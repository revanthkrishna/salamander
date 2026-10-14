// src/siteActions.ts
// What the sidebar's site-wide actions do (design spec §AE, §AF; §1.6,
// §1.7): export, import (the question asked in the menu, then the file),
// "delete all on this website", the list's hover delete, and the site's
// counts that grey export and delete-all out. Each is a round trip to the
// service worker plus what the sidebar shows for its outcome. Moved out of
// content.ts unchanged; content.ts wires the sidebar's callbacks to them.

import { normaliseDomain } from './urlNorm';
import { parseImportBundle } from './import';
import {
  // The list's hover delete (design spec v4 §L) shares the enlarged view's
  // failure copy rather than declaring a second string for the same event.
  DELETE_ERROR_MESSAGE,
  DELETE_ALL_FAILED_MESSAGE,
  EXPORT_FAILED_MESSAGE,
  IMPORT_FAILED_MESSAGE,
  NOTHING_TO_EXPORT_MESSAGE,
  importErrorMessage,
  deleteAllConfirmMessage,
  DELETE_ALL_CONFIRM_LABEL,
  IMPORT_REPLACE_CONFIRM_LABEL,
  IMPORT_REPLACE_CONFIRM_MESSAGE,
} from './copy';
import { FeedbackItem, ImportError } from './types';
import { send } from './rpc';
import type * as SidebarModule from './sidebar';
import {
  DeleteItemMessage,
  ExportMessage,
  ImportStageImageMessage,
  ImportCommitMessage,
  ImportAbortMessage,
  GetDomainItemCountMessage,
  GetDomainItemCountResponse,
  DeleteDomainDataMessage,
} from './messages';

export interface SiteActionsDeps {
  sidebar: Pick<
    typeof SidebarModule,
    | 'setSiteHasNotes'
    | 'closeMoreOptionsMenu'
    | 'showError'
    | 'showWarning'
    | 'confirmInMenu'
    | 'isMoreOptionsMenuOpen'
    | 'openImportPicker'
    | 'setExportButtonEnabled'
    | 'setImportButtonEnabled'
    | 'isSidebarVisible'
  >;
  /** Re-read the current URL's notes and repaint the list (content.ts). */
  refreshList: () => Promise<void>;
  /** Open the sidebar and tell the service worker (content.ts). */
  openSidebar: () => void;
}

export interface SiteActions {
  exportSite: () => Promise<void>;
  requestImport: () => Promise<void>;
  importFile: (file: File) => Promise<void>;
  deleteAll: () => Promise<void>;
  /** The enlarged view's "delete all", already confirmed in its top bar:
   *  the same delete, no question; resolves whether it went through. */
  deleteAllConfirmed: () => Promise<boolean>;
  deleteItem: (item: FeedbackItem) => Promise<void>;
  refreshSiteHasNotes: () => Promise<void>;
}

export function createSiteActions(deps: SiteActionsDeps): SiteActions {
  const { sidebar, refreshList: refreshThumbnails, openSidebar: openAndReport } = deps;

  let deleteAllInFlight = false;

  /** Read the site's note and page counts (every page, not just this one),
   *  through the service worker's write queue, so every write sent before is
   *  counted. A successful read also catches the sidebar up on whether the
   *  site has notes — what greys out export and delete-all (§AF). A failed
   *  one changes nothing; the caller decides what that means. */
  async function readSiteCounts(): Promise<GetDomainItemCountResponse | undefined> {
    const message: GetDomainItemCountMessage = {
      type: 'GET_DOMAIN_ITEM_COUNT',
      domain: normaliseDomain(location.host),
    };
    const response = await send(message);
    if (response?.ok) sidebar.setSiteHasNotes(response.count > 0);
    return response;
  }

  /** Re-read whether the site has any notes, and with it whether export and
   *  "delete all" have anything to act on. A count that cannot be read greys
   *  them out: the safe direction for the one irreversible action in the
   *  product. */
  async function refreshSiteHasNotes(): Promise<void> {
    const response = await readSiteCounts();
    if (!response?.ok) sidebar.setSiteHasNotes(false);
  }

  /**
   * Delete every note on every page of this site, and every screenshot, after
   * the menu turns into a question quoting both counts (§AF) — so it is plain
   * this reaches beyond the page on screen. The counts are read fresh when
   * asked (not trusted from the last repaint), through the same write queue
   * the delete then goes through, so the question counts every write sent
   * before it. Unreachable during add mode (the whole group is disabled, §H)
   * and the enlarged view (the panel is inert behind it).
   */
  async function handleDeleteAll(): Promise<void> {
    if (deleteAllInFlight) return;
    const domain = normaliseDomain(location.host);

    const counts = await readSiteCounts();
    if (!counts || !counts.ok) {
      sidebar.closeMoreOptionsMenu();
      sidebar.showError(counts ? counts.message : DELETE_ALL_FAILED_MESSAGE);
      return;
    }
    if (counts.count === 0) {
      // Emptied since the item was last enabled (e.g. from the enlarged view):
      // nothing to ask — readSiteCounts has already greyed the item out.
      sidebar.closeMoreOptionsMenu();
      return;
    }

    const confirmed = await sidebar.confirmInMenu(
      deleteAllConfirmMessage(counts.count, counts.pageCount),
      DELETE_ALL_CONFIRM_LABEL,
    );
    if (!confirmed) return;

    try {
      const response = await sendDeleteAll(domain);
      if (!response || !response.ok) {
        sidebar.showError(response?.message ?? DELETE_ALL_FAILED_MESSAGE);
      }
    } finally {
      // Repaint from storage either way: on success the list empties and the
      // item greys itself out; on failure whatever did survive is shown.
      await refreshThumbnails();
    }
  }

  /** DELETE_DOMAIN_DATA, one at a time. */
  async function sendDeleteAll(domain: string) {
    deleteAllInFlight = true;
    try {
      const message: DeleteDomainDataMessage = { type: 'DELETE_DOMAIN_DATA', domain };
      return await send(message);
    } finally {
      deleteAllInFlight = false;
    }
  }

  /** The enlarged view's "delete all" (design spec §AH, 2026-10-13): asked
   *  in its own top bar, so no question here; the view says the outcome
   *  itself and closes on success, and its closing repaints the list. */
  async function handleDeleteAllConfirmed(): Promise<boolean> {
    if (deleteAllInFlight) return false;
    const response = await sendDeleteAll(normaliseDomain(location.host));
    return response?.ok === true;
  }

  /**
   * "import" was chosen in the menu (§1.7, design spec §AF). With notes on the
   * site the menu first turns into "your existing notes will be discarded.
   * continue with import?" — asked BEFORE the file is chosen, so once the file
   * checks out it replaces without asking again. With none, the picker opens
   * straight away (unless the menu was dismissed during the round trip).
   * The count is read fresh when asked rather than trusted from the last
   * repaint, so notes added from another tab before the click are counted;
   * the round trip takes milliseconds, well inside the user activation a file
   * picker needs.
   */
  async function handleImportRequest(): Promise<void> {
    const counts = await readSiteCounts();
    if (!counts || !counts.ok) {
      // Without the count there is no knowing whether a replace would discard
      // anything, so the only safe answer is to stop (§5 #10).
      sidebar.closeMoreOptionsMenu();
      sidebar.showError(counts ? counts.message : IMPORT_FAILED_MESSAGE);
      return;
    }
    if (counts.count > 0) {
      const confirmed = await sidebar.confirmInMenu(
        IMPORT_REPLACE_CONFIRM_MESSAGE,
        IMPORT_REPLACE_CONFIRM_LABEL,
        'accent',
      );
      if (!confirmed) return;
    } else if (!sidebar.isMoreOptionsMenuOpen()) {
      // Dismissed during the round trip: the user has moved on, so no picker.
      // (The question above already answers no in that case.)
      return;
    }
    sidebar.openImportPicker();
  }

  /**
   * Delete one note straight from the list's hover delete (design spec v4 §L):
   * immediate, with no confirmation, exactly like the enlarged view's delete —
   * the same DELETE_ITEM round trip, and the same error message on failure, so
   * the two entry points can't drift apart. On success the list is re-read from
   * storage rather than patched locally, which is what every other mutation
   * here does.
   */
  async function handleDeleteItem(item: FeedbackItem): Promise<void> {
    const message: DeleteItemMessage = {
      type: 'DELETE_ITEM',
      domain: normaliseDomain(location.host),
      normalisedUrl: item.normalisedUrl,
      itemId: item.id,
    };
    const response = await send(message);
    if (response?.ok !== true) {
      sidebar.showError(DELETE_ERROR_MESSAGE);
      return;
    }
    await refreshThumbnails();
  }

  /**
   * §1.6 — export every feedback item across every URL of the current domain
   * as a `.zip` download. The service worker (src/export.ts) does the actual
   * assembly and download (gotchas #1, #4); this side's only job is the
   * message round trip and surfacing the two possible non-success outcomes:
   * §5 #7's empty-domain alert, or a generic failure in the sidebar's error
   * bar. The export button is disabled for the duration so a second click
   * can't start a second download mid-assembly.
   */
  async function handleExport(): Promise<void> {
    sidebar.setExportButtonEnabled(false);
    try {
      const message: ExportMessage = {
        type: 'EXPORT',
        domain: normaliseDomain(location.host),
      };
      const response = await send(message);
      if (!response) {
        sidebar.showError(EXPORT_FAILED_MESSAGE);
        return;
      }
      if (!response.ok) {
        if (response.code === 'EMPTY') {
          // Export is greyed out with nothing to export (§AF), so this is only
          // reached if the site emptied since the last check (another tab):
          // say so, and grey it out now.
          sidebar.showWarning(NOTHING_TO_EXPORT_MESSAGE);
          void refreshSiteHasNotes();
        } else {
          sidebar.showError(response.message);
        }
      }
    } finally {
      sidebar.setExportButtonEnabled(true);
    }
  }

  /**
   * §1.7 — import a `.zip` bundle, once it has been picked. src/import.ts owns
   * the whole §5 validation ladder (unzip, parse, screenshot/duplicate/domain
   * checks); this side reports a validation failure verbatim and hands a valid
   * bundle to the service worker to write, one screenshot at a time and then
   * the notes. Nothing is asked here: any replace
   * of existing notes was confirmed before the picker opened
   * (handleImportRequest, §AF). The import item is disabled for the duration
   * so a second pick can't overlap the first.
   */
  async function handleImportFile(file: File): Promise<void> {
    sidebar.setImportButtonEnabled(false);
    try {
      const currentDomain = normaliseDomain(location.host);

      let bundle;
      try {
        bundle = await parseImportBundle(file, currentDomain);
      } catch (err) {
        sidebar.showError(
          err instanceof ImportError ? importErrorMessage(err.code, err.details) : IMPORT_FAILED_MESSAGE,
        );
        return;
      }

      // The write crosses to the service worker in pieces (messages.ts's
      // import banner): each screenshot staged on its own, then one small
      // commit of the notes, carrying the keys and thumbnails staging minted.
      const items: FeedbackItem[] = [];
      for (const { screenshotDataUrl, ...fields } of bundle.items) {
        const stage: ImportStageImageMessage = { type: 'IMPORT_STAGE_IMAGE', dataUrl: screenshotDataUrl };
        const staged = await send(stage);
        if (!staged || !staged.ok) {
          // Nothing references what was staged so far; let it go.
          if (items.length > 0) {
            const abort: ImportAbortMessage = { type: 'IMPORT_ABORT', screenshotKeys: items.map((i) => i.screenshotKey) };
            void send(abort);
          }
          sidebar.showError(staged?.message ?? IMPORT_FAILED_MESSAGE);
          return;
        }
        items.push({ ...fields, screenshotKey: staged.screenshotKey, thumbnailDataUrl: staged.thumbnailDataUrl });
      }

      // A commit that fails cleans up its own screenshots; one whose answer
      // never came may have landed, so nothing is deleted from here.
      const commit: ImportCommitMessage = { type: 'IMPORT_COMMIT', domain: currentDomain, items };
      const committed = await send(commit);
      if (!committed || !committed.ok) {
        sidebar.showError(committed?.message ?? IMPORT_FAILED_MESSAGE);
        return;
      }

      // §1.7: sidebar opens (if not already) showing the current url's items.
      if (!sidebar.isSidebarVisible()) {
        openAndReport();
      } else {
        void refreshThumbnails();
      }
    } finally {
      sidebar.setImportButtonEnabled(true);
    }
  }

  return {
    exportSite: handleExport,
    requestImport: handleImportRequest,
    importFile: handleImportFile,
    deleteAll: handleDeleteAll,
    deleteAllConfirmed: handleDeleteAllConfirmed,
    deleteItem: handleDeleteItem,
    refreshSiteHasNotes,
  };
}
