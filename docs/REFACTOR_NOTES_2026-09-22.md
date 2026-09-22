# Refactor notes — `screenshot-version` (2026-09-22)

Review and refactor of the tree at `028d521` (version 2.0.0, clean) the day before the Chrome Web Store
submission, building on `docs/TECHNICAL_REVIEW_2026-09-21.md` and `docs/REFACTOR_NOTES_2026-09-21.md`
rather than redoing them. Bar: no regression of any functional or non-functional behaviour. No git
command was run; the working tree holds every change, grouped into commit units in §3.

Verification (details in §6): `npx tsc --noEmit` clean, `npm run build` clean, `npx jest` **802/802 across
26 suites** (was 789/789 across 25; no test deleted). `content.js` 191,667 → 190,971 bytes, `background.js`
26,316 → 26,316. Every `<style>` sheet the bundles emit is rule-for-rule identical to the baseline build
(checked mechanically, §6). No browser was opened and no Playwright test was run, by instruction; §7 lists
what only a browser can prove.

The 2026-09-21 review's §5 "What NOT to change" list was checked against every change: closed shadow roots,
the page-shrink machinery, keyboard isolation, the event-level scroll lock, the hand-rolled base64 decoder,
the measured crop scale, the double rAF, the serialised write queue, id allocation in the service worker,
data-URL images in IndexedDB, JPEG thumbnails, the session/local split — none touched. Motion values
(durations, easings, springs, choreography) are untouched; §4 records observations only.

---

## 1. Findings

### 1.1 Architecture (module boundaries, message contract, state ownership, data model)

Sound, and the earlier review's assessment still holds. What I checked specifically after the newest work
(drawing, format v2, dark-only, wheel routing, the SVG outline):

- **Content script ↔ service worker.** `messages.ts`'s `MessageMap` + `rpc.send()` + `background.ts`'s
  handler table is enforced at both ends; the two pencil-colour messages fit the pattern. One gap on the
  *other* direction: the background→content listener in `content.ts` was untyped (`any`) and replied to
  PING with an untyped literal, although `BackgroundToContentMessage`/`PingResponse` exist for exactly that.
  Fixed (§2, commit 5).
- **State ownership.** Unchanged from the review (module singletons on the content side; the enlarged view is
  a per-open instance; the service worker owns storage). The drawing layer lands correctly: strokes are
  add-mode state, `FeedbackItem.drawing` is item data, the pen colour is browser-session state behind the
  service worker. Nothing leaks.
- **Data model.** `Drawing` is an optional field with no migration need (correct); export composites it
  into the PNG and the bundle carries only the alt-text marker (correct per §AB/§AC); import rebuilds an item
  without it (consistent). `DomainMeta.version` is still unread — kept as the hook it is documented to be.
- **Bundle format.** `bundle/index.ts` dispatched the reader on `FORMAT_VERSION` (the version this build
  *writes*) instead of the v2 codec's own `FORMAT_VERSION_V2`. Identical today (both 2), but the first v3
  would have routed v3 files to the v2 decoder and refused every v2 file already on disk — the opposite of
  the design the file's own banner describes. Fixed, with a test pinning `FORMAT_VERSION === FORMAT_VERSION_V2`.
- **Storage.** Layout and keys untouched. `readIndex`'s shape check was typed as a loose partial and then
  double-cast (`as unknown as DomainIndex`); the predicate now names the type it is actually vouching for.
  `saveDomainData` had no caller in `src/` or tests.

### 1.2 Low-level design

- **Dead code left by removed features.** Theme switcher: three comment blocks in `sidebar.ts` describing a
  "theme toggle" in the header, a `registerThemedHost`/`data-theme` sync that no longer exists, and two
  orphaned doc-comment fragments with no declaration under them; one in `addMode.ts` claiming light/dark
  switches restyle add mode live. Modal/toolbar: comments in `enlargedView.ts`, `thumbnails.ts`,
  `messages.ts`, `sidebar.ts` describing the code by reference to `modal.ts`/`toolbar.ts`. Whole-record
  storage: two banners in `background.ts` and one comment in `export.ts` still explaining the write queue and
  a read as "storage.ts rewrites the whole record" / "a first read of a legacy record migrates it in place" —
  the split layout replaced the former and the amendment of 2026-09-21 removed the latter.
  `EnlargedViewHandle.setLogoSrc` had exactly one caller, in `initSidebar`, at a point where
  `enlargedView` is provably always `null`; `EnlargedViewHandle.relayout` had none. `FieldReader.optionalBoolean`
  in `bundle/v2.ts` was never called (written for a `truncated` flag the format never got).
  `imageStore._resetConnectionForTests` had no caller in the tests either. All removed (§2).
- **Duplication.** The scrollbar-excluded viewport (`documentElement.clientWidth || innerWidth`) was
  written three times — `capture.ts` (documented as the one source), `sidebar.ts`'s `viewportRightEdge`,
  `enlargedView.ts`'s `viewportSize` — and it is load-bearing (§5 of the review: selection bounds and the
  panel edge must agree). Now one function in `dom.ts`. `sidebar.ts`'s `makeGhostButton` and
  `makeIconButton` were byte-identical apart from the class string; `dockMotion?.setSuspended(dockSuspended
  || enlargedDockSuspended)` was written three times; `enlargedView.ts` faded the header bar and the editor
  together in six places with the same options. Folded.
- **Over-long functions.** `initSidebar` was ~150 lines of listener wiring across three unrelated groups;
  now `wireAddGroup()` / `wireExportGroup()` / `wireChrome()`, which are also the seams a future file
  split (review F-06) would cut along. `layoutCards`, `handleIsolatedKeydown` and `beginCollapse` are long
  but each is one coherent choreography; left alone.
- **Type looseness.** `addMode.ts` spelled `{ width: number; height: number }` twelve times for one
  concept (now `type Bounds = ViewportSize`); `window.__annotatorActive` went through `(window as any)`
  (now a typed global augmentation); the background→content listener (above).
- **Swallowed errors.** One real one, in `content.ts`'s import flow: if `GET_DOMAIN_ITEM_COUNT` answered
  `{ ok: false }` (a storage read failed) the count was taken as **0**, §5 #10's "this will replace your N
  items" confirmation was skipped, and `IMPORT_REPLACE` went ahead — a replace-without-confirmation on the
  one path where the user most needs the confirmation. `DOMAIN_COUNT_FAILED_MESSAGE` existed in `copy.ts` for
  this case and was never shown by the content script. Fixed as a behaviour change, listed separately in §5.
  Every other `catch {}` in the tree is documented and deliberate (chrome.* guards, best-effort cleanups,
  the font loader) — none hides a user-facing failure.

### 1.3 Findings NOT acted on, and why

| Finding | Decision |
|---|---|
| `UPDATE_NOTE` message + `handleUpdateNote` + `storage.updateNote` are a compatibility alias no current code sends (every caller sends `UPDATE_ITEM`). | Kept. Its stated purpose — a content script from an older build still alive on a page keeps saving across an extension update — is real for anyone upgrading from a dev build to 2.0.0. Remove in the release after 2.0.0 (message, handler, storage wrapper, ~6 tests in `background.test.ts`/`storage.test.ts`). |
| The chevron menu (`sidebar.ts`) and the pencil menu (`addMode.ts`) duplicate ~80 lines of open/close/keyboard/outside-pointerdown logic. | Not extracted. The two differ in placement (the pencil menu flips above), disabled gating, and how keys reach them (direct listener vs. the keyboard-isolation hook). A shared controller is a real improvement but is behaviour-adjacent in keyboard handling and needs a browser check; not the day before shipping. |
| `addMode.ts` imports `getSidebarWidth`/`DEFAULT_THUMBNAIL_BOX_SIZE` from `sidebar.ts` (review F-08's "overlay → panel" arrow). | Left. Changing it means a `deps` parameter on `startAddMode` and test-harness changes. |
| `--annotator-sidebar-width` is written on `<html>` "so other extension surfaces can track the width" — nothing reads it but three sidebar tests. | Left. Removing it changes the page's inline style and the tests; harmless as is. Candidate for a later cleanup. |
| `CaptureErrorCode` is never read downstream; `handleUpdateItem` ignores storage's `found` result (review F-14). | Left, as the review recommended for a later pass. |
| `handleImportReplace` builds the item field-by-field, so a future codec that decoded `drawing` would have it silently dropped. | Left; today no codec decodes one (the bundle carries pixels only). Worth a spread of the optional field when a codec gains it. |
| `refreshThumbnails` has no request token; `contextCapture`'s walk cost on huge selections (review F-15). | Left; not bugs today. |
| `deleteDomainData` has no production caller (tests only). | Kept — it is the storage module's natural counterpart to `replaceDomainData` and is covered. |
| Three spellings of the same two easing curves: `cubic-bezier(.2, 0, 0, 1)` in `sidebar.ts`, the same inline in `addMode.ts`, `STD.css`/`ACC.css` in `flip.ts`. | Left. Unifying changes the emitted stylesheet text (`.2` vs `0.2`), which the brief rules out; see §4. |
| `sidebar.ts` (3,070 lines) and `enlargedView.ts` file splits (review F-06/F-07), CSS out of TS (F-09), `content.ts`'s IIFE/singletons (F-08). | Deferred, as the previous notes deferred them: they want the Playwright `SELECTORS` run as the checkpoint. The `wire*` split above makes the seams explicit without moving anything. |
| `LIGHT_THEME` and the dark-only token machinery. | Kept unused on purpose, per the brief. |
| `background.ts`'s private `clamp` copy. | Kept on purpose (previous notes: the service worker has no reason to import the motion toolkit). |
| `tests/helpers/extension.js` says the add button's aria-label is state-dependent ("add note (on)"); it is fixed since §Y. | Comment only, in the Playwright helper; not touched, flagged for the docs pass. |
| `TECH_DESIGN.md` mentions `saveDomainData` (removed here). | Docs are out of scope by instruction; flagged for the docs pass. |

---

## 2. Changes, with why each is behaviour-preserving

### 2.1 Dead code and stale comments outside the UI modules

- `src/storage.ts` — `saveDomainData` removed (no caller anywhere); `isRecordLike` → `isDomainIndex`, a
  predicate typed for what it returns, removing the `as unknown as DomainIndex` cast in `readIndex`. The
  runtime check (object with `meta` and `pages` objects) is character-for-character the same. Header
  comment no longer names the removed function.
- `src/imageStore.ts` — `_resetConnectionForTests` removed (no test called it).
- `src/bundle/v2.ts` — `optionalBoolean` removed (never called); the local `DecodedItem` type is now the
  exported `DecodedBundleItem`, so the shape exists once. `src/bundle/index.ts` re-exports it (same
  public name and shape as before) and dispatches the reader on `v2.FORMAT_VERSION_V2` (see §1.1). Both
  constants are 2, so every input takes the same branch it did.
- `src/background.ts`, `src/export.ts` — comments only: the queue rationale now describes the split
  layout (index read-modify-write, per-item keys); the two "legacy record migrates on read" comments
  describe what the queued read actually buys (a count / export that reflects every write queued before it).
- `src/messages.ts`, `src/thumbnails.ts` — comments only ("the modal" → the enlarged view; "addMode/modal").
- `src/__tests__/bundle.test.ts` — one test added: `FORMAT_VERSION === FORMAT_VERSION_V2`.

### 2.2 One scrollbar-excluded viewport reader

- `src/dom.ts` — `getContentViewportSize()` moved here from `capture.ts` with its rationale expanded to
  name every consumer. Body unchanged (`documentElement.clientWidth || innerWidth`, same for height).
- `src/capture.ts` — imports it from `dom.ts` (no longer exports it; no test imported it from here).
- `src/addMode.ts` — imports it from `dom.ts`; `type Bounds = ViewportSize` replaces twelve inline
  `{ width: number; height: number }` annotations (type-level only); the stale light/dark comment above
  `ADD_MODE_CSS` is corrected (it is a `//` comment outside the template string, so the sheet is unchanged).
- `src/__tests__/dom.test.ts` — new: the viewport fallback and the layout case, `reducedMotionQuery`'s
  three outcomes, `requestAnimationFrameSafe`'s timeout fallback and its cancel.

### 2.3 `sidebar.ts` structure

- `initSidebar` keeps exactly the same statements in the same order; the listener block is now
  `wireAddGroup()` / `wireExportGroup()` / `wireChrome(shadow)`. Registration order within each element is
  unchanged, and the two capture-phase outside-pointerdown listeners are registered in the same relative
  order as before. The dead `enlargedView?.setLogoSrc(...)` line is gone (always a no-op: `enlargedView`
  is `null` whenever this code runs).
- `makeGhostButton` delegates to `makeIconButton`; the produced `<button>` (type, className, aria-label,
  title, `.icon` span with the SVG) is identical.
- `syncDockSuspension()` replaces the three inline `dockMotion?.setSuspended(dockSuspended ||
  enlargedDockSuspended)` expressions.
- `viewportRightEdge()` uses `getContentViewportSize().width`; `playItemRemoval` uses `dom.ts`'s
  `reducedMotionQuery()?.matches` instead of an inline `window.matchMedia?.(...)?.matches` — same value in
  every environment (both yield falsy where `matchMedia` is missing or throws).
- Comments: the file banner, three CSS-comment mentions of a theme toggle, the "same trick as toolbar.ts"
  and "carried over from toolbar.ts" lines, two orphaned doc fragments, and a stale "aria-label is
  state-dependent" doc comment (it is fixed since §Y; the following comment already said so). The three
  edits inside `SIDEBAR_CSS` are inside `/* */` comments; §6 verifies the sheet is rule-identical.
- `applyListHold`'s doc comment, which had drifted onto `playItemRemoval`, is back on `applyListHold`.

### 2.4 `enlargedView.ts` structure

- `fadeContent(to, opts)` = `fadeTo(head)` then `fadeTo(editor)` with the same options — the six call
  sites (`crossfadeContent`, `deleteCurrent` out and failure-in, `applyDeletion` both branches) call it with
  the exact durations/curves they used, in the same order.
- `setLogoSrc` and `relayout` dropped from `EnlargedViewHandle` (no callers; `relayout` is now a private
  method, still driven by `img.onload` and the resize rAF as before). `viewportSize()` reads
  `getContentViewportSize()`.
- Banner: two sentences that explained the module by reference to the deleted `modal.ts` reworded.

### 2.5 `content.ts`

- The background→content listener is typed `BackgroundToContentMessage`; PING replies through a
  `PingResponse` value; `ACTIVATE` reads `message.tabId` without a cast. `window.__annotatorActive` is a
  typed global (`true | undefined`); the reads/writes are unchanged.
- **Behaviour change** (§5): the import flow stops when the existing-item count cannot be read.
- `src/__tests__/content.test.ts` — the import flow had no coverage at all; five tests added (replace
  without asking on an empty domain; §5 #10 asked with the real count and honoured for yes and no; a
  failed count read stops the import with `DOMAIN_COUNT_FAILED_MESSAGE`; a dead worker at the count step
  stops it with `IMPORT_FAILED_MESSAGE`; the import item is re-enabled afterwards). `parseImportBundle` is
  mocked there because the ladder has its own suite.

---

## 3. Commit units

In this order (each compiles and passes on its own; 3 needs 2, 4 needs 2 and 3, 5 is independent of 2–4).

1. **`storage, bundle: drop unused surface; read each codec by its own version; comments catch up with the split layout`**
   `src/storage.ts`, `src/imageStore.ts`, `src/bundle/index.ts`, `src/bundle/v2.ts`, `src/background.ts`,
   `src/export.ts`, `src/messages.ts`, `src/thumbnails.ts`, `src/__tests__/bundle.test.ts`
2. **`dom: one scrollbar-excluded viewport reader for capture, add mode, the panel and the enlarged view`**
   `src/dom.ts`, `src/capture.ts`, `src/addMode.ts`, `src/__tests__/dom.test.ts`
3. **`sidebar: split initSidebar's wiring by group, one icon-button factory, shared helpers, stale theme-toggle comments`**
   `src/sidebar.ts`
4. **`enlargedView: fold the header+editor fade pairs, drop the handle's unused methods`**
   `src/enlargedView.ts`
5. **`content: type the background→content channel; stop an import whose existing-item count cannot be read`**
   `src/content.ts`, `src/__tests__/content.test.ts` — contains the one behaviour change (§5). If you
   want the fix on its own for the changelog, `git add -p` the `handleImportFile` hunk and its five tests
   into a separate commit after the typing hunks.
6. **`docs: refactor notes 2026-09-22`**
   `docs/REFACTOR_NOTES_2026-09-22.md`

---

## 4. Motion-design observations (recommendations only — nothing implemented)

Lens: the LottieFiles motion-design skill (Corporate archetype, as `design/MOTION_SPEC.md` declares) against
`dockMotion.ts`, `flip.ts`, `enlargedView.ts`, and the CSS transitions in `sidebar.ts`/`addMode.ts`. All
approved values stay as they are; these are for a later, supervised motion pass.

**Passes the skill's checklist as built**
- Directional easing is consistent: `STD` for anything that stays on screen, `ACC` for exits (the delete
  shrink, content-out, fade-outs), including the CSS-only menus (`.action-menu`, `.draw-menu`: 120ms std
  in / 90ms acc out) — entrances longer than exits everywhere it matters (expand 450 / collapse 340).
- Stagger budget: title 200 → editor 250 → rail 300 is a 50ms Corporate cascade, total < 400ms.
- Reduced motion is handled live in every module (media-query change listeners, crossfades only, halved
  durations) and the dock switches its whole layer off — better than the skill's minimum.
- Interruptibility (MOTION_SPEC §13 option (a)) is real: analytic tweens in `flip.ts`, retarget from the
  live rect, one `finish()` teardown. This is the strongest part of the motion code.
- The empty-note shake (±4px, 2 cycles, 200ms) is a deliberately toned-down Error Shake; fine for Corporate.
- The dock spring's ζ = 0.92 tracking / ζ = 1 release: the ~0.2% overshoot is inside the archetype's 0–3%.

**Worth a look later (HIGH/MEDIUM on the skill's severity tiers)**
1. *Layout-property animation* — `.thumbnail-item.is-removing` transitions `max-height` and
   `margin-bottom` (the list close-up), and `.add-switch` reveals by transitioning `width`, `padding`,
   `margin-left` and `border-width`. Both reflow the panel every frame. They are small, contained subtrees
   and the durations are short (180 / 160ms), so jank is unlikely, but the skill lists layout animation as
   CRITICAL. Alternatives that keep the look: FLIP the rows below a removed note with `translateY`; reveal
   the switch with `clip-path: inset()` + a transform on the knob.
2. *Symmetric reveal/collapse on the switch* — 160ms both ways (plus the 250ms grace on collapse, which is
   a usability affordance, not motion). The skill's "exit 30–50% shorter" rule would put the collapse
   around 110–120ms. Cosmetic.
3. *Peek hover* — enter 90ms / leave 180ms `translateY(±7px)`. Entrance shorter than exit, which inverts
   the skill's rule, but for hover feedback (< 100ms in) a slower release reads as a settle. Deliberate;
   document it in `MOTION_SPEC.md` §9 so it isn't "fixed" later.
4. *Naming* — `T.badgeDelayIn` (150) is also the wordmark's fade-in delay and the expand-time delay of a
   card with no list rect; `T.scrimOut` (150) is also the badge's fade-in on collapse. Give the reused
   values their own names (same numbers) so a future retune of the badge doesn't move the wordmark.
5. *Three spellings of two curves* (§1.3) — `sidebar.ts`'s `EASE_STD`/`EASE_ACC`, `addMode.ts`'s inline
   literals, `flip.ts`'s `STD.css`/`ACC.css`. Same curves; unify under `flip.ts` when a stylesheet text
   change is acceptable.
6. *`.thumbnail-note-bg`'s CSS transition vs the dock spring* — already handled by the `[data-dock="on"]`
   override; nothing to do, noted because it is the pattern to copy if another element joins the spring.

---

## 5. Behaviour changes (exactly one)

**Import stops when the existing-item count cannot be read** (`src/content.ts`, `handleImportFile`).
Before: `GET_DOMAIN_ITEM_COUNT` → `{ ok: false }` or `undefined` was treated as "0 items", §5 #10's
confirmation was skipped, and `IMPORT_REPLACE` was sent — replacing the domain unconfirmed (on a dead
worker it then failed anyway, on a failed storage read it succeeded). After: the sidebar shows
`DOMAIN_COUNT_FAILED_MESSAGE` ("couldn't check existing feedback. try again.") for `ok: false`, or
`IMPORT_FAILED_MESSAGE` for a dead worker (the same message the old path ended on), nothing is replaced,
and the import item is re-enabled. The happy paths (count 0 → replace; count N → confirm → replace/cancel)
are unchanged and now tested. Copy is existing `copy.ts` text; nothing new is shown to the user.

---

## 6. Verification

| Check | Baseline (028d521) | After |
|---|---|---|
| `npx tsc --noEmit` | clean | clean |
| `npm run build` | clean | clean |
| `npx jest` | 789 passed / 25 suites | **802 passed / 26 suites** (+13: 5 import-flow, 1 bundle version, 7 dom) |
| `dist/content.js` | 191,667 B | 190,971 B (−696) |
| `dist/background.js` | 26,316 B | 26,316 B |
| Frozen fixture `src/__tests__/fixtures/feedback-v2.md` | byte-exact | byte-exact (bundleV2.test.ts, unchanged) |

Tests deleted: none. Tests changed: none of the existing ones (only additions).

Stylesheet equivalence: every backtick template in the baseline and new `content.js`/`background.js` that
is a stylesheet (five in content, the page-resize rule in background) was extracted, `/* */` comments
stripped, whitespace collapsed and minifier variable names normalised — all identical. The only
differences inside any `<style>` text are the three CSS-comment rewordings in `SIDEBAR_CSS` (§2.3).

Also verified by reading: the minified bundles contain no new `fetch(`, `eval`, inline handler or
network capability; `manifest.json` untouched; storage keys and the message `type` set untouched.

Playbook passes run over the diff before finishing: the code-reviewer checklist (correctness, naming,
duplication, error handling, resource management — the `wire*` split registers every listener the old
block did, and `destroySidebar` still removes the two it needs to), and the silent-failure-hunter
checklist (no new `catch {}`; no new fallback value; the one change to error handling surfaces a
failure that was previously converted into a default).

---

## 7. Browser-only checks (in priority order)

1. **Import flow on a domain with existing notes** — pick a valid zip: the §5 #10 dialog must quote the
   real count; cancel leaves everything as it was; ok replaces and repaints. Then stop the service worker
   (chrome://serviceworker-internals) and import again: an error banner, nothing replaced, and "import"
   in the chevron menu is enabled again. Import on a domain with no notes: no dialog, straight replace.
2. **Sidebar action row and chrome** (`initSidebar`'s wiring moved between functions): add-note click,
   double-click, shift+click, shift+Enter, the switch click both on and off; export click; chevron menu
   by mouse (focus stays on the chevron) and by Enter/ArrowDown (focus on "import"); Esc, Tab and an
   outside click close it; "import" opens the picker; close button; resize by drag and by arrow keys /
   Home / End on the handle — width persisted across reload.
3. **Enlarged view** — open, ↑/↓ (including mid-morph), delete a note and force a delete failure (stop
   the worker): the header bar and editor must fade out and back exactly as before; collapse; the riding
   logo + wordmark show while expanded.
4. **Selection bounds with a scrollbar** — on a long page, drag a selection flush against the sidebar's
   edge: no sidebar pixels in the capture (the viewport reader moved modules; code identical).
5. **Add mode and enlarged view geometry at a narrow window** and with browser zoom 150%.
6. **Fresh capture on a new domain** (index + item keys written, thumbnails paint) and a note edit
   autosave (`isDomainIndex` shape check).
7. **Export / import round trip** — unchanged format; the fixture test proves the bytes.
8. Load the built `dist/` into Chrome at all (the bundles were rebuilt; the minified output is exercised
   only by a browser).
