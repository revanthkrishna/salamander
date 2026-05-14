# Annotator — Technical Design Document

> **Version:** 1.0  
> **Status:** Draft  
> **Scope:** Chrome Extension v1

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Storage](#2-storage)
3. [YAML Schema (Normative)](#3-yaml-schema-normative)
4. [Element Fingerprinting](#4-element-fingerprinting)
5. [Pin Rendering](#5-pin-rendering)
6. [Toolbar Injection & Lifecycle](#6-toolbar-injection--lifecycle)
   - 6.6 [Annotation Mode — Hover & Click Implementation](#66-annotation-mode--hover--click-implementation)
   - 6.7 [Popover Implementation](#67-popover-implementation)
7. [Cross-Tab Sync](#7-cross-tab-sync)
8. [Import Pipeline](#8-import-pipeline)
9. [Export Pipeline](#9-export-pipeline)
10. [Security](#10-security)
11. [Trade-offs & Alternatives Considered](#11-trade-offs--alternatives-considered)

---

## 1. Architecture Overview

### 1.1 Component Breakdown

Annotator is a Manifest V3 Chrome extension with three runtime components:

| Component | File(s) | What it owns |
|---|---|---|
| **Content Script** | `content/index.js` | All in-page UI — toolbar, pins, popover, annotation mode, element fingerprinting, pin rendering |
| **Background Service Worker** | `background.js` | Extension icon click handling; tab activation tracking; injecting the content script on demand |
| **No Popup** | — | Intentionally omitted; the toolbar lives in the page |

There is **no browser popup**. The extension icon click directly injects the toolbar into the active tab. This is the correct model because all meaningful interaction happens in-page.

### 1.2 Why Each Component Exists

**Content Script** does everything the user sees and touches. It runs in the context of the page (isolated JS world, shared DOM), which is the only place pins and the toolbar can exist. It manages:
- Toolbar DOM lifecycle
- Annotation mode (highlight on hover, click-to-annotate, popover)
- Pin rendering and position updates
- Storage reads/writes
- Import/export orchestration

**Background Service Worker** is deliberately thin. Its only jobs are:
1. Listen for `chrome.action.onClicked` (icon click)
2. Check if the content script is already active on that tab (via a `ping` message)
3. If not: inject the content script; if yes: tell it the icon was clicked (no-op per requirements)

The service worker does **not** hold any annotation state. State lives in `chrome.storage.local`.

### 1.3 Message Passing Design

All cross-component communication uses `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`.

#### Background → Content Script

| Message | When | Payload |
|---|---|---|
| `{ type: "ACTIVATE", tabId: number }` | Icon clicked, content script not yet present | `tabId` — the tab's ID, passed so the content script can identify itself |
| `{ type: "ICON_CLICKED" }` | Icon clicked, content script already active | none |

#### Content Script → Background

| Message | When | Payload |
|---|---|---|
| `{ type: "PING" }` | Background checks if content script is alive | → response: `{ alive: true, tabId: number }` |

**How the content script gets its tab ID:** Content scripts in MV3 cannot reliably self-identify their tab ID (`chrome.tabs.getCurrent()` is undefined in injected content scripts). The background passes the tab ID explicitly:
- On `ACTIVATE`: the background includes `tabId` in the message payload
- On PING: the background includes `tabId` in the response

The content script stores this as `let myTabId = message.tabId` (or `response.tabId`) on receipt and uses it for all `activeTab:{tabId}` storage operations.

#### Storage events (no direct messages)

Cross-tab state updates travel via `chrome.storage.onChanged` events, not direct messages. Each content script instance subscribes to storage changes and re-renders pins when storage mutates. See §7.

### 1.4 Content Script Internal Architecture

The content script is structured as a set of cooperating modules (bundled into one file via a bundler):

```
content/
  index.js          — entry point, sets up everything on inject
  toolbar.js        — toolbar DOM, button state, message display
  annotationMode.js — hover highlight, click interception, popover
  pinRenderer.js    — pin creation, positioning, show/hide
  storage.js        — all chrome.storage.local read/write helpers
  fingerprint.js    — CSS selector / XPath / text capture + resolution
  importExport.js   — YAML parse/validate/serialize, file download
  urlNorm.js        — URL and domain normalization utilities
```

These are logical modules bundled with esbuild (or similar) into a single content script file for simplicity. No module loader at runtime.

---

## 2. Storage

### 2.1 Mechanism: `chrome.storage.local`

**Decision:** Use `chrome.storage.local`.

Rationale:
- Persists across browser restarts (unlike `sessionStorage`)
- Local to device + Chrome profile (no unintended sync)
- ~10MB quota — exceeds the 8MB requirement
- Natively async and available in both content scripts and service workers
- No setup required — works out of the box in MV3

Storage quota handling is **out of scope for v1**. If writes fail due to quota exceeded, the error is silently dropped (the requirements explicitly exclude quota handling).

### 2.2 Storage Schema

All extension data lives under a single top-level key per domain. There is also one global key for tab activation state.

#### Top-Level Keys

| Key Pattern | Type | Purpose |
|---|---|---|
| `annotations:{domain}` | Object | All annotation data for a normalised domain |
| `activeTab:{tabId}` | boolean (`true`) | Present when the toolbar is active on that tab; absent when inactive |

#### Domain Object Structure

```
annotations:{domain}:
  meta:
    nextPinNumber: number        // highest used pin + 1
    importedFilename: string?    // null if no file imported or modified after import
    version: number              // storage schema version (currently 1)
  pages:
    {pageUrl}: Annotation[]      // keyed by normalised URL (no params/fragments)
```

#### Annotation Object

```typescript
interface Annotation {
  pinNumber: number;             // globally unique, globally sequential
  note: string;                  // max 400 chars
  fingerprint: Fingerprint;
  offset: { x: number; y: number }; // click point relative to element top-left
  createdAt: string;             // ISO 8601
}

interface Fingerprint {
  cssSelector: string;
  xpath: string;
  textSnippet: string;           // first ~50 chars of element text
  tagName: string;               // lowercase
  boundingBox: {                 // hint only — not used for resolution; intentionally OMITTED from YAML export
    top: number;
    left: number;
    width: number;
    height: number;
  };
}
```

#### Full Concrete Example

```json
{
  "annotations:figma.com": {
    "meta": {
      "nextPinNumber": 5,
      "importedFilename": null,
      "version": 1
    },
    "pages": {
      "https://www.figma.com/blog/how-we-built-figma": [
        {
          "pinNumber": 1,
          "note": "This is the key architectural insight.",
          "fingerprint": {
            "cssSelector": "#main-content > article > p:nth-of-type(3)",
            "xpath": "/html/body/main/div[2]/article/p[3]",
            "textSnippet": "The challenge was making the rendering engin",
            "tagName": "p",
            "boundingBox": { "top": 412, "left": 80, "width": 760, "height": 48 }
          },
          "offset": { "x": 120, "y": 20 },
          "createdAt": "2026-05-14T04:30:00.000Z"
        }
      ]
    }
  }
}
```

### 2.3 Domain Key Normalisation

Domain keys are derived from the normalised domain (see §6 URL normalisation). Example: `figma.com`, `app.example.com`, `amazon.com`.

The `www.` prefix is stripped before forming the key, so `www.figma.com` and `figma.com` map to the same key `annotations:figma.com`.

### 2.4 Page URL Normalisation

Page URLs stored as keys within `pages`:
- Scheme is lowercased; hostname is lowercased
- `www.` prefix stripped
- Port ignored
- Path preserved as-is (case-sensitive)
- Trailing slash stripped
- Query params stripped
- Fragment stripped
- `http://` normalised to `https://`

Example: `http://www.figma.com/blog/How-We-Built-Figma?ref=twitter#intro` → `https://figma.com/blog/How-We-Built-Figma`

### 2.5 Pin Number Management

`meta.nextPinNumber` is the source of truth for the next pin number to assign. It is always `max(all existing pinNumbers) + 1`.

On every annotation write (create), the content script:
1. Reads current storage
2. Assigns `meta.nextPinNumber` to the new pin
3. Writes the new annotation
4. Updates `meta.nextPinNumber = newPin.pinNumber + 1`

On import, `meta.nextPinNumber` is set to `max(importedPins) + 1` regardless of gaps.

On delete: `meta.nextPinNumber` is **not** decremented. Gaps are preserved.

**Known v1 limitation — concurrent multi-tab pin numbering:** The read-then-write sequence is not atomic. Two tabs annotating simultaneously can both read the same `nextPinNumber`, both assign the same pin number, and produce a duplicate. Since `chrome.storage.local` has no transactional writes, this is an inherent constraint in v1. It is accepted under the same "last-write-wins" policy as other concurrent writes (§7.3). Duplicate pin numbers created this way will not surface as import errors for the active session, but a re-exported file with duplicates would fail import on the duplicate check (§3.3 rule 6). The likelihood is low in practice (requires two tabs annotating within the same storage roundtrip window).

### 2.6 Tab Activation State

Each tab where the toolbar is active stores a single key: `activeTab:{tabId}: true`. When the toolbar is deactivated or the tab closes, the key is deleted.

**Why per-tab keys instead of a shared array:** A shared `activeTabIds: number[]` requires all tabs to do read-modify-write operations on the same key. Two tabs registering simultaneously would race and clobber each other's entries. Per-tab keys are independent — each tab owns only its own key and never needs to read others.

The background service worker checks `chrome.storage.local.get('activeTab:' + tabId)` to decide whether to inject or send a no-op. The content script sets `chrome.storage.local.set({ ['activeTab:' + myTabId]: true })` on init and removes it on tab close.

---

## 3. YAML Schema (Normative)

### 3.1 Full Schema

```yaml
version: 1                                  # integer — Annotator export format version
exported_at: "2026-05-14T04:30:00.000Z"    # ISO 8601 UTC timestamp
domain: "figma.com"                         # normalised domain (www. stripped)

annotations:
  - pin_number: 1                           # integer, globally unique
    page_url: "https://figma.com/blog/how-we-built-figma"  # normalised URL, no params/fragments
    note: "This is the key architectural insight."          # string, max 400 chars
    fingerprint:
      css_selector: "#main-content > article > p:nth-of-type(3)"
      xpath: "/html/body/main/div[2]/article/p[3]"
      text_snippet: "The challenge was making the rendering engin"  # first ~50 chars
      tag_name: "p"                         # lowercase element tag
    offset:
      x: 120                               # pixels from element left edge
      y: 20                                # pixels from element top edge
    created_at: "2026-05-14T04:30:00.000Z" # ISO 8601 UTC

  - pin_number: 2
    page_url: "https://figma.com/blog/how-we-built-figma"
    note: "Worth citing in the architecture doc."
    fingerprint:
      css_selector: "h2#performance"
      xpath: "/html/body/main/div[2]/article/h2[2]"
      text_snippet: "Performance at Scale"
      tag_name: "h2"
    offset:
      x: 0
      y: 0
    created_at: "2026-05-14T04:31:00.000Z"
```

### 3.2 Field Reference

| Field | Type | Required | Notes |
|---|---|---|---|
| `version` | integer | ✅ | Currently `1`. Increment on breaking schema changes. |
| `exported_at` | string (ISO 8601) | ✅ | UTC timestamp of export. Human reference only. |
| `domain` | string | ✅ | Normalised domain without `www.`. Validated on import. |
| `annotations` | array | ✅ | May not be empty (rejected on import if empty). |
| `annotations[].pin_number` | integer | ✅ | Must be unique within the file. |
| `annotations[].page_url` | string | ✅ | Normalised URL. No query params or fragments. |
| `annotations[].note` | string | ✅ | Max 400 chars. |
| `annotations[].fingerprint` | object | ✅ | All sub-fields required. |
| `annotations[].fingerprint.css_selector` | string | ✅ | Full CSS path to element. |
| `annotations[].fingerprint.xpath` | string | ✅ | Absolute XPath from document root. |
| `annotations[].fingerprint.text_snippet` | string | ✅ | May be empty string if element has no text. |
| `annotations[].fingerprint.tag_name` | string | ✅ | Lowercase tag. Used in text-match fallback. |
| `annotations[].offset` | object | ✅ | Click position relative to element top-left. |

> **Note on `boundingBox`:** The internal `Fingerprint` storage interface includes a `boundingBox` field (§2.2). This field is **intentionally excluded from the YAML export** — it is a rendering hint used only at runtime and is not needed for annotation resolution or round-trip fidelity. Do not include it in the export serializer.
| `annotations[].offset.x` | number | ✅ | Pixels. |
| `annotations[].offset.y` | number | ✅ | Pixels. |
| `annotations[].created_at` | string (ISO 8601) | ✅ | UTC. |

### 3.3 Validation Rules (Normative)

On import, all of the following must pass or the file is rejected:

1. File extension is `.yaml` or `.yml`
2. File is non-empty
3. File parses as valid YAML
4. Top-level object has `version`, `domain`, `annotations` keys
5. `annotations` is a non-empty array
6. All `annotations[].pin_number` values are unique
7. `domain` matches the normalised domain of the current tab
8. `version` ≤ current supported version (warn if version > supported)
9. File size ≤ 8MB
10. Each annotation has all required fields

### 3.4 Versioning Strategy

```javascript
const CURRENT_EXPORT_VERSION = 1; // increment on breaking schema changes
```

- `version: 1` is the current format.
- On a **breaking change** (field renamed, removed, or semantics changed): increment to `2`. Import code checks: if `file.version > CURRENT_VERSION`, show yellow warning and proceed; if schema fails validation, reject with red error.
- On a **backward-compatible addition** (new optional field): same version. Old importers ignore unknown fields.
- The version is an integer, not semver. No minor versions.

---

## 4. Element Fingerprinting

### 4.1 Capture Algorithm

When the user clicks an element, the following is captured synchronously (before any storage write):

```
function captureFingerprint(element):
  return {
    cssSelector: buildCSSSelector(element),
    xpath: buildXPath(element),
    textSnippet: element.textContent.trim().slice(0, 50),
    tagName: element.tagName.toLowerCase(),
    boundingBox: element.getBoundingClientRect() + scrollOffset
  }
```

#### 4.2 CSS Selector Generation (`buildCSSSelector`)

The generator walks up the DOM from the target element to `<body>`, building the shortest stable selector it can.

**Priority order (first match wins at each level):**

1. **Element has a non-empty `id`:** use `#id`. Stop walking up — IDs are globally unique. Return immediately.
2. **Element has a `data-*` attribute that is non-generated and stable:** use `[data-testid="value"]` or `[data-id="value"]`. Prefer `data-testid`, `data-id`, `data-cy`, `data-qa` in that order.
3. **Element has a stable, non-generated `class`:** use `tagName.className`. A class is considered unstable if it matches patterns like `/[a-z]{1,3}_[a-z0-9]{4,}/` (hashed/generated class names, common in CSS modules and Tailwind-JIT).
4. **Fallback:** use `tagName:nth-of-type(n)` where `n` is the element's position among siblings of the same tag.

The selector is built as a full path: each ancestor contributes one segment, joined with ` > `.

**Example output:** `#main-content > article > p:nth-of-type(3)`

**Length cap:** If the generated selector exceeds 512 characters, truncate from the top (drop the oldest ancestor segments) and use a shorter path that still resolves uniquely. If uniqueness cannot be guaranteed, keep the full path anyway — resolution will validate it.

#### 4.3 XPath Generation (`buildXPath`)

Walk up from the target element to `<html>`, building an absolute XPath:

```
function buildXPath(element):
  parts = []
  node = element
  while node.nodeType == ELEMENT_NODE:
    tag = node.tagName.toLowerCase()
    siblings = node.parentNode.children with same tag
    if siblings.length > 1:
      index = 1-based position of node among siblings
      parts.unshift(tag + "[" + index + "]")
    else:
      parts.unshift(tag)
    node = node.parentNode
  return "/" + parts.join("/")
```

**Example output:** `/html/body/main/div[2]/article/p[3]`

### 4.4 Resolution Algorithm (on Import)

For each annotation in the imported file, when the content script runs on that page:

```
function resolveElement(fingerprint):
  // 1. CSS selector
  try:
    el = document.querySelector(fingerprint.css_selector)
    if el != null and isUnique(fingerprint.css_selector):
      return el
  catch: pass

  // 2. XPath
  try:
    result = document.evaluate(fingerprint.xpath, document, ...)
    el = result.iterateNext()
    if el != null:
      return el
  catch: pass

  // 3. Text content match
  candidates = document.querySelectorAll(fingerprint.tag_name)
  for el in candidates:
    snippet = el.textContent.trim().slice(0, 50)
    if snippet == fingerprint.text_snippet and snippet.length > 0:
      return el

  // 4. All strategies failed — annotation is unresolved
  return null
```

`isUnique(selector)` → `document.querySelectorAll(selector).length === 1`

If a CSS selector matches but is not unique (matches multiple elements), the XPath fallback is tried next. This prevents selecting the wrong element on pages with non-unique generated selectors.

### 4.5 Failure Modes

| Failure | Cause | Handling |
|---|---|---|
| CSS selector invalid | Malformed or contains chars illegal in CSS selectors | Caught with try/catch; fall through to XPath |
| CSS selector not unique | Auto-generated classes with same structure on different elements | Fall through to XPath |
| XPath invalid | Very rare; generated paths should always be valid | Caught; fall through to text match |
| Text snippet is empty | Element had no text at capture time | Text match skipped; annotation is unresolved if CSS+XPath both fail |
| Element removed from DOM | Dynamic content not present on page load | All three strategies return null; annotation is silently skipped, counted in page-level alert |
| SPA with auto-generated IDs | IDs like `ember123` change between renders | CSS selector fails (ID not found); XPath + text match attempted; often resolves via text |

### 4.6 Unresolved Annotation Counting

After attempting resolution for all annotations targeting the current page URL, the content script computes:

- `total` = annotations in storage for this page
- `resolved` = those where `resolveElement()` returned non-null
- `unresolved` = `total - resolved`

These counts drive the toolbar alert logic (§6 toolbar lifecycle).

---

## 5. Pin Rendering

### 5.1 Pin DOM Structure

Each pin is a single `<div>` appended directly to `<body>`. Pins use **`position: fixed`** only for fixed-position target elements; all other pins use **`position: absolute`** relative to the document.

```html
<div class="annotator-pin" data-pin-id="1" style="position: absolute; left: 532px; top: 1204px; z-index: 2147483640;">
  <span>1</span>
</div>
```

**Why not Shadow DOM for pins?** Pins must be positioned with document-relative coordinates. Shadow DOM doesn't change positioning behaviour, only style encapsulation. The pin element itself is simple enough that style isolation via a unique class prefix (`annotator-pin`) is sufficient. Shadow DOM would add complexity without benefit here. (The toolbar does use Shadow DOM — see §5.5.)

### 5.2 Style Isolation

All pin styles are defined with high specificity using the `.annotator-pin` prefix and injected as a `<style>` element by the content script. The style block uses `!important` on critical layout properties (position, z-index, display) to prevent page styles from overriding pin visibility.

Pin appearance:
- Shape: circle, 24px diameter
- Background: magenta (`#E040FB`)
- Text: white, bold, 11px, centered
- Border: 2px white solid (visibility on dark backgrounds)
- Cursor: default (pointer)
- No pointer events when annotation mode is off (see §5.4)

### 5.3 Z-Index Strategy

| Layer | Z-index |
|---|---|
| Page content | 0 – 999,999 |
| Page modals/overlays | 1,000,000+ |
| Annotator pins | 2,147,483,640 |
| Annotator toolbar | 2,147,483,644 |
| Annotator popover | 2,147,483,646 |
| Annotator hover overlay | 2,147,483,647 (INT_MAX) |

This ensures annotator UI is always on top. Stacking context issues (elements with `transform`, `filter`, or `isolation: isolate`) can trap child elements below their stacking context ceiling — but since pins are children of `<body>`, this is avoided.

### 5.4 Position Calculation

**For normal (non-fixed) elements:**

```
pinLeft = element.getBoundingClientRect().left + window.scrollX + annotation.offset.x
pinTop  = element.getBoundingClientRect().top  + window.scrollY + annotation.offset.y
```

`window.scrollX/Y` converts viewport-relative rect to document-relative position. The pin uses `position: absolute` on `<body>`.

**For fixed-position elements:**

```
// Detect: window.getComputedStyle(el).position === 'fixed'
// OR: walk up ancestors and check
pinLeft = element.getBoundingClientRect().left + annotation.offset.x
pinTop  = element.getBoundingClientRect().top  + annotation.offset.y
// Pin uses position: fixed
```

Fixed elements don't scroll, so we use viewport coordinates directly. The pin is also set to `position: fixed`.

**Checking if element is fixed:**

```javascript
function isFixedPosition(el) {
  let node = el;
  while (node && node !== document.body) {
    if (window.getComputedStyle(node).position === 'fixed') return true;
    node = node.parentElement;
  }
  return false;
}
```

### 5.5 Toolbar Style Isolation

The toolbar (unlike pins) uses **Shadow DOM** to prevent page styles from leaking in. The toolbar is appended to `<body>` as a `<div id="annotator-host">` with `attachShadow({ mode: 'closed' })`. All toolbar CSS lives inside the shadow root. This is appropriate for the toolbar because it has complex internal structure (buttons, text, alerts) that would be vulnerable to CSS cascade pollution from the page.

**Critical implementation note:** `attachShadow({ mode: 'closed' })` returns the shadow root at creation time. After that, `host.shadowRoot` is `null` — the browser does not expose it externally. The returned reference **must** be stored in module scope:

```javascript
const toolbarHost = document.createElement('div');
toolbarHost.id = 'annotator-host';
const toolbarShadow = toolbarHost.attachShadow({ mode: 'closed' }); // STORE THIS
document.body.appendChild(toolbarHost);
// All subsequent toolbar DOM work uses toolbarShadow, not toolbarHost.shadowRoot
```

### 5.6 Scroll and Resize Behaviour

Pin positions are **recalculated on scroll and resize** by updating the `left` and `top` inline styles on each pin element. A single throttled event listener handles both:

```javascript
const repositionOnScroll = throttle(() => {
  for (const [pinId, { element, offset, isFixed }] of activePins) {
    if (isFixed) continue; // fixed-position pins don't move with scroll; skip to avoid wasteful recalculation
    updatePinPosition(pinId, element, offset, isFixed);
  }
}, 16); // ~60fps cap

const repositionAll = throttle(() => {
  for (const [pinId, { element, offset, isFixed }] of activePins) {
    updatePinPosition(pinId, element, offset, isFixed); // resize can move fixed elements too
  }
}, 16);

window.addEventListener('scroll', repositionOnScroll, { passive: true });
window.addEventListener('resize', repositionAll, { passive: true });
```

`activePins` is a `Map<pinId, { element: HTMLElement, offset: {x,y}, isFixed: bool }>` maintained by the content script.

### 5.7 Show/Hide on Annotation Mode Toggle

- **Annotation mode ON:** all pin elements have `display: block` and `pointer-events: auto`
- **Annotation mode OFF:** all pin elements have `display: none` and `pointer-events: none`

This is handled by toggling a CSS class on `<body>`:
```css
body:not(.annotator-active) .annotator-pin { display: none !important; pointer-events: none !important; }
```

---

## 6. Toolbar Injection & Lifecycle

### 6.1 Injection Flow

1. User clicks extension icon
2. Background service worker receives `chrome.action.onClicked`
3. Background sends `{ type: "PING" }` to the active tab's content script
4. **If ping times out (script not present):** Background calls `chrome.scripting.executeScript` to inject the content script. After injection completes, background sends `{ type: "ACTIVATE", tabId: tab.id }` so the content script knows its own tab ID (see §1.3). Content script calls `init(message.tabId)`.
5. **If ping responds** with `{ alive: true, tabId }`: Background sends `{ type: "ICON_CLICKED" }`. Content script ignores it (toolbar already active — no-op per requirements §6 #18).

The content script is **not** declared in `manifest.json` under `content_scripts`. It is injected on demand only. This prevents the extension from running on every page load when the user hasn't activated it.

### 6.2 Content Script `init(tabId)`

On first injection (called with the tab ID passed from background via `ACTIVATE` message):
1. Store `myTabId = tabId` in module scope
2. Build and inject toolbar into `<body>` via Shadow DOM host div
3. Register: `chrome.storage.local.set({ ['activeTab:' + myTabId]: true })`
3. Load annotations from storage for the current normalised domain
4. Determine current page URL (normalised)
5. Render pins for annotations matching current page URL
6. Set up `chrome.storage.onChanged` listener
7. Set up URL change detection (for SPA navigation)
8. Set up `window.addEventListener('beforeunload', cleanup)`

### 6.3 Full Page Reload Persistence

When the page reloads:
- The content script is torn down (the page unloads)
- `beforeunload` is fired → content script removes its per-tab key: `chrome.storage.local.remove('activeTab:' + myTabId)`

**Mechanism:** On full navigation, `chrome.tabs.onUpdated` fires in the background service worker. When `changeInfo.status === 'complete'` and `activeTab:{tabId}` exists in storage, the background auto-re-injects and sends `ACTIVATE`:

```javascript
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    chrome.storage.local.get('activeTab:' + tabId, (result) => {
      if (result['activeTab:' + tabId]) {
        // Re-inject content script, then send ACTIVATE with tabId
        chrome.scripting.executeScript(
          { target: { tabId }, files: ['content/index.js'] },
          () => chrome.tabs.sendMessage(tabId, { type: 'ACTIVATE', tabId })
        );
      }
    });
  }
});
```

**Edge case:** `beforeunload` is not guaranteed to fire (e.g. if Chrome crashes). If `activeTab:{tabId}` lingers after a crash and the tab re-opens with the same ID (rare but possible), the toolbar re-injects. This is acceptable — the user can ignore the toolbar.

**Cleanup on tab close:** `chrome.tabs.onRemoved` deletes the per-tab key:

```javascript
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove('activeTab:' + tabId);
});
```

**Startup cleanup:** On background service worker startup, remove stale `activeTab:*` keys for tabs that no longer exist (e.g., after a browser restart where Chrome re-uses tab IDs or doesn't):

```javascript
chrome.runtime.onStartup.addListener(() => {
  chrome.tabs.query({}, (liveTabs) => {
    const liveIds = new Set(liveTabs.map(t => t.id));
    chrome.storage.local.get(null, (all) => {
      const staleKeys = Object.keys(all)
        .filter(k => k.startsWith('activeTab:'))
        .filter(k => !liveIds.has(parseInt(k.split(':')[1])));
      if (staleKeys.length) chrome.storage.local.remove(staleKeys);
    });
  });
});
```

### 6.4 SPA Navigation Detection

SPAs change the URL without triggering a page reload. The content script detects this via two mechanisms:

**1. `popstate` event** — fired when the user clicks the back/forward buttons, or when the SPA calls `history.back()`:
```javascript
window.addEventListener('popstate', handleUrlChange);
```

**2. `hashchange` event** — fired when the URL's hash fragment changes (hash-based routing used by React Router v5 hash mode, Vue Router hash mode, etc.):
```javascript
window.addEventListener('hashchange', handleUrlChange);
```

**3. Monkey-patching `history.pushState` and `history.replaceState`** — fired when the SPA navigates programmatically:
```javascript
const origPush = history.pushState.bind(history);
history.pushState = function(...args) {
  origPush(...args);
  handleUrlChange();
};
// Same for replaceState
```

**`handleUrlChange()`:**
1. Compute new normalised URL
2. If URL changed from the last known URL:
   a. Clear rendered pins
   b. Load annotations for the new page from storage
   c. Render pins for the new page
   d. Update toolbar alert (resolution counts)
   e. Store new URL as last known
3. Annotation mode is set to **off** on URL change (user must re-enter for each page)

### 6.5 Toolbar State Machine

```
INACTIVE (no toolbar)
  └─ [icon click] → ACTIVE_IDLE

ACTIVE_IDLE (toolbar visible, annotation mode off)
  ├─ [Start Annotating] → ACTIVE_ANNOTATING
  ├─ [Upload] → [import pipeline]
  ├─ [Export] → [export pipeline]
  └─ [Delete All] → [confirmation → clear storage]

ACTIVE_ANNOTATING (annotation mode on)
  ├─ [Exit] → ACTIVE_IDLE
  ├─ [click element] → POPOVER_OPEN
  └─ [click existing pin] → POPOVER_OPEN (pre-filled)

POPOVER_OPEN
  ├─ [Add] → ACTIVE_ANNOTATING (pin created/updated)
  ├─ [Delete] → ACTIVE_ANNOTATING (pin deleted)
  └─ [✕ / click outside] → ACTIVE_ANNOTATING (no change)
```

### 6.6 Annotation Mode — Hover & Click Implementation

Annotation mode is controlled by a boolean `let annotationModeActive = false` in the content script. All annotation mode event listeners are registered once (at init) but short-circuit when `annotationModeActive` is false.

#### Click Interception

Native clicks are suppressed using a **capturing-phase listener** (third argument `true`). Capturing fires before the element's own handlers, enabling full suppression:

```javascript
document.addEventListener('click', (e) => {
  if (!annotationModeActive) return;
  if (isAnnotatorElement(e.target)) return; // let toolbar/popover handle their own clicks
  e.preventDefault();
  e.stopImmediatePropagation(); // stop all other handlers on this element too
  handleAnnotationClick(e);
}, true);
```

`isAnnotatorElement(el)` returns true if the element is inside the toolbar host, a pin, or the popover host:
```javascript
function isAnnotatorElement(el) {
  return (
    el.closest('#annotator-host') !== null ||
    el.closest('#annotator-popover-host') !== null ||
    el.classList?.contains('annotator-pin') ||
    el.closest('.annotator-pin') !== null
  );
}
```

**`handleAnnotationClick(e)`:**
1. If `e.target` is a pin element (or inside one): extract `pinId` from `data-pin-id`, open popover pre-filled with that annotation's note
2. Otherwise: capture fingerprint at `e.target`, compute offset `{ x: e.clientX - rect.left, y: e.clientY - rect.top }`, open blank popover for new annotation

#### Hover Highlight

Hover uses `mouseover`/`mouseout` (not `mouseenter`/`mouseleave`) because `mouseover` bubbles and fires when entering any child — which gives us the immediate target element:

```javascript
let highlightedEl = null;

document.addEventListener('mouseover', (e) => {
  if (!annotationModeActive || popoverOpen) return;
  if (isAnnotatorElement(e.target)) return;
  if (highlightedEl) highlightedEl.classList.remove('annotator-highlighted');
  highlightedEl = e.target;
  highlightedEl.classList.add('annotator-highlighted');
}, true);

document.addEventListener('mouseout', (e) => {
  if (!annotationModeActive) return;
  if (e.target === highlightedEl) {
    highlightedEl.classList.remove('annotator-highlighted');
    highlightedEl = null;
  }
}, true);
```

Highlight CSS (injected by content script into the page, not Shadow DOM — it needs to apply to page elements):
```css
.annotator-highlighted {
  outline: 2px solid #E040FB !important;
  outline-offset: 2px !important;
  cursor: crosshair !important;
  box-sizing: border-box !important;
}
```

**When annotation mode exits:** Remove `annotator-highlighted` from any currently highlighted element, set `annotationModeActive = false`, set `popoverOpen = false`.

---

### 6.7 Popover Implementation

#### DOM Structure

The popover is a separate Shadow DOM host appended to `<body>` (not inside the toolbar's shadow root, to avoid stacking context and positioning constraints):

```javascript
const popoverHost = document.createElement('div');
popoverHost.id = 'annotator-popover-host';
const popoverShadow = popoverHost.attachShadow({ mode: 'closed' }); // store this ref
document.body.appendChild(popoverHost);
```

Internal structure:
```html
<!-- inside popoverShadow -->
<div class="popover">
  <button class="close" aria-label="Close">&#x2715;</button>
  <textarea
    class="note-input"
    maxlength="400"
    placeholder="Add a note..."
  ></textarea>
  <div class="footer">
    <button class="delete">Delete</button>
    <span class="counter">0 / 400</span>
    <button class="add" disabled>Add</button>
  </div>
</div>
```

**Positioning:** The popover is `position: fixed` (so it doesn't scroll away) with `z-index: 2147483646`. Position is calculated from the pin's screen coordinates:

```javascript
function positionPopover(pinScreenX, pinScreenY) {
  const PIN_SIZE = 24;
  const MARGIN = 8;
  const pw = popover.offsetWidth || 280;  // measured or fallback
  const ph = popover.offsetHeight || 160;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const candidates = [
    { left: pinScreenX + PIN_SIZE + MARGIN,  top: pinScreenY },                          // bottom-right of pin
    { left: pinScreenX + PIN_SIZE + MARGIN,  top: pinScreenY - ph + PIN_SIZE },           // top-right
    { left: pinScreenX - pw - MARGIN,        top: pinScreenY - ph + PIN_SIZE },           // top-left
    { left: pinScreenX - pw - MARGIN,        top: pinScreenY },                           // bottom-left
  ];

  const pos = candidates.find(c =>
    c.left >= 0 && c.top >= 0 &&
    c.left + pw <= vw && c.top + ph <= vh
  ) || candidates[0]; // fallback to first if all overflow

  Object.assign(popoverHost.style, { left: pos.left + 'px', top: pos.top + 'px', position: 'fixed' });
}
```

#### Character Counter

```javascript
noteInput.addEventListener('input', () => {
  counter.textContent = `${noteInput.value.length} / 400`;
  addBtn.disabled = noteInput.value.trim().length === 0;
});
```

#### Click-Outside Detection

The popover's click-outside detection must coexist with annotation mode's click interception. Since annotation mode already stops propagation on all page clicks (capturing phase), the click-outside handler must also use the capturing phase and run before annotation mode's handler:

```javascript
document.addEventListener('click', (e) => {
  if (!popoverOpen) return;
  if (e.composedPath().includes(popoverHost)) return; // click inside popover
  closePopover(/* save= */ false);
  // Don't call e.stopPropagation() here — let annotation mode's handler also run
}, true);
```

`e.composedPath()` correctly traverses through Shadow DOM boundaries, so clicks inside the shadow root are detected.

**Listener ordering:** Register the click-outside listener before the annotation mode click listener (registration order determines capture-phase order). Or use a single unified handler that checks popover state first.

#### Delete Confirmation

The delete button shows an inline confirmation inside the popover (not a browser `confirm()` dialog — those are blocked in some contexts and look native/jarring):

1. First click on Delete: popover body text changes to "Delete this annotation? This cannot be undone." with **Confirm** and **Cancel** buttons
2. Confirm: delete annotation from storage, close popover
3. Cancel: restore normal popover view

#### Focus Management

```javascript
function openPopover(annotation) {
  // ... set content ...
  popoverHost.style.display = 'block';
  popoverOpen = true;
  // Focus textarea after display (use requestAnimationFrame to ensure layout is complete)
  requestAnimationFrame(() => noteInput.focus());
}
```

---

## 7. Cross-Tab Sync

### 7.1 `chrome.storage.onChanged` Listener

Every active content script instance registers a storage change listener on init:

```javascript
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  const domainKey = `annotations:${currentDomain}`;
  if (!changes[domainKey]) return;

  const newData = changes[domainKey].newValue;
  if (!newData) return; // domain data was deleted

  refreshPinsFromStorage(newData);
  updateToolbarState(newData);
});
```

### 7.2 `refreshPinsFromStorage(newData)`

1. Get annotations for `currentPageUrl` from `newData.pages`
2. Diff against currently rendered pins:
   - Pins in new data but not rendered → resolve element + render
   - Pins rendered but not in new data → remove from DOM
   - Pins in both → update note (no re-render needed unless offset changed)
3. Update toolbar button states (Export enabled/disabled, etc.)
4. Recalculate and display page-level alert

### 7.3 Concurrency Model

Last-write-wins. Two tabs writing simultaneously may overwrite each other's changes. This is explicitly accepted in requirements (§2 Multi-Tab Behavior). No optimistic locking, no CRDTs, no merge strategy.

### 7.4 Own-Write Handling

When the current tab writes to storage, `onChanged` fires in the **same tab too**. The `suppressNextChange` boolean + `setTimeout` approach that was considered here is fragile: two rapid writes within the timeout window cause the flag to clear too early, and the timeout window is arbitrary.

**Decision: don't suppress own-write events.** Instead, make `refreshPinsFromStorage` idempotent so that re-processing the same state is a no-op:

- Pins already rendered with the correct position/note are not re-created (diff logic in §7.2: "Pins in both → update note only if changed")
- Toolbar button states are set to the same values they already have
- There is no visible flicker or user-facing side effect from processing an own-write

This is the simpler and more correct approach. No suppression mechanism needed.

---

## 8. Import Pipeline

### 8.1 Step-by-Step

```
File selected via <input type="file">
  │
  ├─ [size check] > 8MB → Error #13: "File too large"
  │
  ├─ [extension check] not .yaml/.yml → Error #1: "Invalid file type"
  │
  ├─ [read file as UTF-8 text]
  │
  ├─ [empty check] length == 0 → Error #2: "File is empty"
  │
  ├─ [YAML parse] fails → Error #3: "Corrupted or malformed"
  │
  ├─ [schema validation]
  │   ├─ missing required keys → Error #4: "Doesn't look like Annotator file"
  │   ├─ empty annotations array → Error #10: "No annotations"
  │   └─ duplicate pin_numbers → Error #14: "Duplicate pin numbers"
  │
  ├─ [version check] file.version > CURRENT_VERSION → Warning #6 (continue)
  │
  ├─ [domain check] file.domain != currentDomain → Error #5: "Wrong domain"
  │
  ├─ [existing data check]
  │   ├─ has annotations AND no unsaved changes → Confirmation #11
  │   └─ has annotations AND has unsaved changes → Confirmation #12
  │   (user cancels → abort; user confirms → continue)
  │
  ├─ [store annotations]
  │   ├─ Transform YAML objects to internal Annotation format
  │   ├─ Build storage object keyed by page URL
  │   ├─ Set meta.nextPinNumber = max(pin_numbers) + 1
  │   ├─ Set meta.importedFilename = file.name
  │   └─ Write to chrome.storage.local
  │
  ├─ [render current page]
  │   ├─ Get annotations for currentPageUrl
  │   ├─ Attempt resolution for each (§4.4)
  │   └─ Render resolved pins
  │
  ├─ [display toolbar state]
  │   ├─ Show filename above buttons
  │   └─ Show page-level alert if unresolved pins exist
  │
  ├─ [activate annotation mode] (auto-enter per §1.4)
  │
  └─ [reset file input] input.value = '' — allows re-selection of same file on error or retry
```

### 8.2 File Reading

```javascript
async function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result); // UTF-8 string
    reader.onerror = () => reject(new Error('File read failed'));
    reader.readAsText(file, 'UTF-8');
  });
}
```

### 8.3 YAML Parsing

Use the `js-yaml` library (bundled into the content script). Parse with `yaml.load(text, { schema: yaml.JSON_SCHEMA })`. The `JSON_SCHEMA` option restricts the parser to safe JSON-compatible types — no `!!js/function` or other unsafe tags.

```javascript
import * as yaml from 'js-yaml';

function parseYAML(text) {
  try {
    return yaml.load(text, { schema: yaml.JSON_SCHEMA });
  } catch (e) {
    throw new ImportError('MALFORMED');
  }
}
```

### 8.4 Schema Validation

```javascript
function validateSchema(doc) {
  if (!doc || typeof doc !== 'object') throw new ImportError('WRONG_SCHEMA');
  if (!('version' in doc) || !('domain' in doc) || !Array.isArray(doc.annotations))
    throw new ImportError('WRONG_SCHEMA');
  if (doc.annotations.length === 0)
    throw new ImportError('EMPTY_ANNOTATIONS');

  const pinNumbers = new Set();
  for (const ann of doc.annotations) {
    // Type-check required fields (presence + type)
    if (!Number.isInteger(ann.pin_number) || ann.pin_number < 1)
      throw new ImportError('WRONG_SCHEMA');  // pin_number must be a positive integer
    if (typeof ann.page_url !== 'string' || !ann.page_url)
      throw new ImportError('WRONG_SCHEMA');
    if (typeof ann.note !== 'string')          // allow empty string — don't use !ann.note
      throw new ImportError('WRONG_SCHEMA');
    if (!ann.fingerprint || typeof ann.fingerprint !== 'object')
      throw new ImportError('WRONG_SCHEMA');
    if (typeof ann.fingerprint.css_selector !== 'string' ||
        typeof ann.fingerprint.xpath !== 'string' ||
        typeof ann.fingerprint.text_snippet !== 'string' ||
        typeof ann.fingerprint.tag_name !== 'string')
      throw new ImportError('WRONG_SCHEMA');  // validate all fingerprint sub-fields
    if (!ann.offset || typeof ann.offset.x !== 'number' || typeof ann.offset.y !== 'number')
      throw new ImportError('WRONG_SCHEMA');  // offset x/y must be numbers

    if (pinNumbers.has(ann.pin_number))
      throw new ImportError('DUPLICATE_PINS');
    pinNumbers.add(ann.pin_number);
  }
}
```

### 8.5 Domain Check

```javascript
const fileDomain = normaliseDomain(doc.domain);
const currentDomain = normaliseDomain(location.hostname);
if (fileDomain !== currentDomain)
  throw new ImportError('WRONG_DOMAIN', { fileDomain, currentDomain });
```

### 8.6 Error Display

All `ImportError` types map to a display string and style:

```javascript
const ERROR_MESSAGES = {
  FILE_TOO_LARGE:      { msg: 'This file is too large to import (max 8MB).', style: 'error' },
  WRONG_TYPE:          { msg: 'Invalid file type. Please upload a .yaml annotation file.', style: 'error' },
  EMPTY_FILE:          { msg: 'This file is empty. Nothing to import.', style: 'error' },
  MALFORMED:           { msg: 'Could not read this file — it appears to be corrupted or incorrectly formatted.', style: 'error' },
  WRONG_SCHEMA:        { msg: "This file doesn't look like an Annotator file. Please check you're uploading the right file.", style: 'error' },
  EMPTY_ANNOTATIONS:   { msg: 'This file exists but contains no annotations.', style: 'error' },
  DUPLICATE_PINS:      { msg: 'This file appears to be corrupted (duplicate pin numbers detected).', style: 'error' },
  WRONG_DOMAIN:        { msg: (d) => `This file contains annotations for \`${d.fileDomain}\`, but you're currently on \`${d.currentDomain}\`.`, style: 'error' },
  VERSION_MISMATCH:    { msg: 'This file was created with a newer version of Annotator. Some annotations may not display correctly.', style: 'warning' },
};
```

Errors are displayed in the toolbar's notification area (above the buttons), styled red for errors and yellow for warnings. The notification auto-clears after 8 seconds or on the next user action.

**Timer management:** Use a single `let notifTimer = null` in the notification module. Clear any existing timer before setting a new one to prevent an old timer from clearing a newer message:

```javascript
let notifTimer = null;
function showNotification(msg, style) {
  clearTimeout(notifTimer);           // cancel previous auto-clear
  setNotificationContent(msg, style);
  notifTimer = setTimeout(() => clearNotification(), 8000);
}
```

---

## 9. Export Pipeline

### 9.1 Step-by-Step

```
User clicks Export
  │
  ├─ Read all annotation data for currentDomain from chrome.storage.local
  │
  ├─ Flatten into sorted annotation array (sorted by pin_number ascending)
  │
  ├─ Build YAML document object:
  │   {
  │     version: CURRENT_EXPORT_VERSION,
  │     exported_at: new Date().toISOString(),
  │     domain: currentDomain,
  │     annotations: [...]
  │   }
  │
  ├─ Serialise to YAML string using js-yaml
  │
  ├─ Create Blob (UTF-8, type: 'application/x-yaml')
  │
  ├─ Create object URL and trigger download via <a download="...">
  │
  └─ Revoke object URL after click
```

### 9.2 Filename Generation

```javascript
function exportFilename(domain) {
  // "figma.com" → "annotations-figma_com.yaml"
  return `annotations-${domain.replace(/\./g, '_')}.yaml`;
}
```

### 9.3 YAML Serialisation

```javascript
import * as yaml from 'js-yaml';

function serialiseToYAML(doc) {
  return yaml.dump(doc, {
    sortKeys: false,       // preserve field order for readability
    lineWidth: 120,        // wrap long lines
    noRefs: true,          // no YAML anchors/aliases
    schema: yaml.JSON_SCHEMA,
  });
}
```

**Field order:** With `sortKeys: false`, output field order matches JS object property insertion order. Build the doc object and each annotation object in the exact order shown in §3.1 to ensure output matches the documented schema example:

```javascript
const ann = {
  pin_number: a.pinNumber,
  page_url: a.pageUrl,
  note: a.note,
  fingerprint: {
    css_selector: a.fingerprint.cssSelector,
    xpath: a.fingerprint.xpath,
    text_snippet: a.fingerprint.textSnippet,
    tag_name: a.fingerprint.tagName,
    // boundingBox intentionally excluded from export
  },
  offset: { x: a.offset.x, y: a.offset.y },
  created_at: a.createdAt,
};
```

### 9.4 Download Trigger

```javascript
function triggerDownload(content, filename) {
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

No `chrome.downloads` API needed — the simple anchor click approach works within the content script context and requires no additional permissions.

### 9.5 Export Includes All Pages

The export collects annotations from **all page URL keys** under the current domain's storage object, not just the current page. This ensures round-trip fidelity — annotations for pages the user has not visited since importing are preserved.

---

## 10. Security

### 10.1 No Network Calls

The extension makes **zero network requests**. This is enforced at two levels:

**Manifest CSP:**
```json
{
  "content_security_policy": {
    "extension_pages": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'"
  }
}
```

`connect-src 'none'` blocks all `fetch`, `XMLHttpRequest`, and WebSocket calls from extension pages.

Content scripts run in the page's CSP context, not the extension's. However, the content script code never calls `fetch`, `XMLHttpRequest`, `WebSocket`, or any network API. The bundled `js-yaml` library is a pure parser with no network activity.

**No `host_permissions` beyond what's needed** — see §10.3.

### 10.2 No Remote Scripts

- All JavaScript is bundled at build time into the extension package
- No CDN links, no `eval`, no `new Function()`, no dynamic `<script>` injection
- `js-yaml` is vendored (bundled), not loaded from a CDN
- The extension has no update server for code (only Chrome Web Store updates, which are integrity-verified by Chrome)

### 10.3 Minimal Permissions

```json
{
  "permissions": [
    "storage",       // chrome.storage.local for annotation persistence
    "scripting",     // chrome.scripting.executeScript for on-demand injection
    "tabs"           // chrome.tabs.onUpdated / onRemoved for reload persistence
  ],
  "host_permissions": [
    "<all_urls>"     // required to inject content scripts on any website
  ]
}
```

**Justification:**
- `storage`: annotation persistence
- `scripting`: on-demand content script injection (not declared in `content_scripts` to avoid running on every page load)
- `tabs`: tab lifecycle management for reload re-injection
- `<all_urls>`: the extension's core value is working on any website; there is no way to achieve this with narrower permissions

**Not requested:**
- `downloads` — not needed; anchor-click download works without it
- `notifications` — not used
- `identity` — not used
- `webRequest` — not used

### 10.4 Data Locality

- All data stored in `chrome.storage.local` — local to device, not synced
- Export files are downloaded to the user's device; no upload occurs
- Import reads a local file chosen by the user; no data is sent anywhere
- The extension has no analytics, telemetry, crash reporting, or update pings

### 10.5 Open Source Auditability

- No code obfuscation. Source maps are included in the build.
- All dependencies are vendored and pinned to specific versions
- Build is reproducible from source: `npm run build` produces the exact same output
- The manifest explicitly lists all permissions with justifications in `PERMISSIONS.md`

---

## 11. Trade-offs & Alternatives Considered

### 11.1 Shadow DOM for Pins vs. Pins as Plain DOM Elements

**Decision:** Plain DOM elements for pins, Shadow DOM for the toolbar.

**Considered:** Using Shadow DOM for every pin element.

**Rejected because:** Shadow DOM adds meaningful complexity (especially for `closed` mode) and provides no benefit for pins. Pins have trivial CSS needs (a circle with a number). Style encapsulation via a unique class prefix is sufficient. The main risk — page styles overriding pin visibility — is handled with `!important` on position, display, and z-index.

**Shadow DOM kept for toolbar:** The toolbar has complex internal structure and is vulnerable to page CSS cascade (e.g. a page that sets `* { display: flex }` would break toolbar layout). Shadow DOM provides genuine isolation here.

---

### 11.2 `chrome.storage.local` vs. IndexedDB

**Decision:** `chrome.storage.local`.

**Considered:** IndexedDB, which offers larger quotas (no fixed limit), richer querying, and transactional writes.

**Rejected because:** IndexedDB is significantly more complex to use (async transaction model, cursor-based reads, explicit versioning). For v1, the data model is simple enough that a single JSON blob per domain fits in `storage.local`. The 10MB limit is more than the 8MB requirement. If v2 needs to handle thousands of annotations or multiple user profiles, IndexedDB is the right migration path — but that's a future problem.

---

### 11.3 On-Demand Script Injection vs. `content_scripts` in Manifest

**Decision:** On-demand injection via `chrome.scripting.executeScript`.

**Considered:** Declaring the content script in `manifest.json` so it auto-injects on every page.

**Rejected because:** This would run the extension's JavaScript on every single page the user visits, even when they never use it. This wastes CPU and memory, and creates unnecessary attack surface. The requirements explicitly state the toolbar should only appear when the user clicks the extension icon. On-demand injection satisfies this precisely.

**Trade-off accepted:** Re-injection on page reload requires background service worker to track active tabs via `activeTabIds`. This is slightly more complex but the right design.

---

### 11.4 `activeTab` Permission vs. `<all_urls>` Host Permission

**Decision:** `<all_urls>` host permission.

**Considered:** Using `activeTab` permission, which only grants access to the current tab when the user clicks the extension icon.

**Rejected because:** `activeTab` doesn't persist across page navigations. The content script needs to survive page reloads (auto-reinject) and the background worker needs to programmatically inject into tabs. `activeTab` is a one-shot permission scoped to a single user gesture — it can't support the reload-persistence requirement. `<all_urls>` is the only practical choice for a persistent, domain-wide annotation tool.

---

### 11.5 MutationObserver for Dynamic Content vs. Static Resolution

**Decision:** Static resolution at render time. No MutationObserver in v1.

**Considered:** Using `MutationObserver` to watch for elements being added to the DOM and retroactively place pins when their target elements appear.

**Rejected because:** This is significantly more complex to implement correctly (false positive mutations, infinite loops, performance impact on heavy SPAs) and the v1 requirements explicitly defer this to v2. The existing text-match fallback and page-level alert system adequately communicates to the user when resolution fails. MutationObserver would be the right v2 improvement for React/SPA pages where target elements are conditionally rendered.

---

### 11.6 Global Pin Numbering vs. Per-Page Numbering

**Decision:** Global, continuous numbering across the domain.

**Considered:** Resetting pin numbers to 1 on each page.

**Kept as designed:** The requirements explicitly call for global numbering as a cross-page reference system ("see pin 12"). This is a product decision; the implementation is straightforward (a single `nextPinNumber` counter in `meta`).

---

### 11.7 YAML vs. JSON for Export Format

**Decision:** YAML.

**Considered:** JSON (simpler to implement, no dependency needed), CSV (simpler but loses structure).

**YAML chosen because:** The requirements explicitly specify YAML. It is significantly more human-readable than JSON (especially for multi-line text fields and nested structures), which is a stated goal. The `js-yaml` library adds ~40KB to the bundle, which is acceptable. JSON would have been the simpler technical choice.

---

### 11.8 Bundler Choice

**Decision:** esbuild.

**Considered:** webpack, Rollup, Parcel.

**esbuild chosen because:** Fast build times (millisecond rebuilds during development), minimal configuration, good tree-shaking. For a single content script entry point with a handful of modules and one external dependency (`js-yaml`), esbuild is the obvious choice. webpack's configuration overhead is not justified here.

---

### 11.9 Popover Position Calculation

**Decision:** CSS-based overflow detection with four candidate positions.

The popover attempts placement in priority order: bottom-right → top-right → top-left → bottom-left. Each candidate is tested against `window.innerWidth` / `window.innerHeight` before committing.

**Not considered:** Floating UI / Popper.js. These are excellent libraries, but adding a dependency for a four-position fallback is over-engineering. The calculation is ~30 lines of plain JS.

---

### 11.10 Pin Anchor: Click Point vs. Element Corner

**Decision:** Store and render at the exact click point (as an offset from element top-left).

**Considered:** Always anchoring the pin to the element's top-left corner (offset = 0,0).

**Rejected because:** The requirements explicitly call for the pin to appear at the exact point the user clicked. This is better UX — users click the interesting part of the element (e.g. a specific word), not the element's corner. The offset-from-top-left approach handles element repositioning correctly while preserving the intended pin location.

---

*End of Technical Design Document*
