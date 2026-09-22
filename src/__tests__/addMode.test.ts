// Add-mode tests — box placement/clamping, resize hit-zone geometry
// and edge/corner resizing, the rounded-hole scrim, the comment box's char
// counter and save-disabled state, the never-off-screen positioning
// guarantee, and cancel/save lifecycle (Salamander design spec §3.2).
//
// jsdom has no layout engine, so these verify the *mechanism* — inline
// px values computed from window.innerWidth/innerHeight — not actual pixel
// rendering. Real-site visual verification is the Playwright suite.

import * as addMode from '../addMode';
import * as sidebar from '../sidebar';
import { getSidebarWidth } from '../sidebar';
import { getThemeCSS } from '../theme';

// addMode.ts uses attachShadow({ mode: 'closed' }); force 'open' for this test
// file only so we can assert on the rendered DOM, same trick as sidebar.test.ts.
const originalAttachShadow = HTMLElement.prototype.attachShadow;
beforeAll(() => {
  HTMLElement.prototype.attachShadow = function (init: ShadowRootInit) {
    return originalAttachShadow.call(this, { ...init, mode: 'open' });
  };
});
afterAll(() => {
  HTMLElement.prototype.attachShadow = originalAttachShadow;
});

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
}

function getHost(): HTMLElement | null {
  return document.getElementById('annotator-addmode-host');
}

function shadowRoot(): ShadowRoot {
  const host = getHost();
  if (!host || !host.shadowRoot) throw new Error('add-mode host/shadow root not found');
  return host.shadowRoot;
}

function blocker(): HTMLElement {
  return shadowRoot().querySelector('.blocker') as HTMLElement;
}

function boxEl(): HTMLElement {
  return shadowRoot().querySelector('.box') as HTMLElement;
}

function zone(key: string): HTMLElement {
  return shadowRoot().querySelector(`.resize-zone[data-zone="${key}"]`) as HTMLElement;
}

function textarea(): HTMLTextAreaElement {
  return shadowRoot().querySelector('.note-input') as HTMLTextAreaElement;
}

function saveBtn(): HTMLButtonElement {
  return shadowRoot().querySelector('.btn-save') as HTMLButtonElement;
}

function cancelBtn(): HTMLButtonElement {
  return shadowRoot().querySelector('.btn-cancel') as HTMLButtonElement;
}

function counter(): HTMLElement {
  return shadowRoot().querySelector('.counter') as HTMLElement;
}

function commentBoxEl(): HTMLElement | null {
  return shadowRoot().querySelector('.comment-box');
}

function visualsEl(): HTMLElement {
  return shadowRoot().querySelector('.visuals') as HTMLElement;
}

function previewTooltipEl(): HTMLElement {
  return shadowRoot().querySelector('.preview-tooltip') as HTMLElement;
}

function stylesheetText(): string {
  return (shadowRoot().querySelector('style') as HTMLStyleElement).textContent ?? '';
}

/** Add mode's own rules, i.e. the stylesheet minus the prepended theme
 *  token block (which legitimately contains raw hex values). */
function addModeOwnCSS(): string {
  return stylesheetText().replace(getThemeCSS(), '');
}

/** The first `selector { ... }` rule body in add mode's own CSS. */
function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return addModeOwnCSS().match(new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{[^}]*\\}`))?.[0] ?? '';
}

function typeNote(text: string): void {
  textarea().value = text;
  textarea().dispatchEvent(new Event('input'));
}

function click(el: HTMLElement, x: number, y: number): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y, button: 0 }));
}

function mousedown(el: HTMLElement, x: number, y: number): void {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0 }));
}

function mousemove(x: number, y: number): void {
  document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
}

function mouseup(x = 0, y = 0): void {
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }));
}

/** Simulates a real placement "click": mousedown then mouseup at the same
 *  point (movement 0px, well under DRAG_THRESHOLD) — the center-on-click
 *  default-size box path. Placement is driven by mousedown/mousemove/mouseup
 *  now (not a bare 'click' event) so drag-to-draw can be distinguished. */
function place(el: HTMLElement, x: number, y: number): void {
  mousedown(el, x, y);
  mouseup(x, y);
}

/** Simulates a placement drag: mousedown at (x1,y1), a mousemove to (x2,y2)
 *  (past DRAG_THRESHOLD unless the caller wants to test a sub-threshold
 *  move), then mouseup at (x2,y2). */
function drag(el: HTMLElement, x1: number, y1: number, x2: number, y2: number): void {
  mousedown(el, x1, y1);
  mousemove(x2, y2);
  mouseup(x2, y2);
}

/** Mirrors addMode's internal clamp() helper (not exported). */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Mirrors addMode's computeDefaultBox(): the click-to-place default box is
 *  centered on the click point, sized to sidebar.DEFAULT_THUMBNAIL_BOX_SIZE
 *  (the sidebar's thumbnail box size at the default sidebar width — see
 *  src/sidebar.ts's DEFAULT_THUMBNAIL_BOX_SIZE / src/thumbnails.ts's
 *  THUMBNAIL_IMAGE_HEIGHT_PX, the single source of truth), then clamped by
 *  shifting to stay on-screen. Tests compute the *expected* box through this
 *  same formula instead of hardcoding the old fixed 200x150 default. */
function expectedDefaultBox(clickX: number, clickY: number, bounds: { width: number; height: number }) {
  const defaultSize = sidebar.DEFAULT_THUMBNAIL_BOX_SIZE;
  const width = Math.min(defaultSize.width, bounds.width);
  const height = Math.min(defaultSize.height, bounds.height);
  const x = clamp(clickX - width / 2, 0, Math.max(0, bounds.width - width));
  const y = clamp(clickY - height / 2, 0, Math.max(0, bounds.height - height));
  return { x, y, width, height };
}

/** Mirrors addMode's (unexported) computeZoneRects(): edge/corner hit-zone
 *  rects for a given box, using the same EDGE_ZONE/CORNER_ZONE constants. */
function expectedZoneRects(b: { x: number; y: number; width: number; height: number }) {
  const EDGE_ZONE = 10;
  const CORNER_ZONE = 16;
  const e = EDGE_ZONE / 2;
  const c = CORNER_ZONE / 2;
  const left = b.x;
  const top = b.y;
  const right = b.x + b.width;
  const bottom = b.y + b.height;
  const innerW = Math.max(0, b.width - CORNER_ZONE);
  const innerH = Math.max(0, b.height - CORNER_ZONE);
  return {
    n: { x: left + c, y: top - e, width: innerW, height: EDGE_ZONE },
    s: { x: left + c, y: bottom - e, width: innerW, height: EDGE_ZONE },
    w: { x: left - e, y: top + c, width: EDGE_ZONE, height: innerH },
    e: { x: right - e, y: top + c, width: EDGE_ZONE, height: innerH },
    nw: { x: left - c, y: top - c, width: CORNER_ZONE, height: CORNER_ZONE },
    ne: { x: right - c, y: top - c, width: CORNER_ZONE, height: CORNER_ZONE },
    sw: { x: left - c, y: bottom - c, width: CORNER_ZONE, height: CORNER_ZONE },
    se: { x: right - c, y: bottom - c, width: CORNER_ZONE, height: CORNER_ZONE },
  };
}

/** Mirrors addMode's (unexported) resizeBox(): moves only the edges named by
 *  `zoneKey` to (clientX, clientY), clamped per edge to `bounds` and the
 *  20x20 minimum — same formula as production, used so tests can assert on
 *  resize results without hardcoding geometry that now depends on the
 *  (variable) default box size. */
function expectedResizeBox(
  current: { x: number; y: number; width: number; height: number },
  zoneKey: string,
  clientX: number,
  clientY: number,
  bounds: { width: number; height: number },
) {
  const MIN_SIZE = 20;
  const left = current.x;
  const top = current.y;
  const right = current.x + current.width;
  const bottom = current.y + current.height;

  let newLeft = left;
  let newTop = top;
  let newRight = right;
  let newBottom = bottom;

  if (zoneKey.includes('w')) newLeft = clamp(clientX, 0, right - MIN_SIZE);
  if (zoneKey.includes('e')) newRight = clamp(clientX, left + MIN_SIZE, bounds.width);
  if (zoneKey.includes('n')) newTop = clamp(clientY, 0, bottom - MIN_SIZE);
  if (zoneKey.includes('s')) newBottom = clamp(clientY, top + MIN_SIZE, bounds.height);

  return { x: newLeft, y: newTop, width: newRight - newLeft, height: newBottom - newTop };
}

function makeCallbacks() {
  const calls = { ok: [] as { rect: any; note: string }[], cancel: 0 };
  return {
    calls,
    onOk: (result: any) => calls.ok.push(result),
    onCancel: () => { calls.cancel++; },
  };
}

describe('add mode', () => {
  beforeEach(() => {
    setViewport(1200, 800);
  });

  afterEach(() => {
    addMode.exitAddMode();
    // The first-run hint's window is page-session state (design spec v4 §N),
    // so every test has to start from a fresh "page load".
    addMode._resetHintForTests();
  });

  // ── lifecycle / structure ─────────────────────────────────────────────────

  test('startAddMode builds a host attached to <html> with a crosshair blocker', () => {
    addMode.startAddMode(makeCallbacks());
    const host = getHost();
    expect(host).not.toBeNull();
    expect(host!.parentElement).toBe(document.documentElement);
    expect(addMode.isAddModeActive()).toBe(true);
    expect(blocker().classList.contains('placing')).toBe(true);
  });

  test('is idempotent: a second startAddMode call while active does not build a second host', () => {
    addMode.startAddMode(makeCallbacks());
    addMode.startAddMode(makeCallbacks());
    expect(document.querySelectorAll('#annotator-addmode-host')).toHaveLength(1);
  });

  test('exitAddMode tears down the host and returns to idle', () => {
    addMode.startAddMode(makeCallbacks());
    addMode.exitAddMode();
    expect(getHost()).toBeNull();
    expect(addMode.isAddModeActive()).toBe(false);
  });

  // ── regression: bug 1 — comment box must not exist before placement ───────

  test('the comment box does not exist in the DOM immediately after startAddMode (before any placement click)', () => {
    addMode.startAddMode(makeCallbacks());
    expect(commentBoxEl()).toBeNull();
    expect(shadowRoot().querySelector('.note-input')).toBeNull();
    expect(shadowRoot().querySelector('.btn-save')).toBeNull();
    expect(shadowRoot().querySelector('.btn-cancel')).toBeNull();
  });

  test('the comment box is created only once the placement click lands', () => {
    addMode.startAddMode(makeCallbacks());
    expect(commentBoxEl()).toBeNull();

    place(blocker(), 300, 200);

    expect(commentBoxEl()).not.toBeNull();
    expect(textarea()).not.toBeNull();
    expect(saveBtn()).not.toBeNull();
    expect(cancelBtn()).not.toBeNull();
  });

  // ── regression: bug 2 — comment box clicks must not be swallowed ──────────

  test('the comment box opts back into pointer-events so its clicks are not swallowed by the pointer-events:none host', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 200); // build the comment box

    // The host is `pointer-events: none` so the transparent .blocker overlay
    // (which IS pointer-events: auto) can own page-click suppression while
    // purely-visual children (box outline, scrim) stay click-through and let
    // the blocker underneath receive the event. Anything meant to be
    // clickable inside .visuals — resize hit zones, and the comment box — must
    // explicitly opt back into pointer-events: auto, or its computed value
    // inherits :none from the host and every click on it is silently
    // swallowed (mouse only — Tab-key focus is unaffected, which is exactly
    // the symptom this regression test guards against).
    const css = stylesheetText();
    const commentBoxRule = css.match(/\.comment-box\s*\{[^}]*\}/)?.[0] ?? '';
    expect(commentBoxRule).toMatch(/pointer-events:\s*auto/);
  });

  test('cancel button tears down add mode and fires onCancel, with no onOk (save) call', () => {
    const cbs = makeCallbacks();
    addMode.startAddMode(cbs);
    place(blocker(), 100, 100); // place the box first so the comment box exists
    click(cancelBtn(), 0, 0);

    expect(cbs.calls.cancel).toBe(1);
    expect(cbs.calls.ok).toHaveLength(0);
    expect(addMode.isAddModeActive()).toBe(false);
    expect(getHost()).toBeNull();
  });

  // ── placement (click-to-place: center-on-click + viewport clamping) ──────

  test('a plain click (no drag) centers the default box (sized to match the sidebar thumbnail) on the click point', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 200);

    const bounds = { width: 1200 - getSidebarWidth(), height: 800 };
    const expected = expectedDefaultBox(300, 200, bounds);
    const box = addMode._boxForTests();
    // centered: top-left = (clickX - width/2, clickY - height/2)
    expect(box).toEqual(expected);
    expect(boxEl().style.left).toBe(`${expected.x}px`);
    expect(boxEl().style.top).toBe(`${expected.y}px`);
    expect(boxEl().style.width).toBe(`${expected.width}px`);
    expect(boxEl().style.height).toBe(`${expected.height}px`);
  });

  test('clamps a naive top/left-off-screen centered box by shifting it fully on-screen', () => {
    addMode.startAddMode(makeCallbacks());
    // naive centering pushes both edges negative, which clamps to (0, 0).
    place(blocker(), 20, 20);

    const bounds = { width: 1200 - getSidebarWidth(), height: 800 };
    const expected = expectedDefaultBox(20, 20, bounds);
    expect(expected.x).toBe(0);
    expect(expected.y).toBe(0);
    const box = addMode._boxForTests();
    expect(box).toEqual(expected);
  });

  test('clamps a naive bottom/right-off-screen centered box symmetrically', () => {
    addMode.startAddMode(makeCallbacks());
    const bounds = { width: 1200 - getSidebarWidth(), height: 800 };
    // click 20px from the bottom-right corner of the selectable area: naive
    // centering pushes the box off both the right and bottom edges.
    place(blocker(), bounds.width - 20, bounds.height - 20);

    const box = addMode._boxForTests();
    const expected = expectedDefaultBox(bounds.width - 20, bounds.height - 20, bounds);
    expect(box).toEqual(expected);
    expect(box.x + box.width).toBe(bounds.width);
    expect(box.y + box.height).toBe(bounds.height);
  });

  test('placement clamps the default box to stay within the viewport bounds (minus sidebar width), independent per axis, for any click point', () => {
    addMode.startAddMode(makeCallbacks());
    const bounds = { width: 1200 - getSidebarWidth(), height: 800 };
    // click near the bottom-right corner of the selectable area
    place(blocker(), bounds.width - 5, bounds.height - 5);

    const box = addMode._boxForTests();
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.width);
    expect(box.y + box.height).toBeLessThanOrEqual(bounds.height);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
  });

  test('a second click after placement (outside box/comment) does nothing', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 200);
    const before = addMode._boxForTests();

    place(blocker(), 700, 600);
    expect(addMode._boxForTests()).toEqual(before);
    expect(addMode.isAddModeActive()).toBe(true);
  });

  // ── add-mode preview: the selection rect follows the cursor (design spec §G) ──

  test('a pointer move during placing shows a preview using the exact click-to-place box, faded in', () => {
    addMode.startAddMode(makeCallbacks());
    expect(visualsEl().dataset.preview).toBeUndefined();

    mousemove(300, 200);

    const bounds = { width: 1200 - getSidebarWidth(), height: 800 };
    const expected = expectedDefaultBox(300, 200, bounds);
    // "uses the same rect as computeDefaultBox" — same box, same clamping.
    expect(visualsEl().dataset.preview).toBe('true');
    expect(visualsEl().dataset.previewVisible).toBe('true');
    expect(boxEl().dataset.preview).toBe('true');
    expect([boxEl().style.left, boxEl().style.top, boxEl().style.width, boxEl().style.height]).toEqual([
      `${expected.x}px`, `${expected.y}px`, `${expected.width}px`, `${expected.height}px`,
    ]);
    const scrim = shadowRoot().querySelector('.scrim') as HTMLElement;
    expect([scrim.style.left, scrim.style.top, scrim.style.width, scrim.style.height]).toEqual([
      `${expected.x}px`, `${expected.y}px`, `${expected.width}px`, `${expected.height}px`,
    ]);

    // no resize zones and no comment box during the preview
    expect(visualsEl().dataset.hasBox).toBeUndefined();
    expect(commentBoxEl()).toBeNull();

    expect(cssRule('.preview-tooltip')).toMatch(/opacity:\s*0/);
    expect(cssRule('.preview-tooltip')).toMatch(/transition:\s*opacity 120ms/);
    expect(addModeOwnCSS()).toMatch(/\.preview-tooltip\[data-visible="true"\]\s*\{\s*opacity:\s*1/);
  });

  test('the preview follows the pointer 1:1 as it moves, with no comment box or resize zones appearing', () => {
    addMode.startAddMode(makeCallbacks());
    mousemove(300, 200);
    const bounds = { width: 1200 - getSidebarWidth(), height: 800 };

    mousemove(500, 450);
    const expected = expectedDefaultBox(500, 450, bounds);
    expect(boxEl().style.left).toBe(`${expected.x}px`);
    expect(boxEl().style.top).toBe(`${expected.y}px`);
    expect(commentBoxEl()).toBeNull();
    expect(shadowRoot().querySelectorAll('.resize-zone')).toHaveLength(8); // present but still hidden
    for (const z of Array.from(shadowRoot().querySelectorAll('.resize-zone'))) {
      expect((z as HTMLElement).style.left).toBe(''); // never laid out — renderZones() never ran
    }
  });

  test('the preview is clamped at the viewport edges, exactly like a real click there', () => {
    addMode.startAddMode(makeCallbacks());
    const bounds = { width: 1200 - getSidebarWidth(), height: 800 };

    mousemove(5, 5); // naive centering would push both edges negative
    let expected = expectedDefaultBox(5, 5, bounds);
    expect(expected.x).toBe(0);
    expect(expected.y).toBe(0);
    expect(boxEl().style.left).toBe('0px');
    expect(boxEl().style.top).toBe('0px');

    mousemove(bounds.width - 5, bounds.height - 5); // bottom-right corner
    expected = expectedDefaultBox(bounds.width - 5, bounds.height - 5, bounds);
    expect(boxEl().style.left).toBe(`${expected.x}px`);
    expect(boxEl().style.top).toBe(`${expected.y}px`);
    expect(expected.x + expected.width).toBe(bounds.width);
    expect(expected.y + expected.height).toBe(bounds.height);
  });

  test('the preview hides the moment the pointer moves past the selectable area onto the sidebar', () => {
    addMode.startAddMode(makeCallbacks());
    const bounds = { width: 1200 - getSidebarWidth(), height: 800 };
    mousemove(300, 300);
    expect(visualsEl().dataset.preview).toBe('true');

    mousemove(bounds.width + 10, 300); // now over the sidebar strip
    expect(visualsEl().dataset.preview).toBeUndefined();
    expect(previewTooltipEl().dataset.visible).toBeUndefined();
  });

  test('the preview hides when the pointer leaves the browser viewport entirely', () => {
    addMode.startAddMode(makeCallbacks());
    mousemove(300, 300);
    expect(visualsEl().dataset.preview).toBe('true');

    document.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }));
    expect(visualsEl().dataset.preview).toBeUndefined();
  });

  test('the preview holds through the press, and a drag hands over to the real rect', () => {
    addMode.startAddMode(makeCallbacks());
    mousemove(300, 300);
    expect(visualsEl().dataset.preview).toBe('true');

    // It deliberately survives mousedown. Dropping it here left NOTHING
    // drawn between mousedown and mouseup — the whole duration of a click —
    // so the outline and the scrim's hole blinked out and back as the box
    // was placed.
    mousedown(blocker(), 300, 300);
    expect(visualsEl().dataset.preview).toBe('true');

    mousemove(500, 450); // a drag: the real (has-box) rect takes over
    expect(visualsEl().dataset.preview).toBeUndefined();
    expect(visualsEl().dataset.hasBox).toBe('true');

    mouseup(500, 450);
    expect(visualsEl().dataset.preview).toBeUndefined();
  });

  test('the preview stops tracking the cursor once the press begins', () => {
    addMode.startAddMode(makeCallbacks());
    mousemove(300, 300);
    const held = { left: boxEl().style.left, top: boxEl().style.top };
    mousedown(blocker(), 300, 300);
    // Below the drag threshold: still a click, and the preview must not
    // creep with the pointer while the button is held.
    mousemove(302, 301);
    expect(visualsEl().dataset.preview).toBe('true');
    expect({ left: boxEl().style.left, top: boxEl().style.top }).toEqual(held);
  });

  test('the preview is gone for good once a rect is placed by a plain click, and does not come back on further pointer moves', () => {
    addMode.startAddMode(makeCallbacks());
    mousemove(300, 200);
    expect(visualsEl().dataset.preview).toBe('true');

    place(blocker(), 300, 200);

    expect(visualsEl().dataset.preview).toBeUndefined();
    expect(visualsEl().dataset.previewVisible).toBeUndefined();
    expect(boxEl().dataset.preview).toBeUndefined();
    expect(visualsEl().dataset.hasBox).toBe('true');

    mousemove(500, 400); // 'editing' now — must not resurrect the preview
    expect(visualsEl().dataset.preview).toBeUndefined();
  });

  test('the tooltip reads "click or drag to select" (lowercase), tracks the cursor with the preview, and is hidden once a rect is placed', () => {
    addMode.startAddMode(makeCallbacks());
    const tooltip = previewTooltipEl();
    expect(tooltip.textContent).toBe('click or drag to select');
    expect(tooltip.dataset.visible).toBeUndefined();
    expect(tooltip.getAttribute('aria-hidden')).toBe('true');

    mousemove(300, 200);
    expect(tooltip.dataset.visible).toBe('true');
    // offset (+16, +20) from the cursor per design spec §G, unless that would
    // overflow the bounds (not the case here).
    expect(tooltip.style.left).toBe('316px');
    expect(tooltip.style.top).toBe('220px');

    place(blocker(), 300, 200);
    expect(tooltip.dataset.visible).toBeUndefined();
  });

  // ── the hint shows once per page session (design spec v4 §N) ─────────────

  test('the tooltip retires itself after ~5s, while the preview keeps following the cursor', () => {
    jest.useFakeTimers();
    try {
      addMode.startAddMode(makeCallbacks());
      const tooltip = previewTooltipEl();
      mousemove(300, 200);
      expect(tooltip.dataset.visible).toBe('true');

      jest.advanceTimersByTime(4999);
      expect(tooltip.dataset.visible).toBe('true');
      jest.advanceTimersByTime(1);
      expect(tooltip.dataset.visible).toBeUndefined();

      // The preview rect itself is unaffected — it still tracks the cursor.
      mousemove(500, 300);
      expect(tooltip.dataset.visible).toBeUndefined();
      expect(visualsEl().dataset.preview).toBe('true');
      const bounds = { width: 1200 - getSidebarWidth(), height: 800 };
      const expected = expectedDefaultBox(500, 300, bounds);
      expect(boxEl().style.left).toBe(`${expected.x}px`);
      expect(boxEl().style.top).toBe(`${expected.y}px`);
    } finally {
      jest.useRealTimers();
    }
  });

  test('once retired the tooltip never comes back, not even in a later add-mode session', () => {
    jest.useFakeTimers();
    try {
      addMode.startAddMode(makeCallbacks());
      mousemove(300, 200);
      jest.advanceTimersByTime(5000);
      expect(previewTooltipEl().dataset.visible).toBeUndefined();

      addMode.exitAddMode();
      addMode.startAddMode(makeCallbacks());
      mousemove(300, 200);
      expect(previewTooltipEl().dataset.visible).toBeUndefined();
      // Still a working preview, just no hint.
      expect(visualsEl().dataset.preview).toBe('true');
    } finally {
      jest.useRealTimers();
    }
  });

  test('inside its window the tooltip may come and go with the preview, and still retires on time', () => {
    jest.useFakeTimers();
    try {
      addMode.startAddMode(makeCallbacks());
      const tooltip = previewTooltipEl();
      const bounds = { width: 1200 - getSidebarWidth(), height: 800 };

      mousemove(300, 200);
      expect(tooltip.dataset.visible).toBe('true');

      jest.advanceTimersByTime(2000);
      mousemove(bounds.width + 10, 200); // onto the sidebar: preview + hint go
      expect(tooltip.dataset.visible).toBeUndefined();

      jest.advanceTimersByTime(1000);
      mousemove(300, 200); // back inside, still inside the 5s window
      expect(tooltip.dataset.visible).toBe('true');

      jest.advanceTimersByTime(2000); // 5s since it first appeared
      expect(tooltip.dataset.visible).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  test('exiting add mode leaves no hint timer behind to fire on a detached element', () => {
    jest.useFakeTimers();
    try {
      addMode.startAddMode(makeCallbacks());
      mousemove(300, 200);
      addMode.exitAddMode();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('the tooltip flips to stay clamped within the viewport near the bottom-right edge', () => {
    addMode.startAddMode(makeCallbacks());
    const bounds = { width: 1200 - getSidebarWidth(), height: 800 };
    const tooltip = previewTooltipEl();

    mousemove(bounds.width - 2, bounds.height - 2);

    const left = parseFloat(tooltip.style.left);
    const top = parseFloat(tooltip.style.top);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(left).toBeLessThanOrEqual(bounds.width);
    expect(top).toBeLessThanOrEqual(bounds.height);
  });

  test('the preview and tooltip stay inside .visuals, so hideOverlayUI() keeps them out of a screenshot', () => {
    addMode.startAddMode(makeCallbacks());
    mousemove(300, 200);
    expect(visualsEl().contains(boxEl())).toBe(true);
    expect(visualsEl().contains(previewTooltipEl())).toBe(true);

    addMode.hideOverlayUI();
    expect(visualsEl().getAttribute('data-hidden')).toBe('true');
  });

  // ── placement (drag-to-draw + click-vs-drag threshold) ───────────────────

  test('a mousedown+mousemove past the 5px threshold draws a custom box between the two points instead of the default size', () => {
    addMode.startAddMode(makeCallbacks());
    drag(blocker(), 300, 300, 500, 450);

    const box = addMode._boxForTests();
    expect(box).toEqual({ x: 300, y: 300, width: 200, height: 150 });
  });

  test('movement under the 5px threshold is treated as a click, not a drag (center-on-click default size)', () => {
    addMode.startAddMode(makeCallbacks());
    // 3px total movement on each axis stays under the 5px threshold.
    drag(blocker(), 300, 300, 303, 303);

    const bounds = { width: 1200 - getSidebarWidth(), height: 800 };
    const box = addMode._boxForTests();
    expect(box).toEqual(expectedDefaultBox(300, 300, bounds));
  });

  test('movement past the 5px threshold in only one axis still counts as a drag', () => {
    addMode.startAddMode(makeCallbacks());
    drag(blocker(), 300, 300, 300, 320); // 0px on x, 20px on y
    const box = addMode._boxForTests();
    expect(box).toEqual({ x: 300, y: 300, width: 20, height: 20 });
  });

  test('drag-to-draw works normalized in any direction (dragging up-left from the mousedown point)', () => {
    addMode.startAddMode(makeCallbacks());
    drag(blocker(), 500, 450, 300, 300); // mouse moves up and to the left
    const box = addMode._boxForTests();
    expect(box).toEqual({ x: 300, y: 300, width: 200, height: 150 });
  });

  test('the box updates live as the user drags, before mouseup finalizes it', () => {
    addMode.startAddMode(makeCallbacks());
    mousedown(blocker(), 300, 300);
    mousemove(500, 450); // past threshold — box should already reflect this

    expect(addMode._boxForTests()).toEqual({ x: 300, y: 300, width: 200, height: 150 });
    expect(boxEl().style.width).toBe('200px');
    expect(boxEl().style.height).toBe('150px');
    // still in the 'placing' phase — no comment box yet.
    expect(commentBoxEl()).toBeNull();

    mousemove(650, 600); // drag further — live box keeps growing
    expect(addMode._boxForTests()).toEqual({ x: 300, y: 300, width: 350, height: 300 });

    mouseup(650, 600);
    expect(addMode._boxForTests()).toEqual({ x: 300, y: 300, width: 350, height: 300 });
    expect(commentBoxEl()).not.toBeNull(); // finalized into 'editing'
  });

  test('drag-to-draw respects the 20x20 minimum size', () => {
    addMode.startAddMode(makeCallbacks());
    drag(blocker(), 300, 300, 305, 306); // past threshold, but a tiny rectangle
    const box = addMode._boxForTests();
    expect(box.width).toBeGreaterThanOrEqual(20);
    expect(box.height).toBeGreaterThanOrEqual(20);
  });

  test('drag-to-draw clamps to the viewport bounds', () => {
    addMode.startAddMode(makeCallbacks());
    const bounds = { width: 1200 - getSidebarWidth(), height: 800 };
    drag(blocker(), bounds.width - 50, bounds.height - 50, bounds.width + 500, bounds.height + 500);

    const box = addMode._boxForTests();
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.width);
    expect(box.y + box.height).toBeLessThanOrEqual(bounds.height);
  });

  // ── scrim + selection outline (design spec §3.2) ──────────────────────────

  test('nothing selection-related is shown before the first placement', () => {
    addMode.startAddMode(makeCallbacks());
    const visuals = shadowRoot().querySelector('.visuals') as HTMLElement;
    expect(visuals.dataset.hasBox).toBeUndefined();
    // The CSS gate that keeps the scrim's spread shadow from dimming the page
    // during 'placing'.
    expect(addModeOwnCSS()).toMatch(/\.visuals:not\(\[data-has-box="true"\]\) \.scrim-layer/);

    place(blocker(), 300, 300);
    expect(visuals.dataset.hasBox).toBe('true');
  });

  test('the scrim is a single rounded hole exactly over the box, clipped to the content area', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 300); // default box centered on (300, 300)

    expect(shadowRoot().querySelectorAll('.scrim-rect')).toHaveLength(0); // v1 four-strip scrim is gone
    const scrims = shadowRoot().querySelectorAll('.scrim');
    expect(scrims).toHaveLength(1);
    const scrim = scrims[0] as HTMLElement;
    const bounds = { width: 1200 - getSidebarWidth(), height: 800 };
    const expected = expectedDefaultBox(300, 300, bounds);
    expect([scrim.style.left, scrim.style.top, scrim.style.width, scrim.style.height]).toEqual([
      `${expected.x}px`, `${expected.y}px`, `${expected.width}px`, `${expected.height}px`,
    ]);

    const layer = shadowRoot().querySelector('.scrim-layer') as HTMLElement;
    expect(layer.style.width).toBe(`${1200 - getSidebarWidth()}px`);
    expect(layer.style.height).toBe('800px');

    expect(cssRule('.scrim')).toMatch(/border-radius:\s*var\(--sal-radius-md\)/);
    expect(cssRule('.scrim')).toMatch(/box-shadow:[^;]*var\(--sal-scrim\)/);
    expect(cssRule('.scrim')).toMatch(/pointer-events:\s*none/);
    expect(cssRule('.scrim-layer')).toMatch(/overflow:\s*hidden/);
    expect(cssRule('.scrim-layer')).toMatch(/pointer-events:\s*none/);
  });

  test('the selection outline alternates 4px accent / 4px ink at one width, with no keyline', () => {
    addMode.startAddMode(makeCallbacks());
    const rule = cssRule('.box');
    expect(rule).toMatch(/border-radius:\s*var\(--sal-radius-md\)/);
    // The line itself is an SVG stroke: CSS `dashed`/`dotted` derive their
    // dash length from the line's thickness and give no control over it, and
    // border-image with a repeating gradient ignores border-radius.
    expect(rule).not.toMatch(/outline:/);
    expect(rule).not.toMatch(/border:\s*2px/);
    // No separate keyline: the ink dashes already give the contrast, and a
    // keyline beside them read as a second, undashed line.
    expect(rule).not.toMatch(/box-shadow/);

    // Both rects stroke the same path at the same width, so the accent's
    // gaps are ink rather than holes and the line never thickens.
    expect(cssRule('.box-dash rect')).toMatch(/stroke-width:\s*2/);
    expect(cssRule('.box-dash .dash-ink')).toMatch(/stroke:\s*var\(--sal-on-accent\)/);
    const accent = cssRule('.box-dash .dash-accent');
    expect(accent).toMatch(/stroke:\s*var\(--sal-accent\)/);
    expect(accent).toMatch(/stroke-dasharray:\s*4 4/);
  });

  test('the outline SVG tracks the box and keeps its dashes 4px at any size', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 400, 300);
    const svg = shadowRoot().querySelector('.box-dash') as SVGSVGElement;
    const ink = shadowRoot().querySelector('.dash-ink') as SVGRectElement;
    const box = boxEl();
    const w = parseFloat(box.style.width);
    const h = parseFloat(box.style.height);
    // Sized in CSS pixels with no viewBox, so nothing scales the dashes.
    expect(svg.getAttribute('viewBox')).toBeNull();
    // The SVG overhangs by exactly the line's 2px on each side.
    expect(+svg.getAttribute('width')!).toBe(w + 4);
    expect(+svg.getAttribute('height')!).toBe(h + 4);
    // The stroke is centred on this path, so it lands in the 2px just
    // outside the selection and never covers it.
    expect(+ink.getAttribute('x')!).toBe(1);
    expect(+ink.getAttribute('width')!).toBe(w + 2);
    expect(addModeOwnCSS()).not.toMatch(/\.box:(hover|active)/);
    expect(addModeOwnCSS()).not.toMatch(/\.resize-zone:(hover|active)/);
  });

  test('add mode keeps exactly one <style> element and uses tokens instead of v1 hard-coded colours', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 200);
    expect(shadowRoot().querySelectorAll('style')).toHaveLength(1);
    expect(stylesheetText().startsWith(getThemeCSS())).toBe(true);
    expect(addModeOwnCSS()).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(addModeOwnCSS()).not.toMatch(/rgba?\(/);
  });

  // ── resize hit zones ───────────────────────────────────────────────────────

  test('no visible resize handles remain; 8 invisible hit zones (4 edges + 4 corners) replace them', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 200);
    expect(shadowRoot().querySelectorAll('.handle')).toHaveLength(0);
    expect(shadowRoot().querySelectorAll('[data-handle]')).toHaveLength(0);

    const zones = Array.from(shadowRoot().querySelectorAll('.resize-zone')) as HTMLElement[];
    expect(zones.map((z) => z.dataset.zone).sort()).toEqual(['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w']);
    for (const z of zones) expect(z.getAttribute('aria-hidden')).toBe('true');

    const rule = cssRule('.resize-zone');
    expect(rule).toMatch(/background:\s*transparent/);
    expect(rule).toMatch(/pointer-events:\s*auto/);
  });

  test('hit zones live inside .visuals, so hideOverlayUI() keeps them out of the screenshot', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 200);
    const visuals = shadowRoot().querySelector('.visuals') as HTMLElement;
    for (const z of Array.from(shadowRoot().querySelectorAll('.resize-zone'))) {
      expect(visuals.contains(z)).toBe(true);
    }
    expect(visuals.contains(shadowRoot().querySelector('.scrim'))).toBe(true);
  });

  test.each([
    ['n', 'ns-resize'],
    ['s', 'ns-resize'],
    ['e', 'ew-resize'],
    ['w', 'ew-resize'],
    ['nw', 'nwse-resize'],
    ['se', 'nwse-resize'],
    ['ne', 'nesw-resize'],
    ['sw', 'nesw-resize'],
  ])('the %s hit zone shows the %s cursor', (key, cursor) => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 300);
    expect(zone(key).style.cursor).toBe(cursor);
  });

  test('edge zones are 10px strips straddling the outline between the corners; corner zones are 16x16 centred on the corners', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 300); // default box centered on (300, 300)

    const bounds = { width: 1200 - getSidebarWidth(), height: 800 };
    const defaultBox = expectedDefaultBox(300, 300, bounds);
    const rects = expectedZoneRects(defaultBox);

    const rectOf = (key: string) => {
      const el = zone(key);
      return [el.style.left, el.style.top, el.style.width, el.style.height];
    };
    const asPx = (r: { x: number; y: number; width: number; height: number }) =>
      [`${r.x}px`, `${r.y}px`, `${r.width}px`, `${r.height}px`];
    expect(rectOf('n')).toEqual(asPx(rects.n));
    expect(rectOf('s')).toEqual(asPx(rects.s));
    expect(rectOf('w')).toEqual(asPx(rects.w));
    expect(rectOf('e')).toEqual(asPx(rects.e));
    expect(rectOf('nw')).toEqual(asPx(rects.nw));
    expect(rectOf('ne')).toEqual(asPx(rects.ne));
    expect(rectOf('sw')).toEqual(asPx(rects.sw));
    expect(rectOf('se')).toEqual(asPx(rects.se));
    expect(addMode._zoneRectsForTests().se).toEqual(rects.se);

    // Corners are appended after edges so they win the hit test where the
    // squares overlap the strip ends on a small box.
    const order = (Array.from(shadowRoot().querySelectorAll('.resize-zone')) as HTMLElement[]).map((z) => z.dataset.zone);
    expect(order.slice(0, 4).sort()).toEqual(['e', 'n', 's', 'w']);
  });

  // Placed at (300,300): the default box centered there (see
  // expectedDefaultBox/sidebar.DEFAULT_THUMBNAIL_BOX_SIZE).
  test.each([
    ['n', 300, 200],
    ['s', 300, 400],
    ['e', 450, 300],
    ['w', 150, 300],
    ['nw', 150, 200],
    ['ne', 450, 200],
    ['sw', 150, 400],
    ['se', 450, 400],
  ])('dragging the %s hit zone to (%i, %i) moves only that side/corner', (key, toX, toY) => {
    addMode.startAddMode(makeCallbacks());
    const bounds = { width: 1200 - getSidebarWidth(), height: 800 };
    const defaultBox = expectedDefaultBox(300, 300, bounds);
    place(blocker(), 300, 300);

    mousedown(zone(key), 0, 0);
    mousemove(toX, toY);
    mouseup(toX, toY);

    const expected = expectedResizeBox(defaultBox, key, toX, toY, bounds);
    expect(addMode._boxForTests()).toEqual(expected);
    // the rendered outline and scrim hole follow the new rect
    expect(boxEl().style.width).toBe(`${expected.width}px`);
    expect((shadowRoot().querySelector('.scrim') as HTMLElement).style.height).toBe(`${expected.height}px`);
  });

  test('the resize cursor is held on the blocker for the whole drag and cleared on mouseup', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 300);

    mousedown(zone('ne'), 400, 225);
    expect(blocker().style.cursor).toBe('nesw-resize');
    mousemove(420, 210);
    mouseup(420, 210);
    expect(blocker().style.cursor).toBe('');

    // listener hygiene: a stray move after mouseup no longer resizes
    const after = addMode._boxForTests();
    mousemove(600, 100);
    expect(addMode._boxForTests()).toEqual(after);
  });

  test('hit zones do nothing before placement is finalized', () => {
    addMode.startAddMode(makeCallbacks());
    mousedown(blocker(), 300, 300);
    mousemove(500, 450); // live drag-to-draw, still 'placing'
    const during = addMode._boxForTests();
    mousedown(zone('se'), 500, 450);
    expect(blocker().style.cursor).toBe('');
    mouseup(500, 450);
    expect(addMode._boxForTests()).toEqual(during);
  });

  test('dragging the se corner grows the box to the new bottom-right corner', () => {
    addMode.startAddMode(makeCallbacks());
    const bounds = { width: 1200 - getSidebarWidth(), height: 800 };
    const defaultBox = expectedDefaultBox(100, 100, bounds);
    place(blocker(), 100, 100); // default box centered on (100, 100)

    mousedown(zone('se'), defaultBox.x + defaultBox.width, defaultBox.y + defaultBox.height);
    mousemove(400, 350);
    mouseup();

    const box = addMode._boxForTests();
    expect(box).toEqual(expectedResizeBox(defaultBox, 'se', 400, 350, bounds));
  });

  test('resize enforces the 20x20 minimum size from an edge and from a corner', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 300); // default box centered on (300, 300)

    mousedown(zone('w'), 200, 300);
    mousemove(1_000_000, 300); // drag far past the opposite edge, trying to shrink past the minimum
    mouseup();
    expect(addMode._boxForTests().width).toBe(20);

    mousedown(zone('se'), 400, 375);
    mousemove(-500, -500); // drag the corner far past the opposite one
    mouseup();
    const box = addMode._boxForTests();
    expect(box.width).toBe(20);
    expect(box.height).toBe(20);
  });

  test('resize clamps to the content viewport bounds (minus the sidebar) on every side', () => {
    addMode.startAddMode(makeCallbacks());
    const bounds = { width: 1200 - getSidebarWidth(), height: 800 };
    place(blocker(), 300, 300);

    mousedown(zone('se'), 400, 375);
    mousemove(bounds.width + 500, bounds.height + 500);
    mouseup();
    mousedown(zone('nw'), 200, 225);
    mousemove(-500, -500);
    mouseup();

    expect(addMode._boxForTests()).toEqual({ x: 0, y: 0, width: bounds.width, height: bounds.height });
  });

  // ── comment box ────────────────────────────────────────────────────────────

  test('save is disabled while the textarea is empty, enabled once text is entered', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 200);
    expect(saveBtn().disabled).toBe(true);

    typeNote('looks broken here');
    expect(saveBtn().disabled).toBe(false);
  });

  test('save stays disabled for whitespace-only text', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 200);

    typeNote('   ');
    expect(saveBtn().disabled).toBe(true);
  });

  test('placeholder text is lowercase per §3.4 ("what should change here?")', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 200);
    expect(textarea().placeholder).toBe('what should change here?');
  });

  test('counter: hidden at 0-900 chars, muted at 901-979, danger at 980-1000, formatted "n/1000"', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 200);

    typeNote('a'.repeat(900));
    expect(counter().dataset.warn).toBe('false');
    expect(counter().dataset.danger).toBe('false');

    typeNote('a'.repeat(901));
    expect(counter().dataset.warn).toBe('true');
    expect(counter().dataset.danger).toBe('false');
    expect(counter().textContent).toBe('901/1000');

    typeNote('a'.repeat(979));
    expect(counter().dataset.danger).toBe('false');

    typeNote('a'.repeat(980));
    expect(counter().dataset.warn).toBe('true');
    expect(counter().dataset.danger).toBe('true');
    expect(counter().textContent).toBe('980/1000');

    typeNote('a'.repeat(1000));
    expect(counter().dataset.danger).toBe('true');
    expect(counter().textContent).toBe('1000/1000');

    const css = addModeOwnCSS();
    expect(cssRule('.counter')).toMatch(/visibility:\s*hidden/);
    expect(cssRule('.counter')).toMatch(/color:\s*var\(--sal-muted\)/);
    expect(cssRule('.counter')).toMatch(/font-family:\s*var\(--sal-font-mono\)/);
    expect(css).toMatch(/\.counter\[data-warn="true"\]\s*\{\s*visibility:\s*visible/);
    expect(css).toMatch(/\.counter\[data-danger="true"\]\s*\{[^}]*color:\s*var\(--sal-danger\)[^}]*font-weight:\s*600/);
  });

  test('comment box wrapper is a plain 296px shadowPop container; the text area and footer form the visible surface (design spec §3.2 v2 §C)', () => {
    addMode.startAddMode(makeCallbacks());
    const rule = cssRule('.comment-box');
    expect(rule).toMatch(/width:\s*296px/);
    expect(rule).toMatch(/box-shadow:\s*var\(--sal-shadow-pop\)/);
    // no fill/border of its own — those live on the textarea/footer; the
    // radius only shapes the drop shadow to the merged surface (no square
    // shadow corners)
    expect(rule).not.toMatch(/background:/);
    expect(rule).not.toMatch(/border:/);
    expect(rule).toMatch(/border-radius:\s*var\(--sal-radius-lg\)/);
    expect(addModeOwnCSS()).not.toMatch(/\.comment-box:(hover|focus)/);
    expect(addModeOwnCSS()).not.toMatch(/border-(left|right):/); // no dividers between buttons
  });

  test('the footer is a raised extension tucked under the text area by one radius-lg, sitting behind it (z-index)', () => {
    addMode.startAddMode(makeCallbacks());
    const textareaRule = cssRule('.note-input');
    expect(textareaRule).toMatch(/z-index:\s*1/);

    const footer = cssRule('.footer');
    expect(footer).toMatch(/z-index:\s*0/);
    expect(footer).toMatch(/margin-top:\s*calc\(-1 \* var\(--sal-radius-lg\)\)/);
    expect(footer).toMatch(/background:\s*var\(--sal-raised\)/);
    expect(footer).toMatch(/border-radius:\s*0 0 var\(--sal-radius-lg\) var\(--sal-radius-lg\)/);
    expect(footer).not.toMatch(/border-top:/); // hidden under the textarea — no divider needed
  });

  test('the footer extension carries the note\'s 1px line border, drawn inside (v4 §O)', () => {
    addMode.startAddMode(makeCallbacks());
    const footer = cssRule('.footer');
    expect(footer).toMatch(/box-shadow:\s*inset 0 0 0 1px var\(--sal-line\)/);
    // Drawn inside, not as a real border that would bleed past the text
    // area's edges above it.
    expect(footer).not.toMatch(/(^|[^-])border:\s*1px/);
  });

  test('textarea is its own bordered surface: line border at rest, lineStrong on hover, accent on focus (colour change only)', () => {
    addMode.startAddMode(makeCallbacks());
    expect(cssRule('.note-input')).toMatch(/border:\s*1px solid var\(--sal-line\)/);
    expect(cssRule('.note-input')).toMatch(/border-radius:\s*var\(--sal-radius-lg\)/);
    expect(cssRule('.note-input')).toMatch(/outline:\s*none/);
    expect(cssRule('.note-input:hover')).toMatch(/border-color:\s*var\(--sal-line-strong\);/);
    const focus = cssRule('.note-input:focus');
    expect(focus).toMatch(/border-color:\s*var\(--sal-accent\);/);
    expect(focus).not.toMatch(/box-shadow/); // colour change only — no extra ring
    // :focus comes after :hover so it wins while both apply
    const css = addModeOwnCSS();
    expect(css.indexOf('.note-input:focus')).toBeGreaterThan(css.indexOf('.note-input:hover'));
  });

  test('save/cancel buttons: rounded-sm, ~30px tall, padded, standard (non-inset) focus ring (design spec §2, v2 §C)', () => {
    addMode.startAddMode(makeCallbacks());
    expect(cssRule('.btn')).toMatch(/height:\s*30px/);
    expect(cssRule('.btn')).toMatch(/border-radius:\s*var\(--sal-radius-sm\)/);
    expect(cssRule('.btn')).toMatch(/padding:\s*0 12px/);

    expect(cssRule('.btn-save')).toMatch(/color:\s*var\(--sal-accent-ink\)/);
    expect(cssRule('.btn-save')).toMatch(/font-weight:\s*700/);
    expect(cssRule('.btn-save:not(:disabled):hover')).toMatch(/background:\s*var\(--sal-accent\);\s*color:\s*var\(--sal-on-accent\)/);
    expect(cssRule('.btn-save:not(:disabled):active')).toMatch(/background:\s*var\(--sal-accent-press\)/);
    const saveFocus = cssRule('.btn-save:not(:disabled):focus-visible');
    expect(saveFocus).toMatch(/background:\s*var\(--sal-accent\)/);
    expect(saveFocus).toMatch(/box-shadow:\s*0 0 0 2px var\(--sal-bg\), 0 0 0 4px var\(--sal-focus\)/);
    expect(cssRule('.btn-save:disabled')).toMatch(/color:\s*var\(--sal-muted\);\s*opacity:\s*0\.5/);

    expect(cssRule('.btn-cancel')).toMatch(/color:\s*var\(--sal-muted\)/);
    expect(cssRule('.btn-cancel:not(:disabled):hover')).toMatch(/background:\s*var\(--sal-hover\)/);
    expect(cssRule('.btn-cancel:not(:disabled):active')).toMatch(/background:\s*var\(--sal-press\)/);
    expect(cssRule('.btn-cancel:focus-visible')).toMatch(/box-shadow:\s*0 0 0 2px var\(--sal-bg\), 0 0 0 4px var\(--sal-focus\)/);

    // Left: the pencil tools; right: the counter, then cancel, then save
    // (design spec §AB moved the counter over from the left).
    const footerKids = Array.from(shadowRoot().querySelectorAll('.footer > *'));
    expect(footerKids).toHaveLength(0); // not built until placement
    place(blocker(), 300, 200);
    const classes = (Array.from(shadowRoot().querySelectorAll('.footer > *')) as HTMLElement[]).map((el) => el.className);
    expect(classes).toEqual(['draw-tools', 'counter', 'btn btn-cancel', 'btn btn-save']);
  });

  test('textarea has a maxlength of 1000', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 200);
    expect(textarea().maxLength).toBe(1000);
  });

  test('save click fires onOk with the selection rect and trimmed note, and locks the comment box while capturing', () => {
    const cbs = makeCallbacks();
    addMode.startAddMode(cbs);
    place(blocker(), 300, 200);

    typeNote('  spacing is off here  ');
    click(saveBtn(), 0, 0);

    const bounds = { width: 1200 - getSidebarWidth(), height: 800 };
    expect(cbs.calls.ok).toHaveLength(1);
    expect(cbs.calls.ok[0].note).toBe('spacing is off here');
    expect(cbs.calls.ok[0].rect).toEqual(expectedDefaultBox(300, 200, bounds));
    expect(saveBtn().disabled).toBe(true);
    expect(cancelBtn().disabled).toBe(true);
    expect(saveBtn().textContent).toBe('saving\u2026');
    expect(textarea().readOnly).toBe(true);
    expect(commentBoxEl()!.getAttribute('aria-busy')).toBe('true');
    // add mode does not tear itself down on save — the caller drives that.
    expect(addMode.isAddModeActive()).toBe(true);
  });

  test('cancel and save buttons render lowercase labels per §3.4 (no "ok" button remains)', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 200);
    expect(cancelBtn().textContent).toBe('cancel');
    expect(saveBtn().textContent).toBe('save');
    expect(shadowRoot().querySelector('.btn-ok')).toBeNull();
    const labels = (Array.from(shadowRoot().querySelectorAll('button')) as HTMLButtonElement[]).map((b) => b.textContent);
    expect(labels).not.toContain('ok');
  });

  // ── hide/show overlay UI (for the capture pipeline) ────────────────

  test('hideOverlayUI hides the visuals container; showOverlayUI restores it and re-enables buttons', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 200);

    typeNote('note');
    click(saveBtn(), 0, 0); // disables save/cancel, simulating a capture in flight

    addMode.hideOverlayUI();
    expect(shadowRoot().querySelector('.visuals')!.getAttribute('data-hidden')).toBe('true');

    addMode.showOverlayUI();
    expect(shadowRoot().querySelector('.visuals')!.getAttribute('data-hidden')).toBe('false');
    expect(saveBtn().disabled).toBe(false); // note still present, so re-enabled
    expect(saveBtn().textContent).toBe('save');
    expect(cancelBtn().disabled).toBe(false);
    expect(textarea().readOnly).toBe(false);
    expect(commentBoxEl()!.hasAttribute('aria-busy')).toBe(false);
  });

  // ── keyboard isolation regression (Gmail/Instagram leak bug) ─────────────
  // See keyboardIsolation.ts / keyboardIsolation.test.ts for the general
  // mechanism proof; these verify addMode.ts actually wires it up around the
  // comment box's textarea.

  test('a hostile document-level keydown listener never sees keys typed into the comment textarea once it exists', () => {
    let hostileFired = false;
    const hostileHandler = (e: KeyboardEvent) => {
      hostileFired = true;
      e.preventDefault();
    };
    document.addEventListener('keydown', hostileHandler);

    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 200); // builds the comment box + textarea

    const event = new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true, composed: true });
    const notCancelled = textarea().dispatchEvent(event);

    expect(hostileFired).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(notCancelled).toBe(true);

    document.removeEventListener('keydown', hostileHandler);
  });

  test('keyboard isolation is not installed before the comment box exists, and is released on exitAddMode', () => {
    let hostileFired = false;
    const hostileHandler = () => { hostileFired = true; };
    document.addEventListener('keydown', hostileHandler);

    addMode.startAddMode(makeCallbacks());
    // Before placement, there is no textarea; a keydown on the blocker itself
    // (not inside a text surface) should not be isolated away from the page.
    blocker().dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true, composed: true }));
    expect(hostileFired).toBe(true);

    hostileFired = false;
    place(blocker(), 300, 200);
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true, composed: true }));
    expect(hostileFired).toBe(false); // isolated while the comment box is open

    addMode.exitAddMode();
    hostileFired = false;
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true }));
    expect(hostileFired).toBe(true); // isolation released after teardown

    document.removeEventListener('keydown', hostileHandler);
  });

  // ── never-off-screen comment box ──────────────────────────────────────────

  test('comment box position is always clamped within the viewport bounds, even in a tiny viewport', () => {
    setViewport(getSidebarWidth() + 260, 200); // barely wider than the sidebar + comment box
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 10, 10);

    const comment = shadowRoot().querySelector('.comment-box') as HTMLElement;
    const left = parseFloat(comment.style.left);
    const top = parseFloat(comment.style.top);
    const bounds = { width: getSidebarWidth() + 260 - getSidebarWidth(), height: 200 };

    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(left).toBeLessThanOrEqual(Math.max(0, bounds.width));
    expect(top).toBeLessThanOrEqual(Math.max(0, bounds.height));
  });

  // ── sidebar widened during add mode ──────────────────────────────────────

  describe('sidebar width changing mid-selection', () => {
    afterEach(() => {
      sidebar.destroySidebar();
      document.documentElement.style.cssText = '';
    });

    test('widening the sidebar re-clamps a box placed flush right (shifted, size kept)', () => {
      sidebar.initSidebar({ onAdd() {}, onExport() {}, onImportFile() {}, onClose() {}, onOpenItem() {} });
      sidebar.setSidebarWidth(200);
      sidebar.openSidebar();
      addMode.startAddMode(makeCallbacks());
      // Flush against the (then) right edge of the selectable area: 1200 − 200.
      drag(blocker(), 800, 100, 1000, 300);
      expect(addMode._boxForTests()).toEqual({ x: 800, y: 100, width: 200, height: 200 });

      sidebar.setSidebarWidth(300); // dispatches a synthetic resize while open
      expect(addMode._boxForTests()).toEqual({ x: 700, y: 100, width: 200, height: 200 });
      expect(boxEl().style.left).toBe('700px');
      expect(getHost()!.style.width).toBe('900px');
    });

    test('a box wider than the new bounds is shrunk to fit, and narrowing leaves it alone', () => {
      sidebar.initSidebar({ onAdd() {}, onExport() {}, onImportFile() {}, onClose() {}, onOpenItem() {} });
      sidebar.setSidebarWidth(sidebar.SIDEBAR_MIN_WIDTH); // 188px (v5 §V)
      sidebar.openSidebar();
      setViewport(400, 800);
      addMode.startAddMode(makeCallbacks());
      drag(blocker(), 0, 0, 300, 100); // full width of the 212px selectable area
      expect(addMode._boxForTests().width).toBe(212);

      sidebar.setSidebarWidth(250);
      expect(addMode._boxForTests()).toEqual({ x: 0, y: 0, width: 150, height: 100 });

      sidebar.setSidebarWidth(sidebar.SIDEBAR_MIN_WIDTH);
      expect(addMode._boxForTests()).toEqual({ x: 0, y: 0, width: 150, height: 100 });
    });

    test('stops listening once add mode exits', () => {
      addMode.startAddMode(makeCallbacks());
      addMode.exitAddMode();
      expect(() => window.dispatchEvent(new Event('resize'))).not.toThrow();
      expect(getHost()).toBeNull();
    });
  });
});
