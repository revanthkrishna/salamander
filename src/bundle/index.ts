// src/bundle/index.ts
// feedback.md, versioned. This module is the only thing the rest of the
// extension imports for the bundle format: the writer for the current
// format, and a reader that dispatches on the line-1 format stamp
// (src/bundle/version.ts) to the codec that understands the file.
//
// There is one format today, version 3 (`v3.ts`, design spec §AC), with a
// committed fixture of real text under src/__tests__/fixtures/. Nothing
// older is read: a file with any other stamp is refused — including version
// 2 (2.0/2.1's exports, whose notes were headed `### feedback {n}`) and the
// retired v1 format. A future revision is
// a new `vN.ts`, a bump of FORMAT_VERSION, a new `case` below and a new
// fixture.

import { FeedbackItem } from '../types';
import { parseFormatVersion } from './version';
import * as v3 from './v3';
import type { DecodedBundleEntry } from './v3';

export { FORMAT_VERSION, parseFormatVersion } from './version';
export type { DecodedBundleEntry, DecodedBundleItem, ExportHeader } from './v3';

export interface DecodedBundle {
  /** The format version the file declared. */
  version: number;
  /** Every note in the file, in document order (pages then notes): the item
   *  and the display number its heading showed. */
  entries: DecodedBundleEntry[];
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
  header: v3.ExportHeader,
): string {
  return v3.buildFeedbackMarkdown(pages, header);
}

/**
 * Read a `feedback.md` back into notes.
 *
 * Throws `UnsupportedFormatError` for a file in any format but the current
 * one (src/import.ts maps it to §5 #6), and a plain `Error` for a current-
 * format file whose structure or json does not parse or whose fields have the
 * wrong type (mapped to §5 #4b). This module has no opinion on user-facing
 * copy. Deciding whether the *values* are acceptable (screenshots present,
 * ids and per-page numbers unique, domain matches) is the importer's
 * ladder, not this reader's.
 */
export function decodeFeedbackMarkdown(markdown: string): DecodedBundle {
  const version = parseFormatVersion(markdown);
  switch (version) {
    // Each case names the codec's OWN version, not FORMAT_VERSION: when a
    // v3 arrives, FORMAT_VERSION moves to 3 and this case keeps reading the
    // v2 files people have already exported.
    case v3.FORMAT_VERSION_V3:
      return { version, entries: v3.decodeFeedbackMarkdown(markdown) };
    default:
      throw new UnsupportedFormatError(version);
  }
}
