# Testing

How to test salamander after a code change — unit tests, the build, and manual verification in Chrome. `BROWSER_TEST_CASES.md` is the full click-through checklist; this file covers the tooling, the shorter flows and debugging.

---

## unit tests

```bash
npm test                          # full jest run
npx jest sidebar                  # one suite by name
npx jest capture                  # capture geometry and ordering
npx jest contextCapture           # DOM context extraction
npx jest import                   # the §5 validation ladder
npx jest bundle                   # feedback.md: frozen fixture, round trip, reader errors
npx tsc --noEmit                  # type check (strict, noUnusedLocals)
```

**802 tests in 26 suites** (2026-09-22; `npx jest` and `npx tsc --noEmit` both clean):

- `sidebar.test.ts` (117) — open/close, page shrink, URL tracking, resizable width (drag/keyboard, persistence, clamping, the derived 188px minimum), the narrow breakpoint, the add group + "keep on" switch (paint, reveal, gestures, resting width, the tuck, track/knob colours), the export/chevron menu (routes, keyboard, outside pointerdown, per-half hover/press), the one-bordered top block, note padding and hover delete, the "on hold" state
- `addMode.test.ts` (66) — box placement (centred click, clamping, drag-to-draw), edge/corner zones, minimum size, comment box positioning, counter thresholds, save/cancel state, the preview and hint
- `addModeDrawing.test.ts` (49) — the pencil: no surface while placing, the surface exactly over the rect with the zones above it, stroke capture incl. coalesced samples and dots, focus moving off the textarea, strokes pinned through a resize, the cropped `drawing` handed to `onOk`, Cmd/Ctrl+Z vs the textarea's own undo, the pencil menu (erase all, disabled when empty, Esc/Tab/arrows, placement above), the swatch radio group, capture purity end to end
- `drawing.test.ts` (18) — the palette, `cropDrawing` (edge cuts, exit/re-entry splitting, dots, rounding), the SVG builder, the canvas painter's scaling
- `drawingViews.test.ts` (10) — a saved drawing over the list thumbnail and over the enlarged view's main card and peeks
- `enlargedView.test.ts` (82) — open/collapse incl. interrupted transitions, prev/next and the ends, autosave debounce + flush, save failures, the empty-note rule on every exit path, delete (middle/last/only), keyboard, add mode collapsing it, the scroll lock, reduced motion, teardown
- `content.test.ts` (43) — the add-note toggle / switch state machine end to end (gestures, Esc, sidebar close, opening a note), the "on hold" wiring, the list delete round trip, the import flow (replace on an empty domain, the §5 #10 confirmation honoured both ways, a failed count read stops the import, a dead worker stops it, the menu item re-enabled)
- `capture.test.ts` (18) — viewport-relative coordinates, the page-rect conversion, ordering (context before hide, double rAF before `CAPTURE`), failure restores the overlay
- `background.test.ts` (70) — injection and reload re-injection, the handler table, the capture relay and throttle, `computeDeviceRect` across the DPR/zoom/scrollbar/edge matrix, blob cleanup on a failed save, import replace, pen colour validation, a `fetch()` stub that throws (the CSP regression guard)
- `contextCapture.test.ts` (12) — deepest-containing-element selection, contained-element prioritisation and the 15 cap, area text, the 2KB governor's truncation order and markers, iframe leaves
- `selectorBuilder.test.ts` (22) — selector priority ladder, framework-id rejection, class heuristics, XPath
- `storage.test.ts` (31) — domain and item CRUD, the split layout (which keys each operation touches, torn-write tolerance), blob orphan prevention, `nextItemNumber` monotonicity, session state and pen colour
- `thumbnails.test.ts` (17) — list rendering in order, open on click/Enter/Space, the note-preview DOM cap (the 3-line clamp itself is CSS), the sibling delete button firing `onDelete` and never `onOpen`
- `import.test.ts` (16) — the ladder with purpose-built zips: not-a-zip, corrupt archive, missing `feedback.md`, unsupported format (a retired v1 bundle, a newer stamp, no stamp — checked before malformed data), malformed element data, missing screenshot, duplicate ids, domain mismatch, and a round trip
- `bundle.test.ts` (25) — the format-2 writer against generated input (header, page/note order, field order, `(none)`, the free-text caps and their single ellipsis), `formatExportDate`, the derived `text`, the round trip, notes that look like structure or quote a whole item, reader dispatch (v1/newer/unstamped refused), every malformed-file error, and `FORMAT_VERSION === FORMAT_VERSION_V2`
- `bundleV2.test.ts` (8) — the frozen fixture `fixtures/feedback-v2.md`: it decodes to hand-written items and the writer reproduces it byte for byte; the visible note line is ignored on read; CRLF/BOM copies still read; all fixed text is lowercase
- `export.test.ts` (11) — a drawing composited at the image's measured scale, an undrawn item exported byte for byte with no canvas, no drawing data in `feedback.md` (only the alt text), a failed composite falling back, the injectable header, the export → import round trip
- `urlNorm.test.ts` (31) — normalisation rules and `exportFilename`
- `keyboardIsolation.test.ts` (5) — capture-phase isolation of events inside the host; events outside untouched; `preventDefault` never called
- `theme.test.ts` (6) — the parked light table covers the same keys as the dark one; `RADII`; `getThemeCSS` emits only the dark tokens on `:host` (no `data-theme` selector) with the namespaced font stacks; `ensureFontsLoaded` never throws and is idempotent
- `dockMotion.test.ts` (29) — influence/falloff math, spring integration, keyboard-focus magnification, reduced-motion bypass, the shared note-background/delete opacity spring, rAF loop lifecycle
- `dom.test.ts` (7) — `getContentViewportSize`'s fallback and layout case, `reducedMotionQuery`'s three outcomes, the safe rAF fallback and cancel
- `autosave.test.ts` (9) — debounce, in-flight counts as clean, superseded replies dropped, failed saves retried on flush, forget on delete
- `rpc.test.ts` (4) — `send()` never rejects; `undefined` on a dead worker / invalidated context
- `dataUrl.test.ts` (10) — byte-exact codecs, percent-encoded form, >32 KiB chunking, `fetch`-free
- `copy.test.ts` (4) — the §5 copy, byte-exact

**Environment:** jest + ts-jest + jsdom. `src/__tests__/setup.ts` mocks `chrome.storage.local/session`, `chrome.runtime.getManifest` (reads the real `manifest.json`) and installs `fake-indexeddb`; jsdom has no layout, so `offsetWidth`/`offsetHeight` report 100 for any connected element and `CSS.escape` is polyfilled. `src/__tests__/fixtures/feedback-v2.md` is frozen: a writer change that alters it is a format change and needs a new fixture and version.

**Comment policy:** a comment explains a *constraint* or a *rejected alternative* — why the code is the odd shape it is and what broke when it was simpler — never *when* something changed (git has that). The banners in `background.ts` (the measured crop scale), `sidebar.ts` (the page-shrink strategy) and `enlargedView.ts` (the scroll lock's exemption test) are the model.

---

## build and load in chrome

```bash
npm run build          # esbuild → dist/background.js + dist/content.js (minified, sourcemaps)
npm run build:watch    # rebuild on change
```

1. `chrome://extensions` → enable **Developer mode**.
2. First time: **Load unpacked** → the project root (with `manifest.json`).
3. After every rebuild: the reload icon on the extension card.
4. Then refresh the test tab — a content script injected before the reload is orphaned and cannot reach the new service worker (its messages resolve `undefined` and show "try again" banners).

---

## end-to-end (playwright)

```bash
npm run build && npx playwright test
```

Five specs in `tests/` (26 tests: sidebar, capture, thumbnails/enlarged view, export/import, persistence) run headed against a real Chromium with the built extension loaded (`tests/helpers/extension.js`: persistent context, service-worker handle, a local file server for `tests/fixtures/test-page.html` with SPA-style routes, and a patch that forces the extension's closed shadow roots open so plain CSS selectors reach inside). One worker, one retry. Not run in the unit loop.

Known harness limitation (last recorded run, 2026-09-21: 23 passed / 3 failed): the export tests wait for a page-initiated download event, but export downloads through `chrome.downloads` from the service worker, which never raises one. Those three failures are the harness, not the extension — verify export manually.

---

## manual test flows

### Flow 1: capture → thumbnail → enlarged view → export

**Page:** any real site (github.com, wikipedia.org).

1. Click the icon → the sidebar opens on the right; the page is narrower, not covered.
2. Click **add note** (the group turns yellow) → crosshair, a preview box follows the cursor, the hint "click or drag to select" for ~5s. The list dims and export is disabled.
3. Click → a 267×100 box centred on the click; or drag a rectangle. Resize from the invisible edge/corner zones; it refuses to go under 20×20 or past the viewport.
4. Type past 900 characters → a muted counter appears; past 980 → danger; hard stop at 1000. **save** is disabled while empty.
5. **save** → the overlay vanishes for a frame, the thumbnail appears at the bottom with its number and a 3-line note.
6. Hover the add button, flick **keep add mode on**, save two more notes without clicking the button; **cancel** one (you stay in add mode); click the button → everything stops.
7. Click a thumbnail → the sidebar expands; the thumbnail grows into the large image, neighbours peek above/below. ↑/↓ and the peeks navigate; edit the note and collapse — reopen to confirm it was kept (no save button, no "saved" text). Clear the text and try to leave → blocked with the inline error. Scroll behind the view → the page must not move.
8. Delete from the enlarged view (moves to the next note) and from the list's hover button (no confirmation either way).
9. Capture on a second URL of the same site, then **export** → `feedback-{domain}-{date}.zip`. Unzip: `screenshots/{id}.png` per note, `feedback.md` whose line 1 is the format stamp, three header lines, one `## page` per URL, and per note the heading, image, `**note:**` line and the collapsed json block, all fixed text lowercase.

### Flow 1a: drawing (design spec §AB)

1. Place a box. Inside → pencil cursor; on an edge → resize cursor; outside → arrow.
2. Draw; pick red; draw. Resize the box over the strokes: they crop, they never move.
3. Cmd/Ctrl+Z with focus on the drawing removes the last stroke; in the textarea it undoes typing only.
4. Pencil button → **erase all**. Save a note with a drawing: strokes over the thumbnail, and glued to the image through the expand morph and the carousel.
5. Export: that PNG has the strokes burned in (4px wide on a 2× display); its alt text ends " — marked up by the reviewer"; no drawing data anywhere else. Reload and start a note: the last colour is still selected. Restart Chrome: yellow.

### Flow 1b: resizable sidebar and the youtube limitation

1. On wikipedia.org, drag the sidebar's left edge: it stops at 188 and 300. Tab to the handle: arrows step 10px, Home/End jump to the ends. Reload: the width is remembered.
2. Open a note and resize the window: the expanded panel stays ~75% and re-lays out; collapse → your width is back.
3. **youtube.com** is a known limitation (REQUIREMENTS EC-13): the page bleeds under the sidebar. Check only that the sidebar paints on top and works, captures are clean, and closing restores the page.

### Flow 2: import

1. On the site the bundle came from: chevron → **import** → pick the zip. With existing notes, the native confirm quotes the real count; cancel leaves everything; ok replaces.
2. Navigate between the bundle's URLs: thumbnails appear per URL.
3. Errors (copy in REQUIREMENTS §5): a `.txt`; a renamed non-zip; a zip without `feedback.md`; a `feedback.md` whose line 1 is another stamp or missing; a broken json block; a bundle from another site.
4. Stop the service worker (`chrome://serviceworker-internals`) and import again: a banner, nothing replaced, **import** enabled again.

### Flow 3: SPA navigation

On reddit.com or twitter.com: capture two notes, follow an in-app link. The sidebar stays open, the list refreshes for the new URL ("no feedback on this page yet" if none), and going back restores the original items.

### Flow 4: reload persistence

Sidebar open → F5 → it reopens by itself with the same items. Close it → F5 → it stays closed.

### Flow 5: coordinates (DPR / zoom)

On a Retina display and at 80% / 150% zoom: capture a region with recognisable text, open it in the enlarged view, compare — no offset. Repeat scrolled halfway down a long page and flush against the right edge next to the sidebar (no sidebar pixels).

---

## edge cases to verify

- **Cross-origin iframe** — pixels captured; exported json shows only the `<iframe>` element's attributes.
- **Large selection** — `contained_elements` caps at 15, attribute/text-bearing elements first; `html` ends in `…` at 300 characters.
- **Form inputs** — captured as shown, no masking (known limitation).
- **Rapid captures** — with the switch on, save as fast as you can: every capture succeeds (they are spaced 500ms apart), none shows extension UI.
- **Restricted pages** — `chrome://extensions`, a new tab, a PDF, the Web Store: clicking the icon does nothing visible; nothing on the page breaks.

---

## debugging

**Where data lives** — `chrome://extensions` → the extension's **Details** → **Inspect views: service worker**:

```js
chrome.storage.local.get(null, d => console.log(d));     // domain:{domain} indexes, item:{domain}:{id} records
chrome.storage.session.get(null, d => console.log(d));   // sidebarOpen:{tabId}, penColor
const db = await new Promise(r => { const q = indexedDB.open('annotator-images'); q.onsuccess = () => r(q.result); });
const keys = await new Promise(r => { const q = db.transaction('screenshots').objectStore('screenshots').getAllKeys(); q.onsuccess = () => r(q.result); });
console.log(keys);                                        // one screenshotKey per stored PNG (data-URL strings)
```

**Message flow** — every handler logs failures with `[Annotator]` in the service-worker console; the content script's failures surface as banners. To trace a message, add a `console.log(msg.type, msg)` at the top of `handleRuntimeMessage` in `src/background.ts` temporarily.

**Context capture** — export and read a note's json block: `viewport` should match `innerWidth/innerHeight`, `dpr` the page's `devicePixelRatio`, `selection_rect` page coordinates (scroll included). `TESTING` cannot check the pixels; Flow 5 does.

**Platforms** — DPR and scrollbar rendering differ by OS: check high-DPI on macOS and classic-scrollbar pages on Windows/Linux (the two viewport widths in `CAPTURE` exist for this).

---

## gotchas

- **Stale `dist/`** — Chrome loads the built files; `npm run build` after every change.
- **Orphaned content scripts** — refresh the tab after reloading the extension.
- **`fetch(dataUrl)` is a CSP violation** in the service worker (`connect-src 'none'`); use `src/dataUrl.ts`. `background.test.ts` keeps a throwing `fetch` stub as the guard.
- **Closed shadow roots** — DevTools shows the hosts but not their contents; the Playwright helper's `attachShadow` patch is the way in for automation.
- **SPA detection** relies on `history.pushState`/`replaceState`; a router that bypasses them (rare) is only picked up on `popstate`/`hashchange`.
- **`chrome.storage.session`** is invisible to content scripts by design — read it from the service-worker console.

---

## shipping checklist

- [ ] `npm test` — 802 passing, 26 suites
- [ ] `npx tsc --noEmit` clean; `npm run build` clean
- [ ] Load the built `dist/` in Chrome and run `BROWSER_TEST_CASES.md` on at least three real sites
- [ ] Flows 1–5 above, including a 2× display and 150% zoom
- [ ] Import error cases with hand-made bundles; export → import round trip
- [ ] The Playwright suite, allowing for the known download-event harness failures
