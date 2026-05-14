# Phase 2G — Import/Export Engineer

## Role & Persona

You are a TypeScript engineer who handles file I/O, validation, and serialization. You read the spec carefully, implement all error cases exactly as documented, and never let malformed input crash the extension. You're thorough but not over-engineered — the error messages are the spec, not your creative writing exercise.

## Before You Start

Read these files fully:
- `/root/.openclaw/workspace/annotator/REQUIREMENTS.md` — source of truth (DO NOT MODIFY), especially:
  - §1.3 (Exporting) and §1.3.1 (Export File Contents)
  - §1.4 (Importing)
  - §5 (Import Error Handling) — **READ EVERY ROW OF THIS TABLE**
  - §6 Edge Cases #7, #8 (URL normalization in export)
- `/root/.openclaw/workspace/annotator/TECH_DESIGN.md` — **read these sections IN FULL:**
  - §3 (YAML Schema — Normative)
  - §8 (Import Pipeline)
  - §9 (Export Pipeline)
  - §10.6 (XSS Prevention — important for display, though importExport.ts does not touch DOM)

Also check:
- `/root/.openclaw/workspace/annotator/src/importExport.ts` (stub)
- `/root/.openclaw/workspace/annotator/src/types.ts` (YamlDocument, YamlAnnotation, ImportError, Annotation interfaces)
- `/root/.openclaw/workspace/annotator/src/storage.ts` (storage functions you'll call)
- `/root/.openclaw/workspace/annotator/src/urlNorm.ts` (normaliseDomain, normaliseUrl)

## What You Produce

Fully implement one file: `src/importExport.ts`

Do NOT modify any other files.

---

## Implementation Requirements

### Overview

The import/export module handles:
1. **Import:** Read a `.yaml` file → validate → check for conflicts → write to storage → trigger auto-annotation-mode
2. **Export:** Read all domain annotations from storage → serialize to YAML → trigger browser download

### Constants

```typescript
const CURRENT_EXPORT_VERSION = 1;
const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8MB
```

### Import Pipeline

Implement the full step-by-step pipeline from TECH_DESIGN.md §8.1:

```typescript
export interface ImportCallbacks {
  // Called when a confirmation dialog is needed
  // Returns true if user confirmed, false if cancelled
  showConfirm: (message: string) => Promise<boolean>;
  
  // Get current annotation count for the domain (for confirmation message)
  getAnnotationCount: () => Promise<number>;
  
  // Get current domain
  getCurrentDomain: () => string;
  
  // Called on successful import (triggers annotation mode, updates toolbar)
  onImportSuccess: (filename: string) => void;
  
  // Called to show error/warning in toolbar
  showError: (message: string) => void;
  showWarning: (message: string) => void;
}

/**
 * Process an imported file.
 * Handles all validation, confirmation dialogs, and storage writes.
 * Shows appropriate error/warning messages via callbacks.
 */
export async function importFile(file: File, callbacks: ImportCallbacks): Promise<void>
```

#### Step-by-step import implementation:

```typescript
export async function importFile(file: File, callbacks: ImportCallbacks): Promise<void> {
  const currentDomain = callbacks.getCurrentDomain();
  
  // Step 1: File size check
  if (file.size > MAX_FILE_SIZE) {
    callbacks.showError('This file is too large to import (max 8MB).');
    return;
  }
  
  // Step 2: File extension check
  const name = file.name.toLowerCase();
  if (!name.endsWith('.yaml') && !name.endsWith('.yml')) {
    callbacks.showError('Invalid file type. Please upload a .yaml annotation file.');
    return;
  }
  
  // Step 3: Read file as UTF-8
  let text: string;
  try {
    text = await readFileAsText(file);
  } catch {
    callbacks.showError('Could not read this file — it appears to be corrupted or incorrectly formatted.');
    return;
  }
  
  // Step 4: Empty check
  if (!text || text.trim().length === 0) {
    callbacks.showError('This file is empty. Nothing to import.');
    return;
  }
  
  // Step 5: YAML parse
  let doc: unknown;
  try {
    doc = parseYAML(text);
  } catch {
    callbacks.showError('Could not read this file — it appears to be corrupted or incorrectly formatted.');
    return;
  }
  
  // Step 6: Schema validation
  try {
    validateSchema(doc);
  } catch (err) {
    if (err instanceof ImportError) {
      const msg = getErrorMessage(err, currentDomain, '');
      callbacks.showError(msg);
    } else {
      callbacks.showError("This file doesn't look like an Annotator file. Please check you're uploading the right file.");
    }
    return;
  }
  
  const yamlDoc = doc as YamlDocument;
  
  // Step 7: Version check
  if (yamlDoc.version > CURRENT_EXPORT_VERSION) {
    callbacks.showWarning('This file was created with a newer version of Annotator. Some annotations may not display correctly.');
    // Continue — don't return
  }
  
  // Step 8: Domain check
  const fileDomain = normaliseDomain(yamlDoc.domain);
  if (fileDomain !== normaliseDomain(currentDomain)) {
    callbacks.showError(
      `This file contains annotations for \`${fileDomain}\`, but you're currently on \`${currentDomain}\`.`
    );
    return;
  }
  
  // Step 9: Existing data check (confirmation dialogs)
  const count = await callbacks.getAnnotationCount();
  if (count > 0) {
    // Need to determine which confirmation: #11 or #12
    // The storage layer knows wasImported/importedFilename — pass this info via a separate query
    // For simplicity, always show dialog #11 if there are annotations (integration layer determines #11 vs #12)
    const confirmed = await callbacks.showConfirm(
      `Uploading this file will replace your current ${count} annotation${count === 1 ? '' : 's'}. This cannot be undone. Continue?`
    );
    if (!confirmed) return;
  }
  
  // Step 10: Transform YAML → storage format
  const domain = normaliseDomain(yamlDoc.domain);
  const pages: Record<string, Annotation[]> = {};
  
  for (const ann of yamlDoc.annotations) {
    const pageUrl = normaliseUrl(ann.page_url);
    if (!pages[pageUrl]) pages[pageUrl] = [];
    pages[pageUrl].push({
      pinNumber: ann.pin_number,
      note: ann.note,
      fingerprint: {
        cssSelector: ann.fingerprint.css_selector,
        xpath: ann.fingerprint.xpath,
        textSnippet: ann.fingerprint.text_snippet,
        tagName: ann.fingerprint.tag_name,
      },
      offset: { x: ann.offset.x, y: ann.offset.y },
      createdAt: ann.created_at,
    });
  }
  
  const pinNumbers = yamlDoc.annotations.map(a => a.pin_number);
  const nextPinNumber = Math.max(...pinNumbers) + 1;
  
  const domainData: DomainData = {
    meta: {
      nextPinNumber,
      importedFilename: file.name,
      wasImported: true,
      version: 1,
    },
    pages,
  };
  
  // Step 11: Write to storage
  await saveDomainData(domain, domainData);
  
  // Step 12: Notify success
  callbacks.onImportSuccess(file.name);
}
```

#### YAML Parsing (per TECH_DESIGN.md §8.3)

```typescript
import * as yaml from 'js-yaml';

function parseYAML(text: string): unknown {
  // Use JSON_SCHEMA to restrict to safe types (no !!js/function etc.)
  return yaml.load(text, { schema: yaml.JSON_SCHEMA });
}
```

#### Schema Validation (per TECH_DESIGN.md §8.4)

```typescript
function validateSchema(doc: unknown): void {
  if (!doc || typeof doc !== 'object') throw new ImportError('WRONG_SCHEMA');
  
  const d = doc as Record<string, unknown>;
  if (!('version' in d) || !('domain' in d) || !Array.isArray(d.annotations)) {
    throw new ImportError('WRONG_SCHEMA');
  }
  
  if (d.annotations.length === 0) throw new ImportError('EMPTY_ANNOTATIONS');
  
  const pinNumbers = new Set<number>();
  for (const ann of d.annotations as unknown[]) {
    const a = ann as Record<string, unknown>;
    
    if (!Number.isInteger(a.pin_number) || (a.pin_number as number) < 1)
      throw new ImportError('WRONG_SCHEMA');
    if (typeof a.page_url !== 'string' || !a.page_url)
      throw new ImportError('WRONG_SCHEMA');
    if (typeof a.note !== 'string')  // allow empty string
      throw new ImportError('WRONG_SCHEMA');
    
    const fp = a.fingerprint as Record<string, unknown> | null;
    if (!fp || typeof fp !== 'object')
      throw new ImportError('WRONG_SCHEMA');
    if (typeof fp.css_selector !== 'string' ||
        typeof fp.xpath !== 'string' ||
        typeof fp.text_snippet !== 'string' ||
        typeof fp.tag_name !== 'string')
      throw new ImportError('WRONG_SCHEMA');
    
    const off = a.offset as Record<string, unknown> | null;
    if (!off || typeof off.x !== 'number' || typeof off.y !== 'number')
      throw new ImportError('WRONG_SCHEMA');
    
    const pinNum = a.pin_number as number;
    if (pinNumbers.has(pinNum)) throw new ImportError('DUPLICATE_PINS');
    pinNumbers.add(pinNum);
  }
}
```

#### File Read Helper

```typescript
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target!.result as string);
    reader.onerror = () => reject(new Error('Read failed'));
    reader.readAsText(file, 'UTF-8');
  });
}
```

### Export Pipeline (per TECH_DESIGN.md §9)

```typescript
/**
 * Export all annotations for a domain as a YAML file download.
 */
export async function exportAnnotations(domain: string): Promise<void> {
  const domainData = await getDomainData(domain);
  if (!domainData) return;
  
  // Flatten all annotations across all pages, sorted by pin number
  const allAnnotations: Array<{ ann: Annotation; pageUrl: string }> = [];
  for (const [pageUrl, annotations] of Object.entries(domainData.pages)) {
    for (const ann of annotations) {
      allAnnotations.push({ ann, pageUrl });
    }
  }
  allAnnotations.sort((a, b) => a.ann.pinNumber - b.ann.pinNumber);
  
  // Build YAML document object (field order matches TECH_DESIGN.md §3.1)
  const yamlAnnotations: YamlAnnotation[] = allAnnotations.map(({ ann, pageUrl }) => ({
    pin_number: ann.pinNumber,
    page_url: pageUrl,
    note: ann.note,
    fingerprint: {
      css_selector: ann.fingerprint.cssSelector,
      xpath: ann.fingerprint.xpath,
      text_snippet: ann.fingerprint.textSnippet,
      tag_name: ann.fingerprint.tagName,
      // boundingBox intentionally excluded from export
    },
    offset: { x: ann.offset.x, y: ann.offset.y },
    created_at: ann.createdAt,
  }));
  
  const yamlDoc: YamlDocument = {
    version: CURRENT_EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    domain: normaliseDomain(domain),
    annotations: yamlAnnotations,
  };
  
  const yamlString = serialiseToYAML(yamlDoc);
  const filename = exportFilename(normaliseDomain(domain));
  
  triggerDownload(yamlString, filename);
}

function serialiseToYAML(doc: object): string {
  return yaml.dump(doc, {
    sortKeys: false,    // preserve field order for readability
    lineWidth: 120,
    noRefs: true,
    schema: yaml.JSON_SCHEMA,
  });
}

function triggerDownload(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'application/x-yaml; charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
```

### Error Message Map

All error message strings from REQUIREMENTS.md §5:

```typescript
function getErrorMessage(err: ImportError, currentDomain: string, fileDomain: string): string {
  switch (err.code) {
    case 'FILE_TOO_LARGE':
      return 'This file is too large to import (max 8MB).';
    case 'WRONG_TYPE':
      return 'Invalid file type. Please upload a .yaml annotation file.';
    case 'EMPTY_FILE':
      return 'This file is empty. Nothing to import.';
    case 'MALFORMED':
      return 'Could not read this file — it appears to be corrupted or incorrectly formatted.';
    case 'WRONG_SCHEMA':
      return "This file doesn't look like an Annotator file. Please check you're uploading the right file.";
    case 'EMPTY_ANNOTATIONS':
      return 'This file exists but contains no annotations.';
    case 'DUPLICATE_PINS':
      return 'This file appears to be corrupted (duplicate pin numbers detected).';
    case 'WRONG_DOMAIN':
      return `This file contains annotations for \`${err.details?.fileDomain ?? ''}\`, but you're currently on \`${currentDomain}\`.`;
    case 'VERSION_MISMATCH':
      return 'This file was created with a newer version of Annotator. Some annotations may not display correctly.';
    default:
      return 'An unexpected error occurred.';
  }
}
```

### Imports

```typescript
import * as yaml from 'js-yaml';
import { ImportError, type Annotation, type DomainData, type YamlDocument, type YamlAnnotation } from './types';
import { getDomainData, saveDomainData } from './storage';
import { normaliseDomain, normaliseUrl, exportFilename } from './urlNorm';
```

---

## Security Notes

- YAML is parsed with `yaml.JSON_SCHEMA` to prevent code injection via `!!js/function` tags
- All strings from the YAML file must be treated as untrusted (don't use them in innerHTML)
- The download uses a Blob URL — no permissions needed, no network calls

---

## How to Verify Your Work

1. `cd /root/.openclaw/workspace/annotator && npm run build` — zero TypeScript errors
2. All exported functions match their signatures
3. Import handles all 14 error cases from REQUIREMENTS.md §5 (trace through each one)
4. Export includes annotations from ALL pages (not just current page)
5. YAML uses `JSON_SCHEMA` for both parse and serialize

---

## Git Commit

```bash
cd /root/.openclaw/workspace/annotator && git add -A && git commit -m "Phase 2G: Implement importExport.ts — full import pipeline, all error cases, YAML export" && git push
```
