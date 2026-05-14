# Phase 1B — Project Setup Engineer

## Role & Persona

You are a senior frontend engineer who specializes in Chrome extension infrastructure. You set up clean, minimal project scaffolds that "just work." You don't over-engineer. You leave clear stubs so parallel implementation agents can start immediately.

## Before You Start

Read these files fully:
- `/root/.openclaw/workspace/annotator/REQUIREMENTS.md` — source of truth (DO NOT MODIFY)
- `/root/.openclaw/workspace/annotator/TECH_DESIGN.md` — architecture decisions (especially §1, §10)

## What You Produce

A fully working project scaffold in `/root/.openclaw/workspace/annotator/` with:
1. `manifest.json`
2. `package.json`
3. `tsconfig.json`
4. `esbuild.config.js`
5. `src/` directory with stub entry points
6. `npm run build` passes with zero errors

---

## Detailed Requirements

### Directory Structure

Create this exact structure:

```
annotator/
  manifest.json
  package.json
  tsconfig.json
  esbuild.config.js
  src/
    background.ts       ← stub
    content.ts          ← stub (main entry point for content script)
    toolbar.ts          ← stub
    annotationMode.ts   ← stub
    pinRenderer.ts      ← stub
    storage.ts          ← stub
    fingerprint.ts      ← stub
    importExport.ts     ← stub
    urlNorm.ts          ← stub
    types.ts            ← stub
  dist/                 ← gitignored, created by build
```

### `manifest.json`

Create a Manifest V3 Chrome extension manifest. Requirements from TECH_DESIGN.md §10.3:

```json
{
  "manifest_version": 3,
  "name": "Annotator",
  "version": "1.0.0",
  "description": "Annotate any webpage, export as YAML, share with others.",
  "permissions": ["storage", "scripting", "tabs"],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "dist/background.js"
  },
  "action": {
    "default_title": "Annotator"
  },
  "content_security_policy": {
    "extension_pages": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'"
  },
  "icons": {}
}
```

**CRITICAL:** Do NOT add `"default_popup"` to the `action` object. If a popup is specified, `chrome.action.onClicked` never fires and the entire injection flow breaks.

**CRITICAL:** Do NOT declare `content_scripts` in the manifest. Content scripts are injected on demand via `chrome.scripting.executeScript` (see TECH_DESIGN.md §6.1). Adding `content_scripts` would run the extension on every page, violating the requirements.

### `package.json`

```json
{
  "name": "annotator",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "build": "node esbuild.config.js",
    "build:watch": "node esbuild.config.js --watch",
    "test": "jest"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "esbuild": "^0.20.0",
    "@types/chrome": "^0.0.270",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.0",
    "@types/jest": "^29.5.0"
  },
  "dependencies": {
    "js-yaml": "^4.1.0",
    "@types/js-yaml": "^4.0.9"
  }
}
```

Note: `js-yaml` is a runtime dependency (bundled into content script). `@types/js-yaml` provides TypeScript types.

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "lib": ["ES2020", "DOM"],
    "outDir": "./dist",
    "rootDir": "./src",
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

### `esbuild.config.js`

```javascript
const esbuild = require('esbuild');
const path = require('path');

const isWatch = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: {
    'background': 'src/background.ts',
    'content': 'src/content.ts',
  },
  bundle: true,
  outdir: 'dist',
  platform: 'browser',
  target: ['chrome100'],
  format: 'iife',
  sourcemap: true,
  minify: false,
  external: [],
};

if (isWatch) {
  esbuild.context(buildOptions).then(ctx => ctx.watch());
} else {
  esbuild.build(buildOptions).catch(() => process.exit(1));
}
```

**Note:** All modules (toolbar, fingerprint, storage, etc.) are imported by `content.ts` and bundled into `dist/content.js`. Only `background.ts` and `content.ts` are entry points. The `dist/content.js` file is what gets injected via `chrome.scripting.executeScript`.

### Stub Files

Create minimal stubs for each file so the build passes. Each stub should:
- Export the functions/classes that other modules will depend on (with empty implementations)
- Include a comment: `// TODO: Implement in Phase 2`
- Have correct TypeScript types so the build doesn't fail

#### `src/types.ts` stub
```typescript
// TODO: Implement in Phase 2 - Storage & Types Engineer
export interface Annotation {
  pinNumber: number;
  note: string;
  fingerprint: Fingerprint;
  offset: { x: number; y: number };
  createdAt: string;
}

export interface Fingerprint {
  cssSelector: string;
  xpath: string;
  textSnippet: string;
  tagName: string;
}

export interface DomainMeta {
  nextPinNumber: number;
  importedFilename: string | null;
  wasImported: boolean;
  version: number;
}

export interface DomainData {
  meta: DomainMeta;
  pages: Record<string, Annotation[]>;
}
```

#### `src/urlNorm.ts` stub
```typescript
// TODO: Implement in Phase 2 - Storage & Types Engineer
export function normaliseUrl(url: string): string { return url; }
export function normaliseDomain(hostname: string): string { return hostname; }
export function exportFilename(domain: string): string { return `annotations-${domain.replace(/\./g, '_')}.yaml`; }
```

#### `src/storage.ts` stub
```typescript
// TODO: Implement in Phase 2 - Storage & Types Engineer
import type { DomainData, Annotation } from './types';
export async function getDomainData(domain: string): Promise<DomainData | null> { return null; }
export async function saveDomainData(domain: string, data: DomainData): Promise<void> {}
export async function clearDomainData(domain: string): Promise<void> {}
export async function setTabActive(tabId: number): Promise<void> {}
export async function removeTabActive(tabId: number): Promise<void> {}
export async function isTabActive(tabId: number): Promise<boolean> { return false; }
```

#### `src/fingerprint.ts` stub
```typescript
// TODO: Implement in Phase 2 - Fingerprinting Engineer
import type { Fingerprint } from './types';
export function captureFingerprint(element: Element): Fingerprint {
  return { cssSelector: '', xpath: '', textSnippet: '', tagName: element.tagName.toLowerCase() };
}
export function resolveElement(fingerprint: Fingerprint): Element | null { return null; }
```

#### `src/pinRenderer.ts` stub
```typescript
// TODO: Implement in Phase 2 - Pin Rendering Engineer
import type { Annotation } from './types';
export function renderPins(annotations: Annotation[]): void {}
export function clearPins(): void {}
export function showPins(): void {}
export function hidePins(): void {}
```

#### `src/toolbar.ts` stub
```typescript
// TODO: Implement in Phase 2 - Toolbar + UI Engineer
export function initToolbar(tabId: number): void {}
export function setAnnotationMode(active: boolean): void {}
export function setFilename(filename: string | null): void {}
export function showError(message: string): void {}
export function showWarning(message: string): void {}
export function clearMessage(): void {}
export function updateButtonStates(hasAnnotations: boolean, annotationMode: boolean): void {}
export function showResolutionAlert(unresolved: number, total: number): void {}
```

#### `src/annotationMode.ts` stub
```typescript
// TODO: Implement in Phase 2 - Annotation Popover Engineer
export function enableAnnotationMode(): void {}
export function disableAnnotationMode(): void {}
export function isAnnotationModeActive(): boolean { return false; }
```

#### `src/importExport.ts` stub
```typescript
// TODO: Implement in Phase 2 - Import/Export Engineer
export async function importFile(file: File): Promise<void> {}
export async function exportAnnotations(domain: string): Promise<void> {}
```

#### `src/background.ts` stub
```typescript
// TODO: Implement in Phase 2 - Background Worker Engineer
// Background service worker entry point
export {};
```

#### `src/content.ts` stub
```typescript
// TODO: Implement in Phase 3 - Integration Engineer
// Content script main entry point

// Idempotency guard (CRITICAL - do not remove)
if ((window as any).__annotatorActive) {
  // Already initialized on this page - exit to prevent double injection
} else {
  (window as any).__annotatorActive = true;
  
  // TODO: Wire all modules here in Phase 3
  console.log('[Annotator] Content script loaded');
}

export {};
```

### `jest.config.js`

Create a basic jest configuration:
```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    // Mock chrome APIs in tests
  }
};
```

### `.gitignore` additions

Ensure `dist/` and `node_modules/` are in `.gitignore`. Check if `.gitignore` exists first:
```
dist/
node_modules/
*.js.map
```

---

## Installation Steps

After creating all files:

```bash
cd /root/.openclaw/workspace/annotator
npm install
npm run build
```

**The build MUST pass before you commit.** If it fails, fix the errors first.

---

## How to Verify Your Work

1. `npm install` completes without errors
2. `npm run build` exits with code 0
3. `dist/background.js` and `dist/content.js` exist
4. No TypeScript errors
5. File structure matches the spec above

---

## Git Commit

```bash
cd /root/.openclaw/workspace/annotator && git add -A && git commit -m "Project setup: manifest.json, tsconfig, esbuild, package.json, src stubs — npm run build passes" && git push
```
