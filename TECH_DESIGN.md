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
- Header: logo + wordmark, theme toggle, close. A separate action row below it holds two
  icon-only groups: **add note** with an attached "keep add mode on" switch (design spec v3 §A2),
  and **export** with an attached chevron whose menu holds **import** (§C2)
- While add mode is active the sidebar goes "on hold" (§H): the note list dims, stops taking
  pointer/keyboard input and loses its dock magnification; the export group is disabled
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

## Thumbnails & Enlarged View

**Thumbnail list** (`src/thumbnails.ts`, magnification in `src/dockMotion.ts`)
- Renders from `FeedbackItem[]` returned by `GET_PAGE_ITEMS` message
- Shows inline thumbnail image + note (3-line clamp) + item number badge
- Newest at bottom (capture order); macOS-Dock-style spring magnification on hover/focus

**Enlarged view** (`src/enlargedView.ts`, FLIP helpers in `src/flip.ts`) — replaces v1's modal
- Click thumbnail → the sidebar itself expands to ~75% of the viewport inside the sidebar's shadow root (page not re-laid out; scrim over the remaining strip)
- Shared-element FLIP morphs (panel, clicked thumbnail → main slot, neighbours → peek slots); prev/next/delete run as an interruptible morphing carousel; reduced motion = instant layout + crossfades. Spec: `design/MOTION_SPEC.md`
- Shows the full-resolution image (fetched via `GET_IMAGE` on open, stale-fetch guarded)
- Note autosaves (debounced, flushed on navigate/collapse/unload); empty notes are never saved and block leaving the note
- Immediate delete (no confirmation); deletes both record and blob via background message

## File Inventory

| File | Lines | Role |
|---|---|---|
| `src/background.ts` | 868 | Service worker: injection, capture relay, storage ownership |
| `src/sidebar.ts` | ~2770 | Right-docked sidebar shell, page resize, add-note toggle + "keep on" switch, export/chevron menu, hosts the enlarged view |
| `src/content.ts` | ~700 | Content script entry: injection guard, message listener, SPA nav detection |
| `src/addMode.ts` | ~960 | Selection box, dimming scrim, comment box, add mode lifecycle |
| `src/capture.ts` | 318 | Capture pipeline: hide UI, capture, crop, restore, exit |
| `src/contextCapture.ts` | 426 | DOM context extraction: DCA, contained elements, area text, size governance |
| `src/import.ts` | 172 | Import validation ladder (13 cases), file picker, confirmation dialog |
| `src/export.ts` | 111 | Export coordinator (assembly happens in bundle.ts + background) |
| `src/bundle.ts` | 341 | Markdown serialization + YAML schema definition (shared by export/import) |
| `src/imageStore.ts` | 98 | IndexedDB wrapper: CRUD for PNG blobs, cropping to thumbnail |
| `src/enlargedView.ts` | ~1800 | Enlarged view: expanding sidebar note viewer/editor, autosave, carousel |
| `src/flip.ts` | ~360 | FLIP / shared-element animation helpers |
| `src/dockMotion.ts` | ~640 | Dock-style spring magnification for the note list |
| `src/theme.ts` | ~650 | Design tokens, light/dark/auto theme, bundled font loading |
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
