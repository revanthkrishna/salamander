# Technical Design — Salamander

## Overview

Salamander is a Chrome MV3 extension that captures visual feedback from webpages. The reviewer selects an area, optionally draws on it, attaches a note; the extension screenshots the area, records DOM context, and exports a `.zip` (screenshots + one `feedback.md`) that a person or an AI coding agent reads and that the extension imports back.

**Core constraint:** all data stays on the device; there are no network requests (CSP `connect-src 'none'`). Metadata lives in `chrome.storage.local`, image data in extension-origin IndexedDB, ephemeral state in `chrome.storage.session`.

Behaviour is specified in `REQUIREMENTS.md` (IDs cited below); visual and motion decisions in `design/SALAMANDER_SPEC.md` and `design/MOTION_SPEC.md`. The code is the source of truth for all three.

---

## Architecture

Two bundles, built by esbuild as IIFEs (minified, sourcemaps): `dist/background.js` (the service worker) and `dist/content.js` (the content script, injected on demand). One runtime dependency, `fflate`. The stylesheets live in `src/styles/*.css.ts` as template literals (they interpolate the TS metrics); their CSS comments are stripped at build time by `build/stripCssComments.js` (an esbuild `onLoad` plugin; jest applies the same function, so the golden files in `src/__tests__/__golden__/` pin the CSS that ships).

### Service worker (`src/background.ts`)

- **Icon click:** `PING` the tab (300ms timeout). No answer → `chrome.scripting.executeScript` the content script and send `ACTIVATE { tabId }`; alive → send `ICON_CLICKED` and let the content script toggle. Injection failure (`chrome://`, Web Store, PDF viewer) is logged and otherwise silent.
- **Reload persistence (FR-SB-9):** on `tabs.onUpdated` with `status: 'complete'`, if `chrome.storage.session` says the tab's sidebar was open, `PING` first and re-inject only when no script answers, then re-`ACTIVATE`; if injection now fails, clear the stale state. `tabs.onRemoved` clears it too.
- **Message handler table:** one handler per `MessageMap` key (`src/messages.ts`); a missing handler or a wrong response shape is a compile error. Background→content messages (`PING`/`ACTIVATE`/`ICON_CLICKED`) are typed the same way on the content side.
- **Capture relay (FR-CP):** `CAPTURE` → a serial throttle queue spacing `chrome.tabs.captureVisibleTab` calls 500ms apart → `createImageBitmap` + `OffscreenCanvas` crop → PNG data-URL into IndexedDB under a `crypto.randomUUID()` key, plus a JPEG thumbnail (longest edge 480, quality 0.75) returned inline. `SAVE_ITEM` then allocates the id and writes the record; if that write fails the blob is deleted again.
- **Storage owner:** every domain mutation (`SAVE_ITEM`, `UPDATE_ITEM`/`UPDATE_NOTE`, `DELETE_ITEM`, `SET_PAGE_TITLE`, `IMPORT_COMMIT`, `DELETE_DOMAIN_DATA`) and every domain read that feeds a user decision (`GET_PAGE_ITEMS`, `GET_SITE_PAGES`, `GET_DOMAIN_ITEM_COUNT`, the export's read) goes through one promise-chain queue, because the index is read-modify-write. `GET_IMAGE` is a plain read. An `UPDATE_ITEM` (or `UPDATE_NOTE`) for a note that no longer exists answers `{ ok: false, code: 'NOT_FOUND' }` with the "couldn't save" copy, never "saved".
- **Export / import write:** `EXPORT` delegates to `src/export.ts`. Import crosses in pieces, because Chrome refuses any one message over 64 MiB: `IMPORT_STAGE_IMAGE` (one screenshot per message) stores it under a fresh key and renders its thumbnail; `IMPORT_COMMIT` (the notes, carrying those keys and thumbnails) replaces the domain in one queued call and deletes the staged screenshots if it fails; `IMPORT_ABORT` deletes what was staged when staging fails part-way. `GET_PEN_COLOR` / `SET_PEN_COLOR` keep the pencil colour in `chrome.storage.session` (only the three palette HEXes are accepted). The Option/Alt+N tip (FR-AM-2b, `src/addNoteTip.ts`): `GET_ADD_NOTE_TIP` answers whether a single-click start counted now would show it (the session's `addNoteClicks`, its `addNoteTipReserved` and the install's `addNoteTip` state) and, on a yes, reserves the showing in the same step (the install's count up, the session's reservation set), so two tabs cannot both be told yes; `RECORD_ADD_NOTE_CLICK` counts a start, `RELEASE_ADD_NOTE_TIP` gives back a reserved showing nobody saw and `ADD_NOTE_SHORTCUT_USED` sets the never-again flag — the last three are notifications. They run one at a time on their own promise chain, not the domain queue, and are best-effort.

### Content script (`src/content.ts`)

- Idempotent: `window.__annotatorActive` guards a second injection (it records the instance's `{ alive, teardown }`). Wrapped in an IIFE so the guard can `return` silently.
- **Page-lifetime teardown (when the extension context dies):** after an extension update or reload the old script is an orphan whose every round trip fails. `teardown()` exits add mode, destroys the sidebar (host removed, page layout restored), restores history's methods and removes its own listeners, showing nothing new. It runs on the first round trip that finds the context invalidated (`rpc.ts`'s `onContextInvalidated` hook) or when a fresh injection, which dispatches a `salamander:takeover` event on `document` before its guard, finds this one's context dead (DOM events cross JS worlds where globals do not). So the icon clicked after an update builds exactly one sidebar.
- Listens for `PING` / `ACTIVATE` / `ICON_CLICKED`; `init()` always means "open the sidebar" and reports `SIDEBAR_OPENED` / `SIDEBAR_CLOSED` back so the service worker can persist per-tab state (the content script never touches session storage itself).
- Wires the **add-mode state machine** (FR-AM-1/2, `src/addModeControl.ts`, a pure controller on injected deps): the button's click/double-click disambiguation (a 400ms window), the "keep on" switch, `Esc` and Option/Alt+N through the key router at `GLOBAL_ESC_AND_SHORTCUT` (an open pencil menu takes the first `Esc`), every exit path funnelled through `exitFully()` / the cancel callback so the button's paint can never drift from `addMode.isAddModeActive()`, and a session token so a capture that resolves after a new add-mode session started leaves that session alone. A start from a single click on the button asks the service worker about the Option/Alt+N tip (`addMode.showPlacingTip` puts it in the hint's place if the answer comes while still placing, and says once whether it was seen) and, once the double-click window has passed without a `dblclick`, is counted — a start the tip was for only once the tip has been on screen; one whose tip never got there, or half of a double-click, gives the reserved showing back uncounted; the shortcut reports that it was used.
- SPA detection (`src/navigation.ts`): `history.pushState`/`replaceState` patched, `popstate`, `hashchange`, debounced 50ms, with a `restore()` for the teardown; a change of normalised URL exits add mode, collapses the enlarged view and refreshes the list.
- Orchestrates every round trip for the list and the enlarged view; export, import, delete-all and the list's delete are `src/siteActions.ts`. The site's note count (`GET_DOMAIN_ITEM_COUNT`) is read by one helper, `readSiteCounts()`, which also tells the sidebar whether the site has notes (`setSiteHasNotes`, what greys out export and delete-all); it runs after every repaint (`refreshSiteHasNotes`, failing closed) and fresh when import or delete-all is chosen. The pure-DOM modules (`sidebar.ts`, `enlargedView.ts`, `thumbnails.ts`, `addMode.ts`) never import `chrome.runtime`.
- `beforeunload`/`pagehide` flush a pending autosave.

### Message contract (`src/messages.ts`, `src/rpc.ts`)

- `MessageMap` pairs every content→background type with its response (two compile-time guards: its keys and the union's `type`s are the same set, and every entry's request is the message of its own key); `send()` derives its return type from the request and **never rejects** — a dead worker or invalidated context resolves `undefined`, which every caller treats as failure. An invalidated context is also reported to the content script's teardown hook.
- JSON-serialised: images cross as data-URL strings. The full-resolution crop never travels back to the page; only the key and the thumbnail do.
- `UPDATE_NOTE` stays as an alias of `UPDATE_ITEM` (`patch: { note }`), answering exactly as it does, so an older content script still alive on a page keeps saving across an extension update. It was once scheduled for removal after 2.0.0; the owner has chosen to keep it for now.

---

## Sidebar and add mode

**Sidebar shell (`src/sidebar.ts`)** — builds and wires the panel (one `SidebarDom` record while it is built), paints the add group, resolves the action row's availability and add mode's hold, hosts the list and the enlarged view. Beside it: the page shrink (`src/pageResize.ts`), the width store (`src/sidebarWidth.ts`), the numbers (`src/sidebarMetrics.ts`), the stylesheet (`src/styles/sidebar.css.ts`), the banner (`src/notifications.ts`) and the "more options" menu (`src/actionMenu.ts`).
- Closed shadow root on `#annotator-sidebar-host` (attached to `<html>`, `z-index: 2147483645`).
- **Keys pressed in the panel never reach the page** (NF-ISO-1, NF-A11Y-2): keyboard isolation on its host while it is shown, at the key router's `SIDEBAR_ISOLATION`. Its hook first hands the panel's own keydown listeners a non-composed copy of the key at the focused element (a copy a listener cancels cancels the real key), since the isolation stops the key before they would hear it.
- **Page shrink (`src/pageResize.ts`):** `margin-right: {width}px`, `width: auto`, `min-width: 0` and `overflow-x: hidden`, all `!important`, on `<html>` — as inline declarations (the page's own pre-open values are snapshotted and restored on close) and as a backstop `html:root {…}` stylesheet (`#annotator-page-resize`), defended by a `MutationObserver` on the root's `style`/`class` (re-asserting up to 50 times) and followed by a synthetic `resize` event so JS-measured layouts re-run. A resize drag writes this once per animation frame. `--annotator-sidebar-width` is also set on `<html>` (nothing reads it today but tests). Known limitation: `vw`-sized and `innerWidth`-measured layouts (youtube.com) are not moved (EC-13).
- **Resizable width (`src/sidebarWidth.ts`):** 210–300, default 300, persisted as `sidebarWidth` in `chrome.storage.local` directly from the content script (the one sanctioned exception to the storage boundary below), clamped on load. `SIDEBAR_MIN_WIDTH` is derived from the action row's constants (`PANEL_BORDER + ACTION_ROW_PAD_X×2 + ADD_GROUP + ADD_SWITCH_ADVANCE + ACTION_ROW_GAP + EXPORT_GROUP` = 210; the export group is two 38px buttons 6px apart, design spec §AE). Below 220px (`NARROW_WIDTH_BREAKPOINT`) only the wordmark hides.
- Header (logo + wordmark + close), action row (add group + export group, `initSidebar`'s wiring split into `wireAddGroup` / `wireExportGroup` / `wireChrome`), one rule under the block, "this page (n)" + list or the empty state, inline `role="alert"` banners (8s).
- **On hold** during add mode (FR-AM-9): `applyListHold` dims and inerts the list, suspends dock motion, disables the export group.
- **Menu confirmations** (FR-SB-11): `confirmInMenu` turns the open "more options" menu (`src/actionMenu.ts`) into the question. `layoutConfirmActions` measures the two buttons' natural (unwrapped) widths per question and, when they do not fit side by side, stacks them full width (`is-stacked`, the confirming button above cancel); labels never wrap.
- Hosts the enlarged view (it expands the sidebar itself) and exposes `openEnlargedView` / `collapseEnlargedView` / `flushEnlargedView`.

**Add mode (`src/addMode.ts`)**
- Own closed shadow root on `#annotator-addmode-host` (`z-index: 2147483640`, `pointer-events: none`; a full-viewport `.blocker` underneath takes page clicks). `.visuals` holds everything `hideOverlayUI()` hides for the capture: preview, scrim, box, outline, zones, drawing layer, comment box, the preview tooltip that follows the cursor. The shared tooltip (`src/tooltip.ts`) is its sibling, so the save click hides it itself, with `hide({ immediate: true })` — no fade-out for the capture to catch. The sidebar's tooltip can reach over the page too, so the add-mode controller's capture step (`src/addModeControl.ts`) takes it down the same way (`sidebar.hideTooltipNow()`) as part of the capture's hide step.
- Placement: `computeDefaultBox` (267×100 = `DEFAULT_THUMBNAIL_BOX_SIZE` from `sidebarMetrics.ts`, centred, clamped to `getContentViewportSize()` minus the sidebar), a 5px drag threshold for drag-to-draw, 20×20 minimum, edge zones 10px / corner zones 16px (`computeZoneRects`, exposed to the tests as `_zoneRectsForTests`). While a box is being placed the page hears no key at all (FR-AM-8): every key is stopped, never cancelled, at the key router's `PLACING_ISOLATION`, after salamander's own handlers.
- Outline: two SVG rects on the same rounded path — ink underneath, accent dashed 4/4 on top — so the line is exactly 2px and the gaps are ink (design spec §Z).
- Comment box (296px; its numbers shared with the stylesheet in `src/addModeMetrics.ts`; its height measured once, not on every render): one `bg` surface with a uniform 6px inset (`COMMENT_PAD_PX`) around and between the textarea (1000 max) and the button row; every corner inside is radius-lg − 6 (`COMMENT_INNER_RADIUS_CSS`), concentric with the box's. The row holds the pencil button (28px), its `role="menu"` ("erase all", carrying `data-tip-edge`), the swatch radio group, the counter (`>900` muted, `≥980` danger), cancel/save; below → above → side flip. Save (empty note) and erase all (nothing drawn) are soft-disabled (`aria-disabled`, with a `data-tip-reason`); "saving…" is natively `disabled`, as are cancel, the pencil and the swatches during the capture.
- **The pencil (§AB):** a `.draw-surface` exactly over the box (interior only — the resize zones are later siblings and win along the edges) takes Pointer Events with coalesced samples and draws into an SVG layer sized to the whole selectable area in **viewport coordinates**, offset by `-box.x/-box.y` and clipped by the surface; a resize only moves the clip, so strokes stay pinned to the page. On save `drawing.ts`'s `cropDrawing` (Liang–Barsky per segment; a stroke that leaves and re-enters becomes two runs) produces the stored `Drawing`. `hasPendingComment()` counts strokes as unfinished work.
- Keys: once a box is placed, keyboard isolation (`ADDMODE_ISOLATION`) stops every key before it reaches anything inside the shadow root, so add mode passes it a keydown hook for its own keys — Cmd/Ctrl+Z undoes the last stroke unless `shadowRoot.activeElement` is the textarea; the swatches' arrows; the pencil menu's arrows/Tab/Esc.
- Pencil colour: content.ts asks the service worker on every entry (`restorePenColor`, sequence-guarded so a late reply cannot overwrite a newer pick) and reports picks fire-and-forget.

**Capture pipeline (`src/capture.ts`)**
- Order: read viewport metrics once → `captureContext` (page-coordinate rect) → `overlay.hide()` → `waitForNextPaint` (double rAF, 250ms timeout for a backgrounded tab) → `CAPTURE` → `SAVE_ITEM` → hand back the stored item. On success the overlay stays hidden (add mode tears down); on any failure it is restored and add mode stays alive.
- Coordinate contract: the crop rect is **viewport-relative CSS px** (no scroll offset — `captureVisibleTab` photographs the viewport); `selectionRect` on the item is page CSS px (`toPageRect`, the only place scroll is added); device px are computed only in the service worker (`computeDeviceRect`), where the real image size is known. Two CSS widths travel (`innerWidth` and `documentElement.clientWidth`) because a classic scrollbar makes the divisor ambiguous; the scale nearest `dpr` wins. Edges round independently and clamp inside the image.

---

## Storage

**Three tiers**

1. **`chrome.storage.local`** — schema version 2:
   ```
   domain:{domain}    → { meta: { nextItemNumber, version: 2, pageTitles? }, pages: { normalisedUrl: id[] } }
   item:{domain}:{id} → FeedbackItem   (thumbnailDataUrl inline; drawing optional)
   ```
   The promise wrappers over `chrome.storage.local` reject when `chrome.runtime.lastError` is set, so a failed read, write or delete reaches the calling handler's catch and its existing error copy rather than passing as success. The destructive paths write first and clean up after, so data nothing references is the only possible residue of a failure: `replaceDomainData` writes the new record, then removes the stale item keys and the old screenshots; `deleteDomainData` removes the keys, then the screenshots; `deleteItem` writes the index, then removes the item key and its screenshot. Removing what nothing points at any more is best-effort and only logged, since an orphan costs space and nothing else. The session-storage wrappers stay best-effort. The list paints from one index read plus one multi-key get of that URL's items; an autosave rewrites only that item's key; `addItem` writes item and index in one `set`. `getDomainData` assembles the in-memory `DomainData` (`pages: { url: FeedbackItem[] }`) and the write primitives split it. There is no migration (no other stored shape was ever released); `version` is stamped so a future one has a branch point; an index stamped newer than this build is read as-is.
2. **IndexedDB** (`annotator-images`, store `screenshots`, extension origin) — full-resolution PNGs as data-URL strings, keyed by `screenshotKey`, owned by the service worker. The shared connection is reopened, not cached broken, after a failed open, a close the browser made, or a `versionchange`. Data-URL strings rather than Blobs because every hop (capture API, messages, `chrome.downloads`) already deals in them and a service worker has no `FileReader`.
3. **`chrome.storage.session`** — `sidebarOpen:{tabId}`, `penColor` (one value for the browser) `addNoteClicks` (the session's single-click add-mode starts, FR-AM-2b) and `addNoteTipReserved` (its tip showing promised). Survives reloads, clears on browser restart. Never exposed to content scripts (`setAccessLevel` is not called). The tip's install state (`addNoteTip`: `{ shown, shortcutUsed }`) is one more `chrome.storage.local` key, written only by the service worker and never touched by an import or a delete-all.

**Storage boundary**
- Feedback data and blobs only through the service worker: `src/storage.ts` and `src/imageStore.ts` are imported by `src/background.ts` alone. This keeps the write queue, id allocation and the no-orphan rules in one place, and keeps IndexedDB in the extension origin rather than the page's.
- UI preferences may be touched from either context: `sidebarWidth` is read/written by the content script directly. Anything keyed by domain or item is not a preference.

**Context capture (`src/contextCapture.ts`)** — pure DOM walk in the content script, before anything is hidden: primary target (deepest fully-containing element, iframes as leaves), ≤15 prioritised contained elements, area text, page metadata, all under a 2KB JSON-length budget that shrinks the `outerHTML` snippet (×0.7 steps, marker kept) then trims elements. Selectors come from `src/selectorBuilder.ts` (see `FINGERPRINTING.md`).

---

## Thumbnails and the enlarged view

**Note list (`src/thumbnails.ts`, magnification in `src/dockMotion.ts`)**
- Renders `FeedbackItem[]` from `GET_PAGE_ITEMS`: per `<li>`, a `<button class="thumbnail">` (100px image box, `object-fit: contain`, badge, drawing SVG with `pointer-events: none`, note text clamped to 3 lines by CSS with a 600-character DOM cap) and a sibling `<button class="thumbnail-delete">` (28px; nested buttons are invalid HTML and break activation). The delete goes through `content.ts` on the same `DELETE_ITEM` round trip and copy as the enlarged view's.
- Dock motion: influence is a cosine falloff over 1.75 item heights from the pointer's Y (layout coordinates, read once), target scale `1 + 0.12·f`, translateX `−22px·f`, integrated by a spring (ζ 0.92 tracking, critically damped release) in one rAF loop that stops at rest; keyboard focus drives the same targets; the note background and the delete button share one opacity spring; off under reduced motion; suspended during add mode and while the enlarged view is open.

**Enlarged view (`src/enlargedView.ts`; pure geometry in `src/enlargedLayout.ts`, a page's heading and rename in `src/pageHeading.ts`, the scroll lock in `src/scrollLock.ts`, motion helpers in `src/flip.ts`, autosave in `src/autosave.ts`) — design spec §AH**
- Opened by `content.ts` after one `GET_SITE_PAGES` round trip (every page of the domain with notes, ordered by first note id, each with its edited name); the list still paints from `GET_PAGE_ITEMS` for the current URL only (which also carries the page's edited name, for the fallback view when `GET_SITE_PAGES` fails — that view says so in its top bar, `EnlargedSite.notice`). Renders inside the sidebar's shadow root; the sidebar's own width animates to `max(0.75·viewport, min(560, viewport), sidebarWidth)` with a scrim over the remaining page. A 68px top bar — the riding logo (at the docked size, settling centred in the bar and as far in, 24px), the tools row (a notice, if any, then **delete all**, right-aligned 20px left of exit), exit (a right-pointing chevron) and a 1px `line` rule on its last row — over a full-width scroller, which has the panel's final width from the first frame.
- Layout (`computeGridLayout`, pure): content column = scroller client width − 2×16 (`PANEL_PAD_X = PANEL_MARGIN`, the top bar's 16px margin); each note's screenshot at its selection's CSS size, never up, down to the column width or the visible height (`maxShotHeightFor`); column `clamp(shot, 267, contentW)`; greedy rows of ≤3 with 32px gaps, each row centred; each note is one group — bar (28px, "#n" + delete centred over the image), screenshot, text area (267×96, fixed) — centred on its image and vertically centred in its row, so bars and text areas follow their own image; headings 62px (40 name line + 2 + 20 address line); gaps 16 / 40 / 64. `scrollTopFor` shows the last 40px (`OPEN_PEEK_PX`) of the row before the opened note's under the top bar — for a page's first note the previous page's last row, the heading whole below it; the site's first row opens at the top; a window too short for that and the note's text area scrolls the text area whole into view instead. Every heading and every part of every note (header, screenshot, editor) is absolutely positioned in content coordinates.
- Motion: list thumbnails visible in the list's scrollport — wholly or in part, a cut one's clone clipped by an eased `clip-path` inset (`morphKeyframes`' `clip`) — morph into the grid as clones in a front layer (sampled transform-only keyframes with a counter-transformed media box, as before) and back on collapse; the rest fades in bands. A delete re-packs and FLIPs every part on or within 200px of the screen from its live offset (the rest are placed at once) (an analytic record per part), folding any scroll clamp into the start offsets. Timing table `T` (expand 450, collapse 340, move 400, autosave 700, …).
- Full images via `GET_IMAGE`, lazily (`src/fullImageLoader.ts`: IntersectionObserver on the scroller, 800px margin; everything without one). The shared-element clones and their morphs are `src/cloneLayer.ts`; the view decides which notes travel, from where, to where and when. A rename a collapse committed that comes back failed is said in the sidebar's banner. Autosave through `AutosaveController`, now with one debounce timer per id (dirty = differs from stored and in-flight, superseded replies dropped, failures retried on flush); empty notes are never savable, say "note required" at once and block every user exit (FR-EV-8). Page renames go through `SET_PAGE_TITLE`, stored in the index's `meta.pageTitles`. The top bar's delete all asks in place ("confirm?", yes / cancel) and, confirmed, calls `onDeleteAll` (`siteActions.deleteAllConfirmed`: the same `DELETE_DOMAIN_DATA`, no menu question), dropping debounced edits first; on success the view empties its model and collapses onto the empty list (nothing to morph to), on failure it says so in the top bar. It counts as a pending delete, so a collapse asked for meanwhile waits.
- Scroll lock (FR-EV-9): capture-phase `wheel`/`touchmove` with `{ passive: false }` and the keys through the key router at `SCROLL_LOCK` (before the view's own isolation), taken in `open()` and released in `finish()`, the one teardown every exit path routes through. The exemption test is "an element before the host in the composed path can really take this delta" — the view's scroller and text areas — not "the path contains our host", which would exempt the whole viewport once the scrim covers it.

**Key router (`src/keyRouter.ts`)** — the one owner of salamander's capture-phase key listeners on `window`: one listener per key type (on with the first handler, off with the last), handlers run by named priority — `TOOLTIP_ESC`, `GLOBAL_ESC_AND_SHORTCUT`, `SCROLL_LOCK`, `ENLARGED_ISOLATION`, `ADDMODE_ISOLATION`, `SIDEBAR_ISOLATION`, `PLACING_ISOLATION` — and a handler returning `'stop'` stops the key once. No module depends on the order it registered in.

**Keyboard isolation (`src/keyboardIsolation.ts`)** — a key-router handler for `keydown`/`keyup`/`keypress` that stops (never `preventDefault()`s) events whose `composedPath()` includes the host, at its surface's priority; installed while the sidebar is shown, while the enlarged view is open and once add mode's box is placed. Reason: closed shadow roots hide the focused element from a site's `document`-level shortcut handlers (Gmail's "c", Instagram's "n"), which then fire and `preventDefault()` the keystroke. From `window`, `composedPath()` stops at a closed root's host; `src/dom.ts`'s `keyTargetWithin` / `pointTargetWithin` recover the real inner target (the root's focused element for a key, the element under the pointer for a wheel or touch), for the enlarged view's Enter/Space handling and its scroll lock.

**Tooltip (`src/tooltip.ts`, design spec §AG)** — one `.sal-tip` and one set of delegated listeners per shadow root (`attachTooltips`: the sidebar's, which the enlarged view shares, and add mode's). Its Esc listener is a key-router handler at `TOOLTIP_ESC`, ahead of every isolation, because keyboard isolation stops every in-host key at window capture. `scroll` is not composed, so it listens on the root as well as the window. While one is open, a `MutationObserver` on the root (subtree; `childList` and the `hidden`/`inert`/`data-tip`/`data-tip-reason`/`aria-disabled` attributes — never `style`, which the motion code writes every frame) hides it when its control is removed, hidden, made inert or given different text. A `transitionend` on the root re-places an open tooltip when the transition ended on its control or an ancestor, so a reason shown on focus the moment a menu opens is measured again at the menu's final, unscaled size.
- Placement: above by default, below when there is no room. `data-tip-side="left"` goes to the left of the nearest `[data-tip-edge]` ancestor (the sidebar's "more options" menu; add mode's pencil menu) or of the control itself; with no room there, to the right of that same edge, then above.
- Soft-disabled controls: `isSoftDisabled` / `setSoftDisabled` are the one reader and writer of `aria-disabled="true"` (set, or removed — never `"false"`), used by the sidebar and add mode. `setSoftDisabled` returns whether the state changed; callers then hide their tooltip synchronously (`hide()`), rather than waiting for the observer's microtask.

**Theme and fonts (`src/theme.ts`)** — dark only (design spec §AA): `getThemeCSS()` emits `DARK_THEME` as `--sal-*` custom properties on `:host`; `LIGHT_THEME` is kept, unused, so a light theme can return without re-deriving a palette (a test pins that the two tables share the same keys). Fonts are fetched from `chrome.runtime.getURL('fonts/…')` and registered with `FontFace` under `Salamander Serif` / `Sans` / `Mono`, once, silently falling back to the system stack.

---

## Export and import

**Export (`src/export.ts`)** — in the service worker: read the domain (through the queue: the loader is a required parameter) → `buildFeedbackMarkdown` → per item `imageStore.getImage`, composited with `paintDrawing` on an `OffscreenCanvas` when the item has strokes (scale measured as image px / drawing CSS px, a failed composite falls back to the clean PNG, a missing blob skips the file — which leaves a bundle its own importer rejects; what to do instead is an open owner decision) → `zipSync` (level 6) → data URL → `chrome.downloads.download({ saveAs: false })`. The header's clock and manifest version are injectable so a test can pin the bytes. Scaling limit: the data URL holds about 2.4 times the zip in memory at its peak.

**Bundle format (`src/bundle/`)** — `version.ts` owns the line-1 stamp (`<!-- salamander-feedback-format: 3 -->`, BOM/whitespace tolerant); `index.ts` dispatches the reader on it (each `case` names the codec's own version constant) and refuses any other with `UnsupportedFormatError`; `v3.ts` is the grammar, the `JsonFeedbackItem` record (keys in §AC order), the writer, the reader and its `FieldReader` type checks. The writer numbers each `### note n` heading by the note's position on its page and names the screenshot by id; the reader hands back `{ number, item }` entries so the importer can check for a repeated number within a page while the item itself carries only the id. `text` is derived from `html` at export (tags stripped, entities decoded) and ignored on read. `context.pageMeta` is not written — only `page_title`, which `export.ts` (`pagesWithEditedTitles`) sets to a renamed page's name — and import rebuilds it from the item fields. A future format is a new `vN.ts`, a `FORMAT_VERSION` bump, a `case` and a new frozen fixture.

**Why one Markdown file with JSON inside:** it is both what a person or agent reads and what import reads back, with no second file and no YAML dependency. Pretty-printed JSON can never contain a line that is exactly ` ``` `, so a note (free user text) cannot end the block early; the reader takes each item's block by its id, preferring the block whose note renders to exactly the lines above it, so a note that quotes an exported item is skipped whole.

**Import (`src/import.ts`)** — in the content script (the `File` lives in the page's world; validation needs no storage): the §5 ladder in order (type → `unzipSync` → `feedback.md` present → format stamp → structure/fields → screenshots present → duplicates (the same id twice anywhere, or the same heading number twice under one page) → domain), each check a full pass over every item before the next; then `src/siteActions.ts` stages each screenshot (`IMPORT_STAGE_IMAGE`) and commits the notes (`IMPORT_COMMIT`). Any replace of existing notes was already confirmed when **import** was chosen: `content.ts` read the count (`GET_DOMAIN_ITEM_COUNT`) and, with notes present, asked through the menu itself (`sidebar.confirmInMenu`, spec §AF — not `window.confirm`, whose title Chrome sets to the page's origin) before opening the picker with the PNG bytes re-encoded as data URLs.

---

## File inventory

| File | Role |
|---|---|
| `src/background.ts` | Service worker: injection, capture relay + crop, handler table, storage ownership, import staging |
| `src/content.ts` | Content script entry: the guard and teardown, message listener, list refresh, enlarged-view wiring |
| `src/addModeControl.ts` | The "add note" state machine on injected deps |
| `src/siteActions.ts` | Export, import, delete-all, the list's delete, the site's counts |
| `src/navigation.ts` | SPA navigation detection, debounce, restore |
| `src/sidebar.ts` | Sidebar shell: building and wiring the panel, add group, availability and hold, list host, enlarged-view host |
| `src/pageResize.ts` | The page shrink: `<html>`'s margin, the backstop sheet, the observer |
| `src/sidebarWidth.ts` | The width store, persisted |
| `src/sidebarMetrics.ts` | The sidebar's layout and motion numbers |
| `src/actionMenu.ts` | The "more options" menu and its confirmation |
| `src/notifications.ts` | The sidebar's banner |
| `src/enlargedView.ts` | Enlarged view: the whole-site page's DOM, FLIP choreography, per-note autosave, empty-note lock, the top bar's delete all, keyboard |
| `src/cloneLayer.ts` | Its shared-element clones |
| `src/fullImageLoader.ts` | Its lazy full-resolution images |
| `src/enlargedLayout.ts` | Its pure geometry: note sizes, row packing, the opening scroll, address ellipsis |
| `src/pageHeading.ts` | A page's heading in it, and its rename |
| `src/scrollLock.ts` | The host page's scroll lock while it is open |
| `src/addMode.ts` | Selection box, zones, scrim, outline, comment box, preview + hint, the pencil |
| `src/addModeMetrics.ts` | Add mode's numbers shared with its stylesheet |
| `src/styles/*.css.ts` | The stylesheets: sidebar, add mode, enlarged view, tooltip |
| `src/keyRouter.ts` | The one owner of capture-phase key listeners, by priority |
| `src/keyboardIsolation.ts` | Key isolation of a closed shadow host |
| `src/tooltip.ts` | The shared tooltip |
| `src/thumbnails.ts` | Note list items |
| `src/dockMotion.ts` | Dock-style spring magnification |
| `src/flip.ts` | Analytic tweens, morph keyframes, WAAPI wrappers |
| `src/autosave.ts` | `AutosaveController` |
| `src/capture.ts` | Capture pipeline (content-script half) |
| `src/contextCapture.ts` | DOM context extraction and the 2KB governor |
| `src/selectorBuilder.ts` | CSS selector + XPath generation |
| `src/wordlist.ts` | Dictionary for the "human-authored id" heuristic |
| `src/drawing.ts` | Pen palette, `cropDrawing`, SVG and canvas renderers |
| `src/messages.ts` | Typed message contract, `MessageMap`, handler types |
| `src/rpc.ts` | The typed `send()`, and the dead-context hook |
| `src/storage.ts` | `chrome.storage.local` layout, domain/item CRUD, session state, pen colour, the Option/Alt+N tip's counts |
| `src/imageStore.ts` | IndexedDB wrapper |
| `src/export.ts` | Zip assembly, drawing composite, download |
| `src/import.ts` | Import validation ladder |
| `src/bundle/` | feedback.md format: the stamp (`version.ts`), dispatch (`index.ts`), format 3 (`v3.ts`) |
| `src/theme.ts` | Tokens (dark emitted, light parked), radii, font loading |
| `src/copy.ts` | Every user-facing string |
| `src/icons.ts` | The stroke icon set and the pencil cursor |
| `src/shortcut.ts` | The Option/Alt+N shortcut and its keycap label |
| `src/addNoteTip.ts` | When the Option/Alt+N tip shows (pure; the counts are the service worker's) |
| `src/dataUrl.ts` | data-URL ↔ bytes/Blob (CSP-safe, no `fetch`) |
| `src/dom.ts` | `getContentViewportSize`, reduced-motion query, safe rAF, closed-root event targets |
| `src/urlNorm.ts` | URL/domain normalisation, export filename |
| `src/types.ts` | Data model, `ItemPatch`, import error codes |
| `build/stripCssComments.js` | Strips the stylesheets' CSS comments (esbuild plugin and jest transform) |
| `scripts/unused-exports.js` | `npm run lint:exports`: exports nothing else imports (report-only) |

(Line counts are left out on purpose: they went stale with every change. `wc -l src/**/*.ts` gives them.)

---

## Key decisions

- **Screenshots instead of live pins.** Re-resolving a pinned element after the page changed was fragile (see `docs/v1-archive/`). A screenshot plus context is a stable artefact; nothing is ever re-located.
- **A sidebar that shrinks the page.** An overlay hides content; a shrink keeps everything reachable and means the sidebar can never be inside a capture.
- **Closed shadow roots + keyboard isolation + event-level scroll lock.** Each exists because a real site broke without it (page CSS bleed, Gmail/Instagram shortcuts, the width shift `overflow: hidden` causes). Do not replace them with the simpler alternative.
- **The crop scale is measured, not assumed.** `innerWidth` is an integer and the captured image is not guaranteed to be `innerWidth × devicePixelRatio`; dividing real by reported is self-correcting, and sending both viewport widths resolves the scrollbar ambiguity.
- **Ids allocated in the service worker, preserved on import; numbers derived at render.** The id is sequential across a domain's URLs, never reused, and is the storage key and the export's screenshot filename; the counter lives behind the storage boundary. The number a note is shown under is its 1-based position in its page's list, computed by each renderer (list, enlarged view, export) from the same `pages[url]` array — nothing stores it, so nothing migrates, and deleting a note renumbers the ones after it.
- **Drawing as a separate layer, flattened only at export.** The stored screenshot stays clean and the bundle format does not change; the alt text is the only trace in `feedback.md`.
- **Replace-only import, format 3 only.** No merge logic, no ID collision handling, no legacy codecs — 2.0/2.1's format-2 exports are refused by decision.
- **Dark only.** The switcher, `themeMode` and cross-tab sync were removed (design spec §AA); the light table is parked in `theme.ts`.
