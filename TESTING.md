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
npx tsc --noEmit                  # type check (strict, noUnused*, exactOptionalPropertyTypes)
npm run lint:exports              # report-only: exports nothing else imports
```

The suites (`npx jest` prints the current counts; they are not kept here, where they went stale):

- `sidebar.test.ts` — open/close, page shrink, URL tracking, resizable width (drag/keyboard, persistence, clamping, the derived 210px minimum), the narrow breakpoint, the add group + "keep on" switch (paint, a transform + clip-path slide-out kept out of flow, the 250ms grace after a finished reveal and the immediate reversal of a part-way one, gestures, resting width, the tuck, track/knob colours), export and the "more options" menu (two separate buttons, routes, keyboard incl. reaching a greyed-out item, outside pointerdown, the greyed-out export and delete-all with their reasons, import handing over to `onImport` with the menu left open, and the menu turning into a question: full panel width, focus on cancel, every way of answering no, Tab between the buttons, stacking the buttons full width when the labels would wrap, a second question replacing the first, a greyed-out delete-all not asking again, named by the question (`aria-labelledby`) and back to its own label as the list, reopening as the list), closing the sidebar hiding an open tooltip, the one-bordered top block, note padding and hover delete, the "on hold" state, keys pressed in the panel never reaching the page while its own key handling still works, the resize drag writing once per frame, and the split pins (`<html>`'s exact style across open, drag and close; a destroy then init starting fresh)
- `addMode.test.ts` — no key reaching the page while a box is placed (and none cancelled), the Option/Alt+N tip in the hint's place (the same tooltip and 5s, a window of its own, swapped in while shown, only while placing, put back), box placement (centred click, clamping, drag-to-draw), edge/corner zones, minimum size, comment box positioning, counter thresholds, save/cancel state (save greyed out with "enter a note to save"), the one-surface comment box with its uniform 6px inset and concentric 8px corners, the pencil drawn like the sidebar's buttons, a greyed-out save's hover/press override coming after the plain button's (equal specificity, so order decides), the preview and hint, one tooltip per add-mode root on re-entry, save hiding the tooltip with no fade
- `addModeDrawing.test.ts` — erase all greyed out (aria-disabled) with its "nothing to erase" reason on hover and focus, the pencil: no surface while placing, the surface exactly over the rect with the zones above it, stroke capture incl. coalesced samples and dots, focus moving off the textarea, strokes pinned through a resize, the cropped `drawing` handed to `onOk`, Cmd/Ctrl+Z vs the textarea's own undo, the pencil menu (erase all, Esc/Tab/arrows, placement above), the swatch radio group, capture purity end to end
- `drawing.test.ts` — the palette, `cropDrawing` (edge cuts, exit/re-entry splitting, dots, rounding), the SVG builder, the canvas painter's scaling
- `drawingViews.test.ts` — a saved drawing over the list thumbnail and over the enlarged view's screenshots: inside each note's `.xp-shot`, riding the morph clone's media box, and moving with its screenshot when a delete re-packs the rows
- `enlargedView.test.ts` — enlarged view 2.0 (design spec §AH): every page of the site in order with per-page numbers, headings (two lines: serif name and a neutral pencil, then the mono address in regular ink, "this page" on the current page only, a group named by each), every note editable, parts placed by the layout and sized before any image loads; opening (the clicked note focused with the caret at the end, the row before it peeking 40px under the top bar (a page's heading whole), the first note at the top, list thumbnails morphing in — one cut by the list's edge clipped as it is cut — while the rest fade a band at a time, a second open refused while one is up, the panel, the 68px top bar with 16px margins and the logo settling 16px down as it is 16px in, its bottom rule (the docked divider's token and thickness, edge to edge, arriving and leaving with exit), the exit chevron, lazy full images via IntersectionObserver, no site → this page alone, said in the top bar); closing (focus back to the last note focused on this page, Esc/scrim, notes on screen morphing back to their thumbnails, collapse mid-expand reversing from the live width and clones, keyboard isolation); per-note autosave (independent debounces, blur, flush on collapse, failures under their note and named in the banner, unload flush, dedupe); the empty-note lock ("note required" at once, every exit refused with focus moved to it, one shake per emptying, forced close, delete still allowed); delete (one click deletes on a scrolled view and the scroll stays, shrink, renumber, FLIP re-pack of only what is near the screen, focus to the next delete, a page's last note takes its heading, the site's last collapses, failure, mid-expand); renaming a page (a field in the name's serif, Enter, Esc only cancels, ✓/×, empty or default restores, failure reverts, a page whose notes were deleted elsewhere says so, blur and collapse save); keyboard (Tab order, focus scrolling a note into view only when the keyboard moved it, ↑/↓ and page keys, Enter/Space isolation, IME, the exit glyph, the one trash glyph); the §T scroll lock (Space on a button is its click; the lock sits before the isolation); reduced motion; lifecycle (held-off refresh, sidebar close, destroy, resize re-pack)
- `enlargedView.test.ts`, "delete all, in the top bar" — the button left of exit (the trash glyph, the danger ink, 20px from exit, 8px between the answers), asked in place with focus on cancel, cancel / Esc (not closing the view) / a press or focus elsewhere putting it back, the keyboard (Tab order, Shift+Tab between the answers), confirming closing onto the empty list with nothing morphing, debounced edits dropped, allowed with a note empty, a failure said in the top bar, a collapse waiting for the outcome
- `pageHeading.test.ts` — a page heading's address ellipsized in the middle to its measured room or shown whole, a cut-short name's tooltip, every heading fitted in one layout pass (all writes, all reads, all writes), the rename field sized to its text
- `enlargedLayout.test.ts` — the pure layout: panel width, content width, the height cap, the text area = the default selection's width; never upscaling, scaling down by width and height; row packing (greedy, one to three, exact fits, a wide note alone); centring of every row, own widths, each note a group (bar, image, text area) centred on its image and vertically centred in its row; pages with headings and gaps; narrow panels down to one per row and below the text area's width; the opening scroll (the site's first row at the top with no peek, every note in it; a later row with the previous row's last 40px under the top bar; a page's first row with its heading whole and the previous page's last row peeking above it, and the text area still winning on a short window; the same peek on a tall and a short window; the text area winning on a window too short for both; clamping); the address's scheme and middle ellipsis
- `content.test.ts` — the enlarged view's wiring (GET_SITE_PAGES before opening, both pages shown, the clicked note focused, the site unreadable → this page alone under its stored name, said in the view's top bar, a rename of a page whose notes were deleted elsewhere, add mode during the read opening nothing, UPDATE_ITEM / DELETE_ITEM / SET_PAGE_TITLE, the toolbar icon refused while a note is empty), the add-note toggle / switch state machine end to end (gestures, Esc, sidebar close, opening a note, the sidebar tooltip taken down at once as a capture starts), the "on hold" wiring, the list delete round trip, the import flow (asked in the menu before the picker only when the site has notes, cancel opens no picker, a failed count read or dead worker stops it, a menu dismissed during the count opens no picker, the fresh count greying out export and delete-all, a valid file then replaces without asking again), and delete-all (greyed out unless the site has feedback and its count can be read, the question quoting both counts, cancel, a count failing at click time, a site emptied meanwhile, a failed or dead-worker delete), an edit to a note deleted elsewhere not reported saved, SPA navigation, export's replies and import's failures (staging, commit, abort), and the shutdown when the extension context dies (everything removed and restored, the takeover by a fresh injection leaving one sidebar, a live duplicate injection changing nothing). Each test first tears down the previous test's instance
- `tooltip.test.ts` — the shared tooltip (spec §AG), including the left → right → above fallback: the native delay before the first, nothing when leaving early, moving onto the control's own icon keeps it, the warm hand-off to the next control, hidden on press, nothing on keyboard focus for a plain tooltip, a disabled reason quicker on hover, at once on focus and announced, above by default, below when there is no room, the left side and its fallback, an open tooltip re-placed when a transition ends on its control or an ancestor (not elsewhere, and not once closed), cleanup; Esc hiding it under keyboard isolation installed after it (a real closed root), hidden when its control is removed, an ancestor hidden or made inert, or its text changed (not when merely restyled), hidden on a scroll inside the root and on the page, `hide({ immediate: true })` turning the fade off until the next show, `destroy()` removing the window listeners, the root's `transitionend` listener and the observer; the shared `setSoftDisabled` (sets or removes `aria-disabled`, never writes `"false"`, reports only a change) and `isSoftDisabled` (only `"true"` counts)
- `closedShadowTyping.test.ts` — Space on a button (and the other controls it activates) is its click, never cancelled; typing inside a genuinely **closed** shadow root while the enlarged view's page-scroll lock listens on window: Space, the arrows, Home/End and the page keys reach the textarea, ordinary characters are untouched, and the lock still cancels scroll keys on controls and on the page. Every other suite forces shadow roots open, which is how the bug this guards slipped through
- `capture.test.ts` — viewport-relative coordinates, the page-rect conversion, ordering (context before hide, double rAF before `CAPTURE`), failure restores the overlay
- `background.test.ts` — GET_SITE_PAGES and SET_PAGE_TITLE (routing, failures, the write queue), injection and reload re-injection (a script that still answers PING is re-activated, not injected again), the handler table, the capture relay and throttle, `computeDeviceRect` across the DPR/zoom/scrollbar/edge matrix, blob cleanup on a failed save, UPDATE_ITEM / UPDATE_NOTE answering NOT_FOUND for a note that no longer exists, the import's stage and commit (ids kept and grouped by page, `nextItemNumber`, each note stored as sent with a fresh key and thumbnail, through the queue, a failed commit deleting what it was given, an undecodable screenshot refused, abort, routing), the export's queued read, the item/page count and the whole-domain delete (including that it waits for an in-flight save, and that a `chrome.runtime.lastError` from the real storage layer comes back as the delete-all copy), pen colour validation, a `fetch()` stub that throws (the CSP regression guard)
- `contextCapture.test.ts` — deepest-containing-element selection, contained-element prioritisation and the 15 cap, area text, the 2KB governor's truncation order and markers, iframe leaves
- `selectorBuilder.test.ts` — selector priority ladder, framework-id rejection, class heuristics, XPath
- `storage.test.ts` — the write order of the destructive paths (a failed import write keeps the old notes and their screenshots, a failed delete-all removal keeps both, a screenshot that cannot be deleted afterwards is an orphan and not a failure), the chrome.storage fake copying values and answering asynchronously, `getPageTitle`, the site's pages in order and the edited page names (trimmed, reset by empty or null, refused for a page with no notes, index-only, cleared by the page's last delete, delete all and an import, kept by captures, carried by split/assemble), domain and item CRUD, the index-only item/page count, the split layout (which keys each operation touches, torn-write tolerance), blob orphan prevention, `nextItemNumber` monotonicity, session state and pen colour, and `chrome.runtime.lastError` failing a get/set/remove (while an orphan key left after the index write is only logged)
- `thumbnails.test.ts` — list rendering in order, open on click/Enter/Space, the note-preview DOM cap (the 3-line clamp itself is CSS), the sibling delete button firing `onDelete` and never `onOpen`, numbering by position (badges and labels vs `data-item-id`, delete-then-renumber, delete-all-then-1, two pages each from 1)
- `import.test.ts` — the ladder with purpose-built zips: not-a-zip, corrupt archive, missing `feedback.md`, unsupported format (a retired v1 bundle, a newer stamp, no stamp — checked before malformed data), malformed element data, missing screenshot, duplicates (the same id on two pages; the same number twice on one page; the same number on two pages accepted; a gap accepted; #4 before #11), domain mismatch, and a round trip
- `bundle.test.ts` — the format-2 writer against generated input (header, page order, notes in list order numbered by position with id-named screenshots, every page from 1, field order, `(none)`, the free-text caps and their single ellipsis), `formatExportDate`, the derived `text`, the round trip, notes that look like structure or quote a whole item, reader dispatch (v1/newer/unstamped refused), every malformed-file error, and `FORMAT_VERSION === FORMAT_VERSION_V2`
- `bundleV2.test.ts` — the frozen fixture `fixtures/feedback-v2.md`: it decodes to hand-written items (each with its heading number) and the writer reproduces it byte for byte; headings count from 1 on each page while screenshot paths keep the id; the visible note line is ignored on read; CRLF/BOM copies still read; all fixed text is lowercase
- `export.test.ts` — a renamed page exported under its name as `page_title` (and back through import), a drawing composited at the image's measured scale, an undrawn item exported byte for byte with no canvas, no drawing data in `feedback.md` (only the alt text), a failed composite falling back, the injectable header, per-page heading numbers with id-named screenshot files, the export → import round trip, export → import → export reproducing the same file, and a failed read reported as an export failure
- `urlNorm.test.ts` — normalisation rules and `exportFilename`
- `keyboardIsolation.test.ts` — capture-phase isolation of events inside the host; events outside untouched; `preventDefault` never called
- `keyRouter.test.ts` — the router: priority order, `'stop'`, event types, handlers added or released mid-key, the window listener's lifetime, the table's order
- `keyOrder.test.ts` — who sees a key first, one case per priority pair with the real modules, each registering the later handler first
- `addModeControl.test.ts` — the add-note state machine on fakes with an injected clock: the double-click window, the switch, cancel, capture outcomes, Esc, Option/Alt+N, the capture session token; the Option/Alt+N tip's side (a single click asks and is counted after the double-click window, a double-click neither counts nor keeps its tip, the switch / shift+click / shortcut / kept-on restarts never ask, a late answer shows nothing, the shortcut reported once it fires)
- `addNoteTip.test.ts` — when the tip shows (the third single-click start of a session only; at most three per install; never after the shortcut), its macOS and Windows wording, and the service worker's counts on the real storage: the session count resetting with the browser while the lifetime count does not, a start that took its tip back not counted, the two stores' keys, failures answering no
- `navigation.test.ts` — SPA detection's debounce, its four sources, and `restore()` (history's methods back unless something wrapped them since)
- `notifications.test.ts` — the banner: verbatim copy, the 8s auto-clear and countdown, a new message restarting it
- `sidebarWidth.test.ts` — the width store: clamping, subscribers, persisting on commit, a persisted width yielding to one the user picked
- `imageStore.test.ts` — the shared IndexedDB connection reopened after a failed open, a close and a versionchange
- `emittedCss.test.ts` — every emitted stylesheet byte for byte against `__golden__/` (regenerate with `UPDATE_GOLDEN=1` for a deliberate change)
- `stripCssComments.test.ts` — what the build strips from the stylesheets, and that only template literal text is touched
- `theme.test.ts` — the parked light table covers the same keys as the dark one; `RADII`; `getThemeCSS` emits only the dark tokens on `:host` (no `data-theme` selector) with the namespaced font stacks; `ensureFontsLoaded` never throws and is idempotent
- `dockMotion.test.ts` — influence/falloff math, spring integration, keyboard-focus magnification, reduced-motion bypass, the shared note-background/delete opacity spring, rAF loop lifecycle
- `dom.test.ts` — `getContentViewportSize`'s fallback and layout case, `reducedMotionQuery`'s three outcomes, the safe rAF fallback and cancel, and `keyTargetWithin` / `pointTargetWithin` on open and closed roots
- `autosave.test.ts` — a debounce per id (typing in one never restarts another), `flush()` over every dirty id, debounce, in-flight counts as clean, superseded replies dropped, failed saves retried on flush, forget on delete
- `rpc.test.ts` — `send()` never rejects; `undefined` on a dead worker / invalidated context; the dead-context hook (run before the caller hears `undefined`, not for an ordinary failure)
- `dataUrl.test.ts` — byte-exact codecs, percent-encoded form, >32 KiB chunking, `fetch`-free
- `copy.test.ts` — the §5 copy, byte-exact (with the top bar's delete all strings)

**Environment:** jest + ts-jest (compiling with the project's `tsconfig.json`) + jsdom. `src/__tests__/setup.ts` mocks `chrome.storage.local/session` (one fake for both, copying values on the way in and out and answering a microtask later, as Chrome does), `chrome.runtime.getManifest` (reads the real `manifest.json`) and installs `fake-indexeddb`; `src/__tests__/helpers/` holds the shared CSS-rule and item builders; jsdom has no layout, so `offsetWidth`/`offsetHeight` report 100 for any connected element and `CSS.escape` is polyfilled. `src/__tests__/fixtures/feedback-v2.md` is frozen: a writer change that alters it is a format change and needs a new fixture and version.

**Comment policy:** a comment explains a *constraint* or a *rejected alternative* — why the code is the odd shape it is and what broke when it was simpler — never *when* something changed (git has that). The banners in `background.ts` (the measured crop scale), `pageResize.ts` (the page-shrink strategy) and `scrollLock.ts` (the scroll lock's exemption test) are the model.

---

## build and load in chrome

```bash
npm run build          # esbuild → dist/background.js + dist/content.js (minified, sourcemaps)
npm run build:watch    # rebuild on change
```

1. `chrome://extensions` → enable **Developer mode**.
2. First time: **Load unpacked** → the project root (with `manifest.json`).
3. After every rebuild: the reload icon on the extension card.
4. Then refresh the test tab, or just use it: a content script injected before the reload is orphaned (it cannot reach the new service worker), and it shuts itself down — sidebar removed, page restored, nothing shown — on its first action or when the icon injects the new build.

---

## end-to-end (playwright)

```bash
npm run build && npx playwright test
```

Eight specs in `tests/` (48 tests: sidebar, capture, thumbnails/enlarged view — its opening peek, a window too short for it, delete all in its top bar —, export/import, persistence, the Alt+N shortcut and its tip on the third click of a session, a large import over Chrome's 64 MiB message limit, and keyboard isolation on a page with a hostile shortcut handler) run headed against a real Chromium with the built extension loaded (`tests/helpers/extension.js`: persistent context, service-worker handle, a local file server for `tests/fixtures/test-page.html` with SPA-style routes, and a patch that forces the extension's closed shadow roots open so plain CSS selectors reach inside). One worker, one retry (in CI a test that only passed on its retry fails the run). Not run in the unit loop.

Last recorded run, 2026-10-13: 48 passed. (Export is read back by wrapping `chrome.downloads.download` in the service worker — `exportAndGetDownload` — since a service-worker download raises no page download event.)

---

## manual test flows

### Flow 1: capture → thumbnail → enlarged view → export

**Page:** any real site (github.com, wikipedia.org).

1. Click the icon → the sidebar opens on the right; the page is narrower, not covered.
2. Click **add note** (the group turns yellow) → crosshair, a preview box follows the cursor, the hint "click or drag to select" for ~5s. The list dims and export is disabled.
3. Click → a 267×100 box centred on the click; or drag a rectangle. Resize from the invisible edge/corner zones; it refuses to go under 20×20 or past the viewport.
4. Type past 900 characters → a muted counter appears; past 980 → danger; hard stop at 1000. **save** is greyed out while empty; hovering or focusing it says "enter a note to save", and clicking it does nothing.
5. **save** → the overlay vanishes for a frame, the thumbnail appears at the bottom with its number (its position in this page's list — a second page starts at 1 again) and a 3-line note.
6. Hover the add button, flick **keep add mode on**, save two more notes without clicking the button; **cancel** one (you stay in add mode); click the button → everything stops.
7. Capture on a second URL of the same site too. Click a thumbnail → the sidebar expands into one scrolling page of every note on the site, page by page under each page's name and address ("this page" on yours); the visible list thumbnails grow into their places, everything else fades in. The clicked note's text area has the cursor, and the bottom of whatever precedes it peeks at the top. Edit two notes, collapse — reopen to confirm both were kept (no save button, no "saved" text). Empty one → "note required" under it at once; try exit, Esc, the scrim, the toolbar icon → each refused, focus jumps to it. Rename a page with the pencil (Enter saves, Esc cancels without closing, an empty name restores the title). Scroll behind the view → the page must not move; the view itself scrolls.
8. Delete from the enlarged view (the rest renumber and slide into their re-packed places; a page's last note takes its heading with it) and from the list's hover button (no confirmation either way); every note below the deleted one moves up a number. Delete all of a page's notes and capture again → #1, and the page has its title back.
9. **export** → `feedback-{domain}-{date}.zip`. Unzip: `screenshots/{id}.png` per note, `feedback.md` whose line 1 is the format stamp, three header lines, one `## page` per URL, and per note the heading (`### feedback n`, counting from 1 on every page, the same numbers as the sidebar), image (`screenshots/{id}.png` — the internal id, unique across the site), `**note:**` line and the collapsed json block, all fixed text lowercase.

### Flow 1a: drawing (design spec §AB)

1. Place a box. Inside → pencil cursor; on an edge → resize cursor; outside → arrow.
2. Draw; pick red; draw. Resize the box over the strokes: they crop, they never move.
3. Cmd/Ctrl+Z with focus on the drawing removes the last stroke; in the textarea it undoes typing only.
4. Pencil button → **erase all**. Save a note with a drawing: strokes over the thumbnail, and glued to the image through the expand morph, the collapse and a delete's re-pack.
5. Export: that PNG has the strokes burned in (4px wide on a 2× display); its alt text ends " — marked up by the reviewer"; no drawing data anywhere else. Reload and start a note: the last colour is still selected. Restart Chrome: yellow.

### Flow 1b: resizable sidebar and the youtube limitation

1. On wikipedia.org, drag the sidebar's left edge: it stops at 210 and 300. Tab to the handle: arrows step 10px, Home/End jump to the ends. Reload: the width is remembered.
2. Open a note and resize the window: the expanded panel stays ~75% and re-lays out; collapse → your width is back.
3. **youtube.com** is a known limitation (REQUIREMENTS EC-13): the page bleeds under the sidebar. Check only that the sidebar paints on top and works, captures are clean, and closing restores the page.

### Flow 2: import

1. On the site the bundle came from: **more options** (⋯) → **import**. With existing notes the menu itself asks "your existing notes will be discarded. continue with import?" before the picker opens; cancel leaves everything; **yes, import** opens the picker and the picked bundle replaces.
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
- **Orphaned content scripts** — after reloading the extension, the old script shuts itself down on its first action (or when the icon injects the new build); refresh the tab if you want a clean start.
- **`fetch(dataUrl)` is a CSP violation** in the service worker (`connect-src 'none'`); use `src/dataUrl.ts`. `background.test.ts` keeps a throwing `fetch` stub as the guard.
- **Closed shadow roots** — DevTools shows the hosts but not their contents; the Playwright helper's `attachShadow` patch is the way in for automation.
- **SPA detection** relies on `history.pushState`/`replaceState`; a router that bypasses them (rare) is only picked up on `popstate`/`hashchange`.
- **`chrome.storage.session`** is invisible to content scripts by design — read it from the service-worker console.

---

## shipping checklist

- [ ] `npm test` — every suite passing
- [ ] `npx tsc --noEmit` clean; `npm run build` clean
- [ ] Load the built `dist/` in Chrome and run `BROWSER_TEST_CASES.md` on at least three real sites
- [ ] Flows 1–5 above, including a 2× display and 150% zoom
- [ ] Import error cases with hand-made bundles; export → import round trip
- [ ] The Playwright suite (`npm run build && npx playwright test`), all passing
