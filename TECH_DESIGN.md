# Technical Design — Screenshot-Based Feedback Extension

## Overview

The annotator is a Chrome extension that captures visual feedback from webpages. Users select an area on a page, screenshot it, attach a note, and export as a `.zip` bundle containing the screenshots and a `feedback.md` file (plus embedded context for AI agents or developers to locate the annotated code).

**Core constraint:** all data stays on-device; no network requests. Feedback is stored locally in `chrome.storage.local` (metadata) and IndexedDB (image blobs).

---

## Architecture

### Entry Points & Lifecycle

**Background service worker** (`src/background.ts`)
- Handles extension icon clicks: ping content script to check if already injected; inject if not
- Manages tab lifecycle: re-inject on `tabs.onUpdated` if sidebar was open (via `chrome.storage.session` per-tab state)
- Owns the screenshot capture relay: receives `CAPTURE` messages from content script, calls `chrome.tabs.captureVisibleTab`, crops via `OffscreenCanvas` + `createImageBitmap`, persists full PNG + thumbnail to IndexedDB
- Throttles captures (~2/sec rate limit), routes all storage reads/writes (metadata and blobs live in extension origin, not the page's origin)
- Implements all message handlers for storage, export, and import

**Content script** (`src/content.ts`)
- Injected per-tab on demand; stays idempotent (double-injection guard)
- Listens to `chrome.runtime` messages from background
- Detects SPA navigation (patches `history.pushState/replaceState`, listens to `popstate`)
- When sidebar needs to open (icon click or reload after prior session), wires up the shadow-root sidebar and overlay UI

**Message contract** (`src/messages.ts`)
- Typed union of all messages crossing the content-script ↔ background boundary
- JSON-serialised: images cross as data-URL strings, not Blob/ArrayBuffer

---

## Sidebar & Add Mode

**Sidebar shell** (`src/sidebar.ts`)
- Right-docked panel that **resizes the page** (shrinks `<html>` width), not an overlay
- Header: 4 buttons (add, export, import, close), all icon-only
- Body: scrollable thumbnail list for current URL only (§1.5 of REQUIREMENTS)
- Closed shadow root (prevents page CSS bleed)
- Persists across SPA navigation and full reloads via `chrome.storage.session` per-tab

**Add mode** (`src/addMode.ts`)
- Entered by clicking add button
- Crosshair cursor, click-to-place default 200×150px box (clamped to viewport)
- 8 resize handles (minimum 20×20px), 4-way dimming scrim (macOS style)
- Comment box (textarea, 1000-char counter, cancel/ok buttons) with auto-flip positioning (below → above → side)
- Suppresses all page interaction while active

**Capture pipeline** (`src/capture.ts`)
- Hide overlay UI → requestAnimationFrame (double-rAF, not timeout) → message background → restore UI → exit add mode
- Coordinate contract: selection rect is in **viewport-relative CSS pixels** (same frame as `MouseEvent.clientX/clientY`)
- Service worker crops to device pixels using empirical scale (`imageWidth / cssWidth`) — self-corrects against integer rounding and browser zoom
- Captures are kept at native device pixel ratio (no downscaling); failures create no partial item

---

## Storage Architecture

**Three-tier persistence** (cross-cutting gotcha #1):

1. **`chrome.storage.local`** (metadata) — domain-keyed `DomainData` records:
   ```
   { domain: { meta: { nextItemNumber, version }, pages: { normalisedUrl: FeedbackItem[] } } }
   ```
   Includes inline thumbnail data-URLs so sidebar list renders without IndexedDB round trips (Phase 1 design call)

2. **IndexedDB** (blobs, extension origin) — full-resolution PNGs indexed by `screenshotKey`, owned exclusively by service worker
   - Content script can't see IndexedDB; all access goes through background messages
   - Each stored item includes `screenshotKey` (key into IDB) and `thumbnailDataUrl` (inline preview)

3. **`chrome.storage.session`** (ephemeral) — per-tab sidebar open/closed state
   - Survives page reloads within a session
   - Clears on browser restart
   - Enables sidebar persistence across F5 without explicit user action

**Context capture** (`src/contextCapture.ts`)
- Called at capture time; runs in content script (pure DOM walk, no IDB/storage access)
- Deepest-common-ancestor (DCA) of selection rect → primary target (CSS selector + XPath + ≤1KB outerHTML snippet)
- Descendant walk: ≤15 prioritised elements (attribute-rich or text-bearing first)
- Flat area text (all visible text in selection rect, concatenated)
- Page metadata: full URL, normalized URL, viewport, DPR, selection rect, timestamp
- **Size governed:** 2KB per item; truncates outerHTML first, then contained-elements list, always with visible markers
- CSS selector reuses v1's selector-building logic (lifted verbatim from Phase 6)

---

## Thumbnails & Modal

**Thumbnail list** (`src/thumbnails.ts`)
- Renders from `FeedbackItem[]` returned by `GET_PAGE_ITEMS` message
- Shows inline thumbnail image + truncated note + item number badge
- Newest at bottom (capture order)

**Enlarged modal** (`src/modal.ts`)
- Click thumbnail → translucent backdrop modal
- Shows full-resolution image (fetched via `GET_IMAGE` message on open)
- Editable note textarea with autosave on blur/close
- Immediate delete (no confirmation); deletes both record and blob via background message

---

## Export & Import

**Export** (`src/export.ts`)
- Service worker assembles `.zip` containing `screenshots/{id}.png` and single `feedback.md`
- Filename: `feedback-{domain_with_underscores}-{YYYY-MM-DD}.zip`
- `feedback.md` structure:
  - One `##` section per URL (ordered by first-capture)
  - Items chronological within section
  - Each item: number + `![](screenshots/{id}.png)` + note + fenced ` ```yaml ` context block
- Zip assembly happens in SW (blobs already there); downloads via `chrome.downloads` + data: URL
- Empty domain → `alert("nothing to export")`

**Import** (`src/import.ts`)
- File picker (`.zip` only)
- Content script validates full §5 error ladder (13 cases): not-a-zip, corrupt archive, missing `feedback.md`, malformed fence, missing screenshot, duplicate IDs, domain mismatch, version mismatch, existing-data confirmation
- If all valid: message background with validated items
- Background replaces domain data entirely (no merge); stores blobs via imageStore
- Sidebar auto-opens showing current-URL items from imported bundle

**Bundle format** (`src/bundle.ts`)
- Shared serialization/deserialization (used by both export and import)
- Markdown prose + fenced YAML blocks (one per item)
- YAML schema: mirrors `FeedbackItem` fields (snake_case names) minus the two storage handles (`screenshotKey`, `thumbnailDataUrl`)
- Round-trip tested: export → parse → deep-equal

---

## URL Normalization

**Normalization** (`src/urlNorm.ts`, §6 #11 of REQUIREMENTS)
- Strip query params and fragments
- Strip `www.` prefix
- Strip trailing slash
- Case-sensitive paths (preserve case)
- Strip default ports (80 for HTTP, 443 for HTTPS), preserve non-standard ports
- All feedback for one domain but different normalized URLs is stored separately in `DomainData.pages`

---

## Security & Privacy

- **No network calls.** CSP enforces `connect-src 'none'`; `fflate` (or alternative) bundled for decompression
- **No external dependencies loaded at runtime.** esbuild bundles everything (script-src 'self')
- **No visual masking of form fields.** Out of scope (v1 limitation); users can be warned at capture time
- **Cross-origin iframes:** screenshot pixels still captured correctly (visible-tab capture doesn't care about origin), but DOM context limited to iframe element's own tag/attrs/`src` (same-origin restriction on DOM walk)

---

## Error Handling

All user-facing errors are lowercase (REQUIREMENTS §3.4) and verbatim from REQUIREMENTS §5:

| # | Case | Behavior |
|---|------|----------|
| 1 | Wrong file type on import (not `.zip`) | "invalid file type. please upload a .zip feedback bundle." |
| 2 | Corrupted zip | "could not read this file — it appears to be corrupted." |
| 3 | Missing `feedback.md` | "this doesn't look like a feedback bundle." |
| 4 | Missing screenshot file | "this file is missing screenshot data and can't be imported." |
| 4b | Malformed metadata fence | "this bundle appears to be corrupted (couldn't read feedback data)." |
| 5 | Domain mismatch | "this bundle contains feedback for '{other-domain}', but you're currently on '{current-domain}'." |
| 6 | Newer schema version | "this bundle was created with a newer version of the extension. some feedback may not display correctly." (warning, import proceeds) |
| 7 | Export zero items | `alert("nothing to export")` |
| 8 | Capture fails (rate limit, restricted page) | "couldn't capture a screenshot here. try again." |
| 9 | Sidebar on restricted page | Extension icon disabled; explanatory message on interaction |
| 10 | Import with existing data | Confirmation dialog before replace |
| 11 | Duplicate IDs in bundle | "this bundle appears to be corrupted (duplicate item ids)." |

---

## Testing

**Unit tests** (`src/__tests__/*.test.ts`)
- jsdom (no browser launch) for DOM-related code
- Mocked `chrome.storage` and `fake-indexeddb` for storage tests
- Coverage: capture coordinate math, context capture size governance, selector stability, bundle round-trip, message handlers, storage CRUD

**E2E tests** (Phase 10, separate agent)
- Playwright suite: sidebar, capture, thumbnails, export/import, persistence
- Real browser; manual verification on real sites before shipping

---

## File Inventory

| File | Lines | Role |
|---|---|---|
| `src/background.ts` | 868 | Service worker: injection, capture relay, storage ownership |
| `src/sidebar.ts` | 875 | Right-docked sidebar shell, page resize, modal wiring |
| `src/content.ts` | 502 | Content script entry: injection guard, message listener, SPA nav detection |
| `src/addMode.ts` | 645 | Selection box, dimming scrim, comment box, add mode lifecycle |
| `src/capture.ts` | 318 | Capture pipeline: hide UI, capture, crop, restore, exit |
| `src/contextCapture.ts` | 426 | DOM context extraction: DCA, contained elements, area text, size governance |
| `src/import.ts` | 172 | Import validation ladder (13 cases), file picker, confirmation dialog |
| `src/export.ts` | 111 | Export coordinator (assembly happens in bundle.ts + background) |
| `src/bundle.ts` | 341 | Markdown serialization + YAML schema definition (shared by export/import) |
| `src/imageStore.ts` | 98 | IndexedDB wrapper: CRUD for PNG blobs, cropping to thumbnail |
| `src/modal.ts` | 390 | Enlarged modal: full image, editable note, delete button |
| `src/thumbnails.ts` | 97 | Thumbnail list rendering |
| `src/storage.ts` | 261 | `chrome.storage.local` wrappers: domain CRUD, item CRUD, session state |
| `src/messages.ts` | 416 | Typed message union (documentation + types) |
| `src/types.ts` | 237 | Data model: FeedbackItem, CapturedContext, YAML mirror types |
| `src/selectorBuilder.ts` | 342 | CSS selector + XPath generation (lifted from Phase 6) |
| `src/urlNorm.ts` | 125 | URL normalization (v1's rules, unchanged) |
| `src/wordlist.ts` | 1507 | Dictionary for classifier (semantic vs. generated class names) |

---

## Key Decisions & Rationale

**Why screenshots instead of pins?** Live re-resolution of pin positions proved fragile as pages change. Screenshots plus context capture provide a stable artifact.

**Why sidebar instead of overlay?** Overlay blocks page content; sidebar resizes the page so everything remains accessible. Sidebar persistence (§1.1) makes the interaction more natural across navigations.

**Why IndexedDB for blobs?** `chrome.storage.local` has a quota (even with `unlimitedStorage`, it handles ~1000s of small records better than large binary data). IndexedDB is designed for flexible blob handling.

**Why device pixel ratio?** Developers need pixel-perfect screenshots for their high-DPI targets. Downscaling loses information.

**Why 2KB context cap?** Balances detail (selectors, contained elements, area text are meaningful) against file size and rendering speed in markdown viewers. 1KB outerHTML and 15 elements fit naturally within this budget.

**Why replace-only import?** Simplifies implementation (no merge logic, no ID collision handling); users can export before importing if they want to preserve old feedback.
