//! Two-pane split metadata kept separate from SSH/ConPTY task ownership.
//! Splitting never clones or closes a connection; it only changes presentation.

use openshell_core::workspace::SplitAxis;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct SplitView {
    pub(super) primary: u64,
    pub(super) secondary: u64,
    pub(super) axis: SplitAxis,
}

impl SplitView {
    pub(super) fn new(primary: u64, secondary: u64, axis: SplitAxis) -> Option<Self> {
        if primary == secondary { return None; }
        Some(Self { primary, secondary, axis })
    }

    pub(super) fn contains(self, id: u64) -> bool {
        id == self.primary || id == self.secondary
    }

    pub(super) fn ids(self) -> [u64; 2] {
        [self.primary, self.secondary]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_requires_two_distinct_tabs() {
        assert!(SplitView::new(3, 3, SplitAxis::Vertical).is_none());
        let split = SplitView::new(3, 7, SplitAxis::Horizontal).unwrap();
        assert_eq!(split.ids(), [3, 7]);
        assert!(split.contains(7));
        assert!(!split.contains(9));
    }
}
