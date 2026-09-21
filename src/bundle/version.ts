// src/bundle/version.ts
// The schema-version stamp on line 1 of feedback.md — the one part of the
// format shared by every version, because it is what src/bundle/index.ts
// reads to decide which codec the rest of the file belongs to.

/**
 * The bundle schema version this build WRITES (§5 #6 — "bundle schema
 * version newer than current extension"). Bumped whenever a change to the
 * grammar or the yaml block would make an older importer misread a newer
 * bundle; each version's codec then lives in its own `bundle/vN.ts` and the
 * dispatcher gains a case. Embedded as an HTML comment on the first line of
 * `feedback.md` (invisible in a rendered markdown viewer, exactly like the
 * fenced yaml blocks are meant to be inert prose to a human reader) so the
 * importer can compare without touching the human-facing content.
 */
export const SCHEMA_VERSION = 1;

const VERSION_COMMENT_RE = /^<!--\s*annotator-schema-version:\s*(\d+)\s*-->\s*$/;

/** The line-1 stamp for `version`. */
export function versionComment(version: number): string {
  return `<!-- annotator-schema-version: ${version} -->`;
}

/**
 * Read the schema version stamped on a `feedback.md`. Absent entirely (a
 * hand-authored bundle, or one predating the marker) is treated as version 1
 * rather than an error — the marker is a forward-compatibility aid, not a
 * required field (§5's #6 only fires on a bundle *newer* than this build,
 * never on one that's silent about it).
 */
export function parseSchemaVersion(markdown: string): number {
  for (const line of markdown.split('\n', 5)) {
    const match = VERSION_COMMENT_RE.exec(line.trim());
    if (match) return parseInt(match[1], 10);
  }
  return 1;
}
