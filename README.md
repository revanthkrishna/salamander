# Annotator

A Chrome extension for inline web annotations. Annotate any webpage, export as a YAML file, and share with others who can import and view the same annotations.

## Features

- Annotate any element on any webpage
- Magenta pin markers with sequential numbering
- Export all annotations as a YAML file
- Import and view annotations from others
- Annotations persist across browser sessions and page reloads
- Works across all pages of a domain

## Development Setup

### Prerequisites

- Node.js 18+
- npm

### Install & Build

```bash
npm install
npm run build
```

This produces `dist/background.js` and `dist/content.js`.

### Run Tests

```bash
npm test
```

101 tests across 4 suites — all should pass.

---

## Loading in Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `annotator` directory — the folder containing `manifest.json` (this folder)
5. The Annotator extension appears in your extension list

To make the icon visible in the toolbar: click the puzzle piece icon (🧩) in the Chrome toolbar and pin **Annotator**.

---

## Using the Extension

1. Navigate to any website
2. Click the **Annotator** icon in the Chrome toolbar
3. The floating toolbar appears in the bottom-right corner of the page
4. Click **Start Annotating** to enter annotation mode
5. Hover over any element — it highlights in magenta
6. Click to open the note popover; type your annotation (up to 400 characters) and click **Add**
7. A numbered magenta pin appears on the element
8. Click **Exit Annotating** to leave annotation mode (pins become invisible but are saved)
9. Click **Export** to download all annotations as a YAML file
10. Click **Upload** to import annotations from a YAML file shared by someone else

### Notes

- Annotations are stored per domain (e.g. all pages under `example.com` share one annotation set)
- Pins are numbered sequentially; numbers are never reused after deletion
- After importing a file, the filename is shown in the toolbar — it disappears as soon as you make any change

---

## Architecture

See `TECH_DESIGN.md` for the full technical design.

### Quick overview

| File | Role |
|---|---|
| `src/content.ts` | Main content script: toolbar, pins, popover, annotation mode, SPA detection |
| `src/background.ts` | Background service worker: tab lifecycle, content script injection |
| `src/storage.ts` | `chrome.storage.local` helpers for domain annotation data |
| `src/importExport.ts` | YAML export and 14-case import validation pipeline |
| `src/fingerprint.ts` | CSS selector / XPath / text-snippet generation and resolution |
| `src/urlNorm.ts` | URL normalisation (domain extraction, per-page keys) |
| `src/toolbar.ts` | Toolbar Shadow DOM component |
| `src/annotationMode.ts` | Hover highlight + popover Shadow DOM component |
| `src/pinRenderer.ts` | Pin element creation, positioning, scroll repositioning |
| `src/types.ts` | Shared TypeScript types |

---

## Security

This extension makes **zero network requests**. All annotation data stays on your machine in `chrome.storage.local`. The manifest CSP enforces `connect-src 'none'`. See `TECH_DESIGN.md §10` for the full security model.

---

## Permissions

| Permission | Why |
|---|---|
| `storage` | Annotation persistence across sessions |
| `scripting` | On-demand content script injection when icon is clicked |
| `tabs` | Tab lifecycle management for reload persistence |
| `<all_urls>` | The extension works on any website |

---

## License

MIT
