// Add mode's pencil (design spec §AB) — drawing on the placed selection:
// where the pencil works and where it does not, stroke capture (coalesced
// samples included), the strokes pinned to the page while the box is only
// their clip, undo that leaves the textarea's own undo alone, erase all and
// the pencil menu, the colour swatches, the drawing handed to onOk, and the
// drawing layer staying out of the screenshot.
//
// jsdom has no layout and no PointerEvent: pointer events are dispatched as
// MouseEvents with the pointer event's type, exactly as the listeners read
// them (clientX/clientY/button), and a coalesced-events test attaches its
// own getCoalescedEvents(). Real-pixel checks are the browser pass's job
// (BROWSER_TEST_CASES.md, "drawing on the selection").

import * as addMode from '../addMode';
import * as capture from '../capture';
import { getThemeCSS } from '../theme';
import { PENCIL_CURSOR } from '../icons';

const originalAttachShadow = HTMLElement.prototype.attachShadow;
beforeAll(() => {
  HTMLElement.prototype.attachShadow = function (init: ShadowRootInit) {
    return originalAttachShadow.call(this, { ...init, mode: 'open' });
  };
});
afterAll(() => {
  HTMLElement.prototype.attachShadow = originalAttachShadow;
});

const YELLOW = '#E8B600';
const BLACK = '#1A1712';
const RED = '#E5484D';

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
}

function host(): HTMLElement | null {
  return document.getElementById('annotator-addmode-host');
}
function root(): ShadowRoot {
  const h = host();
  if (!h || !h.shadowRoot) throw new Error('add-mode host not found');
  return h.shadowRoot;
}
const q = <T extends Element = HTMLElement>(sel: string): T | null => root().querySelector<T>(sel);
const blocker = () => q('.blocker')!;
const surface = () => q<HTMLDivElement>('.draw-surface');
const strokesSvg = () => q<SVGSVGElement>('.draw-strokes')!;
const paths = () => Array.from(root().querySelectorAll<SVGPathElement>('.draw-strokes path'));
const textarea = () => q<HTMLTextAreaElement>('.note-input')!;
const pencil = () => q<HTMLButtonElement>('.btn-pencil')!;
const menu = () => q<HTMLElement>('.draw-menu')!;
const eraseItem = () => q<HTMLButtonElement>('.draw-menu-item')!;
const swatches = () => Array.from(root().querySelectorAll<HTMLButtonElement>('.swatch'));
const saveBtn = () => q<HTMLButtonElement>('.btn-save')!;
const zone = (key: string) => q(`.resize-zone[data-zone="${key}"]`)!;
const menuOpen = () => menu().dataset.open === 'true';

function ownCSS(): string {
  return (root().querySelector('style')!.textContent ?? '').replace(getThemeCSS(), '');
}

function mouse(el: EventTarget, type: string, x: number, y: number): MouseEvent {
  const e = new MouseEvent(type, { bubbles: true, composed: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  el.dispatchEvent(e);
  return e;
}

/** Place a box by dragging from (x1,y1) to (x2,y2). */
function placeBox(x1: number, y1: number, x2: number, y2: number): void {
  mouse(blocker(), 'mousedown', x1, y1);
  mouse(document, 'mousemove', x2, y2);
  mouse(document, 'mouseup', x2, y2);
}

/** One stroke through `pts`: down on the surface at the first, moves to the
 *  rest, up at the last. */
function stroke(pts: [number, number][]): void {
  const [x0, y0] = pts[0];
  mouse(surface()!, 'pointerdown', x0, y0);
  for (const [x, y] of pts.slice(1)) mouse(document, 'pointermove', x, y);
  const [xl, yl] = pts[pts.length - 1];
  mouse(document, 'pointerup', xl, yl);
}

function key(target: Element, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, composed: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

function makeCallbacks() {
  return { onOk: jest.fn(), onCancel: jest.fn(), onPenColorChange: jest.fn() };
}

/** Add mode with a 200x100 box at (100, 100). */
function editing(cbs = makeCallbacks()) {
  addMode.startAddMode(cbs);
  placeBox(100, 100, 300, 200);
  expect(addMode._boxForTests()).toEqual({ x: 100, y: 100, width: 200, height: 100 });
  return cbs;
}

function typeNote(text: string): void {
  textarea().value = text;
  textarea().dispatchEvent(new Event('input'));
}

beforeEach(() => {
  setViewport(1200, 800);
});

afterEach(() => {
  addMode.exitAddMode();
  addMode._resetHintForTests();
  addMode._resetPenColorForTests();
});

// ---------------------------------------------------------------------------

describe('where the pencil works', () => {
  test('there is no drawing surface while placing — only once the box is placed', () => {
    addMode.startAddMode(makeCallbacks());
    expect(surface()).toBeNull();
    expect(q('.btn-pencil')).toBeNull();
    placeBox(100, 100, 300, 200);
    expect(surface()).not.toBeNull();
  });

  test('the surface is exactly the selection rect, with the pencil cursor', () => {
    editing();
    const s = surface()!;
    expect([s.style.left, s.style.top, s.style.width, s.style.height]).toEqual(['100px', '100px', '200px', '100px']);
    expect(ownCSS()).toContain(`cursor: ${PENCIL_CURSOR};`);
    // hotspot on the tip, and a system cursor to fall back on
    expect(PENCIL_CURSOR).toMatch(/^url\("data:image\/svg\+xml,[^"]+"\) 3 20, crosshair$/);
    expect(decodeURIComponent(PENCIL_CURSOR)).toMatch(/<svg[^>]*width="24" height="24"/);
  });

  test('the resize zones stay above the surface and keep their resize cursors', () => {
    editing();
    const kids = Array.from(root().querySelector('.visuals')!.children);
    const at = kids.indexOf(surface()!);
    for (const k of ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']) {
      expect(kids.indexOf(zone(k))).toBeGreaterThan(at); // later sibling wins the hit test
    }
    expect(zone('e').style.cursor).toBe('ew-resize');
    expect(zone('nw').style.cursor).toBe('nwse-resize');
  });

  test('an edge drag still resizes, and draws nothing', () => {
    editing();
    mouse(zone('e'), 'mousedown', 300, 150);
    mouse(document, 'mousemove', 400, 150);
    mouse(document, 'mouseup', 400, 150);
    expect(addMode._boxForTests()).toEqual({ x: 100, y: 100, width: 300, height: 100 });
    expect(addMode._strokesForTests()).toEqual([]);
  });

  test('mid-resize the interior shows the resize cursor, not the pencil', () => {
    editing();
    mouse(zone('e'), 'mousedown', 300, 150);
    expect(surface()!.style.cursor).toBe('ew-resize');
    mouse(document, 'mouseup', 300, 150);
    expect(surface()!.style.cursor).toBe('');
  });

  test('outside the rect nothing draws: the blocker is under the pointer there', () => {
    editing();
    mouse(blocker(), 'pointerdown', 20, 20);
    mouse(document, 'pointerup', 30, 30);
    expect(addMode._strokesForTests()).toEqual([]);
  });

  test('a press outside the box does not move focus off add mode', () => {
    editing();
    const e = mouse(blocker(), 'mousedown', 20, 20);
    expect(e.defaultPrevented).toBe(true);
  });
});

describe('the stroke', () => {
  test('pointer moves become a stroke in viewport px, drawn 2px, round, in yellow by default', () => {
    editing();
    stroke([[120, 120], [140, 130], [160, 150]]);
    expect(addMode._strokesForTests()).toEqual([{ color: YELLOW, points: [[120, 120], [140, 130], [160, 150]] }]);
    const [p] = paths();
    expect(p.getAttribute('d')).toBe('M120 120L140 130L160 150');
    expect(p.getAttribute('stroke')).toBe(YELLOW);
    expect(p.getAttribute('stroke-width')).toBe('2');
    expect(p.getAttribute('stroke-linecap')).toBe('round');
    expect(p.getAttribute('stroke-linejoin')).toBe('round');
    expect(p.getAttribute('fill')).toBe('none');
  });

  test('coalesced samples are all used, so a fast stroke stays smooth', () => {
    editing();
    mouse(surface()!, 'pointerdown', 110, 110);
    const move = new MouseEvent('pointermove', { bubbles: true, clientX: 150, clientY: 150 });
    (move as any).getCoalescedEvents = () => [
      { clientX: 120, clientY: 120 },
      { clientX: 130, clientY: 125 },
      { clientX: 150, clientY: 150 },
    ];
    document.dispatchEvent(move);
    mouse(document, 'pointerup', 150, 150);
    expect(addMode._strokesForTests()[0].points).toEqual([[110, 110], [120, 120], [130, 125], [150, 150]]);
  });

  test('a tap leaves a dot', () => {
    editing();
    stroke([[150, 150]]);
    expect(addMode._strokesForTests()).toEqual([{ color: YELLOW, points: [[150, 150]] }]);
    expect(paths()[0].getAttribute('d')).toBe('M150 150L150 150');
  });

  test('near-duplicate samples are dropped', () => {
    editing();
    stroke([[120, 120], [120.2, 120.1], [130, 120]]);
    expect(addMode._strokesForTests()[0].points).toEqual([[120, 120], [130, 120]]);
  });

  test('starting a stroke moves focus off the textarea, onto the surface', () => {
    editing();
    textarea().focus();
    expect(root().activeElement).toBe(textarea());
    mouse(surface()!, 'pointerdown', 150, 150);
    expect(root().activeElement).toBe(surface());
    mouse(document, 'pointerup', 150, 150);
    // the surface is focusable but never a Tab stop
    expect(surface()!.tabIndex).toBe(-1);
  });

  test('a stroke that leaves the rect keeps recording: the clip hides that part', () => {
    editing();
    stroke([[250, 150], [350, 150]]);
    expect(addMode._strokesForTests()[0].points).toEqual([[250, 150], [350, 150]]);
    expect(ownCSS()).toMatch(/\.draw-surface \{[^}]*overflow: hidden/);
  });
});

describe('resizing after drawing: strokes pinned to the page', () => {
  test('the stroke layer is offset by the box, so the strokes sit in viewport coordinates', () => {
    editing();
    expect(strokesSvg().style.left).toBe('-100px');
    expect(strokesSvg().style.top).toBe('-100px');
    // the whole selectable area (the viewport less the sidebar's strip)
    expect(`${strokesSvg().getAttribute('width')}px`).toBe(host()!.style.width);
    expect(`${strokesSvg().getAttribute('height')}px`).toBe(host()!.style.height);
  });

  test('a resize moves the clip, never the strokes', () => {
    editing();
    stroke([[120, 120], [180, 180]]);
    const before = paths()[0].getAttribute('d');

    // grow from the left edge: the surface moves, the layer counter-moves
    mouse(zone('w'), 'mousedown', 100, 150);
    mouse(document, 'mousemove', 50, 150);
    mouse(document, 'mouseup', 50, 150);

    expect(addMode._boxForTests()).toEqual({ x: 50, y: 100, width: 250, height: 100 });
    expect(surface()!.style.left).toBe('50px');
    expect(surface()!.style.width).toBe('250px');
    expect(strokesSvg().style.left).toBe('-50px');
    expect(paths()[0].getAttribute('d')).toBe(before);
    expect(addMode._strokesForTests()[0].points).toEqual([[120, 120], [180, 180]]);
  });

  test('shrinking crops the saved drawing; growing back reveals the rest again', () => {
    const cbs = editing();
    stroke([[120, 150], [280, 150]]);

    // shrink from the right to x = 200
    mouse(zone('e'), 'mousedown', 300, 150);
    mouse(document, 'mousemove', 200, 150);
    mouse(document, 'mouseup', 200, 150);
    // ...and back out to x = 300
    mouse(zone('e'), 'mousedown', 200, 150);
    mouse(document, 'mousemove', 300, 150);
    mouse(document, 'mouseup', 300, 150);

    typeNote('a note');
    saveBtn().click();
    expect(cbs.onOk.mock.calls[0][0].drawing).toEqual({
      width: 200,
      height: 100,
      strokes: [{ color: YELLOW, points: [[20, 50], [180, 50]] }],
    });
  });
});

describe('the drawing handed to onOk', () => {
  test('cropped to the final rect, in its own coordinates, with each stroke\'s colour', () => {
    const cbs = editing();
    stroke([[110, 110], [150, 150]]);
    q<HTMLButtonElement>(`.swatch[data-color="${RED}"]`)!.click();
    // runs out through the bottom edge (y = 200)
    stroke([[200, 150], [200, 250]]);
    typeNote('look here');
    saveBtn().click();

    const result = cbs.onOk.mock.calls[0][0];
    expect(result.rect).toEqual({ x: 100, y: 100, width: 200, height: 100 });
    expect(result.note).toBe('look here');
    expect(result.drawing).toEqual({
      width: 200,
      height: 100,
      strokes: [
        { color: YELLOW, points: [[10, 10], [50, 50]] },
        { color: RED, points: [[100, 50], [100, 100]] },
      ],
    });
  });

  test('no drawing key at all when nothing was drawn', () => {
    const cbs = editing();
    typeNote('a note');
    saveBtn().click();
    expect(cbs.onOk.mock.calls[0][0]).not.toHaveProperty('drawing');
  });

  test('no drawing key when everything drawn fell outside the final rect', () => {
    const cbs = editing();
    stroke([[280, 150], [295, 150]]);
    mouse(zone('e'), 'mousedown', 300, 150);
    mouse(document, 'mousemove', 250, 150);
    mouse(document, 'mouseup', 250, 150);
    typeNote('a note');
    saveBtn().click();
    expect(cbs.onOk.mock.calls[0][0]).not.toHaveProperty('drawing');
  });

  test('strokes alone count as work in progress (hasPendingComment)', () => {
    editing();
    expect(addMode.hasPendingComment()).toBe(false);
    stroke([[120, 120], [130, 130]]);
    expect(addMode.hasPendingComment()).toBe(true);
  });
});

describe('undo', () => {
  test('cmd+z and ctrl+z each take back the last stroke when focus is not in the textarea', () => {
    editing();
    stroke([[110, 110], [120, 120]]);
    stroke([[130, 130], [140, 140]]);
    stroke([[150, 150], [160, 160]]);
    expect(root().activeElement).toBe(surface());

    const e1 = key(surface()!, 'z', { metaKey: true });
    expect(e1.defaultPrevented).toBe(true);
    expect(addMode._strokesForTests()).toHaveLength(2);
    expect(paths()).toHaveLength(2);

    key(surface()!, 'Z', { ctrlKey: true });
    expect(addMode._strokesForTests().map((s) => s.points[0])).toEqual([[110, 110]]);
    expect(paths()).toHaveLength(1);
  });

  test('from the pencil or a swatch it undoes a stroke too', () => {
    editing();
    stroke([[110, 110], [120, 120]]);
    stroke([[130, 130], [140, 140]]);
    pencil().focus();
    key(pencil(), 'z', { metaKey: true });
    swatches()[0].focus();
    key(swatches()[0], 'z', { ctrlKey: true });
    expect(addMode._strokesForTests()).toEqual([]);
  });

  test('inside the textarea the keys keep undoing typed text: no stroke is touched, nothing is prevented', () => {
    editing();
    stroke([[110, 110], [120, 120]]);
    textarea().focus();
    const e = key(textarea(), 'z', { metaKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(addMode._strokesForTests()).toHaveLength(1);
  });

  test('shift+cmd+z (redo) is not an undo', () => {
    editing();
    stroke([[110, 110], [120, 120]]);
    key(surface()!, 'z', { metaKey: true, shiftKey: true });
    expect(addMode._strokesForTests()).toHaveLength(1);
  });

  test('the page never sees the keystroke: it stays inside the keyboard isolation', () => {
    editing();
    stroke([[110, 110], [120, 120]]);
    const pageListener = jest.fn();
    document.addEventListener('keydown', pageListener);
    key(surface()!, 'z', { metaKey: true });
    document.removeEventListener('keydown', pageListener);
    expect(pageListener).not.toHaveBeenCalled();
  });

  test('undo with nothing drawn is harmless', () => {
    editing();
    expect(() => key(surface()!, 'z', { metaKey: true })).not.toThrow();
    expect(addMode._strokesForTests()).toEqual([]);
  });
});

describe('the pencil menu and erase all', () => {
  test('the pencil is a 28px menu button labelled "drawing options"', () => {
    editing();
    expect(pencil().getAttribute('aria-label')).toBe('drawing options');
    expect(pencil().getAttribute('aria-haspopup')).toBe('menu');
    expect(pencil().getAttribute('aria-expanded')).toBe('false');
    expect(ownCSS()).toMatch(/\.btn-pencil \{[^}]*width: 28px;[^}]*height: 28px;/);
    expect(menu().getAttribute('role')).toBe('menu');
    expect(eraseItem().getAttribute('role')).toBe('menuitem');
    expect(eraseItem().textContent).toBe('erase all');
  });

  test('left of the swatches, in the bottom bar\'s left group', () => {
    editing();
    const tools = q('.footer > .draw-tools')!;
    expect(Array.from(tools.children).map((c) => c.className)).toEqual(['btn-pencil', 'swatches']);
  });

  test('it opens and closes the menu; erase all is disabled while nothing is drawn', () => {
    editing();
    pencil().click();
    expect(menuOpen()).toBe(true);
    expect(pencil().getAttribute('aria-expanded')).toBe('true');
    expect(eraseItem().disabled).toBe(true);
    pencil().click();
    expect(menuOpen()).toBe(false);

    stroke([[110, 110], [120, 120]]);
    expect(eraseItem().disabled).toBe(false);
  });

  test('erase all removes every stroke, closes the menu and hands focus back to the pencil', () => {
    editing();
    stroke([[110, 110], [120, 120]]);
    stroke([[130, 130], [140, 140]]);
    pencil().click();
    eraseItem().click();
    expect(addMode._strokesForTests()).toEqual([]);
    expect(paths()).toHaveLength(0);
    expect(menuOpen()).toBe(false);
    expect(root().activeElement).toBe(pencil());
    expect(eraseItem().disabled).toBe(true);
  });

  test('esc closes the menu and returns focus to the pencil (the key hook, and dismissDrawingMenu)', () => {
    editing();
    stroke([[110, 110], [120, 120]]);
    pencil().click();
    eraseItem().focus();
    key(eraseItem(), 'Escape');
    expect(menuOpen()).toBe(false);
    expect(root().activeElement).toBe(pencil());

    pencil().click();
    expect(addMode.dismissDrawingMenu()).toBe(true);
    expect(menuOpen()).toBe(false);
    expect(addMode.dismissDrawingMenu()).toBe(false); // nothing left to close
    expect(addMode.isAddModeActive()).toBe(true);
  });

  test('keyboard: arrow down on the pencil opens straight into the menu; tab closes it', () => {
    editing();
    stroke([[110, 110], [120, 120]]);
    pencil().focus();
    key(pencil(), 'ArrowDown');
    expect(menuOpen()).toBe(true);
    expect(root().activeElement).toBe(eraseItem());
    key(eraseItem(), 'Tab');
    expect(menuOpen()).toBe(false);
  });

  test('an outside press closes it; starting a stroke closes it', () => {
    editing();
    pencil().click();
    mouse(blocker(), 'pointerdown', 10, 10);
    expect(menuOpen()).toBe(false);

    pencil().click();
    mouse(surface()!, 'pointerdown', 150, 150);
    expect(menuOpen()).toBe(false);
    mouse(document, 'pointerup', 150, 150);
  });

  test('it opens below the comment box, or above the pencil when there is no room below', () => {
    editing();
    pencil().click();
    expect(menu().dataset.placement).toBe('below');
    pencil().click();

    q<HTMLElement>('.comment-box')!.style.top = '700px';
    pencil().click();
    expect(menu().dataset.placement).toBe('above');
  });

  test('the menu is the §C2 menu: fade/scale in 120ms, out 90ms, instant under reduced motion', () => {
    editing();
    const css = ownCSS();
    expect(css).toMatch(/\.draw-menu \{[^}]*opacity 90ms/);
    expect(css).toMatch(/\.draw-menu\[data-open="true"\] \{[^}]*opacity 120ms/);
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.draw-menu,\s*\.draw-menu\[data-open="true"\],?[^{]*\{\s*transition: none;/);
  });
});

describe('the colour swatches', () => {
  test('a radio group "pencil colour" of yellow, black, red — yellow checked by default', () => {
    editing();
    const group = q('.swatches')!;
    expect(group.getAttribute('role')).toBe('radiogroup');
    expect(group.getAttribute('aria-label')).toBe('pencil colour');
    expect(swatches().map((s) => [s.getAttribute('role'), s.getAttribute('aria-label'), s.dataset.color])).toEqual([
      ['radio', 'yellow', YELLOW],
      ['radio', 'black', BLACK],
      ['radio', 'red', RED],
    ]);
    expect(swatches().map((s) => s.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    // roving tabindex: only the checked one is a Tab stop
    expect(swatches().map((s) => s.tabIndex)).toEqual([0, -1, -1]);
  });

  test('every dot has a visible edge (the black one on a dark bar), and the checked one a ring', () => {
    editing();
    const css = ownCSS();
    expect(css).toMatch(/\.swatch-dot \{[^}]*box-shadow: 0 0 0 1px var\(--sal-line-strong\)/);
    expect(css).toMatch(/\.swatch\[aria-checked="true"\] \.swatch-dot[^{]*\{[^}]*0 0 0 3\.5px var\(--sal-text\)/);
    expect(q<HTMLElement>(`.swatch[data-color="${BLACK}"] .swatch-dot`)!.style.background).not.toBe('');
  });

  test('a click checks it, reports it once, and the next stroke uses it', () => {
    const cbs = editing();
    swatches()[2].click();
    expect(swatches().map((s) => s.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true']);
    expect(cbs.onPenColorChange).toHaveBeenCalledWith(RED);
    swatches()[2].click();
    expect(cbs.onPenColorChange).toHaveBeenCalledTimes(1); // no change, no news
    stroke([[110, 110], [120, 120]]);
    expect(addMode._strokesForTests()[0].color).toBe(RED);
    expect(paths()[0].getAttribute('stroke')).toBe(RED);
  });

  test('strokes keep the colour they were drawn in', () => {
    editing();
    stroke([[110, 110], [120, 120]]);
    swatches()[1].click();
    stroke([[130, 130], [140, 140]]);
    expect(addMode._strokesForTests().map((s) => s.color)).toEqual([YELLOW, BLACK]);
  });

  test('arrow keys move the checked colour with the focus, and wrap', () => {
    const cbs = editing();
    swatches()[0].focus();
    key(swatches()[0], 'ArrowRight');
    expect(root().activeElement).toBe(swatches()[1]);
    expect(addMode.getPenColor()).toBe(BLACK);
    key(swatches()[1], 'ArrowDown');
    expect(addMode.getPenColor()).toBe(RED);
    key(swatches()[2], 'ArrowRight');
    expect(addMode.getPenColor()).toBe(YELLOW);
    key(swatches()[0], 'ArrowLeft');
    expect(addMode.getPenColor()).toBe(RED);
    expect(root().activeElement).toBe(swatches()[2]);
    expect(cbs.onPenColorChange).toHaveBeenCalledTimes(4);
  });

  test('setPenColor restores a colour silently, and ignores anything off the palette', () => {
    const cbs = editing();
    addMode.setPenColor(BLACK);
    expect(swatches().map((s) => s.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    addMode.setPenColor('#FF0000');
    addMode.setPenColor(null);
    expect(addMode.getPenColor()).toBe(BLACK);
    expect(cbs.onPenColorChange).not.toHaveBeenCalled();
  });

  test('the colour carries into the next add-mode session on the page', () => {
    editing();
    swatches()[2].click();
    addMode.exitAddMode();
    editing();
    expect(swatches()[2].getAttribute('aria-checked')).toBe('true');
  });
});

describe('the bottom bar', () => {
  test('the counter sits on the right now, taking no room until it shows', () => {
    editing();
    const css = ownCSS();
    expect(css).toMatch(/\.counter:not\(\[data-warn="true"\]\) \{ display: none; \}/);
    expect(css).not.toMatch(/\.counter \{[^}]*margin-right: auto/);
    expect(css).toMatch(/\.draw-tools \{[^}]*margin-right: auto/);
  });

  test('every visible string and label is lowercase', () => {
    editing();
    const strings = [
      pencil().getAttribute('aria-label'),
      pencil().title,
      menu().getAttribute('aria-label'),
      eraseItem().textContent,
      q('.swatches')!.getAttribute('aria-label'),
      surface()!.getAttribute('aria-label'),
      ...swatches().flatMap((s) => [s.getAttribute('aria-label'), s.title]),
    ];
    for (const s of strings) expect(s).toBe(String(s).toLowerCase());
  });

  test('still one <style> in the root', () => {
    editing();
    expect(root().querySelectorAll('style')).toHaveLength(1);
  });
});

describe('the drawing never reaches the screenshot', () => {
  test('the surface and its strokes live inside .visuals, which hideOverlayUI hides', () => {
    editing();
    stroke([[110, 110], [120, 120]]);
    expect(root().querySelector('.visuals')!.contains(surface())).toBe(true);
    addMode.hideOverlayUI();
    expect(root().querySelector('.visuals')!.getAttribute('data-hidden')).toBe('true');
    // Nothing inside opts back into visibility while hidden.
    expect(ownCSS()).toMatch(
      /\.visuals\[data-hidden="true"\] \.counter,\s*\.visuals\[data-hidden="true"\] \.draw-menu \{ visibility: hidden; \}/,
    );
    expect(ownCSS()).not.toMatch(/\.draw-surface[^{]*\{[^}]*visibility: visible/);
  });

  test('from save until the capture settles nothing can be drawn, undone, erased or recoloured', () => {
    const cbs = editing();
    stroke([[110, 110], [120, 120]]);
    typeNote('a note');
    saveBtn().click();
    expect(cbs.onOk).toHaveBeenCalledTimes(1);

    mouse(surface()!, 'pointerdown', 150, 150);
    mouse(document, 'pointerup', 160, 160);
    key(surface()!, 'z', { metaKey: true });
    expect(addMode._strokesForTests()).toHaveLength(1);
    expect(pencil().disabled).toBe(true);
    expect(swatches().every((s) => s.disabled)).toBe(true);

    // a failed capture hands everything back
    addMode.showOverlayUI();
    expect(pencil().disabled).toBe(false);
    stroke([[150, 150], [160, 160]]);
    expect(addMode._strokesForTests()).toHaveLength(2);
  });

  test('end to end with the real pipeline: at the moment CAPTURE goes out, the drawing layer is hidden', async () => {
    const seenAtCapture: Array<string | null> = [];
    const saved: any[] = [];
    (global.chrome as any).runtime = {
      ...((global.chrome as any).runtime ?? {}),
      lastError: null,
      sendMessage: jest.fn((message: any, cb?: (r: unknown) => void) => {
        if (message.type === 'CAPTURE') {
          const visuals = root().querySelector('.visuals')!;
          seenAtCapture.push(visuals.contains(surface()) ? visuals.getAttribute('data-hidden') : 'outside');
          cb?.({ ok: true, screenshotKey: 'k', thumbnailDataUrl: 'data:image/jpeg;base64,AA' });
          return;
        }
        if (message.type === 'SAVE_ITEM') {
          saved.push(message.item);
          cb?.({ ok: true, item: { ...message.item, id: 1 } });
          return;
        }
        cb?.(undefined);
      }),
    };
    const raf = (global as any).requestAnimationFrame;
    (global as any).requestAnimationFrame = (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0);

    const outcome = new Promise((resolve) => {
      addMode.startAddMode({
        onOk: (result) => {
          void capture
            .captureAndSave(result, { hide: addMode.hideOverlayUI, show: addMode.showOverlayUI })
            .then(resolve);
        },
        onCancel: () => {},
      });
    });
    placeBox(100, 100, 300, 200);
    stroke([[110, 110], [150, 150]]);
    typeNote('a note');
    saveBtn().click();
    await outcome;
    (global as any).requestAnimationFrame = raf;

    expect(seenAtCapture).toEqual(['true']);
    expect(saved[0].drawing).toEqual({
      width: 200,
      height: 100,
      strokes: [{ color: YELLOW, points: [[10, 10], [50, 50]] }],
    });
  });

  test('exit throws the drawing away with the rest of the session', () => {
    editing();
    stroke([[110, 110], [120, 120]]);
    addMode.exitAddMode();
    editing();
    expect(addMode._strokesForTests()).toEqual([]);
    expect(paths()).toHaveLength(0);
  });
});
