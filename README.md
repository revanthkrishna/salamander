# salamander

> Chrome extension for visual feedback on any webpage. Select an area, draw on it if you like, write a note; salamander screenshots the area, records where it sits in the DOM, and exports everything as a bundle a developer or an AI coding agent can act on without the live page.

Version 2.1.0 · Manifest V3 · MIT

---

## what it does

- **select and screenshot** — a sidebar opens beside the page (the page shrinks, nothing is covered). Click or drag to select an area; resize it from any edge or corner. The screenshot is cropped to the selection at native device pixels.
- **draw** — a pencil (yellow, black or red, 2px) for marking up the selection before saving. Undo with Cmd/Ctrl+Z. The drawing is kept as its own layer on the note and burned into the PNG only at export.
- **note** — a comment box with a 1000-character limit. Notes autosave when edited later; a note can never be empty.
- **context** — every note carries a CSS selector, an XPath, a sanitised HTML snippet, the elements inside the selection, the visible text, and page metadata, so the code can be found without the page.
- **review** — notes for the current URL appear as thumbnails with dock-style magnification; click one and the sidebar expands into an enlarged view: every note on the site on one scrolling page, grouped by page, each editable in place, with pages you can rename.
- **export / import** — one `.zip` per site: `screenshots/{id}.png` plus a single `feedback.md` that people and agents read and the extension imports back.
- **private** — no network requests at all (`connect-src 'none'`). Data lives in the browser profile until you export or delete it.

---

## install (unpacked)

```bash
npm install
npm run build          # esbuild → dist/background.js, dist/content.js
```

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → pick the project root (the directory with `manifest.json`).
3. The salamander icon appears in the toolbar. After every rebuild, click the extension's reload icon and refresh any open test tab (an already-injected content script is orphaned by an extension reload).

Requires Chrome 105 or newer (`chrome.storage.session`, CSS `:has()`). The `dist/` directory is not committed, so the build step is required.

---

## how to use

1. Click the icon → the sidebar opens on the right and the page narrows to make room. Drag the sidebar's left edge to resize it (210–300px); the width is remembered.
2. Click **add note** (the comment-bubble button). The cursor becomes a crosshair and a preview box follows it.
3. Click to place a 267×100 box centred on the pointer, or press and drag to draw your own. Resize from the invisible edge/corner zones (minimum 20×20).
4. Inside the box the cursor is a pencil: draw if you want, switch colour with the swatches, **erase all** from the pencil menu, Cmd/Ctrl+Z to undo a stroke.
5. Type a note (placeholder "type a note…") and click **save**. The overlay hides for one frame, the screenshot and DOM context are captured, and the note appears at the bottom of the list. **cancel** discards it; clicking outside the box does nothing.
6. To capture several in a row, hover the add button and flick **keep add mode on** — after each save you are straight back in add mode. Click the button or press Esc to stop. Double-click or shift+click the button does the same as the switch.
7. Shortcut: with the sidebar open, **Option+N** (Mac) or **Alt+N** (Windows/Linux) adds one note, like a single click on add note. It does nothing while you are typing, while a note is being placed or while the enlarged view is open. Until you have used it, the third time in a browsing session you start add mode with a click, the hint beside the cursor says "tip: press ⌥N to add a note" ("alt+n" off the Mac) instead of "click or drag to select" — at most three times per install.
8. Click a thumbnail to open the enlarged view: every note on the site, page by page (oldest page first), each under its page's name and address, the page you are on labelled "this page". The note you clicked has the cursor, with the last 40px of the row before it peeking under the top bar (for a page's first note, the page's heading shows whole below that peek). Every note is editable at once and autosaves; a note can't be left empty ("note required"). Click the pencil beside a page's name to rename it (Enter saves, Esc cancels, an empty name restores the page's title) — the name is used in the export too. The trash icon above a note deletes it. **delete all**, beside the exit button at the top right, deletes every note on every page of the site after asking "confirm?" in place (yes, delete all / cancel; Esc cancels the question). Esc, the scrim or the exit button (›) at the top right closes the view. Hover a thumbnail for a delete button that skips the enlarged view.
9. Browse the site normally — the sidebar stays open across SPA navigation and full reloads, showing the notes for whatever URL you are on. Notes are numbered by their position on the page — every page counts from 1, and deleting a note renumbers the ones after it.
10. **export** downloads `feedback-{domain}-{date}.zip` with every note on the site. The **more options** button (⋯) beside it holds **import**, which replaces the site's notes with a bundle's (after confirmation if any exist), and **delete all on this website**, which deletes every note on every page of the site after a confirmation quoting how many.

All visible UI text is lowercase by design. The extension is dark-themed only.

---

## the bundle

```
feedback-example_com-2026-09-22.zip
├── feedback.md
└── screenshots/
    ├── 1.png
    └── 2.png
```

`feedback.md` (format 3 — the full rules are in `design/SALAMANDER_SPEC.md` §AC, the frozen example in `src/__tests__/fixtures/feedback-v3.md`):

````markdown
<!-- salamander-feedback-format: 3 -->
salamander 2.1.0\
**date exported:** 2026-09-22 14:05 utc+01:00\
**website:** example.com

## page "https://example.com/pricing"

### note 1

![note 1 — marked up by the reviewer](screenshots/1.png)

**note:** the "start trial" cta is misaligned on mobile

<details>
<summary>element data</summary>

```json
{
  "text": "start trial",
  "selector": "section.plans > div:nth-of-type(2) > a.btn",
  "xpath": "/html/body/main/section[2]/div[2]/a",
  "html": "<a class=\"btn btn-primary\" href=\"/signup?plan=team\">start trial</a>",
  "page_url": "https://www.example.com/pricing?plan=team",
  "note": "the \"start trial\" cta is misaligned on mobile",
  "id": 1,
  "normalised_url": "https://example.com/pricing",
  "page_title": "pricing — example",
  "created_at": "2026-09-20T10:15:30.000Z",
  "selection_rect": { "x": 412, "y": 1188, "width": 267, "height": 100 },
  "viewport": { "width": 1280, "height": 720 },
  "dpr": 2,
  "contained_elements": [ { "tag": "a", "text": "start trial" } ],
  "area_text": "team $12 / seat start trial"
}
```

</details>
````

- Line 1 is the format stamp import checks; only format 3 is read (no backward compatibility: 2.0/2.1's format-2 exports, with `### feedback n` headings, are refused).
- One `## page` section per normalised URL, notes in capture order. `### note n` is the note's position on its page (from 1 on every page, the same number the sidebar shows); `screenshots/{id}.png` is the note's internal id, unique across the site. Each note's JSON is the complete record; the visible `**note:**` line is for people and ignored on import.
- Free text in the JSON is capped (`text` 120, `html` 300, `area_text` 200, element text/attributes 80) and ends in `…` when cut. Notes and identifiers are never cut.
- `page_title` is the page's name as the enlarged view shows it: the name you gave it there, else the HTML title captured with its notes. Re-importing brings a given name back as those notes' title.
- A drawing is only ever in the pixels: the alt text says "marked up by the reviewer" so a reader knows the marks are not part of the page. Re-importing keeps it flattened into the image.

Import validates before writing anything, in order: file type → readable archive → `feedback.md` present → format stamp → item structure and JSON fields → every screenshot present → no duplicate ids (nor the same number twice on one page) → domain matches the current site. Every message is lowercase and listed in `REQUIREMENTS.md` §5.

---

## permissions and privacy

| Permission | Why |
|---|---|
| `storage` | Notes and sidebar state |
| `unlimitedStorage` | Screenshots exceed the 10MB default quickly |
| `scripting` | Inject the content script on demand |
| `tabs` | Re-inject after a reload while the sidebar is open; clean up on tab close |
| `downloads` | Export the bundle |
| `<all_urls>` | Works on any site (not `chrome://`, the Web Store or the PDF viewer, where content scripts cannot run) |

CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'`. The one dependency (`fflate`) is bundled. Metadata lives in `chrome.storage.local`, PNGs in extension-origin IndexedDB, per-tab sidebar state and the pencil colour in `chrome.storage.session`. Screenshots capture what is on screen, form fields included — there is no masking.

---

## development

```bash
npm run build          # esbuild, minified, sourcemaps → dist/
npm run build:watch    # rebuild on change (still reload the extension in Chrome)
npm test               # jest, jsdom (TESTING.md lists the suites)
npx jest sidebar       # one suite
npx tsc --noEmit       # type check (strict, noUnused*, exactOptionalPropertyTypes)
npx playwright test    # end-to-end against a real Chromium (see TESTING.md)
npm run lint:exports   # report exports nothing else imports
```

Unit tests mock `chrome.*` and use `fake-indexeddb`; no browser is launched. The Playwright suite loads the built extension into a persistent context and needs `npm run build` first. `TESTING.md` covers the suites, manual flows and debugging; `BROWSER_TEST_CASES.md` is the click-through checklist for a release.

---

## project layout

```
manifest.json            MV3 manifest (permissions, CSP, web-accessible fonts/logos)
esbuild.config.js        two IIFE bundles: background (service worker), content
build/                   stripCssComments.js (the stylesheets' comments out of the bundle) + its jest transform
scripts/                 unused-exports.js (npm run lint:exports)
src/
  background.ts          service worker: injection, capture relay + crop, storage owner, export, import staging and commit
  content.ts             content script entry: the guard and teardown, message listener, list refresh, enlarged-view wiring
  addModeControl.ts      the "add note" state machine (off / on / kept on, Esc, Option/Alt+N, the tip's counting)
  addNoteTip.ts          when the Option/Alt+N tip shows (pure; the counts live in the service worker)
  siteActions.ts         export, import, delete-all, the list's delete, the site's counts
  navigation.ts          SPA navigation detection
  sidebar.ts             the docked panel: building and wiring it, the add group, availability, note list host
  pageResize.ts          the page shrink behind the panel
  sidebarWidth.ts        the panel's width, persisted
  sidebarMetrics.ts      the panel's layout and motion numbers
  actionMenu.ts          the "more options" menu and its confirmation
  notifications.ts       the panel's banner
  addMode.ts             selection box, resize zones, scrim, comment box, the pencil
  addModeMetrics.ts      add mode's numbers shared with its stylesheet
  styles/                the stylesheets (sidebar, add mode, enlarged view, tooltip) as TS template literals
  capture.ts             the capture pipeline's content-script half
  contextCapture.ts      DOM context (primary target, contained elements, area text, 2KB governor)
  selectorBuilder.ts     CSS selector + XPath generation (see FINGERPRINTING.md)
  wordlist.ts            the dictionary for selectorBuilder's "human-authored id" check
  drawing.ts             stroke model, cropping, SVG and canvas renderers
  thumbnails.ts          the note list's items
  dockMotion.ts          dock-style magnification spring
  enlargedView.ts        the expanded review/edit view: the whole site on one page
  cloneLayer.ts          its shared-element clones
  fullImageLoader.ts     its lazy full-resolution images
  enlargedLayout.ts      its pure geometry: note sizes, row packing, the opening scroll
  pageHeading.ts         a page's heading in it, and its rename
  scrollLock.ts          the host page's scroll lock while it is open
  flip.ts                shared-element motion helpers
  autosave.ts            debounced per-item autosave controller
  tooltip.ts             the one tooltip every surface uses
  export.ts              zip assembly, drawing composite, chrome.downloads
  import.ts              the validation ladder
  bundle/                feedback.md format 3 writer/reader (v3.ts), version stamp, dispatch
  storage.ts             chrome.storage.local layout, session state
  imageStore.ts          IndexedDB wrapper
  messages.ts, rpc.ts    typed message contract and the content script's send()
  keyRouter.ts           the one owner of salamander's window key listeners, by priority
  keyboardIsolation.ts   key isolation of a closed shadow host from the host page
  shortcut.ts            the Option/Alt+N shortcut
  theme.ts               design tokens (dark only), bundled font loading
  icons.ts               the stroke icon set
  dom.ts                 viewport size, reduced motion, safe rAF, closed-root event targets
  dataUrl.ts             data-URL ↔ bytes/Blob without fetch
  urlNorm.ts             URL/domain normalisation, the export filename
  copy.ts                every user-facing string
  types.ts               the data model
  __tests__/             jest suites, helpers, fixtures (feedback-v3.md is frozen) and the emitted-CSS golden files
tests/                   Playwright specs, helper and fixture page
design/                  SALAMANDER_SPEC.md, MOTION_SPEC.md, the design canvas exports
docs/                    technical review, refactor notes, development plan, v1 archive (historical)
fonts/, icons/           bundled assets (OFL fonts)
```

`TECH_DESIGN.md` describes the architecture; `REQUIREMENTS.md` the behaviour with stable IDs.

---

## out of scope

Editing a drawing after saving; re-cropping a saved screenshot; markers on the live page; capturing beyond the viewport; merging on import; reading older bundle formats; cloud sync; a light theme; non-Chrome browsers.

## license

MIT — see `LICENSE`.
