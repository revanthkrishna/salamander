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

function mouseup(): void {
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
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

    click(blocker(), 300, 200);

    expect(commentBoxEl()).not.toBeNull();
    expect(textarea()).not.toBeNull();
    expect(okBtn()).not.toBeNull();
    expect(cancelBtn()).not.toBeNull();
  });

  // ── regression: bug 2 — comment box clicks must not be swallowed ──────────

  test('the comment box opts back into pointer-events so its clicks are not swallowed by the pointer-events:none host', () => {
    addMode.startAddMode(makeCallbacks());
    click(blocker(), 300, 200); // build the comment box

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
    click(blocker(), 100, 100); // place the box first so the comment box exists
    click(cancelBtn(), 0, 0);

    expect(cbs.calls.cancel).toBe(1);
    expect(cbs.calls.ok).toHaveLength(0);
    expect(addMode.isAddModeActive()).toBe(false);
    expect(getHost()).toBeNull();
  });

  // ── placement (first click) ───────────────────────────────────────────────

  test('first click places a default 200x150 box anchored at the click point', () => {
    addMode.startAddMode(makeCallbacks());
    click(blocker(), 300, 200);

    const box = addMode._boxForTests();
    expect(box).toEqual({ x: 300, y: 200, width: 200, height: 150 });
    expect(boxEl().style.left).toBe('300px');
    expect(boxEl().style.top).toBe('200px');
    expect(boxEl().style.width).toBe('200px');
    expect(boxEl().style.height).toBe('150px');
  });

  test('placement clamps the default box to stay within the viewport bounds (minus sidebar width)', () => {
    addMode.startAddMode(makeCallbacks());
    const bounds = { width: 1200 - SIDEBAR_WIDTH, height: 800 };
    // click near the bottom-right corner of the selectable area
    click(blocker(), bounds.width - 5, bounds.height - 5);

    const box = addMode._boxForTests();
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.width);
    expect(box.y + box.height).toBeLessThanOrEqual(bounds.height);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
  });

  test('a second click after placement (outside box/comment) does nothing', () => {
    addMode.startAddMode(makeCallbacks());
    click(blocker(), 300, 200);
    const before = addMode._boxForTests();

    click(blocker(), 700, 600);
    expect(addMode._boxForTests()).toEqual(before);
    expect(addMode.isAddModeActive()).toBe(true);
  });

  // ── resize handles ─────────────────────────────────────────────────────────

  test('renders all 8 resize handles once placed', () => {
    addMode.startAddMode(makeCallbacks());
    click(blocker(), 300, 200);
    const handles = shadowRoot().querySelectorAll('.handle');
    expect(handles).toHaveLength(8);
  });

  test('dragging the se handle grows the box to the new bottom-right corner', () => {
    addMode.startAddMode(makeCallbacks());
    click(blocker(), 100, 100); // box: x100 y100 w200 h150 -> right 300 bottom 250

    mousedown(handle('se'), 300, 250);
    mousemove(400, 350);
    mouseup();

    const box = addMode._boxForTests();
    expect(box).toEqual({ x: 100, y: 100, width: 300, height: 250 });
  });

  test('dragging the nw handle moves the top-left corner and keeps the opposite corner fixed', () => {
    addMode.startAddMode(makeCallbacks());
    click(blocker(), 300, 300); // box: x300 y300 w200 h150 -> right 500 bottom 450

    mousedown(handle('nw'), 300, 300);
    mousemove(250, 260);
    mouseup();

    const box = addMode._boxForTests();
    expect(box.x).toBe(250);
    expect(box.y).toBe(260);
    expect(box.x + box.width).toBe(500);
    expect(box.y + box.height).toBe(450);
  });

  test('resize enforces the 20x20 minimum size', () => {
    addMode.startAddMode(makeCallbacks());
    click(blocker(), 300, 300); // right edge at 500

    mousedown(handle('w'), 300, 300);
    mousemove(490, 300); // try to shrink width to 10px
    mouseup();

    const box = addMode._boxForTests();
    expect(box.width).toBeGreaterThanOrEqual(20);
  });

  test('resize clamps to the viewport bounds', () => {
    addMode.startAddMode(makeCallbacks());
    const bounds = { width: 1200 - SIDEBAR_WIDTH, height: 800 };
    click(blocker(), 300, 300);

    mousedown(handle('e'), 500, 300);
    mousemove(bounds.width + 500, 300); // drag far past the right edge
    mouseup();

    const box = addMode._boxForTests();
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.width);
  });

  // ── comment box ────────────────────────────────────────────────────────────

  test('ok is disabled while the textarea is empty, enabled once text is entered', () => {
    addMode.startAddMode(makeCallbacks());
    click(blocker(), 300, 200);
    expect(okBtn().disabled).toBe(true);

    textarea().value = 'looks broken here';
    textarea().dispatchEvent(new Event('input'));
    expect(okBtn().disabled).toBe(false);
  });

  test('ok stays disabled for whitespace-only text', () => {
    addMode.startAddMode(makeCallbacks());
    click(blocker(), 300, 200);

    textarea().value = '   ';
    textarea().dispatchEvent(new Event('input'));
    expect(okBtn().disabled).toBe(true);
  });

  test('placeholder text is lowercase per §3.4', () => {
    addMode.startAddMode(makeCallbacks());
    click(blocker(), 300, 200);
    expect(textarea().placeholder).toBe('type something...');
  });

  test('counter is hidden below 900 characters, visible at 900+, flagged danger at 980+', () => {
    addMode.startAddMode(makeCallbacks());
    click(blocker(), 300, 200);

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
    click(blocker(), 300, 200);
    expect(textarea().maxLength).toBe(1000);
  });

  test('ok click fires onOk with the selection rect and trimmed note, and disables both buttons', () => {
    const cbs = makeCallbacks();
    addMode.startAddMode(cbs);
    click(blocker(), 300, 200);

    textarea().value = '  spacing is off here  ';
    textarea().dispatchEvent(new Event('input'));
    click(okBtn(), 0, 0);

    expect(cbs.calls.ok).toHaveLength(1);
    expect(cbs.calls.ok[0].note).toBe('spacing is off here');
    expect(cbs.calls.ok[0].rect).toEqual({ x: 300, y: 200, width: 200, height: 150 });
    expect(okBtn().disabled).toBe(true);
    expect(cancelBtn().disabled).toBe(true);
    // add mode does not tear itself down on ok — the caller drives that.
    expect(addMode.isAddModeActive()).toBe(true);
  });

  test('cancel and ok buttons render lowercase labels per §3.4', () => {
    addMode.startAddMode(makeCallbacks());
    click(blocker(), 300, 200);
    expect(cancelBtn().textContent).toBe('cancel');
    expect(okBtn().textContent).toBe('ok');
  });

  // ── hide/show overlay UI (for Phase 5's capture pipeline) ────────────────

  test('hideOverlayUI hides the visuals container; showOverlayUI restores it and re-enables buttons', () => {
    addMode.startAddMode(makeCallbacks());
    click(blocker(), 300, 200);

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

  // ── never-off-screen comment box ──────────────────────────────────────────

  test('comment box position is always clamped within the viewport bounds, even in a tiny viewport', () => {
    setViewport(SIDEBAR_WIDTH + 260, 200); // barely wider than the sidebar + comment box
    addMode.startAddMode(makeCallbacks());
    click(blocker(), 10, 10);

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
