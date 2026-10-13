// src/fullImageLoader.ts
// The enlarged view's full-resolution images (design spec §AH): fetched
// (GET_IMAGE, through the view's callback) as each note comes near the
// scroller's viewport. Thumbnails, inline in every item, stand in until
// then, and every box is sized from the stored selection before any image
// arrives, so nothing moves when one does. Moved out of enlargedView.ts
// unchanged: the observer, the fetches in flight and the images that
// arrived are its own state; the view says where an image lands.

import type { FeedbackItem } from './types';

/** Full images are fetched as a note comes within this much of the
 *  scroller's viewport. */
const LAZY_ROOT_MARGIN = '800px 0px';

export interface FullImageLoaderOptions {
  /** The image for `item`, or null when it cannot be had. */
  fetch: (item: FeedbackItem) => Promise<string | null>;
  /** One arrived: put it where `item`'s note (and any clone of it) shows. */
  onLoaded: (item: FeedbackItem, url: string) => void;
  /** Once the view has closed, a late reply lands nowhere. */
  isClosed: () => boolean;
}

export class FullImageLoader {
  private readonly images = new Map<number, string>();
  private readonly fetching = new Set<number>();
  private observer: IntersectionObserver | null = null;

  constructor(private readonly opts: FullImageLoaderOptions) {}

  /** The full image of note `id`, if it has arrived. */
  get(id: number): string | undefined {
    return this.images.get(id);
  }

  /** Full images arrive as notes near the viewport (IntersectionObserver on
   *  `root`, the scroller, with a margin). Without one (jsdom), all are
   *  fetched. */
  start(notes: Iterable<{ item: FeedbackItem; el: Element }>, root: Element): void {
    if (typeof IntersectionObserver !== 'function') {
      for (const note of notes) this.ensure(note.item);
      return;
    }
    const byEl = new Map<Element, FeedbackItem>();
    for (const note of notes) byEl.set(note.el, note.item);
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          this.observer?.unobserve(entry.target);
          const item = byEl.get(entry.target);
          if (item) this.ensure(item);
        }
      },
      { root, rootMargin: LAZY_ROOT_MARGIN },
    );
    for (const el of byEl.keys()) this.observer.observe(el);
  }

  /** Fetch `item`'s full image unless it has arrived or is on its way. */
  ensure(item: FeedbackItem): void {
    const id = item.id;
    if (this.images.has(id) || this.fetching.has(id)) return;
    this.fetching.add(id);
    void this.opts
      .fetch(item)
      .catch(() => null)
      .then((url) => {
        this.fetching.delete(id);
        if (!url || this.opts.isClosed()) return;
        this.images.set(id, url);
        this.opts.onLoaded(item, url);
      });
  }

  /** Stop observing (the view's teardown). */
  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
  }
}
