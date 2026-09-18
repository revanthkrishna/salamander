# Development Plan — Screenshot-Based Feedback Rebuild

Build plan for the pivot specified in `REQUIREMENTS.md` (pin-based annotation → screenshot-based
feedback capture). This document is *how we build it*, not *what it is* — all behavioural questions
are settled in `REQUIREMENTS.md` and it remains the single source of truth. If a phase brief and
`REQUIREMENTS.md` disagree, `REQUIREMENTS.md` wins.

Audience: a lead engineer dispatching Claude Code subagents, one phase per subagent run.

---

## How to run a phase

Each phase below gives: **goal**, **files**, **reuse vs. replace**, **agent persona**, **model
tier**, **done-when**, **commit**. Dispatch one subagent per phase with a brief that contains:

1. The phase block verbatim.
2. The relevant `REQUIREMENTS.md` sections (cited per phase).
3. The Cross-Cutting Gotchas section below (all phases — these are the things that silently break).
4. "Run `npm test` and `npm run build` before committing; both must pass."

Personas are from `VoltAgent/awesome-claude-code-subagents/categories/01-core-development/` —
fetch as `curl -s https://raw.githubusercontent.com/VoltAgent/awesome-claude-code-subagents/main/categories/01-core-development/<name>.md`
and prepend to the subagent's system prompt. Available and used here: `backend-developer`,
`frontend-developer`, `api-designer`, `fullstack-developer`, `ui-designer`.

Model tiers: **haiku** = mechanical//deletion/docs. **sonnet** = default for real implementation.
**opus** = reserved; only Phase 5 qualifies (pixel math + timing + cross-context round trip, where a
subtle error produces a plausible-looking but wrong screenshot).

---

## Cross-cutting gotchas (include in every phase brief)

These are the non-obvious constraints that will otherwise be discovered the hard way:

1. **IndexedDB in a content script belongs to the *page's* origin, not the extension's.** Screenshot
   blobs stored from `content.ts` would be scattered per-site and readable by the page. All IDB
   access must live in the **service worker** (extension origin), with the content script talking to
   it over `chrome.runtime` messages.
2. **`chrome.runtime` messaging is JSON-serialised.** `Blob`, `File`, and `ArrayBuffer` do **not**
   survive. Images cross the content-script ↔ service-worker boundary as base64 / data-URL strings.
   `chrome.tabs.captureVisibleTab` conveniently already returns a data URL.
3. **`captureVisibleTab` cannot be called from a content script** — it is service-worker-only and
   requires the tab to be active. Every capture is a message round trip.
4. **Service workers have no `URL.createObjectURL` and no DOM.** Cropping in the SW means
   `createImageBitmap` + `OffscreenCanvas`. Downloading from the SW means `chrome.downloads` with a
   `data:` URL. (An offscreen document is the escape hatch if either proves limiting.)
5. **Existing CSP** in `manifest.json` is `script-src 'self'` — every dependency must be bundled by
   esbuild, never loaded from a CDN. `fflate`/`jszip` are fine; anything using `eval` is not.
6. **The content script is injected on demand and must stay idempotent.** `src/content.ts` already
   has the double-injection guard pattern — preserve it.
7. **All user-visible text is lowercase** (`REQUIREMENTS.md` §3.4). Errors, buttons, placeholders,
   dialogs, empty states.
8. Do not `git push`. Local commits only.

---

## Inventory: what happens to the v1 code

| File | Fate | Notes |
|---|---|---|
| `src/annotationMode.ts` (25KB) | **delete** (Phase 0) | Click-to-place-pin interaction. No equivalent in the new design. Its popover positioning/flip logic is worth *reading* before Phase 4 writes the comment box. |
| `src/pinRenderer.ts` (12KB) | **delete** (Phase 0) | Live pin rendering + RAF re-resolution loop. §1.5 explicitly drops live markers. |
| `src/pageDetectors.ts` + test | **delete** (Phase 0) | Warns that *pins* may fail (iframes/canvas/shadow DOM/SPA). Screenshots don't care. The only surviving need — "content scripts can't run here" (§5 #9) — is handled in Phase 2 by injection failure, not by DOM scanning. |
| `src/fingerprint.ts` (45KB) | **split** (Phase 6) | Keep the *selector-building* half (`buildCSSSelector`, `segmentFor`, `hasUsableId`, `idHasDictionaryWord`, `getDataAttrSegment`, `getStableAttrSegment`, `getMeaningfulClass`, `isUnique`, `buildXPath`, `buildPositionalXPath`) — that is exactly §1.4A. Delete the *resolution* half (`resolveElement`, `scoreCandidate`, `scoreContext`, `scoreHeadingPath`, `headingPathAgreement`, `passesRectSanityCheck`, `resolvePageAnnotations`) and the whole heading/sibling/domIndex signal family — those exist only to re-find an element later, which we no longer do. |
| `src/wordlist.ts` (18KB) | **keep untouched** | Sole consumer is `idHasDictionaryWord()` in selector building (the "is this id human-authored or a framework hash" heuristic), which Phase 6 keeps. No other references. |
| `src/urlNorm.ts` | **keep, one edit** | §6 #11 carries v1 normalisation forward unchanged. Only `exportFilename()` changes (Phase 8) for the new `.zip` naming. Its test stays green throughout. |
| `src/storage.ts` | **extend** (Phase 1) | `chrome.storage.local` promise wrapper + domain-keyed records is the right shape. Add the IDB blob store, swap `activeTab:{tabId}` → `chrome.storage.session`, replace the annotation CRUD with feedback-item CRUD. |
| `src/background.ts` | **rework** (Phase 2) | Icon-click / ping / inject / re-inject-on-reload flow is reusable almost verbatim. Add the capture relay, the IDB owner, and per-tab sidebar state. |
| `src/content.ts` (21KB) | **rework** (Phases 3–5, 7) | Keep: injection guard, message listener shape, SPA nav detection (`history.pushState`/`replaceState` patching + `popstate` + debounce), teardown. Replace: everything pin-related. |
| `src/toolbar.ts` (33KB) | **replace** (Phase 3) | Bottom-right floating widget → right-docked sidebar. Reuse *patterns*, not code: closed-shadow-root host, inline `currentColor` SVG icons, `showError`/`showWarning`/`showConfirmDialog` primitives, the design tokens in its CSS block. |
| `src/importExport.ts` (17KB) | **replace** (Phases 8–9) | v1 is a single YAML file; v2 is a zip + markdown. The validation *ladder* (type → parse → schema → domain → duplicate ids) maps 1:1 onto §5 and should be carried over in structure. |
| `src/types.ts` | **rewrite** (Phase 0) | New shape defined up front so every later phase compiles against it. |
| `src/__tests__/*` | mixed | `urlNorm.test.ts` keep; `setup.ts` extend (Phase 1); `storage.test.ts` rewrite (Phase 1); `fingerprint.test.ts` cut to selector-only (Phase 6); `importExport.test.ts` rewrite (Phases 8–9); `pageDetectors.test.ts` delete (Phase 0). |
| `tests/*.spec.js` (Playwright) | **delete specs, keep harness** (Phase 0) | All 8 specs drive pin flows. `tests/helpers/extension.js` and `tests/fixtures/test-page.html` survive and get extended in Phase 10. |
| `manifest.json` | **edit** (Phase 0 only) | Add `unlimitedStorage` (§2) and `downloads`. Everything else stands. |
| `TECH_DESIGN.md`, `UX_DESIGN.md`, `FINGERPRINTING.md` | **archive** (Phase 0) → `docs/v1-archive/` | All describe the pin system. Archived rather than deleted because Phase 6 wants `FINGERPRINTING.md`'s selector rationale and Phase 3 wants `UX_DESIGN.md`'s tokens. |
| `TESTING.md`, `README.md` | **rewrite last** (Phase 10) | Stale until the thing exists. Leave them alone until then. |

---

## Phase 0 — Demolition, types, and build setup

**Goal:** Leave the repo compiling and `npm test` green with the v1 pin machinery gone and the v2
type surface in place, so every later phase has a stable contract to build against.

**Files:**
- Delete: `src/annotationMode.ts`, `src/pinRenderer.ts`, `src/pageDetectors.ts`,
  `src/__tests__/pageDetectors.test.ts`, `src/__tests__/fingerprint.test.ts`,
  `src/__tests__/importExport.test.ts`, `src/__tests__/storage.test.ts`, `tests/0*.spec.js`,
  `tests/diag2.spec.js`, `tests/smoke.spec.js`, `salamander.zip`
- Rewrite: `src/types.ts`
- Edit: `manifest.json`, `package.json`, `src/content.ts` (strip imports/calls to deleted modules
  down to a stub that still injects, guards, and detects SPA navigation), `src/importExport.ts` and
  `src/background.ts` (stub out what no longer compiles — do not build new behaviour here)
- Move: `TECH_DESIGN.md`, `UX_DESIGN.md`, `FINGERPRINTING.md` → `docs/v1-archive/`

**Type surface to define** (from §1.2, §1.4, §1.6):
`FeedbackItem` (id, pageUrl, normalisedUrl, note, createdAt, selectionRect, viewport, dpr,
screenshotKey, context), `CapturedContext` (`primaryTarget` {cssSelector, xpath, outerHtmlSnippet,
truncated}, `containedElements[]`, `areaText`, `pageMeta`), `DomainData`/`DomainMeta`
(nextItemNumber — sequential across all URLs per §1.2), the bundle-serialisation mirror types
(snake_case, for the fenced yaml blocks), and the `ImportError` code union rewritten against §5's
11 cases.

**Reuse vs. replace:** `types.ts` is a from-scratch rewrite; the `ImportError` class shape and the
`DomainData`/`DomainMeta` pattern carry over. `manifest.json` gains two permissions and changes
nothing else.

**Dependencies:** add `fflate` (tiny, zero-dep, no `eval`, works in both SW and content script —
`jszip` is an acceptable alternative if the subagent prefers it) and dev-dep `fake-indexeddb`. Keep
`js-yaml` — §1.6 still needs it for the fenced yaml blocks.

**Agent:** `backend-developer` · **Model:** `sonnet`

**Done when:** `npm run build` and `npm test` both pass; the only remaining test file is
`urlNorm.test.ts`; `grep -ri "pin" src/` returns nothing meaningful.

**Commit:** `Phase 0: remove pin system, define v2 types and build deps`

---

## Phase 1 — Storage layer

**Goal:** A complete, tested persistence API that later phases can call without thinking about where
bytes live: metadata in `chrome.storage.local`, PNG blobs in extension-origin IndexedDB, sidebar
open/closed state in `chrome.storage.session` keyed by tab id.

**Files:** rewrite `src/storage.ts`; new `src/imageStore.ts` (IDB wrapper); extend
`src/__tests__/setup.ts` (mock `chrome.storage.session`, wire `fake-indexeddb`); new
`src/__tests__/storage.test.ts`.

**API to deliver:** domain CRUD, `getPageItems(domain, normalisedUrl)`, `addItem` /`updateNote`
/`deleteItem` (deleting an item **must** delete its blob — §1.5), `getNextItemId(domain)`
(monotonic across URLs), `replaceDomainData` (for import's replace-only semantics, §1.7), and
`setSidebarOpen(tabId)`/`isSidebarOpen(tabId)`/`clearSidebarState(tabId)`.

**Reuse vs. replace:** keep `storage.ts`'s promise-wrapping helpers and domain-keyed layout
verbatim. Replace the annotation CRUD. Delete `activeTab:{tabId}` in `storage.local` in favour of
`chrome.storage.session` (§1.1 decision).

**Design call to make here:** store a small thumbnail data-URL alongside each item's metadata in
`storage.local` so the sidebar list renders without an IDB round trip per item, and keep the
full-resolution PNG in IDB for the modal and for export. Record whichever way you go in a comment.

**Agent:** `backend-developer` · **Model:** `sonnet`

**Done when:** storage tests cover create/read/update/delete, orphan-blob prevention, id
monotonicity across URLs, and session-state round trip.

**Commit:** `Phase 1: storage layer — local metadata, IndexedDB blobs, session sidebar state`

---

## Phase 2 — Service worker

**Goal:** The extension-context half of the app: injection, per-tab sidebar state, the screenshot
capture relay, and sole ownership of IndexedDB.

**Files:** rewrite `src/background.ts`; new `src/messages.ts` (the typed message union — both sides
import it, so it is the contract).

**Scope:** icon-click inject/ping/toggle (v1's flow, largely intact); re-inject on
`tabs.onUpdated` when `storage.session` says the sidebar was open (§1.1 — now a hard requirement,
not v1's best-effort); `tabs.onRemoved` cleanup; `CAPTURE` handler wrapping
`chrome.tabs.captureVisibleTab` with a ~500ms client-side queue/throttle (§2, §6 #8) that surfaces a
clean error rather than a silent failure; crop-to-rect via `createImageBitmap` + `OffscreenCanvas`;
blob persisted through Phase 1's `imageStore`; injection failure on restricted pages reported back
as §5 #9.

**Reuse vs. replace:** `pingContentScript`, the `executeScript` injection, and the `onUpdated`
re-inject block carry over nearly unchanged. Everything capture- and IDB-related is new.

**Agent:** `backend-developer` · **Model:** `sonnet`

**Done when:** message union is exhaustive and typed; capture round trip works end to end when
driven manually from the SW console; throttle verified by firing 5 captures in a row.

**Commit:** `Phase 2: service worker — injection, capture relay, IDB ownership`

---

## Phase 3 — Sidebar shell

**Goal:** The right-docked sidebar that **resizes the page rather than overlaying it** (§1.1, §3.1),
with its four header buttons wired to no-op handlers, the current-URL thumbnail list (empty for now),
the empty state, and survival across SPA navigation and full reloads.

**Files:** new `src/sidebar.ts`; rework `src/content.ts`; delete `src/toolbar.ts`.

**The hard part** is the page resize. `position: fixed` sidebar + shrinking the page is not a
one-liner on real sites: `document.documentElement` width adjustment, `position: fixed` page elements
that ignore it, scrollbar gutter, `100vw` page CSS that overflows, and restoring cleanly on close.
Pick one strategy, apply it to `<html>` (not `<body>`), and test against 5+ real sites of different
layout vintages before declaring done. Everything the extension draws lives in a **closed shadow
root** to avoid page CSS bleed (v1's approach in `toolbar.ts` — keep it).

**Reuse vs. replace:** reuse `toolbar.ts`'s shadow-host construction, `showError`/`showWarning`
/`showConfirmDialog`, icon SVG inlining, and CSS tokens; reuse `content.ts`'s injection guard and
SPA nav detection. The layout and everything pin-facing is replaced. `UX_DESIGN.md` (archived) has
the v1 visual tokens.

**Agent:** `frontend-developer` · **Model:** `sonnet` — escalate to `opus` only if the page-resize
strategy proves unstable across the test sites.

**Done when:** sidebar opens on icon click, shrinks the page without covering content, survives F5
and SPA route changes without user action, closes cleanly with the page restored to its original
layout.

**Commit:** `Phase 3: right-docked sidebar shell with page resize and reload persistence`

---

## Phase 4 — Add mode

**Goal:** The selection interaction (§1.2, §3.2): crosshair cursor, click-to-place default 200×150
box clamped to the viewport, 8 resize handles with a 20×20 minimum, macOS-style dimming scrim
outside the box, page interaction fully suppressed, and the attached comment box (textarea, 1000-char
counter appearing at 900 / red at 980, cancel/ok, ok disabled while empty, clicks outside do
*nothing*).

**Files:** new `src/addMode.ts`; edit `src/content.ts` (wire the sidebar's add button).

**Notes:** the scrim is cleanest as four rects or one element with a CSS `clip-path` hole. Comment-box
placement reuses v1's popover overflow logic (below → above → side) — read the deleted
`annotationMode.ts` in git history for the algorithm before reimplementing. Add mode must expose a
clean `hideOverlayUI()` / `showOverlayUI()` pair for Phase 5 to call around the capture.

**Reuse vs. replace:** conceptual reuse of v1's popover positioning only; all code is new.

**Agent:** `frontend-developer` · **Model:** `sonnet`

**Done when:** a box can be placed, resized to every edge, clamped at the viewport, and
cancelled; the comment box never renders off-screen; page links are unclickable while in add mode.

**Commit:** `Phase 4: add mode — selection box, dimming scrim, comment box`

---

## Phase 5 — Capture pipeline  ⚠️ highest risk

**Goal:** Turn "user clicked ok" into a stored, correctly-cropped PNG. This is the phase where
everything subtly wrong produces a screenshot that looks fine but is off by a scroll offset or a
device-pixel-ratio factor.

**Files:** new `src/capture.ts`; edit `src/addMode.ts`, `src/content.ts`, and (only if the SW
contract needs adjusting) `src/background.ts`.

**Scope:** hide overlay UI → wait exactly one paint (`requestAnimationFrame` double-rAF, not a
timeout) → message the SW → crop → restore UI → exit add mode → item appears in the sidebar. The
crop rect must be converted from CSS pixels to device pixels (§1.3 — native DPR retained, no
downscaling), and account for browser zoom (§6 #5) and scroll position. The sidebar deliberately
needs **no** hiding (§1.2 step 1 — it resizes rather than overlays). Failure (rate limit, restricted
page) creates **no** partial item (§1.3, §5 #8).

**Verify on:** a 1× display and a 2× display, at 100% / 80% / 150% browser zoom, scrolled halfway
down a long page, with a selection at each viewport edge. Compare captured pixels against a known
on-page fixture — visual inspection is not enough here.

**Reuse vs. replace:** all new.

**Agent:** `fullstack-developer` (this phase straddles the content-script/service-worker boundary) ·
**Model:** `opus` — the only phase that warrants it.

**Done when:** the cropped PNG matches the selection to the pixel across the verification matrix, and
no extension UI ever appears in a capture.

**Commit:** `Phase 5: screenshot capture pipeline with DPR-correct cropping`

---

## Phase 6 — Context capture

**Goal:** §1.4's "fingerprint for explanation": primary target (selector + xpath + ≤1KB sanitised
`outerHTML`), ≤15 prioritised contained elements, flat area text, page metadata — the whole thing
governed by a 2KB per-item budget with visible truncation markers and the documented truncation order.

**Files:** new `src/contextCapture.ts` and `src/selectorBuilder.ts` (the surviving half of
`fingerprint.ts`); delete `src/fingerprint.ts`; new `src/__tests__/selectorBuilder.test.ts` and
`src/__tests__/contextCapture.test.ts`; trim `docs/v1-archive/FINGERPRINTING.md` into a short current
`FINGERPRINTING.md` covering selector generation only.

**Reuse vs. replace:** lift the selector/xpath builders out of `fingerprint.ts` **as-is** (they are
mature and hardened against framework hash classes — do not rewrite them); delete every
resolution/scoring function and the heading/sibling/domIndex signals. `wordlist.ts` is imported by
the lifted code and stays.

**New logic:** deepest-common-ancestor-of-the-rect (primary target), rect-intersection descendant
walk with the attribute-rich/text-bearing prioritisation, area-text aggregation, and the size
governor. Cross-origin iframes contribute only their own tag/attrs/`src` (§6 #6).

**Independence:** this is a pure DOM→object module with no `content.ts` or `background.ts` surface —
it can run fully in parallel with Phases 2–5.

**Agent:** `api-designer` (this is schema-and-budget design more than UI) · **Model:** `sonnet`

**Done when:** jsdom tests cover selector stability, the 2KB governor's truncation order, the
15-element cap's prioritisation, and iframe degradation.

**Commit:** `Phase 6: context capture — selector reuse plus rect-scoped DOM/text extraction`

---

## Phase 7 — Thumbnails and enlarged modal

**Goal:** §1.5 / §3.3 — thumbnail list (image + truncated note + item-number badge, current URL only,
newest at the bottom), click to open an enlarged modal over a translucent backdrop, note editable
with autosave on blur/close, immediate no-confirm delete that also drops the blob.

**Files:** new `src/thumbnails.ts`, `src/modal.ts`; edit `src/sidebar.ts`, `src/content.ts`.

**Reuse vs. replace:** all new UI, built on Phase 3's shadow root and Phase 1's storage API.

**Agent:** `ui-designer` for the visual pass, `frontend-developer` for the wiring — or one
`frontend-developer` run given the archived `UX_DESIGN.md` tokens. · **Model:** `sonnet`

**Done when:** capture → thumbnail → open → edit → close → reload → edit persisted; delete removes
both record and blob.

**Commit:** `Phase 7: sidebar thumbnails and enlarged feedback modal`

---

## Phase 8 — Export

**Goal:** §1.6 — a `.zip` containing `screenshots/{id}.png` and one `feedback.md`, covering **all**
URLs of the current domain, named `feedback-{domain_with_underscores}-{YYYY-MM-DD}.zip`, with
`alert("nothing to export")` on an empty domain.

**Files:** new `src/bundle.ts` (the markdown serialiser **and** the shared section/fence grammar —
Phase 9 imports from here, so define the format once), new `src/export.ts`; edit `src/urlNorm.ts`
(`exportFilename`), `src/sidebar.ts`, `src/background.ts` (download path); new
`src/__tests__/bundle.test.ts`.

**Key decision to make and document:** where the zip is assembled. Recommended default — assemble in
the **service worker** (the blobs already live there; `chrome.downloads` accepts a `data:` URL, and
the `downloads` permission was added in Phase 0), which avoids shipping every PNG across the
messaging boundary as base64. Fall back to an offscreen document if `data:` URL size becomes a
problem for large bundles.

**Format discipline:** one `##` section per URL ordered by first capture, items chronological within
a section, each item = number + `![](screenshots/{id}.png)` + prose note + a fenced ` ```yaml ` block
holding the §1.4 context. Write the round-trip test (serialise → parse → deep-equal) in this phase,
not Phase 9 — it is the contract.

**Reuse vs. replace:** `importExport.ts`'s `buildExportYaml` aggregation shape and
`triggerDownload` are worth reading; the output format is entirely new. `js-yaml` still does the
fence bodies.

**Agent:** `api-designer` · **Model:** `sonnet`

**Done when:** a multi-URL, multi-item bundle exports, renders correctly in a plain markdown viewer
with inline images, and passes the round-trip test.

**Commit:** `Phase 8: zip bundle export with feedback.md and embedded yaml context`

---

## Phase 9 — Import

**Goal:** §1.7 and the full §5 error table — file picker (`.zip` only), parse `feedback.md`, extract
every fenced yaml block, validate, confirm-then-**replace** the domain's existing data, store blobs,
refresh the sidebar.

**Files:** new `src/import.ts`; edit `src/bundle.ts` (parser side), `src/sidebar.ts`,
`src/background.ts` (blob ingest); new `src/__tests__/import.test.ts`; delete `src/importExport.ts`.

**Validation ladder** (carry over v1's ordering discipline, map onto §5): not-a-zip (#1) → corrupt
archive (#2) → missing `feedback.md` (#3) → malformed/missing fence (#4b) → referenced screenshot
absent (#4) → duplicate ids (#11) → domain mismatch (#5) → newer schema version (#6, warn and
proceed) → existing-data confirmation (#10). Every message lowercase, verbatim from §5.

**Reuse vs. replace:** the *structure* of `importExport.ts`'s `importFile` ladder and its
`ImportError` code/detail plumbing carry over; the parsing is new.

**Agent:** `api-designer` · **Model:** `sonnet`

**Done when:** every §5 row has a test with a purpose-built fixture bundle, and a Phase 8 export
imports back to an identical state.

**Commit:** `Phase 9: zip bundle import with full error-case coverage`

---

## Phase 10 — E2E tests and documentation

**Goal:** Restore the Playwright suite against the new flows and bring the docs back in line with
reality.

**Files:** new `tests/01-sidebar.spec.js`, `02-capture.spec.js`, `03-thumbnails.spec.js`,
`04-export-import.spec.js`, `05-persistence.spec.js`; extend `tests/helpers/extension.js` and
`tests/fixtures/test-page.html`; rewrite `TESTING.md`, `README.md`, and a fresh lean `TECH_DESIGN.md`
(target ~300 lines describing the actual built architecture — not a revival of the archived 68KB
version).

**Reuse vs. replace:** `tests/helpers/extension.js` (extension loading, service-worker handle) is
reusable as-is; all specs are new. `playwright.config.js` needs no changes.

**Agent:** `fullstack-developer` for the specs; docs can be a separate `haiku` run ·
**Model:** `sonnet` for specs, `haiku` for docs

**Done when:** `npx playwright test` is green and every user journey in `REQUIREMENTS.md` §4 has a
covering spec.

**Commit:** `Phase 10: e2e suite and documentation for the screenshot-based system` (split into two
commits if docs run separately)

---

## Sequencing and parallelism

**Shared-file conflicts — these must run sequentially:**

- `src/types.ts` — Phase 0 only. Frozen after Phase 0; any later phase needing a type change should
  make it and flag it, since everything compiles against it.
- `manifest.json` — Phase 0 only. If a later phase discovers a missing permission, that is a signal
  Phase 0's brief was incomplete; add it and note it in the commit.
- `src/background.ts` — Phase 2 owns it. Phases 5, 8, and 9 each touch it afterwards for their own
  handler. **Never run 5, 8, and 9 concurrently.**
- `src/content.ts` — Phases 0, 3, 4, 5, 7 all touch it. Strictly sequential.
- `src/sidebar.ts` — Phase 3 creates it; 7, 8, 9 each wire a button into it. Sequential.
- `src/bundle.ts` — Phase 8 creates it, Phase 9 extends it. 9 must follow 8.

**Genuinely parallel-safe:**

- **Phase 6 (context capture)** shares no file with Phases 2–5 — it only creates
  `contextCapture.ts` / `selectorBuilder.ts` and deletes `fingerprint.ts`. Run it in its own
  worktree concurrently with the Phase 3→4→5 chain and merge before Phase 5 wires it in.
- **Phase 1 (storage) and Phase 2 (service worker)** can start together if Phase 2 is told to code
  against Phase 1's declared API surface rather than its implementation — but Phase 2 cannot *finish*
  until Phase 1 lands. Lower-risk alternative: run them back to back.
- **Phase 10's documentation half** can run any time after Phase 9 and overlaps nothing.

**Critical path:** `0 → 1 → 2 → 3 → 4 → 5 → 7 → 8 → 9 → 10`, with 6 hanging off 0 in parallel.

```
0 ──┬─ 1 ── 2 ── 3 ── 4 ── 5 ── 7 ── 8 ── 9 ── 10
    └─ 6 ─────────────────────┘ (merge before 5)
```

**Model budget:** 1 opus phase (5), 8 sonnet, 1 haiku (docs). If Phase 3's page-resize work stalls,
that is the second-best candidate for escalation — nothing else is.

**Suggested checkpoint:** after Phase 5, manually exercise the capture flow on a handful of real
sites before continuing. Phases 7–9 are all downstream of a correct screenshot; discovering a crop
bug at Phase 9 is expensive.

---

## What to do first

Dispatch **Phase 0** as a single `backend-developer` subagent on `sonnet`, with a brief containing
the Phase 0 block, the Cross-Cutting Gotchas, the Inventory table, and `REQUIREMENTS.md` §1.1–1.4 and
§1.6 (it needs the full data model to design `types.ts` correctly). Nothing else can start until
`types.ts` and `manifest.json` are settled — they are the contract every other phase compiles
against.

Once Phase 0 is committed, launch Phase 1 and Phase 6 together (Phase 6 in a separate worktree, since
it shares no files), and follow the critical path from there.
