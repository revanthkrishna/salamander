# Phase 2A — Storage & Types Engineer

## Role & Persona

You are a TypeScript engineer who writes rock-solid data layer code. You design clean interfaces, implement reliable storage wrappers, and handle URL normalization edge cases without complaint. You read the spec carefully and implement exactly what it says.

## Before You Start

Read these files fully:
- `/root/.openclaw/workspace/annotator/REQUIREMENTS.md` — source of truth (DO NOT MODIFY)
- `/root/.openclaw/workspace/annotator/TECH_DESIGN.md` — especially §2 (Storage), §3 (YAML Schema)

Also check what the Project Setup Engineer created:
- `/root/.openclaw/workspace/annotator/src/types.ts` — you will fully implement this
- `/root/.openclaw/workspace/annotator/src/storage.ts` — you will fully implement this
- `/root/.openclaw/workspace/annotator/src/urlNorm.ts` — you will fully implement this

## What You Produce

Fully implement three files:
1. `src/types.ts` — all TypeScript interfaces and types
2. `src/storage.ts` — `chrome.storage.local` wrapper
3. `src/urlNorm.ts` — URL and domain normalization utilities

Do NOT modify any other files.

---

## Implementation Requirements

### `src/types.ts`

Implement ALL interfaces used by the extension. Reference TECH_DESIGN.md §2.2:

```typescript
export interface Fingerprint {
  cssSelector: string;
  xpath: string;
  textSnippet: string;   // first ~50 chars of element text; may be empty string
  tagName: string;       // lowercase
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

// For YAML import/export (snake_case field names per TECH_DESIGN.md §3)
export interface YamlAnnotation {
  pin_number: number;
  page_url: string;
  note: string;
  fingerprint: {
    css_selector: string;
    xpath: string;
    text_snippet: string;
    tag_name: string;
  };
  offset: { x: number; y: number };
  created_at: string;
}

export interface YamlDocument {
  version: number;
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
```

### `src/urlNorm.ts`

Implement all URL normalization per TECH_DESIGN.md §2.4 and REQUIREMENTS.md §6 edge cases 7, 14, 15, 16, 17.

Rules (implement ALL of these):
1. **Scheme:** normalize to `https://`; `http://` → `https://`
2. **Hostname:** lowercase
3. **www prefix:** strip `www.` from hostname (but NOT other subdomains like `app.example.com`)
4. **Port:** ignore/strip (e.g. `:8080` removed)
5. **Path:** preserve case exactly as-is
6. **Trailing slash:** strip from path (but `https://example.com/` → `https://example.com`)
7. **Query params:** strip entirely
8. **Fragment:** strip entirely

Domain normalization rules (for storage keys and domain matching):
- Strip `www.` prefix
- Lowercase
- Strip port
- Result: `figma.com`, `app.example.com`, `amazon.com`

```typescript
export function normaliseUrl(url: string): string {
  // Implement full URL normalization
  // Returns normalised URL with no params/fragments/trailing-slash
  // Normalises scheme to https
  // Example: "http://www.figma.com/blog/How-We-Built-Figma?ref=twitter#intro"
  //       → "https://figma.com/blog/How-We-Built-Figma"
}

export function normaliseDomain(hostname: string): string {
  // Strips www., lowercases, strips port
  // "www.figma.com" → "figma.com"
  // "app.example.com" → "app.example.com" (keep non-www subdomains)
  // "example.com:8080" → "example.com"
}

export function exportFilename(domain: string): string {
  // "figma.com" → "annotations-figma_com.yaml"
  // dots replaced with underscores
}
```

Write thorough unit tests if you can, but at minimum make sure the function handles the example from TECH_DESIGN.md §2.4:
- Input: `http://www.figma.com/blog/How-We-Built-Figma?ref=twitter#intro`
- Expected: `https://figma.com/blog/How-We-Built-Figma`

### `src/storage.ts`

Implement the full `chrome.storage.local` wrapper. Reference TECH_DESIGN.md §2.2–§2.6.

Storage key patterns:
- `annotations:{domain}` → DomainData object
- `activeTab:{tabId}` → boolean (true)

```typescript
import type { DomainData, Annotation } from './types';

const STORAGE_VERSION = 1;

// Get all domain data (returns null if not found)
export async function getDomainData(domain: string): Promise<DomainData | null>

// Save domain data
export async function saveDomainData(domain: string, data: DomainData): Promise<void>

// Clear all data for a domain (used by delete-all)
export async function clearDomainData(domain: string): Promise<void>

// Mark a tab as having an active toolbar
export async function setTabActive(tabId: number): Promise<void>

// Remove tab active marker (on tab close)
export async function removeTabActive(tabId: number): Promise<void>

// Check if a tab has an active toolbar
export async function isTabActive(tabId: number): Promise<boolean>

// Startup cleanup: remove stale activeTab keys for tabs that no longer exist
// Called from background service worker on chrome.runtime.onStartup
export async function cleanupStaleTabKeys(): Promise<void>

// Get the next pin number for a domain (reads from meta.nextPinNumber)
// Creates fresh DomainData if none exists
export async function getNextPinNumber(domain: string): Promise<number>

// Add an annotation to storage (handles nextPinNumber update)
export async function addAnnotation(domain: string, pageUrl: string, annotation: Annotation): Promise<void>

// Update an existing annotation (by pinNumber)
export async function updateAnnotation(domain: string, pageUrl: string, pinNumber: number, note: string): Promise<void>

// Delete an annotation (by pinNumber, across all pages of domain)
export async function deleteAnnotation(domain: string, pinNumber: number): Promise<void>

// Get all annotations for a specific page URL
export async function getPageAnnotations(domain: string, pageUrl: string): Promise<Annotation[]>

// Get annotation count for a domain (across all pages)
export async function getAnnotationCount(domain: string): Promise<number>

// Create a fresh DomainData object with defaults
export function createFreshDomainData(): DomainData
```

**Implementation notes:**
- All chrome.storage calls should be wrapped in Promise-returning helpers
- Use `chrome.storage.local.get`, `.set`, `.remove`
- Error handling: if storage write fails, let the error propagate (caller handles it); quota errors are silently ignored per requirements
- `cleanupStaleTabKeys` needs to query all current tabs via `chrome.tabs.query` — this function is called from the background worker only

**For `cleanupStaleTabKeys`, implementation:**
```typescript
export async function cleanupStaleTabKeys(): Promise<void> {
  // Get all current tab IDs
  const tabs = await new Promise<chrome.tabs.Tab[]>(resolve => 
    chrome.tabs.query({}, resolve)
  );
  const liveIds = new Set(tabs.map(t => t.id));
  
  // Get all storage keys
  const all = await new Promise<Record<string, unknown>>(resolve =>
    chrome.storage.local.get(null, resolve)
  );
  
  // Remove stale activeTab keys
  const staleKeys = Object.keys(all)
    .filter(k => k.startsWith('activeTab:'))
    .filter(k => !liveIds.has(parseInt(k.split(':')[1])));
  
  if (staleKeys.length > 0) {
    await new Promise<void>(resolve => chrome.storage.local.remove(staleKeys, resolve));
  }
}
```

---

## TypeScript Strictness

- No `any` types unless absolutely unavoidable (and add a comment explaining why)
- All async functions return proper Promise types
- All parameters and return types explicitly annotated

---

## How to Verify Your Work

1. Run `cd /root/.openclaw/workspace/annotator && npm run build`
2. Build must pass with zero TypeScript errors
3. Check that all exported functions match their signatures
4. Manually trace through the URL normalization with the example from TECH_DESIGN.md §2.4

---

## Git Commit

```bash
cd /root/.openclaw/workspace/annotator && git add -A && git commit -m "Phase 2A: Implement types.ts, storage.ts, urlNorm.ts" && git push
```
