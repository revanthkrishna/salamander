// Phase 4: add-mode tests — box placement/clamping, resize-handle geometry,
// scrim regions, the comment box's char counter and ok-disabled state, the
// never-off-screen positioning guarantee, and cancel/ok lifecycle.
//
// jsdom has no layout engine, so these verify the *mechanism* — inline
// px values computed from window.innerWidth/innerHeight — not actual pixel
// rendering. Real-site visual verification is Phase 10's Playwright suite.

import * as addMode from '../addMode';
import { SIDEBAR_WIDTH } from '../sidebar';

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

function handle(key: string): HTMLElement {
  return shadowRoot().querySelector(`.handle[data-handle="${key}"]`) as HTMLElement;
}

function textarea(): HTMLTextAreaElement {
  return shadowRoot().querySelector('.note-input') as HTMLTextAreaElement;
}

function okBtn(): HTMLButtonElement {
  return shadowRoot().querySelector('.btn-ok') as HTMLButtonElement;
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
    expect(shadowRoot().querySelector('.btn-ok')).toBeNull();
    expect(shadowRoot().querySelector('.btn-cancel')).toBeNull();
  });

  test('the comment box is created only once the placement click lands', () => {
    addMode.startAddMode(makeCallbacks());
    expect(commentBoxEl()).toBeNull();

    place(blocker(), 300, 200);

    expect(commentBoxEl()).not.toBeNull();
    expect(textarea()).not.toBeNull();
    expect(okBtn()).not.toBeNull();
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
    // clickable inside .visuals — resize handles, and the comment box — must
    // explicitly opt back into pointer-events: auto, or its computed value
    // inherits :none from the host and every click on it is silently
    // swallowed (mouse only — Tab-key focus is unaffected, which is exactly
    // the symptom this regression test guards against).
    const css = stylesheetText();
    const commentBoxRule = css.match(/\.comment-box\s*\{[^}]*\}/)?.[0] ?? '';
    expect(commentBoxRule).toMatch(/pointer-events:\s*auto/);
  });

  test('cancel button tears down add mode and fires onCancel, with no onOk call', () => {
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
    const bounds = { width: 1200 - SIDEBAR_WIDTH, height: 800 };
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
    const bounds = { width: 1200 - SIDEBAR_WIDTH, height: 800 };
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
    const bounds = { width: 1200 - SIDEBAR_WIDTH, height: 800 };
    drag(blocker(), bounds.width - 50, bounds.height - 50, bounds.width + 500, bounds.height + 500);

    const box = addMode._boxForTests();
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.width);
    expect(box.y + box.height).toBeLessThanOrEqual(bounds.height);
  });

  // ── resize handles ─────────────────────────────────────────────────────────

  test('renders all 8 resize handles once placed', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 200);
    const handles = shadowRoot().querySelectorAll('.handle');
    expect(handles).toHaveLength(8);
  });

  test('dragging the se handle grows the box to the new bottom-right corner', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 100, 100); // centered default box: x0 y25 w200 h150 -> right 200 bottom 175

    mousedown(handle('se'), 300, 250);
    mousemove(400, 350);
    mouseup();

    const box = addMode._boxForTests();
    expect(box).toEqual({ x: 0, y: 25, width: 400, height: 325 });
  });

  test('dragging the nw handle moves the top-left corner and keeps the opposite corner fixed', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 300); // centered default box: x200 y225 w200 h150 -> right 400 bottom 375

    mousedown(handle('nw'), 300, 300);
    mousemove(250, 260);
    mouseup();

    const box = addMode._boxForTests();
    expect(box.x).toBe(250);
    expect(box.y).toBe(260);
    expect(box.x + box.width).toBe(400);
    expect(box.y + box.height).toBe(375);
  });

  test('resize enforces the 20x20 minimum size', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 300); // centered default box: right edge at 400

    mousedown(handle('w'), 300, 300);
    mousemove(390, 300); // try to shrink width to 10px
    mouseup();

    const box = addMode._boxForTests();
    expect(box.width).toBeGreaterThanOrEqual(20);
  });

  test('resize clamps to the viewport bounds', () => {
    addMode.startAddMode(makeCallbacks());
    const bounds = { width: 1200 - SIDEBAR_WIDTH, height: 800 };
    place(blocker(), 300, 300);

    mousedown(handle('e'), 500, 300);
    mousemove(bounds.width + 500, 300); // drag far past the right edge
    mouseup();

    const box = addMode._boxForTests();
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.width);
  });

  // ── comment box ────────────────────────────────────────────────────────────

  test('ok is disabled while the textarea is empty, enabled once text is entered', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 200);
    expect(okBtn().disabled).toBe(true);

    textarea().value = 'looks broken here';
    textarea().dispatchEvent(new Event('input'));
    expect(okBtn().disabled).toBe(false);
  });

  test('ok stays disabled for whitespace-only text', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 200);

    textarea().value = '   ';
    textarea().dispatchEvent(new Event('input'));
    expect(okBtn().disabled).toBe(true);
  });

  test('placeholder text is lowercase per §3.4', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 200);
    expect(textarea().placeholder).toBe('type something...');
  });

  test('counter is hidden below 900 characters, visible at 900+, flagged danger at 980+', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 200);

    textarea().value = 'a'.repeat(899);
    textarea().dispatchEvent(new Event('input'));
    expect(counter().dataset.warn).toBe('false');

    textarea().value = 'a'.repeat(900);
    textarea().dispatchEvent(new Event('input'));
    expect(counter().dataset.warn).toBe('true');
    expect(counter().dataset.danger).toBe('false');

    textarea().value = 'a'.repeat(980);
    textarea().dispatchEvent(new Event('input'));
    expect(counter().dataset.danger).toBe('true');
  });

  test('textarea has a maxlength of 1000', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 200);
    expect(textarea().maxLength).toBe(1000);
  });

  test('ok click fires onOk with the selection rect and trimmed note, and disables both buttons', () => {
    const cbs = makeCallbacks();
    addMode.startAddMode(cbs);
    place(blocker(), 300, 200);

    textarea().value = '  spacing is off here  ';
    textarea().dispatchEvent(new Event('input'));
    click(okBtn(), 0, 0);

    expect(cbs.calls.ok).toHaveLength(1);
    expect(cbs.calls.ok[0].note).toBe('spacing is off here');
    expect(cbs.calls.ok[0].rect).toEqual({ x: 200, y: 125, width: 200, height: 150 });
    expect(okBtn().disabled).toBe(true);
    expect(cancelBtn().disabled).toBe(true);
    // add mode does not tear itself down on ok — the caller drives that.
    expect(addMode.isAddModeActive()).toBe(true);
  });

  test('cancel and ok buttons render lowercase labels per §3.4', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 200);
    expect(cancelBtn().textContent).toBe('cancel');
    expect(okBtn().textContent).toBe('ok');
  });

  // ── hide/show overlay UI (for Phase 5's capture pipeline) ────────────────

  test('hideOverlayUI hides the visuals container; showOverlayUI restores it and re-enables buttons', () => {
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 300, 200);

    textarea().value = 'note';
    textarea().dispatchEvent(new Event('input'));
    click(okBtn(), 0, 0); // disables ok/cancel, simulating a capture in flight

    addMode.hideOverlayUI();
    expect(shadowRoot().querySelector('.visuals')!.getAttribute('data-hidden')).toBe('true');

    addMode.showOverlayUI();
    expect(shadowRoot().querySelector('.visuals')!.getAttribute('data-hidden')).toBe('false');
    expect(okBtn().disabled).toBe(false); // note still present, so re-enabled
    expect(cancelBtn().disabled).toBe(false);
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
    setViewport(SIDEBAR_WIDTH + 260, 200); // barely wider than the sidebar + comment box
    addMode.startAddMode(makeCallbacks());
    place(blocker(), 10, 10);

    const comment = shadowRoot().querySelector('.comment-box') as HTMLElement;
    const left = parseFloat(comment.style.left);
    const top = parseFloat(comment.style.top);
    const bounds = { width: SIDEBAR_WIDTH + 260 - SIDEBAR_WIDTH, height: 200 };

    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(left).toBeLessThanOrEqual(Math.max(0, bounds.width));
    expect(top).toBeLessThanOrEqual(Math.max(0, bounds.height));
  });
});
