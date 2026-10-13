// src/styles/addMode.css.ts
// Add mode's stylesheet (design spec §3.2, §AB, §G), moved out of
// addMode.ts unchanged. addMode.ts puts it in its shadow root's one <style>,
// after the theme tokens and before the shared tooltip's CSS.

import { DISABLED_CSS, FOCUS_RING_CSS, STATE_TRANSITION_CSS } from '../theme';
import { PENCIL_CURSOR } from '../icons';
import {
  COMMENT_PAD_PX,
  COMMENT_ROW_PX,
  COMMENT_WIDTH,
  DRAW_MENU_ABOVE_OFFSET,
  DRAW_MENU_GAP,
  NOTE_INPUT_HEIGHT_PX,
  OUTLINE_DASH,
  OUTLINE_PAD,
  OUTLINE_W,
} from '../addModeMetrics';

const COMMENT_INNER_RADIUS_CSS = `calc(var(--sal-radius-lg) - ${COMMENT_PAD_PX}px)`;

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

// Every colour/radius/font below is a --sal-* token from getThemeCSS(), which
// buildDOM() prepends into this same <style> element (the dark set — the
// extension is dark only, design spec §AA).
export const ADD_MODE_CSS = `
  :host {
    font-family: var(--sal-font-body);
  }
  *, *::before, *::after { box-sizing: border-box; }

  .blocker {
    position: absolute;
    top: 0;
    left: 0;
    background: transparent;
  }
  .blocker.placing { cursor: crosshair; }

  .visuals[data-hidden="true"] { visibility: hidden; }
  /* A descendant that sets visibility: visible itself would override the
     inherited hidden above and show up in the screenshot. These two are the
     only ones that do; this out-specifies both. */
  .visuals[data-hidden="true"] .counter,
  .visuals[data-hidden="true"] .draw-menu { visibility: hidden; }
  /* Nothing selection-related renders until the first placement/drag gives
     the box a real rect (renderBox() sets data-has-box). Without this the
     scrim's spread shadow would dim the whole page during 'placing'. */
  .visuals:not([data-has-box="true"]) .scrim-layer,
  .visuals:not([data-has-box="true"]) .box,
  .visuals:not([data-has-box="true"]) .resize-zone { display: none; }

  /* Scrim: a single transparent element exactly over the box, with the same
     corner radius, casting a huge spread shadow in the scrim colour. That
     leaves a hole whose corners match the rounded outline (the v1 four-strip
     scrim only worked for a square box). The layer is sized to the page
     content area and clips, so the spread never dims the sidebar. */
  .scrim-layer {
    position: absolute;
    top: 0;
    left: 0;
    overflow: hidden;
    pointer-events: none;
  }
  .scrim {
    position: absolute;
    border-radius: var(--sal-radius-md);
    box-shadow: 0 0 0 200vmax var(--sal-scrim);
    pointer-events: none;
  }

  /* Selection outline (see OUTLINE_W): the alternating line is entirely the
     .box-dash SVG below, drawn OUTSIDE the box — its rect IS the selection,
     so nothing may cover it, which is why the SVG overhangs. No hover/press
     styling — only the cursor over the hit zones below changes. */
  .box {
    position: absolute;
    border-radius: var(--sal-radius-md);
    background: transparent;
    pointer-events: none;
  }

  .resize-zone {
    position: absolute;
    background: transparent;
    /* .visuals inherits pointer-events: none from the host; the hit zones
       must opt back in or no mousedown ever reaches them. */
    pointer-events: auto;
  }

  /* Add-mode preview (design spec §G): while 'placing' and before any box
     has been placed, hovering shows the same box+scrim visuals as a live
     preview of the box a click would produce right now. These two rules are
     an equal-specificity override of the ".visuals:not([data-has-box]) ..."
     display:none rule above (three class/attribute selectors on each side),
     so they only need to win by appearing later in the stylesheet — no
     !important, no touching that rule (a regression test pins its exact
     text). Faded in via opacity rather than the display flip itself, since
     display can't transition; onPlacementHoverMove() forces a style flush
     between setting data-preview and data-preview-visible so the fade-in
     actually runs (see showPreview()). Hiding is instant (spec only
     describes an appear fade), which also covers reduced motion without a
     media-query duplicate of the whole rule. */
  .visuals[data-preview="true"] .scrim-layer,
  .visuals[data-preview="true"] .box {
    display: block;
    opacity: 0;
    transition: opacity 120ms ease-out;
  }
  .visuals[data-preview="true"][data-preview-visible="true"] .scrim-layer,
  .visuals[data-preview="true"][data-preview-visible="true"] .box {
    opacity: 1;
  }

  /* Tooltip that follows the cursor alongside the preview (design spec §G):
     "click or drag to select". Uses the real box/comment surface treatment
     (surface fill, line border, radius md, shadowNote) so it reads as part
     of the same UI. Position is set 1:1 with the pointer in JS (no
     transition on left/top — only opacity fades, per the motion-design
     skill's rule for pointer-following UI: the tracked position itself
     never eases or lags, only the appearance/disappearance may). It is a
     first-run hint, so it also fades back OUT after ~5s and never returns
     for the rest of the page session (v4 §N) — same 120ms opacity
     transition in both directions. */
  .preview-tooltip {
    position: absolute;
    z-index: 1;
    padding: 6px 10px;
    border: 1px solid var(--sal-line);
    border-radius: var(--sal-radius-md);
    background: var(--sal-surface);
    box-shadow: var(--sal-shadow-note);
    color: var(--sal-text);
    font-family: var(--sal-font-body);
    font-size: 12px;
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    transition: opacity 120ms ease-out;
  }
  .preview-tooltip[data-visible="true"] { opacity: 1; }

  /* The alternating outline. Two rects on the same path at the same stroke
     width: ink underneath, accent dashed on top, so the "gaps" are ink
     rather than holes and the line never gets thicker than OUTLINE_W. Sized
     in JS (paintBoxOutline) because the dash length has to stay 4px whatever
     the box's size — a viewBox that scaled would stretch it. */
  .box-dash {
    position: absolute;
    left: -${OUTLINE_PAD}px;
    top: -${OUTLINE_PAD}px;
    overflow: visible;
    pointer-events: none;
  }
  .box-dash rect { fill: none; stroke-width: ${OUTLINE_W}; }
  .box-dash .dash-ink { stroke: var(--sal-on-accent); }
  .box-dash .dash-accent { stroke: var(--sal-accent); stroke-dasharray: ${OUTLINE_DASH} ${OUTLINE_DASH}; }

  /* The drawing surface (design spec §AB): exactly the selection's rect,
     clipping a layer of strokes that lives in viewport coordinates — so the
     strokes are pinned to the page and a resize only moves the clip. It is
     the rect's interior only: the resize zones are later siblings and win
     the hit test along the edges, keeping their resize cursors. A plain
     rectangular clip, like the crop itself, so what shows is exactly what
     the saved drawing will hold. Inside .visuals, so hideOverlayUI() takes
     it out of the screenshot with everything else. Built with the comment
     box, i.e. never during 'placing'. */
  .draw-surface {
    position: absolute;
    overflow: hidden;
    pointer-events: auto;
    cursor: ${PENCIL_CURSOR};
    outline: none;
    touch-action: none;
    user-select: none;
  }
  .visuals:not([data-has-box="true"]) .draw-surface { display: none; }
  .draw-strokes {
    position: absolute;
    overflow: visible;
    pointer-events: none;
  }
  /* Mid-stroke the pointer may cross a hit zone or the comment box; the
     pencil stays the pencil until the stroke ends. (The zones' own cursor
     is an inline style, hence !important.) */
  .visuals[data-drawing="true"] .resize-zone,
  .visuals[data-drawing="true"] .comment-box,
  .visuals[data-drawing="true"] .comment-box * { cursor: ${PENCIL_CURSOR} !important; }

  /* One rounded surface holding the text area and, below it, the button
     row, both inset by COMMENT_PAD_PX so their edges line up. */
  .comment-box {
    position: absolute;
    width: ${COMMENT_WIDTH}px;
    color: var(--sal-text);
    font-family: var(--sal-font-body);
    /* The box is the surface (design spec, 2026-09-30): the sidebar's own
       background, like its button bar, with the text area and the button
       row inset by the same padding all round. Its 1px line is an inset
       shadow, so the padding is measured from its outer edge. */
    box-sizing: border-box;
    padding: ${COMMENT_PAD_PX}px;
    background: var(--sal-bg);
    box-shadow: var(--sal-shadow-pop), inset 0 0 0 1px var(--sal-line);
    border-radius: var(--sal-radius-lg);
    /* .visuals inherits pointer-events: none from the host (the host is
       pointer-events: none so the blocker underneath can own page-click
       suppression while non-interactive visuals like the box outline and
       scrim stay click-through). .resize-zone opts itself back into auto
       above; the comment box and everything in it (textarea, cancel/save
       buttons) need the same opt-in, or their clicks fall through to nothing
       and only keyboard/Tab focus keeps working. */
    pointer-events: auto;
  }

  /* The text area: a bordered surface inset in the box, its corners
     concentric with the box's (COMMENT_INNER_RADIUS_CSS), like the buttons
     below it. A real 1px border (box-sizing: border-box keeps it from
     growing the box), surface fill. Hover/focus only ever change the border
     colour — no extra ring, no shape change. */
  .note-input {
    display: block;
    width: 100%;
    height: ${NOTE_INPUT_HEIGHT_PX}px;
    box-sizing: border-box;
    margin: 0;
    resize: none;
    border: 1px solid var(--sal-line);
    border-radius: ${COMMENT_INNER_RADIUS_CSS};
    outline: none;
    background: var(--sal-surface);
    /* The box's own padding, so text, edges and buttons share one inset. */
    padding: ${COMMENT_PAD_PX}px;
    font-family: var(--sal-font-body);
    font-size: 13px;
    line-height: 1.4;
    color: var(--sal-text);
    transition: border-color 140ms ease-out;
  }
  .note-input::placeholder { color: var(--sal-muted); }
  .note-input:hover { border-color: var(--sal-line-strong); }
  /* After :hover so focus wins while both apply. */
  .note-input:focus { border-color: var(--sal-accent); }

  /* The button row: the pencil tools on the left, the counter, cancel and
     save on the right, COMMENT_PAD_PX below the text area. */
  .footer {
    padding-top: ${COMMENT_PAD_PX}px;
    display: flex;
    align-items: center;
    gap: 4px;
  }


  /* Right side (design spec §AB): the counter sits just left of cancel. It
     only takes up room once it shows — hidden, it would push the bar past
     its 296px with the pencil tools on the left. */
  .counter {
    padding: 0 4px;
    font-family: var(--sal-font-mono);
    font-size: 11px;
    color: var(--sal-muted);
    visibility: hidden;
  }
  .counter[data-warn="true"] { visibility: visible; }
  .counter[data-danger="true"] { color: var(--sal-danger); font-weight: 600; }
  .counter:not([data-warn="true"]) { display: none; }

  /* Left side (design spec §AB): the pencil, then its three swatches. The
     group pushes everything after it to the right. */
  .draw-tools {
    display: flex;
    align-items: center;
    gap: 2px;
    margin-right: auto;
  }

  /* The pencil: a 28px icon button (§X) and a menu button (§C2), drawn like
     the sidebar's button bar (§AE): surface fill, 1px line border, text-
     coloured glyph; hover and press change the fill and light the border.
     border-box, so the border does not change its 28px size. */
  .btn-pencil {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    margin: 0;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--sal-line);
    border-radius: ${COMMENT_INNER_RADIUS_CSS};
    background: var(--sal-surface);
    color: var(--sal-text);
    cursor: pointer;
    outline: none;
    ${STATE_TRANSITION_CSS}
  }
  .btn-pencil .icon { width: 16px; height: 16px; display: inline-flex; }
  .btn-pencil .icon svg { width: 100%; height: 100%; display: block; }
  /* Open takes the hover fill, like the sidebar's "more options" button
     (§AE). Before :hover and :active so the press fill still reads while
     it is open. */
  .btn-pencil[aria-expanded="true"] { background: var(--sal-hover); border-color: var(--sal-line-strong); }
  .btn-pencil:not(:disabled):hover { background: var(--sal-hover); border-color: var(--sal-line-strong); }
  .btn-pencil:not(:disabled):active { background: var(--sal-press); border-color: var(--sal-line-strong); }
  .btn-pencil:focus-visible { ${FOCUS_RING_CSS} }
  .btn-pencil:disabled { ${DISABLED_CSS} }

  /* The swatches: a radio group of 18px-wide targets, each holding a 12px
     circle in its colour. Every dot carries a 1px lineStrong edge, which is
     what keeps the black one visible on the dark bar; the checked one adds
     a gap and a text-coloured ring. Keyboard focus is the standard ring on
     the target, so "checked" and "focused" never look alike. */
  .swatches { display: flex; align-items: center; }
  .swatch {
    width: 18px;
    height: 28px;
    flex-shrink: 0;
    margin: 0;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: var(--sal-radius-sm);
    background: transparent;
    cursor: pointer;
    outline: none;
  }
  .swatch-dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    box-shadow: 0 0 0 1px var(--sal-line-strong);
    transition: box-shadow 140ms ease-out;
  }
  .swatch:not(:disabled):hover .swatch-dot { box-shadow: 0 0 0 1px var(--sal-muted); }
  .swatch[aria-checked="true"] .swatch-dot,
  .swatch[aria-checked="true"]:not(:disabled):hover .swatch-dot {
    /* The gap is the bar's own fill, so the ring floats clear of the dot. */
    box-shadow: 0 0 0 2px var(--sal-bg), 0 0 0 3.5px var(--sal-text);
  }
  .swatch:focus-visible { ${FOCUS_RING_CSS} }
  .swatch:disabled { ${DISABLED_CSS} }

  /* The pencil's menu — the sidebar's "more options" menu (§C2, §AE), same
     surface, item and motion: closed is the base state and carries the exit
     (90ms, accelerating), [data-open] the entrance (120ms, standard).
     visibility rather than [hidden] so both directions animate and nothing
     inside is focusable while it is closed. A child of the comment box, so
     it is placed against the box and lines up with the pencil
     (COMMENT_PAD_PX in): it opens below the box, or above the pencil when
     there is no room below. */
  .draw-menu {
    position: absolute;
    left: ${COMMENT_PAD_PX}px;
    top: calc(100% + ${DRAW_MENU_GAP}px);
    z-index: 2;
    min-width: 132px;
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    border: 1px solid var(--sal-line);
    border-radius: var(--sal-radius-md);
    background: var(--sal-surface);
    box-shadow: var(--sal-shadow-pop);
    transform-origin: top left;
    opacity: 0;
    visibility: hidden;
    transform: scale(0.96);
    transition:
      opacity 90ms cubic-bezier(.3, 0, 1, 1),
      transform 90ms cubic-bezier(.3, 0, 1, 1),
      visibility 0s linear 90ms;
  }
  .draw-menu[data-placement="above"] {
    top: auto;
    bottom: ${DRAW_MENU_ABOVE_OFFSET}px;
    transform-origin: bottom left;
  }
  .draw-menu[data-open="true"] {
    opacity: 1;
    visibility: visible;
    transform: scale(1);
    transition:
      opacity 120ms cubic-bezier(.2, 0, 0, 1),
      transform 120ms cubic-bezier(.2, 0, 0, 1),
      visibility 0s;
  }
  .draw-menu-item {
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
    outline: none;
    ${STATE_TRANSITION_CSS}
  }
  .draw-menu-item:hover { background: var(--sal-hover); }
  .draw-menu-item:focus-visible { background: var(--sal-hover); }
  .draw-menu-item:active { background: var(--sal-press); }
  /* Greyed out (soft-disabled) while nothing is drawn; these outrank the
     hover and press above on specificity. */
  .draw-menu-item[aria-disabled="true"] { ${DISABLED_CSS} }
  .draw-menu-item[aria-disabled="true"]:hover,
  .draw-menu-item[aria-disabled="true"]:active { background: transparent; }
  .draw-menu-item .icon { width: 16px; height: 16px; flex-shrink: 0; display: inline-flex; }
  .draw-menu-item .icon svg { width: 100%; height: 100%; display: block; }

  /* Cancel and save (design spec §2 rows, restyled per v2 §C), drawn like
     the sidebar's button bar (§AE): surface fill and a 1px line border that
     hover and press light up. COMMENT_ROW_PX tall, free-floating inside the
     box, with corners concentric with the box's (COMMENT_INNER_RADIUS_CSS).
     The border is inside the box (border-box), and the side padding gives
     back its 1px, so the buttons keep their size. */
  .btn {
    height: ${COMMENT_ROW_PX}px;
    margin: 0;
    padding: 0 11px;
    border: 1px solid var(--sal-line);
    border-radius: ${COMMENT_INNER_RADIUS_CSS};
    background: var(--sal-surface);
    font-family: var(--sal-font-body);
    font-size: 13px;
    cursor: pointer;
    outline: none;
    ${STATE_TRANSITION_CSS}
  }
  .btn:disabled { ${DISABLED_CSS} }

  .btn:not(:disabled):hover { background: var(--sal-hover); border-color: var(--sal-line-strong); }
  .btn:not(:disabled):active { background: var(--sal-press); border-color: var(--sal-line-strong); }
  .btn:focus-visible { ${FOCUS_RING_CSS} }

  .btn-cancel {
    color: var(--sal-text);
    font-weight: 500;
  }

  /* Save is yellow text on the plain button, like "add note"'s glyph: it
     never fills yellow; hover and press are the plain button's. */
  .btn-save {
    color: var(--sal-accent-icon);
    font-weight: 700;
  }
  /* Empty note: muted text at half opacity (design spec §2 "save disabled"). */
  .btn-save:disabled,
  .btn-save[aria-disabled="true"] { color: var(--sal-muted); opacity: 0.5; }
  /* Greyed out but still hoverable (so its reason can show): no hover or
     press change, no pointer. */
  .btn-save[aria-disabled="true"] { cursor: default; }
  .btn-save[aria-disabled="true"]:hover,
  .btn-save[aria-disabled="true"]:active { background: var(--sal-surface); border-color: var(--sal-line); }
  /* While capturing (after save), keep the yellow text so "saving…" reads as
     in-progress rather than as the empty-note disabled state. */
  .comment-box[aria-busy="true"] .btn-save:disabled { color: var(--sal-accent-icon); opacity: 1; }

  /* Motion-design skill: reduced motion keeps the opacity change (still
     communicates state) but drops the transition itself, so the preview and
     tooltip appear instantly instead of fading in. Nothing here needs a
     "remove spatial movement" rule — the preview/tooltip never had any: both
     already track the pointer 1:1 with plain style writes, never eased. */
  @media (prefers-reduced-motion: reduce) {
    .visuals[data-preview="true"] .scrim-layer,
    .visuals[data-preview="true"] .box,
    .preview-tooltip,
    .draw-menu,
    .draw-menu[data-open="true"],
    .swatch-dot {
      transition: none;
    }
    .draw-menu,
    .draw-menu[data-open="true"] { transform: none; }
  }
`;
