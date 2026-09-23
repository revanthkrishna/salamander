// src/thumbnails.ts
// Sidebar note-list rendering (REQUIREMENTS §1.5, design spec §3.1/§3.3).
//
// Pure DOM builder: given the shadow-root <ul> sidebar.ts already owns and a
// list of FeedbackItem for the current URL, (re)builds one <li> per item —
// each holding a real <button class="thumbnail"> (screenshot + number badge
// + note text below, no card/box around it) and, as its sibling, the hover
// <button class="thumbnail-delete"> (design spec v4 §L) — and wires their
// click/keyboard activation. No chrome.runtime, no module-level state: sidebar.ts
// calls renderThumbnailList on every refresh and this module just repaints
// the list from scratch, mirroring how addMode/enlargedView own their own
// DOM but this one owns none of its own — the <ul> belongs to sidebar.ts's shadow
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
// src/dockMotion.ts's magnification (design spec §4, which also drives the
// <li class="thumbnail-item"> transforms and the .thumbnail-note-bg layer's
// opacity) — they predate this restyle and are kept stable on purpose,
// including because tests/helpers/extension.js's Playwright SELECTORS
// reference them directly.
//
// Newest-at-the-bottom ordering (§1.5) is the caller's responsibility —
// storage.ts's getPageItems already returns items in capture order and this
// module renders them in the order given, appending nothing itself. That
// order is also what each badge shows: an item's number is its 1-based
// position in the list it is rendered in (see FeedbackItem.id in types.ts),
// so a repaint after a delete renumbers everything below the gap. The
// internal id goes only into `data-item-id`, which is how sidebar.ts finds
// an item again after a repaint.

import { FeedbackItem } from './types';
// The project's ONE trash glyph (design spec v5 §S) — the enlarged view's
// delete draws the same one.
import { ICON_TRASH } from './icons';
import { buildDrawingSvg, hasStrokes } from './drawing';

export interface ThumbnailCallbacks {
  /** Fired when a thumbnail is activated (click or Enter/Space). */
  onOpen: (item: FeedbackItem) => void;
  /** Fired when an item's hover delete is activated (design spec v4 §L).
   *  Deletes immediately, with no confirmation — the caller owns the
   *  DELETE_ITEM round trip and the repaint that follows. */
  onDelete: (item: FeedbackItem) => void;
}

/** Hard cap on the note text handed to the DOM (design spec §3.1's visual
 *  3-line clamp is CSS's job now — sidebar.ts's `.thumbnail-note` rule sets
 *  `-webkit-line-clamp: 3`, which adapts to the resizable 188–300px sidebar
 *  width the way a fixed character count never could). This is only a sanity
 *  ceiling for pathological notes so a many-KB note never bloats one list
 *  item's DOM/paint cost. */
const NOTE_PREVIEW_LENGTH = 600;

/** Fixed height (px) for every thumbnail's image box (§1.5/§3.3). Screenshots
 *  are captured at whatever aspect ratio the user's selection happened to be,
 *  so without a fixed box the grid reads as uneven — some thumbnails tall,
 *  some short/wide. Width intentionally stays relative (100%, set in
 *  sidebar.ts's `.thumbnail-image-wrap` rule) rather than a paired fixed
 *  value: the sidebar itself is becoming resizable (188–300px) in this same
 *  round of work, so a hardcoded width would either overflow or leave a gap
 *  as the sidebar is dragged. Applied as an inline style rather than a new
 *  sidebar.ts CSS rule since this module owns the elements it builds and
 *  sidebar.ts is out of scope for this change.
 *
 *  Exported so sidebar.ts can combine it with the thumbnail box's live width
 *  (sidebar width minus the list's horizontal padding) into a single
 *  "current thumbnail box size" helper — the source of truth addMode.ts
 *  reads for the click-to-place default selection size, so a default
 *  capture always fills the thumbnail exactly with no letterboxing. */
export const THUMBNAIL_IMAGE_HEIGHT_PX = 100;

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
  items.forEach((item, index) => {
    listEl.appendChild(buildThumbnailEl(item, index + 1, callbacks));
  });
}

/** One list item. `number` is the item's display number — its position in
 *  the list, not its id (see the file banner). */
function buildThumbnailEl(item: FeedbackItem, number: number, callbacks: ThumbnailCallbacks): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'thumbnail-item';

  // The interactive element is the button, not the <li> — see the file
  // banner for why this is a real <button> rather than a role="button" div.
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'thumbnail';
  btn.setAttribute('aria-label', `feedback item ${number}`);
  // Lets sidebar.focusThumbnail() find the item again after a repaint.
  btn.dataset.itemId = String(item.id);

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
  badge.textContent = String(number);

  imageWrap.appendChild(img);
  // The note's drawing (design spec §AB), laid over the image and fitted
  // exactly as it is: the SVG fills the same box with a viewBox of the
  // selection's size and `xMidYMid meet`, which is object-fit: contain.
  // Inside the <li>, so dock magnification scales it with the image, and
  // pointer-events: none (sidebar.ts's .thumbnail-drawing rule) so the
  // thumbnail button keeps every click.
  if (hasStrokes(item.drawing)) {
    imageWrap.appendChild(buildDrawingSvg(document, item.drawing, 'thumbnail-drawing'));
  }
  imageWrap.appendChild(badge);

  const note = document.createElement('p');
  const preview = truncateNotePreview(item.note);
  note.className = preview ? 'thumbnail-note' : 'thumbnail-note thumbnail-note-empty';
  note.textContent = preview || 'no note';

  // The note's hover/focus "extension" background (design spec v2 §B) is its
  // own layer rather than a background on the <p>: the dock magnification
  // (src/dockMotion.ts) fades it with an opacity-only spring, and the <p>'s
  // own `overflow: hidden` (needed for the 3-line clamp) would clip the
  // shadow if it lived on the note itself. Its geometry (tucked up under the
  // thumbnail's bottom edge, bottom-only radius, inset border) is entirely
  // sidebar.ts's `.thumbnail-note-bg` CSS rule — this module just gives it an
  // element spanning the button's width, so it's never wider than the
  // thumbnail.
  const noteWrap = document.createElement('span');
  noteWrap.className = 'thumbnail-note-wrap';
  const noteBg = document.createElement('span');
  noteBg.className = 'thumbnail-note-bg';
  noteBg.setAttribute('aria-hidden', 'true');
  noteWrap.appendChild(noteBg);
  noteWrap.appendChild(note);

  btn.appendChild(imageWrap);
  btn.appendChild(noteWrap);
  li.appendChild(btn);

  // The hover delete (design spec v4 §L). A SIBLING of the thumbnail button
  // inside the <li>, never a child of it: nested buttons are invalid HTML
  // and break activation. sidebar.ts's `.thumbnail-delete` rule floats it
  // over the thumbnail's top-right corner and fades it in with the note's
  // hover extension; dockMotion.ts springs that opacity and, because this
  // lives inside the transformed <li>, magnifies it along with its item.
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'thumbnail-delete';
  del.setAttribute('aria-label', `delete feedback item ${number}`);
  del.title = 'delete';
  // Same hook sidebar.focusThumbnail() uses on the item's own button, so a
  // caller can find this one again after a repaint.
  del.dataset.itemId = String(item.id);
  // Same shape as sidebar.ts's makeIconButton: a `.icon` span the stylesheet
  // sizes, holding the raw SVG markup.
  const delIcon = document.createElement('span');
  delIcon.className = 'icon';
  delIcon.innerHTML = ICON_TRASH;
  del.appendChild(delIcon);
  li.appendChild(del);

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

  del.addEventListener('click', (e) => {
    // It sits outside the thumbnail button's own hit area, so this is a
    // belt-and-braces guard rather than the main defence — but a click on
    // "delete" must never also read as "open this note", however the event
    // reaches here (a synthetic click, a future wrapper listener).
    e.stopPropagation();
    e.preventDefault();
    callbacks.onDelete(item);
  });

  return li;
}
