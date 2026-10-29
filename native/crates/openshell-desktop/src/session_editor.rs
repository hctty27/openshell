//! Non-secret SSH session editor. Passwords and trust decisions are never stored here.
use openshell_core::{HostIdentity, Session};
use gpui::Keystroke;

const MAX_FIELD_LENGTH: usize = 255;

#[derive(Clone, Debug)]
pub(super) struct SessionDraft {
    pub id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: String,
    pub username: String,
    pub selected: usize,
    pub saving: bool,
    pub error: Option<String>,
}

impl SessionDraft {
    pub fn new() -> Self {
        Self {
            id: None, name: String::new(), host: String::new(),
            port: "22".into(), username: String::new(),
            selected: 0, saving: false, error: None,
        }
    }

    pub fn edit(session: &Session) -> Self {
        Self {
            id: Some(session.id.clone()), name: session.name.clone(),
            host: session.host.clone(), port: session.port.to_string(),
            username: session.username.clone(), selected: 0,
            saving: false, error: None,
        }
    }

    pub fn fields(&self) -> [(&'static str, &str); 4] {
        [("Name", &self.name), ("Host", &self.host),
         ("Port", &self.port), ("Username", &self.username)]
    }

    fn selected_mut(&mut self) -> &mut String {
        match self.selected {
            0 => &mut self.name,
            1 => &mut self.host,
            2 => &mut self.port,
            _ => &mut self.username,
        }
    }

    pub fn select(&mut self, field: usize) {
        self.selected = field.min(3);
        self.error = None;
    }

    pub fn type_text(&mut self, value: &str) {
        let numeric = self.selected == 2;
        let field = self.selected_mut();
        for ch in value.chars() {
            if ch.is_control() || (numeric && !ch.is_ascii_digit()) { continue; }
            if field.len() + ch.len_utf8() > MAX_FIELD_LENGTH { break; }
            field.push(ch);
        }
        self.error = None;
    }

    pub fn on_key(&mut self, key: &Keystroke) {
        match key.key.as_str() {
            "tab" => self.select((self.selected + if key.modifiers.shift { 3 } else { 1 }) % 4),
            "backspace" => { self.selected_mut().pop(); self.error = None; }
            "a" if key.modifiers.control => { self.selected_mut().clear(); self.error = None; }
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
