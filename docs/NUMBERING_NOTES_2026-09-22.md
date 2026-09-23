# Numbering notes — `screenshot-version` (2026-09-22)

Per-page display numbers, implemented on the tree at `98de6a7` (version 2.0.0, clean) ahead of the
Chrome Web Store submission. No git command was run; the working tree holds every change, grouped
into commit units in §8. Verification (§6): `npx tsc --noEmit` clean, `npm run build` clean,
`npx jest` **826/826 across 26 suites** (was 802/802; two existing assertions changed, §5). No
browser was opened and no Playwright test was run, by instruction; §7 lists what only a browser
can prove.

---

## 1. The rule

**The number shown for a feedback item is its 1-based position in its page's list
(`DomainData.pages[normalisedUrl]`, capture order), recomputed on every render.** Deleting an
item renumbers everything after it; an emptied page starts again at 1; every page has its own #1.

The internal id is untouched: unique per domain, allocated by the service worker
(`DomainMeta.nextItemNumber`, only ever grows, never reused), still the storage key
(`item:{domain}:{id}`), the IndexedDB image's link, and the export's screenshot filename
(`screenshots/{id}.png`). Nothing stored changes shape or value, so there is no migration: existing
data renumbers on its next draw. The one place the rule is written down is `FeedbackItem.id`'s doc
comment in `src/types.ts`; every renderer refers to it.

Where the number comes from at each surface:

| Surface | Source of the number | Where the id still lives |
|---|---|---|
| Sidebar list (`thumbnails.ts`) | `items.forEach((item, index) => …index + 1)` | `data-item-id` on the thumbnail and its delete button (sidebar.ts's `focusThumbnail`, `playItemRemoval`, the enlarged view's `getListThumb`) |
| Enlarged view (`enlargedView.ts`) | `numberOf(id)` = index in the view's own `items` copy + 1, read at every `setContent` (title), `setRole` (peek labels) and `syncBadges` (card badges, run from `layoutCards` and `beginCollapse`) | the card map key, `data-item-id`, every callback |
| Export (`bundle/v2.ts`) | `renderItem(item, index + 1)` over the page's array, unsorted | `screenshots/{id}.png`, json `id` |
| Import (`bundle/v2.ts`, `import.ts`) | the heading's number is read into `DecodedBundleEntry.number` for §5 #11 only | json `id` = the image line's id; ids preserved on write |

The list and the export can never disagree: both read the same array in the same order, and the
writer no longer re-sorts a page's notes by id (it did before — harmless for captured data, where
id order is capture order, but wrong for a hand-reordered import).

### The bundle

- `### feedback {n}` and the alt text `feedback {n}` carry the display number; the image path
  `screenshots/{id}.png` and the json `id` carry the internal id. The user chose id-named files so
  they stay unique across pages.
- **The display number is not written into the json.** It is the heading. A record that also
  carried its own position could disagree with where it sits after a hand edit, and §AC's "no field
  appears twice" rule would be broken by a value derivable from the file's structure. An agent that
  needs the number has the heading two lines above the block.
- The format marker stays **2**. Files written before this change (none published) would read fine
  — the reader takes the heading number as written — and would re-export renumbered.
- The reader's contract changed from "heading id = image id = json id" to "image id = json id;
  heading number taken as written". `DecodedBundle.items: DecodedBundleItem[]` became
  `DecodedBundle.entries: DecodedBundleEntry[]` (`{ number, item }`) so the importer can see the
  heading numbers without the number leaking into `ImportItemPayload` — the payload spreads only
  `entry.item`, and a test pins that no `number` field rides along.
- §5 #11 (`DUPLICATE_IDS`, copy unchanged: "this bundle appears to be corrupted (duplicate item
  ids).") now trips on either: the same internal id twice anywhere in the file (it is the storage key
  and the screenshot file — a repeat would collapse two notes into one), or the same heading number
  twice under one page. The same number on two pages is what every healthy export now looks like
  and is accepted. Ladder order is unchanged (#4 before #11 — tested).
- Gaps and out-of-position heading numbers in a hand-edited file are accepted, not refused
  (someone who deleted a note by hand gets 1, 3 → imports as positions 1, 2). Tested.
- Export → import → export reproduces `feedback.md` and every screenshot byte for byte (tested in
  `export.test.ts`, with the pages installed exactly the way `handleImportReplace` installs them).

---

## 2. Judgement calls

1. **Import keeps the bundle's ids (the brief said "assigns fresh internal ids as it does
   today").** The code has never re-allocated on import: `handleImportReplace` writes `payload.id`
   and sets `nextItemNumber = max id + 1` (its own doc comment said so, and `import.test.ts`
   "preserving ids" pinned it). I kept that, because the brief's other requirement — export →
   import → export must be the same file — is only possible if the ids, which name the screenshot
   files, survive the trip (the frozen fixture's ids 1, 3 / 2 are not in document order, so a
   fresh 1..n allocation would rewrite two filenames). Display numbers do "fall out of list
   position" exactly as the brief describes, because the payload carries no number at all.
   Consequence: internal-id uniqueness must still be checked at import (above), since a repeated
   id would become a repeated storage key. Documented in FR-IM-6 and the `handleImportReplace`
   comment.
2. **One error code for both duplicate kinds.** `ImportErrorCode` and the §5 copy were not
   extended; both kinds are a corrupted file and the existing sentence covers both. A new code
   would have meant new copy in `copy.ts`, a new REQUIREMENTS row and Playwright wording for a
   distinction the user cannot act on differently.
3. **Page order in the export is still by first id** (first-captured page first, §AC). Only the
   within-page sort was removed; page order was never something the sidebar shows.
4. **`saveErrorFor(n)` names the display number**, with the unnamed `SAVE_ERROR_MESSAGE` as the
   fallback if the note is no longer in the view's list (unreachable in practice: a deleted note's
   draft is forgotten with it). A wrong number is worse than no number.
5. **`numberOf` returns `null` for an unknown id rather than a made-up number**; the title and
   peek-label template sites are only ever reached with ids from the view's own list, so they never
   see it. The card badge falls back to empty text on creation (also unreachable — cards are
   created only for ids in `targets()`), and `syncBadges` leaves a retiring card's last text alone
   while it fades.
6. **Numbers inside a user's note text are not rewritten** ("see #3" stays "see #3"). Out of
   scope, and it is the user's text.
7. **No cross-tab sync.** Two tabs on one page can show stale numbers until one refreshes — the
   same staleness the list already has. Documented in FR-CP-4, §AD and browser case 3.11.
8. **Pre-existing, untouched:** a drawn note's alt-text suffix (" — marked up by the reviewer")
   does not survive export → import → export, because import rebuilds the item without a drawing
   (§AB: the strokes come back only as pixels). The round-trip test therefore uses undrawn notes;
   the drawn-alt-text case is covered separately. Not a numbering matter.

---

## 3. Files touched

Source (`src/`):

- `types.ts` — doc comments only: `FeedbackItem.id` now states the rule (id = identity, number =
  position); `DomainMeta.nextItemNumber` says it is the allocator, not a display number;
  `DomainData` says the page array order is what both renderers number from.
- `thumbnails.ts` — `renderThumbnailList` passes `index + 1` to `buildThumbnailEl(item, number,
  callbacks)`; the badge text and both aria-labels (`feedback item {n}`, `delete feedback item
  {n}`) use it; `data-item-id` keeps the id. Banner updated.
- `enlargedView.ts` — new private `numberOf(id)`, `saveErrorMessageFor(id)`, `syncBadges()`;
  `layoutCards` calls `syncBadges()` after retiring cards; `beginCollapse` calls it before
  measuring the landing rects; `createCard` seeds the badge from `numberOf`; `setRole`'s peek label
  and `setContent`'s title use `numberOf`; the three `saveErrorFor(id)` sites go through
  `saveErrorMessageFor`. The card map is still keyed by id. No timing, CSS or choreography change.
- `bundle/v2.ts` — writer: no within-page sort, `renderItem(item, number)`; reader:
  `DecodedBundleEntry`, `decodeFeedbackMarkdown` returns entries, `imageLineAfter` returns the
  image's id, `readItemBlock` matches json to the image id and reports errors by heading number,
  `fromJsonFeedbackItem` takes an optional `where`. Banner rewritten for the two numbers.
- `bundle/index.ts` — `DecodedBundle.entries`, re-exports `DecodedBundleEntry`.
- `import.ts` — consumes entries; §5 #11 checks ids file-wide and numbers per page; payload is
  `entry.item` only. Banner updated.
- `background.ts` — comments only (id allocation rationale; `handleImportReplace`'s doc).
- `storage.ts` — comment only (ids are keys, not the numbers shown).

Frozen fixture: `src/__tests__/fixtures/feedback-v2.md` (§4).

Tests (`src/__tests__/`): `thumbnails.test.ts`, `enlargedView.test.ts`, `content.test.ts`,
`bundle.test.ts`, `bundleV2.test.ts`, `import.test.ts`, `export.test.ts` (§5). `storage.test.ts`
untouched — storage code is untouched.

Playwright (`tests/`, edited, not run): `02-capture.spec.js` (test renamed; new case: delete
renumbers, delete-all then capture is #1), `05-persistence.spec.js` (page two's first note is
`1`, not `2`; comments). `tests/helpers/extension.js` needed no change (selectors are by class and
`data-item-id`).

Docs: `REQUIREMENTS.md` (Domain definition, FR-CP-4, FR-LS-1, FR-EV-1, FR-EX-5, FR-IM-6, FR-IM-7,
Journey 1, E-11), `design/SALAMANDER_SPEC.md` (§3.1 badge, §AC rules, new §AD), `TECH_DESIGN.md`
(bundle format paragraph, import ladder, the "ids allocated…" key decision), `TESTING.md` (counts
and the three flow steps), `README.md` (numbering line, format bullet, ladder line),
`BROWSER_TEST_CASES.md` (2.12, 2a.13's alt-text line, 3.4, 3.10, new 3.11, 4.4, 5.10), this file.

Not touched: `manifest.json`, any CSS value, timing, copy string, storage key, message type, the
§5 "what NOT to change" list from the 2026-09-21 review.

---

## 4. The fixture diff (`src/__tests__/fixtures/feedback-v2.md`)

Regenerated deliberately, by hand, four lines; everything else is byte-identical (the header, page
headings, note lines and every json block — including each `"id"` — are unchanged):

| Line | Before | After |
|---|---|---|
| 70 | `### feedback 3` | `### feedback 2` |
| 72 | `![feedback 3](screenshots/3.png)` | `![feedback 2](screenshots/3.png)` |
| 126 | `### feedback 2` | `### feedback 1` |
| 128 | `![feedback 2](screenshots/2.png)` | `![feedback 1](screenshots/2.png)` |

Why: the pricing page holds ids 1 and 3, so its second note is now `feedback 2` (with
`screenshots/3.png`, json `"id": 3`); the docs page holds id 2 alone, so it starts at `feedback 1`
(with `screenshots/2.png`, json `"id": 2`). Line 8/10 (`feedback 1`, id 1, the drawn note) are
unchanged. `bundleV2.test.ts`'s `FIXTURE_PAGES` had the pricing notes in insertion order
`[ITEM_3, ITEM_1]` to prove the old id sort; it is now `[ITEM_1, ITEM_3]` because list order is
the file's order (page insertion order is still deliberately reversed to prove page sorting).

---

## 5. Tests

Existing assertions changed (the only two that encoded the old rule):

- `thumbnails.test.ts` "builds each item's hover delete as a SIBLING…": `delete feedback item 7`
  → `delete feedback item 1` (the item is alone in its list).
- `enlargedView.test.ts` "delete › middle note: carousels to the next one": title `feedback #3` →
  `feedback #2`.

Existing tests adapted to the API rename (`.items` → `.entries.map((e) => e.item)` in
`bundle.test.ts`; `entries` with `FIXTURE_ENTRIES` in `bundleV2.test.ts`; the "orders notes within
a page by capture order (id)" test rewritten as "writes notes within a page in list order and
numbers them by position"; the malformed case "the screenshot line names another id" renamed to
say what it now proves; `content.test.ts` "clicking a note expands…": `feedback #7` →
`feedback #1` for the first of two notes with ids 7 and 8).

Added (24):

- `thumbnails.test.ts` (+4): badges/labels by position with `data-item-id` keeping the id;
  delete-then-renumber; delete-all-then-capture-starts-at-1; two pages each from 1.
- `enlargedView.test.ts` (+9): title/badges/peek labels for ids 10/20/30; deleting the first,
  middle and last note (title, main badge, both peeks' labels and badges); delete mid-morph
  (before the expand settles); collapse after a delete (list renumbered mid-collapse, the landing
  cards carry the new numbers, final list); deleting the only note then a new capture is #1;
  save-failure copy naming the position in the status slot and in the post-collapse banner.
- `bundle.test.ts` (+2): every page from 1 with id-named screenshots and no `number` field in
  the json; a heading whose number is not the position still reads. (+ the entries' numbers
  asserted in the round trip.)
- `bundleV2.test.ts` (+2): heading numbers 1, 2, 1 vs json ids 1, 3, 2; the fixture's headings and
  screenshot paths.
- `import.test.ts` (+4): the same number twice under one page; the same number on two pages
  accepted; a gap accepted and no `number` in the payload; #4 reported before #11.
- `export.test.ts` (+3): per-page headings with id filenames (and the file equals the writer's
  output); drawn alt text follows the heading number; export → import → export byte-identical.

---

## 6. Verification

| Check | Baseline (98de6a7) | After |
|---|---|---|
| `npx tsc --noEmit` | clean | clean |
| `npm run build` | clean | clean |
| `npx jest` | 802 passed / 26 suites | **826 passed / 26 suites** |
| `dist/content.js` | 190,971 B | 191,628 B (+657: `numberOf`, `syncBadges`, the entry objects) |
| `dist/background.js` | 26,316 B | 26,298 B (−18: the dropped within-page sort) |
| Frozen fixture | byte-exact | byte-exact against the regenerated file (§4) |

Playbook passes run over the diff before finishing:

- *code-reviewer* — correctness: every template site is reached only with ids from the list the
  number is computed against; the reader's image/json id agreement is unchanged in strictness;
  the ladder order is preserved and tested. Naming: `number` is the display number everywhere,
  `id` the identity, `entries` what the reader returns. Duplication: the rule is stated once
  (`types.ts`) and the derivation is `index + 1` at each renderer with no shared helper, because
  each already has the index in hand (the enlarged view's `numberOf` is the one lookup by id).
  Resource management: no new listener, timer or animation.
- *silent-failure-hunter* — no new `catch`, no swallowed error. New fallbacks: `saveErrorMessageFor`
  → the unnamed save message (the failure is still shown; only the number is withheld when it
  would be wrong), `createCard`'s badge → `''` (unreachable), `syncBadges` skipping a retiring card
  (its text is fading out). Import refuses rather than repairs: duplicates and mismatched ids
  throw; gaps are accepted by design and tested.
- *type-design* — `DecodedBundleEntry` keeps the number out of `DecodedBundleItem`, so it cannot
  reach `ImportItemPayload`, `FeedbackItem` or storage; `buildThumbnailEl`/`renderItem` take the
  number as a parameter rather than reading a field, so nothing can render a stored number.

---

## 7. Browser-only checks (in priority order)

1. **Enlarged-view delete, live renumbering** (browser case 3.11): delete #2 of 4 — the title,
   the badge on the card that morphs back to the list on collapse, and the "next note: feedback
   #3" peek label all shift with no flash of the old number; mid-morph delete; last-note delete.
   jsdom proves the DOM text; only Chrome shows the badge during the FLIP morph.
2. **List delete then reload** — the numbers after the gap move up and stay moved after a reload
   (storage untouched; only the draw changes). Then delete all and capture: #1.
3. **Two pages** — each starts at 1 (05-persistence's changed assertion, and 2.12).
4. **Export/import** — unzip: headings per page from 1, `screenshots/` named by id, no collision
   between two pages' `feedback 1`; re-import the zip; export again and diff the two
   `feedback.md` files (identical). Hand-edit a duplicate heading under one page → E-11.
5. **Playwright** — `tests/02-capture.spec.js`'s new case drives the list's hover delete with
   `hover()` + `click({ force: true })`, the approach the helper's `thumbnailDelete` comment
   prescribes, but no existing spec did this before; run it before trusting it.
6. Load `dist/` at all (rebuilt bundles).

---

## 8. Commit groups

1. `src/types.ts`, `src/thumbnails.ts`, `src/enlargedView.ts`, `src/storage.ts`,
   `src/__tests__/thumbnails.test.ts`, `src/__tests__/enlargedView.test.ts`,
   `src/__tests__/content.test.ts`
   — *Number notes by their position on the page; the id stays the key*
2. `src/bundle/v2.ts`, `src/bundle/index.ts`, `src/import.ts`, `src/background.ts`,
   `src/__tests__/fixtures/feedback-v2.md`, `src/__tests__/bundle.test.ts`,
   `src/__tests__/bundleV2.test.ts`, `src/__tests__/import.test.ts`, `src/__tests__/export.test.ts`
   — *feedback.md: headings count from 1 per page, screenshots keep the id; import refuses a repeated number within a page*
3. `tests/02-capture.spec.js`, `tests/05-persistence.spec.js`
   — *E2e: numbering restarts per page and renumbers after a delete*
4. `REQUIREMENTS.md`, `design/SALAMANDER_SPEC.md`, `TECH_DESIGN.md`, `TESTING.md`, `README.md`,
   `BROWSER_TEST_CASES.md`, `docs/NUMBERING_NOTES_2026-09-22.md`
   — *Docs: per-page numbering (FR-CP-4, §AC/§AD) and the notes for it*
