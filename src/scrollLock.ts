// src/scrollLock.ts
// The host page does not scroll while the enlarged view is open (design spec
// v5 §T): the wheel, touch scrolling and the scrolling keys are cancelled at
// the event level unless something inside the view itself can take them —
// the view's own scroller and its text areas. Split out of enlargedView.ts,
// which takes the lock in open() and drops it on its single teardown path.

import { keyTargetWithin, pointTargetWithin } from './dom';

/** The direction each scrolling key travels, as a (dx, dy) sign pair. Space
 *  is in the list twice over — it pages down, and shift+space pages up. */
const SCROLL_KEYS: Record<string, { dx: number; dy: number }> = {
  ' ': { dx: 0, dy: 1 },
  Spacebar: { dx: 0, dy: 1 }, // legacy key name, still emitted by some IMEs/remotes
  PageUp: { dx: 0, dy: -1 },
  PageDown: { dx: 0, dy: 1 },
  Home: { dx: 0, dy: -1 },
  End: { dx: 0, dy: 1 },
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
};

export interface ScrollLockHandle {
  release: () => void;
}

function computedStyleOf(el: Element): CSSStyleDeclaration | null {
  try {
    return window.getComputedStyle(el);
  } catch {
    return null;
  }
}

function scrollableOverflow(value: string | undefined): boolean {
  return value === 'auto' || value === 'scroll' || value === 'overlay';
}

/**
 * Can `el` itself take this scroll — is it an overflow container AND does it
 * still have room to move in the direction of travel?
 *
 * The "room left" half is what makes overscroll chaining stop at our own
 * edge: a textarea scrolled to its last line has no room, so the wheel is
 * cancelled rather than handed on to the page underneath.
 *
 * `dx`/`dy` are signs (or a wheel's raw deltas); 0/0 means "either axis,
 * either direction", which is all a touchmove can tell us.
 */
export function elementCanScroll(el: Element, dx: number, dy: number): boolean {
  const anyDir = dx === 0 && dy === 0;
  // The cheap rejection first — most elements in the path have no overflow
  // at all, and this runs on every wheel event.
  const roomY = el.scrollHeight - el.clientHeight;
  const roomX = el.scrollWidth - el.clientWidth;
  if (roomY <= 1 && roomX <= 1) return false;
  const style = computedStyleOf(el);
  // A <textarea> scrolls by UA default (and jsdom reports no computed
  // overflow at all), so it counts whatever the cascade says.
  const isTextarea = el instanceof HTMLTextAreaElement;

  if (roomY > 1 && (dy !== 0 || anyDir) && (isTextarea || scrollableOverflow(style?.overflowY))) {
    if (anyDir) return true;
    if (dy < 0 ? el.scrollTop > 0 : el.scrollTop < roomY - 1) return true;
  }
  if (roomX > 1 && (dx !== 0 || anyDir) && (isTextarea || scrollableOverflow(style?.overflowX))) {
    if (anyDir) return true;
    if (dx < 0 ? el.scrollLeft > 0 : el.scrollLeft < roomX - 1) return true;
  }
  return false;
}

/** Text entry of any kind — typing a space, or moving the caret with the
 *  arrow/home/end keys, must never be cancelled. These consume the key
 *  themselves, so letting them through can't scroll anything either. */
function isTextEntry(target: EventTarget | undefined): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) return true;
  return target instanceof HTMLElement && target.isContentEditable;
}

/**
 * Stops the host page scrolling under the enlarged view, at the EVENT level
 * (design spec v5 §T): capture-phase `wheel` / `touchmove` with
 * `{ passive: false }` plus the scrolling keys, cancelled unless something
 * in OUR OWN UI can actually consume the scroll.
 *
 * Deliberately NOT `overflow: hidden` on the host's documentElement/body.
 * On a page with a classic scrollbar that hands the scrollbar's width back
 * to the content, which changes the layout viewport — and this extension
 * reads that viewport twice over: content.ts shrinks the page by the docked
 * sidebar's width, and the FLIP morphs measure list-thumbnail rects in
 * viewport coordinates at the exact moment the view opens and closes. A
 * width change there is a visible jump in the middle of the morph. Nothing
 * here touches layout at all.
 *
 * The exemption is "this event can really be consumed", NOT "this event is
 * somewhere inside our host". The two are not the same thing and the
 * difference is the whole feature: while the view is open the host covers
 * the ENTIRE viewport, because the scrim belongs to it — `elementFromPoint`
 * anywhere on screen returns the host. A path-contains-host test therefore
 * exempts every wheel and every key on the page and the lock blocks nothing
 * at all, while still cancelling a synthetic event dispatched on
 * `document.body` (whose path genuinely excludes the host) and so still
 * looking like it works.
 *
 * So: walk the composed path as far as the host and let the event through
 * only if an element BEFORE the host can take it — an overflow container
 * with room left in the direction of travel. In practice that is the view's
 * scroller (design spec §AH: the whole site is one scrolling page) and the
 * note text areas inside it. Stopping at the host also keeps a page that
 * sets `html { overflow: auto }` from qualifying as the scroller.
 */
export function lockPageScroll(hostEl: Element, root: ShadowRoot | null = null): ScrollLockHandle {
  /** The part of the composed path that belongs to our UI, innermost first,
   *  or null when the event never touched it.
   *
   *  The UI lives in a CLOSED shadow root, and these listeners sit on
   *  `window`, outside it. From there `composedPath()` is retargeted: it
   *  stops at the host and never shows the element inside that the event
   *  actually reached. Read naively, every key typed into the note textarea
   *  looks like a key pressed on the bare host — so Space, the arrows and
   *  Home/End were all cancelled as page scrolls, and the textarea could not
   *  take a space or move its caret. So when the path stops at the host,
   *  the inner target is recovered from the root itself: the focused element
   *  for a key (keys go where focus is), the element under the pointer for a
   *  wheel or a touch. An open root (the test harnesses force one) shows the
   *  full path and needs none of this. */
  function ownPath(e: Event): EventTarget[] | null {
    const path = e.composedPath();
    const host = path.indexOf(hostEl);
    if (host < 0) return null;
    if (host > 0) return path.slice(0, host);
    const inner = innerTarget(e);
    if (!inner) return [];
    const out: EventTarget[] = [];
    for (let n: Node | null = inner; n && n !== root; n = n.parentNode) out.push(n);
    return out;
  }

  /** Only reached when the path stops at the host (dom.ts's rule). */
  function innerTarget(e: Event): Element | null {
    if (!root) return null;
    const t = e instanceof KeyboardEvent ? keyTargetWithin(e, hostEl, root) : pointTargetWithin(e, hostEl, root);
    return t instanceof Element ? t : null;
  }

  function consumable(e: Event, dx: number, dy: number): boolean {
    const path = ownPath(e);
    if (!path) return false;
    for (const t of path) {
      if (t instanceof Element && elementCanScroll(t, dx, dy)) return true;
    }
    return false;
  }

  function cancel(e: Event): void {
    if (e.cancelable) e.preventDefault();
  }

  const onWheel = (e: Event): void => {
    const w = e as WheelEvent;
    if (!consumable(e, w.deltaX ?? 0, w.deltaY ?? 0)) cancel(e);
  };
  // A touchmove carries no delta, so "can this scroll at all, either way" is
  // as much as can be asked of it.
  const onTouchMove = (e: Event): void => {
    if (!consumable(e, 0, 0)) cancel(e);
  };
  const onKeydown = (e: KeyboardEvent): void => {
    const dir = SCROLL_KEYS[e.key];
    if (!dir) return;
    if (isTextEntry(ownPath(e)?.[0])) return;
    const dy = e.key === ' ' || e.key === 'Spacebar' ? (e.shiftKey ? -1 : 1) : dir.dy;
    if (!consumable(e, dir.dx, dy)) cancel(e);
  };

  // Capture phase, so a page that stops these events on its own document
  // never gets the chance to (the same guarantee keyboardIsolation.ts
  // relies on). `passive: false` is required: Chrome makes window-level
  // wheel/touchmove listeners passive by default, and a passive listener's
  // preventDefault() is ignored.
  const opts: AddEventListenerOptions = { capture: true, passive: false };
  window.addEventListener('wheel', onWheel, opts);
  window.addEventListener('touchmove', onTouchMove, opts);
  window.addEventListener('keydown', onKeydown, opts);

  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      window.removeEventListener('wheel', onWheel, opts);
      window.removeEventListener('touchmove', onTouchMove, opts);
      window.removeEventListener('keydown', onKeydown, opts);
    },
  };
}
