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
/** The enlarged view could not read the site's other pages (design spec
 *  §AH); it opens on this page's notes alone. */
export const SITE_LOAD_FAILED_MESSAGE = "couldn't load the other pages' notes. try again.";
/** A page's new name could not be stored (design spec §AH). */
export const PAGE_NAME_SAVE_ERROR_MESSAGE = "couldn't save the page name. try again.";
/** A page was renamed after its notes were deleted elsewhere (another tab):
 *  a page exists only through its notes, so there is nothing to name, and
 *  trying again cannot help — reopening shows the site as it now is. */
export const PAGE_HAS_NO_NOTES_MESSAGE = "these notes were deleted in another tab. reopen this view to see the latest.";
export const IMAGE_LOAD_FAILED_MESSAGE = "couldn't load screenshot. try again.";

/** A save failure, under the note's own text area. */
export const SAVE_ERROR_MESSAGE = "couldn't save note. try again.";
/** A save failure reported in the sidebar's banner once the enlarged view
 *  has closed names the note — by its number on its page (design spec §AD)
 *  and, since the view shows the whole site, the page (§AH). */
export function saveErrorFor(number: number, pageName: string): string {
  return `couldn't save note #${number} on ${pageName}. try again.`;
}
export const DELETE_ERROR_MESSAGE = "couldn't delete the note. try again.";
/** "A note can never be empty" (design spec v2 §D, §AH): under a text area
 *  that has been emptied. The last saved text stays stored, and the view
 *  will not close until the note has text again. */
export const NOTE_REQUIRED_MESSAGE = 'note required';

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
/** The reason "delete all on this website" is greyed out (design spec §AF). */
export const NOTHING_TO_DELETE_MESSAGE = 'nothing to delete';
/** The reason add mode's "erase all" is greyed out (design spec §AB). */
export const NOTHING_TO_ERASE_MESSAGE = 'nothing to erase';
/** The reason add mode's "save" is greyed out: the note is empty (§3.2). */
export const ENTER_A_NOTE_MESSAGE = 'enter a note to save';
/** Placeholder of the note's text area, in add mode and the enlarged view. */
export const NOTE_PLACEHOLDER = 'type a note\u2026';

// ─── Labels: add mode and the note list ─────────────────────────────────────
// Not failures, but user-facing all the same (visible text, tooltips and
// accessible names), so they live here with the rest and are pinned too.

/** A cancel button: add mode's, and the menu's question's. */
export const CANCEL_LABEL = 'cancel';
/** Add mode's save button, and what it says while the capture runs. */
export const SAVE_LABEL = 'save';
export const SAVING_LABEL = 'saving\u2026';
/** The first-run hint beside the cursor while placing (design spec §G). */
export const PLACING_HINT = 'click or drag to select';
/** The Option/Alt+N tip (src/addNoteTip.ts), shown once in a while in the
 *  hint's place: the keycap as the platform writes it — ⌥ on macOS. */
export function addNoteTip(mac: boolean): string {
  return mac ? 'tip: press \u2325N to add a note' : 'tip: press alt+n to add a note';
}
/** The comment box and its text area (their accessible names). */
export const ADD_NOTE_LABEL = 'add feedback note';
export const NOTE_FIELD_LABEL = 'feedback note';
/** The pencil (design spec §AB): its button and menu, the menu's one item,
 *  the colour swatches' group, and the surface strokes are drawn on. */
export const DRAWING_OPTIONS_LABEL = 'drawing options';
export const ERASE_ALL_LABEL = 'erase all';
export const PENCIL_COLOUR_LABEL = 'pencil color';
export const DRAWING_SURFACE_LABEL = 'drawing on the selection';
/** A note in the sidebar's list, and its hover delete (design spec v4 §L). */
export function listItemLabel(number: number): string {
  return `note #${number}`;
}
export function deleteListItemLabel(number: number): string {
  return `delete note #${number}`;
}
export const DELETE_LIST_ITEM_TIP = 'delete';
/** A listed note with no text (the list shows something rather than
 *  nothing). */
export const EMPTY_NOTE_PREVIEW = 'no note';

// ─── The enlarged view (design spec §AH) ────────────────────────────────────

/** The view's accessible name: it shows every note of the site. */
export const ENLARGED_VIEW_LABEL = 'all notes on this website';
export const EXIT_ENLARGED_VIEW_LABEL = 'exit enlarged view';
export const EXIT_ENLARGED_VIEW_TIP = 'exit enlarged view (esc)';
/** Beside the heading of the page on screen. */
export const THIS_PAGE_LABEL = 'this page';
/** A page whose notes were captured with no HTML title. */
export const UNTITLED_PAGE_NAME = 'untitled page';
export const DELETE_NOTE_TIP = 'delete note';
/** The top bar's "delete all" (design spec §AH, 2026-10-13): the menu's
 *  "delete all on this website", asked in place — its label, the name and
 *  tooltip that say how far it reaches, and the question it turns into. */
export const DELETE_ALL_LABEL = 'delete all';
export const DELETE_ALL_SITE_LABEL = 'delete all notes on this website';
export const DELETE_ALL_QUESTION = 'confirm?';
export const DELETE_ALL_YES_LABEL = 'yes, delete all';
export const EDIT_PAGE_NAME_TIP = 'edit page name';
export const SAVE_PAGE_NAME_LABEL = 'save page name';
export const PAGE_NAME_FIELD_LABEL = 'page name';
/** Accessible names that say which note or page a control acts on. */
export function deleteNoteLabel(number: number, pageName: string): string {
  return `delete note #${number} on ${pageName}`;
}
export function noteFieldLabel(number: number, pageName: string): string {
  return `note #${number} on ${pageName}`;
}
export function editPageNameLabel(pageName: string): string {
  return `edit page name: ${pageName}`;
}

// ─── Import (§1.7, §5) ───────────────────────────────────────────────────────

export const DOMAIN_COUNT_FAILED_MESSAGE = "couldn't check existing feedback. try again.";
/** The import round trip itself failed (dead service worker, a write that
 *  threw) rather than a validation failure §5 already has copy for. */
export const IMPORT_FAILED_MESSAGE = "couldn't import this bundle. try again.";

/** The menu's confirmations (design spec §AF). */
export const CONFIRM_CANCEL_LABEL = CANCEL_LABEL;
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
      return 'invalid file type. choose a .zip feedback bundle.';
    case 'CORRUPT_ARCHIVE':
      return "couldn't read this file. it may be corrupted.";
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
