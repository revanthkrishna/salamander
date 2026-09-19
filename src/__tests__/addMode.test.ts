// Phase 4: add-mode tests — box placement/clamping, resize hit-zone geometry
// and edge/corner resizing, the rounded-hole scrim, the comment box's char
// counter and save-disabled state, the never-off-screen positioning
// guarantee, and cancel/save lifecycle (Salamander design spec §3.2).
//
// jsdom has no layout engine, so these verify the *mechanism* — inline
// px values computed from window.innerWidth/innerHeight — not actual pixel
// rendering. Real-site visual verification is Phase 10's Playwright suite.

import * as addMode from '../addMode';
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

  test('a plain click (no drag) centers the default 200x150 box on the click point', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 200);

    const box = addMode._boxForTests();
    // centered: top-left = (clickX - width/2, clickY - height/2)
    expect(box).toEqual({ x: 200, y: 125, width: 200, height: 150 });
    expect(boxEl().style.left).toBe('200px');
    expect(boxEl().style.top).toBe('125px');
    expect(boxEl().style.width).toBe('200px');
    expect(boxEl().style.height).toBe('150px');
  });

  test('clamps a naive top/left-off-screen centered box by shifting it fully on-screen (exact worked example: click (20,20) -> box (0,0)-(200,150))', () => {
    addMode.startAddMode(makeCallbacks());
    // naive centering: (20 - 100, 20 - 75) = (-80, -55), which clamps to (0, 0)
    place(blocker(), 20, 20);

    const box = addMode._boxForTests();
    expect(box).toEqual({ x: 0, y: 0, width: 200, height: 150 });
  });

  test('clamps a naive bottom/right-off-screen centered box symmetrically', () => {
    addMode.startAddMode(makeCallbacks());
    const bounds = { width: 1200 - getSidebarWidth(), height: 800 };
    // click 20px from the bottom-right corner of the selectable area: naive
    // centering pushes the box off both the right and bottom edges.
    place(blocker(), bounds.width - 20, bounds.height - 20);

    const box = addMode._boxForTests();
    expect(box).toEqual({
      x: bounds.width - 200,
      y: bounds.height - 150,
      width: 200,
      height: 150,
    });
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

    const box = addMode._boxForTests();
    expect(box).toEqual({ x: 200, y: 225, width: 200, height: 150 });
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
    place(blocker(), 300, 300); // box x200 y225 w200 h150

    expect(shadowRoot().querySelectorAll('.scrim-rect')).toHaveLength(0); // v1 four-strip scrim is gone
    const scrims = shadowRoot().querySelectorAll('.scrim');
    expect(scrims).toHaveLength(1);
    const scrim = scrims[0] as HTMLElement;
    expect([scrim.style.left, scrim.style.top, scrim.style.width, scrim.style.height]).toEqual([
      '200px', '225px', '200px', '150px',
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

  test('the selection box has a radius-md outline of accent + keyline and no hover/press styling', () => {
    addMode.startAddMode(makeCallbacks());
    const rule = cssRule('.box');
    expect(rule).toMatch(/border-radius:\s*var\(--sal-radius-md\)/);
    expect(rule).toMatch(/box-shadow:\s*0 0 0 2px var\(--sal-accent\), 0 0 0 3px var\(--sal-keyline\)/);
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
    place(blocker(), 300, 300); // box x200 y225 w200 h150 -> right 400 bottom 375

    const rectOf = (key: string) => {
      const el = zone(key);
      return [el.style.left, el.style.top, el.style.width, el.style.height];
    };
    expect(rectOf('n')).toEqual(['208px', '220px', '184px', '10px']);
    expect(rectOf('s')).toEqual(['208px', '370px', '184px', '10px']);
    expect(rectOf('w')).toEqual(['195px', '233px', '10px', '134px']);
    expect(rectOf('e')).toEqual(['395px', '233px', '10px', '134px']);
    expect(rectOf('nw')).toEqual(['192px', '217px', '16px', '16px']);
    expect(rectOf('ne')).toEqual(['392px', '217px', '16px', '16px']);
    expect(rectOf('sw')).toEqual(['192px', '367px', '16px', '16px']);
    expect(rectOf('se')).toEqual(['392px', '367px', '16px', '16px']);
    expect(addMode._zoneRectsForTests().se).toEqual({ x: 392, y: 367, width: 16, height: 16 });

    // Corners are appended after edges so they win the hit test where the
    // squares overlap the strip ends on a small box.
    const order = (Array.from(shadowRoot().querySelectorAll('.resize-zone')) as HTMLElement[]).map((z) => z.dataset.zone);
    expect(order.slice(0, 4).sort()).toEqual(['e', 'n', 's', 'w']);
  });

  // Placed at (300,300): box x200 y225 w200 h150 -> left 200, top 225, right 400, bottom 375.
  test.each([
    ['n', 300, 200, { x: 200, y: 200, width: 200, height: 175 }],
    ['s', 300, 400, { x: 200, y: 225, width: 200, height: 175 }],
    ['e', 450, 300, { x: 200, y: 225, width: 250, height: 150 }],
    ['w', 150, 300, { x: 150, y: 225, width: 250, height: 150 }],
    ['nw', 150, 200, { x: 150, y: 200, width: 250, height: 175 }],
    ['ne', 450, 200, { x: 200, y: 200, width: 250, height: 175 }],
    ['sw', 150, 400, { x: 150, y: 225, width: 250, height: 175 }],
    ['se', 450, 400, { x: 200, y: 225, width: 250, height: 175 }],
  ])('dragging the %s hit zone to (%i, %i) moves only that side/corner', (key, toX, toY, expected) => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 300);

    mousedown(zone(key), 0, 0);
    mousemove(toX, toY);
    mouseup(toX, toY);

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
    place(blocker(), 100, 100); // centered default box: x0 y25 w200 h150 -> right 200 bottom 175

    mousedown(zone('se'), 200, 175);
    mousemove(400, 350);
    mouseup();

    const box = addMode._boxForTests();
    expect(box).toEqual({ x: 0, y: 25, width: 400, height: 325 });
  });

  test('resize enforces the 20x20 minimum size from an edge and from a corner', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 300); // centered default box: right edge at 400, bottom at 375

    mousedown(zone('w'), 200, 300);
    mousemove(390, 300); // try to shrink width to 10px
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

  test('comment box is one merged 280px surface: radius lg, 1px line border, shadowPop, overflow hidden, no padding', () => {
    addMode.startAddMode(makeCallbacks());
    const rule = cssRule('.comment-box');
    expect(rule).toMatch(/width:\s*280px/);
    expect(rule).toMatch(/border-radius:\s*var\(--sal-radius-lg\)/);
    expect(rule).toMatch(/border:\s*1px solid var\(--sal-line\)/);
    expect(rule).toMatch(/background:\s*var\(--sal-surface\)/);
    expect(rule).toMatch(/box-shadow:\s*var\(--sal-shadow-pop\)/);
    expect(rule).toMatch(/overflow:\s*hidden/);
    expect(rule).toMatch(/padding:\s*0/);
    expect(addModeOwnCSS()).not.toMatch(/\.comment-box:(hover|focus)/);

    const footer = cssRule('.footer');
    expect(footer).toMatch(/height:\s*36px/);
    expect(footer).toMatch(/border-top:\s*1px solid var\(--sal-line\)/);
    expect(addModeOwnCSS()).not.toMatch(/border-(left|right):/); // no dividers between buttons
  });

  test('textarea: no border of its own; hover edge = inset lineStrong, focus edge = inset accent only', () => {
    addMode.startAddMode(makeCallbacks());
    expect(cssRule('.note-input')).toMatch(/border:\s*none/);
    expect(cssRule('.note-input')).toMatch(/outline:\s*none/);
    expect(cssRule('.note-input:hover')).toMatch(/box-shadow:\s*inset 0 0 0 1px var\(--sal-line-strong\);/);
    const focus = cssRule('.note-input:focus');
    expect(focus).toMatch(/box-shadow:\s*inset 0 0 0 1px var\(--sal-accent\);/);
    expect(focus).not.toMatch(/,/); // a single inset edge — no secondary soft ring
    // :focus comes after :hover so it wins while both apply
    const css = addModeOwnCSS();
    expect(css.indexOf('.note-input:focus')).toBeGreaterThan(css.indexOf('.note-input:hover'));
  });

  test('save/cancel button states follow design spec §2', () => {
    addMode.startAddMode(makeCallbacks());
    expect(cssRule('.btn-save')).toMatch(/color:\s*var\(--sal-accent-ink\)/);
    expect(cssRule('.btn-save')).toMatch(/font-weight:\s*700/);
    expect(cssRule('.btn-save:not(:disabled):hover')).toMatch(/background:\s*var\(--sal-accent\);\s*color:\s*var\(--sal-on-accent\)/);
    expect(cssRule('.btn-save:not(:disabled):active')).toMatch(/background:\s*var\(--sal-accent-press\)/);
    const saveFocus = cssRule('.btn-save:not(:disabled):focus-visible');
    expect(saveFocus).toMatch(/background:\s*var\(--sal-accent\)/);
    expect(saveFocus).toMatch(/box-shadow:\s*inset 0 0 0 2px var\(--sal-focus\)/);
    expect(cssRule('.btn-save:disabled')).toMatch(/color:\s*var\(--sal-muted\);\s*opacity:\s*0\.5/);

    expect(cssRule('.btn-cancel')).toMatch(/color:\s*var\(--sal-muted\)/);
    expect(cssRule('.btn-cancel:not(:disabled):hover')).toMatch(/background:\s*var\(--sal-hover\)/);
    expect(cssRule('.btn-cancel:not(:disabled):active')).toMatch(/background:\s*var\(--sal-press\)/);
    expect(cssRule('.btn-cancel:focus-visible')).toMatch(/box-shadow:\s*inset 0 0 0 2px var\(--sal-focus\)/);

    // cancel comes before save in the footer, counter first
    const footerKids = Array.from(shadowRoot().querySelectorAll('.footer > *'));
    expect(footerKids).toHaveLength(0); // not built until placement
    place(blocker(), 300, 200);
    const classes = (Array.from(shadowRoot().querySelectorAll('.footer > *')) as HTMLElement[]).map((el) => el.className);
    expect(classes).toEqual(['counter', 'btn btn-cancel', 'btn btn-save']);
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

    expect(cbs.calls.ok).toHaveLength(1);
    expect(cbs.calls.ok[0].note).toBe('spacing is off here');
    expect(cbs.calls.ok[0].rect).toEqual({ x: 200, y: 125, width: 200, height: 150 });
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

  // ── hide/show overlay UI (for Phase 5's capture pipeline) ────────────────

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
});
