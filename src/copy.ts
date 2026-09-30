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
/** §5 #7 — the reason export is greyed out, in its tooltip (design spec §AF);
 *  also the warning if the site empties between the check and the export. */
export const NOTHING_TO_EXPORT_MESSAGE = 'nothing to export';
/** The reason "delete all for this website" is greyed out (design spec §AF). */
export const NOTHING_TO_DELETE_MESSAGE = 'nothing to delete';

// ─── Import (§1.7, §5) ───────────────────────────────────────────────────────

export const DOMAIN_COUNT_FAILED_MESSAGE = "couldn't check existing feedback. try again.";
/** The import round trip itself failed (dead service worker, a write that
 *  threw) rather than a validation failure §5 already has copy for. */
export const IMPORT_FAILED_MESSAGE = "couldn't import this bundle. try again.";

/** The menu's confirmations (design spec §AF). */
export const CONFIRM_CANCEL_LABEL = 'cancel';
export const DELETE_ALL_CONFIRM_LABEL = 'yes, delete';
export const IMPORT_REPLACE_CONFIRM_LABEL = 'yes, import';
/** Asked when import is chosen and the site already has notes (§5 #10,
 *  reworded for §AF: asked before the file is picked, so without a count). */
export const IMPORT_REPLACE_CONFIRM_MESSAGE = 'your existing notes will be discarded. continue with import?';

/** Delete-all failed in the service worker (design spec §AE). */
export const DELETE_ALL_FAILED_MESSAGE = "couldn't delete feedback. try again.";

/** Delete-all's confirmation (design spec §AF): the count, and how many
 *  pages it spans, so it is plain this reaches beyond the page on screen.
 *  Each noun agrees with its own number. */
export function deleteAllConfirmMessage(itemCount: number, pageCount: number): string {
  const notes = itemCount === 1 ? 'note' : 'notes';
  const pages = pageCount === 1 ? 'page' : 'pages';
  return `delete ${itemCount} ${notes} across ${pageCount} ${pages}?`;
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
