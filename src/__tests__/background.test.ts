// Service worker tests — injection/lifecycle handlers, sidebar
// session-state wiring, and the throttled capture-and-crop pipeline.
//
// background.ts registers its listeners (chrome.action.onClicked etc.) at
// *import* time, so every chrome.* surface it touches must exist before the
// module loads. setup.ts's base mock (chrome.storage/.tabs.query/.runtime)
// is already installed globally by the time this file runs; the additional
// surfaces background.ts needs (action, scripting, tabs.sendMessage/onUpdated/
// onRemoved/captureVisibleTab, runtime.onMessage) are layered on
// here, then the module is `require`'d so the extra mocks are in place
// first — a static top-of-file `import` would run before that setup.
//
// jsdom has no OffscreenCanvas/createImageBitmap (the crop pipeline's
// gotcha #4 tools), so those are faked too: the fakes record what they were
// asked to draw rather than actually rendering, which is enough to verify
// the crop math and error propagation without a real browser.

import * as imageStore from '../imageStore';
import * as storage from '../storage';
import type { CaptureMessage, NewFeedbackItem } from '../messages';

jest.mock('../imageStore');
jest.mock('../storage', () => ({
  isSidebarOpen: jest.fn(),
  setSidebarOpen: jest.fn().mockResolvedValue(undefined),
  clearSidebarState: jest.fn().mockResolvedValue(undefined),
  getNextItemId: jest.fn().mockResolvedValue(1),
  addItem: jest.fn().mockResolvedValue(undefined),
  getPageItems: jest.fn().mockResolvedValue([]),
  updateItem: jest.fn().mockResolvedValue(true),
  updateNote: jest.fn().mockResolvedValue(undefined),
  deleteItem: jest.fn().mockResolvedValue(undefined),
  getPenColor: jest.fn().mockResolvedValue(null),
  setPenColor: jest.fn().mockResolvedValue(undefined),
}));

type Cb<T> = (result: T) => void;

let sendMessageMock: jest.Mock;
let executeScriptMock: jest.Mock;
let captureVisibleTabMock: jest.Mock;

// jsdom's Blob implementation has no arrayBuffer()/text()/stream() at all
// (real browsers, including the extension service worker, fully support
// it) — a minimal stand-in with just the shape background.ts needs keeps
// these tests from depending on a jsdom gap that has nothing to do with the
// code under test.
class FakeBlob {
  constructor(private readonly bytes: number[], public readonly type: string) {}
  async arrayBuffer(): Promise<ArrayBuffer> {
    return new Uint8Array(this.bytes).buffer;
  }
}

class FakeOffscreenCanvas {
  /** Every drawImage() call of the current test, in order: the full-resolution
   *  crop first, then the downscaled thumbnail. */
  static drawCalls: unknown[][] = [];
  static shouldFailDraw = false;
  static lastConvertOptions: unknown = null;
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  static get lastDrawArgs(): unknown[] | null {
    return FakeOffscreenCanvas.drawCalls[FakeOffscreenCanvas.drawCalls.length - 1] ?? null;
  }
  /** The first drawImage call — the full-resolution crop, which is the one the
   *  pixel-accuracy assertions care about. */
  static get cropDrawArgs(): unknown[] | null {
    return FakeOffscreenCanvas.drawCalls[0] ?? null;
  }
  getContext() {
    return {
      imageSmoothingQuality: 'low',
      drawImage: (...args: unknown[]) => {
        if (FakeOffscreenCanvas.shouldFailDraw) throw new Error('draw failed');
        FakeOffscreenCanvas.drawCalls.push(args);
      },
    };
  }
  async convertToBlob(options?: unknown): Promise<Blob> {
    FakeOffscreenCanvas.lastConvertOptions = options;
    return new FakeBlob([1, 2, 3, 4], 'image/png') as unknown as Blob;
  }
}

/** The decoded capture. Dimensions are settable per-test so the DPR/zoom
 *  matrix can drive the real crop path, not just the pure helper. */
const fakeBitmap = { width: 1024, height: 768, close: jest.fn() };

function setCaptureImageSize(width: number, height: number): void {
  fakeBitmap.width = width;
  fakeBitmap.height = height;
}

function installChromeMocks(): void {
  const c = global.chrome as unknown as Record<string, any>;

  c.action = { onClicked: { addListener: jest.fn() } };
  c.scripting = { executeScript: (executeScriptMock = jest.fn().mockResolvedValue(undefined)) };

  sendMessageMock = jest.fn(
    (_tabId: number, _message: unknown, callback?: Cb<{ alive: boolean }>) => {
      callback?.({ alive: true });
    },
  );
  captureVisibleTabMock = jest.fn(
    (_windowId: number, _opts: unknown, callback: Cb<string>) => {
      callback('data:image/png;base64,ZnVsbC1pbWFnZQ==');
    },
  );

  c.tabs = {
    ...(c.tabs ?? {}),
    sendMessage: sendMessageMock,
    captureVisibleTab: captureVisibleTabMock,
    onUpdated: { addListener: jest.fn() },
    onRemoved: { addListener: jest.fn() },
  };

  c.runtime = {
    ...(c.runtime ?? {}),
    lastError: null,
    onMessage: { addListener: jest.fn() },
  };
}

function installCropGlobals(): void {
  (global as any).OffscreenCanvas = FakeOffscreenCanvas;
  (global as any).createImageBitmap = jest.fn(async (blob: Blob) => {
    decodedBlobs.push(blob);
    return fakeBitmap;
  });
  // Regression guard, not a stub: the service worker must never call fetch().
  // manifest.json's CSP is `connect-src 'none'`, which applies to the MV3
  // service worker, so `fetch(dataUrl)` — the obvious way to turn a capture
  // into a Blob — is blocked at runtime even though the URL is a data: one.
  // A mock that *satisfied* fetch is exactly what let that bug ship green.
  (global as any).fetch = jest.fn(() => {
    throw new Error('fetch() is blocked by connect-src \'none\' in the service worker');
  });
  if (typeof (global as any).btoa === 'undefined') {
    (global as any).btoa = (s: string) => Buffer.from(s, 'binary').toString('base64');
  }
  if (typeof (global as any).atob === 'undefined') {
    (global as any).atob = (s: string) => Buffer.from(s, 'base64').toString('binary');
  }
}

/** Every Blob handed to createImageBitmap this test, so the decode path can be
 *  asserted on without a real image decoder. */
const decodedBlobs: Blob[] = [];

installChromeMocks();
installCropGlobals();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const background = require('../background') as typeof import('../background');

const mockedImageStore = imageStore as jest.Mocked<typeof imageStore>;
const mockedStorage = storage as jest.Mocked<typeof storage>;

function makeSender(tabId?: number, windowId = 7): chrome.runtime.MessageSender {
  if (tabId === undefined) return {};
  return { tab: { id: tabId, windowId } as chrome.tabs.Tab };
}

/** A CAPTURE message whose CSS viewport matches the default 1024x768 fake
 *  capture at dpr 1 — i.e. device px and CSS px are 1:1, so a test that only
 *  cares about plumbing can assert on the rect it passed in. */
function makeCaptureMessage(
  rect: { x: number; y: number; width: number; height: number },
  overrides: Partial<CaptureMessage> = {},
): CaptureMessage {
  return {
    type: 'CAPTURE',
    rect,
    viewport: { width: 1024, height: 768 },
    contentViewport: { width: 1024, height: 768 },
    dpr: 1,
    ...overrides,
  };
}

function makeNewItem(): NewFeedbackItem {
  return {
    pageUrl: 'https://example.com/a',
    normalisedUrl: 'example.com/a',
    note: 'a note',
    createdAt: '2026-01-01T00:00:00.000Z',
    selectionRect: { x: 1, y: 2, width: 3, height: 4 },
    viewport: { width: 1024, height: 768 },
    dpr: 1,
    screenshotKey: 'key-1',
    thumbnailDataUrl: 'data:image/jpeg;base64,AAAA',
    context: {} as NewFeedbackItem['context'],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (global.chrome as any).runtime.lastError = null;
  FakeOffscreenCanvas.drawCalls = [];
  FakeOffscreenCanvas.shouldFailDraw = false;
  FakeOffscreenCanvas.lastConvertOptions = null;
  decodedBlobs.length = 0;
  setCaptureImageSize(1024, 768);
  background._resetCaptureQueueForTests();
  background._resetSaveQueueForTests();
  mockedImageStore.putImage.mockResolvedValue(undefined);
  mockedImageStore.deleteImage.mockResolvedValue(undefined);
  mockedStorage.getNextItemId.mockResolvedValue(1);
  mockedStorage.addItem.mockResolvedValue(undefined);
  mockedStorage.getPageItems.mockResolvedValue([]);
  mockedStorage.updateItem.mockResolvedValue(true);
  mockedStorage.updateNote.mockResolvedValue(undefined);
  mockedStorage.deleteItem.mockResolvedValue(undefined);
  sendMessageMock.mockImplementation(
    (_tabId: number, _message: unknown, callback?: Cb<{ alive: boolean }>) => {
      callback?.({ alive: true });
    },
  );
  captureVisibleTabMock.mockImplementation(
    (_windowId: number, _opts: unknown, callback: Cb<string>) => {
      callback('data:image/png;base64,ZnVsbC1pbWFnZQ==');
    },
  );
  executeScriptMock.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// handleActionClicked
// ---------------------------------------------------------------------------

describe('handleActionClicked', () => {
  it('does nothing for a tab with no id', async () => {
    await background.handleActionClicked({} as chrome.tabs.Tab);
    expect(executeScriptMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('injects and activates when the content script is not already alive', async () => {
    sendMessageMock.mockImplementationOnce((_tabId, _msg, callback?: Cb<any>) => callback?.(undefined));
    await background.handleActionClicked({ id: 5 } as chrome.tabs.Tab);
    expect(executeScriptMock).toHaveBeenCalledWith({
      target: { tabId: 5 },
      files: ['dist/content.js'],
    });
    expect(sendMessageMock).toHaveBeenLastCalledWith(
      5,
      { type: 'ACTIVATE', tabId: 5 },
      expect.any(Function),
    );
  });

  it('sends ICON_CLICKED without re-injecting when already alive', async () => {
    await background.handleActionClicked({ id: 5 } as chrome.tabs.Tab);
    expect(executeScriptMock).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledWith(5, { type: 'ICON_CLICKED' }, expect.any(Function));
  });

  it('swallows injection failure on restricted pages (§5 #9) without throwing', async () => {
    sendMessageMock.mockImplementationOnce((_tabId, _msg, callback?: Cb<any>) => callback?.(undefined));
    executeScriptMock.mockRejectedValueOnce(new Error('cannot access chrome:// URL'));
    await expect(background.handleActionClicked({ id: 9 } as chrome.tabs.Tab)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// handleTabUpdated
// ---------------------------------------------------------------------------

describe('handleTabUpdated', () => {
  it('ignores non-complete navigation events', async () => {
    await background.handleTabUpdated(5, { status: 'loading' } as chrome.tabs.TabChangeInfo);
    expect(mockedStorage.isSidebarOpen).not.toHaveBeenCalled();
  });

  it('does not re-inject when the sidebar was not open', async () => {
    mockedStorage.isSidebarOpen.mockResolvedValue(false);
    await background.handleTabUpdated(5, { status: 'complete' } as chrome.tabs.TabChangeInfo);
    expect(executeScriptMock).not.toHaveBeenCalled();
  });

  it('re-injects and re-activates when the sidebar was open (§1.1)', async () => {
    mockedStorage.isSidebarOpen.mockResolvedValue(true);
    await background.handleTabUpdated(5, { status: 'complete' } as chrome.tabs.TabChangeInfo);
    expect(executeScriptMock).toHaveBeenCalledWith({
      target: { tabId: 5 },
      files: ['dist/content.js'],
    });
    expect(sendMessageMock).toHaveBeenCalledWith(5, { type: 'ACTIVATE', tabId: 5 }, expect.any(Function));
  });

  it('clears sidebar state when re-injection fails on a now-restricted page', async () => {
    mockedStorage.isSidebarOpen.mockResolvedValue(true);
    executeScriptMock.mockRejectedValueOnce(new Error('cannot access'));
    await background.handleTabUpdated(5, { status: 'complete' } as chrome.tabs.TabChangeInfo);
    expect(mockedStorage.clearSidebarState).toHaveBeenCalledWith(5);
  });
});

// ---------------------------------------------------------------------------
// handleTabRemoved
// ---------------------------------------------------------------------------

describe('handleTabRemoved', () => {
  it('clears sidebar session state for the closed tab', () => {
    background.handleTabRemoved(42);
    expect(mockedStorage.clearSidebarState).toHaveBeenCalledWith(42);
  });
});

// ---------------------------------------------------------------------------
// handleRuntimeMessage — dispatch
// ---------------------------------------------------------------------------

describe('handleRuntimeMessage', () => {
  it('persists sidebar-opened state and does not keep the channel open', () => {
    const sendResponse = jest.fn();
    const keepOpen = background.handleRuntimeMessage(
      { type: 'SIDEBAR_OPENED' },
      makeSender(3),
      sendResponse,
    );
    expect(mockedStorage.setSidebarOpen).toHaveBeenCalledWith(3);
    expect(keepOpen).toBe(false);
  });

  it('clears sidebar-closed state', () => {
    const keepOpen = background.handleRuntimeMessage(
      { type: 'SIDEBAR_CLOSED' },
      makeSender(3),
      jest.fn(),
    );
    expect(mockedStorage.clearSidebarState).toHaveBeenCalledWith(3);
    expect(keepOpen).toBe(false);
  });

  it('ignores messages it does not own (PING/ACTIVATE/ICON_CLICKED)', () => {
    const keepOpen = background.handleRuntimeMessage({ type: 'PING' }, makeSender(3), jest.fn());
    expect(keepOpen).toBe(false);
    expect(mockedStorage.setSidebarOpen).not.toHaveBeenCalled();
  });

  it('dispatches CAPTURE asynchronously and keeps the channel open', async () => {
    const sendResponse = jest.fn();
    const captureMessage = makeCaptureMessage({ x: 0, y: 0, width: 10, height: 10 });
    const keepOpen = background.handleRuntimeMessage(captureMessage, makeSender(3), sendResponse);
    expect(keepOpen).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0)); // flush the capture's internal awaits
    expect(sendResponse).toHaveBeenCalled();
    expect(sendResponse.mock.calls[0][0]).toMatchObject({ ok: true });
  });

  it('dispatches SAVE_ITEM asynchronously and keeps the channel open', async () => {
    const sendResponse = jest.fn();
    const keepOpen = background.handleRuntimeMessage(
      { type: 'SAVE_ITEM', domain: 'example.com', item: makeNewItem() },
      makeSender(3),
      sendResponse,
    );
    expect(keepOpen).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendResponse.mock.calls[0][0]).toMatchObject({ ok: true });
  });

  it('dispatches GET_PAGE_ITEMS asynchronously and keeps the channel open', async () => {
    const sendResponse = jest.fn();
    const keepOpen = background.handleRuntimeMessage(
      { type: 'GET_PAGE_ITEMS', domain: 'example.com', normalisedUrl: 'example.com/a' },
      makeSender(3),
      sendResponse,
    );
    expect(keepOpen).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendResponse.mock.calls[0][0]).toMatchObject({ ok: true, items: [] });
  });

  it('dispatches GET_IMAGE asynchronously and keeps the channel open', async () => {
    mockedImageStore.getImage.mockResolvedValue('data:image/png;base64,ZnVsbA==');
    const sendResponse = jest.fn();
    const keepOpen = background.handleRuntimeMessage(
      { type: 'GET_IMAGE', screenshotKey: 'key-1' },
      makeSender(3),
      sendResponse,
    );
    expect(keepOpen).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendResponse.mock.calls[0][0]).toEqual({ ok: true, dataUrl: 'data:image/png;base64,ZnVsbA==' });
  });

  it('dispatches UPDATE_ITEM asynchronously and keeps the channel open', async () => {
    const sendResponse = jest.fn();
    const keepOpen = background.handleRuntimeMessage(
      { type: 'UPDATE_ITEM', domain: 'example.com', normalisedUrl: 'example.com/a', itemId: 1, patch: { note: 'edited' } },
      makeSender(3),
      sendResponse,
    );
    expect(keepOpen).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendResponse.mock.calls[0][0]).toEqual({ ok: true });
  });

  it('dispatches UPDATE_NOTE asynchronously and keeps the channel open', async () => {
    const sendResponse = jest.fn();
    const keepOpen = background.handleRuntimeMessage(
      { type: 'UPDATE_NOTE', domain: 'example.com', normalisedUrl: 'example.com/a', itemId: 1, note: 'edited' },
      makeSender(3),
      sendResponse,
    );
    expect(keepOpen).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendResponse.mock.calls[0][0]).toEqual({ ok: true });
  });

  it('dispatches DELETE_ITEM asynchronously and keeps the channel open', async () => {
    const sendResponse = jest.fn();
    const keepOpen = background.handleRuntimeMessage(
      { type: 'DELETE_ITEM', domain: 'example.com', normalisedUrl: 'example.com/a', itemId: 1 },
      makeSender(3),
      sendResponse,
    );
    expect(keepOpen).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendResponse.mock.calls[0][0]).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// handleCapture — the capture/crop/persist pipeline
// ---------------------------------------------------------------------------

describe('handleCapture', () => {
  const rect = { x: 12, y: 34, width: 200, height: 150 };
  const message = makeCaptureMessage(rect);

  it('returns CAPTURE_FAILED when the sender has no tab (e.g. from a popup)', async () => {
    const result = await background.handleCapture(message, {});
    expect(result).toEqual({
      ok: false,
      code: 'CAPTURE_FAILED',
      message: "couldn't capture a screenshot here. try again.",
    });
  });

  it('captures, crops to the requested rect, and persists the blob (§1.2 step 2)', async () => {
    const result = await background.handleCapture(message, makeSender(5, 77));

    expect(captureVisibleTabMock).toHaveBeenCalledWith(77, { format: 'png' }, expect.any(Function));
    // drawImage(bitmap, sx, sy, sw, sh, dx, dy, dw, dh) — at dpr 1 the source
    // rect must be exactly what was requested, destination is the full
    // cropped canvas (§1.3: no downscaling of the stored capture).
    expect(FakeOffscreenCanvas.cropDrawArgs).toEqual([
      expect.anything(),
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      0,
      0,
      rect.width,
      rect.height,
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(mockedImageStore.putImage).toHaveBeenCalledWith(
        result.screenshotKey,
        expect.stringMatching(/^data:image\/png;base64,/),
      );
      // The full-resolution PNG is persisted, never returned: only the key and
      // the small thumbnail cross the messaging boundary (gotcha #2).
      expect(Object.keys(result).sort()).toEqual(['ok', 'screenshotKey', 'thumbnailDataUrl']);
    }
  });

  it('decodes the capture without fetch() — connect-src \'none\' blocks it in the worker', async () => {
    const result = await background.handleCapture(message, makeSender(5, 77));

    expect(result.ok).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
    // captureVisibleTab's "full-image" payload reached the decoder intact.
    expect(decodedBlobs).toHaveLength(1);
    expect(decodedBlobs[0].type).toBe('image/png');
    expect(decodedBlobs[0].size).toBe('full-image'.length);
  });

  it('also renders a downscaled thumbnail from the same decoded bitmap', async () => {
    // A 2x display: the 200x150 CSS selection is a 400x300 device-px crop,
    // which is under the 480px thumbnail cap, so the thumbnail is 1:1 too.
    setCaptureImageSize(2048, 1536);
    const result = await background.handleCapture(
      makeCaptureMessage(rect, { dpr: 2 }),
      makeSender(5, 77),
    );

    expect(FakeOffscreenCanvas.drawCalls).toHaveLength(2);
    // Both draws read the same source rect; only the destination differs.
    expect(FakeOffscreenCanvas.drawCalls[0].slice(1, 5)).toEqual([24, 68, 400, 300]);
    expect(FakeOffscreenCanvas.drawCalls[1].slice(1, 5)).toEqual([24, 68, 400, 300]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(typeof result.thumbnailDataUrl).toBe('string');
  });

  it('downscales an over-large crop for the thumbnail but stores the capture at native size', async () => {
    setCaptureImageSize(2048, 1536);
    // 800x600 CSS at dpr 2 => 1600x1200 device px; longest edge capped at 480.
    await background.handleCapture(
      makeCaptureMessage({ x: 0, y: 0, width: 800, height: 600 }, { dpr: 2 }),
      makeSender(5, 77),
    );

    expect(FakeOffscreenCanvas.drawCalls[0].slice(5)).toEqual([0, 0, 1600, 1200]);
    expect(FakeOffscreenCanvas.drawCalls[1].slice(5)).toEqual([0, 0, 480, 360]);
  });

  it('never creates a partial item when the underlying capture fails (§1.3, §5 #8)', async () => {
    captureVisibleTabMock.mockImplementationOnce((_w: number, _o: unknown, cb: Cb<string>) => {
      (global.chrome as any).runtime.lastError = { message: 'capture rate limited' };
      cb('');
    });
    const result = await background.handleCapture(message, makeSender(5, 77));
    expect(result).toEqual({
      ok: false,
      code: 'RATE_LIMITED',
      message: "couldn't capture a screenshot here. try again.",
    });
    expect(mockedImageStore.putImage).not.toHaveBeenCalled();
  });

  it('surfaces a clean error (not a crash) when cropping fails', async () => {
    FakeOffscreenCanvas.shouldFailDraw = true;
    const result = await background.handleCapture(message, makeSender(5, 77));
    expect(result).toEqual({
      ok: false,
      code: 'CROP_FAILED',
      message: "couldn't capture a screenshot here. try again.",
    });
    expect(mockedImageStore.putImage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// computeDeviceRect — the pixel-critical conversion (§1.3, §6 #4, §6 #5)
//
// This is the crop's verification matrix (1x/2x display,
// 100%/80%/150% zoom, selections at every viewport edge, scrolled pages),
// expressed against the pure function rather than a real browser: the selection
// is in viewport CSS px, the capture is in device px, and every case below
// asserts the exact device rectangle that must be cut out.
// ---------------------------------------------------------------------------

describe('computeDeviceRect', () => {
  /** Shorthand: no scrollbar, so both CSS viewport candidates agree. */
  function convert(
    rect: { x: number; y: number; width: number; height: number },
    cssWidth: number,
    cssHeight: number,
    dpr: number,
    imageWidth = Math.round(cssWidth * dpr),
    imageHeight = Math.round(cssHeight * dpr),
  ) {
    return background.computeDeviceRect(
      rect,
      { width: cssWidth, height: cssHeight },
      { width: cssWidth, height: cssHeight },
      dpr,
      imageWidth,
      imageHeight,
    );
  }

  const selection = { x: 100, y: 200, width: 300, height: 150 };

  it('is the identity mapping on a 1x display at 100% zoom', () => {
    expect(convert(selection, 1000, 800, 1)).toEqual(selection);
  });

  it('scales by 2 on a retina display (§6 #4)', () => {
    expect(convert(selection, 1000, 800, 2)).toEqual({ x: 200, y: 400, width: 600, height: 300 });
  });

  it('scales by 3 on a 3x display', () => {
    expect(convert(selection, 1000, 800, 3)).toEqual({ x: 300, y: 600, width: 900, height: 450 });
  });

  it('handles 150% browser zoom on a 1x display (§6 #5)', () => {
    // Chrome folds zoom into devicePixelRatio: a 1280px-wide window at 150%
    // reports innerWidth 853 (the rounded 1280/1.5) and dpr 1.5.
    expect(convert(selection, 853, 512, 1.5, 1280, 768)).toEqual({
      x: 150,
      y: 300,
      width: 450,
      height: 225,
    });
  });

  it('handles 80% browser zoom (a fractional scale below 1)', () => {
    expect(convert(selection, 1600, 1000, 0.8, 1280, 800)).toEqual({
      x: 80,
      y: 160,
      width: 240,
      height: 120,
    });
  });

  it('handles a 2x display at 150% zoom (effective scale 3)', () => {
    expect(convert(selection, 853, 512, 3, 2560, 1536)).toEqual({
      x: 300,
      y: 600,
      width: 900,
      height: 450,
    });
  });

  it('prefers the scrollbar-inclusive width when the capture includes the scrollbar', () => {
    // innerWidth 1000, clientWidth 985 (15px scrollbar), image 1000 device px:
    // dividing by clientWidth would stretch everything by 1.5%.
    const result = background.computeDeviceRect(
      { x: 900, y: 0, width: 80, height: 50 },
      { width: 1000, height: 800 },
      { width: 985, height: 800 },
      1,
      1000,
      800,
    );
    expect(result).toEqual({ x: 900, y: 0, width: 80, height: 50 });
  });

  it('prefers the scrollbar-exclusive width when the capture omits the scrollbar', () => {
    const result = background.computeDeviceRect(
      { x: 900, y: 0, width: 80, height: 50 },
      { width: 1000, height: 800 },
      { width: 985, height: 800 },
      1,
      985,
      800,
    );
    expect(result).toEqual({ x: 900, y: 0, width: 80, height: 50 });
  });

  it('lands exactly on the image edge for a selection flush against the viewport edge', () => {
    // Bottom-right corner selection on a 2x display.
    expect(convert({ x: 800, y: 700, width: 200, height: 100 }, 1000, 800, 2)).toEqual({
      x: 1600,
      y: 1400,
      width: 400,
      height: 200,
    });
    // Top-left corner.
    expect(convert({ x: 0, y: 0, width: 20, height: 20 }, 1000, 800, 2)).toEqual({
      x: 0,
      y: 0,
      width: 40,
      height: 40,
    });
  });

  it('clamps a rect that would read past the image instead of sampling transparency', () => {
    expect(convert({ x: 900, y: 700, width: 300, height: 300 }, 1000, 800, 2)).toEqual({
      x: 1800,
      y: 1400,
      width: 200,
      height: 200,
    });
  });

  it('keeps sub-pixel rects at least one device pixel in each dimension', () => {
    const result = convert({ x: 10, y: 10, width: 0, height: 0 }, 1000, 800, 1);
    expect(result.width).toBeGreaterThanOrEqual(1);
    expect(result.height).toBeGreaterThanOrEqual(1);
  });

  it('rounds each edge independently so a fractional rect keeps its size', () => {
    expect(convert({ x: 10.4, y: 10.4, width: 100.2, height: 100.2 }, 1000, 800, 2)).toEqual({
      x: 21,
      y: 21,
      width: 200,
      height: 200,
    });
  });

  it('falls back to devicePixelRatio when the viewport numbers are unusable', () => {
    expect(
      background.computeDeviceRect(selection, undefined, undefined, 2, 2000, 1600),
    ).toEqual({ x: 200, y: 400, width: 600, height: 300 });
    expect(
      background.computeDeviceRect(selection, { width: 0, height: 0 }, undefined, 2, 2000, 1600),
    ).toEqual({ x: 200, y: 400, width: 600, height: 300 });
  });

  it('falls back to 1:1 when neither the viewport nor the dpr is usable', () => {
    expect(background.computeDeviceRect(selection, undefined, undefined, 0, 0, 0)).toEqual(
      selection,
    );
  });
});

describe('computeThumbnailSize', () => {
  it('leaves a small crop untouched', () => {
    expect(background.computeThumbnailSize(400, 300)).toEqual({ width: 400, height: 300 });
  });

  it('caps the longest edge and preserves the aspect ratio', () => {
    expect(background.computeThumbnailSize(1600, 1200)).toEqual({ width: 480, height: 360 });
    expect(background.computeThumbnailSize(600, 1200)).toEqual({ width: 240, height: 480 });
  });

  it('never rounds an extreme aspect ratio down to zero', () => {
    expect(background.computeThumbnailSize(2000, 3)).toEqual({ width: 480, height: 1 });
  });
});

// ---------------------------------------------------------------------------
// handleSaveItem — id allocation and the no-orphan failure path
// ---------------------------------------------------------------------------

describe('handleSaveItem', () => {
  it('assigns the domain-sequential id and stores the item (§1.2)', async () => {
    mockedStorage.getNextItemId.mockResolvedValue(7);
    const response = await background.handleSaveItem({
      type: 'SAVE_ITEM',
      domain: 'example.com',
      item: makeNewItem(),
    });

    expect(response.ok).toBe(true);
    if (response.ok) expect(response.item.id).toBe(7);
    expect(mockedStorage.addItem).toHaveBeenCalledWith(
      'example.com',
      expect.objectContaining({ id: 7, screenshotKey: 'key-1' }),
    );
  });

  it('serialises concurrent saves so two captures cannot share an id', async () => {
    let next = 1;
    mockedStorage.getNextItemId.mockImplementation(async () => next);
    mockedStorage.addItem.mockImplementation(async () => {
      next += 1;
    });

    const responses = await Promise.all([
      background.handleSaveItem({ type: 'SAVE_ITEM', domain: 'example.com', item: makeNewItem() }),
      background.handleSaveItem({ type: 'SAVE_ITEM', domain: 'example.com', item: makeNewItem() }),
      background.handleSaveItem({ type: 'SAVE_ITEM', domain: 'example.com', item: makeNewItem() }),
    ]);

    const ids = responses.map((r) => (r.ok ? r.item.id : -1));
    expect(ids).toEqual([1, 2, 3]);
  });

  it('deletes the already-stored blob when the metadata write fails (§1.5, §1.3)', async () => {
    mockedStorage.addItem.mockRejectedValue(new Error('quota exceeded'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await background.handleSaveItem({
      type: 'SAVE_ITEM',
      domain: 'example.com',
      item: makeNewItem(),
    });

    expect(response).toEqual({
      ok: false,
      message: "couldn't capture a screenshot here. try again.",
    });
    expect(mockedImageStore.deleteImage).toHaveBeenCalledWith('key-1');
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// mapCaptureError — pure error classification
// ---------------------------------------------------------------------------

describe('mapCaptureError', () => {
  it('classifies a generic failure as CAPTURE_FAILED', () => {
    expect(background.mapCaptureError(new Error('boom'))).toEqual({
      ok: false,
      code: 'CAPTURE_FAILED',
      message: "couldn't capture a screenshot here. try again.",
    });
  });

  it('classifies a rate-limit-shaped message as RATE_LIMITED', () => {
    expect(background.mapCaptureError(new Error('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND'))).toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('always uses the exact §5 #8 lowercase message regardless of the underlying error', () => {
    const result = background.mapCaptureError('a raw non-Error thrown value');
    expect(result.message).toBe("couldn't capture a screenshot here. try again.");
  });
});

// ---------------------------------------------------------------------------
// enqueueCapture — throttle queue (§2, §6 #8: ~2 captures/second)
// ---------------------------------------------------------------------------

describe('enqueueCapture throttle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    background._resetCaptureQueueForTests();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('spaces five rapid-fire captures at least 500ms apart', async () => {
    const timestamps: number[] = [];
    const fn = jest.fn(async () => {
      timestamps.push(Date.now());
      return 'ok';
    });

    const results = Promise.all([1, 2, 3, 4, 5].map(() => background.enqueueCapture(fn)));

    await jest.advanceTimersByTimeAsync(3000);
    await results;

    expect(fn).toHaveBeenCalledTimes(5);
    expect(timestamps).toHaveLength(5);
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i] - timestamps[i - 1]).toBeGreaterThanOrEqual(500);
    }
  });

  it('does not let one rejected capture block the ones queued behind it', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('first one fails'))
      .mockResolvedValueOnce('second succeeds');

    const first = background.enqueueCapture(fn);
    const second = background.enqueueCapture(fn);

    await jest.advanceTimersByTimeAsync(2000);

    await expect(first).rejects.toThrow('first one fails');
    await expect(second).resolves.toBe('second succeeds');
  });
});

// ---------------------------------------------------------------------------
// Thumbnail list + enlarged view handlers (§1.5, §3.3)
// ---------------------------------------------------------------------------

describe('handleGetPageItems', () => {
  it('returns storage.ts\'s items for the domain/url unchanged', async () => {
    const items = [{ id: 1 } as any];
    mockedStorage.getPageItems.mockResolvedValue(items);

    const response = await background.handleGetPageItems({
      type: 'GET_PAGE_ITEMS',
      domain: 'example.com',
      normalisedUrl: 'example.com/a',
    });

    expect(mockedStorage.getPageItems).toHaveBeenCalledWith('example.com', 'example.com/a');
    expect(response).toEqual({ ok: true, items });
  });

  it('maps a storage read failure to a lowercase error, not a throw', async () => {
    mockedStorage.getPageItems.mockRejectedValue(new Error('boom'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await background.handleGetPageItems({
      type: 'GET_PAGE_ITEMS',
      domain: 'example.com',
      normalisedUrl: 'example.com/a',
    });

    expect(response).toEqual({
      ok: false,
      message: "couldn't load feedback for this page. try again.",
    });
    warn.mockRestore();
  });
});

describe('handleGetImage', () => {
  it('returns the stored data url for the key', async () => {
    mockedImageStore.getImage.mockResolvedValue('data:image/png;base64,ZnVsbA==');

    const response = await background.handleGetImage({ type: 'GET_IMAGE', screenshotKey: 'key-1' });

    expect(mockedImageStore.getImage).toHaveBeenCalledWith('key-1');
    expect(response).toEqual({ ok: true, dataUrl: 'data:image/png;base64,ZnVsbA==' });
  });

  it('reports failure (lowercase) when the key has no stored image', async () => {
    mockedImageStore.getImage.mockResolvedValue(null);

    const response = await background.handleGetImage({ type: 'GET_IMAGE', screenshotKey: 'missing' });

    expect(response).toEqual({ ok: false, message: "couldn't load screenshot. try again." });
  });

  it('maps a thrown error to the same lowercase failure', async () => {
    mockedImageStore.getImage.mockRejectedValue(new Error('idb closed'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await background.handleGetImage({ type: 'GET_IMAGE', screenshotKey: 'key-1' });

    expect(response).toEqual({ ok: false, message: "couldn't load screenshot. try again." });
    warn.mockRestore();
  });
});

describe('handleUpdateItem', () => {
  it('forwards the patch to storage.ts\'s updateItem and reports success', async () => {
    const response = await background.handleUpdateItem({
      type: 'UPDATE_ITEM',
      domain: 'example.com',
      normalisedUrl: 'example.com/a',
      itemId: 3,
      patch: { note: 'edited note' },
    });

    expect(mockedStorage.updateItem).toHaveBeenCalledWith('example.com', 'example.com/a', 3, { note: 'edited note' });
    expect(response).toEqual({ ok: true });
  });

  it('maps a write failure to the same lowercase error as UPDATE_NOTE', async () => {
    mockedStorage.updateItem.mockRejectedValue(new Error('quota exceeded'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await background.handleUpdateItem({
      type: 'UPDATE_ITEM',
      domain: 'example.com',
      normalisedUrl: 'example.com/a',
      itemId: 3,
      patch: { note: 'edited note' },
    });

    expect(response).toEqual({ ok: false, message: "couldn't save note. try again." });
    warn.mockRestore();
  });

  it('shares the save queue with SAVE_ITEM (no overlapping read-modify-write)', async () => {
    const order: string[] = [];
    let releaseAdd!: () => void;
    mockedStorage.addItem.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          order.push('add:start');
          releaseAdd = () => {
            order.push('add:end');
            resolve();
          };
        }),
    );
    mockedStorage.updateItem.mockImplementation(async () => {
      order.push('update');
      return true;
    });

    const save = background.handleSaveItem({ type: 'SAVE_ITEM', domain: 'example.com', item: makeNewItem() });
    const update = background.handleUpdateItem({
      type: 'UPDATE_ITEM',
      domain: 'example.com',
      normalisedUrl: 'example.com/a',
      itemId: 3,
      patch: { note: 'edited' },
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(order).toEqual(['add:start']);

    releaseAdd();
    await Promise.all([save, update]);
    expect(order).toEqual(['add:start', 'add:end', 'update']);
  });
});

describe('handleUpdateNote', () => {
  it('forwards to storage.ts\'s updateNote and reports success', async () => {
    const response = await background.handleUpdateNote({
      type: 'UPDATE_NOTE',
      domain: 'example.com',
      normalisedUrl: 'example.com/a',
      itemId: 3,
      note: 'edited note',
    });

    expect(mockedStorage.updateNote).toHaveBeenCalledWith('example.com', 'example.com/a', 3, 'edited note');
    expect(response).toEqual({ ok: true });
  });

  it('maps a write failure to a lowercase error', async () => {
    mockedStorage.updateNote.mockRejectedValue(new Error('quota exceeded'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await background.handleUpdateNote({
      type: 'UPDATE_NOTE',
      domain: 'example.com',
      normalisedUrl: 'example.com/a',
      itemId: 3,
      note: 'edited note',
    });

    expect(response).toEqual({ ok: false, message: "couldn't save note. try again." });
    warn.mockRestore();
  });
});

describe('handleDeleteItem', () => {
  it('forwards to storage.ts\'s deleteItem (which also drops the blob) and reports success', async () => {
    const response = await background.handleDeleteItem({
      type: 'DELETE_ITEM',
      domain: 'example.com',
      normalisedUrl: 'example.com/a',
      itemId: 5,
    });

    expect(mockedStorage.deleteItem).toHaveBeenCalledWith('example.com', 'example.com/a', 5);
    expect(response).toEqual({ ok: true });
  });

  it('maps a delete failure to a lowercase error', async () => {
    mockedStorage.deleteItem.mockRejectedValue(new Error('boom'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await background.handleDeleteItem({
      type: 'DELETE_ITEM',
      domain: 'example.com',
      normalisedUrl: 'example.com/a',
      itemId: 5,
    });

    expect(response).toEqual({ ok: false, message: "couldn't delete item. try again." });
    warn.mockRestore();
  });
});

describe('domain-record writes share the save queue', () => {
  it('UPDATE_NOTE and DELETE_ITEM wait for an in-flight SAVE_ITEM (no overlapping read-modify-write)', async () => {
    const order: string[] = [];
    let releaseAdd!: () => void;
    mockedStorage.addItem.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          order.push('add:start');
          releaseAdd = () => {
            order.push('add:end');
            resolve();
          };
        }),
    );
    mockedStorage.updateNote.mockImplementation(async () => {
      order.push('update');
    });
    mockedStorage.deleteItem.mockImplementation(async () => {
      order.push('delete');
    });

    const save = background.handleSaveItem({ type: 'SAVE_ITEM', domain: 'example.com', item: makeNewItem() });
    const update = background.handleUpdateNote({
      type: 'UPDATE_NOTE',
      domain: 'example.com',
      normalisedUrl: 'example.com/a',
      itemId: 3,
      note: 'edited',
    });
    const del = background.handleDeleteItem({
      type: 'DELETE_ITEM',
      domain: 'example.com',
      normalisedUrl: 'example.com/a',
      itemId: 5,
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(order).toEqual(['add:start']);

    releaseAdd();
    await Promise.all([save, update, del]);
    expect(order).toEqual(['add:start', 'add:end', 'update', 'delete']);
  });

  it('GET_PAGE_ITEMS reads after a pending UPDATE_NOTE lands (read-after-write)', async () => {
    const order: string[] = [];
    let releaseUpdate!: () => void;
    mockedStorage.updateNote.mockImplementation(
      () => new Promise<void>((resolve) => (releaseUpdate = () => { order.push('update'); resolve(); })),
    );
    mockedStorage.getPageItems.mockImplementation(async () => {
      order.push('read');
      return [];
    });
    const update = background.handleUpdateNote({
      type: 'UPDATE_NOTE', domain: 'example.com', normalisedUrl: 'example.com/a', itemId: 3, note: 'x',
    });
    const read = background.handleGetPageItems({ type: 'GET_PAGE_ITEMS', domain: 'example.com', normalisedUrl: 'example.com/a' });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(order).toEqual([]);
    releaseUpdate();
    await Promise.all([update, read]);
    expect(order).toEqual(['update', 'read']);
  });
});

// ---------------------------------------------------------------------------
// The pencil's colour (design spec §AB) — chrome.storage.session, reached
// through the service worker because content scripts are never granted
// session access (no setAccessLevel anywhere in this extension)
// ---------------------------------------------------------------------------

describe('pencil colour (GET_PEN_COLOR / SET_PEN_COLOR)', () => {
  it('reads back the session\'s colour through the channel', async () => {
    mockedStorage.getPenColor.mockResolvedValue('#E5484D');
    const sendResponse = jest.fn();
    const keepOpen = background.handleRuntimeMessage({ type: 'GET_PEN_COLOR' }, makeSender(3), sendResponse);
    expect(keepOpen).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendResponse).toHaveBeenCalledWith({ color: '#E5484D' });
  });

  it('answers null when nothing was chosen yet, or the stored value is not a palette colour', async () => {
    mockedStorage.getPenColor.mockResolvedValue(null);
    expect(await background.handleGetPenColor()).toEqual({ color: null });
    mockedStorage.getPenColor.mockResolvedValue('#123456');
    expect(await background.handleGetPenColor()).toEqual({ color: null });
    mockedStorage.getPenColor.mockRejectedValue(new Error('session gone'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await background.handleGetPenColor()).toEqual({ color: null });
    warn.mockRestore();
  });

  it('SET_PEN_COLOR is a notification that stores only palette colours', () => {
    mockedStorage.setPenColor.mockResolvedValue(undefined);
    const keepOpen = background.handleRuntimeMessage({ type: 'SET_PEN_COLOR', color: '#1A1712' }, makeSender(3), jest.fn());
    expect(keepOpen).toBe(false);
    expect(mockedStorage.setPenColor).toHaveBeenCalledWith('#1A1712');

    mockedStorage.setPenColor.mockClear();
    background.handleRuntimeMessage({ type: 'SET_PEN_COLOR', color: 'javascript:alert(1)' }, makeSender(3), jest.fn());
    expect(mockedStorage.setPenColor).not.toHaveBeenCalled();
  });
});

describe('an item\'s drawing (design spec §AB)', () => {
  it('SAVE_ITEM stores the drawing inline on the item record, as sent', async () => {
    const drawing = { width: 3, height: 4, strokes: [{ color: '#E8B600', points: [[1, 1], [2, 2]] as [number, number][] }] };
    mockedStorage.getNextItemId.mockResolvedValue(2);
    const response = await background.handleSaveItem({
      type: 'SAVE_ITEM',
      domain: 'example.com',
      item: { ...makeNewItem(), drawing },
    });
    expect(response.ok && response.item.drawing).toEqual(drawing);
    expect(mockedStorage.addItem).toHaveBeenCalledWith('example.com', expect.objectContaining({ id: 2, drawing }));
  });

  it('an item without one is stored without the key', async () => {
    await background.handleSaveItem({ type: 'SAVE_ITEM', domain: 'example.com', item: makeNewItem() });
    expect(mockedStorage.addItem.mock.calls[0][1]).not.toHaveProperty('drawing');
  });
});
