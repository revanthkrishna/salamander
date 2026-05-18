# 🦎 salamander

annotate directly on webpage elements. share exactly what you see.

---

> *it leaves yellow spots on websites. just like a salamander.*

salamander is a Chrome extension for inline web annotations. click the salamander button, pin notes on any element of any page, export as a YAML file, and share it with anyone — they import it and see exactly what you saw, pins and all.

---

## what it does

- **annotate anything** — click any element on any webpage and leave a note
- **numbered pins** — yellow markers that stick to elements across scrolls, resizes, and page reloads
- **export** — all annotations for a domain exported as a single readable YAML file
- **import** — open someone else's annotation file and their pins appear on your screen
- **persistent** — annotations survive browser restarts and page reloads
- **cross-domain aware** — annotations are scoped per domain, covering all pages under it

---

## how to use

1. navigate to any website
2. click the salamander icon in your Chrome toolbar
3. the salamander button appears in the bottom-right corner — click it to enter annotation mode
4. hover over elements — they highlight in yellow
5. click any element to drop a note
6. type your annotation (up to 400 characters) and hit save
7. a numbered yellow pin appears on the element
8. use the toolbar to export, import, or delete all
9. click ✕ to exit annotation mode (pins hide, annotations stay saved)

---

## architecture

| file | role |
|---|---|
| `src/content.ts` | main content script — wires everything together |
| `src/background.ts` | service worker — tab lifecycle, script injection |
| `src/fingerprint.ts` | multi-signal element fingerprinting (CSS selector + XPath + text match) |
| `src/pinRenderer.ts` | pin creation, positioning, MutationObserver retry for async DOM |
| `src/toolbar.ts` | salamander button + toolbar panel (Shadow DOM) |
| `src/annotationMode.ts` | hover highlight + annotation popover (Shadow DOM) |
| `src/importExport.ts` | YAML export + 14-case import validation pipeline |
| `src/storage.ts` | `chrome.storage.local` helpers |
| `src/urlNorm.ts` | URL and domain normalisation |
| `src/types.ts` | shared TypeScript types |

full technical details in [`TECH_DESIGN.md`](./TECH_DESIGN.md).

---

## privacy & security

zero network requests. ever. all annotation data lives in `chrome.storage.local` on your machine. the manifest CSP enforces `connect-src 'none'`. nothing leaves your device unless you explicitly export a file.

| permission | why |
|---|---|
| `storage` | saving annotations across sessions |
| `scripting` | injecting the extension into pages on demand |
| `tabs` | tab lifecycle for reload persistence |
| `<all_urls>` | works on any website |

---

## license

MIT
