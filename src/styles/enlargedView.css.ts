// src/styles/enlargedView.css.ts
// The enlarged view's stylesheet (design spec §AH), moved out of
// enlargedView.ts unchanged. Appended to the sidebar's single <style>
// (sidebar.ts): the view renders inside the sidebar's shadow root.

import { FOCUS_RING_CSS, STATE_TRANSITION_CSS } from '../theme';
import {
  DOCKED_HEADER_H,
  EXIT_BTN_PX,
  HEADING_NAME_H,
  HEADING_SUB_GAP,
  HEADING_SUB_H,
  NOTE_TEXT_H,
  PANEL_MARGIN,
  PANEL_PAD_X,
  TOP_BAR_H,
} from '../enlargedLayout';
import { STD } from '../flip';

const EXIT_BTN = EXIT_BTN_PX;

// ---------------------------------------------------------------------------
// CSS — appended to the sidebar's single <style> (sidebar.ts)
// ---------------------------------------------------------------------------

const Z_SCRIM = 2147483643;
const Z_BG = 2147483644; // below .sidebar (2147483645)
const Z_STAGE = 2147483646;
const Z_FRONT = 2147483647;

/** A page's name, and the field that renames it: the display serif. */
const PAGE_NAME_FACE_CSS = `font-family: var(--sal-font-display); font-style: italic; font-weight: 400;
    font-size: 28px; line-height: 34px; letter-spacing: -0.01em;`;
/** The rename field's side padding, pulled back by a negative margin. */
const PAGE_FIELD_PAD_X = 12;

/** The 28px icon button (design spec §X's small size) of a note's header and
 *  a page heading — §L's list delete treatment, surface at rest. */
const SMALL_BUTTON_CSS = `
    flex-shrink: 0;
    width: 28px; height: 28px; margin: 0; padding: 0;
    display: flex; align-items: center; justify-content: center;
    border: 1px solid var(--sal-line); border-radius: var(--sal-radius-md);
    background: var(--sal-surface);
    color: var(--sal-muted);
    cursor: pointer;
    ${STATE_TRANSITION_CSS}`;

export const ENLARGED_VIEW_CSS = `
  /* ─── Enlarged view (design spec §AH, src/enlargedView.ts) ───────────── */
  .sidebar.is-expanded { pointer-events: none !important; }
  /* The header mark is replaced by .xp-brand, which rides the panel edge. */
  .sidebar.is-brand-riding .header .logo,
  .sidebar.is-brand-riding .header .wordmark { visibility: hidden; }

  .xp-scrim {
    position: fixed; inset: 0;
    background: var(--sal-scrim);
    z-index: ${Z_SCRIM};
    pointer-events: auto;
  }
  .xp-bg {
    position: fixed; top: 0; bottom: 0; right: 0;
    background: var(--sal-bg);
    border-left: 1px solid var(--sal-line);
    z-index: ${Z_BG};
    pointer-events: auto;
  }
  .xp-stage, .xp-front {
    position: fixed; top: 0; bottom: 0; right: 0;
    overflow: hidden;
    pointer-events: none;
  }
  .xp-stage { z-index: ${Z_STAGE}; }
  /* The clones are clipped where the scroller is: below the top bar. */
  .xp-front { z-index: ${Z_FRONT}; clip-path: inset(${TOP_BAR_H}px 0 0 0); }

  .xp-brand {
    position: absolute; top: 0; left: ${PANEL_MARGIN}px;
    height: ${DOCKED_HEADER_H}px;
    display: flex; align-items: center; gap: 10px;
    pointer-events: none;
    white-space: nowrap;
  }
  .xp-brand img { width: 35px; height: 20px; display: block; flex-shrink: 0; }
  .xp-brand-word {
    font-family: var(--sal-font-display);
    font-style: italic; font-size: 22px; line-height: 1;
    color: var(--sal-text);
  }

  /* The top bar's bottom rule (design spec §AH, 2026-10-13): the docked
     header block's divider — .action-row's 1px \`line\` border, edge to
     edge — on the bar's last pixel row, above the scroller's hard cut. */
  .xp-bar-rule {
    position: absolute; left: 0; right: 0; top: ${TOP_BAR_H - 1}px;
    height: 0;
    border-bottom: 1px solid var(--sal-line);
    pointer-events: none;
  }

  /* Exit: one secondary icon button, top right — a right-pointing
     chevron (icons.ts, ICON_CHEVRON_RIGHT). */
  .xp-exit {
    position: absolute; top: ${PANEL_MARGIN}px; right: ${PANEL_MARGIN}px;
    width: ${EXIT_BTN}px; height: ${EXIT_BTN}px; margin: 0; padding: 0;
    display: flex; align-items: center; justify-content: center;
    background: var(--sal-surface);
    border: 1px solid var(--sal-line);
    border-radius: var(--sal-radius-md);
    color: var(--sal-text);
    cursor: pointer;
    pointer-events: auto;
    ${STATE_TRANSITION_CSS}
  }
  /* The top bar's notice (the site could not be read in full), right-
     aligned against the exit button. */
  .xp-notice {
    position: absolute; top: 0; right: ${PANEL_MARGIN + EXIT_BTN + PANEL_MARGIN}px;
    margin: 0;
    font-size: 12px; line-height: ${TOP_BAR_H}px;
    color: var(--sal-danger);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    pointer-events: none;
  }
  .xp-exit:hover { background: var(--sal-hover); border-color: var(--sal-line-strong); }
  .xp-exit:active { background: var(--sal-press); border-color: var(--sal-line-strong); }
  .xp-exit:focus-visible { outline: none; ${FOCUS_RING_CSS} }
  .xp-exit svg { width: 18px; height: 18px; display: block; }

  /* The whole site, one scrolling page. The gutter is stable, so the content
     width never changes with the content's height; overscroll stops here
     rather than chaining to the (locked) host page. */
  .xp-scroll {
    position: absolute; top: ${TOP_BAR_H}px; bottom: 0; right: 0;
    overflow-x: hidden; overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
    scrollbar-width: thin;
    scrollbar-color: var(--sal-line-strong) transparent;
    pointer-events: auto;
    outline: none;
  }
  .xp-content { position: relative; margin: 0 0 0 ${PANEL_PAD_X}px; }

  /* A page heading (src/pageHeading.ts): the name and its pencil on one
     line, the address and "this page" on the line under it. */
  .xp-page { position: absolute; }
  .xp-page-line {
    height: ${HEADING_NAME_H}px;
    display: flex; align-items: center; gap: 8px;
    min-width: 0;
  }
  .xp-page-sub {
    height: ${HEADING_SUB_H}px; margin-top: ${HEADING_SUB_GAP}px;
    display: flex; align-items: center; gap: 8px;
    min-width: 0;
  }
  /* The serif's italic ink overhangs its box on the left: the padding gives
     it room, the negative margin keeps the text's origin on the column's
     edge. Ellipsized past 85% of the line, with the rest in its tooltip. */
  .xp-page-name {
    flex: 0 1 auto; min-width: 0; max-width: 85%;
    margin: 0 0 0 -8px; padding: 0 4px 0 8px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    ${PAGE_NAME_FACE_CSS}
    color: var(--sal-text);
  }
  .xp-page-name[hidden], .xp-page-edit[hidden], .xp-page-editor[hidden] { display: none; }
  /* The pencil is the note delete's button (SMALL_BUTTON_CSS) without the
     red: the same box, border and radius, a neutral hover and press. */
  .xp-page-edit { ${SMALL_BUTTON_CSS} }
  .xp-page-edit:hover {
    background: linear-gradient(var(--sal-hover), var(--sal-hover)), var(--sal-surface);
    color: var(--sal-text);
  }
  .xp-page-edit:active {
    background: linear-gradient(var(--sal-press), var(--sal-press)), var(--sal-surface);
    color: var(--sal-text);
  }
  .xp-page-edit:focus-visible { outline: none; ${FOCUS_RING_CSS} }
  .xp-page-edit svg { width: 16px; height: 16px; display: block; }
  .xp-page-editor { display: flex; align-items: center; gap: 6px; flex: 0 1 auto; min-width: 0; }
  /* The name made editable in place: its face, size and line, in the note
     text area's field (surface, inset line, accent on focus). The padding is
     pulled back by a negative margin so the text stays where the name's
     was; its width follows the text (pageHeading.ts, sizeField). */
  .xp-page-input {
    width: 360px; min-width: 0; max-width: 100%; flex: 0 1 auto;
    height: ${HEADING_NAME_H}px;
    margin: 0 0 0 -${PAGE_FIELD_PAD_X}px; padding: 0 ${PAGE_FIELD_PAD_X}px;
    border: none; outline: none;
    border-radius: var(--sal-radius-md);
    background: var(--sal-surface);
    color: var(--sal-text);
    ${PAGE_NAME_FACE_CSS}
    box-shadow: inset 0 0 0 1px var(--sal-line);
    transition: box-shadow 150ms ${STD.css};
  }
  .xp-page-input:hover { box-shadow: inset 0 0 0 1px var(--sal-line-strong); }
  .xp-page-input:focus { box-shadow: inset 0 0 0 1px var(--sal-accent); }
  /* The mirror the field is sized from: the same face, never seen. */
  .xp-page-measure {
    position: absolute; left: 0; top: 0;
    visibility: hidden; white-space: pre; pointer-events: none;
    ${PAGE_NAME_FACE_CSS}
  }
  .xp-page-save, .xp-page-cancel {
    ${SMALL_BUTTON_CSS}
    color: var(--sal-text);
  }
  /* Saving is the yellow action, like add mode's save (2026-09-30). */
  .xp-page-save { color: var(--sal-accent-icon); }
  .xp-page-save:hover, .xp-page-cancel:hover { background: var(--sal-hover); border-color: var(--sal-line-strong); }
  .xp-page-save:active, .xp-page-cancel:active { background: var(--sal-press); border-color: var(--sal-line-strong); }
  .xp-page-save:focus-visible, .xp-page-cancel:focus-visible { outline: none; ${FOCUS_RING_CSS} }
  .xp-page-save svg, .xp-page-cancel svg { width: 16px; height: 16px; display: block; }
  /* The address: regular ink, not muted — it is what tells two pages with
     the same title apart. */
  .xp-page-url {
    flex: 0 1 auto; min-width: 0;
    /* Middle-ellipsized to fit in JS (pageHeading.ts); the end ellipsis is
       only a net, should the face change size under it. */
    overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
    font: 400 12px/20px var(--sal-font-mono);
    color: var(--sal-text);
  }
  /* "this page": a small label in regular ink, outlined in the line colour. */
  .xp-page-here {
    flex-shrink: 0;
    height: 20px; padding: 0 7px;
    border-radius: var(--sal-radius-sm);
    box-shadow: inset 0 0 0 1px var(--sal-line);
    font: 600 11px/20px var(--sal-font-body);
    color: var(--sal-text);
    white-space: nowrap;
  }
  .xp-page-status {
    position: absolute; top: calc(100% + 2px); left: 0;
    margin: 0;
    font-size: 12px; line-height: 16px;
    color: var(--sal-danger);
    opacity: 0;
  }
  .xp-page-status.is-shown { opacity: 1; }

  /* A note: its bar, screenshot and editor — each placed on its own. The
     bar is "#n" and delete side by side, centred over the image. */
  .xp-note-head {
    position: absolute;
    display: flex; align-items: center; justify-content: center; gap: 8px;
  }
  .xp-note-num {
    font: 600 12px/1 var(--sal-font-mono);
    color: var(--sal-muted);
  }
  .xp-note-delete { ${SMALL_BUTTON_CSS} }
  /* Layered over the button's own surface, not used alone: both tints are
     translucent in the dark theme (see .thumbnail-delete). */
  .xp-note-delete:hover {
    background: linear-gradient(var(--sal-danger-soft), var(--sal-danger-soft)), var(--sal-surface);
    color: var(--sal-danger);
  }
  .xp-note-delete:active {
    background: linear-gradient(var(--sal-danger-press), var(--sal-danger-press)), var(--sal-surface);
    color: var(--sal-danger);
  }
  .xp-note-delete:focus-visible { outline: none; ${FOCUS_RING_CSS} }
  .xp-note-delete svg { width: 16px; height: 16px; display: block; }

  /* The screenshot at its own size: no card, no border. The raised fill is
     only ever seen before the first image has decoded. */
  .xp-shot {
    position: absolute;
    border-radius: var(--sal-radius-md);
    overflow: hidden;
    background: var(--sal-raised);
    cursor: text;
  }
  /* Every box has its image's proportions (enlargedLayout.ts, fitShot), so
     cover crops nothing visible; it only keeps a sub-pixel rounding from
     showing as a band of the fill. */
  .xp-shot-img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .xp-shot-drawing, .xp-card-drawing {
    position: absolute; left: 0; top: 0;
    width: 100%; height: 100%;
    pointer-events: none;
    overflow: hidden;
  }

  .xp-editor { position: absolute; height: ${NOTE_TEXT_H}px; }
  /* Design spec v2 §C's text area, at a fixed height: it scrolls inside
     rather than growing. No overscroll containment of its own — a wheel at
     its end moves on to the scroller rather than sticking on one of a page
     of text areas. */
  .xp-note-input {
    display: block; width: 100%; height: 100%;
    margin: 0; padding: 12px 14px;
    resize: none; border: none; outline: none;
    overflow-y: auto;
    border-radius: var(--sal-radius-lg);
    background: var(--sal-surface);
    color: var(--sal-text);
    font-family: var(--sal-font-body); font-size: 14px; line-height: 1.45;
    /* 1px border drawn inside; colour-only state changes (150ms std —
       MOTION_SPEC §11 reuses this exact transition for the danger state). */
    box-shadow: inset 0 0 0 1px var(--sal-line);
    transition: box-shadow 150ms ${STD.css};
  }
  .xp-note-input::placeholder { color: var(--sal-muted); }
  .xp-note-input:hover { box-shadow: inset 0 0 0 1px var(--sal-line-strong); }
  .xp-note-input:focus { box-shadow: inset 0 0 0 1px var(--sal-accent); }
  .xp-note-input.is-error,
  .xp-note-input.is-error:hover,
  .xp-note-input.is-error:focus { box-shadow: inset 0 0 0 1px var(--sal-danger); }
  /* The one line under a text area: "note required" or a failure. Out of
     flow, in the row gap, so it reserves no space while idle. */
  .xp-note-status {
    position: absolute; top: calc(100% + 6px); left: 0; right: 0;
    margin: 0;
    font-size: 12px; line-height: 16px;
    color: var(--sal-danger);
    opacity: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }

  /* Morph clones — see flip.ts for the transform-only morph they serve. */
  .xp-card {
    position: absolute;
    margin: 0; padding: 0;
    pointer-events: none;
  }
  .xp-card-frame {
    position: absolute; left: 0; top: 0; width: 100%; height: 100%;
    border-radius: var(--sal-radius-md);
    overflow: hidden;
    transform-origin: 0 0;
  }
  /* The media box: the contain-fit of the screenshot into the frame, and the
     element the morph's second track transforms (flip.ts). The drawing is
     the image's sibling in it and rides the same transform. */
  .xp-card-media {
    position: absolute;
    display: block;
    overflow: hidden;
    transform-origin: 0 0;
  }
  .xp-card-img {
    display: block;
    width: 100%; height: 100%;
    max-width: none;
    object-fit: contain;
  }
  .xp-card-badge {
    position: absolute; top: 8px; left: 8px;
    min-width: 20px; height: 20px; padding: 0 6px;
    border-radius: var(--sal-radius-sm);
    background: var(--sal-accent); color: var(--sal-on-accent);
    font: 600 11px/20px var(--sal-font-mono);
    text-align: center;
    transform-origin: 0 0;
  }
  @media (prefers-reduced-motion: reduce) {
    .xp-note-input, .xp-page-input { transition: none; }
  }
`;
