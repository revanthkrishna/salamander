// src/export.ts
// Export orchestration (§1.6). Assembles a domain's entire
// feedback history into a `.zip` (screenshots/{id}.png + feedback.md) and
// triggers a chrome.downloads download, all inside the service worker.
//
// Key decision: the zip is assembled
// *here*, not shipped piecewise to the content script to assemble. The
// screenshot blobs already live in this context's IndexedDB (src/imageStore.ts,
// gotcha #1), and chrome.downloads accepts a `data:` URL directly (gotcha
// #4), so read -> zip -> download never needs to leave the service worker or
// cross the chrome.runtime boundary as base64 (gotcha #2). The fallback if a
// bundle's data: URL ever proves too large is an offscreen document — not
// needed at this extension's expected volumes, so not built.

import { zipSync, strToU8 } from 'fflate';
import * as storage from './storage';
import * as imageStore from './imageStore';
import { buildFeedbackMarkdown, ExportHeader } from './bundle';
import { exportFilename } from './urlNorm';
import { DomainData, Drawing } from './types';
import { ExportResponse } from './messages';
import { EXPORT_FAILED_MESSAGE } from './copy';
import { dataUrlToBytes, bytesToDataUrl, dataUrlToBlob, blobToDataUrl } from './dataUrl';
import { hasStrokes, paintDrawing } from './drawing';

/** What the feedback.md header reads from the environment — injectable so a
 *  test can pin the exported text exactly. */
export interface ExportEnvironment {
  now: () => Date;
  extensionVersion: () => string;
}

const LIVE_ENVIRONMENT: ExportEnvironment = {
  now: () => new Date(),
  extensionVersion: () => chrome.runtime.getManifest().version,
};

/**
 * Export every feedback item across every URL of `domain` (§1.6). Returns
 * `{ ok: false, code: 'EMPTY' }` when the domain has nothing captured yet
 * (§5 #7) — the caller (content.ts) is the one that shows
 * `alert("nothing to export")`, since `alert()` needs the page's window.
 */
export async function exportDomain(
  domain: string,
  // The read goes through whatever serialisation the caller holds
  // (background.ts's save queue), so the export sees every write queued
  // before it rather than a record mid-mutation.
  loadDomain: (domain: string) => Promise<DomainData | null> = storage.getDomainData,
  env: ExportEnvironment = LIVE_ENVIRONMENT,
): Promise<ExportResponse> {
  const data = await loadDomain(domain);
  const allItems = data ? Object.values(data.pages).flat() : [];
  if (!data || allItems.length === 0) {
    return { ok: false, code: 'EMPTY' };
  }

  try {
    const now = env.now();
    const header: ExportHeader = {
      extensionVersion: env.extensionVersion(),
      website: domain,
      exportedAt: now,
      // Local time, as the header shows it (design spec §AC).
      utcOffsetMinutes: -now.getTimezoneOffset(),
    };
    const zipDataUrl = await buildZipDataUrl(data, header);
    await triggerDownload(zipDataUrl, exportFilename(domain, now));
    return { ok: true };
  } catch (err) {
    console.warn('[Annotator] export failed:', err);
    return { ok: false, code: 'EXPORT_FAILED', message: EXPORT_FAILED_MESSAGE };
  }
}

async function buildZipDataUrl(data: DomainData, header: ExportHeader): Promise<string> {
  const markdown = buildFeedbackMarkdown(data.pages, header);

  const files: Record<string, Uint8Array> = {
    'feedback.md': strToU8(markdown),
  };

  const allItems = Object.values(data.pages).flat();
  for (const item of allItems) {
    const dataUrl = await imageStore.getImage(item.screenshotKey);
    // A missing blob (shouldn't happen — storage.ts's deleteItem/replaceDomainData
    // keep the two stores in lockstep — but data can drift) is skipped rather
    // than failing the whole export; the item's note and element data still
    // export, just without its image.
    if (!dataUrl) continue;
    // Design spec §AB: the drawn image only — an item's drawing is painted
    // into its exported PNG, and the bundle carries no drawing data of its
    // own (feedback.md says only that the image is marked up, in its alt
    // text — §AC). An item without one is exported exactly as stored, byte for byte:
    // it never goes near a canvas.
    const png = hasStrokes(item.drawing) ? await compositeDrawing(dataUrl, item.drawing) : dataUrl;
    files[`screenshots/${item.id}.png`] = dataUrlToBytes(png);
  }

  const zipped = zipSync(files, { level: 6 });
  return bytesToDataUrl(zipped, 'application/zip');
}

/**
 * The stored screenshot with `drawing` painted over it, as a PNG data URL.
 * At the image's real pixel size: the capture is at its dpr (and whatever
 * zoom), so the drawing's CSS px scale by the decoded image's width and
 * height over the selection's — measured from the pixels, the same way the
 * crop measures its scale rather than trusting devicePixelRatio — and the
 * 2px line scales with them. The service worker has no DOM, so this is
 * createImageBitmap + OffscreenCanvas, like the crop.
 *
 * If painting fails the clean screenshot is exported instead: one item
 * losing its strokes beats the whole export failing.
 */
export async function compositeDrawing(dataUrl: string, drawing: Drawing): Promise<string> {
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error('no 2d context available for the drawing');
    ctx.drawImage(bitmap, 0, 0);
    paintDrawing(ctx, drawing, bitmap.width / drawing.width, bitmap.height / drawing.height);
    return await blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
  } catch (err) {
    console.warn('[Annotator] could not paint a drawing into its export:', err);
    return dataUrl;
  } finally {
    bitmap?.close();
  }
}

function triggerDownload(dataUrl: string, filename: string): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url: dataUrl, filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError || downloadId === undefined) {
        reject(new Error(chrome.runtime.lastError?.message ?? 'download failed'));
        return;
      }
      resolve();
    });
  });
}
