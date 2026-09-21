// Phase 7 — thumbnail list rendering (REQUIREMENTS §1.5, §3.3).

import { renderThumbnailList, truncateNotePreview } from '../thumbnails';
import { FeedbackItem } from '../types';

function makeItem(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    id: 1,
    pageUrl: 'https://example.com/page',
    normalisedUrl: 'https://example.com/page',
    note: 'a note',
    createdAt: '2026-01-01T00:00:00.000Z',
    selectionRect: { x: 0, y: 0, width: 100, height: 100 },
    viewport: { width: 1280, height: 800 },
    dpr: 1,
    screenshotKey: 'key-1',
    thumbnailDataUrl: 'data:image/jpeg;base64,AAAA',
    context: {
      primaryTarget: { cssSelector: 'div', xpath: '/html/body/div', outerHtmlSnippet: '<div></div>', truncated: false },
      containedElements: [],
      areaText: '',
      pageMeta: {
        url: 'https://example.com/page',
        normalisedUrl: 'https://example.com/page',
        title: 'example',
        viewport: { width: 1280, height: 800 },
        dpr: 1,
        selectionRect: { x: 0, y: 0, width: 100, height: 100 },
        capturedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    ...overrides,
  };
}

describe('truncateNotePreview', () => {
  it('returns short notes unchanged (trimmed)', () => {
    expect(truncateNotePreview('  hello  ')).toBe('hello');
  });

  it('truncates pathologically long notes with a trailing ellipsis (visual 3-line clamp is CSS, this is just a DOM-size ceiling)', () => {
    const long = 'x'.repeat(2000);
    const preview = truncateNotePreview(long);
    expect(preview.length).toBeLessThanOrEqual(600);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('leaves realistic note lengths untouched — the 3-line clamp is CSS, not a JS char cap', () => {
    const note = 'x'.repeat(200);
    expect(truncateNotePreview(note)).toBe(note);
  });

  it('returns an empty string for an empty/whitespace-only note', () => {
    expect(truncateNotePreview('   ')).toBe('');
  });
});

describe('renderThumbnailList', () => {
  let listEl: HTMLUListElement;

  beforeEach(() => {
    listEl = document.createElement('ul');
  });

  it('renders one <li> wrapping a real <button class="thumbnail"> per item, in the order given', () => {
    renderThumbnailList(listEl, [makeItem({ id: 1 }), makeItem({ id: 2 })], { onOpen: jest.fn(), onDelete: jest.fn() });
    const items = listEl.querySelectorAll('li > button.thumbnail');
    expect(items.length).toBe(2);
    expect(items[0].tagName).toBe('BUTTON');
    expect(items[0].querySelector('.thumbnail-badge')?.textContent).toBe('1');
    expect(items[1].querySelector('.thumbnail-badge')?.textContent).toBe('2');
  });

  it('clears previous content before rendering (no accumulation across calls)', () => {
    renderThumbnailList(listEl, [makeItem({ id: 1 })], { onOpen: jest.fn(), onDelete: jest.fn() });
    renderThumbnailList(listEl, [makeItem({ id: 2 }), makeItem({ id: 3 })], { onOpen: jest.fn(), onDelete: jest.fn() });
    expect(listEl.querySelectorAll('button.thumbnail').length).toBe(2);
  });

  it('sets the thumbnail image src from thumbnailDataUrl', () => {
    renderThumbnailList(listEl, [makeItem({ thumbnailDataUrl: 'data:image/jpeg;base64,ZZZZ' })], {
      onOpen: jest.fn(),
      onDelete: jest.fn(),
    });
    const img = listEl.querySelector('img.thumbnail-image') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('data:image/jpeg;base64,ZZZZ');
  });

  it('gives the image wrap a fixed height and scales the image to fit via object-fit: contain', () => {
    renderThumbnailList(listEl, [makeItem()], { onOpen: jest.fn(), onDelete: jest.fn() });
    const wrap = listEl.querySelector('.thumbnail-image-wrap') as HTMLElement;
    const img = listEl.querySelector('img.thumbnail-image') as HTMLImageElement;

    // jsdom doesn't compute layout, so assert against the inline style this
    // module applies directly (it owns the elements it builds) rather than a
    // stylesheet rule — same pattern as other CSS assertions in this codebase.
    expect(wrap.style.height).toMatch(/^\d+px$/);
    expect(parseInt(wrap.style.height, 10)).toBeGreaterThanOrEqual(80);

    expect(img.style.objectFit).toBe('contain');
    expect(img.style.width).toBe('100%');
    expect(img.style.height).toBe('100%');
  });

  it('shows the lowercase "no note" placeholder for an empty note, styled distinctly', () => {
    renderThumbnailList(listEl, [makeItem({ note: '' })], { onOpen: jest.fn(), onDelete: jest.fn() });
    const note = listEl.querySelector('.thumbnail-note') as HTMLElement;
    expect(note.textContent).toBe('no note');
    expect(note.classList.contains('thumbnail-note-empty')).toBe(true);
  });

  it('shows the truncated note text for a populated note', () => {
    renderThumbnailList(listEl, [makeItem({ note: 'looks off-centre on mobile' })], { onOpen: jest.fn(), onDelete: jest.fn() });
    const note = listEl.querySelector('.thumbnail-note') as HTMLElement;
    expect(note.textContent).toBe('looks off-centre on mobile');
    expect(note.classList.contains('thumbnail-note-empty')).toBe(false);
  });

  it('fires onOpen with the item on click', () => {
    const onOpen = jest.fn();
    const item = makeItem({ id: 42 });
    renderThumbnailList(listEl, [item], { onOpen, onDelete: jest.fn() });

    (listEl.querySelector('button.thumbnail') as HTMLButtonElement).click();

    expect(onOpen).toHaveBeenCalledWith(item);
  });

  it('fires onOpen on Enter and Space, but not on other keys', () => {
    const onOpen = jest.fn();
    const item = makeItem({ id: 5 });
    renderThumbnailList(listEl, [item], { onOpen, onDelete: jest.fn() });
    const btn = listEl.querySelector('button.thumbnail') as HTMLButtonElement;

    btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(onOpen).not.toHaveBeenCalled();

    btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    btn.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('gives each note a separate, aria-hidden background layer for the dock motion to fade (design spec §4)', () => {
    renderThumbnailList(listEl, [makeItem()], { onOpen: jest.fn(), onDelete: jest.fn() });
    const wrap = listEl.querySelector('button.thumbnail > .thumbnail-note-wrap') as HTMLElement;
    expect(wrap).not.toBeNull();
    const bg = wrap.querySelector('.thumbnail-note-bg') as HTMLElement;
    expect(bg.getAttribute('aria-hidden')).toBe('true');
    expect(bg.textContent).toBe('');
    // The note text itself stays a sibling on top, so its accessible name is unchanged.
    expect(wrap.querySelector('.thumbnail-note')?.textContent).toBe('a note');
  });

  it("builds each item's hover delete as a SIBLING of the thumbnail button (design spec v4 §L)", () => {
    renderThumbnailList(listEl, [makeItem({ id: 7 })], { onOpen: jest.fn(), onDelete: jest.fn() });
    const li = listEl.querySelector('li.thumbnail-item') as HTMLLIElement;
    const del = li.querySelector('button.thumbnail-delete') as HTMLButtonElement;

    // Nested buttons are invalid HTML and break activation, so this cannot
    // live inside <button class="thumbnail">.
    expect(del.parentElement).toBe(li);
    expect((li.querySelector('button.thumbnail') as HTMLElement).contains(del)).toBe(false);

    expect(del.type).toBe('button');
    expect(del.getAttribute('aria-label')).toBe('delete feedback item 7');
    // Every visible string is lowercase (REQUIREMENTS §3.4).
    expect(del.title).toBe('delete');
    expect(del.title).toBe(del.title.toLowerCase());
    expect(del.dataset.itemId).toBe('7');
    // The §1 icon language: 1.8px stroke, round caps/joins, currentColor.
    const svg = del.querySelector('svg') as SVGElement;
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.getAttribute('stroke-width')).toBe('1.8');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });

  it('fires onDelete with the item, and never onOpen, when the delete is clicked', () => {
    const onOpen = jest.fn();
    const onDelete = jest.fn();
    const item = makeItem({ id: 9 });
    renderThumbnailList(listEl, [item], { onOpen, onDelete });

    (listEl.querySelector('button.thumbnail-delete') as HTMLButtonElement).click();

    expect(onDelete).toHaveBeenCalledWith(item);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('gives every item a delete, and rebuilds them all on a repaint', () => {
    renderThumbnailList(listEl, [makeItem({ id: 1 }), makeItem({ id: 2 })], {
      onOpen: jest.fn(),
      onDelete: jest.fn(),
    });
    expect(listEl.querySelectorAll('button.thumbnail-delete').length).toBe(2);

    const onDelete = jest.fn();
    const fresh = makeItem({ id: 3 });
    renderThumbnailList(listEl, [fresh], { onOpen: jest.fn(), onDelete });
    expect(listEl.querySelectorAll('button.thumbnail-delete').length).toBe(1);
    // The rebuilt button is wired to the NEW callback, not the old one.
    (listEl.querySelector('button.thumbnail-delete') as HTMLButtonElement).click();
    expect(onDelete).toHaveBeenCalledWith(fresh);
  });

  it('marks each thumbnail as a real, labelled <button> (native focusability/activation)', () => {
    renderThumbnailList(listEl, [makeItem({ id: 3 })], { onOpen: jest.fn(), onDelete: jest.fn() });
    const btn = listEl.querySelector('button.thumbnail') as HTMLButtonElement;
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.type).toBe('button');
    expect(btn.getAttribute('aria-label')).toContain('3');
  });
});
