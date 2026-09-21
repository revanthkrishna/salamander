// src/export.ts
// Phase 8 — export orchestration (§1.6). Assembles a domain's entire
// feedback history into a `.zip` (screenshots/{id}.png + feedback.md) and
// triggers a chrome.downloads download, all inside the service worker.
//
// Key decision (per DEVELOPMENT_PLAN.md Phase 8): the zip is assembled
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
import { buildFeedbackMarkdown } from './bundle';
import { exportFilename } from './urlNorm';
import { DomainData } from './types';
import { ExportResponse } from './messages';
import { EXPORT_FAILED_MESSAGE } from './copy';
import { dataUrlToBytes, bytesToDataUrl } from './dataUrl';

/**
 * Export every feedback item across every URL of `domain` (§1.6). Returns
 * `{ ok: false, code: 'EMPTY' }` when the domain has nothing captured yet
 * (§5 #7) — the caller (content.ts) is the one that shows
 * `alert("nothing to export")`, since `alert()` needs the page's window.
 */
export async function exportDomain(domain: string): Promise<ExportResponse> {
  const data = await storage.getDomainData(domain);
  const allItems = data ? Object.values(data.pages).flat() : [];
  if (!data || allItems.length === 0) {
    return { ok: false, code: 'EMPTY' };
  }

  try {
    const zipDataUrl = await buildZipDataUrl(data);
    await triggerDownload(zipDataUrl, exportFilename(domain));
    return { ok: true };
  } catch (err) {
    console.warn('[Annotator] export failed:', err);
    return { ok: false, code: 'EXPORT_FAILED', message: EXPORT_FAILED_MESSAGE };
  }
}

async function buildZipDataUrl(data: DomainData): Promise<string> {
  const markdown = buildFeedbackMarkdown(data.pages);

  const files: Record<string, Uint8Array> = {
    'feedback.md': strToU8(markdown),
  };

  const allItems = Object.values(data.pages).flat();
  for (const item of allItems) {
    const dataUrl = await imageStore.getImage(item.screenshotKey);
    // A missing blob (shouldn't happen — storage.ts's deleteItem/replaceDomainData
    // keep the two stores in lockstep — but data can drift) is skipped rather
    // than failing the whole export; the item's yaml context and note still
    // export, just without its image.
    if (!dataUrl) continue;
    files[`screenshots/${item.id}.png`] = dataUrlToBytes(dataUrl);
  }

  const zipped = zipSync(files, { level: 6 });
  return bytesToDataUrl(zipped, 'application/zip');
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
