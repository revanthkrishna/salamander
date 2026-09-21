// src/rpc.ts — the typed send(). The contract every caller relies on is
// "never rejects; undefined on a dead worker", so that is what is pinned
// here; the type half (the response type follows from the request) is
// checked by the compiler in the last block.

import { send } from '../rpc';
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
