// src/sidebarMetrics.ts
// The sidebar's numbers: its width range, the action row's and the note
// list's layout metrics, the minimum width and the narrow breakpoint they
// derive, the small controls' curves and durations, and the z-indexes. The
// stylesheet (src/styles/sidebar.css.ts) is generated from these and the
// panel's code (sidebar.ts) and add mode (DEFAULT_THUMBNAIL_BOX_SIZE) read
// them, so none of them can drift from what the browser lays out. Pure
// constants, no DOM. Moved out of sidebar.ts unchanged.

import { RADII } from './theme';
import { THUMBNAIL_IMAGE_HEIGHT_PX } from './thumbnails';

/** Widest the user can drag the panel — also the default. */
export const SIDEBAR_MAX_WIDTH = 300;
/** Width used before any persisted preference has loaded. */
export const SIDEBAR_DEFAULT_WIDTH = 300;

// ---------------------------------------------------------------------------
// Responsive layout metrics. The stylesheet is generated from these, so the
// narrow breakpoint and the minimum width can't drift from what the browser
// actually lays out.
// ---------------------------------------------------------------------------

/** .sidebar's border-left (box-sizing: border-box, so it eats into width). */
export const PANEL_BORDER_PX = 1;
/** `.thumbnail-list`'s left+right padding (each side) — see that rule in
 *  src/styles/sidebar.css.ts. Named so DEFAULT_THUMBNAIL_BOX_SIZE (below)
 *  can derive the thumbnail's width from the exact same number the list is
 *  actually padded with, instead of a second hardcoded copy drifting from
 *  the CSS. */
export const THUMBNAIL_LIST_PAD_X = 16;

/** The note text's inset inside its hover "extension" background (design
 *  spec v4 §L): the same on all four sides, so the text sits the same
 *  distance below the thumbnail as the background's bottom edge sits below
 *  the last line. Matches radius md, which is the background's own corner
 *  radius — a text inset equal to the corner it sits in. */
export const NOTE_INSET_PX = 10;

/** The note-list thumbnail's box size *at the default sidebar width*
 *  (SIDEBAR_DEFAULT_WIDTH): that width minus the panel's left border minus
 *  `.thumbnail-list`'s own left+right padding, by the thumbnail's fixed
 *  height (THUMBNAIL_IMAGE_HEIGHT_PX, src/thumbnails.ts).
 *
 *  Deliberately a fixed constant rather than a live readout of the user's
 *  current (resizable) sidebar width: addMode.ts uses this as the
 *  click-to-place default selection size, and a default that shifted size
 *  every time the sidebar was dragged would be a moving target rather than a
 *  predictable default. It still derives from the same numbers the live
 *  thumbnail box is built from (this module's padding/border constants and
 *  thumbnails.ts's fixed height) rather than a second hardcoded 200x150-style
 *  magic number, so it can't drift from what a thumbnail actually looks like
 *  at the default width. */
export const DEFAULT_THUMBNAIL_BOX_SIZE: { width: number; height: number } = {
  width: SIDEBAR_DEFAULT_WIDTH - PANEL_BORDER_PX - THUMBNAIL_LIST_PAD_X * 2,
  height: THUMBNAIL_IMAGE_HEIGHT_PX,
};

/** Gap between note rows in the list. */
export const THUMBNAIL_LIST_GAP_PX = 16;
/** Removing a note: fade, then collapse the row and the gap under it, so the
 *  list closes up instead of the note vanishing mid-list (v4 §L). */
export const ITEM_REMOVE_FADE_MS = 140;
export const ITEM_REMOVE_COLLAPSE_MS = 180;
export const ITEM_REMOVE_TOTAL_MS = ITEM_REMOVE_FADE_MS - 40 + ITEM_REMOVE_COLLAPSE_MS;

/** Action row side padding (design spec §3.1). One value at every width now
 *  that §V's minimum guarantees the row fits — there is no compact layout to
 *  tighten it for. */
export const ACTION_ROW_PAD_X = 16;
export const ACTION_ROW_GAP = 8;
/** Every action-row control is 36px tall; the icon halves are 36px square. */
export const ACTION_BUTTON_PX = 36;
/** The 1px border each action-row *group* carries (design spec v3 §A2/§C2:
 *  the group owns the fill and the border, its halves are transparent). */
export const GROUP_BORDER_PX = 1;
/** The gap between the two buttons of the export group (design spec §AE):
 *  two separate controls, close enough to read as a pair. */
export const EXPORT_GROUP_GAP_PX = 6;
/** The switch's padding either side of its 28px track (§A2). */
export const ADD_SWITCH_PAD_X = 10;
/** How far the switch reaches back UNDER the add button — exactly the
 *  button's corner radius (design spec v5 §Q, as refined).
 *
 *  Each half now draws its own border: the button a complete rounded one on
 *  all four sides, the switch one on its top, right and bottom only. Butting
 *  a square-cornered segment against the button's ROUNDED right edge would
 *  leave a crescent-shaped gap at each of those corners, breaking the outer
 *  border into pieces and clipping the switch's hover fill where the curve
 *  falls away. Reaching one radius back under the button fills both
 *  crescents: the button paints above (z-index), so the overlap is hidden and
 *  the only part of the segment on show past the button's silhouette is the
 *  crescent itself. The outer edge then runs unbroken end to end, and the one
 *  curve between the halves is the button's own right border. */
export const ADD_SWITCH_TUCK_PX = RADII.md;
export const ADD_SWITCH_PAD_LEFT = ADD_SWITCH_TUCK_PX + ADD_SWITCH_PAD_X;
/** The switch's box at full reveal: the tuck, the 28px track and its padding,
 *  and the segment's own right border (the group no longer carries one).
 *  `width: auto` is not animatable and every part is fixed, so the total is
 *  known up front. */
export const ADD_SWITCH_WIDTH_PX =
  ADD_SWITCH_PAD_LEFT + 28 + ADD_SWITCH_PAD_X + GROUP_BORDER_PX;
/** What the reveal actually adds to the group, once the negative margin that
 *  cancels the tuck is taken off — so the group's revealed width is unchanged
 *  by the tuck, and SIDEBAR_MIN_WIDTH below stays honest. */
export const ADD_SWITCH_ADVANCE_PX = ADD_SWITCH_WIDTH_PX - ADD_SWITCH_TUCK_PX;

/** "add note" group at rest, i.e. with the switch collapsed (§A2). */
export const ADD_GROUP_PX = ACTION_BUTTON_PX + GROUP_BORDER_PX * 2;
/** export + "more options" (design spec §AE) — two separate buttons, each
 *  the same box as "add note", with a small gap between them. */
export const EXPORT_GROUP_PX = ADD_GROUP_PX * 2 + EXPORT_GROUP_GAP_PX;

/**
 * Narrowest the user can drag the panel (design spec v5 §V): exactly the
 * width the action row needs with the switch REVEALED, so the export group
 * can never be pushed onto a second line at any width that is reachable.
 *
 * Derived, never written out: §Q changed the switch's width, and a literal
 * total would have gone stale silently. It works out at 188px today — above
 * the old 100px floor and below NARROW_WIDTH_BREAKPOINT (220), which is why
 * that one still has work to do.
 */
export const SIDEBAR_MIN_WIDTH =
  PANEL_BORDER_PX +
  ACTION_ROW_PAD_X * 2 +
  ADD_GROUP_PX +
  ADD_SWITCH_ADVANCE_PX +
  ACTION_ROW_GAP +
  EXPORT_GROUP_PX;

/** Below this width the header sheds the wordmark (design spec §3.1's
 *  "narrow widths" rule). It is the width the wordmark needs, not a
 *  re-derivation of the action row: §V's SIDEBAR_MIN_WIDTH already
 *  guarantees the row fits at every reachable width, but at ~190px the
 *  wordmark is down to a couple of ellipsized characters. */
export const NARROW_WIDTH_BREAKPOINT = 220;

/** Width-driven layout classes for a given panel width (pure; applied by
 *  applyWidthToPanel). Only the wordmark responds to width now — §V's
 *  minimum retired the compact layout, whose breakpoint sat below it and
 *  could never match again. */
export function sidebarLayoutFor(width: number): { narrow: boolean } {
  return { narrow: width < NARROW_WIDTH_BREAKPOINT };
}

/** Above every dock-magnified item (dockMotion.ts writes z-index 0–100). */
export const RESIZER_Z_INDEX = 101;

// ─── Motion (design spec v2 §E's curves, reused for these small controls) ───

/** Standard on-screen curve — entrances and state changes. */
export const EASE_STD = 'cubic-bezier(.2, 0, 0, 1)';
/** Accelerating curve — exits/fade-outs, which run shorter than entrances. */
export const EASE_ACC = 'cubic-bezier(.3, 0, 1, 1)';

/** How long a FULLY revealed switch holds open after the pointer leaves
 *  (§A2), so a diagonal path back onto it never loses the target. A reveal
 *  the pointer leaves part-way (a quick brush past) reverses at once instead
 *  of freezing half-out for the grace period (updateSwitchReveal). */
export const ADD_SWITCH_GRACE_MS = 250;
/** The reveal/collapse itself. */
export const ADD_SWITCH_REVEAL_MS = 160;
/** The "more options" menu (§C2, §AE) floats over the note list, whose
 *  dock-magnified items carry z-index 0–100 (dockMotion.ts); one above the
 *  resize handle so an open menu is never struck through by it either. */
export const MENU_Z_INDEX = 102;
/** The menu's own border and padding — the stylesheet, and the width a
 *  confirmation's contents are laid out at (confirmInMenu), both read them. */
export const MENU_BORDER_PX = 1;
export const MENU_PAD_PX = 4;
/** Gap between the confirmation's two buttons, side by side or stacked. */
export const CONFIRM_ACTIONS_GAP_PX = 8;
/** How far (px) the note list's scrollport extends out over the page so
 *  dock-magnified items aren't clipped at the panel edge (see .body). Worst
 *  case at the 300px maximum width: 0.12 × 268px of scale + 22px of shift −
 *  the list's 16px inset ≈ 38px past the edge. The magnification's drop
 *  shadow (§4) then spreads ~1.5 × its 20px blur past *that*, and the
 *  scrollport's own overflow clips it however far the clip-path is relaxed —
 *  so this leaves ~50px of slack beyond the widest item, enough that the
 *  shadow has faded to nothing before the edge rather than being sliced off
 *  mid-falloff. */
export const DOCK_BLEED_PX = 120;
/** Bottom padding (px) of the scrollport. Wide enough for the last item's
 *  drop shadow (10px down + ~30px of blur) to fall inside the scrollport
 *  rather than being cut by its bottom edge; the list's own 16px inset is
 *  what the eye reads as the gap under the last note. */
export const LIST_PAD_BOTTOM_PX = 44;
