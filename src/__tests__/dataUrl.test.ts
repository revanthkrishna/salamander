// src/dataUrl.ts — the one set of data-URL codecs both bundles share. The
// dataUrlToBlob block is the CSP regression guard's other half: it proves the
// hand-rolled decoder reads every byte value back exactly, so nothing has a
// reason to reach for fetch(dataUrl) (blocked by connect-src 'none' in the
// service worker — see background.test.ts's throwing fetch stub).

import {
  base64ToBytes,
  blobToDataUrl,
  bytesToBase64,
  bytesToDataUrl,
  dataUrlToBlob,
  dataUrlToBytes,
} from '../dataUrl';

/** jsdom's Blob has no arrayBuffer()/text() and jsdom has no Response, but
 *  it does have a working FileReader — enough to read the bytes back out. */
function bytesOf(blob: Blob): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(Array.from(new Uint8Array(reader.result as ArrayBuffer)));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

async function textOf(blob: Blob): Promise<string> {
  return String.fromCharCode(...(await bytesOf(blob)));
}

/** jsdom's Blob lacks arrayBuffer(); the service worker's has it. */
class FakeBlob {
  constructor(
    private readonly bytes: number[],
    public readonly type: string,
  ) {}
  async arrayBuffer(): Promise<ArrayBuffer> {
    return new Uint8Array(this.bytes).buffer;
  }
}

describe('dataUrlToBlob — the CSP-safe replacement for fetch(dataUrl)', () => {
  it('decodes a base64 png into bytes, preserving the mime type', async () => {
    const blob = dataUrlToBlob('data:image/png;base64,AAECAw==');
    expect(blob.type).toBe('image/png');
    expect(await bytesOf(blob)).toEqual([0, 1, 2, 3]);
  });

  it('keeps every byte value intact across the 0x80 boundary', async () => {
    const source = [0, 127, 128, 200, 255];
    const base64 = Buffer.from(source).toString('base64');
    const blob = dataUrlToBlob(`data:image/png;base64,${base64}`);
    expect(await bytesOf(blob)).toEqual(source);
  });

  it('handles a percent-encoded (non-base64) data url', async () => {
    const blob = dataUrlToBlob('data:image/svg+xml,%3Csvg%3E');
    expect(blob.type).toBe('image/svg+xml');
    expect(await textOf(blob)).toBe('<svg>');
  });

  it('defaults the mime type when the header omits it', () => {
    expect(dataUrlToBlob('data:;base64,AAA=').type).toBe('image/png');
  });

  it('rejects anything that is not a data url', () => {
    expect(() => dataUrlToBlob('https://example.com/a.png')).toThrow(/data url/);
    expect(() => dataUrlToBlob('data:image/png;base64')).toThrow(/data url/);
    expect(() => dataUrlToBlob('' as unknown as string)).toThrow(/data url/);
  });
});

describe('bytes <-> base64 <-> data url', () => {
  const source = new Uint8Array([0, 1, 2, 127, 128, 200, 255]);

  it('round-trips bytes through base64', () => {
    expect(Array.from(base64ToBytes(bytesToBase64(source)))).toEqual(Array.from(source));
    expect(bytesToBase64(source)).toBe(Buffer.from(source).toString('base64'));
  });

  it('round-trips bytes through a data url of the given mime', () => {
    const url = bytesToDataUrl(source, 'application/zip');
    expect(url.startsWith('data:application/zip;base64,')).toBe(true);
    expect(Array.from(dataUrlToBytes(url))).toEqual(Array.from(source));
  });

  it('handles payloads larger than the 32 KiB fromCharCode chunk', () => {
    const big = new Uint8Array(0x8000 * 2 + 17);
    for (let i = 0; i < big.length; i++) big[i] = i % 256;
    expect(Array.from(dataUrlToBytes(bytesToDataUrl(big, 'image/png')))).toEqual(Array.from(big));
  });

  it('dataUrlToBytes rejects anything that is not a data url', () => {
    expect(() => dataUrlToBytes('https://example.com/a.png')).toThrow(/data url/);
    expect(() => dataUrlToBytes('data:image/png;base64')).toThrow(/data url/);
  });

  it('blobToDataUrl encodes the bytes with the blob type, defaulting to png', async () => {
    expect(await blobToDataUrl(new FakeBlob([1, 2, 3], 'image/jpeg') as unknown as Blob)).toBe(
      `data:image/jpeg;base64,${Buffer.from([1, 2, 3]).toString('base64')}`,
    );
    expect(await blobToDataUrl(new FakeBlob([1], '') as unknown as Blob)).toBe('data:image/png;base64,AQ==');
  });
});
