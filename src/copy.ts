// src/copy.ts
// Every user-facing failure/notice string the extension shows, declared once
// and imported by both bundles. All of it is lowercase (REQUIREMENTS §3.4)
// and the §5 rows are verbatim — the tests assert these byte-exact, which is
// the protection this file relies on: a string edited here is caught by the
// test that quotes it, wherever the message is surfaced from.
//
// Pure strings only: nothing here may touch the DOM, chrome.* or storage, so
// the service worker and the content script can both import it freely.

import type { ImportErrorCode, ImportErrorDetails } from './types';

// ─── Capture / persistence (§5 #8) ──────────────────────────────────────────

/** §5 #8, verbatim. The service worker sends it for its own failures; the
 *  content script shows the same copy for failures before/without a round
 *  trip (context capture, a dead worker). */
export const CAPTURE_FAILED_MESSAGE = "couldn't capture a screenshot here. try again.";

export const ITEM_LOAD_FAILED_MESSAGE = "couldn't load feedback for this page. try again.";
export const IMAGE_LOAD_FAILED_MESSAGE = "couldn't load screenshot. try again.";

/** A save failure for the note on screen. */
export const SAVE_ERROR_MESSAGE = "couldn't save note. try again.";
/** A save failure for a note other than the one on screen names it. */
export function saveErrorFor(id: number): string {
  return `couldn't save note #${id}. try again.`;
}
export const DELETE_ERROR_MESSAGE = "couldn't delete item. try again.";
/** The enlarged view's "a note can never be empty" lock (design spec v2 §D). */
export const EMPTY_NOTE_MESSAGE = "a note can't be empty. add some text to continue.";

/** Shown when a note is clicked while add mode's comment box holds typed
 *  text — opening it would throw that text away. */
export const FINISH_NOTE_FIRST_MESSAGE = 'finish or cancel your note first.';

// ─── Export (§1.6, §5 #7) ────────────────────────────────────────────────────

/** Not one of the numbered §5 cases: the export round trip itself failed
 *  (zip assembly, chrome.downloads, or a dead service worker). */
export const EXPORT_FAILED_MESSAGE = "couldn't export feedback. try again.";
/** §5 #7, verbatim — shown through `alert()`, which needs the page's window. */
export const NOTHING_TO_EXPORT_MESSAGE = 'nothing to export';

// ─── Import (§1.7, §5) ───────────────────────────────────────────────────────

export const DOMAIN_COUNT_FAILED_MESSAGE = "couldn't check existing feedback. try again.";
/** The import round trip itself failed (dead service worker, a write that
 *  threw) rather than a validation failure §5 already has copy for. */
export const IMPORT_FAILED_MESSAGE = "couldn't import this bundle. try again.";

/** §5 #10, verbatim. */
export function importReplaceConfirmMessage(existingCount: number): string {
  return `importing will replace your current ${existingCount} feedback item(s) for this site. this cannot be undone. continue?`;
}

/** §5's error copy, lowercase and verbatim. The one parameterised row
 *  (#5, domain mismatch) fills in from `ImportError.details`. */
export function importErrorMessage(code: ImportErrorCode, details?: ImportErrorDetails): string {
  switch (code) {
    case 'INVALID_FILE_TYPE':
      return 'invalid file type. please upload a .zip feedback bundle.';
    case 'CORRUPT_ARCHIVE':
      return 'could not read this file — it appears to be corrupted.';
    case 'MISSING_MANIFEST':
      return "this doesn't look like a feedback bundle.";
    case 'UNSUPPORTED_FORMAT':
      return "this bundle was made by a different version of the extension and can't be imported.";
    case 'MALFORMED_CONTEXT':
      return "this bundle appears to be corrupted (couldn't read feedback data).";
    case 'MISSING_SCREENSHOT':
      return "this file is missing screenshot data and can't be imported.";
    case 'DOMAIN_MISMATCH':
      return `this bundle contains feedback for '${details?.fileDomain}', but you're currently on '${details?.currentDomain}'.`;
    case 'DUPLICATE_IDS':
      return 'this bundle appears to be corrupted (duplicate item ids).';
    default:
      return IMPORT_FAILED_MESSAGE;
  }
}
