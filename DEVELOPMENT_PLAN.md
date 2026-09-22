# Development Plan — status

This was the phase-by-phase build plan for the pivot from pin-based annotation (v1, archived in `docs/v1-archive/`) to screenshot-based feedback. The build is complete and shipping as 2.0.0; this file is kept as a record of what was planned against what was built. Behaviour is specified in `REQUIREMENTS.md`, the architecture in `TECH_DESIGN.md`.

## Phases

| Phase | Planned | Status |
|---|---|---|
| 0 | Remove the pin system, define v2 types, add `fflate` + `fake-indexeddb` | done |
| 1 | Storage: `chrome.storage.local` metadata, IndexedDB blobs, `chrome.storage.session` sidebar state | done — later split into a per-domain index + per-item keys (schema 2) |
| 2 | Service worker: injection, capture relay with throttle, IndexedDB ownership, typed messages | done — messages became a compile-checked `MessageMap` + handler table |
| 3 | Right-docked sidebar that shrinks the page; SPA/reload persistence | done — plus a resizable width (188–300) and the youtube limitation documented |
| 4 | Add mode: click-to-place box, resize handles, scrim, comment box | done — the 200×150 box became 267×100 (thumbnail-sized), the 8 visible handles became invisible edge/corner zones, "ok" became "save", drag-to-draw and a cursor preview were added |
| 5 | Capture pipeline with DPR-correct cropping | done — the scale is measured from the image, with two viewport widths sent to resolve the scrollbar ambiguity |
| 6 | Context capture (selector reuse + rect-scoped DOM/text extraction, 2KB governor) | done |
| 7 | Thumbnails and an enlarged **modal** | done, then replaced — the modal became the enlarged view (the sidebar itself expands; design spec §D, v4 §M, v5 §R) with autosave, dock magnification and a hover delete |
| 8 | Export: zip + `feedback.md` with fenced **yaml** context | done, then replaced — format 2 (§AC): one json record per note inside `<details>`, `js-yaml` removed, `src/bundle.ts` became `src/bundle/` |
| 9 | Import with the full error ladder; "newer schema: warn and proceed" | done — except that any other format is now **refused** (no backward compatibility; the extension was never published with another format) |
| 10 | Playwright suite + docs | done (five specs; docs rewritten for 2.0.0) |

Added after the plan: the drawing tool (§AB), dark-only theming (§AA — the theme switcher was built and then removed), keyboard isolation from host pages, the enlarged view's scroll lock, the "keep add mode on" switch, the technical review and two refactor passes (`docs/`).

## Obsolete

- The subagent dispatch instructions, model tiers and commit messages: process notes for the original build, not needed again.
- `src/modal.ts`, `src/bundle.ts`, `js-yaml`, fenced yaml blocks, `page_meta` in the bundle, the "warn and proceed" version rule, the theme toggle: all replaced as noted above.
- The Phase 10 doc targets (`TECH_DESIGN.md` at ~300 lines etc.) — superseded by the current files.

## Still true

The cross-cutting gotchas the plan opened with are unchanged and are the things that silently break; they are now written where they apply (`src/messages.ts`, `src/imageStore.ts`, `src/dataUrl.ts`, `src/background.ts`):

1. IndexedDB in a content script belongs to the page's origin — all blob access lives in the service worker.
2. `chrome.runtime` messages are JSON — images cross as data-URL strings.
3. `captureVisibleTab` is service-worker-only and needs the active tab.
4. Service workers have no DOM and no `URL.createObjectURL` — crop with `createImageBitmap` + `OffscreenCanvas`, download via `chrome.downloads` with a `data:` URL.
5. CSP `script-src 'self'`, `connect-src 'none'` — bundle every dependency; never `fetch()` a data URL.
6. The content script is injected on demand and must stay idempotent.
7. All user-visible text is lowercase.

## Open items carried forward

From `docs/REFACTOR_NOTES_2026-09-22.md` §1.3 and the technical review: remove the `UPDATE_NOTE` alias in the release after 2.0.0; a shared menu controller for the chevron and pencil menus; the `sidebar.ts` / `enlargedView.ts` file splits and CSS-out-of-TypeScript, to be done with the Playwright suite as the checkpoint; surfacing `updateItem`'s `found` result; a spread of the optional `drawing` field in `handleImportReplace` if a future codec ever decodes one.
