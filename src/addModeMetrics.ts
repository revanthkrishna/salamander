// src/addModeMetrics.ts
// The numbers add mode's stylesheet (src/styles/addMode.css.ts) and its
// layout code (addMode.ts) both read, so the two can never disagree about
// the comment box's size or the outline's geometry. Moved out of addMode.ts
// unchanged.

/** The comment box's width. 296, not the original 280: the button row now
 *  holds the pencil and its three swatches as well as the counter, cancel and
 *  save, and with the counter showing (900+ characters) that row needs 279px
 *  of content. 280 less the box's COMMENT_PAD_PX on either side left only
 *  268, so it overflowed; widening the box keeps every button's padding the
 *  same as everywhere else in the UI, where squeezing cancel/save would not. */
export const COMMENT_WIDTH = 296;
/** The comment box's padding: the same 6px on every side and between the
 *  text area and the button row, so the text area's edges line up with the
 *  buttons'. Everything inside (text area, pencil, cancel, save) takes the
 *  box's radius-lg corners less that padding, concentric with them. */
export const COMMENT_PAD_PX = 6;

/** The text area's height. */
export const NOTE_INPUT_HEIGHT_PX = 88;
/** The button row's height: cancel and save (.btn). */
export const COMMENT_ROW_PX = 30;

/** Selection outline: a 2px line whose length alternates 4px accent, 4px
 *  ink. CSS cannot express that — `dashed`/`dotted` derive their dash length
 *  from the line's thickness and give no control over it, and border-image
 *  with a repeating gradient ignores border-radius, which this box has. So
 *  the line is an SVG stroke: a solid ink rect with the accent dashed over
 *  it at the same width, which fills the gaps rather than leaving holes. */
export const OUTLINE_W = 2;
export const OUTLINE_DASH = 4;
/** How far the SVG extends past the box on each side: exactly the line's
 *  width, since the line sits just outside the box so the selection itself
 *  is never covered. There is no separate keyline — every other 4px of the
 *  line is already ink, which gives the contrast on a light page that a
 *  keyline used to, and a keyline beside it read as a second, undashed line. */
export const OUTLINE_PAD = OUTLINE_W;

/** The pencil menu's gap below the comment box, when it opens downward. */
export const DRAW_MENU_GAP = 6;
/** How far above the comment box's bottom edge the menu's bottom sits when
 *  it opens upward: clear of the pencil (padding + button row) with 10px to
 *  spare. */
export const DRAW_MENU_ABOVE_OFFSET = COMMENT_PAD_PX + COMMENT_ROW_PX + 10;
