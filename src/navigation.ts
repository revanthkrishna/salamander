// src/navigation.ts
// SPA navigation detection for the content script (§1.1, §1.5): a single-
// page app changes the URL without a page load, so the sidebar's list (one
// URL's notes) has to hear about it. history.pushState/replaceState are
// patched, popstate and hashchange listened for, and the bursts these come
// in (a router replacing state right after pushing it) debounced into one
// call. Moved out of content.ts unchanged, plus restore(): the page's own
// history methods back and the listeners gone, for the content script's
// teardown.

/** One call `delay` ms after the last of a burst; cancel() drops a pending
 *  one. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, delay: number): {
  (...args: A): void;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = (...args: A): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      fn(...args);
      timer = null;
    }, delay);
  };
  debounced.cancel = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return debounced;
}

export interface NavigationWatch {
  /** Stop watching: history's methods are put back (when nothing has
   *  patched them since — otherwise ours just stop reporting), the
   *  listeners removed and a pending call dropped. */
  restore: () => void;
}

/** Call `onChange` (debounced by `delay` ms) whenever the URL may have
 *  changed without a page load. It decides whether it really did. */
export function watchNavigation(onChange: () => void, delay = 50): NavigationWatch {
  const debouncedHandleUrlChange = debounce(onChange, delay);
  let watching = true;

  const nativePush = history.pushState;
  const origPush = nativePush.bind(history);
  const patchedPush = function (...args: Parameters<typeof history.pushState>) {
    origPush(...args);
    if (watching) debouncedHandleUrlChange();
  };
  history.pushState = patchedPush;

  const nativeReplace = history.replaceState;
  const origReplace = nativeReplace.bind(history);
  const patchedReplace = function (...args: Parameters<typeof history.replaceState>) {
    origReplace(...args);
    if (watching) debouncedHandleUrlChange();
  };
  history.replaceState = patchedReplace;

  const onEvent = (): void => debouncedHandleUrlChange();
  window.addEventListener('popstate', onEvent);
  window.addEventListener('hashchange', onEvent);

  return {
    restore: () => {
      if (!watching) return;
      watching = false;
      debouncedHandleUrlChange.cancel();
      // Only ours to put back while ours is still in place: a page (or
      // another extension) that wrapped them since keeps its wrapper, and
      // ours, inside it, now just passes through.
      if (history.pushState === patchedPush) history.pushState = nativePush;
      if (history.replaceState === patchedReplace) history.replaceState = nativeReplace;
      window.removeEventListener('popstate', onEvent);
      window.removeEventListener('hashchange', onEvent);
    },
  };
}
