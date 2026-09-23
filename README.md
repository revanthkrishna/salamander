# salamander

> Chrome extension for visual feedback on any webpage. Select an area, draw on it if you like, write a note; salamander screenshots the area, records where it sits in the DOM, and exports everything as a bundle a developer or an AI coding agent can act on without the live page.

Version 2.0.0 · Manifest V3 · MIT

---

## what it does

- **select and screenshot** — a sidebar opens beside the page (the page shrinks, nothing is covered). Click or drag to select an area; resize it from any edge or corner. The screenshot is cropped to the selection at native device pixels.
- **draw** — a pencil (yellow, black or red, 2px) for marking up the selection before saving. Undo with Cmd/Ctrl+Z. The drawing is kept as its own layer on the note and burned into the PNG only at export.
- **note** — a comment box with a 1000-character limit. Notes autosave when edited later; a note can never be empty.
- **context** — every note carries a CSS selector, an XPath, a sanitised HTML snippet, the elements inside the selection, the visible text, and page metadata, so the code can be found without the page.
- **review** — notes for the current URL appear as thumbnails with dock-style magnification; click one and the sidebar expands into an enlarged view to browse, edit and delete.
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

1. Click the icon → the sidebar opens on the right and the page narrows to make room. Drag the sidebar's left edge to resize it (188–300px); the width is remembered.
2. Click **add note** (the comment-bubble button). The cursor becomes a crosshair and a preview box follows it.
3. Click to place a 267×100 box centred on the pointer, or press and drag to draw your own. Resize from the invisible edge/corner zones (minimum 20×20).
4. Inside the box the cursor is a pencil: draw if you want, switch colour with the swatches, **erase all** from the pencil menu, Cmd/Ctrl+Z to undo a stroke.
5. Type a note (placeholder "what should change here?") and click **save**. The overlay hides for one frame, the screenshot and DOM context are captured, and the note appears at the bottom of the list. **cancel** discards it; clicking outside the box does nothing.
6. To capture several in a row, hover the add button and flick **keep add mode on** — after each save you are straight back in add mode. Click the button or press Esc to stop. Double-click or shift+click the button does the same as the switch.
7. Click a thumbnail to open the enlarged view: ↑/↓ or the peeking neighbours to move between notes, edit the text (it autosaves), the trash icon to delete, Esc or the rail's exit button to collapse. Hover a thumbnail for a delete button that skips the enlarged view.
8. Browse the site normally — the sidebar stays open across SPA navigation and full reloads, showing the notes for whatever URL you are on. Notes are numbered by their position on the page — every page counts from 1, and deleting a note renumbers the ones after it.
9. **export** downloads `feedback-{domain}-{date}.zip` with every note on the site. The chevron beside it holds **import**, which replaces the site's notes with a bundle's (after confirmation if any exist).

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

`feedback.md` (format 2 — the full rules are in `design/SALAMANDER_SPEC.md` §AC, the frozen example in `src/__tests__/fixtures/feedback-v2.md`):

````markdown
<!-- salamander-feedback-format: 2 -->
salamander 2.0.0\
**date exported:** 2026-09-22 14:05 utc+01:00\
**website:** example.com

## page "https://example.com/pricing"

### feedback 1

![feedback 1 — marked up by the reviewer](screenshots/1.png)

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

- Line 1 is the format stamp import checks; only format 2 is read (no backward compatibility — the extension was never published with another format).
- One `## page` section per normalised URL, notes in capture order. `### feedback n` is the note's position on its page (from 1 on every page, the same number the sidebar shows); `screenshots/{id}.png` is the note's internal id, unique across the site. Each note's JSON is the complete record; the visible `**note:**` line is for people and ignored on import.
- Free text in the JSON is capped (`text` 120, `html` 300, `area_text` 200, element text/attributes 80) and ends in `…` when cut. Notes and identifiers are never cut.
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
npm test               # jest, jsdom — 802 tests in 26 suites
npx jest sidebar       # one suite
npx tsc --noEmit       # type check (strict, noUnusedLocals)
npx playwright test    # end-to-end against a real Chromium (see TESTING.md)
```

Unit tests mock `chrome.*` and use `fake-indexeddb`; no browser is launched. The Playwright suite loads the built extension into a persistent context and needs `npm run build` first. `TESTING.md` covers the suites, manual flows and debugging; `BROWSER_TEST_CASES.md` is the click-through checklist for a release.

---

## project layout

```
manifest.json            MV3 manifest (permissions, CSP, web-accessible fonts/logos)
esbuild.config.js        two IIFE bundles: background (service worker), content
src/
  background.ts          service worker: injection, capture relay + crop, storage owner, export, import write
  content.ts             content script entry: sidebar wiring, add-mode state machine, SPA detection
  sidebar.ts             the docked panel, page shrink, action row, note list host, banners
  addMode.ts             selection box, resize zones, scrim, comment box, the pencil
  capture.ts             the capture pipeline's content-script half
  contextCapture.ts      DOM context (primary target, contained elements, area text, 2KB governor)
  selectorBuilder.ts     CSS selector + XPath generation (see FINGERPRINTING.md)
  drawing.ts             stroke model, cropping, SVG and canvas renderers
  thumbnails.ts          the note list's items
  dockMotion.ts          dock-style magnification spring
  enlargedView.ts        the expanded review/edit view
  flip.ts                shared-element motion helpers
  autosave.ts            debounced per-item autosave controller
  export.ts              zip assembly, drawing composite, chrome.downloads
  import.ts              the validation ladder
  bundle/                feedback.md format 2 writer/reader (v2.ts), version stamp, dispatch
  storage.ts             chrome.storage.local layout, session state
  imageStore.ts          IndexedDB wrapper
  messages.ts, rpc.ts    typed message contract and the content script's send()
  theme.ts               design tokens (dark only), bundled font loading
  keyboardIsolation.ts   capture-phase key isolation from the host page
  copy.ts                every user-facing string
  types.ts               the data model
  __tests__/             jest suites + fixtures (feedback-v2.md is frozen)
tests/                   Playwright specs, helper and fixture page
design/                  SALAMANDER_SPEC.md, MOTION_SPEC.md, the design canvas exports
docs/                    technical review, refactor notes, v1 archive (historical)
fonts/, icons/           bundled assets (OFL fonts)
```

`TECH_DESIGN.md` describes the architecture; `REQUIREMENTS.md` the behaviour with stable IDs.

---

## out of scope

Editing a drawing after saving; re-cropping a saved screenshot; markers on the live page; capturing beyond the viewport; merging on import; reading older bundle formats; cloud sync; a light theme; non-Chrome browsers.

## license

MIT — see `LICENSE`.
