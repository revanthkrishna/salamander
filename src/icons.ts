// src/icons.ts
// Inline currentColor SVG icons — 1.8px stroke, round caps/joins (design
// spec §1's icon language), 24-unit viewBox. Every surface (sidebar, enlarged
// view, note list) draws from this one set, so a glyph exists exactly once
// (design spec v5 §S: one trash icon) and a change to the stroke language
// happens in one place.
//
// Pure strings: no DOM, so any module may import it.

/** Shared attributes for every stroke icon. */
const STROKE_ICON_ATTRS =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

/** Chevron variant for the export group's menu half (design spec v3 §C2) —
 *  12px at a heavier 2px stroke so it still reads at that size. */
const CHEVRON_ICON_ATTRS =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

function strokeIcon(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" ${STROKE_ICON_ATTRS}>${body}</svg>`;
}

function chevronIcon(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" ${CHEVRON_ICON_ATTRS}>${body}</svg>`;
}

/** The up/down arrow paths, shared by the menu chevrons (2px stroke) and the
 *  enlarged view's rail arrows (1.8px). */
const PATH_ARROW_DOWN = '<path d="M6 9l6 6 6-6"/>';
const PATH_ARROW_UP = '<path d="M6 15l6-6 6 6"/>';

// ─── Sidebar action row / header ────────────────────────────────────────────

/** "add note" (design spec v3 §A2): a comment bubble rather than the v2 plus,
 *  because the button is now icon-only — a bare plus reads as "add anything",
 *  a bubble reads as "add a note". Rendered at 17px inside the 36px half. */
export const ICON_COMMENT = strokeIcon(
  '<path d="M20 14a2 2 0 0 1-2 2H8.5L4 19.5V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/>',
);

/** Drawn as two variants rather than a rotation so the open/closed arrow is
 *  the exact path the spec names. */
export const ICON_CHEVRON_DOWN = chevronIcon(PATH_ARROW_DOWN);
export const ICON_CHEVRON_UP = chevronIcon(PATH_ARROW_UP);

export const ICON_EXPORT = strokeIcon('<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14"/>');
export const ICON_IMPORT = strokeIcon('<path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M5 19h14"/>');
export const ICON_CLOSE = strokeIcon('<path d="M6 6l12 12M18 6L6 18"/>');

/** Error-bar icon. */
export const ICON_ERROR = strokeIcon('<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>');
/** Warning-bar icon. */
export const ICON_WARNING = strokeIcon('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>');

// ─── Note list + enlarged view ──────────────────────────────────────────────

/** The project's ONE trash glyph (design spec v5 §S): the list's hover delete
 *  and the enlarged view's header delete both use it. */
export const ICON_TRASH = strokeIcon(
  '<path d="M4 7h16"/>' +
    '<path d="M9.5 7V5.5a1.5 1.5 0 0 1 1.5-1.5h2a1.5 1.5 0 0 1 1.5 1.5V7"/>' +
    '<path d="M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12"/>',
);

/** "collapse the panel to the right" (design spec v5 §U): a rounded panel
 *  outline, a divider three-quarters across, and a chevron pointing right in
 *  the larger left area. It replaces the × — the aria-label and title still
 *  say "exit enlarged view", which is what carries the meaning to AT. */
export const ICON_COLLAPSE = strokeIcon(
  '<rect x="3" y="4" width="18" height="16" rx="2.5"/>' + '<path d="M15.5 4v16M8 9.5l3 2.5-3 2.5"/>',
);
/** The enlarged view's rail arrows (previous / next note). */
export const ICON_ARROW_UP = strokeIcon(PATH_ARROW_UP);
export const ICON_ARROW_DOWN = strokeIcon(PATH_ARROW_DOWN);

// ─── Add mode: the pencil (design spec §AB) ─────────────────────────────────

/** The pencil's body and tip, shared by the bottom-bar button and the
 *  cursor so the two are visibly the same tool. The tip is at (3.5, 20.5). */
const PATH_PENCIL = 'M3.5 20.5l1.2-4.6L15.6 5a2.1 2.1 0 0 1 3 0l.4.4a2.1 2.1 0 0 1 0 3L8.1 19.3z';
const PATH_PENCIL_BAND = 'M13.8 6.8l3.4 3.4';

/** The comment box's pencil button (§AB): the menu button the swatches
 *  belong to. */
export const ICON_PENCIL = strokeIcon(`<path d="${PATH_PENCIL}"/><path d="${PATH_PENCIL_BAND}"/>`);

/** "erase all", the pencil menu's one item: an eraser on its baseline. */
export const ICON_ERASER = strokeIcon(
  '<path d="M9 20h11"/>' +
    '<path d="M4.7 14.3l8.6-8.6a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L10 19H8.4z"/>' +
    '<path d="M9.5 9.5l5 5"/>',
);

/** The cursor over the selection while drawing is possible (§AB): the same
 *  pencil, ink on a wider cream halo so it reads on any page, light or dark.
 *  A CSS `cursor` value with its hotspot on the tip and the system crosshair
 *  as the fallback. Explicit width/height, which Chrome requires of an SVG
 *  cursor image. */
export const PENCIL_CURSOR = (() => {
  const body = `<path d="${PATH_PENCIL}"/><path d="${PATH_PENCIL_BAND}"/>`;
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    `<g stroke="#FBF6EA" stroke-width="3.8">${body}</g>` +
    `<g stroke="#1A1712" stroke-width="1.8">${body}</g>` +
    '</svg>';
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 3 20, crosshair`;
})();
