// src/rpc.ts — the typed send(). The contract every caller relies on is
// "never rejects; undefined on a dead worker", so that is what is pinned
// here; the type half (the response type follows from the request) is
// checked by the compiler in the last block.

import { onContextInvalidated, send } from '../rpc';
import type { CaptureResponse, GetImageResponse } from '../messages';

let sendMessageMock: jest.Mock;

beforeEach(() => {
  sendMessageMock = jest.fn();
  (global.chrome as any).runtime = {
    ...((global.chrome as any).runtime ?? {}),
    lastError: null,
    sendMessage: sendMessageMock,
  };
});

describe('send', () => {
  test('resolves with the service worker\'s response', async () => {
    sendMessageMock.mockImplementation((_m: unknown, cb: (r: unknown) => void) => cb({ ok: true, dataUrl: 'data:,x' }));
    await expect(send({ type: 'GET_IMAGE', screenshotKey: 'k' })).resolves.toEqual({ ok: true, dataUrl: 'data:,x' });
    expect(sendMessageMock).toHaveBeenCalledWith({ type: 'GET_IMAGE', screenshotKey: 'k' }, expect.any(Function));
  });

  test('resolves undefined (never rejects) when the worker reports lastError', async () => {
    sendMessageMock.mockImplementation((_m: unknown, cb: (r?: unknown) => void) => {
      (global.chrome as any).runtime.lastError = { message: 'The message port closed before a response was received.' };
      cb(undefined);
    });
    await expect(send({ type: 'GET_IMAGE', screenshotKey: 'k' })).resolves.toBeUndefined();
  });

  test('resolves undefined (never rejects) when the extension context is invalidated', async () => {
    sendMessageMock.mockImplementation(() => {
      throw new Error('Extension context invalidated.');
    });
    await expect(send({ type: 'SIDEBAR_OPENED' })).resolves.toBeUndefined();
  });

  test('the response type follows the request type (compile-time)', async () => {
    sendMessageMock.mockImplementation((_m: unknown, cb: (r: unknown) => void) => cb({ ok: true, dataUrl: 'd' }));
    const image: GetImageResponse | undefined = await send({ type: 'GET_IMAGE', screenshotKey: 'k' });
    expect(image?.ok).toBe(true);
    // @ts-expect-error — a GET_IMAGE reply is not a CaptureResponse.
    const wrong: CaptureResponse | undefined = await send({ type: 'GET_IMAGE', screenshotKey: 'k' });
    expect(wrong).toBeDefined();
  });
});

describe('onContextInvalidated', () => {
  afterEach(() => {
    onContextInvalidated(null);
    (global.chrome as any).runtime.id = 'salamander-test-extension';
  });

  test('a call that throws "Extension context invalidated" runs the hook, before the caller hears undefined', async () => {
    const order: string[] = [];
    onContextInvalidated(() => order.push('hook'));
    sendMessageMock.mockImplementation(() => {
      throw new Error('Extension context invalidated.');
    });
    const reply = await send({ type: 'GET_IMAGE', screenshotKey: 'k' }).then((r) => {
      order.push('caller');
      return r;
    });
    expect(reply).toBeUndefined();
    expect(order).toEqual(['hook', 'caller']);
  });

  test('so does any failure once chrome.runtime has lost its id (an orphaned script)', async () => {
    const hook = jest.fn();
    onContextInvalidated(hook);
    delete (global.chrome as any).runtime.id;
    sendMessageMock.mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'sendMessage')");
    });
    await send({ type: 'SIDEBAR_OPENED' });
    expect(hook).toHaveBeenCalledTimes(1);
  });

  test('an ordinary failure (a busy or restarting worker) does not', async () => {
    const hook = jest.fn();
    onContextInvalidated(hook);
    sendMessageMock.mockImplementation((_m: unknown, cb: (r?: unknown) => void) => {
      (global.chrome as any).runtime.lastError = { message: 'The message port closed before a response was received.' };
      cb(undefined);
    });
    await send({ type: 'GET_IMAGE', screenshotKey: 'k' });
    expect(hook).not.toHaveBeenCalled();
  });

  test('a cleared hook is not called', async () => {
    const hook = jest.fn();
    onContextInvalidated(hook);
    onContextInvalidated(null);
    sendMessageMock.mockImplementation(() => {
      throw new Error('Extension context invalidated.');
    });
    await send({ type: 'SIDEBAR_OPENED' });
    expect(hook).not.toHaveBeenCalled();
  });
});
