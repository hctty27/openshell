use thiserror::Error;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tab {
    pub id: String,
    pub session_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SplitAxis {
    Horizontal,
    Vertical,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Split {
    pub primary: String,
    pub secondary: String,
    pub axis: SplitAxis,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum WorkspaceError {
    #[error("tab does not exist")]
    MissingTab,
    #[error("tab already exists")]
    DuplicateTab,
    #[error("cannot split a tab with itself")]
    SameTab,
}

#[derive(Default, Debug)]
pub struct Workspace {
    tabs: Vec<Tab>,
    active: Option<String>,
    split: Option<Split>,
}

impl Workspace {
    pub fn tabs(&self) -> &[Tab] { &self.tabs }
    pub fn active(&self) -> Option<&str> { self.active.as_deref() }
    pub fn split_layout(&self) -> Option<&Split> { self.split.as_ref() }

    pub fn open(&mut self, tab: Tab) -> Result<(), WorkspaceError> {
        if self.contains(&tab.id) {
            return Err(WorkspaceError::DuplicateTab);
        }
        self.active = Some(tab.id.clone());
        self.split = None;
        self.tabs.push(tab);
        Ok(())
    }

    pub fn activate(&mut self, id: &str) -> Result<(), WorkspaceError> {
        if !self.contains(id) { return Err(WorkspaceError::MissingTab); }
        self.active = Some(id.to_string());
        if self.split.as_ref().is_some_and(|split|
            split.primary != id && split.secondary != id
        ) {
            self.split = None;
        }
        Ok(())
    }

    pub fn reorder(&mut self, id: &str, destination: usize) -> Result<(), WorkspaceError> {
        let current = self.position(id).ok_or(WorkspaceError::MissingTab)?;
        let tab = self.tabs.remove(current);
        let target = destination.min(self.tabs.len());
        self.tabs.insert(target, tab);
        Ok(())
    }

    pub fn split_with(&mut self, secondary: &str, axis: SplitAxis) -> Result<(), WorkspaceError> {
        let primary = self.active.clone().ok_or(WorkspaceError::MissingTab)?;
        if primary == secondary { return Err(WorkspaceError::SameTab); }
        if !self.contains(secondary) { return Err(WorkspaceError::MissingTab); }
        self.split = Some(Split {
            primary,
            secondary: secondary.to_string(),
            axis,
        });
        Ok(())
    }

    pub fn close(&mut self, id: &str) -> Result<Tab, WorkspaceError> {
        let index = self.position(id).ok_or(WorkspaceError::MissingTab)?;
        let closed = self.tabs.remove(index);
        if self.split.as_ref().is_some_and(|split|
            split.primary == id || split.secondary == id
        ) {
            self.split = None;
        }
        if self.active.as_deref() == Some(id) {
            self.active = self.tabs.get(index.min(self.tabs.len().saturating_sub(1)))
                .map(|tab| tab.id.clone());
        }
        Ok(closed)
    }

    fn contains(&self, id: &str) -> bool {
        self.position(id).is_some()
    }

    fn position(&self, id: &str) -> Option<usize> {
        self.tabs.iter().position(|tab| tab.id == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(id: &str) -> Tab {
        Tab { id: id.into(), session_id: "server1".into() }
    }

    #[test]
    fn unique_tab_ids_and_stable_reorder() {
        let mut ws = Workspace::default();
        ws.open(tab("a")).expect("open a");
        ws.open(tab("b")).expect("open b");
        assert_eq!(ws.open(tab("a")), Err(WorkspaceError::DuplicateTab));
        ws.reorder("b", 0).expect("move");
        assert_eq!(ws.tabs().iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec!["b", "a"]);
    }

    #[test]
    fn split_is_removed_when_a_pane_closes() {
        let mut ws = Workspace::default();
        ws.open(tab("a")).expect("a");
        ws.open(tab("b")).expect("b");
        ws.split_with("a", SplitAxis::Horizontal).expect("split");
        assert!(ws.split_layout().is_some());
        ws.close("a").expect("close");
        assert!(ws.split_layout().is_none());
        assert_eq!(ws.active(), Some("b"));
    }

    #[test]
    fn closing_last_tab_clears_active() {
        let mut ws = Workspace::default();
        ws.open(tab("a")).expect("open");
        ws.close("a").expect("close");
        assert_eq!(ws.active(), None);
    }
}
