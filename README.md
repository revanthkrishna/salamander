# 🦎 Salamander

> *It leaves yellow spots on websites. Just like a salamander.*

A Chrome extension for inline web annotations. Click the **S** button, annotate any element on any page, export as YAML, and share with anyone. They import it and see exactly what you saw.

---

## What it does

- **Annotate anything** — click any element on any webpage and leave a note
- **Golden pins** — numbered yellow markers that stick to elements across scrolls, resizes, and page reloads
- **Export** — all annotations for a domain exported as a single readable YAML file
- **Import** — open someone else's annotation file and their pins appear on your screen
- **Persistent** — annotations survive browser restarts and page reloads
- **Cross-domain aware** — annotations are scoped per domain, covering all pages under it

---

## How to use

1. Navigate to any website
2. Click the **Salamander** icon in your Chrome toolbar
3. An **S button** appears in the bottom-right corner — click it to enter annotation mode
4. Hover over elements — they highlight in yellow
5. Click any element to drop a note
6. Type your annotation (up to 400 characters) and hit **save**
7. A numbered yellow 🦎 pin appears on the element
8. Use the toolbar to **export**, **import**, or **delete all**
9. Click **✕** to exit annotation mode (pins hide, annotations stay saved)

---

## Install for development

```bash
npm install
npm run build
```

Then load it in Chrome:

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select this folder (the one with `manifest.json`)
4. Pin the Salamander icon from the 🧩 extensions menu

---

## Run tests

```bash
npm test
```

---

## Architecture

| File | Role |
|---|---|
| `src/content.ts` | Main content script — wires everything together |
| `src/background.ts` | Service worker — tab lifecycle, script injection |
| `src/fingerprint.ts` | Multi-signal element fingerprinting (CSS selector + XPath + text match) |
| `src/pinRenderer.ts` | Pin creation, positioning, MutationObserver retry for async DOM |
| `src/toolbar.ts` | S button + toolbar panel (Shadow DOM) |
| `src/annotationMode.ts` | Hover highlight + annotation popover (Shadow DOM) |
| `src/importExport.ts` | YAML export + 14-case import validation pipeline |
| `src/storage.ts` | `chrome.storage.local` helpers |
| `src/urlNorm.ts` | URL and domain normalisation |
| `src/types.ts` | Shared TypeScript types |

Full technical details in [`TECH_DESIGN.md`](./TECH_DESIGN.md).

---

## Privacy & Security

Zero network requests. Ever. All annotation data lives in `chrome.storage.local` on your machine. The manifest CSP enforces `connect-src 'none'`. Nothing leaves your device unless you explicitly export a file.

| Permission | Why |
|---|---|
| `storage` | Saving annotations across sessions |
| `scripting` | Injecting the extension into pages on demand |
| `tabs` | Tab lifecycle for reload persistence |
| `<all_urls>` | Works on any website |

---

## License

MIT
