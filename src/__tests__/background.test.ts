// Phase 2: service worker tests — injection/lifecycle handlers, sidebar
// session-state wiring, and the throttled capture-and-crop pipeline.
//
// background.ts registers its listeners (chrome.action.onClicked etc.) at
// *import* time, so every chrome.* surface it touches must exist before the
// module loads. setup.ts's base mock (chrome.storage/.tabs.query/.runtime)
// is already installed globally by the time this file runs; the additional
// surfaces Phase 2 needs (action, scripting, tabs.sendMessage/onUpdated/
// onRemoved/captureVisibleTab, runtime.onMessage/onStartup) are layered on
// here, then the module is `require`'d so the extra mocks are in place
// first — a static top-of-file `import` would run before that setup.
//
// jsdom has no OffscreenCanvas/createImageBitmap (the crop pipeline's
// gotcha #4 tools), so those are faked too: the fakes record what they were
// asked to draw rather than actually rendering, which is enough to verify
// the crop math and error propagation without a real browser.

import * as imageStore from '../imageStore';
import * as storage from '../storage';
import type { CaptureMessage } from '../messages';

jest.mock('../imageStore');
jest.mock('../storage', () => ({
  isSidebarOpen: jest.fn(),
  setSidebarOpen: jest.fn().mockResolvedValue(undefined),
  clearSidebarState: jest.fn().mockResolvedValue(undefined),
  cleanupStaleTabKeys: jest.fn().mockResolvedValue(undefined),
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
  static lastDrawArgs: unknown[] | null = null;
  static shouldFailDraw = false;
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  getContext() {
    return {
      drawImage: (...args: unknown[]) => {
        if (FakeOffscreenCanvas.shouldFailDraw) throw new Error('draw failed');
        FakeOffscreenCanvas.lastDrawArgs = args;
      },
    };
  }
  async convertToBlob(): Promise<Blob> {
    return new FakeBlob([1, 2, 3, 4], 'image/png') as unknown as Blob;
  }
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
    onStartup: { addListener: jest.fn() },
  };
}

function installCropGlobals(): void {
  (global as any).OffscreenCanvas = FakeOffscreenCanvas;
  (global as any).createImageBitmap = jest.fn(async () => ({ close: jest.fn() }));
  (global as any).fetch = jest.fn(async (_url: string) => ({
    blob: async () => new FakeBlob([9, 9, 9], 'image/png') as unknown as Blob,
  }));
  if (typeof (global as any).btoa === 'undefined') {
    (global as any).btoa = (s: string) => Buffer.from(s, 'binary').toString('base64');
  }
}

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

beforeEach(() => {
  jest.clearAllMocks();
  (global.chrome as any).runtime.lastError = null;
  FakeOffscreenCanvas.lastDrawArgs = null;
  FakeOffscreenCanvas.shouldFailDraw = false;
  background._resetCaptureQueueForTests();
  mockedImageStore.putImage.mockResolvedValue(undefined);
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
// handleTabRemoved / handleStartup
// ---------------------------------------------------------------------------

describe('handleTabRemoved', () => {
  it('clears sidebar session state for the closed tab', () => {
    background.handleTabRemoved(42);
    expect(mockedStorage.clearSidebarState).toHaveBeenCalledWith(42);
  });
});

describe('handleStartup', () => {
  it('runs the legacy activeTab cleanup', async () => {
    await background.handleStartup();
    expect(mockedStorage.cleanupStaleTabKeys).toHaveBeenCalled();
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
    const captureMessage: CaptureMessage = { type: 'CAPTURE', rect: { x: 0, y: 0, width: 10, height: 10 } };
    const keepOpen = background.handleRuntimeMessage(captureMessage, makeSender(3), sendResponse);
    expect(keepOpen).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0)); // flush the capture's internal awaits
    expect(sendResponse).toHaveBeenCalled();
    expect(sendResponse.mock.calls[0][0]).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// handleCapture — the capture/crop/persist pipeline
// ---------------------------------------------------------------------------

describe('handleCapture', () => {
  const rect = { x: 12, y: 34, width: 200, height: 150 };
  const message: CaptureMessage = { type: 'CAPTURE', rect };

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
    // drawImage(bitmap, sx, sy, sw, sh, dx, dy, dw, dh) — source rect must be
    // exactly what was requested, destination is the full cropped canvas.
    expect(FakeOffscreenCanvas.lastDrawArgs).toEqual([
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
      expect(mockedImageStore.putImage).toHaveBeenCalledWith(result.screenshotKey, result.dataUrl);
      expect(result.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    }
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
