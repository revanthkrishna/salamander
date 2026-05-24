import * as yaml from 'js-yaml';
import { ImportError, type Annotation, type DomainData, type YamlDocument, type YamlAnnotation } from './types';
import { getDomainData, saveDomainData } from './storage';
import { normaliseDomain, normaliseUrl, exportFilename } from './urlNorm';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CURRENT_EXPORT_VERSION = 1;
const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8MB

// ---------------------------------------------------------------------------
// Public interface for import callbacks
// ---------------------------------------------------------------------------

export interface ImportCallbacks {
  /** Called when a confirmation dialog is needed. Returns true if user confirmed. */
  showConfirm: (message: string) => Promise<boolean>;

  /** Get current annotation count for the domain (for confirmation message). */
  getAnnotationCount: () => Promise<number>;

  /** Get the current domain. */
  getCurrentDomain: () => string;

  /** Called on successful import (triggers annotation mode, updates toolbar). */
  onImportSuccess: (filename: string) => void;

  /** Called to show error/warning in toolbar. */
  showError: (message: string) => void;
  showWarning: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Import pipeline
// ---------------------------------------------------------------------------

/**
 * Process an imported file.
 * Handles all validation, confirmation dialogs, and storage writes.
 * Shows appropriate error/warning messages via callbacks.
 */
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
      callbacks.showError(getErrorMessage(err, currentDomain, ''));
    } else {
      callbacks.showError("This file doesn't look like an Annotator file. Please check you're uploading the right file.");
    }
    return;
  }

  const yamlDoc = doc as YamlDocument;

  // Step 7: Version check (warning only — continue regardless)
  if (yamlDoc.version > CURRENT_EXPORT_VERSION) {
    callbacks.showWarning(
      'This file was created with a newer version of Annotator. Some annotations may not display correctly.'
    );
  }

  // Step 8: Domain check
  const fileDomain = normaliseDomain(yamlDoc.domain);
  const normalisedCurrentDomain = normaliseDomain(currentDomain);
  if (fileDomain !== normalisedCurrentDomain) {
    callbacks.showError(
      `This file contains annotations for '${fileDomain}', but you're currently on '${normalisedCurrentDomain}'.`
    );
    return;
  }

  // Step 9: Existing data check — show confirmation dialog if annotations exist.
  // Case #12 (REQUIREMENTS §5): if state came from an import AND has been modified
  // (wasImported=true, importedFilename=null), show "unsaved changes" message.
  // Case #11: otherwise, show the generic "replace annotations" message.
  const count = await callbacks.getAnnotationCount();
  if (count > 0) {
    const existingData = await getDomainData(currentDomain);
    const hasUnsavedChanges =
      existingData?.meta.wasImported === true &&
      existingData?.meta.importedFilename === null;
    const confirmMsg = hasUnsavedChanges
      ? 'You have unsaved changes. Uploading a new file will discard them. This cannot be undone. Continue?'
      : `Uploading this file will replace your current ${count} annotation${count === 1 ? '' : 's'}. This cannot be undone. Continue?`;
    const confirmed = await callbacks.showConfirm(confirmMsg);
    if (!confirmed) return;
  }

  // Step 10: Transform YAML annotations → storage format
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
        ...(ann.fingerprint.closest_label    !== undefined ? { closestLabel:    ann.fingerprint.closest_label    } : {}),
        ...(ann.fingerprint.page_heading     !== undefined ? { pageHeading:     ann.fingerprint.page_heading     } : {}),
        ...(ann.fingerprint.page_sub_heading !== undefined ? { pageSubHeading:  ann.fingerprint.page_sub_heading } : {}),
        ...(ann.fingerprint.heading_path     !== undefined ? { headingPath:     ann.fingerprint.heading_path     } : {}),
        ...(ann.fingerprint.section_context  !== undefined ? { sectionContext:  ann.fingerprint.section_context  } : {}),
        ...(ann.fingerprint.sibling_text    !== undefined ? { siblingText:    ann.fingerprint.sibling_text    } : {}),
        ...(ann.fingerprint.dom_index       !== undefined ? { domIndex:       ann.fingerprint.dom_index       } : {}),
      },
      offset: { x: ann.offset.x, y: ann.offset.y },
      createdAt: ann.created_at,
    });
  }

  const pinNumbers = yamlDoc.annotations.map((a) => a.pin_number);
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

// ---------------------------------------------------------------------------
// Export pipeline
// ---------------------------------------------------------------------------

/**
 * Build the YAML export string for a domain. Returns null if the domain has
 * no stored data or no annotations. Shared by file-download and copy-to-clipboard.
 */
export async function buildExportYaml(domain: string): Promise<string | null> {
  const domainData = await getDomainData(domain);
  if (!domainData) return null;

  // Flatten all annotations across all pages, sorted by pin number
  const allAnnotations: Array<{ ann: Annotation; pageUrl: string }> = [];
  for (const [pageUrl, annotations] of Object.entries(domainData.pages)) {
    for (const ann of annotations) {
      allAnnotations.push({ ann, pageUrl });
    }
  }
  if (allAnnotations.length === 0) return null;
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
      ...(ann.fingerprint.closestLabel    ? { closest_label:    ann.fingerprint.closestLabel    } : {}),
      ...(ann.fingerprint.pageHeading     ? { page_heading:     ann.fingerprint.pageHeading     } : {}),
      ...(ann.fingerprint.pageSubHeading  ? { page_sub_heading: ann.fingerprint.pageSubHeading  } : {}),
      ...(ann.fingerprint.headingPath && ann.fingerprint.headingPath.length > 0 ? { heading_path: ann.fingerprint.headingPath } : {}),
      ...(ann.fingerprint.sectionContext  ? { section_context:  ann.fingerprint.sectionContext  } : {}),
      ...(ann.fingerprint.siblingText   ? { sibling_text:    ann.fingerprint.siblingText   } : {}),
      ...(ann.fingerprint.domIndex !== undefined ? { dom_index: ann.fingerprint.domIndex } : {}),
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

  return serialiseToYAML(yamlDoc);
}

/**
 * Export all annotations for a domain as a YAML file download.
 */
export async function exportAnnotations(domain: string): Promise<void> {
  const yamlString = await buildExportYaml(domain);
  if (yamlString === null) return;
  const filename = exportFilename(normaliseDomain(domain));
  triggerDownload(yamlString, filename);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse YAML text safely using JSON_SCHEMA (no !!js/function etc.)
 */
function parseYAML(text: string): unknown {
  return yaml.load(text, { schema: yaml.JSON_SCHEMA });
}

/**
 * Validate the parsed YAML document against the expected schema.
 * Throws ImportError with the appropriate code on any validation failure.
 */
function validateSchema(doc: unknown): void {
  if (!doc || typeof doc !== 'object') {
    throw new ImportError('WRONG_SCHEMA');
  }

  const d = doc as Record<string, unknown>;

  if (!('version' in d) || !('domain' in d) || !Array.isArray(d.annotations)) {
    throw new ImportError('WRONG_SCHEMA');
  }

  if ((d.annotations as unknown[]).length === 0) {
    throw new ImportError('EMPTY_ANNOTATIONS');
  }

  const pinNumbers = new Set<number>();
  for (const ann of d.annotations as unknown[]) {
    if (!ann || typeof ann !== 'object') {
      throw new ImportError('WRONG_SCHEMA');
    }
    const a = ann as Record<string, unknown>;

    if (!Number.isInteger(a.pin_number) || (a.pin_number as number) < 1) {
      throw new ImportError('WRONG_SCHEMA');
    }
    if (typeof a.page_url !== 'string' || !a.page_url) {
      throw new ImportError('WRONG_SCHEMA');
    }
    if (typeof a.note !== 'string') {
      // empty string is allowed
      throw new ImportError('WRONG_SCHEMA');
    }

    const fp = a.fingerprint;
    if (!fp || typeof fp !== 'object') {
      throw new ImportError('WRONG_SCHEMA');
    }
    const fpObj = fp as Record<string, unknown>;
    if (
      typeof fpObj.css_selector !== 'string' ||
      typeof fpObj.xpath !== 'string' ||
      typeof fpObj.text_snippet !== 'string' ||
      typeof fpObj.tag_name !== 'string'
    ) {
      throw new ImportError('WRONG_SCHEMA');
    }

    const off = a.offset;
    if (!off || typeof off !== 'object') {
      throw new ImportError('WRONG_SCHEMA');
    }
    const offObj = off as Record<string, unknown>;
    if (typeof offObj.x !== 'number' || typeof offObj.y !== 'number') {
      throw new ImportError('WRONG_SCHEMA');
    }

    const pinNum = a.pin_number as number;
    if (pinNumbers.has(pinNum)) {
      throw new ImportError('DUPLICATE_PINS');
    }
    pinNumbers.add(pinNum);
  }
}

/**
 * Map an ImportError code to the user-facing error string from REQUIREMENTS.md §5.
 */
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
    case 'WRONG_DOMAIN': {
      const fd = err.details?.fileDomain ?? fileDomain;
      return `This file contains annotations for \`${fd}\`, but you're currently on \`${currentDomain}\`.`;
    }
    case 'VERSION_MISMATCH':
      return 'This file was created with a newer version of Annotator. Some annotations may not display correctly.';
    default:
      return 'An unexpected error occurred.';
  }
}

/**
 * Read a File as UTF-8 text using FileReader.
 */
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target!.result as string);
    reader.onerror = () => reject(new Error('Read failed'));
    reader.readAsText(file, 'UTF-8');
  });
}

/**
 * Serialise a document object to YAML string.
 */
function serialiseToYAML(doc: object): string {
  return yaml.dump(doc, {
    sortKeys: false,   // preserve field order for readability
    lineWidth: 120,
    noRefs: true,
    schema: yaml.JSON_SCHEMA,
  });
}

/**
 * Trigger a browser file download for the given text content.
 */
function triggerDownload(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'application/x-yaml; charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  // Stop the synthetic click from bubbling — without this it reaches the
  // annotation-mode click listener (clientX/Y = 0,0 so toolbar guards miss it)
  // and creates a spurious annotation.
  a.addEventListener('click', (e) => e.stopPropagation(), { once: true });
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
