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
- Header: logo + wordmark, close. A separate action row below it holds two
  icon-only groups: **add note** with an attached "keep add mode on" switch (design spec v3 §A2),
  and **export** with an attached chevron whose menu holds **import** (§C2)
- While add mode is active the sidebar goes "on hold" (§H): the note list dims, stops taking
  pointer/keyboard input and loses its dock magnification; the export group is disabled
- Body: scrollable thumbnail list for current URL only (§1.5 of REQUIREMENTS)
- Closed shadow root (prevents page CSS bleed)
- Persists across SPA navigation and full reloads via `chrome.storage.session` per-tab

**Add mode** (`src/addMode.ts`)
- Entered by clicking add button
- Crosshair cursor; click-to-place a default box the size of the sidebar's thumbnail box (267×100 at the default sidebar width — `DEFAULT_THUMBNAIL_BOX_SIZE`, so a default capture fills its thumbnail exactly), clamped to the viewport; or drag-to-draw a custom size. While placing, a preview of the default box follows the cursor
- Resize from any edge or corner through invisible hit zones — no visible handles (minimum 20×20px); a dimming scrim with a rounded hole for the selection (macOS style)
- Comment box (textarea, 1000-char counter, cancel/save buttons — save disabled while the trimmed note is empty) with auto-flip positioning (below → above → side)
- Suppresses all page interaction while active
- **The pencil** (design spec §AB): once placed, a `.draw-surface` exactly over the box (the interior only — the resize zones are later siblings and win along the edges) takes Pointer Events (coalesced samples) and draws into an SVG layer sized to the whole selectable area in **viewport coordinates**, offset by `-box.x/-box.y`; the surface clips it. Strokes are therefore pinned to the page and a resize only moves the clip. Everything is inside `.visuals`, so `hideOverlayUI()` hides it for the capture. On save the strokes are cropped to the final rect (`drawing.ts`'s `cropDrawing`: Liang–Barsky per segment, a stroke that leaves and re-enters becomes two) and handed to `onOk` as `drawing`
- Keys: keyboard isolation stops every key before it reaches anything inside the shadow root, so add mode passes it a keydown hook for its own keys — Cmd/Ctrl+Z undoes the last stroke unless `shadowRoot.activeElement` is the textarea; the swatches' arrow keys; the pencil menu's arrows/Tab/Esc. content.ts's global Esc handler asks `dismissDrawingMenu()` first, so an open pencil menu eats one Esc before add mode does
- Pencil colour: `content.ts` asks the service worker (`GET_PEN_COLOR`) on every entry and reports picks (`SET_PEN_COLOR`); the service worker keeps it in `chrome.storage.session` under `penColor`. Content scripts are never granted session access (`setAccessLevel` is not called), which is the same boundary the per-tab sidebar state already follows

**Capture pipeline** (`src/capture.ts`)
- Hide overlay UI → requestAnimationFrame (double-rAF, not timeout) → message background → restore UI → exit add mode
- Coordinate contract: selection rect is in **viewport-relative CSS pixels** (same frame as `MouseEvent.clientX/clientY`)
- Service worker crops to device pixels using empirical scale (`imageWidth / cssWidth`) — self-corrects against integer rounding and browser zoom
- Captures are kept at native device pixel ratio (no downscaling); failures create no partial item

---

## Storage Architecture

**Three-tier persistence** (cross-cutting gotcha #1):

1. **`chrome.storage.local`** (metadata) — one small index per domain plus one key per item
   (schema version 2):
   ```
   domain:{domain}    → { meta: { nextItemNumber, version }, pages: { normalisedUrl: id[] } }
   item:{domain}:{id} → FeedbackItem   (thumbnail data-URL inline)
   ```
   Each item carries its own inline thumbnail data-URL, so the sidebar list still paints from one round
   trip (index read + one multi-key get) without touching IndexedDB — but a note autosave rewrites only
   that item's key, not every item of the domain. Consumers never see the split: `storage.getDomainData`
   assembles the in-memory `DomainData` (`pages: { normalisedUrl: FeedbackItem[] }`) and the write
   primitives split it again. An item's drawing (design spec §AB) is stored inline on its record as the
   optional `drawing` field — `{ width, height, strokes: { color, points: [x, y][] }[] }`, CSS px of the
   final selection — and is absent when nothing was drawn, so it needed no migration and no version
   bump. There is no migration path from an older stored shape — no build with
   one was ever released — but every index carries a `version` stamp so a future change has something
   to branch on.

2. **IndexedDB** (blobs, extension origin) — full-resolution PNGs indexed by `screenshotKey`, owned exclusively by service worker
   - Content script can't see IndexedDB; all access goes through background messages
   - Each stored item includes `screenshotKey` (key into IDB) and `thumbnailDataUrl` (inline preview)

3. **`chrome.storage.session`** (ephemeral) — per-tab sidebar open/closed state, and the pencil's
   colour (`penColor`, one value for the browser — design spec §AB)
   - Survives page reloads within a session
   - Clears on browser restart
   - Enables sidebar persistence across F5 without explicit user action

**Storage boundary** — which context may touch which store:

- **Feedback data and blobs only through the service worker.** Domain records, items and the
  per-tab session state (`src/storage.ts`) and screenshot PNGs (`src/imageStore.ts`) are read and
  written by `src/background.ts` alone; a content script reaches them only over `chrome.runtime`
  messages (`src/messages.ts`). This is what keeps the serialised write queue, id allocation and the
  no-orphan rules in one place, and keeps IndexedDB in the extension origin rather than the page's.
- **UI preferences may be accessed directly from either context.** `sidebarWidth` (`src/sidebar.ts`)
  lives in `chrome.storage.local` and is read/written by the content script itself: it is not domain
  data, it needs no serialisation against item writes, and a message round trip for a tiny preference
  would only add a wrong-width flash on open. (There used to be a `themeMode` preference too; the
  extension is now dark only — design spec §AA.)
  A future preference of the same kind (e.g. which connection is selected) follows this rule; anything
  keyed by domain or item does not.

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
- Shows inline thumbnail image + note (3-line clamp) + item number badge, plus a hover/focus delete button over the thumbnail's top-right corner (a sibling of the item's `<button class="thumbnail">` inside the `<li>` — nested buttons are invalid HTML and break activation)
- An item's drawing is an SVG over the image (`viewBox="0 0 w h"`, `xMidYMid meet` — the same placement as the image's `object-fit: contain`), inside the `<li>` so magnification scales it, `pointer-events: none` so the button keeps the click
- Newest at bottom (capture order); macOS-Dock-style spring magnification on hover/focus, which also fades the note background and the delete button
- The list delete goes through content.ts on the same `DELETE_ITEM` round trip (and the same failure copy) as the enlarged view's, and is taken out of the tab order with the rest of the list while add mode holds it

**Enlarged view** (`src/enlargedView.ts`, FLIP helpers in `src/flip.ts`) — replaces v1's modal
- Click thumbnail → the sidebar itself expands to ~75% of the viewport inside the sidebar's shadow root (page not re-laid out; scrim over the remaining strip)
- Shared-element FLIP morphs (panel, clicked thumbnail → main slot, neighbours → peek slots); prev/next/delete run as an interruptible morphing carousel; reduced motion = instant layout + crossfades. Spec: `design/MOTION_SPEC.md`
- Layout (design spec v5 §R): the title bar + image + text area are one block centred in the sheet both ways; the rail is pinned 20px off the viewport's right edge and vertically centred, independent of the image; each peek is its own note fitted the same way and scaled 0.75, showing 20px past the sheet's top/bottom edge, with its horizontal push taken from one circle through all three centres (`arcRadius`/`arcPush`)
- Shows the full-resolution image (fetched via `GET_IMAGE` on open, stale-fetch guarded)
- A drawing is shown view-only on the main card and the peeks as an SVG sibling of the `<img>` inside `.xp-card-media` — the box the morph's media track transforms — so it rides the FLIP morphs and the carousel with no track of its own
- Note autosaves (debounced, flushed on navigate/collapse/unload) with no confirmation; empty notes are never saved and block leaving the note. Failures are plain text under the text area (a `role="status"` live region), not a bar
- The host page's scroll is locked for as long as the view is up (v5 §T): capture-phase `wheel`/`touchmove`/scroll-key handlers with `{ passive: false }`, never `overflow: hidden` — the latter changes the content width on a page with a scrollbar, which moves both the page-shrink and the rects the FLIP morph measures. Taken in `open()`, released in `finish()`, the one teardown every exit path routes through. The exemption is "an element before the host in the composed path can really take this delta" (overflow container, room left in the direction of travel) — **not** "the path contains our host": while the view is open the scrim makes the host cover the whole viewport, so the latter exempts the entire screen and blocks nothing, while still cancelling synthetic events dispatched on `document.body` and so looking like it works
- Immediate delete (no confirmation); deletes both record and blob via background message

## File Inventory

| File | Lines | Role |
|---|---|---|
| `src/background.ts` | 823 | Service worker: injection, capture relay, the message handler table, storage ownership |
| `src/sidebar.ts` | 2983 | Right-docked sidebar shell, page resize, add-note toggle + "keep on" switch, export/chevron menu, hosts the enlarged view |
| `src/content.ts` | 734 | Content script entry: injection guard, message listener, SPA nav detection, message orchestration |
| `src/addMode.ts` | 2043 | Selection box, resize hit zones, dimming scrim, comment box, cursor preview + hint, the pencil (drawing surface, swatches, erase-all menu, stroke undo), add mode lifecycle |
| `src/capture.ts` | 285 | Capture pipeline: hide UI, capture, crop, restore, exit |
| `src/contextCapture.ts` | 426 | DOM context extraction: DCA, contained elements, area text, size governance |
| `src/import.ts` | 149 | Import validation ladder (§5's 13 cases) over the versioned bundle reader |
| `src/export.ts` | 122 | Export coordinator: zip assembly (a drawing is painted into its PNG via `OffscreenCanvas`) + `chrome.downloads` |
| `src/drawing.ts` | 261 | The pencil's palette, cropping strokes to the selection, the SVG and canvas renderers (design spec §AB) |
| `src/bundle/index.ts` | 74 | `feedback.md`: current-version writer + the reader that dispatches on the schema stamp |
| `src/bundle/v1.ts` | 380 | Frozen schema-v1 grammar, yaml mirror types, codecs and parser |
| `src/bundle/version.ts` | 38 | The line-1 schema-version stamp and its reader |
| `src/imageStore.ts` | 85 | IndexedDB wrapper: CRUD for PNG data-URLs |
| `src/enlargedView.ts` | 2160 | Enlarged view: expanding sidebar note viewer/editor, carousel, scroll lock |
| `src/autosave.ts` | 179 | Debounced per-item autosave controller (draft / in-flight / failed / sequence tracking) |
| `src/flip.ts` | 364 | FLIP / shared-element animation helpers |
| `src/dockMotion.ts` | 628 | Dock-style spring magnification for the note list |
| `src/theme.ts` | 676 | Design tokens, light/dark/auto theme, bundled font loading |
| `src/thumbnails.ts` | 209 | Thumbnail list rendering |
| `src/keyboardIsolation.ts` | 94 | Capture-phase keyboard isolation for the extension's surfaces |
| `src/storage.ts` | 350 | `chrome.storage.local` layout (per-domain index + per-item keys), domain/item CRUD, session state |
| `src/messages.ts` | 485 | Typed message contract, `MessageMap`, handler types |
| `src/rpc.ts` | 35 | The content script's typed `send()` |
| `src/types.ts` | 203 | Data model: FeedbackItem, ItemPatch, CapturedContext, DomainData / DomainIndex, import errors |
| `src/copy.ts` | 83 | Every user-facing string, once |
| `src/dataUrl.ts` | 96 | data-URL ↔ bytes / Blob codecs (CSP-safe: no `fetch`) |
| `src/icons.ts` | 88 | The stroke icon set |
| `src/dom.ts` | 39 | Reduced-motion query, rAF with fallback |
| `src/selectorBuilder.ts` | 341 | CSS selector + XPath generation (lifted from v1's fingerprint.ts) |
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
