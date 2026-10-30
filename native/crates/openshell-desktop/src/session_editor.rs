//! SSH session editor. Passwords are held only in zeroizing memory and
//! stored in the Windows Credential Manager; never render or log secrets.
use openshell_core::{HostIdentity, Session};
use gpui::Keystroke;
use zeroize::Zeroizing;

const MAX_FIELD_LENGTH: usize = 255;

pub(super) struct SessionDraft {
    pub id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: String,
    pub username: String,
    /// Empty means keep the existing choice; new sessions default to password.
    pub key_path: String,
    pub clear_key: bool,
    pub password: Zeroizing<String>,
    /// Only a fingerprint independently verified by the user can be approved.
    pub fingerprint: String,
    pub fingerprint_confirmed: bool,
    pub selected: usize,
    pub saving: bool,
    pub error: Option<String>,
}

impl SessionDraft {
    pub fn new() -> Self {
        Self {
            id: None, name: String::new(), host: String::new(),
            port: "22".into(), username: String::new(),
            key_path: String::new(), clear_key: false,
            password: Zeroizing::new(String::new()),
            fingerprint: String::new(), fingerprint_confirmed: false,
            selected: 0, saving: false, error: None,
        }
    }

    pub fn edit(session: &Session) -> Self {
        Self {
            id: Some(session.id.clone()), name: session.name.clone(),
            host: session.host.clone(), port: session.port.to_string(),
            username: session.username.clone(), selected: 0,
            key_path: String::new(), clear_key: false,
            password: Zeroizing::new(String::new()),
            fingerprint: String::new(), fingerprint_confirmed: false,
            saving: false, error: None,
        }
    }

    /// Only masked password indicators are returned for rendering.
    pub fn fields(&self) -> [(&'static str, String); 7] {
        [
            ("Name", self.name.clone()),
            ("Host", self.host.clone()),
            ("Port", self.port.clone()),
            ("Username", self.username.clone()),
            ("Private key path (optional)", self.key_path.clone()),
            ("Password (leave blank to keep existing)", if self.password.is_empty() {
                "(unchanged)".to_owned()
            } else {
                "●".repeat(self.password.chars().count().min(24))
            }),
            ("Verified host fingerprint (SHA256:...)", self.fingerprint.clone()),
        ]
    }

    fn selected_mut(&mut self) -> &mut String {
        match self.selected {
            0 => &mut self.name,
            1 => &mut self.host,
            2 => &mut self.port,
            3 => &mut self.username,
            4 => &mut self.key_path,
            5 => &mut *self.password,
            _ => &mut self.fingerprint,
        }
    }

    pub fn select(&mut self, field: usize) {
        self.selected = field.min(6);
        self.error = None;
    }

    pub fn type_text(&mut self, value: &str) {
        let numeric = self.selected == 2;
        let key_path = self.selected == 4;
        let password = self.selected == 5;
        let fingerprint = self.selected == 6;
        if key_path { self.clear_key = false; }
        if fingerprint { self.fingerprint_confirmed = false; }
        let capacity = if password { 4096 } else if key_path { 1024 }
            else if fingerprint { 160 } else { MAX_FIELD_LENGTH };
        let field = self.selected_mut();
        for ch in value.chars() {
            if ch.is_control() || (numeric && !ch.is_ascii_digit()) { continue; }
            if field.len() + ch.len_utf8() > capacity { break; }
            field.push(ch);
        }
        self.error = None;

    }

    pub fn use_password(&mut self) {
        self.key_path.clear();
        self.clear_key = true;
        self.error = None;
    }

    /// This is user attestation, not verification by an online lookup.
    pub fn toggle_fingerprint_confirmed(&mut self) {
        if !self.fingerprint.is_empty() {
            self.fingerprint_confirmed = !self.fingerprint_confirmed;
            self.error = None;
        }
    }

    pub fn checked_fingerprint(&self) -> Result<Option<String>, String> {
        let value = self.fingerprint.trim();
        if value.is_empty() {
            return if self.fingerprint_confirmed {
                Err("Host-key confirmation requires a fingerprint".into())
            } else { Ok(None) };
        }
        if !self.fingerprint_confirmed {
            return Err("Verify the host fingerprint independently and check the confirmation before saving".into());
        }
        let Some(encoded) = value.strip_prefix("SHA256:") else {
            return Err("Host fingerprint must begin with SHA256:".into());
        };
        let unpadded = encoded.trim_end_matches('=');
        if unpadded.len() != 43 || !unpadded.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/')
            || encoded.len() > 44
        {
            return Err("Invalid SHA256 fingerprint; expected 43 base64 characters".into());
        }
        Ok(Some(value.to_owned()))
    }

    pub fn on_key(&mut self, key: &Keystroke) {
        match key.key.as_str() {
            "tab" => self.select((self.selected + if key.modifiers.shift { 6 } else { 1 }) % 7),
            "backspace" if self.selected == 5 => {
                let count = self.password.chars().count().saturating_sub(1);
                let replacement: String = self.password.chars().take(count).collect();
                self.password = Zeroizing::new(replacement);
                self.error = None;
            }
            "backspace" => {
                if self.selected == 6 { self.fingerprint_confirmed = false; }
                self.selected_mut().pop();
                self.error = None;
            }
            "a" if key.modifiers.control && self.selected == 5 => {
                self.password = Zeroizing::new(String::new());
                self.error = None;
            }
            "a" if key.modifiers.control => {
                if self.selected == 6 { self.fingerprint_confirmed = false; }
                self.selected_mut().clear();
                self.error = None;
            }
            _ if !key.modifiers.control && !key.modifiers.platform && !key.is_ime_in_progress() => {
                if let Some(text) = &key.key_char { self.type_text(text); }
            }
            _ => {}
        }
    }

    pub fn session(&self, id: String) -> Result<Session, String> {
        let port = self.port.parse::<u16>()
            .map_err(|_| "Port must be from 1 to 65535".to_string())?;
        let session = Session {
            id, name: self.name.trim().into(), host: self.host.trim().into(),
            port, username: self.username.trim().into(),
        };
        session.validate().map_err(|e| e.to_string())?;
        HostIdentity::new(&session.host, session.port).map_err(|e| e.to_string())?;
        Ok(session)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_new_session_metadata() {
        let mut draft = SessionDraft::new();
        draft.name = "Development".into();
        draft.host = "dev.example.org".into();
        draft.username = "deploy".into();
        assert_eq!(draft.session("native-1".into()).unwrap().port, 22);
        draft.port = "65536".into();
        assert!(draft.session("native-1".into()).is_err());
        draft.port = "22".into();
        draft.host = "user@server".into();
        assert!(draft.session("native-1".into()).is_err());
    }

    #[test]
    fn host_fingerprint_requires_independent_user_confirmation() {
        let mut draft = SessionDraft::new();
        draft.select(6);
        draft.type_text("SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        assert!(draft.checked_fingerprint().is_err());
        draft.toggle_fingerprint_confirmed();
        assert!(draft.checked_fingerprint().unwrap().is_some());
        draft.type_text("B");
        assert!(draft.checked_fingerprint().is_err());
        draft.toggle_fingerprint_confirmed();
        assert!(draft.checked_fingerprint().is_err());
    }

    #[test]
    fn private_key_path_is_editable_without_copying_key_data() {
        let mut draft = SessionDraft::new();
        draft.select(4);
        draft.type_text(r"C:\Users\dev\.ssh\id_ed25519");
        assert!(draft.key_path.ends_with("id_ed25519"));
        assert!(!draft.clear_key);
        draft.use_password();
        assert!(draft.key_path.is_empty());
        assert!(draft.clear_key);
        draft.type_text(r"C:\ssh\key");
        assert!(!draft.clear_key);
    }

    #[test]
    fn password_is_masked_and_never_returned_by_render_fields() {
        let mut form = SessionDraft::new();
        form.select(5);
        form.type_text("s3cret\u{1f511}");
        let fields = format!("{:?}", form.fields());
        assert!(!fields.contains("s3cret"));
        assert!(!fields.contains("🔑"));
        assert!(fields.contains("●"));
        assert_eq!(form.password.as_str(), "s3cret🔑");
        form.use_password();
        assert!(form.clear_key);
    }

    #[test]
    fn editing_preserves_id_and_filters_input() {
        let original = Session {
            id: "existing".into(), name: "Old".into(),
            host: "old.example".into(), port: 22, username: "root".into(),
        };
        let mut draft = SessionDraft::edit(&original);
        draft.select(0);
        draft.type_text("\n\u{1b}new");
        assert_eq!(draft.name, "Oldnew");
        assert_eq!(draft.session(draft.id.clone().unwrap()).unwrap().id, "existing");
        draft.select(2);
        draft.port.clear();
        draft.type_text("abc220");
        assert_eq!(draft.port, "220");
        draft.select(1);
        draft.type_text(&"x".repeat(500));
        assert_eq!(draft.host.len(), MAX_FIELD_LENGTH);
    }
}
