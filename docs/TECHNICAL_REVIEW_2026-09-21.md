# Salamander — technical review (2026-09-21)

Branch `screenshot-version`, clean tree. Reviewed: `REQUIREMENTS.md`, `TECH_DESIGN.md`, `DEVELOPMENT_PLAN.md`,
`TESTING.md`, `FINGERPRINTING.md`, `design/SALAMANDER_SPEC.md`, `design/MOTION_SPEC.md`, all 22 modules in `src/`
(~14k lines), the 16 jest files (`npx jest`: 599/599 green, 5.6 s), the Playwright helpers, `manifest.json`,
`esbuild.config.js`. `npx tsc --noEmit` is clean. Bundle composition was measured with esbuild's metafile in memory
(nothing written to `dist/`). No code was changed.

Line numbers below are from the tree as reviewed and will drift; the symbol names will not.

---

## 1. Executive summary

This is a well-engineered codebase for what it is today. The hard, browser-hostile problems — shrinking a host page
without breaking it, cropping a screenshot at the right scale on every DPR/zoom/scrollbar combination, keeping
extension UI out of the capture, keyboard isolation inside closed shadow roots, page scroll locking without layout
shift, interruptible shared-element morphs — are all solved carefully, and the solutions are explained in the code
well enough that a stranger can see *why* each odd-looking line is there. The pure-function seams (`flip.ts`,
`computeEnlargedGeometry`, `computeDeviceRect`, `dockMotion`'s maths, `contextCapture`) are genuinely good and are
what makes 599 fast jsdom tests possible. The message contract, the service-worker-owned storage, and the serialised
write queue are correct designs for MV3.

The shape problem is that the codebase was built phase-by-phase against a spec that was patched five times, and it
now carries the cost of that: two modules (`sidebar.ts`, 3,020 lines; `enlargedView.ts`, 2,219) have absorbed every
responsibility that touched them; state is module-level singletons everywhere on the content-script side; the item
model has exactly one mutation (`note`), no schema migration, and a hand-mirrored YAML twin; and the UI copy, the
data-URL codecs, and the icon strings are each declared two to five times. None of that hurts the current product. All
of it is directly in the path of the three planned features.

The four things that matter most:

1. **The connections/MCP feature conflicts with two load-bearing decisions — "no network calls at runtime" and the
   manifest CSP `connect-src 'none'` — and with the codebase's own defensive code that assumes them.** This is a
   product/permissions decision, not a refactor, and it has to be made before any of that work starts (§3.2, F-02).
2. **`FeedbackItem` cannot grow.** There is no generic update path, `DomainMeta.version` is written but never read, and
   the export codec is a second hand-written copy of the type. Adding `annotations` today means editing six places and
   breaking every existing bundle on import. Fix this first; it is cheap and it unblocks both drawing tools and the
   export revision (F-01, F-03).
3. **Every mutation rewrites the whole domain record, thumbnails included.** A 700 ms note autosave in a 150-item
   domain serialises ~5–8 MB of JPEG data-URLs through `chrome.storage.local.set`. Annotation autosave would do it
   more often. Split the record before adding per-item data that changes frequently (F-04).
4. **`sidebar.ts` and the content-side singletons are where the next feature's bugs will live.** A third in-sidebar
   view (a connections/settings panel) means a third set of boolean flags in a module that already juggles `visible`,
   `enlargedView`, `addModeHold`, `dockSuspended`, `enlargedDockSuspended`, `deferredItems`, `menuOpen`, `exportEnabled`,
   `importEnabled`, and `revealToken`. Introduce an explicit view state and split the file along the seams it already
   has (F-06, F-08).

What is *not* a problem, despite looking like one: the comment volume (36% of `sidebar.ts`) is mostly earning its
keep; the closed-shadow-root + `attachShadow` test patch is the right trade; the four failing Playwright tests are
environmental as stated; the spec's layering is a documentation problem, not a code one.

---

## 2. Findings

Priority: **P0** blocks a planned feature · **P1** significant · **P2** worthwhile · **P3** nice-to-have.
Effort is for one engineer who knows the codebase. Risk is what could break and what protects you.

### F-01 · P0 · The item model has no extension point and no migration path

**Where.** `src/types.ts:91-122` (`FeedbackItem`), `src/types.ts:128-134` (`DomainMeta.version`),
`src/storage.ts:17,46` (`STORAGE_VERSION` written, never read), `src/storage.ts:119-133` (`updateNote` — the only
item mutation), `src/messages.ts:257-274` (`UpdateNoteMessage`), `src/background.ts:378-386`.

**What.** `FeedbackItem` is a flat record whose only mutable field is `note`, reached through a message, a handler
and a storage function all named for that one field. `DomainMeta.version` is stamped on every record but no code
path ever compares it or migrates anything:

```ts
// storage.ts:45-47 — the only place version is produced
function emptyDomainData(): DomainData {
  return { meta: { nextItemNumber: 1, version: STORAGE_VERSION }, pages: {} };
}
```

`getDomainData` (`storage.ts:54-59`) returns whatever JSON is in storage, cast to `DomainData`. Adding an
`annotations` field means every item captured before the change is missing it at runtime, and every reader has to
defend against `undefined` forever, or you write a migration — for which there is no hook.

The same flatness is mirrored in the export: `context.pageMeta` (`types.ts:63-72`) repeats `pageUrl`,
`normalisedUrl`, `viewport`, `dpr`, `selectionRect` and the timestamp from the item that contains it, so the type
can represent an item whose `selectionRect` disagrees with its own `context.pageMeta.selectionRect`. Nothing checks.

**Why it matters.** Drawing tools need a per-item `annotations` document that is edited often, versioned, exported
and re-imported. The export revision needs to change the shape of the same record. Both will be built on top of
this type, and today that means: edit `FeedbackItem`, edit `YamlFeedbackItem`, edit `toYamlFeedbackItem`, edit
`fromYamlFeedbackItem`, add a `UPDATE_ANNOTATIONS` message + handler + storage function by copy-paste from
`UPDATE_NOTE`, and hope old records don't crash the enlarged view.

**What to do.**
- Add `storage.updateItem(domain, url, id, patch: Partial<Pick<FeedbackItem, 'note' | 'annotations' | ...>>)`
  and a single `UPDATE_ITEM` message with a `patch` payload; keep `UPDATE_NOTE` as a thin alias until callers move.
- Add `migrateDomainData(raw: unknown): DomainData` called from `getDomainData`, switching on `meta.version`,
  with `STORAGE_VERSION` bumped to 2 the first time the shape changes. One test per version step.
- Decide whether `context.pageMeta` stays a self-contained duplicate (defensible: the YAML block reads standalone —
  `types.ts:61-62` says so) or becomes derived at export time. Either is fine; the point is to decide before the
  export revision, not during it.

**Effort.** 1–2 days including tests. **Risk.** Low. `storage.test.ts` and `background.test.ts` already cover the
read/write paths; a migration test with a frozen v1 fixture object protects the upgrade. The one thing to watch is
`handleImportReplace` (`background.ts:453-495`), which builds `DomainData` by hand and must stamp the new version.

### F-02 · P0 · Connections/MCP collides with the no-network requirement and the CSP

**Where.** `manifest.json` → `"connect-src 'none'"`; `REQUIREMENTS.md` §2 Security ("No network calls, analytics,
or telemetry"); `README.md` "privacy & security"; `src/background.ts:820-837` (the `dataUrlToBlob` banner, which
documents that `fetch()` of even a `data:` URL dies under this CSP in the service worker); `src/theme.ts:611-621`
(`loadOneFont` — the one `fetch` in the codebase, of a `chrome-extension://` URL, from the content script where the
host page's CSP applies instead).

**What.** Any MCP server integration is, by definition, a runtime network call from the extension. Three separate
things forbid it today: a non-functional requirement, the manifest CSP for extension pages (which governs the
service worker's `fetch`), and the absence of any `host_permissions` beyond `<all_urls>` for content scripts (which
does not grant the *service worker* cross-origin fetch to arbitrary API hosts without the CSP allowing it). The
codebase's own comments treat the CSP as "Phase 0's contract" and were written to keep it.

**Why it matters.** This is the only item in the review that cannot be solved by refactoring. If it is not decided
up front, the connections feature will either be built and then fail on the first `fetch`, or the CSP will be
loosened silently and the privacy claim in the README becomes false.

**What to do.** Decide the permission model and write it into `REQUIREMENTS.md` §2 before any code:
- Keep the default install zero-network. Move network access behind `optional_host_permissions` requested per
  connection with `chrome.permissions.request` from a user gesture, so the install-time posture is unchanged.
- The CSP `connect-src` cannot be changed at runtime, so it has to become a fixed allow-list (`https:` at the
  broadest) in the manifest. Accept that this widens the static posture and say so in the README.
- Tokens: `chrome.storage.local` is not encrypted; keep access tokens in `chrome.storage.session` and refresh from a
  stored refresh token, or use `chrome.identity.launchWebAuthFlow` (`identity` permission) and store nothing
  long-lived.
- MV3 service workers are killed after ~30 s idle. Long syncs must be chunked, resumable and driven by
  `chrome.alarms`, with progress in storage — the existing `enqueueSave`/`enqueueCapture` queues
  (`background.ts:297-303, 531-551`) are deliberately in-memory and already tolerate a restart, which is the right
  model to copy.

**Effort.** Half a day to write the decision; the implementation cost belongs to the feature. **Risk.** Product
risk, not code risk: the privacy posture and the Web Store review both change.

### F-03 · P0 · The bundle codec is fused with its grammar and hand-mirrors the types

**Where.** `src/bundle.ts` — regex grammar at `30-35, 48`, `SCHEMA_VERSION` at `46`, `toYamlFeedbackItem`
`116-155`, `fromYamlFeedbackItem` `171-230`, `parseFeedbackMarkdown`/`parseItemBlock` `256-341`;
`src/types.ts:151-204` (the `Yaml*` mirror types); `src/import.ts:55-152` (validation ladder);
`src/__tests__/import.test.ts:77,134,188,246` (fixtures are generated by calling `buildFeedbackMarkdown`).

**What.** One file defines the markdown grammar, the YAML field mapping, the parser and the version stamp. The
field mapping is written out twice, by hand, in both directions (`toYaml…` and `fromYaml…`), against a second set
of interfaces that duplicate `FeedbackItem` in snake_case. There is one schema version; a newer bundle warns and
proceeds (§5 #6), an older one is assumed identical. The import tests build their fixtures with the exporter, so a
format change that keeps the two sides consistent passes even if it breaks every bundle already on disk.

There is also a documented grammar hole (`bundle.ts:21-25`): a note containing a line that is exactly
` ```yaml ` is misread as the fence. The parser's note-accumulation loop (`parseItemBlock:306-313`) also treats any
`## ` or `### item ` line inside a note as structure, so a note that starts a line with `## ` truncates the item and
throws.

**Why it matters.** The planned "revised feedback markdown/export structure" is a change to exactly this file. Done
in place, it (a) orphans every v1 bundle, (b) needs the mirror types edited in four places, and (c) has no golden
fixture proving v1 bundles still import.

**What to do.**
- Freeze the current format as `bundle/v1.ts` with one committed fixture `feedback.md` (real text, not generated) in
  `src/__tests__/fixtures/`. Add `bundle/v2.ts` for the new structure. `parseImportBundle` dispatches on
  `parseSchemaVersion` and always upgrades to the in-memory `FeedbackItem` shape.
- Replace the hand-written twin mapping with a single declarative field table (`[camel, snake]` pairs walked in
  both directions) or, if the new structure is a real departure, keep explicit codecs but put them beside the
  grammar they belong to, not in `types.ts`.
- Give the item fence a distinguishing info string (e.g. ```` ```yaml salamander ````) so free-text notes cannot
  collide, and stop treating heading-shaped note lines as structure by requiring the image line to open an item.
- Keep the version comment on line 1 (`bundle.ts:66`) — it is the one thing in the format that already anticipates
  this.

**Effort.** 1–2 days for the codec split and fixtures, before the new format is even designed. **Risk.** Medium.
The §5 error ladder has 13 cases with tests; keep `import.test.ts` byte-for-byte on the messages and run it against
both parsers.

### F-04 · P1 · Whole-record read-modify-write with inline thumbnails

**Where.** `src/storage.ts:109-115` (`addItem`), `119-133` (`updateNote`), `137-154` (`deleteItem`) — each
`getDomainData` → mutate → `saveDomainData` of the entire domain; `src/types.ts:112-120` (`thumbnailDataUrl` inline
by design); `src/background.ts:633-646` (480 px JPEG thumbnails); `src/background.ts:283-303` (the serialised
queue that exists *because* the writes are whole-record).

**What.** Every domain is one key in `chrome.storage.local`: `{ meta, pages: { url: FeedbackItem[] } }`, with a
~20–60 KB JPEG data-URL inside every item. A note edit (autosaved 700 ms after typing stops, `enlargedView.ts:1942`)
reads the whole record, patches one string, and writes the whole record back. `GET_PAGE_ITEMS` for one URL also
reads every other URL's thumbnails. The queue comment at `background.ts:289-295` explains the consequence honestly:
"storage.ts rewrites the whole record per write, so any two overlapping writes would otherwise clobber each other".

**Why it matters.** It is fine at 20 items. Drawing tools add a per-item document that autosaves on every stroke
batch; connections add a sync that touches many items. Both multiply the number of whole-record rewrites, each
proportional to the domain's total thumbnail bytes. The inline-thumbnail decision is load-bearing for "the list
paints from one read" (`types.ts:112-119`) and should be kept as a *property*, not as a storage layout.

**What to do.** Two options, in order of preference:
1. Key items individually in `chrome.storage.local` (`item:{domain}:{id}`) plus a small per-domain index
   (`domain:{domain}` → `{ meta, pages: { url: number[] } }`). `getPageItems` becomes one `get` of an index and one
   multi-key `get`. Thumbnails stay inline per item, so the list still paints from one round trip.
2. Move items into IndexedDB (same origin as the blobs, already owned by the service worker) with an index on
   `[domain, normalisedUrl]`. More change, but a real query model for the connections feature's sync bookkeeping.

Either way the write queue stays; it is still needed for `nextItemNumber`.

**Effort.** 2–3 days including a migration (which F-01 gives you a hook for). **Risk.** Medium: it is a storage
migration under real user data. Protection: `storage.test.ts` (15 cases) is small and behavioural; write the
migration as a pure function with a frozen v1 fixture; keep `replaceDomainData` semantics (import replaces the
whole domain) exact.

### F-05 · P1 · The message channel is untyped at both ends and duplicated

**Where.** `src/background.ts:152-208` (`handleRuntimeMessage` — string `switch`, `message as CaptureMessage`
casts, no `never` exhaustiveness against `ContentToBackgroundMessage`); `src/content.ts:537-552` and
`src/capture.ts:206-221` (two identical `sendMessage<TResponse>(message: unknown)` helpers whose comment says
"mirrors capture.ts's private helper of the same shape"); every caller picks `TResponse` by hand
(`content.ts:564, 588, 612, 662, 678, 731, 742, 752`).

**What.** `messages.ts` is an excellent *document* — 44% of its lines are comments explaining coordinate contracts
and why payloads are shaped as they are — but it is not enforced. A new member of the union compiles without a
handler; a caller can send `GetImageMessage` and type the response as `ExportResponse`; the background trusts
`message.type` and casts.

**Why it matters.** Connections need long-running, progress-reporting, cancellable calls; that is `chrome.runtime
.connect` ports, not one-shot `sendMessage`. Adding that on top of the current pattern means a third ad-hoc helper.
Drawing tools add at least one new message. Both are safer on a typed request map.

**What to do.** One `MessageMap` type (`{ CAPTURE: [CaptureMessage, CaptureResponse]; ... }`), one
`send<K extends keyof MessageMap>(msg: MessageMap[K][0]): Promise<MessageMap[K][1] | undefined>` in a new
`src/rpc.ts` shared by `content.ts` and `capture.ts`, and a handler table `Record<K, Handler<K>>` in the background
that fails to compile when a key is missing. Keep the existing "never rejects, `undefined` on a dead worker" contract
— every caller relies on it. Add a `Port`-based variant when connections arrive, not before.

**Effort.** 1 day. **Risk.** Low. `background.test.ts` (67 cases) calls the exported handlers directly and will not
notice; `content.test.ts` mocks `chrome.runtime.sendMessage` by message type and will keep working.

### F-06 · P1 · `sidebar.ts` has become the content script's kitchen

**Where.** `src/sidebar.ts` — 3,020 lines: ~966 lines of CSS in a template string (`464-1430`), width/persistence
(`57-174`), icons (`219-292`), layout metrics (`294-413`), 60 module-level `let`s (`1436-1498, 1998, 2096-2099,
2258-2261, 2822-2858`), DOM build (`1504-1683`), the chevron menu (`1989-2077`), the resize gesture (`2079-2155`),
open/close/theme reveal (`2157-2227`), action availability and the §H hold (`2229-2310`), list rendering and dock
wiring (`2312-2424`), the enlarged-view mount (`2426-2513`), notifications (`2577-2654`), and the page-shrink
machinery (`2656-3020`).

**What.** Each block is individually well written. Together they mean that "add a settings view" or "show a
connection status" touches the same file as "shrink the host page by N pixels", and the module's state is a bag of
booleans with pairwise interactions (`dockSuspended || enlargedDockSuspended`, `addModeHold || !exportEnabled`,
`deferredItems` vs `enlargedView`). `enlargedMount()` (`2430-2460`) is a 13-method ad-hoc interface handed to the
enlarged view so it can reach back into list internals — a sign that the list, not the sidebar, should own those.

**Why it matters.** A third view for connections/settings will add another `visible`-like flag and another
"suspend the dock while I am up" flag. The next `setThumbnails` deferral bug will be found in a 3,000-line file.

**What to do.** Split along the seams the file already labels, without changing the DOM or class names (the tests
and Playwright `SELECTORS` reach in by class):
- `pageShrink.ts` — `2656-3020` verbatim; pure host-page concern, zero UI. Its banner is the best comment block in
  the repo and should move with it.
- `sidebarStyles.css` (see F-09) — the 966-line string.
- `actionRow.ts` — the add group, switch, export group, menu (`1564-1623, 1852-1953, 1989-2077, 2229-2310`).
- `notifications.ts` — `2577-2654`.
- `noteList.ts` — `renderItems`, `focusThumbnail`, `syncDockMotion`, the hold, and the mount methods the enlarged
  view needs (`getListThumb`, `centreListOn`, `getListViewport`), so `enlargedMount()` shrinks to a handful of
  fields.
- Replace the boolean bag with `type SidebarView = 'list' | 'enlarged' | 'settings'` and one `dockSuspendReasons:
  Set<'addMode' | 'enlarged' | 'settings'>`.

**Effort.** 2–3 days. **Risk.** Medium only because of size. `sidebar.test.ts` (117 tests) queries DOM by class and
reads CSS by rule; if the DOM and the concatenated CSS string are unchanged it stays green. Do it as pure moves
first, behaviour changes never in the same commit.

### F-07 · P1 · `EnlargedView` mixes five state machines in one class

**Where.** `src/enlargedView.ts:947-2180` (`class EnlargedView`): geometry (`1199-1242`), DOM (`1120-1193`),
card choreography (`1282-1582`), content crossfade and navigation (`1584-1658`), delete (`1660-1761`), collapse
(`1763-1924`), autosave (`1926-2060` — six `Map`s/`Set`s keyed by item id, all typed for strings), the empty-note
lock (`2062-2099`), keyboard/focus (`2101-2152` — `cycleFocus` is a hard-coded element array), resize (`2154-2179`).
The `Card` record (`884-898`) is `{ el, lift, frame, img, badge, … }` and the morph animates `frame`, `img`, `badge`
as three separate WAAPI tracks (`1480-1491`, `flip.ts:190-231`).

**What.** The choreography and the geometry are excellent and mostly pure. The problem is the *editor* half: draft /
saved / in-flight / failed / sequence tracking is written for one `string` field and is interleaved with the
animation timers. The main card's image is transformed directly (`.xp-card-img`, `transform-origin: 0 0`) with no
wrapper an overlay could share a transform with.

**Why it matters (drawing tools).** The enlarged view is the natural home for the annotation canvas. Today there is
no element to mount it in that survives the FLIP morph without a fourth keyframe track, and no autosave path that
could carry a second field.

**What to do.**
- Extract `AutosaveController<T>` from `1926-2060` with `(equals, serialise, save)` injected; instantiate it once
  for notes now, once for annotations later. The empty-note lock stays a note-specific policy on top.
- Introduce `.xp-card-media` (holds `img` and, later, the annotation layer) and animate *it* with the current `img`
  keyframes; `morphKeyframes` returns the same track under a new name. `Card` gains `media: HTMLElement`.
- Replace `cycleFocus`'s literal array with a query over `[data-xp-focus-order]` inside `this.stage`/`this.front` so
  a toolbar can join the ring without editing the view.

**Effort.** 2 days. **Risk.** Low–medium; `enlargedView.test.ts` (82 cases) drives timers via `T` constants and
asserts on DOM/ARIA state, not on internal maps, so an extraction that preserves behaviour stays green.

### F-08 · P1 · Content-side state lives in module singletons

**Where.** `src/addMode.ts:417-465` (mode, callbacks, 15 element refs, tooltip deadline), `src/sidebar.ts:1436-1498`
(see F-06), `src/theme.ts:282-325` (mode, listeners, hosts, pending writes), `src/content.ts:88-93, 99-142` (an
IIFE with `window.__annotatorActive` and its own `let`s). Consequences in tests: `content.test.ts:116-130`
(`jest.resetModules()` per test to get fresh singletons, with the caveat comment at `18-22` about stale module
references), `_resetThemeStateForTests` (`theme.ts:566-580`), `_resetHintForTests` (`addMode.ts:1244`),
`_resetSaveQueueForTests`/`_resetCaptureQueueForTests` (`background.ts:330, 555`).

**What.** The pattern is consistent and the code guards it well (idempotent `initSidebar`, `startAddMode` no-op
when not idle). But every module that holds a singleton needs a test-only reset export, and `content.ts` cannot be
imported at all — it can only be *executed*. Eight `_…ForTests` exports exist to compensate.

**Why it matters.** Undo/redo history for drawing (per item, discarded on collapse), connection state (global,
long-lived, needs to survive a sidebar close), and a settings view all want an owner with a lifetime. "Another
module-level `let`" is the path of least resistance and the wrong one.

**What to do.** Not a wholesale rewrite. Two targeted moves:
- Make `content.ts` a thin bootstrap that constructs an `App` object (`new App(deps)`) exported from `app.ts`; the
  IIFE guard stays in `content.ts`. Tests construct `App` directly and drop `resetModules`.
- Make `addMode` an instance created per session (`createAddMode(deps)` returning the handle it already almost has)
  so it stops importing `sidebar` for `getSidebarWidth`/`DEFAULT_THUMBNAIL_BOX_SIZE` (`addMode.ts:46`) — that
  import is the one arrow in the graph that points from an overlay *up* to the panel. Pass a `getBounds()` in.
- Leave `theme.ts` and `sidebar.ts`'s width as they are; they are process-wide preferences and a singleton is honest.

**Effort.** 2–3 days. **Risk.** Medium in test churn, low in behaviour; the `content.test.ts` harness comment at
`1-22` is already a description of the seam you would be building.

### F-09 · P2 · CSS lives in TypeScript strings and tests grep the string

**Where.** `src/sidebar.ts:464-1430` (`SIDEBAR_CSS`), `src/enlargedView.ts:469-682` (`ENLARGED_VIEW_CSS`),
`src/addMode.ts:154-411` (`ADD_MODE_CSS`), `src/theme.ts:228-244` (three shared snippet strings pasted into
rules, including `STATE_TRANSITION_CSS.replace(/;$/, ', opacity 140ms ease-out;')` at `sidebar.ts:1380`).
Tests: `sidebar.test.ts:930-933, 1137-1140, 1604-1607` (three copies of `cssRule()`, which returns the *first*
`selector {…}` match by regex), `addMode.test.ts:88-96`, and roughly fifty assertions of the form
`expect(cssRule('.btn-add')).toMatch(/width:\s*38px/)` or `expect(css()).not.toMatch(/\.add-group:hover\s*\{/)`.

**What.** The one-`<style>`-per-closed-root rule (`enlargedView.test.ts:441`, `addMode.test.ts:748`) is the right
architecture for CSP and isolation and should stay. What hurts is the *representation*: 1,400 lines of CSS with no
syntax highlighting, no linting, and tests that couple to whitespace, rule order and the first-match of a selector.
Reordering two rules, or adding a `.btn-add` rule earlier in the sheet for a new state, silently changes what
`cssRule('.btn-add')` asserts.

**What to do.**
- Move each blob to a `.css` file next to its module and import it with esbuild's `text` loader
  (`loader: { '.css': 'text' }` in `esbuild.config.js`; ts-jest needs a `moduleNameMapper`/transform for `.css` →
  string). Runtime behaviour is identical — still one inline `<style>` per root, still CSP-safe, no network.
- For the tests, parse once with jsdom's CSSOM (`styleEl.sheet.cssRules`) and assert on
  `rule.style.getPropertyValue('width')`, which is formatting-insensitive. Caveat, verify first: jsdom's CSS parser
  (cssom) may drop rules with selectors it cannot parse, and this sheet uses `:has()` heavily
  (`sidebar.ts:787, 802, 878-902`). If it does, keep the regex helper but make it assert *all* matches for a
  selector, not the first.
- Consider `adoptedStyleSheets` with a single constructed sheet for the theme block so `getThemeCSS()` is parsed
  once, not once per root. Closed roots support it. This would change the two "one `<style>` element" tests to "one
  adopted sheet"; do it only if the parse cost ever shows up.

**Effort.** 1–2 days. **Risk.** Low for the move (string identity), medium for the test rewrite (fifty assertions).

### F-10 · P2 · The design spec is five patch layers deep and the technical docs have drifted

**Where.** `design/SALAMANDER_SPEC.md`: base (`1-141`), v2 (`145-233`), v3 (`237-359`), v4 (`363-485`), v5
(`489-615`), Q.1 clarification (`617-640`), each opening with "OVERRIDE the sections above where they conflict".
Examples a reader must resolve by hand: §3.1 says "resizable 100–300px" (`82`) but v5 §V derives 188 (`593`);
§3.3 describes a centred modal (`112-117`) that v2 §D replaced (`186`); v2 §A specifies a padlock (`159-166`) that
v3 §A2 removed (`244`); v4 §M sizes peeks at 0.75×main (`436`) and v5 §R rewrites it (`524`); §Q was "read
wrongly" and needed Q.1. `TECH_DESIGN.md:49-51` still says "click-to-place default 200×150px box", "8 resize
handles" and "cancel/ok buttons" (actual: 267×100, invisible zones, cancel/save); its file inventory (`111-133`)
lists `thumbnails.ts` at 97 lines (actual 222). `TESTING.md:18` says ~560 tests and `:296` says 395+ (actual 599).
`DEVELOPMENT_PLAN.md` is a historical build plan presented alongside living docs. `BROWSER_TEST_CASES.md` (35 KB)
is not referenced from `README.md`.

**Why it matters.** The code references the spec 554 times by section letter (`§A2`, `§R`, `§T`…). Those pointers
are the codebase's design rationale, and they point into a document you have to diff in your head. Anyone
onboarding — including a future agent brief — will implement the wrong layer at least once, as Q/Q.1 already shows.

**What to do.** Consolidate `SALAMANDER_SPEC.md` into a single current-state spec (the way `MOTION_SPEC.md` is
written) with a short decisions appendix keyed by stable IDs (`D-01 …`). Rewrite the `§`-pointers in code to the
IDs as files are touched, not in one sweep. Retire `DEVELOPMENT_PLAN.md` to `docs/v2-history/` and bring
`TECH_DESIGN.md`'s three stale sentences and the inventory table up to date.

**Effort.** 1 day for the spec; an hour for the rest. **Risk.** None to code. The risk is doing it *after* the
next feature adds a v6 layer.

### F-11 · P2 · Duplication: copy strings, data-URL codecs, helpers, icons

**Where.**
- User-facing copy declared twice, once per bundle: `"couldn't capture a screenshot here. try again."`
  (`background.ts:235`, `capture.ts:104`); `"couldn't import this bundle. try again."` (`background.ts:419`,
  `content.ts:78`); `"couldn't export feedback. try again."` (`export.ts:23`, `content.ts:74`);
  `"couldn't delete item. try again."` (`background.ts:349`, `enlargedView.ts:112`); `"couldn't save note. try
  again."` (`background.ts:348`, `enlargedView.ts:107`). `content.ts:697-718` maps `ImportErrorCode` → copy while
  the codes live in `types.ts:214-222`.
- Base64/data-URL codecs ×5: `dataUrlToBlob` + `blobToDataUrl` (`background.ts:838-875`), `dataUrlToUint8Array` +
  `uint8ArrayToDataUrl` (`export.ts:90-111`), `uint8ArrayToPngDataUrl` (`import.ts:165-172`). Each carries its
  own copy of the CSP explanation.
- `sendMessage` ×2 (F-05), `clamp` ×2 (`addMode.ts:471`, `background.ts:729`), reduced-motion query ×2
  (`dockMotion.ts:100, 272`, `enlargedView.ts:902-911`), rAF-with-fallback ×2 (`dockMotion.ts:259-270`,
  `enlargedView.ts:2211-2219`).
- Icon attribute strings ×3 (`sidebar.ts:226-228`, `enlargedView.ts:688-690`, `thumbnails.ts:55-57`); the
  chevron/arrow paths appear in both `sidebar.ts:243-245` and `enlargedView.ts:699-700`.

**What to do.** `src/copy.ts` (pure strings, imported by both bundles), `src/dataUrl.ts` (one codec pair with the
CSP note written once), `src/icons.ts`, and fold the small helpers into `flip.ts`/a `dom.ts`. The `thumbnails.ts →
sidebar.ts` one-way import that forced `ICON_TRASH` to live in `thumbnails.ts` (`54-61`) disappears once icons
have their own module.

**Effort.** Half a day. **Risk.** Nil; every one of these strings is asserted byte-exact somewhere in the tests,
which is exactly the protection you want.

### F-12 · P2 · The content script bundle carries 100 KB it never uses on the page

**Where.** `esbuild.config.js` (`minify: false`, `sourcemap: true`); measured composition of `content.js` (365 KB
unminified, 204 KB minified): `js-yaml` 91 KB, `sidebar.ts` 76 KB, `enlargedView.ts` 63 KB, `addMode.ts` 30 KB,
`wordlist.ts` 21 KB, `fflate` 12 KB. `js-yaml` reaches the content bundle through `content.ts → import.ts →
bundle.ts`; only `yaml.load` is used there, for parsing a picked zip.

**Why it matters.** This file is injected into every page the user opens the sidebar on, and re-injected on every
full reload while it is open (`background.ts:99-122`). 365 KB of unminified JS is parse and memory cost on the
host page — a "never disturb the host page" concern, not a vanity metric.

**What to do.**
- Turn `minify` on for production (keep sourcemaps). Free.
- Move zip parsing + the §5 ladder to the service worker: the picked `File` becomes an `ArrayBuffer`, sent as
  base64 (the codebase already sends every screenshot that way, `messages.ts:338-352`), and `IMPORT_REPLACE` takes
  the bytes. `js-yaml` and `fflate` then leave the content bundle entirely (−100 KB), and `import.test.ts` moves with
  the code unchanged. The only thing the content side must still do is show the §5 #10 confirmation, which it
  already does in a separate step.
- `wordlist.ts` (21 KB) is used once, in `idHasDictionaryWord` (`selectorBuilder.ts:145-151`). It is needed at
  capture time so it has to stay; a `Set` built from a compact string at first use instead of a 1,507-line literal
  would halve it, but this is P3.

**Effort.** Half a day for minify + the import move. **Risk.** Low; the validation ladder is pure over bytes.

### F-13 · P2 · Comments: mostly helping, with a specific kind that hurts

**Where.** Comment density by file (comment lines / total): `keyboardIsolation.ts` 59%, `urlNorm.ts` 52%,
`thumbnails.ts` 48%, `messages.ts` 44%, `capture.ts` 44%, `selectorBuilder.ts` 40%, `content.ts` 38%,
`sidebar.ts` 36%, `types.ts` 33%, `theme.ts` 32%, `addMode.ts` 31%; the big behavioural files are lower
(`enlargedView.ts` 22%, `dockMotion.ts` 25%, `flip.ts` 24%).

**What helps** (keep exactly as is): constraint and rationale banners that a reader cannot reconstruct from the
code — `background.ts:572-631` (why the crop scale is measured, and against which of two widths),
`background.ts:820-837` (why `fetch(dataUrl)` must never come back), `sidebar.ts:2656-2813` (the page-shrink
strategy and its rejected alternatives), `enlargedView.ts:783-813` (why the scroll lock's exemption test is
"can consume", not "path contains host"), `keyboardIsolation.ts:1-36`, `capture.ts:35-45` (double rAF),
`theme.ts:289-299` (own-write echo suppression). These are the codebase's institutional memory and they are why
the "What not to change" list in §5 could be written at all.

**What hurts:**
- *Phase narration.* 72 references to "Phase N" across `src/` — `messages.ts` alone has 14, e.g. `"Phase 2 also
  returned the full-resolution crop inline … Phase 5 dropped it"` (`messages.ts:133-140`), `"Phase 7's modal will
  fetch"` (future tense about the past). `storage.ts:220-226` carries a `TODO(Phase 2)` whose work was done (no code
  writes `activeTab:` keys any more) and `background.ts:136-146` still runs the cleanup for it on every startup.
  Git has this history; the comments now mislead.
- *Spec pointers as identifiers.* 554 `§` references that will all rot when F-10 lands.
- *Restating the rule.* Runs of CSS where every declaration has a sentence (`sidebar.ts:1081-1116` is a 36-line
  comment on one `.body` rule). Some of that is genuinely non-obvious (the clip-path/pointer-events dance); much is
  "this is 16px because the spec says 16px".

**What to do.** Adopt a one-line policy in `CONTRIBUTING`/`TESTING.md`: comments explain *constraints and rejected
alternatives*; they do not narrate *when* something changed or *which phase* did it. Delete phase narration as
files are touched; convert `§` pointers to decision IDs with F-10. Do not attempt a repo-wide comment sweep — the
signal-to-noise is high enough that a blanket cut would remove the good ones.

**Effort.** Ongoing; an hour per file as touched. **Risk.** None.

### F-14 · P2 · Error handling is a single 8-second banner and a set of unused codes

**Where.** `sidebar.ts:2583-2624` (one `.notif` slot, auto-clear, last message wins);
`messages.ts:128` (`CaptureErrorCode` has three values; every branch returns the same string, `background.ts:268-277`
— nothing downstream reads `code`); `storage.ts:117-133` (`updateNote` is a silent no-op when the item is gone, so
`UPDATE_NOTE` returns `ok: true` and the enlarged view marks the draft saved — reachable after a cross-tab import
replaced the domain while the view was open); `content.ts:565-568` (a failed `GET_PAGE_ITEMS` paints an empty list
*and* a banner, which reads as "no feedback here yet" once the banner clears).

**Why it matters.** For the current product these are edge cases. Connections need *persistent* state
("connected / syncing / failed since 14:02"), and a transient single-slot banner has nowhere to put it. The
never-read error codes are a small illegal-state smell: the type promises a distinction the UI cannot show.

**What to do.** Keep the banner for transient errors. Add a `role="status"` line (the enlarged view already has
one, `enlargedView.ts:1173-1178`) for persistent state when connections arrive. Make `updateNote`/`deleteItem`
return `{ found: boolean }` so a vanished item surfaces as a failure. Either use `CaptureErrorCode` in the copy or
drop it.

**Effort.** Half a day now, more with connections. **Risk.** Nil.

### F-15 · P2 · A refresh race and a context-capture cost worth knowing about

Two things I would not call bugs without a reproduction, flagged so they are not discovered mid-feature.

- `content.ts:558-571` `refreshThumbnails()` has no request token; two rapid SPA navigations issue two
  `GET_PAGE_ITEMS` and the last *response* wins, not the last *request*. In practice the background serialises reads
  through `enqueueSave` (`background.ts:351-363`) so responses arrive in order today; a future handler that answers
  out of the queue (e.g. a cached read) would expose it. A monotonically increasing token compared in the callback
  costs three lines.
- `contextCapture.ts:166-185` walks every descendant of the primary target and calls `getComputedStyle` +
  `getBoundingClientRect` on each (`isRenderedVisible:420-426`, `getPageRect:387-395`). A selection whose deepest
  common ancestor is `<body>` on a 10k-node page does 10k forced style reads before the overlay is even hidden.
  Cheap fix if it ever bites: bail out of `walk` once `found.length` passes a hard ceiling (say 500; the cap is 15
  after scoring anyway), or skip `getComputedStyle` for elements whose rect is already empty.

**Effort.** An hour each. **Risk.** Nil.

### F-16 · P3 · Dead and test-only surface

**Where.** `storage.ts:220-261` (`setTabActive`, `removeTabActive`, `isTabActive`, `cleanupStaleTabKeys` — no
writer exists) and `background.ts:136-146` (`handleStartup` calling it); `imageStore.ts:81-92` (`clearAllImages`,
unused); `sidebar.ts:2159-2161` (`isSidebarInitialised`), `2490-2492` (`isEnlargedViewOpen`), `2421-2424`
(`setDockMagnificationSuspended` exported, only used internally); `sidebar.ts:2592-2594` (`showWarning`'s
`customIcon` parameter and the exported `ICON_WARNING`, no caller passes one); `theme.ts:155-165`
(`FONT_ASSET_PATHS`, only a type source); `sidebar.ts:1846` registers the host with `registerThemedHost` and
`destroySidebar` (`2519-2575`) never unregisters it; `theme.ts:423` adds a `chrome.storage.onChanged` listener that
`_resetThemeStateForTests` cannot remove. `package.json` says `"name": "annotator", "version": "1.0.0"` while
`manifest.json` says `salamander` / `1.1.0`; `@types/js-yaml` is in `dependencies`; `jest.config.js` uses the
deprecated `globals['ts-jest']` form (a warning on every run).

**What to do.** Delete the legacy block and its startup hook; drop the three unused exports; unregister the themed
host in `destroySidebar`; fix the three config nits. Keep the `_…ForTests` exports until F-08 removes the need for
each one.

**Effort.** One hour. **Risk.** Nil.

### F-17 · P3 · Type modelling: small places where illegal states are representable

- `ImportErrorCode` (`types.ts:214-222`) includes `'VERSION_MISMATCH'` with the comment "warning only; import still
  proceeds" — a member of an *error* union that is never thrown (`import.ts:52-53`). Model it as
  `versionWarning: boolean` (which `ParsedImportBundle` already does) and drop it from the union.
- `AddButtonState = 'off' | 'on' | 'locked'` (`sidebar.ts:1752`) — `'locked'` outlived the padlock it named (v3 §A2
  keeps the value on purpose, `1748-1751`). Rename to `'kept-on'` when the file is next touched; content.ts's
  `addLocked` likewise.
- `EnlargedView` tracks `state: EnlargedState` plus `deleting: boolean` plus `collapseAfterDelete: boolean`
  (`948, 1008-1009`); "closing while deleting" is representable. A single union
  (`'opening' | 'open' | 'deleting' | 'closing' | 'closed'` with `pendingCollapse` inside `'deleting'`) removes a
  class of ordering bugs the code currently guards with `if (this.deleting)` checks in five places.
- `tsconfig.json` is `strict` but not `noUncheckedIndexedAccess` or `noUnusedLocals`. The former would flag
  `this.items[this.idx]` reads that are already guarded; low value, skip. The latter is free and would have caught
  the dead exports in F-16.

**Effort.** Hours, opportunistic. **Risk.** Nil.

### F-18 · P3 · Where the storage boundary actually is, written down once

**Where.** `storage.ts:9-12` says "Content scripts never touch chrome.storage.local/session or IndexedDB
directly"; `TECH_DESIGN.md:19` says the background "routes all storage reads/writes". `sidebar.ts:81-85, 150-174`
(width) and `theme.ts:356-405` (theme mode) read and write `chrome.storage.local` from the content script, with a
justification at `sidebar.ts:81-85`.

**What.** The exception is reasonable — UI preferences are not domain data and a round trip for them is silly —
but it is undocumented at the architecture level, and connections will immediately ask the same question for
"which connection is active". Write the rule: *preferences (`themeMode`, `sidebarWidth`, and later connection
selection) may be accessed directly from either context; feedback data and blobs only through the service worker.*

**Effort.** Ten minutes. **Risk.** Nil.

---

## 3. The three planned features

### 3.1 Drawing / annotation tools on captured screenshots

**Where it fits.** Post-capture, inside the enlarged view, inside the sidebar's closed shadow root. This is the only
placement that keeps the "nothing of ours in a screenshot" requirement trivially true: add mode collapses the
enlarged view before it starts (`content.ts:156-161`), and nothing the enlarged view draws is ever on the page
side of the sidebar. Drawing *during* capture (on the live page) would put a drawing layer inside
`hideOverlayUI()`'s scope and is a different, riskier feature; recommend against it for v1 of the tools.

**What obstructs it today, concretely.**

1. **No field, no mutation, no migration** (F-01). `FeedbackItem` has nowhere to put an annotation document;
   `UPDATE_NOTE` is the only write; old records cannot be upgraded.
2. **Write amplification** (F-04). Annotation autosave on every stroke batch through whole-record rewrites.
3. **No overlay-able element in the morph** (F-07). `.xp-card-img` is transformed directly by `morphKeyframes`'s
   `img` track (`flip.ts:214-226`); a sibling canvas would either not move or need its own identical track.
4. **Autosave is note-shaped** (F-07). `drafts/saved/inflight/failed/saveSeq: Map<number, string>`
   (`enlargedView.ts:982-990`) and `itemsForList` (`1851-1857`) all assume the draft is the note.
5. **Two coordinate systems for the image.** The stored PNG is at device pixels (`item.dpr`); the enlarged view
   displays at `selectionRect` CSS size scaled to fit (`computeEnlargedGeometry:323-328`), and `naturalFor`
   (`1199-1206`) may replace the height from the loaded image's aspect. Annotation coordinates must be stored in
   *image pixel space* (or normalised 0–1) and mapped through the card's current `containFit` box, never in screen
   px.
6. **Export cannot rasterise SVG in the service worker.** `createImageBitmap` from an SVG blob is not supported in
   workers, and the SW has no DOM. If exported PNGs should show the annotations burned in, the annotation model must
   be a **vector command list** (shapes/arrows/text with numeric coordinates) rendered by one pure
   `drawAnnotations(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, model, scale)` used both in
   the enlarged view and in `export.ts` via `OffscreenCanvas`. Text rendering in the SW needs the bundled fonts
   registered on `self.fonts` (WorkerGlobalScope has a `FontFaceSet` in Chrome — verify before relying on it; the
   fallback is the system font, which is acceptable for a burned-in export).
7. **Thumbnails.** `thumbnailDataUrl` is minted in the SW at capture (`background.ts:753-789`). If thumbnails
   should reflect annotations, add a `REGENERATE_THUMBNAIL` message that re-renders from the stored PNG + model
   using the same `drawAnnotations`; otherwise leave thumbnails un-annotated and say so.
8. **Undo/redo** is per-item editor state that must not survive collapse; `EnlargedView` is a per-open instance
   (good) but F-08's singletons in `sidebar.ts` are the wrong home for it. Put it in an `AnnotationEditor` class
   mounted into `.xp-card-media`, owning its own history stack; the enlarged view only routes keyboard events to it
   when it has focus (the existing `onKeydown` at `2103-2138` already dispatches by `activeElement`).
9. **Keyboard/focus.** `cycleFocus`'s literal order (`2143-2147`) and the `aria-modal` dialog need the toolbar and
   canvas added; `inert` on the list stays as is. Reduced-motion handling needs nothing new (drawing has no motion).
10. **Layers/serialisation.** Model: `{ version: 1, layers: [{ id, name, visible, ops: Op[] }] }`, `Op` a
    discriminated union by `kind`. Put the schema in `src/annotations/model.ts` with its own version so the storage
    migration (F-01) and the bundle codec (F-03) can each reference it without owning it.

**What unblocks it.** F-01 → F-04 → F-07 (media wrapper + autosave extraction) → F-03 (so the export carries the
model as a second fenced block or a sidecar `annotations/{id}.json` in the zip). F-08 is helpful but not required.

**Requirements at risk and their protection.** Screenshot purity: none, if drawing stays inside the enlarged
view. Performance of morphs: the canvas must be a child of the transformed media wrapper so it costs nothing extra
per frame; `will-change` is already managed by the morph. Accessibility: every tool is a real `<button>` with the
existing focus ring (`FOCUS_RING_CSS`), the canvas gets `role="img"` + an `aria-label` derived from the ops count,
and there must be a keyboard path to at least delete/undo. Closed shadow root: unchanged.

### 3.2 Connections / MCP servers

**The decision first** (F-02). Nothing below is worth starting until the no-network requirement and the CSP are
re-decided and written down.

**What obstructs it today, concretely.**

1. **CSP and permissions** — `manifest.json` `connect-src 'none'`; no optional host permissions; `README.md`
   privacy claims.
2. **Service-worker lifetime.** Every handler in `background.ts` is request/response and completes in
   milliseconds. A sync that pushes 50 screenshots is minutes. It needs `chrome.alarms`, resumable state in
   storage, and progress reporting — which the one-shot `sendMessage` channel cannot carry (F-05). Use a
   `chrome.runtime.connect` port for progress; keep `sendMessage` for everything else.
3. **No global storage namespace.** `storage.ts` is domain-keyed only. Connections are global config plus per-domain
   or per-item sync bookkeeping ("item 7 was pushed to server X at T"). Add `connections:{id}` (config) and
   `sync:{domain}:{itemId}` (state) namespaces, or put sync state in the item record via F-01's `updateItem` patch.
4. **Secrets.** `chrome.storage.local` is plaintext on disk. Access tokens → `chrome.storage.session`; long-lived
   secrets → don't, prefer OAuth refresh or `chrome.identity`.
5. **No settings surface** (F-06). The chevron menu (`sidebar.ts:1989-2077`, `role="menu"`, one item) was designed
   to grow ("future actions live behind a single affordance", `REQUIREMENTS.md:154`) and is the right entry point
   for "connections…". The panel it opens is a third in-sidebar view; the sidebar has no view state, only flags.
   Introduce `SidebarView` before adding the panel.
6. **Persistent status** (F-14). "Connected / last synced / failed" needs a home that isn't an 8-second banner.
7. **Export as the wire format.** Whatever the MCP push sends will be the revised bundle (§3.3). `buildFeedbackMarkdown`
   already runs service-worker-side (`export.ts:48-68`), which is where the network call will be; keep it a pure
   function of `DomainData` so zip export and MCP push are two consumers of one serialiser.
8. **Async config UI.** Every existing control is synchronous; a connection form needs loading/disabled/error
   states on a group of controls. `syncActionAvailability`'s pattern (`sidebar.ts:2263-2270` — independent reasons
   resolved in one place) is the right one to copy, per control.

**What unblocks it.** F-02 (decision) → F-05 (typed channel + a port variant) → F-06/F-08 (view state, settings
mount) → F-18 (the boundary rule for where config is read).

**Requirements at risk.** *No network calls* — explicitly changed by decision; keep the default install
zero-network via optional permissions. *Host page undisturbed* — unaffected as long as all network work is in the
service worker, never the content script (the host page's CSP would block it anyway; `theme.ts:611-621` shows the
one exception and why it works). *Closed shadow root / screenshot purity* — unaffected. *Accessibility* — a form
inside the sidebar needs labels, `aria-describedby` errors and focus management on open/close; reuse the enlarged
view's `role="status"` pattern.

### 3.3 Revised feedback markdown / export structure

**What obstructs it today, concretely.**

1. **One version, one parser** (F-03). `parseFeedbackMarkdown` is the only reader; changing it orphans existing
   bundles. `SCHEMA_VERSION` (`bundle.ts:46`) only produces a warning on *newer*; there is no "older" path because
   there has never been an older format.
2. **Hand-mirrored types** (F-03, F-01). Four places to edit per field.
3. **Fixtures generated by the exporter** (`import.test.ts:77,134,188,246`). No frozen v1 text exists to prove
   backward compatibility.
4. **Grammar fragility.** Headings and fences are detected by line regex (`bundle.ts:33-35`); notes cannot contain
   `## `, `### item N` or ```` ```yaml ```` at line start. The revised structure will want richer per-item prose
   (annotations list, status, links) and richer YAML; both raise the collision odds.
5. **Duplication in the payload.** `page_meta` repeats five item fields (`bundle.ts:141-149` vs `119-125`). The
   revision is the moment to pick one home.
6. **Screenshots-by-id naming** (`screenshots/{id}.png`, `bundle.ts:102`, `import.ts:113`) is fine, but if
   annotated exports exist there need to be two files or a burned-in one; decide with §3.1.

**What unblocks it.** F-03 alone, done *before* the new structure is designed: `bundle/v1.ts` frozen with a real
fixture, `bundle/v2.ts` for the revision, a dispatcher on the line-1 version comment, and a field table instead of
twin mappers. Then the revision is a new file plus one fixture, not a rewrite.

**Requirements at risk.** §1.6/§1.7's "single human/agent-readable `feedback.md`, also what the extension
re-parses" — keep that principle; a second machine-only file was rejected deliberately (`REQUIREMENTS.md:12`). §5's
13 import errors with byte-exact copy — the ladder stays; only the parser behind step #4b changes.

---

## 4. A suggested sequence

Ordered to minimise rework and to give a green suite at every checkpoint. Items marked ∥ can run in parallel with
their neighbours because they share no files.

**Checkpoint 0 — decide.** F-02 (connections permission model) and the F-03 question of whether `page_meta` stays
duplicated. Half a day of writing. Nothing else depends on the *outcome*, but everything in phase 3 depends on it
being *made*.

**Checkpoint 1 — cheap, zero-risk hygiene (≈1 day).** F-16 dead code · F-11 shared `copy.ts`/`dataUrl.ts`/`icons.ts`
· F-12 `minify: true` · F-18 write the storage-boundary rule · F-10's `TECH_DESIGN.md`/`TESTING.md` corrections.
All ∥. Suite stays green throughout because every string moved is asserted byte-exact.

**Checkpoint 2 — data model foundations (≈3–5 days).** F-01 `updateItem` + migration hook → F-04 record split
(∥ with F-03 codec split; different files) → F-05 typed channel. After this, `npx jest` plus a manual round trip
(capture → edit → export → import) on a real site, because storage migration is the one thing jsdom cannot prove.

**Checkpoint 3 — UI structure (≈4–6 days).** F-06 split `sidebar.ts` (pure moves first) ∥ F-07 extract the
autosave controller and add the media wrapper ∥ F-09 move CSS to files. Then F-08 (`App` object, per-session add
mode) once the sidebar split has settled — it is the only one here that changes the test harness. Checkpoint: the
Playwright suite, since `SELECTORS` are the external contract these moves must not break.

**Checkpoint 4 — spec consolidation (≈1 day, any time after checkpoint 1).** F-10, ideally before the first
feature adds a v6 layer. F-13's comment policy goes in the same commit.

**Then the features**, in this order: export revision (smallest, exercises the new codec), drawing tools (largest,
exercises F-01/F-04/F-07), connections (needs everything, and its decision has had the longest time to settle).

Things that are independent enough to hand to separate people or agents at once: {F-11, F-16, F-12}, {F-03,
F-04}, {F-06, F-07, F-09}. Things that must be serial: F-01 before F-04; F-06 before F-08; F-05 before any port
work.

---

## 5. What NOT to change

These look odd on first read and are load-bearing. Most are documented in place; this list is the index.

**Isolation and the host page**
- **Closed shadow roots, one `<style>` per root, hosts attached to `<html>` not `<body>`** (`sidebar.ts:1831-1841`,
  `addMode.ts:639-643, 707`). The `attachShadow` monkey-patch in tests (`sidebar.test.ts:25-32`) and in the
  Playwright helper is the *correct* trade for keeping production closed.
- **Page shrink via `margin-right` + `width: auto` + `min-width: 0` + `overflow-x: hidden` on `documentElement`,
  as `!important` inline declarations, backed by an injected stylesheet and a capped `MutationObserver`**
  (`sidebar.ts:2656-3002`). The banner lists the alternatives that were tried and why each fails (`box-sizing`
  override re-sizes the whole page; `transform` on an ancestor captures our own fixed panel; `overflow: hidden` on
  body breaks `position: sticky`). The YouTube limitation is documented as accepted (`REQUIREMENTS.md` §6 #13).
- **Per-property restore of `<html>`'s inline style, not a `cssText` snapshot** (`2881-2898`), so a page's own
  scroll-lock set after open is not reverted.
- **Synthetic `resize` after apply/restore** (`2996-3002`) so JS-measured layouts re-run.
- **Keyboard isolation = capture-phase `window` listeners that `stopPropagation()` but never `preventDefault()`**
  (`keyboardIsolation.ts`), installed only while a surface is open; and the global Esc handler registered *once, in
  `ensureStarted`*, so it precedes add mode's isolation in registration order (`content.ts:292-306, 414`).
- **Scroll lock at the event level, never `overflow: hidden`** (`enlargedView.ts:814-873`), with the "can an
  element before the host consume this delta" exemption — the comment explains exactly which wrong version looks
  like it works.

**Capture correctness**
- **`dataUrlToBlob` decodes base64 by hand** (`background.ts:838-859`). The idiomatic `fetch(dataUrl)` dies under
  `connect-src 'none'` in a service worker while unit tests stay green. If F-02 loosens the CSP this becomes
  *possible* again, but keep the manual decoder anyway — it has no network stack to reason about.
- **Crop scale is measured from the returned image, against two candidate CSS widths, choosing the one nearest
  `dpr`** (`background.ts:666-727`; contract in `messages.ts:67-111`). Do not "simplify" to `× devicePixelRatio`.
- **Double `requestAnimationFrame` (with a timeout) between hiding the overlay and asking for the capture**
  (`capture.ts:35-45, 179-197`). A `setTimeout` is not equivalent.
- **Selection bounds use `documentElement.clientWidth` (scrollbar-excluded) minus the *live* sidebar width**
  (`addMode.ts:475-499`, `capture.ts:130-148`); the fixed `DEFAULT_THUMBNAIL_BOX_SIZE` is deliberately *not* live
  (`sidebar.ts:315-332`).
- **`captureContext` runs before the overlay hides and walks from `<body>`** (`capture.ts:245-263`), so the
  extension's `<html>`-attached hosts never leak into the captured context.
- **Dock magnification is suspended for the whole of add mode, snapping to rest with no release animation**
  (`sidebar.ts:2410-2424`, `dockMotion.ts:620-634`) — a swollen item bleeds over the page that is about to be
  photographed.

**Storage and messaging**
- **Ids are allocated in the service worker; import preserves them; screenshot keys are never in the bundle**
  (`background.ts:283-303, 436-452`).
- **One serialised write queue for every domain-record mutation, reads included** (`background.ts:297-303, 351-363`)
  — needed until F-04, and still needed for `nextItemNumber` after it.
- **A failed capture deletes its already-written blob** (`background.ts:314-326`); a failed import deletes only the
  blobs it wrote and leaves the previous domain data intact (`453-495`).
- **Images are data-URL strings in IndexedDB, not `Blob`s** (`imageStore.ts:9-22`); every hop already speaks
  data-URL and the SW has no `FileReader` guarantee.
- **Thumbnails are JPEG, full captures PNG** (`background.ts:639-646`); §1.3's "lossless" governs the stored
  capture, not the render-only copy.
- **Theme own-write echo suppression** (`theme.ts:289-379`) — rapid toggling flickers without it.
- **`chrome.storage.session` for "sidebar open", `chrome.storage.local` for width and theme** (§1.1 decision;
  `sidebar.ts:81-85`).

**UI details that were fought for**
- **Press = fill change only, no scale, anywhere** (spec §2; `theme.ts:230-235` retires `PRESS_SCALE_CSS`) — the
  scale slid the open menu out from under the pointer.
- **Switch reveal on `:has(:focus-visible)`, not `:focus-within`** (`sidebar.ts:789-803`) — a mouse click focuses
  the button and would pin the switch open.
- **The switch tucks one radius under the button; the collapsed state zeroes its border *and* its negative margin**
  (`sidebar.ts:349-372, 446-449`) — otherwise a stray hairline and a 39 px group.
- **`SIDEBAR_MIN_WIDTH` is derived from the action-row constants, never a literal** (`sidebar.ts:379-395`).
- **The hover delete is a sibling of the thumbnail `<button>`, never a child** (`thumbnails.ts:177-197`) — nested
  buttons are invalid HTML and break activation.
- **List items are real `<button>`s with a `keydown` handler that `preventDefault()`s Enter/Space**
  (`thumbnails.ts:199-209`) to avoid the double activation.
- **Rail buttons use `aria-disabled`, not `disabled`** (`enlargedView.ts:2199-2202`) so focus survives reaching the
  end; **`inert` on the list is set only at `settleOpen`** (`1103-1116`) so Esc during the expand still reaches the
  host.
- **`.xp-front` bleeds 48 px left of the panel edge** (`enlargedView.ts:160-163`) for the first frame of a morph
  from a dock-magnified thumbnail.
- **`.body`'s clip-path / `is-bleeding` pointer-events dance** (`sidebar.ts:1081-1129`) — how magnified items paint
  over the page without swallowing its clicks or breaking the list's scrollbar.
- **Mouse events, not Pointer Events, for the resize drag** (`sidebar.ts:2079-2094`) — pointer capture is not in
  jsdom and the whole feature would go untested.
- **The comment box is built lazily on first placement** (`addMode.ts:697-703, 710-765`) — §1.2 forbids it
  existing before a selection.
- **`waitForNextPaint`'s 250 ms timeout** (`capture.ts:106-111`) so a backgrounded tab fails fast with the overlay
  restored instead of hanging with the page blocked.
- **Every timer/animation/listener in the enlarged view is cancelled in `finish()` and nowhere else**
  (`enlargedView.ts:1859-1913`); `deleteTimer` is deliberately not `settleTimer` (`1004-1006`).

The common thread: almost every one of these exists because a simpler version was tried and failed on a real page.
The comments say which page. Trust them.
