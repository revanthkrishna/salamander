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

// ─── Theme toggle (design spec §3.4: sun / moon / half-circle) ──────────────

export const ICON_THEME_LIGHT = strokeIcon(
  '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4 4.2 19.8M19.8 4.2l-1.4 1.4"/>',
);
export const ICON_THEME_DARK = strokeIcon('<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z"/>');
/** "auto" — a half-filled circle rather than a third distinct glyph, so it
 *  reads as "in between" light and dark at a glance. */
export const ICON_THEME_AUTO = strokeIcon(
  '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none"/>',
);

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
