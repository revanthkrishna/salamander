// Phase 2A: Storage & Types — fully implemented

export interface Fingerprint {
  cssSelector: string;
  xpath: string;
  textSnippet: string;   // first ~50 chars of element text; may be empty string
  tagName: string;       // lowercase
  // Semantic context signals — all optional for backward compat with existing
  // stored annotations and imported YAML. Used by resolveElement() for scoring.
  closestLabel?: string;    // aria-label, aria-labelledby, or nearest <label> text
  pageHeading?: string;     // nearest h1/h2/h3/role=heading text (max 80 chars)
  pageSubHeading?: string;  // nearest heading between pageHeading and element, at a lower heading level (max 80 chars)
  headingPath?: string[];   // all h1-h4 / role=heading preceding the element in document order (max 10 most-recent entries, each trimmed to 80 chars)
  sectionContext?: string;  // nearest ancestor with role/data-step context (max 80 chars)
  siblingText?: string;     // prev+next sibling text (max 60 chars)
  domIndex?: number;        // 0-based index among all tagName+text matches in doc
}

export interface Annotation {
  pinNumber: number;
  note: string;          // max 400 chars
  fingerprint: Fingerprint;
  offset: { x: number; y: number };  // click point relative to element top-left
  createdAt: string;     // ISO 8601 UTC
}

export interface DomainMeta {
  nextPinNumber: number;         // always max(all pinNumbers) + 1; starts at 1
  importedFilename: string | null;  // null if no import, or if modified after import
  wasImported: boolean;          // true if state originated from import
                                 // reset to FALSE on delete-all
                                 // NEVER reset on annotation edit/add/delete
  version: number;               // storage schema version, currently 1
}

export interface DomainData {
  meta: DomainMeta;
  pages: Record<string, Annotation[]>;  // keyed by normalised page URL
}

// For YAML import/export (snake_case field names per TECH_DESIGN.md §3).
// Field order in these interfaces is the emit order under sortKeys:false —
// `FEEDBACK` is last so it appears at the bottom of each annotation block
// where a human reader expects the prose content.
export interface YamlAnnotation {
  pin_number: number;
  page_url: string;
  fingerprint: {
    css_selector: string;
    xpath: string;
    text_snippet: string;
    tag_name: string;
    // Context signals — optional so old YAML files remain valid
    closest_label?: string;
    page_heading?: string;
    page_sub_heading?: string;
    heading_path?: string[];
    section_context?: string;
    sibling_text?: string;
    dom_index?: number;
  };
  offset: { x: number; y: number };
  created_at: string;
  FEEDBACK: string;
}

export interface YamlDocument {
  salamander_version: string;  // extension version from manifest, e.g. "1.1.0"
  exported_at: string;
  domain: string;
  annotations: YamlAnnotation[];
}

// Import errors
export type ImportErrorCode =
  | 'FILE_TOO_LARGE'
  | 'WRONG_TYPE'
  | 'EMPTY_FILE'
  | 'MALFORMED'
  | 'WRONG_SCHEMA'
  | 'EMPTY_ANNOTATIONS'
  | 'DUPLICATE_PINS'
  | 'WRONG_DOMAIN'
  | 'VERSION_MISMATCH';

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
