// Capture pipeline (content-script half) — src/capture.ts.
//
// Covers the three things that can silently produce a wrong screenshot or a
// half-written item, none of which need a real browser to pin down:
//   1. Coordinate discipline — the crop rect stays in viewport CSS px (no
//      scroll offset ever added), while the archival rect gets one (§1.4D).
//   2. Ordering — the overlay is hidden and a frame is painted *before* the
//      CAPTURE message goes out (§6 #2), and the item is only saved after a
//      successful capture.
//   3. Failure policy — every failure restores the overlay and creates no
//      item (§1.3, §5 #8).

import * as capture from '../capture';
import { CAPTURE_FAILED_MESSAGE } from '../copy';
import type { AddModeResult } from '../addMode';

jest.mock('../contextCapture', () => ({
  captureContext: jest.fn(() => ({
    primaryTarget: { cssSelector: 'main', xpath: '/html/body/main', outerHtmlSnippet: '<main>', truncated: false },
    containedElements: [],
    areaText: 'hello',
    pageMeta: {
      url: 'https://www.example.com/page',
      normalisedUrl: 'example.com/page',
      title: 'page',
      viewport: { width: 1000, height: 800 },
      dpr: 2,
      selectionRect: { x: 0, y: 0, width: 0, height: 0 },
      capturedAt: '2026-01-01T00:00:00.000Z',
    },
  })),
}));

import { captureContext } from '../contextCapture';

const mockedCaptureContext = captureContext as jest.MockedFunction<typeof captureContext>;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type MessageHandler = (message: any) => unknown;

let handler: MessageHandler;
let sendMessageMock: jest.Mock;
let overlay: { hide: jest.Mock; show: jest.Mock };
/** Records hide/show/message ordering so "hidden before capture" is testable. */
let timeline: string[];

const selection: AddModeResult = {
  rect: { x: 100, y: 50, width: 200, height: 150 },
  note: 'this button is misaligned',
};

function setGeometry(opts: {
  innerWidth?: number;
  innerHeight?: number;
  dpr?: number;
  scrollX?: number;
  scrollY?: number;
}): void {
  Object.defineProperty(window, 'innerWidth', { value: opts.innerWidth ?? 1000, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: opts.innerHeight ?? 800, configurable: true });
  Object.defineProperty(window, 'devicePixelRatio', { value: opts.dpr ?? 2, configurable: true });
  Object.defineProperty(window, 'scrollX', { value: opts.scrollX ?? 0, configurable: true });
  Object.defineProperty(window, 'scrollY', { value: opts.scrollY ?? 0, configurable: true });
  Object.defineProperty(window, 'pageXOffset', { value: opts.scrollX ?? 0, configurable: true });
  Object.defineProperty(window, 'pageYOffset', { value: opts.scrollY ?? 0, configurable: true });
}

/** Default responder: capture succeeds, save succeeds. */
function defaultHandler(message: any): unknown {
  if (message.type === 'CAPTURE') {
    timeline.push('capture');
    return { ok: true, screenshotKey: 'key-1', thumbnailDataUrl: 'data:image/jpeg;base64,BB' };
  }
  if (message.type === 'SAVE_ITEM') {
    timeline.push('save');
    return { ok: true, item: { ...message.item, id: 4 } };
  }
  return undefined;
}

beforeEach(() => {
  timeline = [];
  handler = defaultHandler;
  sendMessageMock = jest.fn((message: unknown, callback?: (response: unknown) => void) => {
    // Respond asynchronously, as the real messaging layer does.
    Promise.resolve().then(() => callback?.(handler(message)));
  });
  (global.chrome as any).runtime = {
    ...((global.chrome as any).runtime ?? {}),
    lastError: null,
    sendMessage: sendMessageMock,
  };

  overlay = {
    hide: jest.fn(() => timeline.push('hide')),
    show: jest.fn(() => timeline.push('show')),
  };

  (global as any).requestAnimationFrame = (cb: FrameRequestCallback): number => {
    setTimeout(() => cb(0), 0);
    return 0;
  };

  setGeometry({});
  window.history.replaceState({}, '', '/page');
  mockedCaptureContext.mockClear();
});

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

describe('toPageRect', () => {
  it('adds the scroll offset and leaves the size alone (§1.4D)', () => {
    expect(capture.toPageRect({ x: 10, y: 20, width: 30, height: 40 }, 0, 900)).toEqual({
      x: 10,
      y: 920,
      width: 30,
      height: 40,
    });
  });

  it('is the identity at the top of the page', () => {
    const rect = { x: 10, y: 20, width: 30, height: 40 };
    expect(capture.toPageRect(rect, 0, 0)).toEqual(rect);
  });
});

describe('readViewportMetrics', () => {
  it('reports the inner dimensions, the dpr and the scroll offset together', () => {
    setGeometry({ innerWidth: 1280, innerHeight: 720, dpr: 1.5, scrollX: 5, scrollY: 640 });
    const metrics = capture.readViewportMetrics();
    expect(metrics.viewport).toEqual({ width: 1280, height: 720 });
    expect(metrics.dpr).toBe(1.5);
    expect(metrics.scrollX).toBe(5);
    expect(metrics.scrollY).toBe(640);
  });

  it('falls back to the inner dimensions when the document reports no layout', () => {
    // jsdom has no layout, so documentElement.clientWidth is 0 — the fallback
    // keeps a zero out of the capture message.
    setGeometry({ innerWidth: 1000, innerHeight: 800 });
    expect(capture.readViewportMetrics().contentViewport).toEqual({ width: 1000, height: 800 });
  });

  it('defaults a missing or nonsensical devicePixelRatio to 1', () => {
    Object.defineProperty(window, 'devicePixelRatio', { value: 0, configurable: true });
    expect(capture.readViewportMetrics().dpr).toBe(1);
  });
});

describe('waitForNextPaint', () => {
  it('resolves after the frame callbacks run', async () => {
    await expect(capture.waitForNextPaint()).resolves.toBeUndefined();
  });

  it('resolves on the timeout when the frame clock is stalled (backgrounded tab)', async () => {
    jest.useFakeTimers();
    (global as any).requestAnimationFrame = () => 0; // never calls back
    const pending = capture.waitForNextPaint(250);
    await jest.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toBeUndefined();
    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// captureAndSave
// ---------------------------------------------------------------------------

describe('captureAndSave', () => {
  it('sends the selection rect in viewport css px, unshifted by scroll', async () => {
    setGeometry({ scrollX: 40, scrollY: 900 });

    await capture.captureAndSave(selection, overlay);

    const captureMessage = sendMessageMock.mock.calls.map((c) => c[0]).find((m) => m.type === 'CAPTURE');
    // captureVisibleTab photographs the viewport, so the crop rect must be the
    // untouched viewport rect — adding scroll here is the classic off-by-a-
    // scroll-offset bug.
    expect(captureMessage.rect).toEqual(selection.rect);
    expect(captureMessage.viewport).toEqual({ width: 1000, height: 800 });
    expect(captureMessage.contentViewport).toEqual({ width: 1000, height: 800 });
    expect(captureMessage.dpr).toBe(2);
  });

  it('stores the selection rect in page coordinates on the item (§1.4D)', async () => {
    setGeometry({ scrollX: 40, scrollY: 900 });

    const outcome = await capture.captureAndSave(selection, overlay);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.item.selectionRect).toEqual({ x: 140, y: 950, width: 200, height: 150 });
    // ...and the context capture gets the same page-coordinate rect.
    expect(mockedCaptureContext).toHaveBeenCalledWith(
      { x: 140, y: 950, width: 200, height: 150 },
      expect.objectContaining({ viewport: { width: 1000, height: 800 }, dpr: 2 }),
    );
  });

  it('hides the overlay and waits for a paint before asking for the capture (§6 #2)', async () => {
    let painted = false;
    (global as any).requestAnimationFrame = (cb: FrameRequestCallback): number => {
      setTimeout(() => {
        painted = true;
        cb(0);
      }, 0);
      return 0;
    };
    handler = (message: any) => {
      if (message.type === 'CAPTURE') {
        expect(painted).toBe(true);
        expect(overlay.hide).toHaveBeenCalled();
      }
      return defaultHandler(message);
    };

    await capture.captureAndSave(selection, overlay);
    expect(timeline.slice(0, 2)).toEqual(['hide', 'capture']);
  });

  it('saves the item only after a successful capture, and leaves the overlay hidden', async () => {
    const outcome = await capture.captureAndSave(selection, overlay);

    expect(timeline).toEqual(['hide', 'capture', 'save']);
    expect(overlay.show).not.toHaveBeenCalled(); // the caller exits add mode instead
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.item).toMatchObject({
      id: 4,
      note: 'this button is misaligned',
      screenshotKey: 'key-1',
      thumbnailDataUrl: 'data:image/jpeg;base64,BB',
      viewport: { width: 1000, height: 800 },
      dpr: 2,
    });
  });

  it('derives the domain and urls from the live location', async () => {
    const outcome = await capture.captureAndSave(selection, overlay);
    const saveMessage = sendMessageMock.mock.calls.map((c) => c[0]).find((m) => m.type === 'SAVE_ITEM');

    expect(saveMessage.domain).toBe('localhost'); // jsdom's default host
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.item.pageUrl).toBe(location.href);
    // normaliseUrl() re-emits every url on https and drops query/fragment.
    expect(outcome.item.normalisedUrl).toBe('https://localhost/page');
    // One timestamp for the item and the captured context, not two clock reads.
    expect(mockedCaptureContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ capturedAt: outcome.item.createdAt, pageUrl: location.href }),
    );
  });

  it('restores the overlay and creates no item when the capture fails (§1.3, §5 #8)', async () => {
    handler = (message: any) => {
      if (message.type === 'CAPTURE') {
        timeline.push('capture');
        return { ok: false, code: 'RATE_LIMITED', message: "couldn't capture a screenshot here. try again." };
      }
      return defaultHandler(message);
    };

    const outcome = await capture.captureAndSave(selection, overlay);

    expect(outcome).toEqual({ ok: false, message: "couldn't capture a screenshot here. try again." });
    expect(overlay.show).toHaveBeenCalled();
    expect(timeline).toEqual(['hide', 'capture', 'show']);
    expect(sendMessageMock.mock.calls.some((c) => c[0].type === 'SAVE_ITEM')).toBe(false);
  });

  it('restores the overlay when the item cannot be stored', async () => {
    handler = (message: any) => {
      if (message.type === 'SAVE_ITEM') {
        timeline.push('save');
        return { ok: false, message: "couldn't capture a screenshot here. try again." };
      }
      return defaultHandler(message);
    };

    const outcome = await capture.captureAndSave(selection, overlay);

    expect(outcome.ok).toBe(false);
    expect(timeline).toEqual(['hide', 'capture', 'save', 'show']);
  });

  it('treats an unreachable service worker as a clean failure', async () => {
    sendMessageMock.mockImplementation((_message: unknown, callback?: (response: unknown) => void) => {
      (global.chrome as any).runtime.lastError = { message: 'receiving end does not exist' };
      callback?.(undefined);
      (global.chrome as any).runtime.lastError = null;
    });

    const outcome = await capture.captureAndSave(selection, overlay);

    expect(outcome).toEqual({ ok: false, message: CAPTURE_FAILED_MESSAGE });
    expect(overlay.show).toHaveBeenCalled();
  });

  it('fails before hiding anything if the context capture throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockedCaptureContext.mockImplementationOnce(() => {
      throw new Error('detached dom');
    });

    const outcome = await capture.captureAndSave(selection, overlay);

    expect(outcome).toEqual({ ok: false, message: CAPTURE_FAILED_MESSAGE });
    expect(overlay.hide).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
