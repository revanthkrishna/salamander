// src/cloneLayer.ts
// The enlarged view's shared-element clones (MOTION_SPEC §2, §4–§6): a copy
// of a note's screenshot that flies between its thumbnail in the docked list
// and its place in the view, in the view's `.xp-front` layer, above
// everything. Moved out of enlargedView.ts unchanged: the clones and their
// in-flight morphs are its own state; the view decides which notes travel,
// where from and where to, and when. The analytic tween maths is flip.ts's.

import type { FeedbackItem } from './types';
import { buildDrawingSvg, hasStrokes } from './drawing';
import { getContentViewportSize } from './dom';
import { RADII } from './theme';
import {
  STD,
  Slot,
  Tween,
  animateEl,
  cancelTracks,
  EdgeCut,
  NO_CUT,
  containFit,
  cutClipPath,
  lerpCut,
  fadeTo,
  lerpSlot,
  morphKeyframes,
  now,
  tweenProgress,
} from './flip';

/** A screenshot's frame at rest, in the view and in the list alike. */
const FRAME_RADIUS = RADII.md;

export interface Clone {
  id: number;
  el: HTMLDivElement;
  frame: HTMLElement;
  media: HTMLElement;
  img: HTMLImageElement;
  badge: HTMLElement;
  slot: Slot;
  /** How much of it the list's scrollport hides at rest (a thumbnail cut
   *  by the list's edge), on screen px. */
  cut: EdgeCut;
  morph: { tween: Tween<Slot>; clip: { from: EdgeCut; to: EdgeCut }; anims: Animation[] } | null;
  aspect: number;
}

/** A selection's aspect ratio, 16:9 when it has no usable size. */
export function aspectOf(item: FeedbackItem): number {
  const r = item.selectionRect;
  return r && r.width > 0 && r.height > 0 ? r.width / r.height : 16 / 9;
}

export class CloneLayer {
  private readonly clones = new Map<number, Clone>();

  /**
   * @param front The layer the clones live in (built with the view).
   * @param imageFor What a clone of `item` shows: its full image once that
   *   has arrived, its thumbnail until then.
   */
  constructor(
    private readonly front: () => HTMLElement,
    private readonly imageFor: (item: FeedbackItem) => string,
  ) {}

  get size(): number {
    return this.clones.size;
  }

  get(id: number): Clone | undefined {
    return this.clones.get(id);
  }

  has(id: number): boolean {
    return this.clones.has(id);
  }

  values(): IterableIterator<Clone> {
    return this.clones.values();
  }

  /**
   * A clone of `item` at `slot`, clipped by `cut`, carrying the list's number
   * badge (`badgeNumber`): it fades out as the clone leaves the list
   * (`badgeFadeOut`, when the badge is in sight and the view is opening) and
   * back in as one lands on it (MOTION_SPEC §4); otherwise it starts hidden.
   */
  create(
    item: FeedbackItem,
    badgeNumber: number,
    slot: Slot,
    cut: EdgeCut,
    badgeFadeOut: { duration: number; delay: number } | null,
  ): Clone {
    const el = document.createElement('div');
    el.className = 'xp-card';
    el.dataset.itemId = String(item.id);
    const frame = document.createElement('span');
    frame.className = 'xp-card-frame';
    const media = document.createElement('span');
    media.className = 'xp-card-media';
    const img = document.createElement('img');
    img.className = 'xp-card-img';
    img.alt = '';
    img.draggable = false;
    img.src = this.imageFor(item);
    const badge = document.createElement('span');
    badge.className = 'xp-card-badge';
    badge.textContent = String(badgeNumber);
    media.appendChild(img);
    if (hasStrokes(item.drawing)) media.appendChild(buildDrawingSvg(document, item.drawing, 'xp-card-drawing'));
    frame.appendChild(media);
    el.append(frame, badge);
    const clone: Clone = { id: item.id, el, frame, media, img, badge, slot, cut, morph: null, aspect: aspectOf(item) };
    this.place(clone, slot, cut);
    if (badgeFadeOut) {
      fadeTo(badge, 0, { duration: badgeFadeOut.duration, delay: badgeFadeOut.delay, curve: STD });
    } else {
      badge.style.opacity = '0';
    }
    this.clones.set(item.id, clone);
    this.front().appendChild(el);
    return clone;
  }

  /** Write the clone's layout boxes for `slot` (the FLIP "Last"), and the
   *  clip of `cut` it rests with there. */
  place(clone: Clone, slot: Slot, cut: EdgeCut = NO_CUT): void {
    this.cancelMorph(clone);
    clone.slot = slot;
    clone.cut = cut;
    clone.frame.style.clipPath = cut.top > 0 || cut.bottom > 0 ? cutClipPath(cut) : '';
    const s = clone.el.style;
    s.right = `${getContentViewportSize().width - (slot.x + slot.w)}px`;
    s.top = `${slot.y}px`;
    s.width = `${slot.w}px`;
    s.height = `${slot.h}px`;
    const ib = containFit(clone.aspect, { x: 0, y: 0, w: slot.w, h: slot.h });
    const ms = clone.media.style;
    ms.left = `${ib.x}px`;
    ms.top = `${ib.y}px`;
    ms.width = `${ib.w}px`;
    ms.height = `${ib.h}px`;
    ms.borderRadius = `${slot.imgR}px`;
  }

  /** Morph `from` → `to`, the clip easing `cutFrom` → `cutTo` with it: a
   *  thumbnail the list's edge cuts leaves (or lands) exactly as cut. */
  morph(clone: Clone, from: Slot, to: Slot, duration: number, cutFrom: EdgeCut = NO_CUT, cutTo: EdgeCut = NO_CUT): void {
    this.place(clone, to, cutTo);
    if (duration <= 0 || from.w < 1 || from.h < 1) return;
    const clip = { from: cutFrom, to: cutTo };
    const clipped = cutFrom.top + cutFrom.bottom + cutTo.top + cutTo.bottom > 0;
    const kf = morphKeyframes(
      from,
      to,
      clone.aspect,
      STD.fn,
      Math.max(8, Math.round(duration / 16)),
      FRAME_RADIUS,
      clipped ? clip : undefined,
    );
    const opts: KeyframeAnimationOptions = { duration, easing: 'linear' };
    const anims = [
      animateEl(clone.frame, kf.frame, opts),
      animateEl(clone.media, kf.media, opts),
      animateEl(clone.badge, kf.badge, opts),
    ].filter((a): a is Animation => a !== null);
    clone.morph = { tween: { from, to, start: now(), delay: 0, duration, ease: STD.fn }, clip, anims };
  }

  /** How much of the clone is clipped right now (analytic). */
  cutOf(clone: Clone): EdgeCut {
    const m = clone.morph;
    if (!m) return clone.cut;
    return lerpCut(m.clip.from, m.clip.to, tweenProgress(m.tween, now()));
  }

  /** Where the clone is on screen right now (analytic — no DOM read). */
  slotOf(clone: Clone): Slot {
    const m = clone.morph;
    if (!m) return clone.slot;
    return lerpSlot(m.tween.from, m.tween.to, tweenProgress(m.tween, now()));
  }

  remove(clone: Clone): void {
    this.cancelMorph(clone);
    cancelTracks(clone.el);
    cancelTracks(clone.badge);
    clone.el.remove();
    if (this.clones.get(clone.id) === clone) this.clones.delete(clone.id);
  }

  removeAll(): void {
    for (const clone of [...this.clones.values()]) this.remove(clone);
  }

  private cancelMorph(clone: Clone): void {
    if (!clone.morph) return;
    for (const a of clone.morph.anims) a.cancel();
    clone.morph = null;
  }
}
