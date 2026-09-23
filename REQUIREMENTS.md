# Salamander — Requirements

> Chrome extension for capturing visual feedback on any webpage. The reviewer selects an area of the page, optionally draws on it, writes a note; the extension screenshots the area and records where in the DOM it was. Feedback is exported as a bundle (screenshots + one human/agent-readable `feedback.md`) that a developer or an AI coding agent can act on without the live page.

**Status:** describes the behaviour of the shipped code (version 2.0.0). The code is the source of truth; where this file and the code disagree, this file is wrong. Design rationale lives in `design/SALAMANDER_SPEC.md` (visual, section references like §AB below) and `design/MOTION_SPEC.md`; implementation detail in `TECH_DESIGN.md`. Every requirement has a stable ID (`FR-…` functional, `NF-…` non-functional, `E-…` error cases, `EC-…` edge cases).

---

## Definitions

- **Sidebar** — the extension's panel, docked to the right edge of the viewport. It shrinks the page rather than floating over it. Opened by clicking the extension icon.
- **Add mode** — the state entered from the sidebar's **add note** button, during which the page is a selection surface and all other page interaction is suppressed. Two phases: *placing* (no box yet) and *editing* (a box, its drawing surface and the comment box exist).
- **Feedback item** (a "note") — one captured unit: a cropped screenshot + note text + captured DOM/page context + an optional drawing. Items never leave a marker on the live page; they exist only as sidebar thumbnails and export data.
- **Bundle** — the export/import unit: a `.zip` holding `screenshots/{id}.png` and a single `feedback.md` that is both the readable document and what import parses. There is no separate machine-only file.
- **Domain** — `location.host` normalised (`www.` and standard ports stripped). Storage, item ids and export are per domain; the list — and the numbers it shows — is per normalised URL within it.

---

## 1. Functional requirements

### 1.1 Sidebar and activation

- **FR-SB-1** Clicking the extension icon injects the content script on demand and opens the sidebar; clicking again while it is open closes it (a toggle). No automatic injection on any page.
- **FR-SB-2** The sidebar is docked to the right edge and **shrinks the page** (`margin-right` on `<html>`, `!important`, defended by an injected stylesheet and a `MutationObserver`, with a synthetic `resize` event after every apply). It never covers page content, except on app-shell sites that ignore a root shrink (EC-13).
- **FR-SB-3** Width is user-resizable by a handle on its left edge: 188–300px, default 300. The minimum is derived from the action row's own metrics (the width it needs with the "keep on" switch revealed), not hardcoded. The handle takes the pointer and the keyboard (arrow keys in 10px steps, `Home` = widest, `End` = narrowest). The chosen width persists in `chrome.storage.local` (`sidebarWidth`) and is clamped into range on load. Page shrink, add-mode selection bounds and the enlarged view's geometry all track the live width.
- **FR-SB-4** Below 220px the wordmark hides. Nothing else responds to width: both action-row groups always sit on one row with nothing clipped, and the switch's reveal is never suppressed by width.
- **FR-SB-5** Layout, top to bottom: a header (logo + "salamander" wordmark + **close**), an action row (the **add note** group and the **export** group, see FR-SB-8), one 1px rule under that block, then a "this page (n)" heading and the note list for the current URL, or the empty state "no feedback on this page yet". The heading and the empty state never show together.
- **FR-SB-6** Notification banners (error/warning) render inline under the action row with `role="alert"`, an icon, lowercase text and a progress line; they auto-clear after 8 seconds.
- **FR-SB-7** **close** hides the sidebar and restores the page. The content script stays loaded; data is untouched. Closing while add mode is active exits add mode first; closing while the enlarged view holds an emptied note is refused (FR-EV-8).
- **FR-SB-8** The action row's right group is **export** with an attached chevron (`aria-haspopup="menu"`, `aria-expanded`). The chevron opens a `role="menu"` holding one item, **import**. The menu closes on item activation, `Esc` (focus returns to the chevron), Tab, an outside `pointerdown`, the sidebar closing and entering add mode; opening it by keyboard focuses the first item and ↑/↓ move between items.
- **FR-SB-9** The sidebar survives SPA navigation (`pushState`/`replaceState` patched, `popstate`, `hashchange`, debounced 50ms) and full reloads: "open" is recorded per tab in `chrome.storage.session` (`sidebarOpen:{tabId}`) and the service worker re-injects and re-opens on the next completed load. Only **close** (or a tab close, a browser restart, or navigating to a page that cannot be injected) clears it. On an SPA route change the list refreshes for the new URL, add mode exits fully and the enlarged view collapses.
- **FR-SB-10** Everything the extension draws lives in closed shadow roots on hosts attached to `<html>` (`#annotator-sidebar-host`, `#annotator-addmode-host`), above the page (`z-index` near the maximum).

### 1.2 Add mode — placing and editing a selection

- **FR-AM-1** **add note** is an icon-only toggle button (`aria-pressed`). Clicking it starts add mode; clicking again cancels it. Its tooltip says what a click will do next ("add note" / "cancel note" / "stop adding notes"); its accessible name is always "add note".
- **FR-AM-2** A **"keep add mode on" switch** (`role="switch"`, `aria-checked`) is attached to the button's right, hidden at rest and revealed on hover or keyboard focus (`:has(:focus-visible)`, not a mouse click's focus), always visible while on, and always visible on hover-less pointers. Switch on: add mode starts if it isn't running and re-enters after every successful capture and every per-note cancel. Switch off mid-session: add mode continues for the current note only. A click on the button while the switch is on stops both. `Esc` stops both. The switch is never persisted; it resets per page session. Double-click, shift+click and shift+Enter/Space on the button turn the switch on (alternates, not the only path).
- **FR-AM-3** While placing, the cursor is a crosshair and a preview of the default box follows the pointer (fading in on the first move, hidden while dragging, gone once a box is placed). A tooltip "click or drag to select" follows the cursor for the first 5 seconds of a page session's first add-mode use, then never again on that page load.
- **FR-AM-4** A single click places a 267×100px box (the thumbnail's size at the default sidebar width — fixed, independent of the current width) **centred** on the click point, shifted (never shrunk) fully on-screen if centring would leave the viewport. A press-and-drag of 5px or more draws a custom rectangle instead, normalised for any drag direction and live-updated.
- **FR-AM-5** The box resizes from any edge or corner through invisible hit zones (edges 10px thick straddling the outline, corners 16×16) with `ns`/`ew`/`nwse`/`nesw` cursors. No visible handles. Minimum size 20×20px. The box is clamped to the content viewport (scrollbars excluded, sidebar excluded) — no auto-scroll, no stitching.
- **FR-AM-6** The outline is a 2px SVG stroke just outside the box, alternating 4px accent yellow and 4px ink, following the box's 10px corner radius; the page outside the box is dimmed by a scrim, the box interior is clear.
- **FR-AM-7** A comment box (296px wide) attaches below the box and flips above or to the side when there is no room. It holds a textarea (placeholder "what should change here?", `maxlength` 1000), a bottom bar with the pencil tools on the left (FR-DR-4) and, on the right, a counter (hidden up to 900 characters, muted from 901, danger-coloured from 980, format "942/1000"), then **cancel** and **save**. **save** is disabled while the trimmed note is empty and reads "saving…" during the capture.
- **FR-AM-8** Only **cancel** or **save** leave the editing state. Clicking outside the box and comment box does nothing at all. `Esc` exits add mode (with an open pencil menu, the first `Esc` only closes the menu). Native page clicks, links and keyboard shortcuts are suppressed for the whole of add mode (NF-ISO-1, NF-ISO-2).
- **FR-AM-9** While add mode is active the sidebar is **on hold**: the note list dims to ~50%, takes no pointer or keyboard input (no hover, no magnification, not tabbable, no click-to-open, delete buttons inert) and the export group is disabled with its menu closed. **add note**, its switch and **close** stay enabled. Every exit path restores the list.
- **FR-AM-10** Opening a note from the list while the comment box holds text or strokes is refused with the warning "finish or cancel your note first."; otherwise opening a note exits add mode first.

### 1.3 Drawing on the selection (design spec §AB)

- **FR-DR-1** Once a box is placed and until the note is saved or cancelled, the box's interior is a **pencil** (custom SVG cursor, hotspot at the tip; system fallback). The edge/corner zones keep their resize cursors and resize; outside the box the cursor is the normal arrow. There is no pencil while placing, during capture, or in the enlarged view.
- **FR-DR-2** Pointer strokes draw 2px round-capped, round-joined lines (coalesced pointer samples, so fast strokes stay smooth). A single click leaves a dot. Colours: yellow `#E8B600` (default), black `#1A1712`, red `#E5484D`; each stroke stores its own HEX.
- **FR-DR-3** The chosen colour is remembered until the browser closes — across reloads, pages and sites — in `chrome.storage.session` behind the service worker (`GET_PEN_COLOR` / `SET_PEN_COLOR`), re-read on every add-mode entry; a fresh browser session starts on yellow.
- **FR-DR-4** The comment box's bottom bar holds, left to right: a 28px **pencil** menu button (`aria-label` "drawing options", `aria-haspopup="menu"`) whose menu contains **erase all** (disabled while nothing is drawn; the menu opens above the button when there is no room below), then three swatches as a radio group named "pencil colour" (arrow keys move and wrap).
- **FR-DR-5** Strokes are pinned to the page, not the box: resizing never moves them; shrinking crops what falls outside, growing reveals it again. On save the strokes are cropped to the final rectangle (a stroke that leaves and re-enters becomes two).
- **FR-DR-6** `Cmd+Z` / `Ctrl+Z` undoes the last stroke whenever focus is not in the textarea (there it keeps undoing typed text). Starting a stroke moves focus to the drawing surface; clicking the textarea returns it. The page never sees the keystroke.
- **FR-DR-7** Strokes count as unfinished work (FR-AM-10). The drawing is hidden with the rest of the overlay for the capture: the stored screenshot never contains it.
- **FR-DR-8** The drawing is stored separately on the item as `drawing: { width, height, strokes: [{ color, points: [x, y][] }] }` — the final selection's CSS-pixel size, points relative to its top-left. An item nothing was drawn on has no `drawing` field.
- **FR-DR-9** A saved drawing is shown, view-only, over the list thumbnail and over the enlarged view's main image and peeks, fitted exactly as the image is (`viewBox` + `xMidYMid meet` against `object-fit: contain`) and riding the morphs. Drawings cannot be edited after saving.

### 1.4 Capture

- **FR-CP-1** On **save**: DOM context is captured first (FR-CX), then the whole add-mode overlay (box, outline, zones, scrim, drawing, comment box, hint) is hidden, the pipeline waits for one painted frame (double `requestAnimationFrame`, 250ms fallback), then asks the service worker for a screenshot cropped to the selection, then to persist the item. The sidebar needs no hiding: it shrinks the page and so never lies inside a selection; its dock magnification is suspended for the whole of add mode so a magnified note cannot bleed into a capture.
- **FR-CP-2** The screenshot is `chrome.tabs.captureVisibleTab` (PNG) cropped in the service worker with `createImageBitmap` + `OffscreenCanvas`. The crop scale is **measured** from the captured image's real dimensions against the two CSS viewport widths the content script sends (with and without scrollbars), choosing the candidate nearest `devicePixelRatio`; the selection rect is viewport-relative CSS pixels, so scroll position never enters the crop. The stored PNG is at native device pixels (DPR and browser zoom included), never downscaled.
- **FR-CP-3** Captures are spaced at least 500ms apart by a serial queue in the service worker so the platform's rate limit is never hit; a burst waits rather than failing.
- **FR-CP-4** Each item gets an internal id, allocated by the service worker at write time, sequential across all URLs of the domain and never reused after a delete (`nextItemNumber` only grows). The id is the storage key and the export's screenshot filename; it is never shown. The **number** the user sees — the list badge, the enlarged view's "feedback #n", the `### feedback n` heading in `feedback.md` — is the item's 1-based position in its page's list, recomputed on every render and never stored: deleting an item renumbers every item after it, a page emptied and captured on again starts at 1, and every page has its own #1. Two tabs open on the same page can show stale numbers until one refreshes, exactly as the list itself is stale then.
- **FR-CP-5** The service worker also renders an inline JPEG thumbnail (longest edge 480px, quality 0.75) stored on the item record, so the list paints without touching IndexedDB. The full PNG lives in IndexedDB under a random key.
- **FR-CP-6** On success add mode exits (or re-enters, FR-AM-2), the sidebar comes off hold, and the new item appears at the bottom of the list. On any failure (context capture, rate limit, restricted page, storage write) no partial item exists, a blob already written is deleted, the overlay is restored, add mode stays exactly as the user left it, and the sidebar shows E-8.

### 1.5 Context capture ("fingerprint for explanation")

Captured once, at save time, so a reader of `feedback.md` can locate the selected UI in source without the live page. Nothing is ever re-resolved against a live page.

- **FR-CX-1** **Primary target**: the deepest element that fully contains the selection rectangle (walking down from `<body>`, one fully-containing child per level; `<iframe>` is always a leaf; `<script>`/`<style>`/`<template>`/`<noscript>` are never entered; hidden elements are skipped). Recorded as a CSS selector (see `FINGERPRINTING.md`), an XPath, and a sanitised `outerHTML` snippet (`<script>`/`<style>` bodies and base64 data-URIs stripped) capped at 1KB with a visible `...[truncated]` marker.
- **FR-CX-2** **Contained elements**: up to 15 descendants of the primary target whose rect intersects the selection, scored (id > key attributes > direct text > semantic class name), ties in document order. Each carries tag, id, classes split into semantic vs generated, key attributes (`data-*`, `aria-*`, `role`, `href`, `alt`, `name`, `type`, `placeholder`) and its direct text (≤100 characters).
- **FR-CX-3** **Area text**: the direct text of the primary target and every contained element, in document order, adjacent duplicates collapsed, joined into one line.
- **FR-CX-4** **Page metadata**: full URL, normalised URL, page title, viewport size, device pixel ratio, the selection rectangle in page coordinates, and an ISO 8601 capture time.
- **FR-CX-5** **Size governance**: the whole context is held under 2KB (measured as JSON length). Over budget, the `outerHTML` snippet shrinks first (always leaving the marker), then the contained-elements list is trimmed from its lowest-priority end, with a `containedElementsTruncated` flag.
- **FR-CX-6** Iframes (cross-origin or not) contribute only their own tag and attributes; their documents are never inspected. No computed styles are captured.

### 1.6 Viewing and managing notes

- **FR-LS-1** The list shows only items whose normalised URL matches the current page, in capture order (newest at the bottom). Each item is a real `<button>` holding the thumbnail (a 100px-tall box, image `object-fit: contain`, never cropped), a number badge at its top-left (the item's position in this list, FR-CP-4), the drawing overlay if any, and the note text below clamped to 3 lines ("no note" when empty).
- **FR-LS-2** Items magnify under the pointer and under keyboard focus in a continuous, macOS-Dock-style spring (up to 1.12× scale and 22px leftwards, out over the page), with the note text gaining a background that tucks under the thumbnail. Under `prefers-reduced-motion` only the background appears.
- **FR-LS-3** Hovering or focusing an item reveals a 28px delete button over the thumbnail's top-right corner — a sibling of the item's button, never nested inside it — which deletes immediately with no confirmation (E-12 on failure) and never opens the note. It is reachable by Tab after its item.
- **FR-LS-4** Clicking an item opens the **enlarged view**: the sidebar itself expands leftwards to 75% of the viewport (never narrower than 560px or the docked width), with a scrim over the rest of the page and no page re-layout. Shared elements morph (the thumbnail into the large image, its neighbours into peeks); everything else fades (`design/MOTION_SPEC.md`). Under reduced motion, layout changes instantly with crossfades only.
- **FR-EV-1** The focused note is one block — a title bar ("feedback #n", n being the note's position on the page per FR-CP-4, with a 32px **delete** icon button at its right end), the screenshot at the selection's own CSS size (scaled down to fit, never up), and the note textarea — centred in the panel both ways. The previous and next notes peek ~20px past the top and bottom edges, each at 0.75 of its own natural size, pushed right along one shared arc; clicking a peek navigates to it; hovering nudges it 7px.
- **FR-EV-2** A rail of three 36px buttons — **exit** (a collapse-panel glyph, "exit enlarged view (esc)"), **↑**, **↓** — sits 20px in from the viewport's right edge, vertically centred, independent of the image's size; ↑/↓ are disabled at the ends.
- **FR-EV-3** Keyboard: focus moves to **exit** on open; `Esc` collapses; ↑/↓ navigate when focus is not in the textarea; Tab cycles exit → ↑ → ↓ → peeks → textarea → delete. On collapse, focus returns to the note's list item (or a fallback in the sidebar when it no longer exists).
- **FR-EV-4** The note autosaves: 700ms after typing stops, and immediately (flushed) on navigate, collapse, blur, sidebar close and page unload. There is no save button and no "saved" confirmation. A failed save shows "couldn't save note. try again." as plain left-aligned text under the textarea (`role="status"`, `aria-live="polite"`) and is retried on the next flush; a failure that is still unresolved when the view collapses is reported in the sidebar's banner naming the note.
- **FR-EV-5** Prev/next run as an interruptible carousel of the same morphs; a second ↓ mid-flight retargets from the live position rather than being dropped.
- **FR-EV-6** **delete** is immediate, with no confirmation, from either entry point, and removes both the record and its screenshot blob. In the enlarged view it moves on to the next note (or the previous if it was last); deleting the only note collapses to the (empty) list.
- **FR-EV-7** While the view is open the host page cannot scroll: capture-phase `wheel`/`touchmove`/scroll-key handlers cancel any scroll no element inside the view can take (the textarea still scrolls). `overflow: hidden` is deliberately not used (it would change the page's width and move the rects the morph measures). The lock is released on every exit path — collapse, `Esc`, the scrim, sidebar close, SPA navigation, entering add mode, teardown.
- **FR-EV-8** **A note can never be empty.** An emptied note is never saved (the last text stays stored), and leaving it — ↑/↓, peeks, exit, `Esc`, the scrim, closing the sidebar — is refused with "a note can't be empty. add some text to continue." and a danger-coloured textarea border (one small shake on the first refusal, never under reduced motion) until text is entered. Deleting is still allowed.
- **FR-EV-9** The enlarged view and add mode never coexist: entering add mode collapses the view instantly (no half-collapse frame); the view also collapses on SPA navigation.
- **FR-LS-5** Nothing is ever placed on the live page for a saved note. The list and the bundle are the whole record.

### 1.7 Export

- **FR-EX-1** **export** downloads a `.zip` with every item across **every URL of the current domain**, assembled and downloaded entirely in the service worker (`chrome.downloads`, no save-as prompt). The button is disabled for the duration of the round trip.
- **FR-EX-2** With no items on the domain: `alert("nothing to export")` and no download. Any other failure shows "couldn't export feedback. try again." in the banner.
- **FR-EX-3** Filename `feedback-{domain}-{YYYY-MM-DD}.zip`, dots and colons in the domain replaced with underscores, the date taken from the UTC calendar day (e.g. `feedback-example_com-2026-09-22.zip`, `feedback-localhost_3000-…`).
- **FR-EX-4** Bundle contents, and nothing else: `screenshots/{id}.png` per item, and `feedback.md`. An item with a drawing has its strokes painted into its PNG at the image's real pixel scale (a 2× capture gets a 4px line); an item without one is exported byte-for-byte as stored. A blob missing from storage is skipped (the note and its data still export); a failed composite falls back to the clean PNG.
- **FR-EX-5** `feedback.md` is **format 2** (design spec §AC, frozen fixture `src/__tests__/fixtures/feedback-v2.md`). Every fixed label is lowercase; user content is written as captured:
  - line 1: `<!-- salamander-feedback-format: 2 -->` (the format stamp, distinct from the extension version);
  - a header of three lines joined by trailing `\`: `salamander {manifest version}`, `**date exported:** YYYY-MM-DD HH:MM utc±hh:mm` (local time), `**website:** {domain}`;
  - `## page "{normalised url}"` per URL, pages in order of their first-captured item, notes in the page's list order (capture order — the same order and numbers the sidebar shows);
  - per note: `### feedback {n}`, `![feedback {n}](screenshots/{id}.png)` (alt text gains ` — marked up by the reviewer` when the note has a drawing), `**note:** {text}` as written (`(none)` when empty), then `<details><summary>element data</summary>` around a pretty-printed ` ```json ` record. `{n}` is the note's position on its page, counting from 1 on every page (FR-CP-4); `{id}` is the internal id, unique across the domain, so screenshot files never collide between pages;
  - the JSON is the complete item and the only thing import reads, keys in this order: `text` (the primary target's visible text, derived from `html` at export), `selector`, `xpath`, `html`, `page_url`, `note`, `id` (the internal id — the display number is the heading, not a field), `normalised_url`, `page_title`, `created_at`, `selection_rect`, `viewport`, `dpr`, `contained_elements`, `area_text`. No field appears twice.
  - Free-text values are capped and end in a single `…` past the limit — `text` 120, `html` 300, `area_text` 200, each contained element's `text` and attribute values 80. The note and every identifier (selector, xpath, URLs, ids, class names) are never cut.

### 1.8 Import

- **FR-IM-1** **import** (in the chevron menu) opens the native file picker accepting `.zip`. The menu item is disabled for the duration.
- **FR-IM-2** The content script unzips and validates the bundle through the ladder in §5, in that order, before anything is written; only the final replace goes to the service worker.
- **FR-IM-3** Only format 2 is read. A `feedback.md` with any other stamp, or none (including the retired v1 YAML format), is refused (E-6). The extension was never published with another format, so there is no backward compatibility.
- **FR-IM-4** The bundle's domain (from its first item's `page_url`) must match the current domain (E-5). An empty bundle is treated as matching.
- **FR-IM-5** Import **replaces** the domain's data; there is no merge. If the domain already has items, a native confirmation quotes the real count (E-10) before anything changes; cancelling leaves everything as it was. If the count cannot be read, the import stops with "couldn't check existing feedback. try again." rather than replacing unconfirmed.
- **FR-IM-6** Each item is rebuilt from its JSON plus `screenshots/{id}.png`; ids are preserved, `nextItemNumber` becomes max id + 1, and the service worker mints a fresh screenshot key and thumbnail per item. The heading's number is not read back beyond E-11's check: after import a note's number is its position in its page's list again (FR-CP-4). A failure part-way cleans up the blobs written for that import and leaves the previous data intact ("couldn't import this bundle. try again.").
- **FR-IM-7** A round trip (export, wipe, import) reproduces every stored field except values the caps shortened (they come back as written) and a drawing, which comes back flattened into the image. Exporting again produces the same `feedback.md` and the same screenshot files.
- **FR-IM-8** After a successful import the sidebar opens if it was closed, showing the current URL's items.

---

## 2. Non-functional requirements

### Privacy and permissions
- **NF-PR-1** No network requests, analytics or telemetry. All data stays on the device; nothing leaves it except through an explicit export.
- **NF-PR-2** Permissions: `storage`, `scripting`, `tabs`, `unlimitedStorage`, `downloads`; host permission `<all_urls>` (needed to inject on demand into any site). `web_accessible_resources` exposes only the two logo SVGs and the bundled fonts.
- **NF-PR-3** Screenshots capture exactly what is on screen, including form fields. No masking of sensitive inputs (known limitation, EC-12).

### Security / CSP
- **NF-SEC-1** Extension-page CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'`. All dependencies (`fflate`) are bundled by esbuild; nothing loads from a CDN, nothing uses `eval`.
- **NF-SEC-2** Because `connect-src 'none'` also governs `fetch()` of `data:` URLs in the service worker, image bytes are decoded by hand (`src/dataUrl.ts`), never via `fetch(dataUrl)`.
- **NF-SEC-3** Content scripts are never granted `chrome.storage.session` access; session state is reached only through the service worker.

### Storage
- **NF-ST-1** Metadata in `chrome.storage.local`, schema version 2: `domain:{domain}` → `{ meta: { nextItemNumber, version }, pages: { normalisedUrl: id[] } }` and `item:{domain}:{id}` → the item (thumbnail data-URL inline). Full-resolution PNGs in extension-origin IndexedDB (`annotator-images` / `screenshots`), as data-URL strings, keyed by `screenshotKey`. Per-tab "sidebar open" and the pencil colour in `chrome.storage.session`. The `sidebarWidth` preference in `chrome.storage.local`, read directly by the content script.
- **NF-ST-2** Feedback data and blobs are read and written only by the service worker; the content script reaches them over typed `chrome.runtime` messages. Every domain-mutating handler (and every domain read that feeds a user decision) is serialised through one queue, so overlapping writes cannot clobber each other and reads see every write queued before them.
- **NF-ST-3** Deleting an item, replacing a domain and a failed save all remove the blobs they orphan. Data persists until deleted, replaced by an import, or the extension is uninstalled. No cross-device sync.
- **NF-ST-4** `unlimitedStorage` lifts the 10MB `chrome.storage.local` quota; practical limits are I/O and memory, not quota. Every domain index carries a `version` stamp so a future schema change has something to branch on; there is no migration today because no other stored shape was ever released.

### Performance
- **NF-PF-1** The overlay hide → capture → restore window is one painted frame plus the service-worker round trip; nothing of the extension's UI may appear in a capture.
- **NF-PF-2** Add-mode interactions (placing, resizing, drawing) and list magnification run on transforms/opacity in a single rAF loop that stops at rest; layout is read once per gesture, never inside the loop.
- **NF-PF-3** The list paints from one `chrome.storage.local` round trip (index + that URL's items, thumbnails inline); a note autosave rewrites only that item's key.
- **NF-PF-4** Both bundles are minified (sourcemaps kept). The content script is idempotent under repeated injection.

### Isolation from the host page
- **NF-ISO-1** Keyboard: while add mode or the enlarged view is open, capture-phase `window` listeners for `keydown`/`keyup`/`keypress` stop propagation of any event whose composed path includes the extension's host, so a site's global shortcuts (Gmail, Instagram, YouTube) never fire and never `preventDefault()` our keystrokes. `preventDefault()` is never called by the isolation itself, so native text editing still works. Listeners are installed only while a surface is open.
- **NF-ISO-2** Pointer: add mode's blocker swallows page clicks; nothing underneath activates. The enlarged view's scroll lock (FR-EV-7) routes wheel/touch/key scrolling only to elements inside the view that can take it.
- **NF-ISO-3** Styling: closed shadow roots with all tokens declared on `:host`; bundled fonts are registered through the `FontFace` API under namespaced families (`Salamander Serif` / `Sans` / `Mono`) with system fallbacks, because shadow-DOM `@font-face` is ignored and a host page's CSP can block extension font URLs. Font loading fails silently.
- **NF-ISO-4** The extension's own DOM (hosts on `<html>`) is never captured as context: context capture walks from `<body>`.

### Accessibility and keyboard
- **NF-A11Y-1** Every control is a real `<button>` (or `role="switch"` / `role="menu"` / radio group) with an accessible name; state is announced through `aria-pressed` / `aria-checked` / `aria-expanded` / `aria-disabled`, never by renaming the control. Focus is visible only for keyboard focus (`:focus-visible`) with one shared ring style.
- **NF-A11Y-2** Full keyboard operation: the resize handle (arrows/Home/End), the add group, the chevron menu, the pencil menu and swatches, the enlarged view (FR-EV-3), the list (Tab through items and their delete buttons).
- **NF-A11Y-3** `prefers-reduced-motion: reduce` is honoured live in every surface: no spatial motion, crossfades only, magnification off, no shake.
- **NF-A11Y-4** All visible UI text is lowercase (buttons, placeholders, errors, dialogs, empty states). This is a product convention; it is not applied to user content.

### Browser support
- **NF-BR-1** Google Chrome, Manifest V3, desktop, left-to-right documents. The build targets Chrome 100 syntax; the runtime APIs used (`chrome.storage.session`, CSS `:has()`, `OffscreenCanvas` in a service worker) need Chrome 105 or newer. Other Chromium browsers are untested; Firefox/Safari are out of scope.
- **NF-BR-2** Pages where content scripts cannot run (`chrome://`, the Web Store, the PDF viewer, `file://` without permission) are not supported: injection fails and nothing visible happens (E-9).

### Reliability and error handling
- **NF-REL-1** Every user-facing failure has copy in `src/copy.ts`, lowercase, asserted byte-exact by tests (§5). No failure is silent: a dead service worker, an invalidated extension context or a rejected write always surfaces as the relevant banner.
- **NF-REL-2** No operation leaves a partial state: a failed capture creates no item and no blob; a failed import leaves the previous data; a failed autosave keeps the draft and retries; a lost `SIDEBAR_OPENED` only means the sidebar does not auto-reopen after the next reload.
- **NF-REL-3** The message contract (`src/messages.ts`) is typed at both ends; adding a message without a handler, or a handler with the wrong response shape, is a compile error. `UPDATE_NOTE` remains as an alias of `UPDATE_ITEM` so a content script from an older build still alive on a page keeps saving across an extension update.

---

## 3. Text conventions

- **NF-TXT-1** Lowercase everywhere in the UI (NF-A11Y-4). In `feedback.md`, every fixed label is lowercase; notes, URLs and page text are written exactly as captured.

---

## 4. User journeys

**Journey 1 — capture and export.** Click the icon → the sidebar opens → **add note** → click or drag on the page → resize by the edges → optionally draw → type a note → **save** → the overlay hides for a frame, the screenshot and context are stored, a thumbnail appears. Flick "keep add mode on" to capture several in a row. Navigate normally; the sidebar persists, and each page numbers its own notes from 1. **export** → `feedback-{domain}-{date}.zip`.

**Journey 2 — review or import.** A developer opens the same site, opens the sidebar, chevron → **import**, picks the zip; if the site already has notes, confirms the replace. Thumbnails appear per URL as they browse. Alternatively they hand `feedback.md` straight to a coding agent: it is self-contained, with inline screenshot references and the element data per note.

---

## 5. Error handling

| # | Case | Type | Behaviour (copy verbatim) |
|---|------|------|----------|
| E-1 | Import: not a `.zip` | error | "invalid file type. please upload a .zip feedback bundle." |
| E-2 | Import: archive cannot be read | error | "could not read this file — it appears to be corrupted." |
| E-3 | Import: no `feedback.md` in the zip | error | "this doesn't look like a feedback bundle." |
| E-6 | Import: `feedback.md` is not format 2 (other stamp, or none) | error | "this bundle was made by a different version of the extension and can't be imported." Checked before E-4b. |
| E-4b | Import: an item's structure or JSON is missing, unparsable, or a field is missing/wrong type | error | "this bundle appears to be corrupted (couldn't read feedback data)." |
| E-4 | Import: an item references a screenshot not in the zip | error | "this file is missing screenshot data and can't be imported." |
| E-11 | Import: the same id twice in the bundle, or the same number twice under one page (the same number on two pages is normal) | error | "this bundle appears to be corrupted (duplicate item ids)." |
| E-5 | Import: domain mismatch | error | "this bundle contains feedback for '{other-domain}', but you're currently on '{current-domain}'." |
| E-10 | Import: the domain already has N items | confirmation | "importing will replace your current N feedback item(s) for this site. this cannot be undone. continue?" (native `confirm`) |
| E-10b | Import: the existing count cannot be read | error | "couldn't check existing feedback. try again." — nothing is replaced. |
| E-10c | Import: the replace itself fails | error | "couldn't import this bundle. try again." — previous data intact. |
| E-7 | Export with zero items on the domain | error | `alert("nothing to export")` |
| E-7b | Export fails (zip, download, dead worker) | error | "couldn't export feedback. try again." |
| E-8 | Capture fails (rate limit, restricted page, crop, storage write) | error | "couldn't capture a screenshot here. try again." No item is created. |
| E-9 | Icon clicked on a page where content scripts cannot run | silent | Injection fails; a warning in the service-worker console; no sidebar. Nothing visible changes. |
| E-12 | Delete fails (either entry point) | error | "couldn't delete item. try again." |
| E-13 | Autosave fails | error | "couldn't save note. try again." under the textarea; after collapse, "couldn't save note #{id}. try again." in the banner. |
| E-14 | List cannot be loaded | error | "couldn't load feedback for this page. try again." |
| E-15 | Full image cannot be loaded in the enlarged view | fallback | The on-screen thumbnail is shown instead. |
| E-16 | A note is clicked while add mode holds text or strokes | warning | "finish or cancel your note first." |

Rows E-1 … E-5 are the import ladder, listed in the order they are checked.

---

## 6. Edge cases

| # | Scenario | Behaviour |
|---|----------|----------|
| EC-1 | Selection would extend past the viewport | Clamped to the content viewport; no auto-scroll, no stitching. |
| EC-2 | Extension UI on screen at capture time | The add-mode overlay is hidden for one painted frame; dock magnification is suspended for all of add mode; the enlarged view cannot be open. |
| EC-3 | Accidental tiny selection | 20×20px minimum. |
| EC-4 | High-DPI display | The crop scale is measured from the image; the PNG is at native device pixels. |
| EC-5 | Browser zoom ≠ 100% | Folded into `devicePixelRatio` by Chrome; handled by the same measured scale. |
| EC-6 | Cross-origin iframe in the selection | Pixels captured normally; context limited to the `<iframe>` element's own attributes. |
| EC-7 | Viewport changed between captures | Items are static images; the stored rect is archival only. |
| EC-8 | Rapid successive captures | Queued 500ms apart; a real failure still reports E-8. |
| EC-9 | Very large selection | The 2KB context governor truncates with visible markers; export caps the free text further. |
| EC-10 | Same URL revisited later | The list shows that normalised URL's stored items. |
| EC-11 | URL normalisation | `https://` scheme; hostname lowercased; `www.` stripped (other subdomains kept); ports 80/443 stripped, others kept; path case preserved; trailing slash stripped; query and fragment stripped. `file://` URLs normalise to their path. |
| EC-12 | Password/sensitive fields in the selection | Captured as shown; no masking. |
| EC-13 | App-shell sites that ignore a root shrink (youtube.com) | Known limitation: containers sized in `vw` units or from `window.innerWidth` keep full width and a page's own `position: fixed` elements never move. The sidebar stays on top and usable, the page reads as partly covered, and closing restores it exactly. Rewriting page stylesheets was rejected as unsafe. |
| EC-14 | Extension reloaded while a page stays open | The orphaned content script's messages return `undefined` and surface as the relevant "try again" banner; a page refresh re-injects. |
| EC-15 | Note text that looks like `feedback.md` structure (headings, fences, a quoted exported item) | The reader takes each item's block by its id, preferring the block whose note renders to exactly the lines above it, so a quoted item is skipped whole. |
| EC-16 | `feedback.md` re-saved by an editor (CRLF, BOM, trailing whitespace on structural lines) | Still reads. |
| EC-17 | Right-to-left documents | The crop assumes the vertical scrollbar is on the right; an RTL page with a scrollbar can be offset by its width (accepted). |

---

## 7. Out of scope

- Editing a drawing, or drawing, after a note is saved; shapes, arrows or text tools.
- Re-cropping or repositioning a saved screenshot (delete and recapture).
- Persistent markers on the live page.
- Auto-scroll + stitch capture beyond the viewport.
- Merging on import.
- Reading bundles from any other format version.
- Cloud sync, backend, real-time collaboration, cross-tab live sync of the sidebar.
- A light theme (the token table is kept in `src/theme.ts`, unused — design spec §AA).
- Mobile and non-Chrome browsers.
