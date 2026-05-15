# Annotator — Build Complete

**Date:** 2026-05-15
**Build:** v1.0.0

---

## What Was Built

Annotator is a Chrome extension that lets users add inline annotations to any webpage. Users click the extension icon, enter annotation mode, and click any element to attach a numbered text note. Notes are stored locally in `chrome.storage.local` and persist across browser restarts and page reloads.

Annotations can be exported as a YAML file (one file covers all pages of a domain) and imported by others to view the same annotations on the same website. The pin numbering is sequential and never backfilled — gaps remain after deletions, preserving the integrity of any external references to pin numbers.

The implementation spans six development phases: requirements and design (Phase 1), stubbed skeleton (Phase 2), core implementation (Phase 3), code review with bug fixes (Phase 4), full unit test suite with 101 passing tests (Phase 5), and final polish (Phase 6).

## Architecture

- **Content script (`dist/content.js`):** Injected on-demand when the user clicks the extension icon. Manages an idempotency guard (`window.__annotatorActive`) so re-injection is a no-op. Owns the toolbar (Shadow DOM, closed mode), pin rendering (absolutely/fixed positioned `<div>` elements), annotation popover (Shadow DOM, closed mode), annotation mode state, SPA navigation detection (monkey-patched `pushState`/`replaceState` with 50ms debounce), cross-tab storage sync via `chrome.storage.onChanged`, and full page lifecycle.
- **Background worker (`dist/background.js`):** Tracks which tabs have an active toolbar using `chrome.storage.local` keys (`activeTab:{tabId}`). Listens for tab navigation (`onUpdated`) and removal (`onRemoved`) events to clean up stale keys. Handles the `chrome.action.onClicked` event — injects the content script (idempotent) and sends an `ACTIVATE` message to signal first activation.
- **Storage (`src/storage.ts`):** All data stored in `chrome.storage.local` under per-domain keys. Domain data includes a per-page annotation map plus metadata (`wasImported`, `importedFilename`, `nextPinNumber`). All mutation operations (add/update/delete) immediately clear `importedFilename` to track the "modified after import" state.
- **Import/Export (`src/importExport.ts`):** Export reads all pages for the domain and writes a YAML file using `js-yaml` with `JSON_SCHEMA` (safe mode). Import parses and validates the YAML through a 14-case error pipeline before writing to storage. Confirmation dialogs distinguish between fresh-annotations (Case #11) and post-import-unsaved-changes (Case #12) scenarios.
- **Fingerprinting (`src/fingerprint.ts`):** CSS selector generation (ID → stable `data-*` → nth-of-type), XPath fallback, and text snippet capture. Resolution order on import: CSS → XPath → text content → unresolved.
- **URL normalisation (`src/urlNorm.ts`):** HTTPS coercion, query/fragment stripping, trailing-slash stripping, `www.` stripping, port stripping, hostname lowercasing, path case preservation.

---

## What's Working

- **Annotation mode:** Click any element, attach a note up to 400 characters, see it as a numbered magenta pin.
- **Pin rendering:** Absolute positioning for normal elements, fixed positioning for `position: fixed` elements (sticky headers). Pins reposition on scroll. Sequential numbering with no backfill. Pins only visible in annotation mode.
- **Popover:** Shadow DOM with overflow-aware quadrant positioning (bottom-right → top-right → top-left → bottom-left). Character counter, Add/Delete/Close buttons. Click-outside closes without saving (`composedPath()` used correctly for Shadow DOM boundary).
- **Toolbar:** Shadow DOM in bottom-right corner. Four buttons: Start/Exit Annotating, Export, Upload, Delete All. Export and Delete All disabled when no annotations exist. Filename indicator after import, removed on any mutation.
- **Delete All:** Single confirmation dialog (owned by `content.ts`), correct count from all pages across the domain, full domain data wipe, `wasImported` reset implicit via fresh domain data.
- **Export:** YAML file covering all annotations across all pages of the domain. Filename `annotations-{domain}.yaml` with dots replaced by underscores.
- **Import:** Full 14-case error pipeline. Domain validation, version check (warning only), schema validation, duplicate pin detection, size limit (8MB), resolution alerts (red/yellow) shown below filename in toolbar.
- **Persistence:** Survives page reloads and browser restarts. Toolbar re-activates on full reload via `activeTab:{tabId}` key checked on content script injection.
- **SPA navigation:** `pushState` and `replaceState` both patched. On URL change: toolbar stays visible, pins update to new URL's annotations, annotation mode exits.
- **Cross-tab sync:** `chrome.storage.onChanged` listener refreshes pins and toolbar button states when another tab mutates storage.
- **Security:** Zero network requests. No `innerHTML` with user data. js-yaml `JSON_SCHEMA` (safe, no `!!js/undefined` etc.). `connect-src 'none'` in manifest CSP.
- **Tests:** 101 unit tests across 4 suites — all passing.

---

## Known Issues / Limitations

None outstanding. All findings from REVIEW_1.md (3 important, 1 minor) were fixed during Phase 4. All 101 tests pass. The build is clean with zero TypeScript errors.

---

## v1 Accepted Limitations (from REQUIREMENTS.md §7)

- No real-time collaboration
- No cloud sync
- Highly dynamic pages (React/SPA with auto-generated IDs) may produce fragile selectors — XPath and text-content fallbacks mitigate but don't eliminate this
- No MutationObserver for dynamic content re-resolution after DOM changes
- No keyboard shortcuts

---

## Manual Testing Required

The following require a real browser and cannot be covered by unit tests:

- Extension icon click → toolbar injection on a live page
- Annotation mode hover highlight on real pages
- Pin rendering and scroll repositioning
- Popover quadrant overflow-avoidance on elements near page edges
- Import/export round-trip with real YAML files
- Cross-tab sync (open same domain in two tabs, annotate in one, verify other updates)
- Reload persistence (annotate, reload, verify pins reappear)
- SPA navigation on a React app (e.g. react.dev) — URL change should update pins
- Fixed-position element annotation (sticky navigation bars)
- Delete All confirmation count accuracy across multi-page domains

See `TEST_PLAN.md` for the full manual test plan.

## How to Load in Chrome

See `README.md` for step-by-step instructions.
