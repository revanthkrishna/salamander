// src/import.ts
// Bundle import validation (§1.7, §5). Runs entirely inside the
// content script: the picked `File` lives in the page's JS world (a native
// `<input type="file">`), and unzipping + validating it needs none of
// chrome.storage/IndexedDB (gotcha #1) — only the final "write the
// replacement domain data" step needs the service worker, and that happens
// over `ImportReplaceMessage` (src/messages.ts) once this module hands back
// a validated bundle. content.ts is the orchestrator: it calls
// `parseImportBundle`, shows §5 #10's confirmation using the count the
// service worker reports, then sends `IMPORT_REPLACE`.
//
// Validation ladder (§5, in this exact order): not-a-zip (#1) -> corrupt archive (#2) -> missing
// feedback.md (#3) -> not this build's format (#6) -> malformed/missing
// element data or field (#4b) -> referenced screenshot absent (#4) ->
// duplicate ids (#11) -> domain mismatch (#5). §5 #10 (existing-data
// confirmation) is not this module's job: it needs the *current* item count,
// which only the service worker knows, so content.ts asks for that
// separately once `parseImportBundle` resolves.
//
// Every check within a single validation *type* (screenshot presence,
// duplicate ids) is run as its own full pass over every item before moving
// to the next type, rather than interleaved per item — so the reported error
// always reflects the ladder's priority order regardless of which item in
// the bundle happens to trip which check first.
//
// Mirrors v1's importFile ladder discipline and its ImportError code/detail
// plumbing (src/types.ts) — extended here with the two zip-specific steps
// (#2, #4) a single-file v1 bundle never needed.

import { unzipSync, strFromU8 } from 'fflate';
import { ImportError } from './types';
import { decodeFeedbackMarkdown, DecodedBundleItem, UnsupportedFormatError } from './bundle';
import { normaliseDomain } from './urlNorm';
import { ImportItemPayload } from './messages';
import { bytesToDataUrl } from './dataUrl';

export interface ParsedImportBundle {
  /** Normalised domain the bundle's items belong to (empty-item bundles have
   *  no domain of their own and fall back to `currentDomain`). */
  domain: string;
  items: ImportItemPayload[];
}

const ZIP_EXTENSION_RE = /\.zip$/i;

/**
 * Validate + parse a picked file into a bundle ready for `IMPORT_REPLACE`.
 * Throws `ImportError` for every 🔴 row in §5 relevant to import (#1, #2,
 * #3, #6, #4b, #4, #11, #5).
 */
export async function parseImportBundle(
  file: File,
  currentDomain: string,
): Promise<ParsedImportBundle> {
  // §5 #1 — wrong file type.
  if (!ZIP_EXTENSION_RE.test(file.name)) {
    throw new ImportError('INVALID_FILE_TYPE');
  }

  // §5 #2 — corrupt / not a valid archive.
  let entries: Record<string, Uint8Array>;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    entries = unzipSync(bytes);
  } catch {
    throw new ImportError('CORRUPT_ARCHIVE');
  }

  // §5 #3 — missing feedback.md.
  const manifestBytes = entries['feedback.md'];
  if (!manifestBytes) {
    throw new ImportError('MISSING_MANIFEST');
  }

  let markdown: string;
  try {
    markdown = strFromU8(manifestBytes);
  } catch {
    throw new ImportError('MISSING_MANIFEST');
  }

  // §5 #6 — feedback.md is not in this build's format: another version's
  // stamp on line 1 (older or newer — the extension is unpublished, so no
  // older format is read), or no stamp at all.
  // §5 #4b — the right format, but an item's structure is broken (no image
  // or note line, no element-data block whose json parses) or its json has
  // a field missing or of the wrong type. The versioned reader (src/bundle)
  // throws for all of these; this is the one place that maps them to the
  // user-facing codes.
  let decodedItems: DecodedBundleItem[];
  try {
    decodedItems = decodeFeedbackMarkdown(markdown).items;
  } catch (err) {
    throw new ImportError(err instanceof UnsupportedFormatError ? 'UNSUPPORTED_FORMAT' : 'MALFORMED_CONTEXT');
  }

  // §5 #4 — an item's metadata references a screenshot not in the zip.
  for (const { id } of decodedItems) {
    if (!entries[`screenshots/${id}.png`]) {
      throw new ImportError('MISSING_SCREENSHOT');
    }
  }

  // §5 #11 — duplicate ids within the bundle.
  const seenIds = new Set<number>();
  for (const { id } of decodedItems) {
    if (seenIds.has(id)) {
      throw new ImportError('DUPLICATE_IDS');
    }
    seenIds.add(id);
  }

  // §5 #5 — domain mismatch. A bundle is always exported for one domain
  // (§1.6), so any item's page_url is representative; an empty bundle has
  // no domain to compare and is treated as matching (nothing to replace
  // against anyway).
  const bundleDomain = decodedItems.length > 0 ? domainOf(decodedItems[0].pageUrl) : currentDomain;
  if (bundleDomain !== currentDomain) {
    throw new ImportError('DOMAIN_MISMATCH', {
      fileDomain: bundleDomain,
      currentDomain,
    });
  }

  const items: ImportItemPayload[] = decodedItems.map((item) => ({
    ...item,
    // Raw PNG bytes -> a data URL, so they can cross the chrome.runtime
    // boundary as JSON (gotcha #2) and land in imageStore exactly like every
    // other stored screenshot.
    screenshotDataUrl: bytesToDataUrl(entries[`screenshots/${item.id}.png`], 'image/png'),
  }));

  return { domain: bundleDomain, items };
}

function domainOf(pageUrl: string): string {
  try {
    return normaliseDomain(new URL(pageUrl).host);
  } catch {
    return '';
  }
}
