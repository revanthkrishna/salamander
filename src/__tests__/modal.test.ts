// Phase 7 — enlarged feedback modal (REQUIREMENTS §1.5, §3.3).
//
// modal.ts is a pure DOM module (gotcha #1/#3 — no chrome.runtime of its
// own); callers inject fetchFullImage/onSaveNote/onDelete, so these tests
// drive it the same way content.ts does, with jest.fn() stand-ins.

import * as modal from '../modal';
import * as sidebar from '../sidebar';
import { getSidebarWidth, setSidebarWidth } from '../sidebar';
import { FeedbackItem } from '../types';

// modal.ts uses attachShadow({ mode: 'closed' }), so tests can't query into
// it from outside — same restriction a real browser imposes. Force 'open'
// mode for this file only (mirrors sidebar.test.ts's approach) so assertions
// can reach the rendered DOM while the module code itself stays untouched.
const originalAttachShadow = HTMLElement.prototype.attachShadow;
beforeAll(() => {
  HTMLElement.prototype.attachShadow = function (init: ShadowRootInit) {
    return originalAttachShadow.call(this, { ...init, mode: 'open' });
  };
});
afterAll(() => {
  HTMLElement.prototype.attachShadow = originalAttachShadow;
});

function getHost(): HTMLElement | null {
  return document.getElementById('annotator-modal-host');
}

function shadowRoot(): ShadowRoot {
  const host = getHost();
  if (!host || !host.shadowRoot) throw new Error('modal host/shadow root not found');
  return host.shadowRoot;
}

function makeItem(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    id: 1,
    pageUrl: 'https://example.com/page',
    normalisedUrl: 'https://example.com/page',
    note: 'original note',
    createdAt: '2026-01-01T00:00:00.000Z',
    selectionRect: { x: 0, y: 0, width: 100, height: 100 },
    viewport: { width: 1280, height: 800 },
    dpr: 1,
    screenshotKey: 'key-1',
    thumbnailDataUrl: 'data:image/jpeg;base64,THUMB',
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

function makeCallbacks(overrides: Partial<modal.ModalCallbacks> = {}): modal.ModalCallbacks {
  return {
    fetchFullImage: jest.fn().mockResolvedValue(null),
    onSaveNote: jest.fn().mockResolvedValue(true),
    onDelete: jest.fn().mockResolvedValue(true),
    onClose: jest.fn(),
    ...overrides,
  };
}

describe('modal', () => {
  afterEach(() => {
    modal._destroyForTests();
    sidebar.destroySidebar();
  });

  it('opens a host attached to <html>, shows the thumbnail immediately, badge and note', () => {
    modal.openModal(makeItem({ id: 3, note: 'hello' }), makeCallbacks());

    const host = getHost();
    expect(host).not.toBeNull();
    expect(host!.parentElement).toBe(document.documentElement);
    expect(modal.isModalOpen()).toBe(true);
    // Bug 3 regression: a bare `position: fixed` host with no explicit
    // z-index sits in the z-index:auto paint layer and loses to any page
    // element with its own explicit positive z-index. The host must set one.
    expect(Number(host!.style.zIndex)).toBe(2147483647);

    const img = shadowRoot().querySelector('img.screenshot') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('data:image/jpeg;base64,THUMB');

    const badge = shadowRoot().querySelector('.item-badge') as HTMLElement;
    expect(badge.textContent).toContain('3');

    const textarea = shadowRoot().querySelector('textarea.note-input') as HTMLTextAreaElement;
    expect(textarea.value).toBe('hello');
  });

  it('swaps in the full-resolution image once fetchFullImage resolves', async () => {
    const callbacks = makeCallbacks({
      fetchFullImage: jest.fn().mockResolvedValue('data:image/png;base64,FULL'),
    });
    modal.openModal(makeItem(), callbacks);

    await Promise.resolve();
    await Promise.resolve();

    const img = shadowRoot().querySelector('img.screenshot') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('data:image/png;base64,FULL');
  });

  it('keeps the thumbnail image when fetchFullImage resolves null', async () => {
    modal.openModal(makeItem(), makeCallbacks({ fetchFullImage: jest.fn().mockResolvedValue(null) }));
    await Promise.resolve();
    await Promise.resolve();

    const img = shadowRoot().querySelector('img.screenshot') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('data:image/jpeg;base64,THUMB');
  });

  it('ignores a stale fetchFullImage resolution after the modal has moved to a new item', async () => {
    let resolveFirst: (v: string | null) => void = () => {};
    const firstFetch = new Promise<string | null>((resolve) => { resolveFirst = resolve; });
    const first = makeCallbacks({ fetchFullImage: jest.fn().mockReturnValue(firstFetch) });
    modal.openModal(makeItem({ id: 1, thumbnailDataUrl: 'data:image/jpeg;base64,ONE' }), first);

    // Move on to a second item before the first fetch resolves.
    const second = makeCallbacks({ fetchFullImage: jest.fn().mockResolvedValue('data:image/png;base64,TWO_FULL') });
    modal.openModal(makeItem({ id: 2, thumbnailDataUrl: 'data:image/jpeg;base64,TWO' }), second);
    await Promise.resolve();
    await Promise.resolve();

    // Now let the first (stale) fetch resolve — it must not clobber item 2's image.
    resolveFirst('data:image/png;base64,ONE_FULL');
    await Promise.resolve();
    await Promise.resolve();

    const img = shadowRoot().querySelector('img.screenshot') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('data:image/png;base64,TWO_FULL');
  });

  it('autosaves the note on textarea blur when the value changed', async () => {
    const onSaveNote = jest.fn().mockResolvedValue(true);
    modal.openModal(makeItem({ note: 'before' }), makeCallbacks({ onSaveNote }));

    const textarea = shadowRoot().querySelector('textarea.note-input') as HTMLTextAreaElement;
    textarea.value = 'after';
    textarea.dispatchEvent(new Event('blur'));
    await Promise.resolve();
    await Promise.resolve();

    expect(onSaveNote).toHaveBeenCalledWith('after');
  });

  it('does not call onSaveNote on blur when the value is unchanged', async () => {
    const onSaveNote = jest.fn().mockResolvedValue(true);
    modal.openModal(makeItem({ note: 'same' }), makeCallbacks({ onSaveNote }));

    const textarea = shadowRoot().querySelector('textarea.note-input') as HTMLTextAreaElement;
    textarea.dispatchEvent(new Event('blur'));
    await Promise.resolve();

    expect(onSaveNote).not.toHaveBeenCalled();
  });

  it('shows an inline error when the note autosave fails, and does not throw', async () => {
    const onSaveNote = jest.fn().mockResolvedValue(false);
    modal.openModal(makeItem({ note: 'before' }), makeCallbacks({ onSaveNote }));

    const textarea = shadowRoot().querySelector('textarea.note-input') as HTMLTextAreaElement;
    textarea.value = 'after';
    textarea.dispatchEvent(new Event('blur'));
    await Promise.resolve();
    await Promise.resolve();

    const error = shadowRoot().querySelector('.inline-error') as HTMLElement;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("couldn't save note. try again.");
  });

  it('autosaves a pending edit on close (close button) before firing onClose', async () => {
    const onSaveNote = jest.fn().mockResolvedValue(true);
    const onClose = jest.fn();
    modal.openModal(makeItem({ note: 'before' }), makeCallbacks({ onSaveNote, onClose }));

    const textarea = shadowRoot().querySelector('textarea.note-input') as HTMLTextAreaElement;
    textarea.value = 'edited then closed';
    // No blur fired — closing directly must still pick up the pending edit.
    (shadowRoot().querySelector('.close-btn') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onSaveNote).toHaveBeenCalledWith('edited then closed');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(modal.isModalOpen()).toBe(false);
    expect(getHost()).toBeNull();
  });

  it('closes on a backdrop click but not on a click inside the panel', () => {
    const onClose = jest.fn();
    modal.openModal(makeItem(), makeCallbacks({ onClose }));

    const panel = shadowRoot().querySelector('.panel') as HTMLElement;
    panel.click();
    expect(modal.isModalOpen()).toBe(true);

    const backdrop = shadowRoot().querySelector('.backdrop') as HTMLElement;
    backdrop.click();
    return Promise.resolve().then(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('closes on Escape', async () => {
    const onClose = jest.fn();
    modal.openModal(makeItem(), makeCallbacks({ onClose }));

    // Escape handling now runs through the same capture-phase keyboard
    // isolation as every other key (see keyboardIsolation.ts /
    // keyboardIsolation.test.ts) rather than a bubble-phase document
    // listener, so the event must actually target something inside the
    // modal's shadow host — bubbles/composed so it crosses the shadow
    // boundary the way a real key event would.
    const textarea = shadowRoot().querySelector('textarea.note-input') as HTMLTextAreaElement;
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(modal.isModalOpen()).toBe(false);
  });

  it('delete removes the item and closes without re-saving the note', async () => {
    const onDelete = jest.fn().mockResolvedValue(true);
    const onSaveNote = jest.fn().mockResolvedValue(true);
    const onClose = jest.fn();
    modal.openModal(makeItem({ note: 'before' }), makeCallbacks({ onDelete, onSaveNote, onClose }));

    const textarea = shadowRoot().querySelector('textarea.note-input') as HTMLTextAreaElement;
    textarea.value = 'edited right before delete';

    (shadowRoot().querySelector('.delete-btn') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onSaveNote).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(modal.isModalOpen()).toBe(false);
  });

  it('shows an inline error and re-enables delete when deletion fails, modal stays open', async () => {
    const onDelete = jest.fn().mockResolvedValue(false);
    const onClose = jest.fn();
    modal.openModal(makeItem(), makeCallbacks({ onDelete, onClose }));

    const deleteBtn = shadowRoot().querySelector('.delete-btn') as HTMLButtonElement;
    deleteBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(onClose).not.toHaveBeenCalled();
    expect(modal.isModalOpen()).toBe(true);
    expect(deleteBtn.disabled).toBe(false);
    const error = shadowRoot().querySelector('.inline-error') as HTMLElement;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("couldn't delete item. try again.");
  });

  it('opening a second item while one is already open tears the first down without saving', () => {
    const onSaveNoteA = jest.fn().mockResolvedValue(true);
    modal.openModal(makeItem({ id: 1, note: 'a' }), makeCallbacks({ onSaveNote: onSaveNoteA }));

    const textarea = shadowRoot().querySelector('textarea.note-input') as HTMLTextAreaElement;
    textarea.value = 'unsaved edit on item 1';

    modal.openModal(makeItem({ id: 2, note: 'b' }), makeCallbacks());

    expect(onSaveNoteA).not.toHaveBeenCalled();
    const badge = shadowRoot().querySelector('.item-badge') as HTMLElement;
    expect(badge.textContent).toContain('2');
  });

  // Bug fix regression: keyboard events leaking to the host page (Gmail /
  // Instagram reports — see keyboardIsolation.ts / keyboardIsolation.test.ts
  // for the general mechanism proof). These verify modal.ts actually wires
  // that mechanism up around its note textarea.
  describe('keyboard isolation for the note textarea', () => {
    it('a hostile document-level keydown listener never sees keys typed into the note textarea while the modal is open', () => {
      let hostileFired = false;
      const hostileHandler = (e: KeyboardEvent) => {
        hostileFired = true;
        e.preventDefault();
      };
      document.addEventListener('keydown', hostileHandler);

      modal.openModal(makeItem(), makeCallbacks());
      const textarea = shadowRoot().querySelector('textarea.note-input') as HTMLTextAreaElement;

      const event = new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true, composed: true });
      const notCancelled = textarea.dispatchEvent(event);

      expect(hostileFired).toBe(false);
      expect(event.defaultPrevented).toBe(false);
      expect(notCancelled).toBe(true);

      document.removeEventListener('keydown', hostileHandler);
    });

    it('stops isolating once the modal is closed — a subsequent keydown on the page reaches the page again', async () => {
      modal.openModal(makeItem(), makeCallbacks());
      await modal.closeModal();

      let hostileFired = false;
      document.addEventListener('keydown', () => {
        hostileFired = true;
      });

      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true }));
      expect(hostileFired).toBe(true);
    });
  });

  // Bug 3 (z-index) / Bug 4 (sidebar overlap) regression coverage.
  describe('stacking relative to the page and the sidebar', () => {
    function makeSidebarCallbacks(): sidebar.SidebarCallbacks {
      return {
        onAdd: jest.fn(),
        onExport: jest.fn(),
        onImportFile: jest.fn(),
        onClose: jest.fn(),
        onOpenItem: jest.fn(),
      };
    }

    it("stacks above the sidebar's own host, not just above plain page content", () => {
      sidebar.initSidebar(makeSidebarCallbacks());
      modal.openModal(makeItem(), makeCallbacks());

      const sidebarHost = document.getElementById('annotator-sidebar-host');
      const modalHostEl = getHost();
      expect(sidebarHost).not.toBeNull();
      expect(modalHostEl).not.toBeNull();

      const sidebarZ = Number(sidebarHost!.style.zIndex);
      const modalZ = Number(modalHostEl!.style.zIndex);
      expect(sidebarZ).toBeGreaterThan(0);
      expect(modalZ).toBeGreaterThan(sidebarZ);
    });

    it('reserves the sidebar strip: the backdrop stops at the live sidebar width instead of covering the full viewport', () => {
      modal.openModal(makeItem(), makeCallbacks());

      const styleText = shadowRoot().querySelector('style')!.textContent ?? '';
      // Live value (sidebar.ts sets the custom property on <html> and it
      // inherits in here), with the current width baked in as the fallback —
      // never a hardcoded constant, since the sidebar is user-resizable.
      expect(styleText).toContain(
        `right: var(--annotator-sidebar-width, ${getSidebarWidth()}px)`,
      );
      // Guards against a regression back to a full-bleed `inset: 0` backdrop.
      expect(styleText).not.toMatch(/\.backdrop\s*\{[^}]*inset:\s*0/);
    });

    it('the backdrop inset follows a sidebar resize rather than a build-time constant', () => {
      const original = getSidebarWidth();
      try {
        setSidebarWidth(140, { persist: false });
        modal.openModal(makeItem(), makeCallbacks());

        const styleText = shadowRoot().querySelector('style')!.textContent ?? '';
        expect(styleText).toContain('right: var(--annotator-sidebar-width, 140px)');
      } finally {
        setSidebarWidth(original, { persist: false });
      }
    });
  });

  // Design spec §3.3 regression coverage: the modal used to hardcode a black
  // header bar, a #141414 panel and a #FB645A delete button rather than
  // pulling from the shared Salamander tokens (theme.ts). These guard
  // against sliding back to those v1 literals now that every surface is
  // supposed to read from `var(--sal-*)` instead.
  describe('design spec §3.3 — Salamander tokens instead of v1 hardcoded colours', () => {
    it('panel, header and delete button reference --sal- tokens, not v1 literals', () => {
      modal.openModal(makeItem(), makeCallbacks());
      const styleText = shadowRoot().querySelector('style')!.textContent ?? '';

      expect(styleText).toContain('var(--sal-surface)');
      expect(styleText).toContain('var(--sal-backdrop)');
      expect(styleText).toContain('var(--sal-shadow-pop)');
      expect(styleText).toContain('var(--sal-danger-soft)');

      // v1 literals that must be gone.
      expect(styleText).not.toContain('#141414');
      expect(styleText).not.toContain('#FB645A');
      expect(styleText).not.toContain('rgba(0, 0, 0, 0.72)');
      expect(styleText).not.toContain('background: #000000');
    });

    it('renders the note editor as a merged textarea + footer bar (§3.2 comment-box shape)', () => {
      modal.openModal(makeItem(), makeCallbacks());

      const editor = shadowRoot().querySelector('.note-editor') as HTMLElement;
      expect(editor).not.toBeNull();

      const textarea = editor.querySelector('textarea.note-input');
      const footerBar = editor.querySelector('.footer-bar');
      expect(textarea).not.toBeNull();
      expect(footerBar).not.toBeNull();

      // Error text on the left, delete on the right, both inside the bar.
      expect(footerBar!.querySelector('.inline-error')).not.toBeNull();
      expect(footerBar!.querySelector('.delete-btn')).not.toBeNull();
    });

    it('delete is a 36px danger button filling the 36px footer bar', () => {
      modal.openModal(makeItem(), makeCallbacks());
      const styleText = shadowRoot().querySelector('style')!.textContent ?? '';
      const rule = (sel: string) =>
        styleText.match(new RegExp(`\\n\\s*${sel.replace('.', '\\.')}\\s*\\{[^}]*\\}`))?.[0] ?? '';
      expect(rule('.delete-btn')).toMatch(/height:\s*36px/);
      expect(rule('.footer-bar')).toMatch(/height:\s*36px/);
      // content-box so the 1px divider sits outside the 36px, like the add-mode footer.
      expect(rule('.footer-bar')).toMatch(/box-sizing:\s*content-box/);
    });

    it('close button keeps its aria-label/title and renders an 18x18 stroked icon', () => {
      modal.openModal(makeItem(), makeCallbacks());

      const closeBtn = shadowRoot().querySelector('.close-btn') as HTMLButtonElement;
      expect(closeBtn.getAttribute('aria-label')).toBe('close');
      expect(closeBtn.title).toBe('close');

      const svg = closeBtn.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg!.getAttribute('stroke-width')).toBe('1.8');
      expect(svg!.getAttribute('stroke-linecap')).toBe('round');
    });
  });
});

describe('modal accessibility', () => {
  afterEach(() => {
    modal._destroyForTests();
    sidebar.destroySidebar();
  });

  it('the dialog is named by its title and the note textarea has a label', () => {
    modal.openModal(makeItem({ id: 4 }), makeCallbacks());
    const dialog = shadowRoot().querySelector('[role="dialog"]') as HTMLElement;
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(shadowRoot().getElementById(labelledBy!)!.textContent).toBe('feedback #4');
    expect(shadowRoot().querySelector('textarea')!.getAttribute('aria-label')).toBe('note');
  });

  it('moves focus into the dialog (the note) on open', () => {
    modal.openModal(makeItem(), makeCallbacks());
    expect(shadowRoot().activeElement).toBe(shadowRoot().querySelector('textarea'));
  });

  it('tearing down while the note is focused and edited never fires a save', () => {
    const cbs = makeCallbacks();
    modal.openModal(makeItem(), cbs);
    const ta = shadowRoot().querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'edited';
    modal.openModal(makeItem({ id: 2 }), makeCallbacks()); // replaces without saving
    ta.dispatchEvent(new FocusEvent('blur'));
    expect(cbs.onSaveNote).not.toHaveBeenCalled();
  });
});

