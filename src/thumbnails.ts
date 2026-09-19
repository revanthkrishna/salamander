// src/thumbnails.ts
// Phase 7 — sidebar thumbnail list rendering (REQUIREMENTS §1.5, §3.3).
//
// Pure DOM builder: given the shadow-root <ul> sidebar.ts already owns and a
// list of FeedbackItem for the current URL, (re)builds one <li> per item —
// screenshot image, item-number badge, note text truncated to a preview
// length — and wires a click/keyboard "open" handler per item. No
// chrome.runtime, no module-level state: sidebar.ts calls renderThumbnailList
// on every refresh and this module just repaints the list from scratch,
// mirroring how addMode/modal own their own DOM but this one owns none of
// its own — the <ul> belongs to sidebar.ts's shadow root (§1.1's single
// closed-shadow-root-per-surface pattern doesn't apply here since this isn't
// a separate host).
//
// Newest-at-the-bottom ordering (§1.5) is the caller's responsibility —
// storage.ts's getPageItems already returns items in capture order and this
// module renders them in the order given, appending nothing itself.

import { FeedbackItem } from './types';

export interface ThumbnailCallbacks {
  /** Fired when a thumbnail is activated (click or Enter/Space). */
  onOpen: (item: FeedbackItem) => void;
}

/** Preview length for the note text under each thumbnail (§3.3 — "note text
 *  truncated to a preview length"). Long enough to be useful at a glance,
 *  short enough that the sidebar's 320px column never wraps to more than a
 *  couple of lines. */
const NOTE_PREVIEW_LENGTH = 80;

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
  li.className = 'thumbnail';
  li.tabIndex = 0;
  li.setAttribute('role', 'button');
  li.setAttribute('aria-label', `feedback item ${item.id}`);

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

  li.appendChild(imageWrap);
  li.appendChild(note);

  const open = (): void => callbacks.onOpen(item);
  li.addEventListener('click', open);
  li.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });

  return li;
}
