// src/bundle/index.ts
// feedback.md, versioned. This module is the only thing the rest of the
// extension imports for the bundle format: the writer for the CURRENT
// version, and a reader that dispatches on the line-1 schema stamp
// (src/bundle/version.ts) to the codec that understands the file, then
// upgrades whatever it read to the in-memory FeedbackItem shape.
//
// Each format version is frozen in its own file (`v1.ts` today) with a
// committed fixture of real text under src/__tests__/fixtures/. A revision of
// the format is a new `vN.ts`, a bump of SCHEMA_VERSION, a new `case` below
// and a new fixture — never an edit to an older codec, which is what keeps
// every bundle already exported importable.

import { FeedbackItem } from '../types';
import { SCHEMA_VERSION, parseSchemaVersion } from './version';
import * as v1 from './v1';

export { SCHEMA_VERSION, parseSchemaVersion } from './version';

/** An item as read back from a bundle: everything a FeedbackItem needs
 *  except the two storage handles the service worker mints at write time
 *  (the bundle never carries them — §1.6). */
export type DecodedBundleItem = Omit<FeedbackItem, 'screenshotKey' | 'thumbnailDataUrl'>;

export interface DecodedBundle {
  /** The schema version the file declared (1 when it declared none). */
  version: number;
  /** True if `version` is newer than this build's (§5 #6). The file was
   *  still read, with the newest codec this build has — best effort. */
  versionWarning: boolean;
  /** Every item in the file, in document order (sections then items). */
  items: DecodedBundleItem[];
}

/**
 * Build the full `feedback.md` contents for a domain's worth of feedback in
 * the current schema version (§1.6 — export covers *all* URLs of the
 * domain). `pages` is exactly `DomainData.pages`: keyed by normalised URL,
 * values in capture order.
 */
export function buildFeedbackMarkdown(pages: Record<string, FeedbackItem[]>): string {
  return v1.buildFeedbackMarkdown(pages);
}

/**
 * Read a `feedback.md` of any known schema version back into items.
 *
 * Throws a plain `Error` (not `ImportError` — this module has no opinion on
 * user-facing copy) for a file whose grammar or yaml blocks do not parse, or
 * whose blocks are missing a required field; src/import.ts maps every such
 * throw to §5 #4b's "corrupted" message. Deciding whether the *values* are
 * acceptable (screenshots present, ids unique, domain matches) is the
 * importer's ladder, not this reader's.
 */
export function decodeFeedbackMarkdown(markdown: string): DecodedBundle {
  const version = parseSchemaVersion(markdown);
  const versionWarning = version > SCHEMA_VERSION;
  switch (version) {
    case 1:
      return { version, versionWarning, items: decodeV1(markdown) };
    default:
      // A version this build does not know is by definition newer (older
      // ones are all listed above). Read it with the newest codec we have:
      // §5 #6 says a newer bundle warns and proceeds.
      return { version, versionWarning, items: decodeV1(markdown) };
  }
}

function decodeV1(markdown: string): DecodedBundleItem[] {
  return v1
    .parseFeedbackMarkdown(markdown)
    .flatMap((section) => section.items)
    .map((parsed) => v1.fromYamlFeedbackItem(parsed.note, parsed.yaml));
}
