// src/pageResize.ts
// The page shrink behind the docked sidebar (REQUIREMENTS §1.1, §3.1): the
// right margin on <html>, the backstop stylesheet and the observer that keeps
// them applied. Moved out of sidebar.ts unchanged; the width is now passed
// in (applyPageResize / rewritePageResize) rather than read from the panel's
// module state. Content-script only, no chrome.*.
//
// ═══════════════════════════════════════════════════════════════════════════
// PAGE RESIZE
// ═══════════════════════════════════════════════════════════════════════════
//
// Goal (§1.1, §3.1): the sidebar must *shrink the page's usable width* rather
// than float over it, so page content is never covered — and §1.2 step 1 leans
// on that ("the sidebar does not need to be hidden for a capture, since the
// page's visible viewport never extends under it").
//
// ── Strategy: shrink the root element's box with a right margin ────────────
//
// Applied to `document.documentElement` (never <body> — see "why the root"
// below), as four !important inline declarations, where N is the sidebar's
// *current* width (passed in by sidebar.ts — the user can drag it between
// SIDEBAR_MIN_WIDTH and SIDEBAR_MAX_WIDTH, so nothing here may hardcode a
// number):
//
//     margin-right: Npx      the actual shrink
//     width:        auto     defeats page CSS that pins html's width
//     min-width:    0        defeats page CSS that floors html's width
//     overflow-x:   hidden   clips whatever refuses to shrink anyway
//
// Plus one non-layout declaration, `--annotator-sidebar-width: Npx`. Custom
// properties inherit through shadow boundaries (closed roots included), so
// setting it on <html> would let another extension shadow tree track the
// live width without any subscription plumbing. Nothing reads it today
// (owner decision D8).
//
// `margin-right` rather than `width: calc(100% - Npx)`, which was the
// previous implementation and is subtly worse:
//
//   * With `width`, the declaration only describes the *content* box under
//     content-box sizing, so any padding or border the page puts on <html>
//     is added on top and the root box overflows into the sidebar strip by
//     exactly that much. The previous implementation papered over this by
//     also forcing `box-sizing: border-box !important` on <html> — which is
//     actively dangerous, because the extremely common
//     `html { box-sizing: border-box } *, *::before, *::after { box-sizing:
//     inherit }` reset means every element on the page inherits its sizing
//     model from the root. Overriding the root's box-sizing there silently
//     re-sizes the *entire page*. With `margin-right` + `width: auto` the
//     used width is "containing block − margins − border − padding" by
//     definition, so the shrink is exact under either sizing model and we
//     never have to touch box-sizing at all.
//   * `width: auto` also beats the `html { width: 100vw }` pattern, where a
//     page-authored width would otherwise win over our margin and reintroduce
//     the overflow. `min-width: 0` does the same for fixed-width legacy
//     layouts that floor the root.
//
// ── Why the root element and not <body> ────────────────────────────────────
//
// Percentage/auto widths on the root resolve against the initial containing
// block — the real viewport — so the shrink is independent of whatever the
// page's own CSS does further down. Shrinking <body> instead would be
// defeated by any page that positions its layout off <html>, and would leave
// the document's own scrollbar geometry inconsistent.
//
// Root-element `overflow` is also special: the used value is *propagated to
// the viewport* and the root itself is then treated as `overflow: visible`.
// That matters twice over — (a) it suppresses the second, document-level
// horizontal scrollbar that a `100vw` hero or an over-wide table would
// otherwise grow next to the sidebar, and (b) because the root never actually
// becomes a scroll container, `position: sticky` elements inside the page keep
// working, which a plain `overflow: hidden` on <body> would break.
//
// ── Scrollbar geometry ─────────────────────────────────────────────────────
//
// The document's vertical scrollbar is painted by the viewport, and the
// initial containing block excludes it. Our panel is `position: fixed;
// right: 0` with no transformed ancestor, so it too is laid out in the initial
// containing block. Both the shrink and the panel therefore measure from the
// *inner* edge of the scrollbar: the panel lands exactly in the gap the margin
// opened, and the page's scrollbar stays visible and grabbable to its right.
//
// ── The accepted limitation: the page's own fixed/full-screen elements ─────
//
// A width change on an ancestor does not move a `position: fixed` descendant —
// only `transform` / `filter` / `will-change: transform` on an ancestor
// re-parents it, by making that ancestor its containing block. So a page's
// fixed header, cookie banner or chat bubble still spans the full viewport and
// slides under the sidebar strip; likewise an app-shell layout that sets
// `html, body { overflow: hidden }` and lays everything out in `position:
// fixed; inset: 0` containers ignores the shrink entirely.
//
// The transform trick was tried and rejected: our own host is unavoidably a
// descendant of <html>, so a transform there would capture the *sidebar's* own
// fixed positioning into the shrunken box and walk it off the screen edge —
// and there is no way to exempt one fixed descendant from an ancestor's
// containing block. Applying the transform to <body> instead (host stays on
// <html>, so it escapes) fails differently and worse: a transformed ancestor
// makes fixed descendants scroll with the page, so every sticky header on the
// web would start scrolling away. Neither is acceptable, so the fixed-element
// case degrades gracefully instead: the sidebar is opaque and at the top of
// the stacking order, so those elements read as "covered by the panel" rather
// than as broken layout, and they are still fully reachable by closing it.
//
// ── Keeping the shrink applied ─────────────────────────────────────────────
//
// Page JS that assigns `documentElement.style.cssText` wholesale (or removes
// the style attribute) would silently drop our declarations and un-shrink the
// page while the sidebar is still on screen — content would end up underneath
// it. Two independent defences, because they fail in different ways:
//
//   1. An injected <style> element (`#annotator-page-resize`) carrying the
//      same declarations as `html:root { ... !important }`. A stylesheet is
//      not stored in the style *attribute*, so a page wiping `cssText` cannot
//      touch it and the shrink survives with zero latency — no observer tick,
//      no un-shrunk frame. Inline !important still outranks it while both are
//      present (inline is the top of the author cascade), so this is purely a
//      backstop and never changes the normal case.
//   2. A MutationObserver on the root's `style`/`class` attributes that
//      re-asserts the inline declarations if they go missing, with a hard cap
//      so we can never end up in a re-write war with a page that is fighting
//      back. `class` is watched as well as `style` because class flips are the
//      cheapest signal that a page's own layout code just ran (theme toggles,
//      scroll locks, theater/fullscreen switches) — it is the moment to
//      re-check that our stylesheet is still attached.
//
// ── Sites where the shrink cannot fully work (youtube.com is the known one) ─
//
// Two page-side patterns defeat *any* root-box shrink, and both are present on
// YouTube. Neither is fixable from a content script; do not "fix" this by
// rewriting the page's stylesheets, which is unsafe and unreliable.
//
//   * Viewport units. `100vw`/`100dvw` are defined by spec against the actual
//     browser viewport, not against any element's used width — shrinking
//     <html> has no effect on them whatsoever. YouTube's app shell sizes
//     several containers this way (the full-bleed/theater player container
//     most visibly), so those keep their full-viewport width and bleed under
//     the sidebar strip no matter what we set on the root.
//   * Layout measured in JS from `window.innerWidth`. Shrinking the root does
//     not change `innerWidth`, so a layout that computes its own pixel widths
//     from it recomputes to the same too-wide number. YouTube's Polymer app
//     (ytd-watch-flexy's player sizing) does exactly this. We dispatch a
//     synthetic `resize` after every apply so such layouts at least re-run,
//     but they re-run to the same answer.
//
// On top of that, YouTube's masthead is `position: fixed`, which is the
// already-accepted fixed-element limitation below.
//
// The degradation is deliberate and safe rather than silent: the sidebar host
// carries an explicit z-index near the top of the 32-bit range, so on such a
// page the panel stays fully visible and usable and the page simply reads as
// "partly covered", which closing the sidebar undoes. This is a documented
// edge case in REQUIREMENTS.md, not a bug with a pending fix.
//
// Restoration is per-property, not a whole-cssText snapshot: we record each
// managed property's pre-open value and priority and put exactly those back,
// leaving any *other* inline style the page set in the meantime alone. A
// cssText snapshot would revert those too (e.g. silently undoing a page's own
// `html.style.overflow = 'hidden'` scroll lock set after the sidebar opened).
//
// ── Telling the page to re-measure ─────────────────────────────────────────
//
// Shrinking the root does not change `window.innerWidth`, so no native resize
// event fires. Layouts that measure in JS rather than in CSS — canvas charts,
// virtualised lists, carousels — would keep their pre-shrink geometry. A
// synthetic `resize` event after apply and after restore nudges them to
// re-measure; ResizeObserver-based layouts already fire on their own.
// ═══════════════════════════════════════════════════════════════════════════

/** Inherits through shadow boundaries, so another surface could track the
 *  sidebar's live width without subscription plumbing. Nothing reads it
 *  today; whether to keep it is the owner's call (D8). */
const SIDEBAR_WIDTH_CSS_VAR = '--annotator-sidebar-width';

/** id of the injected backstop stylesheet — see defence 1 in the banner. */
const RESIZE_STYLE_ELEMENT_ID = 'annotator-page-resize';

let resizeStyleEl: HTMLStyleElement | null = null;

/** The width the page is shrunk by, as last applied or rewritten. */
let width = 0;

/** Property list + the value each should currently hold. A function, not a
 *  constant: the margin (and the custom property) track the
 *  user's chosen sidebar width. Custom properties are written without
 *  `important` — nothing competes for ours, and some engines drop the
 *  priority on custom properties anyway. */
function managedHtmlProps(): ReadonlyArray<[prop: string, value: string, priority: string]> {
  const px = `${width}px`;
  return [
    ['margin-right', px, 'important'],
    ['width', 'auto', 'important'],
    ['min-width', '0px', 'important'],
    ['overflow-x', 'hidden', 'important'],
    [SIDEBAR_WIDTH_CSS_VAR, px, ''],
  ];
}

interface SavedDecl {
  value: string;
  priority: string;
}

/** Pre-open values of the managed properties. `null` when no resize is applied. */
let savedHtmlDecls: Map<string, SavedDecl> | null = null;

/** The managed declarations as the user agent actually stored them, captured on
 *  write. Compared against on every style mutation to spot a page wiping them. */
let appliedValues: Map<string, string> | null = null;

let htmlStyleObserver: MutationObserver | null = null;
let reassertCount = 0;

/** Ceiling on how many times we re-apply the shrink after the page wipes it.
 *  Generous enough for normal SPA churn, low enough that a page actively
 *  rewriting <html>'s style attribute cannot spin us forever. */
const MAX_REASSERTS = 50;

/** Shrink the page by `px` (the sidebar's width). Safe to call while
 *  already applied: it re-asserts the shrink at `px`. */
export function applyPageResize(px: number): void {
  width = px;
  const html = document.documentElement;

  if (savedHtmlDecls === null) {
    const saved = new Map<string, SavedDecl>();
    for (const [prop] of managedHtmlProps()) {
      saved.set(prop, {
        value: html.style.getPropertyValue(prop),
        priority: html.style.getPropertyPriority(prop),
      });
    }
    savedHtmlDecls = saved;
    reassertCount = 0;
  }

  writeManagedProps();
  writeResizeStyleSheet();
  startHtmlStyleObserver();
  notifyPageOfResize();
}

/** Put back exactly what the page had before applyPageResize. Safe to call
 *  when not applied. */
export function restorePageResize(): void {
  stopHtmlStyleObserver();
  removeResizeStyleSheet();
  if (savedHtmlDecls === null) return;

  const html = document.documentElement;
  for (const [prop] of managedHtmlProps()) {
    const saved = savedHtmlDecls.get(prop);
    html.style.removeProperty(prop);
    if (saved && saved.value !== '') {
      html.style.setProperty(prop, saved.value, saved.priority);
    }
  }
  savedHtmlDecls = null;
  appliedValues = null;
  reassertCount = 0;
  notifyPageOfResize();
}

function writeManagedProps(): void {
  const html = document.documentElement;
  const seen = new Map<string, string>();
  for (const [prop, value, priority] of managedHtmlProps()) {
    html.style.setProperty(prop, value, priority);
    // Read back rather than trusting what we wrote: user agents normalise
    // declarations on the way in (Chrome stores `min-width: 0` as `0px`), and
    // comparing against the un-normalised string would make managedPropsIntact()
    // permanently false and put the observer in a pointless rewrite loop.
    seen.set(prop, html.style.getPropertyValue(prop));
  }
  appliedValues = seen;
  // Discard the records our own writes just queued so the observer only ever
  // reacts to the *page's* mutations. A boolean guard would not work: observer
  // callbacks are delivered asynchronously, long after the flag was cleared.
  htmlStyleObserver?.takeRecords();
}

function managedPropsIntact(): boolean {
  if (!appliedValues) return false;
  const html = document.documentElement;
  for (const [prop, value] of appliedValues) {
    if (html.style.getPropertyValue(prop) !== value) return false;
  }
  return true;
}

/**
 * Defence 1: the same declarations as a real stylesheet rule, which a page
 * wiping <html>'s style *attribute* cannot reach. Appended to <head> (falling
 * back to <html> for the rare document without one) and rewritten in place on
 * every width change, so there is never more than one of these.
 *
 * `html:root` rather than bare `html` only to raise specificity above a page's
 * own `html { ... }` rule; both carry !important anyway, and later-injected
 * author sheets win ties, which ours is.
 */
function writeResizeStyleSheet(): void {
  if (!resizeStyleEl) {
    resizeStyleEl = document.createElement('style');
    resizeStyleEl.id = RESIZE_STYLE_ELEMENT_ID;
  }
  resizeStyleEl.textContent =
    `html:root {` +
    `margin-right: ${width}px !important;` +
    `width: auto !important;` +
    `min-width: 0 !important;` +
    `overflow-x: hidden !important;` +
    `${SIDEBAR_WIDTH_CSS_VAR}: ${width}px;` +
    `}`;
  ensureResizeStyleSheetAttached();
}

function ensureResizeStyleSheetAttached(): void {
  if (!resizeStyleEl) return;
  if (resizeStyleEl.isConnected) return;
  (document.head ?? document.documentElement).appendChild(resizeStyleEl);
}

function removeResizeStyleSheet(): void {
  resizeStyleEl?.parentNode?.removeChild(resizeStyleEl);
  resizeStyleEl = null;
}

function startHtmlStyleObserver(): void {
  if (htmlStyleObserver || typeof MutationObserver === 'undefined') return;
  htmlStyleObserver = new MutationObserver(() => {
    if (savedHtmlDecls === null) return;
    // Cheap and unconditional: a page that tore our stylesheet out of <head>
    // gets it back on the next mutation of <html>'s style/class, and this
    // costs one `isConnected` read when nothing is wrong.
    ensureResizeStyleSheetAttached();
    if (managedPropsIntact()) return;
    if (reassertCount >= MAX_REASSERTS) {
      stopHtmlStyleObserver();
      return;
    }
    reassertCount++;
    writeManagedProps();
  });
  htmlStyleObserver.observe(document.documentElement, {
    attributes: true,
    // `class` as well as `style`: a class flip on <html> is the cheapest
    // signal that the page's own layout code just ran (theme/scroll-lock/
    // theater-mode toggles), which is exactly when to re-check our state.
    attributeFilter: ['style', 'class'],
  });
}

function stopHtmlStyleObserver(): void {
  htmlStyleObserver?.disconnect();
  htmlStyleObserver = null;
}

/** Synthetic resize event so JS-measured layouts re-read their box. A page
 *  listener that throws is reported (to the console) by dispatchEvent, never
 *  thrown out of it, so it cannot fail for that reason; the try/catch is
 *  kept as a plain guard around a call into the page's world. */
function notifyPageOfResize(): void {
  try {
    window.dispatchEvent(new Event('resize'));
  } catch {
    // Page listener threw — not ours to handle.
  }
}

/** While applied, follow a new width: the inline declarations and the
 *  backstop sheet are rewritten and the page told to re-measure. A no-op
 *  when the page is not shrunk (the next apply takes the width then). */
export function rewritePageResize(px: number): void {
  if (savedHtmlDecls === null) return;
  width = px;
  writeManagedProps();
  writeResizeStyleSheet();
  notifyPageOfResize();
}

/** Whether the page is currently shrunk. */
export function isPageResized(): boolean {
  return savedHtmlDecls !== null;
}

/** Test-only: assert the current state of the page-resize machinery without
 *  exposing the module's mutable internals. */
export function _stateForTests(): {
  applied: boolean;
  observing: boolean;
  reasserts: number;
  styleSheetAttached: boolean;
} {
  return {
    applied: savedHtmlDecls !== null,
    observing: htmlStyleObserver !== null,
    reasserts: reassertCount,
    styleSheetAttached: resizeStyleEl !== null && resizeStyleEl.isConnected,
  };
}
