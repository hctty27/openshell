//! GPUI-native tab drag payload and checked drop geometry. Dragged tabs
//! are IDs only; a drop never copies or recreates a live SSH/ConPTY session.
use gpui::{div, px, rgb, Context, IntoElement, Render, Window, Point, Pixels};
use openshell_core::workspace::SplitAxis;

#[derive(Clone, Copy, Debug)]
pub(super) struct TerminalTabDrag {
    pub(super) tab_id: u64,
    position: Point<Pixels>,
}

impl TerminalTabDrag {
    pub(super) fn new(tab_id: u64) -> Self {
        Self { tab_id, position: Point::default() }
    }

    pub(super) fn at(mut self, position: Point<Pixels>) -> Self {
        self.position = position;
        self
    }
}

impl Render for TerminalTabDrag {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .pl(self.position.x - px(78.0))
            .pt(self.position.y - px(16.0))
            .px_4()
            .py_2()
            .rounded_md()
            .bg(rgb(0x29435d))
            .text_color(rgb(0xf1f5f9))
            .text_size(px(12.0))
            .child(format!("Move terminal #{}", self.tab_id))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum DropEdge {
    Left,
    Right,
    Top,
    Bottom,
}

/// Classifies a drop in one pane's window-relative working area. We prefer
/// a vertical split for central drops, and top/bottom for the outer 22%.
/// Do not use the mouse position to select a different target tab: the GPUI
/// on_drop handler identifies the specific destination pane by tab ID.
pub(super) fn drop_edge(
    pointer_x: f32,
    pointer_y: f32,
    viewport_width: f32,
    viewport_height: f32,
    sidebar_width: f32,
    top_chrome_height: f32,
) -> DropEdge {
    let width = (viewport_width - sidebar_width).max(1.0);
    let height = (viewport_height - top_chrome_height).max(1.0);
    let x = ((pointer_x - sidebar_width) / width).clamp(0.0, 1.0);
    let y = ((pointer_y - top_chrome_height) / height).clamp(0.0, 1.0);
    if y < 0.22 {
        DropEdge::Top
    } else if y > 0.78 {
        DropEdge::Bottom
    } else if x < 0.5 {
        DropEdge::Left
    } else {
        DropEdge::Right
    }
}

impl DropEdge {
    pub(super) fn axis(self) -> SplitAxis {
        match self {
            Self::Left | Self::Right => SplitAxis::Vertical,
            Self::Top | Self::Bottom => SplitAxis::Horizontal,
        }
    }
    pub(super) fn place_before(self) -> bool {
        matches!(self, Self::Left | Self::Top)
    }
}

/// Expected order after dragging a tab on another tab's title. The workspace
/// applies this order to the *existing* TerminalTab objects without cloning
/// or dropping their transport handles.
pub(super) fn reordered_tab_ids(
    ids: &[u64],
    dragged: u64,
    target: u64,
) -> Option<Vec<u64>> {
    if dragged == target || !ids.contains(&dragged) || !ids.contains(&target) {
        return None;
    }
    let mut order: Vec<u64> = ids.iter().copied().filter(|id| *id != dragged).collect();
    let position = order.iter().position(|id| *id == target)?;
    order.insert(position, dragged);
    Some(order)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dropping_on_edge_selects_orientation_and_order() {
        assert_eq!(drop_edge(280.0, 420.0, 1200.0, 760.0, 244.0, 82.0), DropEdge::Left);
        assert_eq!(drop_edge(1080.0, 420.0, 1200.0, 760.0, 244.0, 82.0), DropEdge::Right);
        assert_eq!(drop_edge(700.0, 90.0, 1200.0, 760.0, 244.0, 82.0), DropEdge::Top);
        assert_eq!(drop_edge(700.0, 740.0, 1200.0, 760.0, 244.0, 82.0), DropEdge::Bottom);
        assert_eq!(DropEdge::Top.axis(), SplitAxis::Horizontal);
        assert!(DropEdge::Left.place_before());
        assert!(!DropEdge::Right.place_before());
    }

    #[test]
    fn tab_reorder_checks_ids_and_preserves_other_order() {
        assert_eq!(reordered_tab_ids(&[1,2,3,4], 4, 2), Some(vec![1,4,2,3]));
        assert_eq!(reordered_tab_ids(&[1,2,3], 1, 3), Some(vec![2,1,3]));
        assert_eq!(reordered_tab_ids(&[1,2,3], 1, 1), None);
        assert_eq!(reordered_tab_ids(&[1,2,3], 8, 1), None);
        assert_eq!(reordered_tab_ids(&[1,2,3], 2, 8), None);
    }
}
