// src/thumbnails.ts
// Sidebar note-list rendering (REQUIREMENTS §1.5, design spec §3.1/§3.3).
//
// Pure DOM builder: given the shadow-root <ul> sidebar.ts already owns and a
// list of FeedbackItem for the current URL, (re)builds one <li> per item —
// each wrapping a real <button class="thumbnail"> (screenshot + number badge
// + note text below, no card/box around it) — and wires its click/keyboard
// "open" activation. No chrome.runtime, no module-level state: sidebar.ts
// calls renderThumbnailList on every refresh and this module just repaints
// the list from scratch, mirroring how addMode/modal own their own DOM but
// this one owns none of its own — the <ul> belongs to sidebar.ts's shadow
// root (§1.1's single closed-shadow-root-per-surface pattern doesn't apply
// here since this isn't a separate host).
//
// A real <button> per item (design spec §3.1) rather than the old
// tabindex/role="button" pair, so Enter/Space/click all come from native
// button semantics. The keydown handler below still exists (rather than
// relying solely on the browser's own click-on-Enter/Space behaviour)
// because it needs to preventDefault before that default action fires —
// otherwise Enter would both call onOpen() directly *and* trigger a second,
// synthetic click.
//
// The class names below (.thumbnail, .thumbnail-image-wrap, .thumbnail-note,
// .thumbnail-badge) are the hook points both for sidebar.ts's CSS and for
// the later dock-magnification agent (design spec §4) — they predate this
// restyle and are kept stable on purpose, including because
// tests/helpers/extension.js's Playwright SELECTORS reference them directly.
//
// Newest-at-the-bottom ordering (§1.5) is the caller's responsibility —
// storage.ts's getPageItems already returns items in capture order and this
// module renders them in the order given, appending nothing itself.

import { FeedbackItem } from './types';

export interface ThumbnailCallbacks {
  /** Fired when a thumbnail is activated (click or Enter/Space). */
  onOpen: (item: FeedbackItem) => void;
}

/** Hard cap on the note text handed to the DOM (design spec §3.1's visual
 *  3-line clamp is CSS's job now — sidebar.ts's `.thumbnail-note` rule sets
 *  `-webkit-line-clamp: 3`, which adapts to the resizable 100–300px sidebar
 *  width the way a fixed character count never could). This is only a sanity
 *  ceiling for pathological notes so a many-KB note never bloats one list
 *  item's DOM/paint cost. */
const NOTE_PREVIEW_LENGTH = 600;

/** Fixed height (px) for every thumbnail's image box (§1.5/§3.3). Screenshots
 *  are captured at whatever aspect ratio the user's selection happened to be,
 *  so without a fixed box the grid reads as uneven — some thumbnails tall,
 *  some short/wide. Width intentionally stays relative (100%, set in
 *  sidebar.ts's `.thumbnail-image-wrap` rule) rather than a paired fixed
 *  value: the sidebar itself is becoming resizable (100–300px) in this same
 *  round of work, so a hardcoded width would either overflow or leave a gap
 *  as the sidebar is dragged. Applied as an inline style rather than a new
 *  sidebar.ts CSS rule since this module owns the elements it builds and
 *  sidebar.ts is out of scope for this change. */
const THUMBNAIL_IMAGE_HEIGHT_PX = 100;

/** Truncate a note to the preview length, breaking on a trailing ellipsis
 *  rather than mid-word cleanup — exported so contextCapture-style callers
 *  and tests can assert on it directly without re-deriving the constant. */
export function truncateNotePreview(note: string): string {
  const trimmed = note.trim();
  if (trimmed.length <= NOTE_PREVIEW_LENGTH) return trimmed;
  return `${trimmed.slice(0, NOTE_PREVIEW_LENGTH - 1).trimEnd()}…`;
}

/** Rebuild `listEl`'s children from `items`. Clears whatever was there before
 *  — cheap enough at the item counts this sidebar ever holds, and avoids
 *  reconciling stale DOM against edited notes/deleted items after every
 *  storage round trip. */
export function renderThumbnailList(
  listEl: HTMLUListElement,
  items: FeedbackItem[],
  callbacks: ThumbnailCallbacks,
): void {
  listEl.innerHTML = '';
  for (const item of items) {
    listEl.appendChild(buildThumbnailEl(item, callbacks));
  }
}

function buildThumbnailEl(item: FeedbackItem, callbacks: ThumbnailCallbacks): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'thumbnail-item';

  // The interactive element is the button, not the <li> — see the file
  // banner for why this is a real <button> rather than a role="button" div.
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'thumbnail';
  btn.setAttribute('aria-label', `feedback item ${item.id}`);

  const imageWrap = document.createElement('div');
  imageWrap.className = 'thumbnail-image-wrap';
  // Fixed-size box (see THUMBNAIL_IMAGE_HEIGHT_PX) — width stays whatever
  // sidebar.ts's CSS gives it (100% of the resizable sidebar's content area).
  imageWrap.style.height = `${THUMBNAIL_IMAGE_HEIGHT_PX}px`;

  const img = document.createElement('img');
  img.className = 'thumbnail-image';
  img.src = item.thumbnailDataUrl;
  img.alt = '';
  img.draggable = false;
  // Scale the (variably-sized) captured screenshot to fit inside the fixed
  // box without cropping — this is a feedback tool, so losing part of the
  // screenshot to a `cover` crop would hide the very thing being reported.
  img.style.width = '100%';
  img.style.height = '100%';
  img.style.objectFit = 'contain';

  const badge = document.createElement('span');
  badge.className = 'thumbnail-badge';
  badge.textContent = String(item.id);

  imageWrap.appendChild(img);
  imageWrap.appendChild(badge);

  const note = document.createElement('p');
  const preview = truncateNotePreview(item.note);
  note.className = preview ? 'thumbnail-note' : 'thumbnail-note thumbnail-note-empty';
  note.textContent = preview || 'no note';

  btn.appendChild(imageWrap);
  btn.appendChild(note);
  li.appendChild(btn);

  const open = (): void => callbacks.onOpen(item);
  btn.addEventListener('click', open);
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      // Stop the button's own default activation from also firing a
      // synthetic click for this same keypress — open() below is that
      // activation.
      e.preventDefault();
      open();
    }
  });

  return li;
}
