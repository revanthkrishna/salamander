# annotator

> Chrome extension for capturing visual feedback on webpages. Select an area, screenshot it, attach a note, and export a bundle for developers or AI coding agents to act on.

---

## what it does

- **select & screenshot** — click a region on any webpage to capture it as a PNG
- **annotate** — attach a text note explaining what needs to be done
- **export** — download a `.zip` bundle with all screenshots and a `feedback.md` file
- **import** — share bundles between team members; recipient imports and sees the same screenshots + notes
- **context** — each capture includes DOM context (element selectors, contained elements, visible text, page metadata) so developers or AI agents can locate the code without needing the live page

---

## how to use

1. Click the extension icon in your Chrome toolbar
2. The sidebar opens on the right side of the page
3. Click **add note** to enter add mode
4. Click & drag to select an area on the page; a default box appears if you just click
5. Drag from any edge or corner of the box to resize the selection (invisible hit zones, no
   visible handles)
6. Type a note in the comment box (up to 1000 characters)
7. Click **save** to capture, or **cancel** to discard
8. New screenshot appears as a thumbnail in the sidebar
9. Repeat for other areas (sidebar stays open across page navigation)
10. Click **export** to download a `.zip` file with all captures and a markdown file
11. Share the `.zip` with teammates; they can **import** it to load your feedback

---

## key features

- **no network requests** — all data stays on your device; nothing leaves without explicit export
- **sidebar resizes the page** — never blocks or overlaps content
- **sidebar persists** — stays open across page reloads and SPA navigation until you close it
- **sequential numbering** — feedback items are numbered globally per domain, so "item #7" is unambiguous across pages
- **bundle format** — human-readable `feedback.md` with inline screenshot references, plus embedded YAML context for AI agents
- **import validation** — 13-case error handling; catches corrupted files, domain mismatches, missing data before writing anything

---

## installation

1. Clone this repo or download it
2. `npm install`
3. `npm run build`
4. Go to `chrome://extensions`, enable **Developer mode**
5. Click **Load unpacked** and pick the project directory (the one with `manifest.json`)
6. The extension icon appears in your Chrome toolbar

---

## development

### unit tests

```bash
npm test                  # full Jest run
npx jest sidebar         # just the sidebar tests
```

Tests run in jsdom (no browser launch). `chrome.storage` and IndexedDB are mocked. Coverage includes capture geometry, context extraction, storage CRUD, bundle round-trip validation, and message handlers.

### building

```bash
npm run build            # esbuild → dist/
```

The extension reads from `dist/` directly. After rebuilding, reload the extension in `chrome://extensions` and refresh the test tab.

### manual testing

- Open the extension on any real website
- Test the full journey: add note → capture → thumbnail → enlarged view → edit note → delete
- Test SPA navigation (e.g. Reddit, Twitter) — sidebar should persist and refresh for the new URL
- Test export on a domain with >1 URL and >1 item per URL
- Test import by re-importing an export (should replace cleanly)

See [TESTING.md](./TESTING.md) for detailed test cases and debugging instructions.

---

## architecture

The extension is built across 21 TypeScript modules (~10,600 lines):

**Background service worker** (`src/background.ts`) — owns all storage, relays captures, handles extension icon clicks and tab lifecycle.

**Content script** (`src/content.ts`) — injected on demand, listens for messages, detects SPA navigation, wires up the sidebar UI.

**Sidebar & add mode** (`src/sidebar.ts`, `src/addMode.ts`) — right-docked, resizable panel that resizes the page, selection box (edge/corner resize) with a merged comment input, all in a closed shadow root.

**Design language** (`src/theme.ts`, `src/dockMotion.ts`) — light/dark/auto theme tokens (persisted, live-synced across tabs and surfaces) plus bundled fonts loaded via `FontFace`; macOS-Dock-style pointer/keyboard-focus magnification for the sidebar's note list.

**Capture pipeline** (`src/capture.ts`) — hide UI → double-rAF → message background → crop → restore UI → persist item.

**Storage** (`src/storage.ts`, `src/imageStore.ts`) — `chrome.storage.local` for metadata (domain-keyed, includes inline thumbnails), IndexedDB for PNG blobs, `chrome.storage.session` for per-tab sidebar state.

**Context capture** (`src/contextCapture.ts`) — DOM walk at capture time: deepest-common-ancestor element, ≤15 descendant elements, flat area text, page metadata — all capped at 2KB.

**Import/Export** (`src/import.ts`, `src/export.ts`, `src/bundle/`) — `.zip` bundles with `screenshots/{id}.png` and single `feedback.md` containing markdown prose + embedded YAML context blocks.

**Thumbnails & enlarged view** (`src/thumbnails.ts`, `src/dockMotion.ts`, `src/enlargedView.ts`, `src/flip.ts`) — the note list with dock-style hover, and the enlarged view where the sidebar expands to review, navigate, edit (autosave) and delete notes.

Full technical details in [TECH_DESIGN.md](./TECH_DESIGN.md).

---

## privacy & security

- **Zero network requests.** Content Security Policy enforces `connect-src 'none'`. All code is bundled by esbuild (script-src 'self').
- **On-device only.** Screenshots and metadata are stored in `chrome.storage.local` and IndexedDB, both local to the device. Nothing leaves your machine unless you explicitly export a file.
- **No form field masking (v1).** Screenshots capture exactly what's on screen, including form inputs. This is a known limitation; masking is deferred to a future release.

---

## permissions

| Permission | Why |
|---|---|
| `storage` | Saving feedback items and sidebar state across sessions |
| `unlimitedStorage` | Screenshots exceed the 10MB default quota quickly |
| `scripting` | Injecting the content script on demand |
| `tabs` | Tab lifecycle (reload re-injection, cleanup on close) |
| `downloads` | Exporting feedback bundles |
| `<all_urls>` | Works on any website (except restricted URLs like `chrome://` or PDFs) |

---

## error handling

All errors are lowercase and user-facing:

- **import errors** — 13 cases caught: wrong file type, corrupted archive, missing `feedback.md`, malformed metadata, missing screenshots, duplicate IDs, domain mismatch, newer schema version (warning), existing-data confirmation
- **capture errors** — rate limit or restricted page (shows "couldn't capture a screenshot here. try again.")
- **restricted pages** — `chrome://`, Web Store, PDF viewer, etc. → extension icon indicates unavailability

---

## edge cases

- **High-DPI displays** — captures naturally reflect device pixel ratio; no downscaling applied
- **Browser zoom ≠ 100%** — selection coordinates and crop are computed against rendered pixels, so zoom is automatically accounted for
- **Cross-origin iframes** — screenshot pixels include the iframe content (visible-tab capture doesn't care about origin), but DOM context is limited to the iframe element's attributes due to same-origin restriction
- **Selection too large** — context capture has a 2KB per-item budget; truncates outerHTML first, then contained-elements list, always with visible markers
- **SPA navigation** — sidebar refreshes its thumbnail list for the new URL while staying open

---

## out of scope (v1)

- Drawing/annotating on top of screenshots (planned for next release)
- Repositioning or cropping existing captures (delete + recapture instead)
- Persistent visual markers on the live page (see REQUIREMENTS §1.5 for rationale)
- Auto-scroll + stitch capture for selections exceeding the viewport
- Merging feedback on import (replace-only in v1; merge deferred to v2)
- Cloud sync / backend / real-time collaboration
- Non-Chrome browsers

---

## license

MIT

---

## testing checklist

Before shipping:

- [ ] `npm test` passes (395+ tests)
- [ ] `npm run build` succeeds
- [ ] Sidebar opens/closes/persists on real sites (e.g. reddit.com, github.com)
- [ ] Add mode: select, resize, comment, capture, undo (cancel)
- [ ] Thumbnails display correctly; click expands the sidebar into the enlarged view
- [ ] Enlarged view: prev/next, edit note (autosaves; empty note blocked), delete (removes item + blob)
- [ ] Export: generates `.zip`, unopened on empty domain
- [ ] Import: validates all error cases, replaces cleanly, sidebar opens for current URL
- [ ] SPA navigation: sidebar stays open, thumbnail list refreshes for new URL
- [ ] High-DPI display: captured pixels match selection at native DPR
- [ ] Browser zoom 80%/150%: selection geometry and capture remain correct
- [ ] E2E tests pass (playwright suite, separate agent)
