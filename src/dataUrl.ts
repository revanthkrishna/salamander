// src/dataUrl.ts
// The extension's one set of data-URL <-> bytes/Blob codecs, shared by the
// service worker (capture crop, export zip) and the content script (import
// zip entries). Every image in this extension travels as a data-URL string
// (see imageStore.ts's representation note), so these are on the hot path
// of every capture, export and import.
//
// ⚠ None of these may ever go back to the idiomatic one-liners
// `await (await fetch(dataUrl)).blob()` / `.arrayBuffer()`. The extension's
// CSP (manifest.json, carried forward from the "no network calls at all"
// posture — REQUIREMENTS §2 Security) sets `connect-src 'none'`, and an MV3
// service worker is an extension page for CSP purposes: `fetch()` there is
// governed by `connect-src`, and a `data:` URL is not exempt. The original
// fetch-based decoder died on a CSP violation inside every real capture and
// surfaced to the user as §5 #8's "couldn't capture a screenshot here. try
// again." — while the unit tests stayed green, because they stubbed
// `global.fetch`. Decoding the base64 by hand has no CSP surface, no network
// stack and no async hop. (Relaxing the CSP instead was the other option and
// was rejected: nothing in this extension should be able to talk to the
// network.) background.test.ts keeps a fetch() stub that THROWS as the
// regression guard.
//
// No URL.createObjectURL or FileReader either: neither is guaranteed in a
// service worker's global scope across Chrome versions, and a content script
// has no reason to bridge through a Blob it would only convert straight back.

const DATA_PREFIX = 'data:';
/** String.fromCharCode(...chunk) is applied per 32 KiB slice — spreading a
 *  multi-megabyte array into one call overflows the argument limit. */
const CHUNK_SIZE = 0x8000;

/** Raw bytes -> base64, chunked (see CHUNK_SIZE). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

/** base64 -> raw bytes. */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Raw bytes -> a base64 data URL of `mime` (a zip entry's PNG, an assembled
 *  zip for chrome.downloads). */
export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  return `${DATA_PREFIX}${mime};base64,${bytesToBase64(bytes)}`;
}

/** A base64 data URL -> its raw bytes (fflate's `zipSync` wants
 *  `Uint8Array` entries, not `Blob`). Throws on anything that is not a
 *  data URL. */
export function dataUrlToBytes(dataUrl: string): Uint8Array<ArrayBuffer> {
  const comma = dataUrl.indexOf(',');
  if (comma === -1 || !dataUrl.startsWith(DATA_PREFIX)) {
    throw new Error('stored image is not a data url');
  }
  return base64ToBytes(dataUrl.slice(comma + 1));
}

/**
 * A data URL -> Blob, so `createImageBitmap` can decode what
 * `chrome.tabs.captureVisibleTab` handed us. Handles the percent-encoded
 * (non-base64) form too: captureVisibleTab always returns base64, but a
 * percent-encoded data URL is still a legal one — decode it rather than feed
 * atob() garbage. Throws on anything that is not a data URL.
 */
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = typeof dataUrl === 'string' ? dataUrl.indexOf(',') : -1;
  if (comma === -1 || !dataUrl.startsWith(DATA_PREFIX)) {
    throw new Error('captured image is not a data url');
  }

  const header = dataUrl.slice(DATA_PREFIX.length, comma);
  const payload = dataUrl.slice(comma + 1);
  const isBase64 = /;base64$/i.test(header);
  const mime = header.replace(/;base64$/i, '').split(';')[0] || 'image/png';

  if (!isBase64) {
    return new Blob([decodeURIComponent(payload)], { type: mime });
  }
  return new Blob([base64ToBytes(payload)], { type: mime });
}

/** Blob -> data URL via arrayBuffer()/btoa(), both part of the standard
 *  worker global scope (a Blob with no type is assumed to be a PNG — the
 *  only kind this extension ever encodes). */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return bytesToDataUrl(bytes, blob.type || 'image/png');
}
