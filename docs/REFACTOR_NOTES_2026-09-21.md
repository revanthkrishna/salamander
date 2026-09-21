# Refactor notes — branch `refactor/technical-review` (2026-09-21)

Implements the technical review of the same date (`docs/TECHNICAL_REVIEW_2026-09-21.md`), Checkpoints 1
and 2 in full, the two behaviour-preserving halves of F-07, F-13's comment policy and F-17's low-risk
tightenings. Fourteen commits on top of `screenshot-version` (`d34c9b5`), one per finding, so any one can
be dropped with a single `git revert`. Nothing was pushed; `main` and `screenshot-version` are untouched.

Verification available to this session: `npx tsc --noEmit` (clean, now with `noUnusedLocals`),
`npm run build` (clean), `npx jest` — **669/669 across 21 suites** (was 599/599 across 16). No browser
was opened and no Playwright test was run, by instruction. §4 below lists everything that only a browser
can prove; read it before trusting anything visual or anything that touches real Chrome storage.

Every change was checked against the review's §5 "What NOT to change". None of it is touched: the
closed shadow roots, the page-shrink machinery, the keyboard isolation, the event-level scroll lock,
the hand-rolled base64 decoder (now in `dataUrl.ts`, with its banner), the measured crop scale, the
double rAF, the serialised write queue (still there; F-04 still needs it for `nextItemNumber`), id
allocation in the service worker, data-URL images in IndexedDB, JPEG thumbnails, the theme echo
suppression, the session/local split for sidebar state, and every UI detail in the list.

---

## 1. What changed, finding by finding

Commits are listed in the order they were made, which is the review's own sequence.

### F-16 · `947fad6` · remove the dead and test-only surface
- Deleted `storage.ts`'s legacy `activeTab:{tabId}` helpers and `background.ts`'s `onStartup` cleanup
  hook (nothing has written those keys since sidebar state moved to `chrome.storage.session`);
  `imageStore.clearAllImages` (no caller); `showWarning`'s never-passed `customIcon` parameter.
- `destroySidebar` now unregisters the host from `theme.ts`'s themed-host set (it registered and never
  let go). `theme.ts` keeps a reference to its `chrome.storage.onChanged` listener so
  `_resetThemeStateForTests` can remove it. `FONT_ASSET_PATHS` is no longer exported.
- **Kept, against the review:** `isSidebarInitialised`, `isEnlargedViewOpen`,
  `setDockMagnificationSuspended`. The review counted them as unused exports; ~20 assertions in three
  test files reach them. Their doc comments now say "for the tests" instead of claiming a production
  caller.
- Config: `package.json` name/version now match `manifest.json` (`salamander` / `1.1.0`);
  `@types/js-yaml` moved to devDependencies (lock file edited by hand to match; `npm ls` is clean);
  `jest.config.js` uses the `transform` form of ts-jest options (the deprecation warning on every run
  is gone).

### F-11 · `bed70b5` (+ tests `cf964ef`) · shared copy / dataUrl / icons / dom modules
- `src/copy.ts` — every user-facing string once, including the §5 import-error table and the two
  parameterised messages. Five strings were declared twice (once per bundle).
- `src/dataUrl.ts` — the four codecs from `background.ts`, `export.ts` and `import.ts`, sharing one
  chunked base64 pair; the `connect-src 'none'` / never-`fetch(dataUrl)` rationale is written once.
  The throwing `fetch` stub stays in `background.test.ts` as the regression guard.
- `src/icons.ts` — the whole stroke-icon set. Output is byte-identical (assembled from the same
  attribute strings and paths). The `thumbnails.ts → sidebar.ts` one-way import that forced
  `ICON_TRASH` to live in `thumbnails.ts` is gone.
- `src/dom.ts` — `reducedMotionQuery`, `requestAnimationFrameSafe` / `cancelAnimationFrameSafe`
  (were duplicated in `dockMotion.ts` and `enlargedView.ts`). The shared rAF checks
  `window.requestAnimationFrame` per call rather than once at attach; same answer in a browser.
- `clamp` moved into `flip.ts` for `addMode.ts`. **`background.ts` keeps its own three-line copy on
  purpose:** the service-worker bundle has no reason to import the motion toolkit.
- `cf964ef` adds `copy.test.ts`: the §5 rows were only ever asserted by code, not text.

### F-12 · `024c0bf` · minify both bundles
- `esbuild.config.js`: `minify: true`, sourcemaps kept. `content.js` 373 KB → 208 KB,
  `background.js` 139 KB → 62 KB. Nothing in `src/` reads a function/class `.name` at runtime.
- **Not done: moving zip parsing + the §5 ladder into the service worker** (the −100 KB step).
  See §2.

### F-18 · `9ffc94b` · the storage boundary, written down
- `TECH_DESIGN.md` "Storage boundary": feedback data and blobs only via the service worker; UI
  preferences (`themeMode`, `sidebarWidth`, and later "which connection") may be read/written directly
  from either context, with the reason. `storage.ts`'s header says the same instead of the stricter
  claim `sidebar.ts`/`theme.ts` already contradicted. No code change.

### F-01 · `fa7cbd3` · item update path + migration hook
- `types.ts`: `ItemPatch = Partial<Pick<FeedbackItem, 'note'>>` — the one place mutable fields are
  listed. `storage.updateItem(domain, url, id, patch)` resolves `found: boolean` (the handler does not
  surface it yet — that is F-14, out of scope). `updateNote` is a one-line wrapper.
- `messages.ts`: `UPDATE_ITEM` with a `patch`; `content.ts`'s autosave sends it. `UPDATE_NOTE` stays
  as a thin alias so an older content script still on a page keeps saving.
- `storage.migrateDomainData(raw)` (renamed `migrateInlineRecord` in F-04) is the read-path hook,
  called on every load with write-back once.
- **Decision not taken:** whether `context.pageMeta` stays a self-contained duplicate of five item
  fields. The review says "either is fine, decide before the export revision". That is a product
  call; recorded here, not made. (My recommendation: keep it — `types.ts`'s rationale that the YAML
  block must read standalone is still true, and the v1 fixture now pins that shape anyway.)

### F-03 · `dfb1200` · frozen v1 bundle codec behind a versioned reader
- `src/bundle.ts` → `src/bundle/{index,v1,version}.ts`. `v1.ts` is the grammar, the yaml mirror
  types (moved out of `types.ts`), both codecs and the parser, moved verbatim and **frozen**.
  `index.ts` exposes the current-version writer and `decodeFeedbackMarkdown()`, which dispatches on the
  line-1 stamp and upgrades to the in-memory `FeedbackItem` shape. A newer version is read best-effort
  with the newest codec and flagged (§5 #6's "warn and proceed", unchanged).
- `src/__tests__/fixtures/feedback-v1.md` is real text generated once and committed;
  `bundleV1.test.ts` pins it from both sides (decode → hand-written items; v1 writer → byte-identical
  text). It also records that js-yaml quotes the `y` key (`'y': 1188`, a YAML 1.1 boolean) — a v2
  reader must accept that.
- `import.ts`'s ladder calls the reader once; every §5 code and the order are unchanged
  (`import.test.ts` is untouched except one import path).
- **Not done:** the grammar hardening (fence info string; requiring the image line to open an item).
  Both change what the writer emits, so they are the first v2, not a v1 fix.
- **Not done:** a declarative field table replacing the twin mappers. A blind deep camel↔snake
  converter would mangle `attrs` keys (HTML attribute names such as `data-track` / anything with an
  underscore), so explicit codecs stay — now beside the grammar, which is the review's alternative.

### F-04 · `e55d913` · split the domain record
- Schema version 2: `domain:{domain}` → `{ meta, pages: { url: id[] } }` (the index) and
  `item:{domain}:{id}` → `FeedbackItem` (thumbnail inline). `getPageItems` is one index read + one
  multi-key get of that URL's items; `updateItem` writes that item's key only; `addItem` writes item
  + index in one `set`; `replaceDomainData`/`deleteDomainData` also remove the item keys the new
  record no longer references, writing the new record first so a torn write leaves orphan keys rather
  than a broken index.
- Consumers still see `DomainData`: `getDomainData` assembles (`assembleDomainData`), the write
  primitives split (`splitDomainData`); both pure and exported. `splitDomainData` stamps
  `STORAGE_VERSION` regardless of the input's `meta.version`, so no caller can write an index the next
  read would mistake for a legacy record.
- Migration: `readIndex()` — every entry point goes through it — recognises a version-0/1 inline
  record, runs `migrateInlineRecord` (pure, one `case` per step) and writes the split layout back
  once. A record stamped newer than this build is read as an index as-is. The write-back happens
  inside the caller's queue slot; `handleGetDomainItemCount` and `exportDomain`'s read now go through
  the queue too so a first-read migration cannot overlap a queued write.
- `TECH_DESIGN.md`'s storage tier describes the new layout.

### F-05 · `6debc37` · typed message channel
- `messages.ts`: `MessageMap` (`[request, response]` per type), `ResponseFor<M>`, `MessageHandler`,
  `MessageHandlers`; a compile-time guard pins the map's keys to `ContentToBackgroundMessage['type']`
  in both directions.
- `src/rpc.ts`: `send(message)` — the response type follows the request; never rejects, `undefined`
  on a dead worker / invalidated context (the exact contract of the two private helpers it replaces).
- `background.ts`: the string `switch` is a `handlers: MessageHandlers` table; a missing key or a
  wrong response shape is a compile error. Exported handlers and `handleRuntimeMessage`'s signature
  and true/false semantics are unchanged.
- No port-based variant (the review says: when a long-running call arrives, not before).

### F-07 (part) · `b79e4f4` · autosave controller + media wrapper
- `src/autosave.ts`: `AutosaveController<T>` owns draft / stored / in-flight / failed / sequence
  tracking with `equals`, `savable`, `save` and the settle callback injected. The dirty rule, the
  single pending debounce, the superseded-reply drop and the failed-set retry on flush are the view's
  rules moved verbatim. The save is dispatched synchronously (the page-unload flush depends on it).
  `enlargedView.ts` keeps the note policy on top (`savable` = not blank; `onSaveSettled` is the old
  then-branch: `item.note`, status slot, banner, `listDirty`).
- `.xp-card-media`: a span between `.xp-card-frame` and the `<img>` that carries the contain-fit box
  and the morph's counter-transform track; the `<img>` fills it at 100%. `flip.ts`'s
  `MorphKeyframes.img` is renamed `media`. The Playwright selector `.xp-card.is-main .xp-card-img`
  still matches. A future annotation canvas is a sibling of the `<img>` inside the transformed box.
- **Not done (out of scope by instruction):** the `EnlargedView` state union, and `cycleFocus` over
  `[data-xp-focus-order]`.

### F-13 · `465ebeb` · comment policy
- All 83 "Phase N" narrations removed from `src/` (16 modules, 9 test headers). Section banners
  retitled by content; past-tense change logs rewritten as the rule they protected (the crop
  deliberately does not come back inline; sidebar-open state is deliberately not written from the
  content script). Every constraint / rejected-alternative comment is kept verbatim.
- The one-line policy is in `TESTING.md`. §-pointers into the design spec are untouched (that is the
  F-10 spec consolidation, not attempted).
- This is its own commit so it can be dropped independently; it is comments only.

### F-17 · `db2e505` · illegal-state tightenings
- `ImportErrorCode` loses `'VERSION_MISMATCH'` (never thrown; `versionWarning` already models it).
  `content.ts` shows `IMPORT_VERSION_WARNING_MESSAGE` directly.
- `AddButtonState`: `'locked'` → `'kept-on'`; `content.ts`'s `addLocked` → `addKeptOn`. No DOM
  attribute carried the raw string.
- `tsconfig.json`: `noUnusedLocals: true`. It flagged one thing — see §5 (a real finding).
- **Not done:** the `state` + `deleting` + `collapseAfterDelete` union in `EnlargedView` (touches the
  delete/collapse choreography in five places; not for a session that cannot look at a frame).
  `noUncheckedIndexedAccess` skipped as the review suggests.

### F-10 (docs) · `0246559` · factual corrections
- `TECH_DESIGN.md`: the three stale add-mode sentences (200×150 box, 8 handles, cancel/ok) corrected;
  file inventory regenerated from `wc -l` on this branch, with the new modules and
  `keyboardIsolation.ts` (never listed). `TESTING.md`: counts (669 / 21 files), the test list, the
  build line. `README.md`: `src/bundle/`.
- **Not done:** the spec consolidation, `DEVELOPMENT_PLAN.md`'s retirement, the §→decision-ID rewrite.

---

## 2. What was skipped, and exactly why

| Item | Status | Why |
|---|---|---|
| **F-02** connections/MCP vs `connect-src 'none'` | Not touched | Product decision, by instruction. The CSP is unchanged, no network capability was added, `README.md`'s privacy claim is still true. |
| **F-06** split `sidebar.ts` | Not touched | Deferred to a supervised session, by instruction: the Playwright `SELECTORS` are the checkpoint and cannot be run here. Not even the "pure moves". |
| **F-08** `App` object / per-session add mode | Not touched | Same. |
| **F-09** CSS out of TypeScript | Not touched | Same. |
| **F-12** import move to the service worker | Skipped | It turns `IMPORT_REPLACE` into a two-message validate/commit exchange. The failure mode — the service worker being killed while the user sits on the §5 #10 `confirm()` dialog for >30 s, losing the parsed bundle — is real and only observable in Chrome. Re-sending the bytes on commit avoids it but doubles the transfer. Worth doing with a browser open; not blind. With minify alone the content bundle is already 208 KB. |
| **F-03** grammar hardening, field table | Skipped | The hardening is a v2 format (changes the writer). A blind deep key converter would mangle `attrs` keys. See F-03 above. |
| **F-01** `context.pageMeta` duplication | Recorded, not decided | Product decision the review asks the user to make. |
| **F-07** state union, focus ring by data attribute | Skipped | Out of scope by instruction; the union is behaviour-adjacent. |
| **F-17** `noUncheckedIndexedAccess` | Skipped | As the review suggests: low value. |
| **F-10** spec consolidation etc. | Skipped | Only the factual corrections were in scope. |
| **F-14, F-15** | Not touched | Not in scope. F-14's `found` result from `updateItem` is now available for it. |
| **§5 "What NOT to change"** | Nothing needed to contradict it | Checked per commit; no change required a §5 exception. |

Delete-no-coverage: one test was removed with its code (`handleStartup` in F-16); everything else was
updated or added. Net +70 tests.

---

## 3. Things to check first in a browser (top three)

1. **F-04 storage migration on a real profile.** Load the unpacked build on a profile that has v1
   data (any domain captured before this branch). Open the sidebar on that domain: the list must show
   every item; in the service-worker console `chrome.storage.local.get(null, ...)` must now show
   `domain:{domain}` with `pages: { url: [ids] }`, `meta.version: 2`, and one `item:{domain}:{id}` per
   item, and the old inline record gone. Then edit a note, delete an item, export, import — and
   confirm a second load writes nothing new (no repeated migration).
2. **F-07 the enlarged view's morph.** Click a thumbnail, use ↑/↓ (including mid-morph), delete a
   note, collapse, and do it once with reduced motion on. The screenshot must never squash or show a
   letterbox band mid-morph, and the corners must stay rounded — the `.xp-card-media` span is now what
   the image track transforms.
3. **F-05 / F-01 the round trips.** Capture → edit a note (autosave 700 ms) → export → import the
   zip. Every message now goes through `rpc.send()` and the handler table; autosave sends
   `UPDATE_ITEM`. Also try with the extension reloaded while a page stays open (the "context
   invalidated" path must still fail quietly, not throw).

---

## 4. What is unverified (jsdom cannot establish it)

**Chrome APIs / storage**
- F-04 migration under real `chrome.storage.local` (jsdom's mock is a plain object; array `get`,
  multi-key `set` atomicity, quota behaviour with many `item:` keys are all assumed from the docs).
- F-04 read-after-write ordering with real IndexedDB + `chrome.storage` latencies (the queue
  serialises within one service-worker lifetime; a SW restart between a migration's `get` and its
  write-back cannot be simulated).
- F-05 `chrome.runtime.sendMessage` callback/`lastError` behaviour — exercised only through mocks.
- F-16 `chrome.storage.onChanged.removeListener` on the real API (guarded; tests use a mock).
- F-12 that the minified bundles load and run at all in Chrome (esbuild minify is standard, but no
  one has loaded `dist/` since).

**Visual / motion**
- F-07 media wrapper: geometry and radius equivalence is argued, not seen. Reduced-motion path too.
- F-11 icons: byte-identical strings, but no one has looked at the rendered glyphs.
- F-17 `'kept-on'` rename: labels/ARIA are asserted; the painted switch state is not.

**Behavioural**
- F-04: `exportDomain`'s read now goes through the save queue; the export is otherwise unchanged.
- F-13: comments only, but the reviewer should skim the rewritten banners in `messages.ts` and
  `content.ts` — they are the only places wording was *replaced* rather than trimmed.
- The Playwright suite (`tests/*.spec.js`) was not run. `SELECTORS` were checked by eye against every
  DOM change (only `.xp-card-media` was added; nothing renamed).

---

## 5. Found along the way (not in the review)

- **`sidebar.ts`'s `deferredItems` was write-only.** Assigned in `setThumbnails`, `openEnlargedView`
  and `destroySidebar`, read nowhere; its doc comment said the deferred refresh was "applied once
  [the view] has closed", which was never true. The behaviour was right (dropped, because `onClosed`
  re-reads storage) but the code lied about it. Found by `noUnusedLocals`; removed in F-17, the early
  return kept with the reason written where it is.
- **`handleGetDomainItemCount` and `exportDomain` read outside the save queue.** Harmless with v1's
  single-record layout; with a migrate-on-read it would have been a race. Both go through the queue
  now (F-04).
- **js-yaml quotes the `y` key.** `selection_rect: { x: 412, 'y': 1188 }` in every v1 bundle,
  because bare `y` is a YAML 1.1 boolean. Any hand-written or third-party parser of `feedback.md` has
  to accept the quoted form; the frozen fixture pins it.
- **`background.ts`'s crop banner said the domain record "is read in full every time the sidebar
  refreshes"** — no longer true after F-04; reworded in F-13.
- **The review's §5 line "Ids are allocated in the service worker; import preserves them"** still
  holds, but note `handleImportReplace` builds `DomainData` with `version: STORAGE_VERSION` — that is
  now redundant with `splitDomainData` stamping it, and deliberately left (belt and braces).
- **TESTING.md's test list never mentioned `keyboardIsolation.test.ts`'s companion module in the
  inventory** — the inventory table now has it.


---

## Amendment, 2026-09-21 (same day, after the browser pass)

**The v1 storage migration is removed.** No build with the older inline layout was ever published,
so no record of that shape exists anywhere and the migration could never fire. Removed:
`migrateInlineRecord`, the `storedVersion` helper, `readIndex`'s migrate-and-write-back branch, and
the frozen v1 fixture and tests that went with them (jest 669 → 663).

Kept deliberately: the `version` stamp on every index, and the place in `readIndex` where a version
branch would go. Those cost nothing and are what a FUTURE schema change needs — which is likely,
given the planned drawing-tool and export-format work.

NOT removed, because it is not backward compatibility: `src/bundle/v1.ts` and the version detection
beside it. v1 is the bundle format the extension writes and reads TODAY; the split exists so a
future v2 can be added alongside it without orphaning bundles people have already exported.

**Verified in Chrome after this change** (see the session log): export produces a valid 8.5KB zip
through `chrome.downloads`; a full round trip on one origin — capture, export, wipe storage, import
— returns both notes with their images and rebuilds the split layout; the enlarged view opens on an
imported item with the new `.xp-card-media` wrapper. The Playwright suite is 23 passed / 3 failed,
and those three are a harness fault, not a defect: they wait for a page-initiated download event,
while export downloads through `chrome.downloads` from the service worker, which never raises one.
