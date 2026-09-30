// The shared tooltip (design spec §AG): timing that matches the native
// `title` tooltips it replaced, disabled reasons, and placement.

import {
  attachTooltips,
  TooltipHandle,
  TOOLTIP_DELAY_MS,
  TOOLTIP_REASON_DELAY_MS,
  TOOLTIP_WARM_MS,
} from '../tooltip';

let root: ShadowRoot;
let handle: TooltipHandle;

function button(tip: string, extra: Record<string, string> = {}): HTMLButtonElement {
  const b = document.createElement('button');
  b.dataset.tip = tip;
  for (const [k, v] of Object.entries(extra)) b.setAttribute(k, v);
  root.appendChild(b);
  return b;
}
function tip(): HTMLElement {
  return root.querySelector('.sal-tip') as HTMLElement;
}
function isShown(): boolean {
  return tip().dataset.open === 'true';
}
function over(el: Element): void {
  el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, composed: true }));
}
function out(el: Element, to: Element | null = null): void {
  el.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, composed: true, relatedTarget: to }));
}

beforeEach(() => {
  jest.useFakeTimers();
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = host.attachShadow({ mode: 'open' });
  handle = attachTooltips(root);
});

afterEach(() => {
  handle.destroy();
  document.body.innerHTML = '';
  jest.useRealTimers();
});

describe('shared tooltip (design spec §AG)', () => {
  test('one role="tooltip" element per root, closed at rest', () => {
    expect(root.querySelectorAll('.sal-tip')).toHaveLength(1);
    expect(tip().getAttribute('role')).toBe('tooltip');
    expect(isShown()).toBe(false);
  });

  test('appears after the native delay, not before, with the control\'s text', () => {
    const b = button('export feedback');
    over(b);
    jest.advanceTimersByTime(TOOLTIP_DELAY_MS - 1);
    expect(isShown()).toBe(false);
    jest.advanceTimersByTime(1);
    expect(isShown()).toBe(true);
    expect(tip().textContent).toBe('export feedback');
  });

  test('leaving before the delay shows nothing; leaving after hides it', () => {
    const b = button('close sidebar');
    over(b);
    jest.advanceTimersByTime(TOOLTIP_DELAY_MS / 2);
    out(b);
    jest.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(isShown()).toBe(false);

    over(b);
    jest.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(isShown()).toBe(true);
    out(b);
    expect(isShown()).toBe(false);
  });

  test('moving within the control (onto its icon) does not hide it', () => {
    const b = button('add note');
    const icon = document.createElement('span');
    b.appendChild(icon);
    over(b);
    jest.advanceTimersByTime(TOOLTIP_DELAY_MS);
    out(b, icon);
    expect(isShown()).toBe(true);
  });

  test('once one is up, the next appears at once — and shortly after one hides, too', () => {
    const a = button('export feedback');
    const b = button('more options');
    over(a);
    jest.advanceTimersByTime(TOOLTIP_DELAY_MS);
    out(a, b);
    over(b);
    jest.advanceTimersByTime(0);
    expect(isShown()).toBe(true);
    expect(tip().textContent).toBe('more options');

    out(b);
    jest.advanceTimersByTime(TOOLTIP_WARM_MS - 50);
    over(a);
    jest.advanceTimersByTime(0);
    expect(tip().textContent).toBe('export feedback');
    expect(isShown()).toBe(true);

    // Long after, it is cold again.
    out(a);
    jest.advanceTimersByTime(TOOLTIP_WARM_MS + 50);
    over(b);
    jest.advanceTimersByTime(0);
    expect(isShown()).toBe(false);
  });

  test('any press hides it, as a native tooltip does', () => {
    const b = button('add note');
    over(b);
    jest.advanceTimersByTime(TOOLTIP_DELAY_MS);
    b.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, composed: true }));
    expect(isShown()).toBe(false);
  });

  test('a plain tooltip does not appear on keyboard focus (neither did the native one)', () => {
    const b = button('add note');
    b.focus();
    jest.advanceTimersByTime(TOOLTIP_DELAY_MS * 2);
    expect(isShown()).toBe(false);
  });

  test('a disabled reason: quicker on hover, at once on focus, and announced', () => {
    const b = button('export feedback', { 'aria-disabled': 'true', 'data-tip-reason': 'nothing to export' });
    over(b);
    jest.advanceTimersByTime(TOOLTIP_REASON_DELAY_MS);
    expect(isShown()).toBe(true);
    expect(tip().textContent).toBe('nothing to export');
    expect(b.getAttribute('aria-describedby')).toBe(tip().id);
    out(b);
    expect(b.hasAttribute('aria-describedby')).toBe(false);

    b.focus();
    expect(isShown()).toBe(true);
    b.blur();
    expect(isShown()).toBe(false);
  });

  test('enabled again, the same control shows its ordinary tooltip', () => {
    const b = button('export feedback', { 'data-tip-reason': 'nothing to export' });
    over(b);
    jest.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(tip().textContent).toBe('export feedback');
    expect(b.hasAttribute('aria-describedby')).toBe(false);
  });

  function placeAt(el: Element, top: number, left = 400): void {
    el.getBoundingClientRect = () =>
      ({ top, left, bottom: top + 32, right: left + 38, width: 38, height: 32, x: left, y: top, toJSON() {} }) as DOMRect;
  }

  test('sits ABOVE its control by default', () => {
    const b = button('export feedback');
    placeAt(b, 300);
    over(b);
    jest.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(tip().dataset.side).toBe('above');
  });

  test('flips below a control at the very top of the window, where there is no room above', () => {
    const b = button('close sidebar');
    placeAt(b, 0);
    over(b);
    jest.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(tip().dataset.side).toBe('below');
  });

  test('side "left" places it to the left; without room there it falls back', () => {
    const b = button('exit enlarged view (esc)', { 'data-tip-side': 'left' });
    placeAt(b, 300, 600);
    over(b);
    jest.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(tip().dataset.side).toBe('left');
    handle.hide();

    const edge = button('next note', { 'data-tip-side': 'left' });
    placeAt(edge, 300, 0);
    over(edge);
    jest.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(tip().dataset.side).not.toBe('left');
  });

  test('hide() and destroy() clean up', () => {
    const b = button('add note');
    over(b);
    jest.advanceTimersByTime(TOOLTIP_DELAY_MS);
    handle.hide();
    expect(isShown()).toBe(false);
    handle.destroy();
    expect(root.querySelector('.sal-tip')).toBeNull();
    over(b);
    jest.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(root.querySelector('.sal-tip')).toBeNull();
    handle = attachTooltips(root); // for afterEach
  });
});
