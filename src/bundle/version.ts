// src/bundle/version.ts
// The format stamp on line 1 of feedback.md — the one part of the format
// shared by every version, because it is what src/bundle/index.ts reads to
// decide which codec the rest of the file belongs to (design spec §AC).

/**
 * The feedback.md format this build WRITES, and the only one it reads. The
 * extension is unpublished, so there is no backward compatibility: a bundle
 * stamped with any other version — or with no stamp, like the retired v1
 * format (`<!-- annotator-schema-version: 1 -->`) — is refused on import.
 * Embedded as an HTML comment on the first line (invisible in a rendered
 * markdown viewer). It is not the extension version, which the header
 * carries separately.
 */
export const FORMAT_VERSION = 2;

const FORMAT_MARKER_RE = /^<!--\s*salamander-feedback-format:\s*(\d+)\s*-->$/;

/** The line-1 stamp for `version`. */
export function formatMarker(version: number): string {
  return `<!-- salamander-feedback-format: ${version} -->`;
}

/**
 * The format version stamped on line 1 of a `feedback.md`, or null when line
 * 1 is not a salamander format stamp at all. Only line 1 counts: the stamp
 * is how import recognises the format, and a note further down may quote
 * one. A leading byte-order mark and surrounding whitespace are tolerated,
 * since an editor re-saving the file may add either.
 */
export function parseFormatVersion(markdown: string): number | null {
  const firstLine = markdown.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0].trim();
  const match = FORMAT_MARKER_RE.exec(firstLine);
  return match ? parseInt(match[1], 10) : null;
}
