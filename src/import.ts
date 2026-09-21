// src/import.ts
// Phase 9 — bundle import validation (§1.7, §5). Runs entirely inside the
// content script: the picked `File` lives in the page's JS world (a native
// `<input type="file">`), and unzipping + validating it needs none of
// chrome.storage/IndexedDB (gotcha #1) — only the final "write the
// replacement domain data" step needs the service worker, and that happens
// over `ImportReplaceMessage` (src/messages.ts) once this module hands back
// a validated bundle. content.ts is the orchestrator: it calls
// `parseImportBundle`, shows §5 #10's confirmation using the count the
// service worker reports, then sends `IMPORT_REPLACE`.
//
// Validation ladder (§5, in the exact order DEVELOPMENT_PLAN.md's Phase 9
// brief specifies): not-a-zip (#1) -> corrupt archive (#2) -> missing
// feedback.md (#3) -> malformed/missing fence or field (#4b) -> referenced
// screenshot absent (#4) -> duplicate ids (#11) -> domain mismatch (#5) ->
// newer schema version (#6, warning only — not thrown). §5 #10 (existing-data
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
// (#2, #4) a single-YAML-file v1 bundle never needed.

import { unzipSync, strFromU8 } from 'fflate';
import { ImportError } from './types';
import { decodeFeedbackMarkdown, DecodedBundleItem } from './bundle';
import { normaliseDomain } from './urlNorm';
import { ImportItemPayload } from './messages';
import { bytesToDataUrl } from './dataUrl';

export interface ParsedImportBundle {
  /** Normalised domain the bundle's items belong to (empty-item bundles have
   *  no domain of their own and fall back to `currentDomain`). */
  domain: string;
  items: ImportItemPayload[];
  /** True if the bundle declares a schema version newer than this build's
   *  (§5 #6) — the caller shows the warning; import proceeds regardless. */
  versionWarning: boolean;
}

const ZIP_EXTENSION_RE = /\.zip$/i;

/**
 * Validate + parse a picked file into a bundle ready for `IMPORT_REPLACE`.
 * Throws `ImportError` for every 🔴 row in §5 relevant to import (#1, #2,
 * #3, #4, #4b, #5, #11). Never throws for #6 — that comes back as
 * `versionWarning` instead, since import proceeds regardless.
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

  // §5 #4b — malformed/missing fence (grammar-level: bad image ref,
  // unterminated or unparsable yaml fence) or a well-formed fence missing a
  // field the shape requires. The versioned reader (src/bundle) throws a
  // plain Error for all of these; this is the one place that maps to the
  // user-facing code. It also reports the file's schema version for #6.
  let decoded;
  try {
    decoded = decodeFeedbackMarkdown(markdown);
  } catch {
    throw new ImportError('MALFORMED_CONTEXT');
  }
  const decodedItems: DecodedBundleItem[] = decoded.items;

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

  // §5 #6 — newer schema version. Warning only; import proceeds.
  return {
    domain: bundleDomain,
    items,
    versionWarning: decoded.versionWarning,
  };
}

function domainOf(pageUrl: string): string {
  try {
    return normaliseDomain(new URL(pageUrl).host);
  } catch {
    return '';
  }
}
