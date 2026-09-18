// Phase 0: v2 type surface — screenshot-based feedback capture.
//
// This is a from-scratch rewrite for the pin → screenshot pivot (see
// DEVELOPMENT_PLAN.md Phase 0 and REQUIREMENTS.md §1.2/§1.4/§1.6). Every later
// phase compiles against this file, so it is frozen once Phase 0 lands — a
// later phase needing a type change should make it and flag it explicitly.

// ---------------------------------------------------------------------------
// Geometry / page-metadata primitives
// ---------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Context capture (REQUIREMENTS §1.4) — "fingerprint for explanation"
// ---------------------------------------------------------------------------

/** §1.4A — the smallest DOM element fully containing the selection rectangle. */
export interface PrimaryTarget {
  cssSelector: string;
  xpath: string;
  /** Sanitised outerHTML snippet: <script>/<style> contents and base64 data-URIs
   *  stripped. Capped at 1KB guidance (§1.4A), subject to the 2KB total budget
   *  (§1.4E) truncating this first if exceeded. */
  outerHtmlSnippet: string;
  /** True if outerHtmlSnippet was cut short — a visible "...[truncated]" marker
   *  is also embedded in the string itself; this flag lets renderers/tests
   *  check truncation without string-matching. */
  truncated: boolean;
}

/** §1.4B — one entry in the ≤15-element "contained elements" list. Lightweight
 *  by design: no full HTML, just tag/attrs/direct-text. */
export interface ContainedElement {
  tag: string; // lowercase tag name
  id?: string;
  /** Classes split into "semantic" (human-authored, e.g. BEM-ish names) vs.
   *  "generated" (framework hash classes, per the dictionary-word heuristic
   *  lifted from fingerprint.ts in Phase 6). Absent entirely if the element
   *  has no classes. */
  classes?: {
    semantic: string[];
    generated: string[];
  };
  /** Key attributes only: data-*, aria-*, role, href, alt, name, type, placeholder. */
  attrs?: Record<string, string>;
  /** Direct visible text only (not full subtree text), trimmed, capped ~100 chars. */
  text?: string;
}

/** §1.4D — page-level metadata, self-contained so the exported yaml block reads
 *  standalone without cross-referencing the enclosing FeedbackItem. */
export interface PageMeta {
  url: string;
  normalisedUrl: string;
  title: string;
  viewport: ViewportSize;
  dpr: number;
  selectionRect: Rect;
  /** ISO 8601, capture time. */
  capturedAt: string;
}

/** §1.4 as a whole — the full captured-context object for one feedback item,
 *  governed by the 2KB total budget (§1.4E: outerHtmlSnippet truncates first,
 *  then the containedElements list — always with a visible marker). */
export interface CapturedContext {
  primaryTarget: PrimaryTarget;
  containedElements: ContainedElement[];
  /** All visible text within the selection rectangle, flattened into one block. */
  areaText: string;
  pageMeta: PageMeta;
  /** True if containedElements was cut short by the size governor (§1.4E). */
  containedElementsTruncated?: boolean;
}

// ---------------------------------------------------------------------------
// Feedback item (REQUIREMENTS §1.2, §1.3, §1.5)
// ---------------------------------------------------------------------------

export interface FeedbackItem {
  /** Globally unique, sequential across all URLs of the domain (§1.2). */
  id: number;
  /** Full page URL at capture time. */
  pageUrl: string;
  /** Normalised URL (see urlNorm.ts) — the key feedback is grouped/filtered by. */
  normalisedUrl: string;
  note: string;
  /** ISO 8601 UTC. */
  createdAt: string;
  /** Selection rectangle in page coordinates. */
  selectionRect: Rect;
  /** Viewport dimensions at capture time. */
  viewport: ViewportSize;
  /** Device pixel ratio at capture time — captures are kept at native DPR,
   *  no downscaling (§1.3). */
  dpr: number;
  /** Key into the IndexedDB blob store (src/imageStore.ts, Phase 1) where the
   *  full-resolution PNG lives. Not the image data itself — chrome.runtime
   *  messages can't carry Blob/ArrayBuffer (see cross-cutting gotcha #2). */
  screenshotKey: string;
  context: CapturedContext;
}

// ---------------------------------------------------------------------------
// Domain-keyed storage (extends v1's DomainData/DomainMeta pattern)
// ---------------------------------------------------------------------------

export interface DomainMeta {
  /** Always max(all item ids in this domain) + 1; starts at 1. Sequential
   *  across all URLs of the domain (§1.2), mirroring v1's pin numbering. */
  nextItemNumber: number;
  /** Storage schema version, currently 1. */
  version: number;
}

export interface DomainData {
  meta: DomainMeta;
  /** Keyed by normalised page URL. */
  pages: Record<string, FeedbackItem[]>;
}

// ---------------------------------------------------------------------------
// Bundle serialisation mirror types (REQUIREMENTS §1.6/§1.7)
// ---------------------------------------------------------------------------
// snake_case field names, for the fenced ```yaml blocks embedded per-item in
// feedback.md. The note text and screenshot image are NOT part of this
// object — they live as plain markdown prose / an image reference alongside
// it (§1.6) — this yaml block is exactly the §1.4 captured context plus the
// item-identifying fields an importer needs to reconstruct a FeedbackItem.

export interface YamlRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface YamlPrimaryTarget {
  css_selector: string;
  xpath: string;
  outer_html_snippet: string;
  truncated: boolean;
}

export interface YamlContainedElement {
  tag: string;
  id?: string;
  classes?: {
    semantic: string[];
    generated: string[];
  };
  attrs?: Record<string, string>;
  text?: string;
}

export interface YamlPageMeta {
  url: string;
  normalised_url: string;
  title: string;
  viewport: { width: number; height: number };
  dpr: number;
  selection_rect: YamlRect;
  captured_at: string;
}

export interface YamlCapturedContext {
  primary_target: YamlPrimaryTarget;
  contained_elements: YamlContainedElement[];
  area_text: string;
  page_meta: YamlPageMeta;
  contained_elements_truncated?: boolean;
}

/** One item's fenced yaml block. `id` maps to `screenshots/{id}.png` (§1.6). */
export interface YamlFeedbackItem {
  id: number;
  page_url: string;
  normalised_url: string;
  created_at: string;
  selection_rect: YamlRect;
  viewport: { width: number; height: number };
  dpr: number;
  context: YamlCapturedContext;
}

// ---------------------------------------------------------------------------
// Import errors (REQUIREMENTS §5 — 11 cases; only the 🔴 error rows and the
// 🟡 version-mismatch warning need a code here. §5 #7 and #8 are export/capture
// errors handled inline where they occur, not through the import ladder. §5 #9
// is a page-injection failure, not an import error. §5 #10 is a confirmation,
// not an error — handled via ImportCallbacks.showConfirm.)
// ---------------------------------------------------------------------------

export type ImportErrorCode =
  | 'INVALID_FILE_TYPE'      // §5 #1 — not a .zip
  | 'CORRUPT_ARCHIVE'        // §5 #2 — zip can't be read
  | 'MISSING_MANIFEST'       // §5 #3 — no feedback.md in the zip
  | 'MALFORMED_CONTEXT'      // §5 #4b — fenced yaml block missing/malformed
  | 'MISSING_SCREENSHOT'     // §5 #4 — referenced screenshot not in the zip
  | 'DOMAIN_MISMATCH'        // §5 #5
  | 'DUPLICATE_IDS'          // §5 #11
  | 'VERSION_MISMATCH';      // §5 #6 — warning only; import still proceeds

export interface ImportErrorDetails {
  fileDomain?: string;
  currentDomain?: string;
}

export class ImportError extends Error {
  code: ImportErrorCode;
  details?: ImportErrorDetails;
  constructor(code: ImportErrorCode, details?: ImportErrorDetails) {
    super(code);
    this.code = code;
    this.details = details;
  }
}
