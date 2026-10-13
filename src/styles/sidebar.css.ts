// src/styles/sidebar.css.ts
// The sidebar panel's stylesheet (design spec §3.1, §A2, §AE, §AF, §L),
// moved out of sidebar.ts unchanged. sidebar.ts puts it in the shadow root's
// one <style>, after the theme tokens and before the enlarged view's and the
// tooltip's CSS. Generated from src/sidebarMetrics.ts's numbers.

import { DISABLED_CSS, FOCUS_RING_CSS, STATE_TRANSITION_CSS } from '../theme';
import {
  ACTION_BUTTON_PX,
  ACTION_ROW_GAP,
  ACTION_ROW_PAD_X,
  ADD_GROUP_PX,
  ADD_SWITCH_PAD_LEFT,
  ADD_SWITCH_PAD_X,
  ADD_SWITCH_REVEAL_MS,
  ADD_SWITCH_TUCK_PX,
  ADD_SWITCH_WIDTH_PX,
  CONFIRM_ACTIONS_GAP_PX,
  DOCK_BLEED_PX,
  EASE_ACC,
  EASE_STD,
  EXPORT_GROUP_GAP_PX,
  GROUP_BORDER_PX,
  ITEM_REMOVE_COLLAPSE_MS,
  ITEM_REMOVE_FADE_MS,
  LIST_PAD_BOTTOM_PX,
  MENU_BORDER_PX,
  MENU_PAD_PX,
  MENU_Z_INDEX,
  NOTE_INSET_PX,
  RESIZER_Z_INDEX,
  SIDEBAR_DEFAULT_WIDTH,
  THUMBNAIL_LIST_GAP_PX,
  THUMBNAIL_LIST_PAD_X,
} from '../sidebarMetrics';

// ---------------------------------------------------------------------------
// CSS — Salamander design tokens (src/theme.ts's --sal-* custom properties,
// design spec §1–§3.1). FOCUS_RING_CSS/STATE_TRANSITION_CSS/
// DISABLED_CSS are the same shared interaction-state snippets enlargedView.ts and
// addMode.ts already paste in, so all three surfaces feel identical.
// ---------------------------------------------------------------------------

/** The "keep on" switch's two reveal states (design spec v3 §A2, made
 *  interruptible 2026-10-12). Kept as snippets because several selectors
 *  reveal it (pointer, keyboard focus, on, and hover-less pointers).
 *
 *  The switch is a finished segment at all times — its width, padding and
 *  border never change — absolutely positioned with its left edge tucked a
 *  corner radius under the add button. Hidden, it is slid left by its own
 *  width (behind the button) and clipped at that tucked edge; revealing
 *  slides it right while the clip's left inset shrinks by the same amount,
 *  so the clip stays put in the group and the segment emerges from behind
 *  the button. Only `transform` and `clip-path` move, on one curve and one
 *  duration, so:
 *    - a frame mid-way is always the left part of the real switch, never a
 *      squeezed box with the track cut off and its padding half-grown (what
 *      animating width, padding, margin and border together produced — the
 *      "half switch, wrong padding" on a quick hover, and the faint half
 *      circle of the track's end);
 *    - an interruption reverses both from where they are, together;
 *    - nothing in the row re-lays out: the group stays the button's width
 *      and the switch overlays the room SIDEBAR_MIN_WIDTH keeps for it.
 *  The clip's other three sides sit 6px out, so the focus ring is never cut.
 *  visibility goes hidden only once the slide back has finished, so Tab can
 *  never land on a hidden switch. */
const ADD_SWITCH_RING_ROOM_PX = 6;
const ADD_SWITCH_HIDDEN_CSS =
  `transform: translateX(-${ADD_SWITCH_WIDTH_PX}px); ` +
  `clip-path: inset(-${ADD_SWITCH_RING_ROOM_PX}px -${ADD_SWITCH_RING_ROOM_PX}px -${ADD_SWITCH_RING_ROOM_PX}px ${ADD_SWITCH_WIDTH_PX}px); ` +
  'visibility: hidden;';
const ADD_SWITCH_SHOWN_CSS =
  'transform: translateX(0px); ' +
  `clip-path: inset(-${ADD_SWITCH_RING_ROOM_PX}px -${ADD_SWITCH_RING_ROOM_PX}px -${ADD_SWITCH_RING_ROOM_PX}px 0px); ` +
  'visibility: visible; transition-delay: 0s;';

export const SIDEBAR_CSS = `
  :host {
    font-family: var(--sal-font-body);
    font-size: 13px;
    color: var(--sal-text);
  }

  *, *::before, *::after { box-sizing: border-box; }

  /* Docked panel. top/bottom rather than height:100vh — 100vh is unreliable
     under browser zoom and on mobile-emulating viewports, and fixed insets
     always resolve against the same box the sidebar is positioned in. */
  .sidebar {
    position: fixed;
    top: 0;
    bottom: 0;
    right: 0;
    /* Starting value only — applyWidthToPanel() writes the live width as an
       inline style once the persisted preference (if any) has loaded. */
    width: ${SIDEBAR_DEFAULT_WIDTH}px;
    background: var(--sal-bg);
    color: var(--sal-text);
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--sal-line);
    /* No heavy shadow (§3.1) — the border-left is the only separation from
       the page. */
    z-index: 2147483645;
    /* Note-list items grow ~1.12x and translate up to -22px past the panel's
       left edge under dock magnification (design spec §4, src/dockMotion.ts);
       nothing along that path may clip them — see .body below for how the
       one scroll container on the path makes room. */
    overflow: visible;
  }
  .sidebar[hidden] { display: none !important; }

  /* ─── Drag handle on the page-facing (left) edge ──────────────────────────
     A 6px hit target so it is actually grabbable, with a 1px hairline that
     is always visible (design spec §3.1) and turns accent on hover/drag/
     focus. role="separator" + tabindex makes it keyboard-operable (arrow
     keys), which a pure mousedown handle would not be.

     The hit target and the hairline are two sibling elements on purpose,
     at different heights in .sidebar's stacking context:
       - .resizer (the hit target) sits above even the most magnified note
         item (dockMotion.ts writes z-index 0–100 on items), so the handle
         is grabbable at every moment — a swollen item crossing the panel
         edge can never cover it. dockMotion.ts treats it as a "hold
         target", so sweeping across its 6px strip doesn't make the swell
         dip and re-grow.
       - .resizer-line (the hairline) sits *below* magnified items at rest,
         so a swollen thumbnail isn't struck through by a 1px rule, and
         rises above them only while the handle is actually in use
         (hover/drag/focus), when the accent line should read. */
  .resizer {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 6px;
    background: transparent;
    cursor: ew-resize;
    touch-action: none;
    z-index: ${RESIZER_Z_INDEX};
  }
  .resizer:focus-visible { outline: none; ${FOCUS_RING_CSS} }
  .resizer-line {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 1px;
    background: var(--sal-line);
    pointer-events: none;
    z-index: 1;
    transition: background-color 140ms ease-out;
  }
  .resizer:hover + .resizer-line,
  .resizer.dragging + .resizer-line,
  .resizer:focus-visible + .resizer-line {
    background: var(--sal-accent);
    z-index: ${RESIZER_Z_INDEX};
  }

  /* ─── Header: logo + wordmark, close (§3.1) ─────────────────────────── */

  /* No border of its own (design spec v4 §J): the header and the action row
     are one fixed block above the scrolling list, and the single rule under
     that block lives at the bottom of .action-row. */
  .header {
    display: flex;
    flex-direction: row;
    align-items: center;
    flex-shrink: 0;
    height: 56px;
    padding: 0 10px 0 16px;
    gap: 10px;
  }

  .logo {
    width: 35px;
    height: 20px;
    flex-shrink: 0;
    display: block;
  }
  .logo img { width: 100%; height: 100%; display: block; }

  /* Pushes close to the right edge at every width — a no-op while the
     flexible wordmark is showing, and what keeps it from drifting left once
     the wordmark hides below the narrow breakpoint. */
  .btn-close { margin-left: auto; }

  .wordmark {
    flex: 1 1 auto;
    min-width: 0;
    font-family: var(--sal-font-display);
    font-style: italic;
    font-size: 22px;
    line-height: 1;
    color: var(--sal-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sidebar.is-narrow .wordmark { display: none; }

  /* Ghost button: close (design spec §2's "ghost" row). */
  .btn-ghost {
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    border-radius: var(--sal-radius-md);
    color: var(--sal-muted);
    cursor: pointer;
    ${STATE_TRANSITION_CSS}
  }
  .btn-ghost:hover { background: var(--sal-hover); color: var(--sal-text); }
  .btn-ghost:active { background: var(--sal-press); color: var(--sal-text); }
  .btn-ghost:focus-visible { ${FOCUS_RING_CSS} outline: none; color: var(--sal-text); }
  .btn-ghost[disabled] { ${DISABLED_CSS} }
  .btn-ghost .icon { width: 16px; height: 16px; display: inline-flex; }
  .btn-ghost.btn-close .icon { width: 18px; height: 18px; }
  .btn-ghost .icon svg { width: 100%; height: 100%; display: block; }

  /* ─── Action row: "add note" + "keep on" switch, export + "more options" ─
     design spec v3 §A2 / §AE. The add-note group is one rounded box that
     carries the fill, the border and the interaction states, its halves
     transparent, borderless and never changing size; export and "more
     options" are two separate buttons, each its own box (see below). */

  .action-row {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    /* No wrapping: §V made SIDEBAR_MIN_WIDTH the width this row needs with
       the switch revealed, so both groups fit on one line at every width the
       user can drag to and there is no second line to fall to. */
    flex-wrap: nowrap;
    padding: 4px ${ACTION_ROW_PAD_X}px 16px;
    gap: ${ACTION_ROW_GAP}px;
    /* §J: the one divider of the fixed top block, under the whole of it
       (header + action row) rather than between the two. */
    border-bottom: 1px solid var(--sal-line);
  }

  /* ── "add note" + its attached "keep on" switch (§A2) ─────────────────── */

  .add-group {
    position: relative;
    display: inline-flex;
    align-items: stretch;
    flex-shrink: 0;
    /* Pushes the export group to the row's right edge at every width, and
       keeps it there when the switch's reveal widens this group. */
    margin-right: auto;
    height: ${ACTION_BUTTON_PX}px;
    /* The group is pure layout now (design spec v5 §Q, as refined): no fill
       and no border of its own — each half draws its own, so the button can
       be a complete rounded button and the switch an open-sided extension
       behind it. The radius is kept only so the merged state's focus ring
       (below) takes the shape of the whole control. */
    border-radius: var(--sal-radius-md);
    /* Not clipped: a focus ring sits 4px outside its half. */
    overflow: visible;
    color: var(--sal-text);
    ${STATE_TRANSITION_CSS}
  }
  .add-group.is-on { color: var(--sal-on-accent); }

  .btn-add {
    /* Above the switch, so the tucked part of the segment is hidden behind
       this button's own opaque fill and only the crescents either side of its
       rounded right corners show (see ADD_SWITCH_TUCK_PX). The fill has to be
       opaque in every state for that to hold — there is no group fill behind
       it any more. */
    position: relative;
    z-index: 1;
    /* Its own two borders are inside this box (border-box), so the button
       occupies exactly what the bordered group used to: 36px of content. */
    width: ${ADD_GROUP_PX}px;
    height: 100%;
    flex-shrink: 0;
    margin: 0;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    white-space: nowrap;
    background: var(--sal-surface);
    border: ${GROUP_BORDER_PX}px solid var(--sal-line);
    border-radius: var(--sal-radius-md);
    color: inherit;
    cursor: pointer;
    ${STATE_TRANSITION_CSS}
  }
  /* Per-half hover/press (§A2 micro states), in both the off and the on
     (yellow) group — the .is-on rules outrank the bare ones by specificity. */
  /* The OUTLINE reacts as one, the fill does not: a hover anywhere in the
     group lights both halves' borders, while only the half under the pointer
     takes the fill. Lighting just the hovered half's border leaves the
     control half-outlined — most obviously on the switch, whose border is
     only three sides, so the junction and the whole button stayed at the
     resting colour and the highlight appeared to stop part-way round the
     shape. */
  .add-group:hover .btn-add,
  .add-group:hover .add-switch,
  .add-group:active .btn-add,
  .add-group:active .add-switch { border-color: var(--sal-line-strong); }
  /* The comment glyph is yellow at rest (accentIcon: deeper in light theme,
     where plain accent on white is too faint). Once add mode is on the
     button is yellow, and the glyph takes the group's on-accent ink. */
  .add-group:not(.is-on) .btn-add { color: var(--sal-accent-icon); }
  .btn-add:hover { background: var(--sal-hover); }
  .btn-add:active { background: var(--sal-press); }
  .add-group.is-on .btn-add { background: var(--sal-accent); border-color: transparent; }
  .add-group.is-on .btn-add:hover { background: var(--sal-accent-hover); }
  .add-group.is-on .btn-add:active { background: var(--sal-accent-press); }
  /* The ring hugs the focused half rather than the group, so it says which
     of the two Enter will hit (§A2 micro states). Keyboard-only, like every
     other control here. */
  .btn-add:focus-visible { ${FOCUS_RING_CSS} outline: none; }
  .btn-add .icon { width: 17px; height: 17px; flex-shrink: 0; display: inline-flex; }
  .btn-add .icon svg { width: 100%; height: 100%; display: block; }

  /* The switch half. Hidden at rest and revealed on hover / keyboard focus
     anywhere in the group; once ON it is visible in every state (§A2).
     visibility (not just opacity) so Tab can never land on an invisible
     control, and an explicit collapsed/expanded width because width: auto is not
     animatable. */
  .add-switch {
    /* Out of the row's flow (see ADD_SWITCH_SHOWN_CSS): tucked a radius
       under the button, at its full, fixed size in every state. */
    position: absolute;
    top: 0;
    left: ${ADD_GROUP_PX - ADD_SWITCH_TUCK_PX}px;
    width: ${ADD_SWITCH_WIDTH_PX}px;
    height: 100%;
    margin: 0;
    padding: 0 ${ADD_SWITCH_PAD_X}px 0 ${ADD_SWITCH_PAD_LEFT}px;
    display: flex;
    align-items: center;
    /* Bordered on its top, right and bottom only — never on the left, where
       the button's own right border is the single line at the junction. */
    border: ${GROUP_BORDER_PX}px solid var(--sal-line);
    border-left-width: 0;
    /* Square on the left: that edge is tucked a radius back under the button,
       so the fill reaches around its rounded corners and fills the crescents
       rather than stopping short in a straight line. */
    border-radius: 0 var(--sal-radius-md) var(--sal-radius-md) 0;
    /* Off: neutral segment — it stays neutral even when the button half is
       yellow, and only goes yellow when the switch itself is on (§A2). */
    background: var(--sal-surface);
    color: var(--sal-text);
    cursor: pointer;
    ${ADD_SWITCH_HIDDEN_CSS}
    /* The slide and its clip share one curve and duration, so they stay in
       step through any interruption; visibility flips only once the slide
       back has finished. The grace period is the JS's (updateSwitchReveal),
       not a transition delay, so it can be skipped for a part-way reveal. */
    transition:
      transform ${ADD_SWITCH_REVEAL_MS}ms ${EASE_STD},
      clip-path ${ADD_SWITCH_REVEAL_MS}ms ${EASE_STD},
      visibility 0s linear ${ADD_SWITCH_REVEAL_MS}ms,
      background-color 150ms ${EASE_STD} 0s,
      border-color 150ms ${EASE_STD} 0s;
    will-change: transform, clip-path;
  }
  .add-switch:hover { background: var(--sal-hover); }
  .add-switch:active { background: var(--sal-press); }
  .add-switch:focus-visible { ${FOCUS_RING_CSS} outline: none; }

  /* Merged (§A2 micro states): with the switch on the two halves are one
     button, so they paint as one. The group has no fill of its own now, so
     both halves take the same yellow and BOTH respond to a hover or press
     anywhere in the group — painting only the half under the pointer would
     put two different yellows side by side in what is meant to be a single
     control. The junction line goes transparent rather than away, so merged
     and split are exactly the same width. Clicking either half means "stop":
     the click handler routes both to the add button's own callback, which
     exits add mode and turns the switch off together. */
  .add-group.is-switch-on .btn-add,
  .add-group.is-switch-on .add-switch {
    background: var(--sal-accent);
    border-color: transparent;
  }
  .add-group.is-switch-on:hover .btn-add,
  .add-group.is-switch-on:hover .add-switch { background: var(--sal-accent-hover); }
  .add-group.is-switch-on:active .btn-add,
  .add-group.is-switch-on:active .add-switch { background: var(--sal-accent-press); }
  /* One control, one ring — on the group, which spans both halves. */
  .add-group.is-switch-on .btn-add:focus-visible { box-shadow: none; }
  .add-group.is-switch-on:has(.btn-add:focus-visible) { ${FOCUS_RING_CSS} }

  /* Reveal (§A2, tightened by v5 §Q): hidden at rest, shown on hover
     (.is-revealed, which updateSwitchReveal sets and clears with the grace
     period) or KEYBOARD focus anywhere in the group, and always shown once the switch is
     on — nothing else. :has(:focus-visible) rather than :focus-within,
     because Chrome focuses a button on mouse-down: with :focus-within the
     switch stayed out from the click that started add mode and lingered right
     through it, until the user clicked the page to draw a rect and focus
     finally left. The add button keeps all four of its corners rounded
     throughout — the switch reads as an extension sliding out from behind it,
     not as the right half of a split pill (§A2 micro states). No breakpoint
     suppresses the reveal — §V made the panel's minimum width the width this
     row needs with the switch out, so there is no width at which it does not
     fit. */
  .add-group.is-revealed .add-switch,
  .add-group:has(:focus-visible) .add-switch,
  .add-group.is-switch-on .add-switch { ${ADD_SWITCH_SHOWN_CSS} }

  /* Nothing to hover with, so nothing would ever reveal it: on touch and
     other hover-less pointers the switch is simply always out (§A2 micro
     states). */
  @media (hover: none) {
    .add-switch { ${ADD_SWITCH_SHOWN_CSS} }
  }

  /* The switch's own colours (design spec v4 §P). Each pair either inverts
     with the theme together or is theme-independent, so the knob always
     contrasts with its track in BOTH themes:
       off — track muted, knob surface: muted (#6E6656 / #B3AA96) and
             surface (#FFFFFF / #1D1A13) invert together, so it is a light
             knob in a dark slot on light and a dark knob in a light slot on
             dark. The old lineStrong track was a hairline colour, too close
             to the segment to read as a live control at all.
       on  — track onAccent, knob accent: both are the same value in either
             theme (#1A1712 and #FEC800), so it is a yellow knob in a lit
             slot on the yellow segment everywhere. The old pairing put a
             surface knob on an onAccent track, which in dark theme is
             near-black on black — one unreadable blob. */
  .add-switch-track {
    position: relative;
    width: 28px;
    height: 16px;
    flex-shrink: 0;
    border-radius: 8px;
    background: var(--sal-muted);
    transition: background-color 150ms ${EASE_STD};
  }
  .add-group.is-switch-on .add-switch-track { background: var(--sal-on-accent); }

  .add-switch-knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--sal-surface);
    transition: left 150ms ${EASE_STD}, background-color 150ms ${EASE_STD};
  }
  .add-group.is-switch-on .add-switch-knob {
    left: 14px;
    background: var(--sal-accent);
  }

  /* ── export + "more options" (design spec §AE) ──────────────────────
     Two separate buttons on the right of the row, each the same box as
     "add note" (its own border, fill, hover, press and focus ring), with a
     small gap. They were one segmented control (§C2) until the menu grew a
     destructive item: a chevron fused to export read as "export options",
     which a delete-everything action must never be mistaken for. The group
     is pure layout, and the anchor the menu hangs from. */
  .export-group {
    position: relative;
    display: inline-flex;
    align-items: stretch;
    flex-shrink: 0;
    gap: ${EXPORT_GROUP_GAP_PX}px;
    height: ${ACTION_BUTTON_PX}px;
    /* The menu hangs out of the bottom of this box. */
    overflow: visible;
    color: var(--sal-text);
  }
  .export-group.is-disabled { ${DISABLED_CSS} }

  .btn-export,
  .btn-menu {
    width: ${ADD_GROUP_PX}px;
    height: 100%;
    flex-shrink: 0;
    margin: 0;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--sal-surface);
    border: ${GROUP_BORDER_PX}px solid var(--sal-line);
    border-radius: var(--sal-radius-md);
    color: inherit;
    cursor: pointer;
    ${STATE_TRANSITION_CSS}
  }
  .btn-export:hover,
  .btn-menu:hover { background: var(--sal-hover); border-color: var(--sal-line-strong); }
  .btn-export:active,
  .btn-menu:active { background: var(--sal-press); border-color: var(--sal-line-strong); }
  /* Open, "more options" keeps the hover treatment so it reads as the
     control its menu belongs to. Written before nothing that would outrank
     it: :active above has the same specificity and comes first, so a press
     on the open button still shows. */
  .btn-menu[aria-expanded="true"] { background: var(--sal-hover); border-color: var(--sal-line-strong); }
  .btn-export:focus-visible,
  .btn-menu:focus-visible { ${FOCUS_RING_CSS} outline: none; }
  .btn-export[disabled],
  .btn-menu[disabled] { cursor: default; }
  .btn-export[aria-disabled="true"] { ${DISABLED_CSS} }
  .btn-export[aria-disabled="true"]:hover,
  .btn-export[aria-disabled="true"]:active {
    background: var(--sal-surface);
    border-color: var(--sal-line);
  }
  .export-group.is-disabled .btn-export:hover,
  .export-group.is-disabled .btn-export:active,
  .export-group.is-disabled .btn-menu:hover,
  .export-group.is-disabled .btn-menu:active {
    background: var(--sal-surface);
    border-color: var(--sal-line);
  }
  .btn-export .icon,
  .btn-menu .icon { width: 16px; height: 16px; display: inline-flex; }
  .btn-export .icon svg,
  .btn-menu .icon svg { width: 100%; height: 100%; display: block; }

  /* The menu itself. Closed is the base state, so this rule carries the
     *exit* timing (90ms, accelerating) and the [data-open] rule below the
     entrance (120ms, standard) — §C2, and the motion language's "entrances
     run 30–50% longer than exits". visibility rather than [hidden] so both
     directions can animate, and so nothing inside is focusable or in the
     accessibility tree while it is invisible. */
  .action-menu-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  /* Both faces set display, which would otherwise beat [hidden]. */
  .action-menu-list[hidden] { display: none; }
  .action-menu {
    position: absolute;
    top: 42px;
    right: 0;
    /* Sized to its content, never to its containing block: it is positioned
       against the two-button group, only ~82px wide, and every label stays
       on one line. At the narrowest panel widths that makes it wider than
       the panel, so it grows leftwards out over the page, like any popover. */
    width: max-content;
    min-width: 132px;
    padding: ${MENU_PAD_PX}px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    border: ${MENU_BORDER_PX}px solid var(--sal-line);
    border-radius: var(--sal-radius-md);
    background: var(--sal-surface);
    box-shadow: var(--sal-shadow-pop);
    z-index: ${MENU_Z_INDEX};
    transform-origin: top right;
    opacity: 0;
    visibility: hidden;
    transform: scale(0.96);
    transition:
      opacity 90ms ${EASE_ACC},
      transform 90ms ${EASE_ACC},
      visibility 0s linear 90ms;
  }
  .action-menu[data-open="true"] {
    opacity: 1;
    visibility: visible;
    transform: scale(1);
    transition:
      opacity 120ms ${EASE_STD},
      transform 120ms ${EASE_STD},
      visibility 0s;
  }

  .action-menu-item {
    height: 32px;
    margin: 0;
    padding: 0 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    white-space: nowrap;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: var(--sal-radius-sm);
    color: var(--sal-text);
    font-family: var(--sal-font-body);
    font-size: 13px;
    font-weight: 500;
    line-height: 1;
    cursor: pointer;
    ${STATE_TRANSITION_CSS}
  }
  .action-menu-item:hover { background: var(--sal-hover); }
  .action-menu-item:focus-visible { background: var(--sal-hover); outline: none; }
  .action-menu-item:active { background: var(--sal-press); }
  .action-menu-item[disabled],
  .action-menu-item[aria-disabled="true"] { ${DISABLED_CSS} }
  .action-menu-item[aria-disabled="true"]:hover,
  .action-menu-item[aria-disabled="true"]:active,
  .action-menu-item.is-danger[aria-disabled="true"]:hover,
  .action-menu-item.is-danger[aria-disabled="true"]:active { background: transparent; }
  .action-menu-item .icon { width: 16px; height: 16px; flex-shrink: 0; display: inline-flex; }
  .action-menu-item .icon svg { width: 100%; height: 100%; display: block; }
  /* The destructive item (design spec §AE): danger ink, and a danger-tinted
     fill on hover and press, so it never looks like a sibling of import. */
  .action-menu-item.is-danger { color: var(--sal-danger); }
  .action-menu-item.is-danger:hover,
  .action-menu-item.is-danger:focus-visible { background: var(--sal-danger-soft); }
  .action-menu-item.is-danger:active { background: var(--sal-danger-hover); }
  /* Keeps the destructive item a deliberate reach away from import. Every
     item sits the same 4px from whatever is around it — the menu's edge or
     this line — so the divider's own margin is the menu padding (4px) less
     the 2px gap the column already puts on each side of it, and it runs the
     items' full width rather than being inset past them. */
  .action-menu-divider {
    height: 1px;
    margin: 2px 0;
    background: var(--sal-line);
    flex-shrink: 0;
  }

  /* ─── The menu as a confirmation (design spec §AF) ────────────────────
     Delete-all and import ask in place: the menu's box morphs to the full
     width of the panel (inline width, set by confirmInMenu) and the
     question's height. Clipped while it grows, and the question is laid out
     at its final width and pinned to the box's right edge (align-self), so
     the box uncovers it rather than reflowing it frame by frame. */
  .action-menu.is-confirm { overflow: hidden; }
  .action-menu-confirm {
    align-self: flex-end;
    flex-shrink: 0;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .action-menu-confirm[hidden] { display: none; }
  .action-menu-confirm-text {
    margin: 0;
    font-family: var(--sal-font-body);
    font-size: 13px;
    line-height: 1.45;
    color: var(--sal-text);
    white-space: normal;
  }
  .action-menu-confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: ${CONFIRM_ACTIONS_GAP_PX}px;
  }
  /* Too narrow for both labels on one line (confirmInMenu measures): the
     buttons stack and span the box, the confirming one on top and cancel at
     the bottom. A label never wraps. */
  .action-menu-confirm-actions.is-stacked { flex-direction: column-reverse; }
  .action-menu-confirm-actions.is-stacked .confirm-btn { width: 100%; }
  .confirm-btn {
    flex-shrink: 0;
    white-space: nowrap;
    height: 32px;
    margin: 0;
    padding: 0 12px;
    background: var(--sal-surface);
    border: 1px solid var(--sal-line);
    border-radius: var(--sal-radius-md);
    color: var(--sal-text);
    font-family: var(--sal-font-body);
    font-size: 13px;
    font-weight: 500;
    line-height: 1;
    cursor: pointer;
    ${STATE_TRANSITION_CSS}
  }
  .confirm-btn:hover { background: var(--sal-hover); border-color: var(--sal-line-strong); }
  .confirm-btn:active { background: var(--sal-press); }
  .confirm-btn:focus-visible { ${FOCUS_RING_CSS} outline: none; }
  /* Both questions are irreversible, so the confirming button carries the
     same soft danger treatment as the menu's delete item. A solid red fill
     would be a light coral in the dark theme, with poor contrast. */
  .confirm-btn.is-danger { background: var(--sal-danger-soft); border-color: transparent; color: var(--sal-danger); }
  .confirm-btn.is-danger:hover { background: var(--sal-danger-hover); }
  .confirm-btn.is-danger:active { background: var(--sal-danger-press); }
  /* A confirming action that destroys nothing on its own terms (import):
     the plain button with yellow text, like "add note"'s glyph. */
  .confirm-btn.is-accent { color: var(--sal-accent-icon); }

  /* ─── Notification banner (error / warning) — design spec §3.1 ────────
     An inline rounded banner (not the old full-bleed black bar), with a
     subtle bottom progress line standing in for the countdown bar. Only one
     message is ever shown at a time, so a single .warning modifier covers
     both colour variants. */
  .notif {
    flex-shrink: 0;
    position: relative;
    overflow: hidden;
    margin: 0 16px 12px;
    border-radius: var(--sal-radius-md);
    background: var(--sal-danger-soft);
    color: var(--sal-danger);
  }
  .notif.warning { background: var(--sal-warn-soft); color: var(--sal-warn); }
  .notif[hidden] { display: none !important; }

  .notif-progress {
    position: absolute;
    left: 0;
    bottom: 0;
    width: 100%;
    height: 2px;
    background: currentColor;
    opacity: 0.3;
    transform-origin: left center;
    transform: scaleX(1);
  }
  .notif-progress[hidden] { display: none !important; }

  .notif-row {
    position: relative;
    display: flex;
    flex-direction: row;
    align-items: flex-start;
    padding: 10px 12px;
    gap: 6px;
  }

  .notif-row .icon {
    width: 16px;
    height: 16px;
    margin-top: 1px;
    flex-shrink: 0;
    display: inline-flex;
  }
  .notif-row .icon svg { width: 100%; height: 100%; display: block; }

  .notif-text {
    font-size: 12.5px;
    line-height: 1.4;
    flex: 1 1 auto;
    word-break: break-word;
  }

  /* The note list's scroll container.

     A scroll container clips on both axes (overflow-x: visible computes to
     auto next to overflow-y: auto), so dock magnification (§4) — which
     swells items up to ~40px past the panel's left edge, plus the note's
     shadow — gets room the other way: the scrollport itself extends
     DOCK_BLEED_PX out over the page (negative margin, matching padding, so
     the content box and list width are unchanged).

     That strip lies over the page, so it must never swallow the page's
     clicks — and the part inside the panel must behave like a normal
     scroller (draggable scrollbar, wheel anywhere scrolls the list). The
     two needs only conflict while something is actually magnified, so the
     body switches between two states, driven by dockMotion.ts's
     onBleedChange (see syncDockMotion):

       - at rest (the normal case): clip-path trims the strip back off.
         clip-path clips hit-testing as well as painting, so the strip is
         simply not part of the scroller — clicks and wheel there go
         straight to the page — while everything inside the panel has
         ordinary pointer events: the scrollbar drags, and wheel over blank
         areas (padding, below a short list) scrolls the list.
       - .is-bleeding (an item is magnified or relaxing back): no clip, so
         swollen items paint un-clipped over the page; the body itself goes
         pointer-events: none (children take events back) so the strip's
         empty parts still pass clicks to the page. Wheel over the items
         still scrolls the body (scroll chaining follows the box tree, not
         hit-testability). This state only lasts while the pointer is on
         the list (plus the ~300ms release), and the pointer can't be on
         the scrollbar *and* the list, so the scrollbar is back to normal
         by the time anyone reaches for it.

     The at-rest clip-path also makes .body a stacking context, which is
     harmless: at rest no item carries a z-index. While bleeding there is no
     clip, so per-item z-indexes compete in .sidebar's context as intended
     (see .resizer). */
  .body {
    flex: 1 1 auto;
    overflow-y: auto;
    /* Scrolling the list never carries on into the page behind it — not at
       either end, and not while the list is too short to scroll at all. */
    overscroll-behavior: contain;
    margin-left: -${DOCK_BLEED_PX}px;
    padding: 12px 0 ${LIST_PAD_BOTTOM_PX}px ${DOCK_BLEED_PX}px;
    clip-path: inset(0 0 0 ${DOCK_BLEED_PX}px);
    transition: opacity 140ms ease-out;
  }
  .body.is-bleeding {
    clip-path: none;
    pointer-events: none;
  }
  .body.is-bleeding > * { pointer-events: auto; }

  /* ─── §H: the sidebar is "on hold" during add mode ─────────────────────
     The note list takes no pointer or keyboard interaction while a selection
     is being placed or a note typed, and is dimmed so the state is legible.
     Dock magnification is switched off through the handle itself (see
     setAddModeHold) rather than fought with CSS, and the list's items are
     also taken out of the tab order in JS — pointer-events: none alone
     would still leave them keyboard-reachable. The header controls and the
     "add note" group are deliberately untouched: the user must always be
     able to stop or close. */
  .body.is-on-hold { opacity: 0.5; }
  .body.is-on-hold .thumbnail-list,
  .body.is-on-hold .thumbnail,
  .body.is-on-hold .thumbnail-delete { pointer-events: none; }

  .section-heading {
    margin: 0 16px 12px;
    font: 600 12px/1.2 var(--sal-font-body);
    color: var(--sal-muted);
  }
  .section-heading[hidden] { display: none !important; }

  .sr-only {
    position: absolute; width: 1px; height: 1px;
    margin: -1px; padding: 0; border: 0;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;
  }
  .empty-state {
    color: var(--sal-muted);
    font-size: 13px;
    line-height: 1.5;
    text-align: center;
    margin-top: 48px;
    padding: 0 24px;
  }
  .empty-state[hidden] { display: none !important; }

  .thumbnail-list {
    list-style: none;
    margin: 0;
    padding: 0 ${THUMBNAIL_LIST_PAD_X}px;
    display: flex;
    flex-direction: column;
    gap: ${THUMBNAIL_LIST_GAP_PX}px;
    overflow: visible;
    /* No isolation here on purpose: the per-item z-index dockMotion.ts
       writes (most magnified on top) has to compete in .sidebar's stacking
       context so a magnified item paints over the resizer *hairline*
       (z-index 1) — but never over the resizer's hit target, which sits
       above every item (RESIZER_Z_INDEX) so the handle stays grabbable. */
  }
  .thumbnail-list[hidden] { display: none !important; }

  /* Dock magnification target (design spec §4): src/dockMotion.ts writes
     transform (translateX/Y + scale), z-index and — only while animating —
     will-change on each <li> from a single rAF spring loop. Right-centre
     origin so items swell out to the left over the page. Deliberately no
     CSS transition on transform here: the spring *is* the easing, and a
     transition would lag every frame behind it. */
  .thumbnail-item {
    position: relative;
    transform-origin: right center;
  }
  /* Removal (v4 §L): the row fades, then collapses its own height and one
     list gap so the notes below slide up rather than jumping. The starting
     max-height is written inline first (a transition out of "none" does not
     run) and the negative margin swallows the flex gap the zero-height row
     would otherwise still contribute. No transform here: dockMotion.ts owns
     this element's transform, and the two would fight. */
  .thumbnail-item.is-removing {
    opacity: 0;
    max-height: 0 !important;
    margin-bottom: -${THUMBNAIL_LIST_GAP_PX}px;
    overflow: hidden;
    pointer-events: none;
    transition:
      opacity ${ITEM_REMOVE_FADE_MS}ms ${EASE_ACC},
      max-height ${ITEM_REMOVE_COLLAPSE_MS}ms ${EASE_STD} ${ITEM_REMOVE_FADE_MS - 40}ms,
      margin-bottom ${ITEM_REMOVE_COLLAPSE_MS}ms ${EASE_STD} ${ITEM_REMOVE_FADE_MS - 40}ms;
  }

  /* ─── Note list items (design spec §3.1/§4) ───────────────────────────
     Each item is a real <button> (src/thumbnails.ts) so Enter/Space/click
     all come from native button semantics rather than a hand-rolled
     role="button". No card/box around the item — just the thumbnail image
     and the note text below it.

     Dock magnification (§4) transforms the <li> around this button (see
     .thumbnail-item above), not the button itself, so the button's own
     press/state transitions never fight the spring. */
  .thumbnail {
    display: block;
    width: 100%;
    padding: 0;
    margin: 0;
    border: none;
    background: transparent;
    text-align: left;
    border-radius: var(--sal-radius-md);
    cursor: pointer;
    position: relative;
    ${STATE_TRANSITION_CSS}
  }
  .thumbnail:focus-visible { outline: none; }
  .thumbnail:focus-visible .thumbnail-image-wrap { ${FOCUS_RING_CSS} }

  .thumbnail-image-wrap {
    position: relative;
    width: 100%;
    height: 100px;
    border-radius: var(--sal-radius-md);
    overflow: hidden;
    background: var(--sal-raised);
    line-height: 0;
    /* Radius on all four corners in every state (design spec v2 §B) — this
       rule never changes on hover/focus. Needs an explicit stacking order
       above .thumbnail-note-bg (below): that layer's top edge is tucked up
       *underneath* this box's bottom edge (see .thumbnail-note-bg), and
       without this the two are plain same-context siblings painted in DOM
       order, which would put the note-wrap (later in the DOM) on top and
       show a sliver of it inside the thumbnail. */
    z-index: 1;
  }

  .thumbnail-image {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
  }
  /* A note's drawing (design spec §AB): over the image, the same box, fitted
     by its viewBox the way the image is by object-fit (thumbnails.ts). Never
     a click target — the thumbnail button underneath is. */
  .thumbnail-drawing {
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    overflow: hidden;
  }

  .thumbnail-badge {
    position: absolute;
    /* NOTE_INSET_PX, the note's single spacing value: the badge, the hover
       delete and the note text all sit that far in, so the badge's left edge
       lines up with the text's below it and the delete's right edge with the
       text's right. */
    top: ${NOTE_INSET_PX}px;
    left: ${NOTE_INSET_PX}px;
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    border-radius: var(--sal-radius-sm);
    background: var(--sal-accent);
    color: var(--sal-on-accent);
    font: 600 11px/20px var(--sal-font-mono);
    text-align: center;
  }

  /* No margin of its own (design spec v4 §L). It used to open an 8px gap
     between the thumbnail and the note — but the hover extension's top edge
     is the thumbnail's bottom edge, so that gap fell *inside* the background
     and stacked on top of the note's own 8px padding-top: 16px of visible
     inset above the first line against 8px below the last. The whole inset
     is the note's padding now, and it is the same number on all four
     sides. */
  .thumbnail-note-wrap {
    display: block;
    position: relative;
    /* The note's bottom inset (§L). It cannot live on .thumbnail-note: that
       element clips its own clamped overflow at its padding box, so a bottom
       padding there shows a sliced fourth line under the ellipsis — and a
       bottom MARGIN there would collapse straight through this block and
       take the background's inset with it. Here it is inside the padding box
       .thumbnail-note-bg is positioned against, so the background still sits
       NOTE_INSET_PX below the last line. */
    padding-bottom: ${NOTE_INSET_PX}px;
  }
  /* The note's hover/focus "extension" (design spec v2 §B): a separate layer
     so it can fade on opacity alone, exactly as before — dockMotion.ts still
     only ever touches this element's inline opacity (spring-driven while
     .thumbnail-list carries data-dock="on"; the plain :hover/:focus-visible
     rule below takes over under prefers-reduced-motion), so none of that
     wiring changed. What changed is the box itself: rather than a rectangle
     matching the note text's own area, it starts tucked one radius-md *up*
     under the thumbnail's bottom edge (the wrap has no margin of its own any
     more, §L, so that edge is also the wrap's top — and .thumbnail-image-wrap's
     higher z-index and opaque fill hide the overlap completely) and runs down
     to the note's bottom padding edge — same width as the thumbnail
     throughout, so its edges land exactly flush with the thumbnail's own. Only the bottom
     corners are rounded (the top is hidden under the thumbnail regardless).
     The note text itself never moves between rest and hover — only this
     layer's opacity changes. */
  .thumbnail-note-bg {
    position: absolute;
    left: 0;
    right: 0;
    /* One radius-md up, i.e. entirely under the thumbnail's bottom edge
       (which is now also the wrap's top edge, §L) — far enough that the
       rounded top corners are hidden behind .thumbnail-image-wrap's higher
       z-index and opaque fill. Its visible top edge is therefore the
       thumbnail's, and "bottom: 0" is the wrap's padding edge, one
       NOTE_INSET_PX below the last line, so the background sits the same
       distance from the text at both ends. */
    top: calc(-1 * var(--sal-radius-md));
    bottom: 0;
    border-radius: 0 0 var(--sal-radius-md) var(--sal-radius-md);
    background: var(--sal-surface);
    /* Soft outer drop shadow (shadowNote's own, which is identical in both
       themes) plus a 1px line border drawn INSIDE via an inset shadow rather
       than shadowNote's outset ring — an outset ring would bleed half a
       pixel past the thumbnail's own (border-less) edges on each side, and
       v2 §B calls for the two to align exactly. */
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.18), inset 0 0 0 1px var(--sal-line);
    opacity: 0;
    pointer-events: none;
    transition: opacity 140ms ease-out;
  }
  .thumbnail-list[data-dock="on"] .thumbnail-note-bg { transition: none; }

  .thumbnail-note {
    position: relative;
    margin: 0;
    /* The inset is uniform on all four sides (§L), but only three of them
       are here: overflow clips at the PADDING box, so a bottom padding gives
       the clamped fourth line somewhere to paint and it shows as a half-line
       sliced through under the ellipsis. With none, the clip lands exactly on
       the third line. The fourth side is .thumbnail-note-wrap's
       padding-bottom (a margin here would collapse through it). */
    padding: ${NOTE_INSET_PX}px ${NOTE_INSET_PX}px 0;
    max-width: 100%;
    border-radius: var(--sal-radius-md);
    background: transparent;
    font-size: 13px;
    /* Integer, not 1.4: the clamp below cuts at a whole number of lines, but
       a fractional line box rounds up and leaves a 1-2px sliver of the
       fourth line showing under the ellipsis. */
    line-height: 18px;
    color: var(--sal-text);
    word-break: break-word;
    /* Clamp to 3 lines (§3.1) rather than letting long notes push the list
       around. */
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    ${STATE_TRANSITION_CSS}
  }
  .thumbnail-note-empty { color: var(--sal-muted); font-style: italic; }
  /* Reduced-motion (or not-yet-wired) fallback for the note background:
     dockMotion.ts removes data-dock when prefers-reduced-motion is on, and
     then only this static hover/focus state remains (§4). */
  .thumbnail-list:not([data-dock="on"]) .thumbnail:hover .thumbnail-note-bg,
  .thumbnail-list:not([data-dock="on"]) .thumbnail:focus-visible .thumbnail-note-bg {
    opacity: 1;
  }

  /* ─── Delete on hover (design spec v4 §L) ──────────────────────────────
     A sibling of the item's <button class="thumbnail">, not a child of it:
     nested buttons are invalid HTML and break activation, so this sits in
     the <li> and is absolutely positioned over the thumbnail's top-right
     corner (mirroring the number badge's 8px inset on the left).

     It is inside the <li> dockMotion.ts transforms, so it rides the
     magnification with its item for free, and dockMotion fades it on the
     same spring as the note extension (see .thumbnail-note-bg) — hence
     opacity in the transition here, for the reduced-motion/no-dock case
     where the CSS below is the only thing that shows it.

     pointer-events: none while it is faded out is what keeps it out of
     the thumbnail's hit area: an opacity-0 button is still clickable, and
     an invisible delete over every screenshot's corner would be a trap. It
     stays tabbable throughout, though — §L wants it reachable by Tab after
     its own item, and :focus-visible below brings it into view. */
  .thumbnail-delete {
    position: absolute;
    /* NOTE_INSET_PX — the same spacing as the badge opposite it and the note
       text below (see .thumbnail-badge). */
    top: ${NOTE_INSET_PX}px;
    right: ${NOTE_INSET_PX}px;
    /* Above .thumbnail-image-wrap's z-index: 1, which is what it overlays. */
    z-index: 2;
    /* 28px. Three button sizes exist and no others: 28 here (this one sits
       on a thumbnail, where 32 crowded the image), 32 for the close, theme
       and enlarged-view delete buttons, 36 for the action row. */
    width: 28px;
    height: 28px;
    margin: 0;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--sal-line);
    border-radius: var(--sal-radius-md);
    background: var(--sal-surface);
    color: var(--sal-muted);
    cursor: pointer;
    opacity: 0;
    pointer-events: none;
    /* STATE_TRANSITION_CSS's timings plus the extension's own opacity fade:
       one shorthand, because a second transition declaration would replace
       the first rather than add to it. */
    ${STATE_TRANSITION_CSS.replace(/;$/, ', opacity 140ms ease-out;')}
  }
  .thumbnail-delete .icon { width: 16px; height: 16px; display: inline-flex; }
  .thumbnail-delete .icon svg { width: 100%; height: 100%; display: block; }
  .thumbnail-item:hover .thumbnail-delete,
  .thumbnail-item:has(:focus-visible) .thumbnail-delete {
    opacity: 1;
    pointer-events: auto;
  }
  /* dangerSoft and dangerPress are translucent in dark theme, and this
     button sits on a screenshot — so the tint is layered over the button's
     own opaque surface rather than used alone, which would let the image
     show through. Same colour, no transparency. */
  .thumbnail-delete:hover {
    background: linear-gradient(var(--sal-danger-soft), var(--sal-danger-soft)), var(--sal-surface);
    color: var(--sal-danger);
  }
  .thumbnail-delete:active {
    background: linear-gradient(var(--sal-danger-press), var(--sal-danger-press)), var(--sal-surface);
    color: var(--sal-danger);
  }
  /* Visible whenever it has focus (§L) — :focus-within above already covers
     this, but the ring must never paint on an invisible control. */
  .thumbnail-delete:focus-visible {
    opacity: 1;
    pointer-events: auto;
    ${FOCUS_RING_CSS}
    outline: none;
  }
  /* While the dock spring owns this element's opacity (inline), the CSS
     transition would fight it frame by frame — same reason .thumbnail-note-bg
     drops its transition. Only the opacity part goes; the fill/border/colour
     states are still the shared ones. */
  .thumbnail-list[data-dock="on"] .thumbnail-delete { ${STATE_TRANSITION_CSS} }

  /* Reduced motion (design spec §4, and v3 §A2/§C2's "reduced motion →
     instant"): every state change added by the action row still *happens*,
     it just happens at once. dockMotion.ts switches itself off separately. */
  @media (prefers-reduced-motion: reduce) {
    .add-switch-track,
    .add-switch-knob,
    .action-menu,
    .action-menu[data-open="true"],
    .body {
      transition: none;
    }
    /* The switch appears and collapses instantly. The grace period is a
       usability affordance rather than motion and is kept — it lives in
       updateSwitchReveal, not in a transition delay. */
    .add-switch { transition: none; }
    .action-menu { transform: none; }
    .action-menu[data-open="true"] { transform: none; }
  }
`;
