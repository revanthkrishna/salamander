# Testing

How to test the annotator extension after code changes — unit tests, builds, and manual browser verification.

---

## unit tests

```bash
npm test                          # full Jest run
npx jest sidebar                  # just the sidebar tests
npx jest capture                  # capture geometry and coordinate math
npx jest contextCapture           # DOM context extraction
npx jest import                   # all 13 import error cases
npx jest bundle                   # markdown serialization round-trip
```

**Test coverage** (669 tests, 21 test files):
- `sidebar.test.ts` — sidebar open/close, page resize, URL tracking, resizable width (drag/keyboard, persistence, clamping), narrow-width breakpoints, the "add note" group + its "keep on" switch (paint, reveal, gestures, resting width, the single divider, the merged fill, the v4 §P track/knob colours), the export/chevron menu (open/close routes, keyboard, outside pointerdown, per-half hover/press), the one-bordered-block top section, the note's uniform padding and its hover delete, and the §H "on hold" state
- `addMode.test.ts` — selection box creation, edge/corner resize hit zones, clamping to viewport, comment box positioning, counter thresholds, save/cancel state
- `capture.test.ts` — viewport-relative CSS coordinates, CSS → device-pixel scale calculation, DPR accounting, crop verification
- `contextCapture.test.ts` — deepest-common-ancestor selection, contained-elements prioritization (15-element cap), area-text aggregation, 2KB size governor, truncation markers
- `selectorBuilder.test.ts` — CSS selector generation (data-* preference, ID rules, nth-of-type fallback, UUID/React hash rejection), XPath generation
- `storage.test.ts` — domain CRUD, item CRUD (create/read/update-by-patch/delete), blob orphan prevention, nextItemNumber monotonicity, the split layout (which keys each operation reads and writes, torn-write tolerance), the version-1 → version-2 migration against a frozen v1 record through every entry point, session state round-trip
- `thumbnails.test.ts` — thumbnail list rendering from FeedbackItem array, including each item's hover delete (a sibling of the item's button, never nested inside it) and its wiring
- `enlargedView.test.ts` — enlarged view open/collapse (incl. interrupted transitions), prev/next and the ends, autosave debounce + flush on navigate/collapse, save failures, the empty-note rule on every exit path, delete (middle/last/only), keyboard (Esc/↑/↓/focus in and out), add mode collapsing it first, reduced-motion path, teardown
- `content.test.ts` — add-note toggle / "keep add mode on" switch state machine end to end (switch on from off, switch off mid-session, capture re-entry and per-note cancel while it is on, the v2 dblclick/shift gestures, Esc, sidebar close, opening a note), plus the §H "sidebar on hold" wiring and the list delete's DELETE_ITEM round trip and failure copy
- `import.test.ts` — all 13 error cases (not-a-zip, corrupt archive, missing `feedback.md`, malformed fence, missing screenshot, duplicate IDs, domain mismatch, version mismatch, existing-data confirmation) with purpose-built fixture bundles
- `bundle.test.ts` — markdown → YAML fence extraction, YAML → object parsing, round-trip (export → parse → deep-equal), the version-dispatching reader
- `bundleV1.test.ts` — the frozen schema-version-1 bundle: `fixtures/feedback-v1.md` (real committed text) must decode to hand-written items, and the v1 writer must reproduce it byte-for-byte
- `background.test.ts` — injection, message handlers, capture relay, throttle verification, re-inject on reload
- `urlNorm.test.ts` — normalization rules (strip query/fragment, strip `www.`, strip trailing slash, case-sensitive paths, port handling) — kept from v1
- `keyboardIsolation.test.ts` — capture-phase window-level keydown/keyup isolation so page shortcuts can't fire while typing into the comment box / enlarged-view note editor
- `theme.test.ts` — theme mode (`auto`/`light`/`dark`) resolution and persistence, `chrome.storage.onChanged` cross-tab sync, OS `prefers-color-scheme` fallback, CSP-safe bundled `FontFace` loading, themed-host registration
- `dockMotion.test.ts` — pointer-position-based influence/falloff math, spring integration toward scale/translate targets, keyboard-focus magnification, `prefers-reduced-motion` bypass, the note background and hover delete sharing one opacity spring, rAF loop lifecycle (starts on interaction, stops at rest, cleaned up on teardown)
- `autosave.test.ts` — the per-item autosave controller: debounce, in-flight-counts-as-clean, superseded replies dropped, failed saves retried on flush, forget on delete
- `rpc.test.ts` — the typed `send()`: never rejects, `undefined` on a dead worker / invalidated context, response type follows the request
- `dataUrl.test.ts` — the data-URL codecs: byte-exact decode across the 0x80 boundary, percent-encoded form, >32 KiB chunking, `fetch`-free
- `copy.test.ts` — the §5 copy, byte-exact

**Jest/jsdom:** no browser launch. `chrome.storage` and IndexedDB are mocked via `src/__tests__/setup.ts`. jsdom doesn't implement layout, so layout-dependent code (e.g. `offsetWidth` for visibility checks) is stubbed to return non-zero for any connected element.

**Comment policy:** a comment explains a *constraint* or a *rejected alternative* — why the code is the odd shape it is, and what broke when it was simpler. It does not narrate *when* something changed or which build phase did it: git has that history, and such comments only ever go stale. The banners in `background.ts` (why the crop scale is measured), `sidebar.ts` (the page-shrink strategy) and `enlargedView.ts` (the scroll lock's exemption test) are the model.

---

## build & load in chrome

The extension's compiled bundle lives in `dist/`. Chrome reads from there directly via "Load unpacked".

```bash
npm run build       # esbuild → dist/ (every src/ module bundled, minified, into dist/*.js)
```

In Chrome:

1. `chrome://extensions` → enable **Developer mode** (top-right toggle)
2. **First time only:** "Load unpacked" → select the project root (directory with `manifest.json`)
3. After every rebuild: click the **reload (↻)** icon on the extension card
4. After reloading the extension: **refresh the test tab** (⌘⇧R / Ctrl+Shift+R)
   - Content scripts injected into *open* tabs become orphaned when you reload the extension
   - A page refresh re-injects the new content script and re-establish the message channel

---

## manual test flows

### Flow 1: Basic capture → thumbnail → enlarged view → export

**Page:** any real website (e.g. https://github.com, https://wikipedia.org)

1. Click the extension icon → sidebar opens on right side of page
2. Verify sidebar has resized the page (page is narrower, no overlay)
3. Click **add note** (the icon-only comment-bubble button; the group turns yellow = on) → cursor becomes a crosshair. Hover the button to reveal the "keep add mode on" switch and flick it on instead: after each save you're straight back in add mode until you click the button, flick the switch back, or press Esc. (Double-click / shift+click / shift+enter still work and just turn the switch on.) While add mode is active the note list below dims and stops responding, and export is disabled
4. Click a specific element (e.g. a button or heading) → default 267×100px box appears (the thumbnail's size at the default sidebar width)
5. Drag from the invisible edge/corner resize zones (no visible handles) to adjust the box
   (minimum 20×20px enforced)
6. Type a note in the comment box (test the 1000-char counter: appears past 900, danger-coloured
   at 980+)
7. Click **save** → overlay hides, screenshot taken, overlay restores, thumbnail appears
8. Thumbnail shows correct image + truncated note text + item number
9. Click thumbnail → the sidebar expands (thumbnail grows into the large screenshot; neighbouring notes peek in above/below)
10. Edit the note text → autosaves shortly after typing stops, silently (no confirmation); try ↑/↓ and the peeks to move between notes; clear the text entirely and try to leave → blocked with an inline error under the text area. Try to scroll the page behind the view → it must not move; the text area still scrolls
11. Click **delete** → item removed, thumbnail gone, blob cleaned up. (A note can also be deleted without opening it: hover or Tab to its list item and use the delete button over the thumbnail's top-right corner.)
12. Repeat steps 3–7 with 2+ items, then on a *different* URL in the same domain
13. Click **export** → `.zip` downloads
14. Extract `.zip` and verify:
    - `screenshots/1.png`, `screenshots/2.png`, etc. exist (correct count)
    - `feedback.md` renders correctly in a markdown viewer with inline images
    - One `##` section per URL, items chronological within section
    - Each item has number, image reference, note, and fenced yaml context block

### Flow 1b: Resizable sidebar + the youtube page-shrink edge case

**Page:** a normal-flow site (https://wikipedia.org) *and* https://youtube.com

1. Sidebar open on wikipedia → hover the sidebar's left edge: cursor becomes `ew-resize`
   and a thin yellow rail appears
2. Drag left/right → panel width follows the cursor live, page reflows to match,
   clamped at 188px (narrowest — the width the action row needs with the "keep on" switch out) and 300px (widest) — it will not go past either
3. Tab to the handle → arrow keys resize in 10px steps, `Home`/`End` jump to the extremes
4. Open a note in the enlarged view, then resize the window → the expanded panel stays ~75%
   of the viewport and its layout recomputes; collapse → the sidebar is back at your chosen width
5. Close the sidebar, reload, reopen → the width you picked is still there
   (persisted in `chrome.storage.local`, key `sidebarWidth`)
6. **youtube.com — known limitation (REQUIREMENTS §6 #13), not a bug to file:**
   the sidebar is fully visible and usable, but page content bleeds *under* it —
   YouTube sizes containers in `vw` units and computes player width from
   `window.innerWidth` in JS, neither of which a root-element shrink can affect.
   What to check is only that (a) the sidebar paints on top and every button works,
   (b) capture still produces a clean screenshot with no extension UI in it, and
   (c) closing the sidebar leaves the page exactly as it was.

### Flow 2: Import

**Setup:** have a `.zip` bundle from Flow 1 on disk

**Page:** same website where the bundle was created

1. Sidebar open, domain is empty (or has old feedback)
2. Click the chevron beside **export**, then **import** in the menu → file picker opens, accept `.zip` only
3. Select the bundle → extension reads and validates
4. If existing feedback: confirmation dialog appears → accept it to replace
5. Sidebar populates with thumbnails for URLs in the bundle
6. Navigate to other URLs in the domain → thumbnails appear/disappear per URL

**Error cases to test manually:**
- Select a `.txt` file → "invalid file type. please upload a .zip feedback bundle."
- Corrupt/truncated `.zip` → "could not read this file — it appears to be corrupted."
- Valid `.zip` missing `feedback.md` → "this doesn't look like a feedback bundle."
- Valid `.zip` where an item's metadata fence is malformed → "this bundle appears to be corrupted (couldn't read feedback data)."
- Valid `.zip` from a different domain → "this bundle contains feedback for 'example.com', but you're currently on 'github.com'."

### Flow 3: SPA navigation persistence

**Page:** a website with client-side routing (e.g. reddit.com, twitter.com)

1. Click extension icon → sidebar opens
2. Create 2+ feedback items on the starting page
3. Navigate to a different URL via a link (not a full page reload)
4. Verify sidebar stays open and thumbnail list refreshes for the new URL
5. If the new URL has no feedback: "no feedback on this page yet" message
6. Navigate back to the starting page → thumbnails reappear (correct items, not from other URLs)

### Flow 4: Reload persistence

**Page:** any website

1. Click extension icon → sidebar opens
2. Create feedback items
3. Press F5 (full reload)
4. Verify sidebar opens automatically with the same items (no user action needed)
5. Close sidebar, reload again → sidebar should NOT open (state was cleared by close)

### Flow 5: Coordinate verification (optional, DPR-sensitive)

**Setup:** use a high-DPI display (e.g. Retina Mac) or zoom the browser to 150%

1. Click extension icon, **add**
2. Select a region containing specific UI elements (e.g. a button with text)
3. Capture and open the note in the enlarged view
4. Visually verify the screenshot matches what's on screen (no offset/shift)
5. Repeat at different zoom levels (80%, 100%, 150%) to catch scaling bugs

---

## edge cases to verify

### Cross-origin iframe
**Page:** a site with an embedded iframe (e.g. an embedded video player or ad)

- Select an area that includes the iframe
- Capture and open the note in the enlarged view
- Verify the screenshot shows the iframe content correctly (visible-tab capture includes it)
- Verify context capture shows the `<iframe>` tag's attributes but not the iframe's internal DOM (same-origin restriction)

### Large selection (context truncation)
**Page:** any complex website with many nested elements

- Select a large region that contains >15 distinct elements with text/attributes
- Capture and open the note in the enlarged view
- Look at the yaml context block in the exported markdown:
  - `contained_elements` should have exactly 15 items
  - `contained_elements_truncated: true` should be present
  - Check that truncated elements were filtered by relevance (elements with text/attributes appear before bare divs)

### Form inputs (sensitivity warning, no masking)
**Page:** a page with password/email inputs (e.g. login form)

- Select an area containing form inputs
- Capture; verify the screenshot includes the form (no visual masking)
- Note: masking is out of scope for v1 (REQUIREMENTS §2)

### Rapid successive captures (throttle)
**Page:** any website

- Enter add mode, capture, exit → capture again, capture again (3+ times in quick succession)
- Verify only 2/second succeed; remaining requests fail with "couldn't capture a screenshot here. try again." (rate limit error from gotcha #2)

### Restricted pages (no injection)
**Pages:** `chrome://extensions`, `chrome://new-tab`, a PDF file, Chrome Web Store

- Click extension icon → no sidebar appears, icon is disabled
- Verify the main page remains fully functional (no errors)

---

## debugging

### Where data lives

- **Metadata:** `chrome.storage.local` under `chrome://extensions` → extension details → **Inspect views: service worker** → console
  ```js
  chrome.storage.local.get(null, data => console.log(data))
  ```
- **Blobs:** IndexedDB, also in the service worker context (right-click extension card → Inspect)
  ```js
  // In the service worker console
  const db = await new Promise(r => {
    const req = indexedDB.open('annotatorDB');
    req.onsuccess = () => r(req.result);
  });
  const tx = db.transaction('screenshots', 'readonly');
  const store = tx.objectStore('screenshots');
  const allKeys = await new Promise(r => {
    const req = store.getAllKeys();
    req.onsuccess = () => r(req.result);
  });
  console.log(allKeys);
  ```

### Inspecting message flow

1. Right-click extension icon → **Manage extension** → **Details**
2. Under "Inspect views," click on the service worker URL
3. The DevTools console shows all `console.warn`, `console.error`, etc. from the background
4. Content script messages are logged with context:
   ```js
   chrome.runtime.onMessage.addListener((msg, sender, respond) => {
     console.log('[BG]', msg.type, msg);
     // ...
   });
   ```

### Inspecting DOM context capture

1. Manually capture an item
2. Extract the export `.zip` and examine the yaml block for one item:
   ```yaml
   primary_target:
     css_selector: "..."
     xpath: "..."
     outer_html_snippet: "..."
   contained_elements:
     - tag: div
       classes: { semantic: [...], generated: [...] }
       attrs: { ... }
       text: "..."
   area_text: "..."
   page_meta:
     url: "..."
     viewport: { width: 1280, height: 720 }
     dpr: 2.0
     selection_rect: { x: 100, y: 150, width: 400, height: 300 }
     captured_at: "2026-09-18T12:34:56Z"
   ```
   - Verify DPR matches `window.devicePixelRatio` on the page
   - Verify viewport matches `window.innerWidth/innerHeight`
   - Verify selection_rect is in page-relative coordinates (not CSS-relative or device-pixels)

### Testing on macOS vs. Windows vs. Linux

Device pixel ratio and scrollbar rendering vary by OS. Test high-DPI on Mac, verify scroll-offset handling on Windows. Coordinate math should be identical across platforms, but real-world rendering quirks (subpixel alignment, scrollbar strip inclusion) are OS-dependent.

---

## gotchas

- **Stale dist/**  — `npm run build` is required; Chrome doesn't auto-recompile TypeScript.
- **Orphaned content scripts** — Always refresh the tab after reloading the extension. Otherwise, the injected content script on that tab is orphaned and can't reach the new background context.
- **IndexedDB mocking** — `fake-indexeddb` is used in tests, but the real browser uses a different backend. Test image blobs manually in the browser (see "Where data lives" above).
- **CSP blocks external URLs** — `script-src 'self'` and `connect-src 'none'` enforce local-only code. All dependencies (fflate, yaml) are bundled by esbuild.
- **SPA detection requires history patching** — if a site bypasses `history.pushState` (e.g. using a custom navigation library), SPA nav detection may miss the transition. Manual refresh still works, though.
- **Storage quota** — with `unlimitedStorage` permission, the quota is unlimited, but be aware that massive exports (100s of items) may hit practical I/O limits. Tested up to 50 items per domain in unit tests.

---

## CI/CD (if applicable)

On push or PR:
```bash
npm install
npm run build  # verifies TypeScript compilation
npm test       # runs Jest suite (must pass)
```

Note: E2E tests (`npx playwright test`) are **not** run in this CI loop — they are explicitly reserved for manual verification in a real browser. See Phase 10 DEVELOPMENT_PLAN.md for the Playwright suite structure.

---

## shipping checklist

- [ ] `npm test` passes (all 669 tests green)
- [ ] `npm run build` succeeds with no errors/warnings
- [ ] Manual flows 1–5 verified on ≥3 real websites
- [ ] Edge cases (iframe, large selection, form inputs, rapid captures, restricted pages) spot-checked
- [ ] High-DPI and zoom edge cases tested
- [ ] Import error cases (13 total) tested with fixture bundles
- [ ] Export → import round-trip verified (same-site and cross-recipient)
- [ ] E2E Playwright suite passes (separate agent, parallel work)
