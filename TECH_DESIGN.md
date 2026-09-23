# Technical Design — Salamander

## Overview

Salamander is a Chrome MV3 extension that captures visual feedback from webpages. The reviewer selects an area, optionally draws on it, attaches a note; the extension screenshots the area, records DOM context, and exports a `.zip` (screenshots + one `feedback.md`) that a person or an AI coding agent reads and that the extension imports back.

**Core constraint:** all data stays on the device; there are no network requests (CSP `connect-src 'none'`). Metadata lives in `chrome.storage.local`, image data in extension-origin IndexedDB, ephemeral state in `chrome.storage.session`.

Behaviour is specified in `REQUIREMENTS.md` (IDs cited below); visual and motion decisions in `design/SALAMANDER_SPEC.md` and `design/MOTION_SPEC.md`. The code is the source of truth for all three.

---

## Architecture

Two bundles, built by esbuild as IIFEs (minified, sourcemaps): `dist/background.js` (the service worker) and `dist/content.js` (the content script, injected on demand). One runtime dependency, `fflate`.

### Service worker (`src/background.ts`)

- **Icon click:** `PING` the tab (300ms timeout). No answer → `chrome.scripting.executeScript` the content script and send `ACTIVATE { tabId }`; alive → send `ICON_CLICKED` and let the content script toggle. Injection failure (`chrome://`, Web Store, PDF viewer) is logged and otherwise silent.
- **Reload persistence (FR-SB-9):** on `tabs.onUpdated` with `status: 'complete'`, if `chrome.storage.session` says the tab's sidebar was open, re-inject and re-`ACTIVATE`; if injection now fails, clear the stale state. `tabs.onRemoved` clears it too.
- **Message handler table:** one handler per `MessageMap` key (`src/messages.ts`); a missing handler or a wrong response shape is a compile error. Background→content messages (`PING`/`ACTIVATE`/`ICON_CLICKED`) are typed the same way on the content side.
- **Capture relay (FR-CP):** `CAPTURE` → a serial throttle queue spacing `chrome.tabs.captureVisibleTab` calls 500ms apart → `createImageBitmap` + `OffscreenCanvas` crop → PNG data-URL into IndexedDB under a `crypto.randomUUID()` key, plus a JPEG thumbnail (longest edge 480, quality 0.75) returned inline. `SAVE_ITEM` then allocates the id and writes the record; if that write fails the blob is deleted again.
- **Storage owner:** every domain mutation (`SAVE_ITEM`, `UPDATE_ITEM`/`UPDATE_NOTE`, `DELETE_ITEM`, `IMPORT_REPLACE`) and every domain read that feeds a user decision (`GET_PAGE_ITEMS`, `GET_DOMAIN_ITEM_COUNT`, the export's read) goes through one promise-chain queue, because the index is read-modify-write. `GET_IMAGE` is a plain read.
- **Export / import write:** `EXPORT` delegates to `src/export.ts`; `IMPORT_REPLACE` mints a fresh screenshot key and thumbnail per item and replaces the domain in one queued call (cleaning up its own blobs on failure). `GET_PEN_COLOR` / `SET_PEN_COLOR` keep the pencil colour in `chrome.storage.session` (only the three palette HEXes are accepted).

### Content script (`src/content.ts`)

- Idempotent: `window.__annotatorActive` guards a second injection. Wrapped in an IIFE so the guard can `return` silently.
- Listens for `PING` / `ACTIVATE` / `ICON_CLICKED`; `init()` always means "open the sidebar" and reports `SIDEBAR_OPENED` / `SIDEBAR_CLOSED` back so the service worker can persist per-tab state (the content script never touches session storage itself).
- Owns the **add-mode state machine** (FR-AM-1/2): the button's click/double-click disambiguation (a 400ms window), the "keep on" switch, the global capture-phase `Esc` handler (registered once, before add mode's own isolation listener, so it always sees the key first; an open pencil menu takes the first `Esc`), and every exit path funnelled through `exitAddModeFully()` / `handleAddModeCancel()` so the button's paint can never drift from `addMode.isAddModeActive()`.
- SPA detection: `history.pushState`/`replaceState` patched, `popstate`, `hashchange`, debounced 50ms; a change of normalised URL exits add mode, collapses the enlarged view and refreshes the list.
- Orchestrates every round trip for the list, enlarged view, export and import; the pure-DOM modules (`sidebar.ts`, `enlargedView.ts`, `thumbnails.ts`, `addMode.ts`) never import `chrome.runtime`.
- `beforeunload`/`pagehide` flush a pending autosave.

### Message contract (`src/messages.ts`, `src/rpc.ts`)

- `MessageMap` pairs every content→background type with its response; `send()` derives its return type from the request and **never rejects** — a dead worker or invalidated context resolves `undefined`, which every caller treats as failure.
- JSON-serialised: images cross as data-URL strings. The full-resolution crop never travels back to the page; only the key and the thumbnail do.
- `UPDATE_NOTE` stays as an alias of `UPDATE_ITEM` (`patch: { note }`) so an older content script still alive on a page keeps saving across an extension update. Remove in the release after 2.0.0.

---

## Sidebar and add mode

**Sidebar shell (`src/sidebar.ts`)**
- Closed shadow root on `#annotator-sidebar-host` (attached to `<html>`, `z-index: 2147483645`).
- **Page shrink:** `margin-right: {width}px`, `width: auto`, `min-width: 0` and `overflow-x: hidden`, all `!important`, on `<html>` — as inline declarations (the page's own pre-open values are snapshotted and restored on close) and as a backstop `html:root {…}` stylesheet (`#annotator-page-resize`), defended by a `MutationObserver` on the root's `style`/`class` (re-asserting up to 50 times) and followed by a synthetic `resize` event so JS-measured layouts re-run. `--annotator-sidebar-width` is also set on `<html>` (nothing reads it today but tests). Known limitation: `vw`-sized and `innerWidth`-measured layouts (youtube.com) are not moved (EC-13).
- **Resizable width:** 188–300, default 300, persisted as `sidebarWidth` in `chrome.storage.local` directly from the content script (the one sanctioned exception to the storage boundary below), clamped on load. `SIDEBAR_MIN_WIDTH` is derived from the action row's constants (`PANEL_BORDER + ACTION_ROW_PAD_X×2 + ADD_GROUP + ADD_SWITCH_ADVANCE + ACTION_ROW_GAP + EXPORT_GROUP` = 188). Below 220px (`NARROW_WIDTH_BREAKPOINT`) only the wordmark hides.
- Header (logo + wordmark + close), action row (add group + export group, `initSidebar`'s wiring split into `wireAddGroup` / `wireExportGroup` / `wireChrome`), one rule under the block, "this page (n)" + list or the empty state, inline `role="alert"` banners (8s).
- **On hold** during add mode (FR-AM-9): `applyListHold` dims and inerts the list, suspends dock motion, disables the export group.
- Hosts the enlarged view (it expands the sidebar itself) and exposes `openEnlargedView` / `collapseEnlargedView` / `flushEnlargedView`.

**Add mode (`src/addMode.ts`)**
- Own closed shadow root on `#annotator-addmode-host` (`z-index: 2147483640`, `pointer-events: none`; a full-viewport `.blocker` underneath takes page clicks). `.visuals` holds everything `hideOverlayUI()` hides for the capture: preview, scrim, box, outline, zones, drawing layer, comment box, tooltip.
- Placement: `computeDefaultBox` (267×100 = `DEFAULT_THUMBNAIL_BOX_SIZE` from `sidebar.ts`, centred, clamped to `getContentViewportSize()` minus the sidebar), a 5px drag threshold for drag-to-draw, 20×20 minimum, edge zones 10px / corner zones 16px (`computeResizeZones`, exported for tests).
- Outline: two SVG rects on the same rounded path — ink underneath, accent dashed 4/4 on top — so the line is exactly 2px and the gaps are ink (design spec §Z).
- Comment box (296px): textarea (1000 max), bottom bar with the pencil button (28px), its `role="menu"` ("erase all"), the swatch radio group, the counter (`>900` muted, `≥980` danger), cancel/save; below → above → side flip.
- **The pencil (§AB):** a `.draw-surface` exactly over the box (interior only — the resize zones are later siblings and win along the edges) takes Pointer Events with coalesced samples and draws into an SVG layer sized to the whole selectable area in **viewport coordinates**, offset by `-box.x/-box.y` and clipped by the surface; a resize only moves the clip, so strokes stay pinned to the page. On save `drawing.ts`'s `cropDrawing` (Liang–Barsky per segment; a stroke that leaves and re-enters becomes two runs) produces the stored `Drawing`. `hasPendingComment()` counts strokes as unfinished work.
- Keys: keyboard isolation stops every key before it reaches anything inside the shadow root, so add mode passes it a keydown hook for its own keys — Cmd/Ctrl+Z undoes the last stroke unless `shadowRoot.activeElement` is the textarea; the swatches' arrows; the pencil menu's arrows/Tab/Esc.
- Pencil colour: `content.ts` asks the service worker on every entry (`restorePenColor`, sequence-guarded so a late reply cannot overwrite a newer pick) and reports picks fire-and-forget.

**Capture pipeline (`src/capture.ts`)**
- Order: read viewport metrics once → `captureContext` (page-coordinate rect) → `overlay.hide()` → `waitForNextPaint` (double rAF, 250ms timeout for a backgrounded tab) → `CAPTURE` → `SAVE_ITEM` → hand back the stored item. On success the overlay stays hidden (add mode tears down); on any failure it is restored and add mode stays alive.
- Coordinate contract: the crop rect is **viewport-relative CSS px** (no scroll offset — `captureVisibleTab` photographs the viewport); `selectionRect` on the item is page CSS px (`toPageRect`, the only place scroll is added); device px are computed only in the service worker (`computeDeviceRect`), where the real image size is known. Two CSS widths travel (`innerWidth` and `documentElement.clientWidth`) because a classic scrollbar makes the divisor ambiguous; the scale nearest `dpr` wins. Edges round independently and clamp inside the image.

---

## Storage

**Three tiers**

1. **`chrome.storage.local`** — schema version 2:
   ```
   domain:{domain}    → { meta: { nextItemNumber, version: 2 }, pages: { normalisedUrl: id[] } }
   item:{domain}:{id} → FeedbackItem   (thumbnailDataUrl inline; drawing optional)
   ```
   The list paints from one index read plus one multi-key get of that URL's items; an autosave rewrites only that item's key; `addItem` writes item and index in one `set`; `replaceDomainData` writes the new record before removing stale item keys, so a torn write leaves orphan keys rather than a broken index. `getDomainData` assembles the in-memory `DomainData` (`pages: { url: FeedbackItem[] }`) and the write primitives split it. There is no migration (no other stored shape was ever released); `version` is stamped so a future one has a branch point; an index stamped newer than this build is read as-is.
2. **IndexedDB** (`annotator-images`, store `screenshots`, extension origin) — full-resolution PNGs as data-URL strings, keyed by `screenshotKey`, owned by the service worker. Data-URL strings rather than Blobs because every hop (capture API, messages, `chrome.downloads`) already deals in them and a service worker has no `FileReader`.
3. **`chrome.storage.session`** — `sidebarOpen:{tabId}` and `penColor` (one value for the browser). Survives reloads, clears on browser restart. Never exposed to content scripts (`setAccessLevel` is not called).

**Storage boundary**
- Feedback data and blobs only through the service worker: `src/storage.ts` and `src/imageStore.ts` are imported by `src/background.ts` alone. This keeps the write queue, id allocation and the no-orphan rules in one place, and keeps IndexedDB in the extension origin rather than the page's.
- UI preferences may be touched from either context: `sidebarWidth` is read/written by the content script directly. Anything keyed by domain or item is not a preference.

**Context capture (`src/contextCapture.ts`)** — pure DOM walk in the content script, before anything is hidden: primary target (deepest fully-containing element, iframes as leaves), ≤15 prioritised contained elements, area text, page metadata, all under a 2KB JSON-length budget that shrinks the `outerHTML` snippet (×0.7 steps, marker kept) then trims elements. Selectors come from `src/selectorBuilder.ts` (see `FINGERPRINTING.md`).

---

## Thumbnails and the enlarged view

**Note list (`src/thumbnails.ts`, magnification in `src/dockMotion.ts`)**
- Renders `FeedbackItem[]` from `GET_PAGE_ITEMS`: per `<li>`, a `<button class="thumbnail">` (100px image box, `object-fit: contain`, badge, drawing SVG with `pointer-events: none`, note text clamped to 3 lines by CSS with a 600-character DOM cap) and a sibling `<button class="thumbnail-delete">` (28px; nested buttons are invalid HTML and break activation). The delete goes through `content.ts` on the same `DELETE_ITEM` round trip and copy as the enlarged view's.
- Dock motion: influence is a cosine falloff over 1.75 item heights from the pointer's Y (layout coordinates, read once), target scale `1 + 0.12·f`, translateX `−22px·f`, integrated by a spring (ζ 0.92 tracking, critically damped release) in one rAF loop that stops at rest; keyboard focus drives the same targets; the note background and the delete button share one opacity spring; off under reduced motion; suspended during add mode and while the enlarged view is open.

**Enlarged view (`src/enlargedView.ts`, motion helpers in `src/flip.ts`, autosave in `src/autosave.ts`)**
- Renders inside the sidebar's shadow root; the sidebar's own width animates to `max(0.75·viewport, min(560, viewport), sidebarWidth)` with a scrim over the remaining page. Layout (`computeEnlargedGeometry`): the block (title bar + image at the selection's CSS size, clamped down, column floor 240px + editor) is centred; the rail (36px buttons) is 20px off the viewport's right edge and vertically centred; each peek is its own note fitted the same way ×0.75, showing 20px past the sheet edge, pushed right on the arc `R = (D² + P²)/2P`, `push(dy) = R − √(R² − dy²)` with `P = 60`, `D = H/2`.
- Shared-element FLIP morphs (panel, clicked thumbnail → main, neighbours → peeks) as sampled transform-only keyframes with a counter-transform on `.xp-card-media` so the contained image never squashes; every tween keeps an analytic record so an interruption retargets from the live value (MOTION_SPEC §13). Timing table `T` in the module (expand 450, collapse 340, carousel 400, autosave 700, …). A drawing rides as an SVG sibling of the `<img>` inside `.xp-card-media`.
- Full image via `GET_IMAGE` on open (stale-fetch guarded; falls back to the thumbnail). Autosave through `AutosaveController` (700ms debounce, dirty = differs from stored and in-flight, superseded replies dropped, failed saves retried on flush); empty notes are never savable and block every exit (FR-EV-8). Failures are plain text under the textarea (`role="status"`).
- Scroll lock (FR-EV-7): capture-phase `wheel`/`touchmove`/`keydown` with `{ passive: false }`, taken in `open()` and released in `finish()`, the one teardown every exit path routes through. The exemption test is "an element before the host in the composed path can really take this delta" — not "the path contains our host", which would exempt the whole viewport once the scrim covers it.
- Delete: immediate, both record and blob, then the §8 choreography (next / prev / collapse).

**Keyboard isolation (`src/keyboardIsolation.ts`)** — capture-phase `window` listeners for `keydown`/`keyup`/`keypress` call `stopPropagation()` + `stopImmediatePropagation()` (never `preventDefault()`) for events whose `composedPath()` includes the host; installed only while add mode or the enlarged view is open. Reason: closed shadow roots hide the focused element from a site's `document`-level shortcut handlers (Gmail's "c", Instagram's "n"), which then fire and `preventDefault()` the keystroke.

**Theme and fonts (`src/theme.ts`)** — dark only (design spec §AA): `getThemeCSS()` emits `DARK_THEME` as `--sal-*` custom properties on `:host`; `LIGHT_THEME` is kept, unused, so a light theme can return without re-deriving a palette (a test pins that the two tables share the same keys). Fonts are fetched from `chrome.runtime.getURL('fonts/…')` and registered with `FontFace` under `Salamander Serif` / `Sans` / `Mono`, once, silently falling back to the system stack.

---

## Export and import

**Export (`src/export.ts`)** — in the service worker: read the domain (through the queue) → `buildFeedbackMarkdown` → per item `imageStore.getImage`, composited with `paintDrawing` on an `OffscreenCanvas` when the item has strokes (scale measured as image px / drawing CSS px, a failed composite falls back to the clean PNG, a missing blob skips the file) → `zipSync` (level 6) → data URL → `chrome.downloads.download({ saveAs: false })`. The header's clock and manifest version are injectable so a test can pin the bytes.

**Bundle format (`src/bundle/`)** — `version.ts` owns the line-1 stamp (`<!-- salamander-feedback-format: 2 -->`, BOM/whitespace tolerant); `index.ts` dispatches the reader on it (each `case` names the codec's own version constant) and refuses any other with `UnsupportedFormatError`; `v2.ts` is the grammar, the `JsonFeedbackItem` record (keys in §AC order), the writer, the reader and its `FieldReader` type checks. The writer numbers each `### feedback n` heading by the note's position on its page and names the screenshot by id; the reader hands back `{ number, item }` entries so the importer can check for a repeated number within a page while the item itself carries only the id. `text` is derived from `html` at export (tags stripped, entities decoded) and ignored on read. `context.pageMeta` is not written — only `page_title` — and import rebuilds it from the item fields. A future format is a new `vN.ts`, a `FORMAT_VERSION` bump, a `case` and a new frozen fixture.

**Why one Markdown file with JSON inside:** it is both what a person or agent reads and what import reads back, with no second file and no YAML dependency. Pretty-printed JSON can never contain a line that is exactly ` ``` `, so a note (free user text) cannot end the block early; the reader takes each item's block by its id, preferring the block whose note renders to exactly the lines above it, so a note that quotes an exported item is skipped whole.

**Import (`src/import.ts`)** — in the content script (the `File` lives in the page's world; validation needs no storage): the §5 ladder in order (type → `unzipSync` → `feedback.md` present → format stamp → structure/fields → screenshots present → duplicates (the same id twice anywhere, or the same heading number twice under one page) → domain), each check a full pass over every item before the next, then `content.ts` reads the existing count (`GET_DOMAIN_ITEM_COUNT`; a failed read stops the import), shows the native `confirm`, and sends `IMPORT_REPLACE` with the PNG bytes re-encoded as data URLs.

---

## File inventory

| File | Lines | Role |
|---|---|---|
| `src/sidebar.ts` | 3071 | Sidebar shell, page shrink, resizable width, action row, banners, list host, enlarged-view host |
| `src/enlargedView.ts` | 2180 | Enlarged view: geometry, FLIP choreography, carousel, autosave wiring, scroll lock |
| `src/addMode.ts` | 2053 | Selection box, zones, scrim, outline, comment box, preview + hint, the pencil |
| `src/wordlist.ts` | 1507 | Dictionary for the "human-authored id" heuristic |
| `src/background.ts` | 857 | Service worker: injection, capture relay + crop, handler table, storage ownership |
| `src/content.ts` | 779 | Content script entry: add-mode state machine, SPA detection, message orchestration |
| `src/dockMotion.ts` | 663 | Dock-style spring magnification |
| `src/bundle/v2.ts` | 579 | feedback.md format 2: grammar, JSON record, writer, reader |
| `src/messages.ts` | 518 | Typed message contract, `MessageMap`, handler types |
| `src/contextCapture.ts` | 426 | DOM context extraction and the 2KB governor |
| `src/storage.ts` | 375 | `chrome.storage.local` layout, domain/item CRUD, session state, pen colour |
| `src/flip.ts` | 364 | Analytic tweens, morph keyframes, WAAPI wrappers |
| `src/selectorBuilder.ts` | 341 | CSS selector + XPath generation |
| `src/theme.ts` | 327 | Tokens (dark emitted, light parked), radii, font loading |
| `src/capture.ts` | 270 | Capture pipeline (content-script half) |
| `src/drawing.ts` | 261 | Pen palette, `cropDrawing`, SVG and canvas renderers |
| `src/types.ts` | 226 | Data model, `ItemPatch`, import error codes |
| `src/thumbnails.ts` | 219 | Note list items |
| `src/autosave.ts` | 179 | `AutosaveController` |
| `src/export.ts` | 144 | Zip assembly, drawing composite, download |
| `src/import.ts` | 142 | Import validation ladder |
| `src/urlNorm.ts` | 125 | URL/domain normalisation, export filename |
| `src/icons.ts` | 110 | The stroke icon set and the pencil cursor |
| `src/dataUrl.ts` | 96 | data-URL ↔ bytes/Blob (CSP-safe, no `fetch`) |
| `src/keyboardIsolation.ts` | 94 | Capture-phase key isolation |
| `src/copy.ts` | 80 | Every user-facing string |
| `src/imageStore.ts` | 79 | IndexedDB wrapper |
| `src/bundle/index.ts` | 72 | Current-format writer; reader dispatch on the stamp |
| `src/dom.ts` | 67 | `getContentViewportSize`, reduced-motion query, safe rAF |
| `src/rpc.ts` | 35 | The typed `send()` |
| `src/bundle/version.ts` | 35 | The line-1 format stamp |

(`wc -l` on 2026-09-22; 16,274 lines in `src/` excluding tests.)

---

## Key decisions

- **Screenshots instead of live pins.** Re-resolving a pinned element after the page changed was fragile (see `docs/v1-archive/`). A screenshot plus context is a stable artefact; nothing is ever re-located.
- **A sidebar that shrinks the page.** An overlay hides content; a shrink keeps everything reachable and means the sidebar can never be inside a capture.
- **Closed shadow roots + keyboard isolation + event-level scroll lock.** Each exists because a real site broke without it (page CSS bleed, Gmail/Instagram shortcuts, the width shift `overflow: hidden` causes). Do not replace them with the simpler alternative.
- **The crop scale is measured, not assumed.** `innerWidth` is an integer and the captured image is not guaranteed to be `innerWidth × devicePixelRatio`; dividing real by reported is self-correcting, and sending both viewport widths resolves the scrollbar ambiguity.
- **Ids allocated in the service worker, preserved on import; numbers derived at render.** The id is sequential across a domain's URLs, never reused, and is the storage key and the export's screenshot filename; the counter lives behind the storage boundary. The number a note is shown under is its 1-based position in its page's list, computed by each renderer (list, enlarged view, export) from the same `pages[url]` array — nothing stores it, so nothing migrates, and deleting a note renumbers the ones after it.
- **Drawing as a separate layer, flattened only at export.** The stored screenshot stays clean and the bundle format does not change; the alt text is the only trace in `feedback.md`.
- **Replace-only import, format 2 only.** No merge logic, no ID collision handling, no legacy codecs — the extension was never published with anything else.
- **Dark only.** The switcher, `themeMode` and cross-tab sync were removed (design spec §AA); the light table is parked in `theme.ts`.
