// src/bundle/index.ts
// feedback.md, versioned. This module is the only thing the rest of the
// extension imports for the bundle format: the writer for the current
// format, and a reader that dispatches on the line-1 format stamp
// (src/bundle/version.ts) to the codec that understands the file.
//
// There is one format today, version 2 (`v2.ts`, design spec §AC), with a
// committed fixture of real text under src/__tests__/fixtures/. The
// extension is unpublished, so nothing older is read: a file with any other
// stamp — including the retired v1 format — is refused. A future revision is
// a new `vN.ts`, a bump of FORMAT_VERSION, a new `case` below and a new
// fixture.

import { FeedbackItem } from '../types';
import { FORMAT_VERSION, parseFormatVersion } from './version';
import * as v2 from './v2';

export { FORMAT_VERSION, parseFormatVersion } from './version';
export type { ExportHeader } from './v2';

/** An item as read back from a bundle: everything a FeedbackItem needs
 *  except the two storage handles the service worker mints at write time
 *  (the bundle never carries them — §1.6). */
export type DecodedBundleItem = Omit<FeedbackItem, 'screenshotKey' | 'thumbnailDataUrl'>;

export interface DecodedBundle {
  /** The format version the file declared. */
  version: number;
  /** Every item in the file, in document order (pages then notes). */
  items: DecodedBundleItem[];
}

/** Thrown by `decodeFeedbackMarkdown` for a file this build does not read:
 *  a different format version, or no salamander format stamp on line 1. */
export class UnsupportedFormatError extends Error {
  constructor(public readonly version: number | null) {
    super(version === null ? 'no feedback format stamp on line 1' : `unsupported feedback format ${version}`);
  }
}

/**
 * Build the full `feedback.md` for a domain's worth of feedback in the
 * current format (§1.6 — export covers *all* urls of the domain). `pages` is
 * exactly `DomainData.pages`: keyed by normalised url, values in capture
 * order. `header` carries the extension version, the domain and the export
 * time — passed in so the output is deterministic.
 */
export function buildFeedbackMarkdown(
  pages: Record<string, FeedbackItem[]>,
  header: v2.ExportHeader,
): string {
  return v2.buildFeedbackMarkdown(pages, header);
}

/**
 * Read a `feedback.md` back into items.
 *
 * Throws `UnsupportedFormatError` for a file in any format but the current
 * one (src/import.ts maps it to §5 #6), and a plain `Error` for a current-
 * format file whose structure or json does not parse or whose fields have the
 * wrong type (mapped to §5 #4b). This module has no opinion on user-facing
 * copy. Deciding whether the *values* are acceptable (screenshots present,
 * ids unique, domain matches) is the importer's ladder, not this reader's.
 */
export function decodeFeedbackMarkdown(markdown: string): DecodedBundle {
  const version = parseFormatVersion(markdown);
  switch (version) {
    case FORMAT_VERSION:
      return { version, items: v2.decodeFeedbackMarkdown(markdown) };
    default:
      throw new UnsupportedFormatError(version);
  }
}
