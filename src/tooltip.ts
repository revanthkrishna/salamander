// src/tooltip.ts
//
// The one tooltip every surface uses (design spec §AG), in place of the
// native `title` attribute. A native tooltip is drawn by the OS: it cannot be
// styled, cannot sit beside a menu, and cannot explain why a control is
// disabled, because a disabled control gets no hover at all. This one is ours,
// themed like the rest of the extension.
//
// Placed ABOVE its control by default (flipped below when there is no room).
//
// Declarative: a control carries its text in `data-tip`, and one set of
// delegated listeners per shadow root (attachTooltips) does the rest, so a
// label that changes with state is just an attribute write. `data-tip-reason`
// is the text shown instead while the control is soft-disabled
// (`aria-disabled="true"`): why it is off. `data-tip-side="left"` places the
// tooltip to the left, beside the nearest `[data-tip-edge]` ancestor if there
// is one (the "more options" menu, which sits against the window's right edge).
//
// Timing matches the native tooltips it replaces: about a second's hover
// before the first appears, none on keyboard focus, hidden on any press; and
// once one is showing, the next appears at once. A disabled reason is quicker
// (300ms) and also appears on keyboard focus, since it carries information the
// control's name does not.
//
// Pure DOM, no chrome.* — any surface may use it.

import { ACC, STD } from './flip';

/** Hover time before a tooltip appears — the native `title` tooltip's delay
 *  under macOS's default, which it replaces. */
export const TOOLTIP_DELAY_MS = 1000;
/** Hover time before a disabled control says why it is off. */
export const TOOLTIP_REASON_DELAY_MS = 300;
/** After one tooltip hides, another appears with no delay for this long. */
export const TOOLTIP_WARM_MS = 500;
/** Gap between a tooltip and its control, and its minimum distance from the
 *  window's edges. */
const GAP_PX = 8;
const EDGE_PX = 8;
/** A control taller than this is a strip (the resize handle): its tooltip
 *  sits level with the pointer rather than with the strip's middle. */
const TALL_PX = 100;

export const TOOLTIP_CSS = `
  .sal-tip {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 2147483647;
    max-width: 260px;
    padding: 6px 9px;
    background: var(--sal-raised);
    border: 1px solid var(--sal-line-strong);
    border-radius: var(--sal-radius-sm);
    box-shadow: var(--sal-shadow-pop);
    color: var(--sal-text);
    font-family: var(--sal-font-body);
    font-size: 12px;
    font-weight: 500;
    line-height: 1.3;
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    visibility: hidden;
    transition: opacity 90ms ${ACC.css}, visibility 0s linear 90ms;
  }
  .sal-tip[data-open="true"] {
    opacity: 1;
    visibility: visible;
    transition: opacity 120ms ${STD.css}, visibility 0s;
  }
  /* The pointer: a small square turned 45deg, bordered on the two sides
     that face outwards so it reads as part of the tooltip's outline. */
  .sal-tip::after {
    content: '';
    position: absolute;
    width: 7px;
    height: 7px;
    background: var(--sal-raised);
    border: 1px solid var(--sal-line-strong);
    transform: rotate(45deg);
  }
  .sal-tip[data-side="below"]::after {
    top: -5px;
    left: calc(var(--tip-arrow, 50%) - 4.5px);
    border-right: none;
    border-bottom: none;
  }
  .sal-tip[data-side="above"]::after {
    bottom: -5px;
    left: calc(var(--tip-arrow, 50%) - 4.5px);
    border-left: none;
    border-top: none;
  }
  .sal-tip[data-side="left"]::after {
    right: -5px;
    top: calc(var(--tip-arrow, 50%) - 4.5px);
    border-left: none;
    border-bottom: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .sal-tip,
    .sal-tip[data-open="true"] { transition: none; }
  }
`;

export interface TooltipHandle {
  /** Hide whatever is showing now (a control's state changed under it). */
  hide: () => void;
  /** Remove the tooltip and every listener. */
  destroy: () => void;
}

type Side = 'below' | 'above' | 'left';

function isReason(el: HTMLElement): boolean {
  return el.getAttribute('aria-disabled') === 'true' && !!el.dataset.tipReason;
}

function textFor(el: HTMLElement): string | undefined {
  return isReason(el) ? el.dataset.tipReason : el.dataset.tip;
}

function tipTarget(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  return node.closest<HTMLElement>('[data-tip], [data-tip-reason]');
}

let nextId = 0;

/**
 * Give one shadow root its tooltip. Every `[data-tip]` / `[data-tip-reason]`
 * inside it is covered, including controls added later.
 */
export function attachTooltips(root: ShadowRoot): TooltipHandle {
  const tip = document.createElement('div');
  tip.className = 'sal-tip';
  tip.id = `sal-tip-${++nextId}`;
  tip.setAttribute('role', 'tooltip');
  tip.dataset.open = 'false';
  root.appendChild(tip);

  let anchor: HTMLElement | null = null;
  let pending: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let hiddenAt = -Infinity;
  let pointerY: number | null = null;

  const isOpen = (): boolean => tip.dataset.open === 'true';
  const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = null;
  }

  function schedule(el: HTMLElement): void {
    if (el === anchor && isOpen()) return;
    clearTimer();
    if (!textFor(el)) return;
    const warm = isOpen() || now() - hiddenAt < TOOLTIP_WARM_MS;
    const delay = warm ? 0 : isReason(el) ? TOOLTIP_REASON_DELAY_MS : TOOLTIP_DELAY_MS;
    pending = el;
    timer = setTimeout(() => show(el), delay);
  }

  function show(el: HTMLElement): void {
    clearTimer();
    const text = textFor(el);
    if (!text || !el.isConnected) return;
    if (anchor && anchor !== el) anchor.removeAttribute('aria-describedby');
    anchor = el;
    tip.textContent = text;
    // A reason says something the control's name does not, so it is also
    // announced; a plain tooltip repeats the name and is not.
    if (isReason(el)) el.setAttribute('aria-describedby', tip.id);
    place(el);
    tip.dataset.open = 'true';
  }

  function hide(): void {
    clearTimer();
    if (!isOpen()) return;
    tip.dataset.open = 'false';
    hiddenAt = now();
    anchor?.removeAttribute('aria-describedby');
    anchor = null;
  }

  function place(el: HTMLElement): void {
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let side: Side = el.dataset.tipSide === 'left' ? 'left' : 'above';
    let x: number;
    let y: number;
    let arrow: number | null = null;

    if (side === 'left') {
      const edge = el.closest<HTMLElement>('[data-tip-edge]')?.getBoundingClientRect() ?? r;
      const cy = r.height > TALL_PX && pointerY !== null ? pointerY : r.top + r.height / 2;
      x = edge.left - GAP_PX - w;
      y = Math.min(Math.max(cy - h / 2, EDGE_PX), vh - h - EDGE_PX);
      arrow = cy - y;
      // No room on the left: fall back to above.
      if (x < EDGE_PX) side = 'above';
    }
    if (side !== 'left') {
      const cx = r.left + r.width / 2;
      x = Math.min(Math.max(cx - w / 2, EDGE_PX), vw - w - EDGE_PX);
      y = r.top - GAP_PX - h;
      side = 'above';
      // No room above (a control at the top of the window): flip below.
      if (y < EDGE_PX) {
        y = r.bottom + GAP_PX;
        side = 'below';
      }
      arrow = cx - x;
    }
    tip.dataset.side = side;
    tip.style.transform = `translate(${Math.round(x!)}px, ${Math.round(y!)}px)`;
    if (arrow !== null) tip.style.setProperty('--tip-arrow', `${arrow}px`);
  }

  const onOver = (e: Event): void => {
    const el = tipTarget(e.target);
    if (el) schedule(el);
  };
  const onOut = (e: Event): void => {
    const from = tipTarget(e.target);
    if (!from) return;
    const to = (e as MouseEvent).relatedTarget;
    if (to instanceof Node && from.contains(to)) return;
    if (from === anchor || from === pending) hide();
  };
  const onMove = (e: Event): void => {
    pointerY = (e as MouseEvent).clientY;
  };
  // Any press hides it, as a native tooltip does.
  const onDown = (): void => hide();
  const onFocusIn = (e: Event): void => {
    const el = tipTarget(e.target);
    if (el && isReason(el)) show(el);
  };
  const onFocusOut = (e: Event): void => {
    const el = tipTarget(e.target);
    if (el && el === anchor) hide();
  };
  const onKey = (e: Event): void => {
    if ((e as KeyboardEvent).key === 'Escape') hide();
  };
  const onScroll = (): void => hide();

  root.addEventListener('pointerover', onOver);
  root.addEventListener('pointerout', onOut);
  root.addEventListener('pointermove', onMove);
  root.addEventListener('pointerdown', onDown, true);
  root.addEventListener('focusin', onFocusIn);
  root.addEventListener('focusout', onFocusOut);
  root.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScroll, true);

  return {
    hide,
    destroy: () => {
      hide();
      root.removeEventListener('pointerover', onOver);
      root.removeEventListener('pointerout', onOut);
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerdown', onDown, true);
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
      root.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      tip.remove();
    },
  };
}
