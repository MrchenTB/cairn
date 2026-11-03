/**
 * Gantt geometry constants (design-research §5.6, gantt-evaluation §7.3–§7.9). Every pixel value
 * the chart lays out with lives here so the pure model code and the components agree.
 */

/** Fixed row height: every row kind (phase, task, milestone, group header) is 32px. */
export const ROW_HEIGHT = 32
/** Task bar height, vertically centred in the row. */
export const BAR_HEIGHT = 20
export const BAR_TOP = (ROW_HEIGHT - BAR_HEIGHT) / 2
/** Two 24px tiers → 48px sticky time header. */
export const HEADER_TIER_HEIGHT = 24
export const HEADER_HEIGHT = HEADER_TIER_HEIGHT * 2

/** Left outline pane (resizable). */
export const PANE_WIDTH_DEFAULT = 300
export const PANE_WIDTH_MIN = 220
export const PANE_WIDTH_MAX = 480
/** Keyboard step for the pane splitter. */
export const PANE_WIDTH_STEP = 16

/** Bars never render narrower than this (a 1-day bar on the Month scale is only 5px). */
export const MIN_BAR_WIDTH = 6
/** Resize hot zone at each end of a bar (shrinks on narrow bars, see `resizeHandleWidth`). */
export const RESIZE_HANDLE_WIDTH = 8
/** Pointer travel (px) before a press becomes a drag; less is a click. */
export const DRAG_THRESHOLD_PX = 3
/** Auto-scroll starts this close (px) to the visible timeline edge… */
export const AUTO_SCROLL_EDGE_PX = 40
/** …and scrolls at most this many px per frame (proportional to proximity). */
export const AUTO_SCROLL_MAX_SPEED = 20

/** Dependency routing: horizontal stub out of the predecessor / into the successor. */
export const LINK_GAP = 8
/** Corner radius of the orthogonal link path. */
export const LINK_RADIUS = 4
/** Arrowhead length / half height. */
export const ARROW_LENGTH = 6
export const ARROW_HALF_HEIGHT = 3.5
/** Point markers (due flag, start tick): half width used as the link anchor offset. */
export const MARKER_HALF_WIDTH = 5

/** Subtask indentation in the outline. */
export const SUBTASK_INDENT = 20
/** Rows rendered above and below the viewport. */
export const ROW_OVERSCAN = 10
/** Pixel width of the label column for due dates in the outline. */
export const DUE_COLUMN_WIDTH = 72
