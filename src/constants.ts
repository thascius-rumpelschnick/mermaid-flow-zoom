export const MIN_SCALE = 0.05;
export const MAX_SCALE = 12;
export const ZOOM_STEP = 1.18;
export const EDGE_SCROLL_ZONE = 46;
// Space above the diagram so the toolbar (8px offset + 40px tall) never covers it.
export const TOOLBAR_CLEARANCE = 56;

export const HELP_ITEMS: readonly (readonly [input: string, action: string])[] = [
	['Click', 'Focus the diagram; zooming and panning only work while it is focused'],
	['Scroll', 'Zoom around the pointer'],
	['Drag', 'Pan'],
	['Shift + scroll', 'Pan sideways (also horizontal trackpad scroll, or scrolling near the left/right edge)'],
	['Ctrl/Cmd + scroll', 'Always zoom'],
	['Double-click', 'Zoom in'],
	['Pinch', 'Zoom on touch devices; drag with one finger to pan'],
	['+ / −', 'Zoom in / out'],
	['0', 'Reset and fit'],
	['Esc', 'Close this help, exit fullscreen, or unfocus the diagram'],
	['Click outside', 'Unfocus the diagram'],
];
