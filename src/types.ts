// The type surface — screenshot-based feedback capture (REQUIREMENTS.md
// §1.2/§1.4/§1.6). Every module compiles against this file; a change to a
// stored type here is a change to the data on disk (storage.ts's migration)
// and to the export format (src/bundle), so make it deliberately.

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
   *  lifted from v1's fingerprint.ts). Absent entirely if the element
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

/** §1.4D — page-level metadata. Every field but `title` repeats one on the
 *  enclosing FeedbackItem (capture fills both from the same values), so the
 *  bundle writes only `page_title` and import rebuilds the rest from the
 *  item — see src/bundle/v2.ts. */
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
  /** Key into the IndexedDB blob store (src/imageStore.ts) where the
   *  full-resolution PNG lives. Not the image data itself — chrome.runtime
   *  messages can't carry Blob/ArrayBuffer (see cross-cutting gotcha #2). */
  screenshotKey: string;
  /** Design call: a small (~thumbnail-sized) data-URL cached inline in the
   *  item's chrome.storage.local record, alongside the full-resolution PNG
   *  in IndexedDB (screenshotKey). This lets the sidebar's thumbnail list
   *  render every item from one storage.local round trip — no per-item
   *  IndexedDB read just to paint the list. The enlarged view and export
   *  still go through imageStore.getImage(screenshotKey) for the
   *  full-resolution image. Minted by the service worker at capture (and at
   *  import); storage.ts itself is agnostic to how it was produced. */
  thumbnailDataUrl: string;
  context: CapturedContext;
  /** What the user drew on the selection before saving (design spec §AB),
   *  kept as its own layer on top of the untouched screenshot. Absent on an
   *  item nothing was drawn on — optional, so older records need no
   *  migration. Not in the bundle: export paints it into the PNG instead. */
  drawing?: Drawing;
}

/** One pencil stroke (design spec §AB). `color` is the HEX the stroke was
 *  drawn in, stored as-is so a later palette change can never recolour a
 *  saved drawing. `points` are CSS px in the owning Drawing's space. */
export interface DrawingStroke {
  color: string;
  points: [number, number][];
}

/** A selection's drawing: `width`/`height` are the final selection's CSS-px
 *  size, and every point is relative to its top-left, already cropped to it
 *  (a stroke that left and re-entered the rect is stored as two strokes).
 *  The screenshot is at the capture's dpr, so painting this onto it scales
 *  by image px / `width` — see src/drawing.ts. */
export interface Drawing {
  width: number;
  height: number;
  strokes: DrawingStroke[];
}

/**
 * The fields of a stored item that may change after capture, as a partial
 * patch. This is the ONE place the set of mutable fields is declared: the
 * storage write (storage.updateItem), the message (UpdateItemMessage) and
 * its handler all take this type, so a new per-item document (e.g. an
 * annotations model) is added to the Pick here and nowhere else. Identity
 * (`id`, `normalisedUrl`), the capture geometry and the storage handles
 * (`screenshotKey`, `thumbnailDataUrl`) are deliberately not patchable.
 */
export type ItemPatch = Partial<Pick<FeedbackItem, 'note'>>;

// ---------------------------------------------------------------------------
// Domain-keyed storage (extends v1's DomainData/DomainMeta pattern)
// ---------------------------------------------------------------------------

export interface DomainMeta {
  /** Always max(all item ids in this domain) + 1; starts at 1. Sequential
   *  across all URLs of the domain (§1.2). */
  nextItemNumber: number;
  /** Storage schema version (storage.ts's STORAGE_VERSION at write time).
   *  Nothing reads it today — no build with an older stored shape was ever
   *  released — but every index carries it so a future change has something
   *  to branch on. */
  version: number;
}

/** A domain's feedback as every consumer sees it: the items grouped by
 *  normalised URL, in capture order. This is the IN-MEMORY shape —
 *  storage.ts assembles it from the split layout below and splits it again
 *  on write. */
export interface DomainData {
  meta: DomainMeta;
  /** Keyed by normalised page URL. */
  pages: Record<string, FeedbackItem[]>;
}

/** What `domain:{domain}` holds in chrome.storage.local: the same meta, and
 *  per URL the ids (in capture order) of the items stored under their own
 *  `item:{domain}:{id}` keys. */
export interface DomainIndex {
  meta: DomainMeta;
  pages: Record<string, number[]>;
}

// The bundle's snake_case json record type lives with the grammar it
// belongs to, per format version: src/bundle/v2.ts.

// ---------------------------------------------------------------------------
// Import errors (REQUIREMENTS §5 — 11 cases; only the 🔴 error rows need a
// code here. §5 #7 and #8 are export/capture errors handled inline where
// they occur, not through the import ladder. §5 #9 is a page-injection
// failure, not an import error. §5 #10 is a confirmation, not an error —
// handled via the sidebar's confirm dialog.)
// ---------------------------------------------------------------------------

export type ImportErrorCode =
  | 'INVALID_FILE_TYPE'      // §5 #1 — not a .zip
  | 'CORRUPT_ARCHIVE'        // §5 #2 — zip can't be read
  | 'MISSING_MANIFEST'       // §5 #3 — no feedback.md in the zip
  | 'UNSUPPORTED_FORMAT'     // §5 #6 — feedback.md is not in this build's format
  | 'MALFORMED_CONTEXT'      // §5 #4b — an item's element data missing/malformed
  | 'MISSING_SCREENSHOT'     // §5 #4 — referenced screenshot not in the zip
  | 'DOMAIN_MISMATCH'        // §5 #5
  | 'DUPLICATE_IDS';         // §5 #11

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
