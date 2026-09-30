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
// before the first appears, none on keyboard focus, hidden on any press, on
// Esc and on any scroll; and once one is showing, the next appears at once.
// It also hides when the control it points at goes away under it: removed,
// hidden, made inert, or given different text. A disabled reason is quicker
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
  /** Hide whatever is showing now (a control's state changed under it).
   *  `immediate` skips the fade-out — and cuts short one already under way —
   *  for a caller about to take a screenshot, which the fading tooltip would
   *  otherwise still be in. The next show fades in as usual. */
  hide: (opts?: { immediate?: boolean }) => void;
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

  // While a tooltip is up, watch for its control going away under it — the
  // list repainting under a hovered delete, a peek card retiring (its
  // data-tip is deleted, then the card is removed), the panel closing or
  // going inert behind the enlarged view — none of which moves the pointer,
  // so nothing else would hide it. Observed only while open; `style` is not
  // in the filter, so the per-frame style writes of the motion code never
  // wake it. jsdom and every supported browser have MutationObserver; the
  // guard only keeps a stripped-down environment from throwing.
  const observer =
    typeof MutationObserver === 'function'
      ? new MutationObserver(() => {
          if (!anchor || !isOpen()) return;
          if (!anchor.isConnected || anchor.closest('[hidden], [inert]') || textFor(anchor) !== tip.textContent) {
            hide();
          }
        })
      : null;
  const OBSERVED: MutationObserverInit = {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['hidden', 'inert', 'data-tip', 'data-tip-reason', 'aria-disabled'],
  };
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
    // Our own writes below (the text) are not a reason to hide.
    observer?.disconnect();
    if (anchor && anchor !== el) anchor.removeAttribute('aria-describedby');
    anchor = el;
    tip.textContent = text;
    // A reason says something the control's name does not, so it is also
    // announced; a plain tooltip repeats the name and is not.
    if (isReason(el)) el.setAttribute('aria-describedby', tip.id);
    place(el);
    // An immediate hide left the transition off; fade in as usual.
    tip.style.transition = '';
    tip.dataset.open = 'true';
    observer?.observe(root, OBSERVED);
  }

  function hide(opts: { immediate?: boolean } = {}): void {
    clearTimer();
    // Set even when already closed: a press hides with the usual fade, and a
    // screenshot taken right after must not catch its tail.
    if (opts.immediate) tip.style.transition = 'none';
    if (!isOpen()) return;
    observer?.disconnect();
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
  // Esc, pressed anywhere in this root. Listened for on `window` in the
  // capture phase, not on the root: the enlarged view (enlargedView.ts) and
  // add mode's comment box (addMode.ts) install keyboard isolation
  // (keyboardIsolation.ts), which stops every key inside the host with
  // stopImmediatePropagation() at window capture — so a listener on the
  // root, or one on window registered AFTER the isolation, never hears it.
  // Window capture listeners run in registration order, so this relies on
  // attachTooltips() running before any isolation on the same host is
  // installed. It does for every caller: sidebar.ts attaches in
  // initSidebar(), and the enlarged view only ever opens inside an
  // initialised sidebar (and is destroyed before it); addMode.ts attaches in
  // buildDOM(), and installs its isolation later, in buildCommentDOM(). A
  // new caller must keep that order. The path check keeps an Esc meant for
  // the page from touching our tooltip, as the root listener did; the
  // closed root's host is on the path even though its inside is not.
  const onKey = (e: Event): void => {
    if ((e as KeyboardEvent).key !== 'Escape') return;
    if (!e.composedPath().includes(root.host)) return;
    hide();
  };
  // Any scroll. `scroll` does not bubble and is not composed: the window
  // listener hears the page's scrollers (capture reaches every target in
  // the document) but nothing scrolled inside this shadow root — the note
  // list, the enlarged view's note — so the root listens too.
  const onScroll = (): void => hide();

  root.addEventListener('pointerover', onOver);
  root.addEventListener('pointerout', onOut);
  root.addEventListener('pointermove', onMove);
  root.addEventListener('pointerdown', onDown, true);
  root.addEventListener('focusin', onFocusIn);
  root.addEventListener('focusout', onFocusOut);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScroll, true);
  root.addEventListener('scroll', onScroll, true);

  return {
    hide,
    destroy: () => {
      hide();
      observer?.disconnect();
      root.removeEventListener('pointerover', onOver);
      root.removeEventListener('pointerout', onOut);
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerdown', onDown, true);
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      root.removeEventListener('scroll', onScroll, true);
      tip.remove();
    },
  };
}
