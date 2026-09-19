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

  it('truncates long notes with a trailing ellipsis, capped at the preview length', () => {
    const long = 'x'.repeat(200);
    const preview = truncateNotePreview(long);
    expect(preview.length).toBeLessThanOrEqual(80);
    expect(preview.endsWith('…')).toBe(true);
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

  it('renders one <li class="thumbnail"> per item, in the order given', () => {
    renderThumbnailList(listEl, [makeItem({ id: 1 }), makeItem({ id: 2 })], { onOpen: jest.fn() });
    const items = listEl.querySelectorAll('li.thumbnail');
    expect(items.length).toBe(2);
    expect(items[0].querySelector('.thumbnail-badge')?.textContent).toBe('1');
    expect(items[1].querySelector('.thumbnail-badge')?.textContent).toBe('2');
  });

  it('clears previous content before rendering (no accumulation across calls)', () => {
    renderThumbnailList(listEl, [makeItem({ id: 1 })], { onOpen: jest.fn() });
    renderThumbnailList(listEl, [makeItem({ id: 2 }), makeItem({ id: 3 })], { onOpen: jest.fn() });
    expect(listEl.querySelectorAll('li.thumbnail').length).toBe(2);
  });

  it('sets the thumbnail image src from thumbnailDataUrl', () => {
    renderThumbnailList(listEl, [makeItem({ thumbnailDataUrl: 'data:image/jpeg;base64,ZZZZ' })], {
      onOpen: jest.fn(),
    });
    const img = listEl.querySelector('img.thumbnail-image') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('data:image/jpeg;base64,ZZZZ');
  });

  it('shows the lowercase "no note" placeholder for an empty note, styled distinctly', () => {
    renderThumbnailList(listEl, [makeItem({ note: '' })], { onOpen: jest.fn() });
    const note = listEl.querySelector('.thumbnail-note') as HTMLElement;
    expect(note.textContent).toBe('no note');
    expect(note.classList.contains('thumbnail-note-empty')).toBe(true);
  });

  it('shows the truncated note text for a populated note', () => {
    renderThumbnailList(listEl, [makeItem({ note: 'looks off-centre on mobile' })], { onOpen: jest.fn() });
    const note = listEl.querySelector('.thumbnail-note') as HTMLElement;
    expect(note.textContent).toBe('looks off-centre on mobile');
    expect(note.classList.contains('thumbnail-note-empty')).toBe(false);
  });

  it('fires onOpen with the item on click', () => {
    const onOpen = jest.fn();
    const item = makeItem({ id: 42 });
    renderThumbnailList(listEl, [item], { onOpen });

    (listEl.querySelector('li.thumbnail') as HTMLLIElement).click();

    expect(onOpen).toHaveBeenCalledWith(item);
  });

  it('fires onOpen on Enter and Space, but not on other keys', () => {
    const onOpen = jest.fn();
    const item = makeItem({ id: 5 });
    renderThumbnailList(listEl, [item], { onOpen });
    const li = listEl.querySelector('li.thumbnail') as HTMLLIElement;

    li.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(onOpen).not.toHaveBeenCalled();

    li.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    li.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('marks each thumbnail as a keyboard-focusable, labelled button role', () => {
    renderThumbnailList(listEl, [makeItem({ id: 3 })], { onOpen: jest.fn() });
    const li = listEl.querySelector('li.thumbnail') as HTMLLIElement;
    expect(li.tabIndex).toBe(0);
    expect(li.getAttribute('role')).toBe('button');
    expect(li.getAttribute('aria-label')).toContain('3');
  });
});
