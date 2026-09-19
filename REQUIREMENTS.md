# Annotator — Requirements

> Chrome extension for capturing visual feedback on any webpage. User selects an area of the page, the extension screenshots it and attaches a note. Feedback is exported as a bundle (screenshots + human/agent-readable notes) that can be handed to a developer or an AI coding agent to locate and act on.

---

## Definitions

- **Sidebar** — the extension's UI panel, docked to the right edge of the viewport. It resizes the page's viewport (shrinks the page rather than floating over it), so it never blocks/overlaps page content. Opened by clicking the extension icon.
- **Add mode** — the transient state entered by clicking the sidebar's **add** button, during which the pointer becomes a selection tool and clicking-and-placing an area on the page is possible. All other page interaction (native clicks, links) is suppressed while in add mode. Add mode auto-exits back to normal browsing as soon as a feedback item is saved or cancelled.
- **Feedback item** — one captured unit of feedback: a screenshot of a selected page area + a text note + captured DOM/page context. Feedback items do **not** persist any visual marker on the live page (see §1.5) — they exist only as sidebar thumbnails and export data.
- **Bundle** — the exported/imported unit: a `.zip` containing screenshot images and a single human/agent-readable `feedback.md`, which is also what the extension re-parses on import (see §1.7) — no separate machine-only file.

---

## Status: 🟢 Requirements Finalized

All technical open items have been resolved (see inline "*(decided by: ... subagent)*" notes for rationale on each) and non-technical decisions were confirmed directly with the user. Ready to move into development planning.

---

## 1. Functional Requirements

### 1.1 Sidebar & Activation
- [ ] Clicking the extension icon injects/opens the sidebar on the current tab (consistent with v1's on-demand activation model — no automatic injection)
- [ ] Sidebar is docked to the right edge of the viewport and **resizes the page** (shrinks the page's available viewport width), so it never blocks or overlaps page content
- [ ] Sidebar width is **user-resizable** by dragging a handle on its left (page-facing) edge, clamped to **100–300px**, defaulting to 300px. The chosen width persists across sessions in `chrome.storage.local` (a durable UI preference, unlike the per-tab open/closed flag below which is deliberately `chrome.storage.session`). The page shrink, the add-mode selection bounds and the enlarged modal's backdrop all track the live width. The handle is also keyboard-operable (arrow keys / Home / End) for accessibility.
- [ ] Sidebar header shows a theme toggle and **close** (Salamander redesign: **add**/**export**/**import** moved to a separate action row below the header — see §3.1)
- [ ] **Close** hides the sidebar (content script stays loaded; feedback data is untouched). Re-opening via the extension icon restores the sidebar showing the same state.
- [ ] Sidebar body shows the list of thumbnails for feedback captured on the **current URL only** (see §1.5)
- [ ] Sidebar persists across both SPA navigation **and full page reloads** — the thumbnail list refreshes for whatever URL is current, but the sidebar itself only disappears when the user explicitly clicks **close**. This is a deliberate departure from v1 (where a full reload required re-clicking the extension icon).
- [ ] Technical implication: a full reload re-injects the content script from scratch, so "sidebar is open" is not naturally remembered — it must be persisted per-tab and re-applied automatically when the content script initializes on the new page load, with no user action required
  - **Decision:** Use `chrome.storage.session` keyed by tab ID. **Rationale:** `chrome.storage.session` is designed exactly for ephemeral state that survives page reloads but clears on browser restart, providing the right UX balance: refreshing the page preserves sidebar open/closed state, but closing and reopening the browser clears it. *(decided by: backend-developer subagent)*

### 1.2 Capturing Feedback (Add Mode) 
- [ ] User clicks **add note** → pointer changes to a screenshot/crosshair icon → page enters add mode. **add note** is a toggle: it shows as on while add mode is active, and clicking it again cancels add mode.
- [ ] **Decision (Salamander v2):** double-clicking **add note** (or shift+click / shift+enter) **locks** add mode on — a small padlock appears on the button, and after each successful capture the page goes straight back into add mode so the user can keep adding notes without re-clicking. While locked, **cancel** discards only the current note and stays in add mode; a single click on the button, or Esc, exits both the lock and add mode. **Rationale:** batch review sessions often capture several notes in a row; re-clicking the button between each one was friction.
- [ ] User clicks once on the page → a default-sized selection box appears **centered** on the click point (default size: fixed, matching the sidebar's note thumbnail box *at the sidebar's default width* — default sidebar width minus the list's horizontal padding, by a fixed 100px height; 267×100px, i.e. top-left = `(x - 133.5, y - 50)`. It does not change if the user resizes the sidebar). If centering would push the box outside the viewport, it is clamped by shifting (not shrinking) it fully on-screen, independently per axis — e.g. clicking at (20, 20) would naively center the box at (-113.5, -30), which clamps to (0, 0), producing a final box of (0,0)–(267,100); the same clamp applies symmetrically near the right/bottom edges.
- [ ] User can also **click-and-drag** (Figma-style) to draw a custom-sized box directly instead of getting the default size: a 5px movement threshold (measured from mousedown) distinguishes a "click" (below threshold → center-on-click default-size behavior above) from a "drag" (at/above threshold → the box is the actual rectangle between the mousedown point and the current/mouseup point, normalized to work when dragging in any direction). The box updates live as the user drags, respecting the 20×20 minimum size and viewport clamping throughout (same clamping logic as the resize handles below).
- [ ] User can resize the box from its corners/edges (Salamander redesign: invisible hit zones rather than visible drag handles — see §3.2). **Decision:** Minimum box size 20×20px. **Rationale:** Small enough to avoid forcing larger selections than necessary, but large enough to prevent useless captures from accidental clicks; prevents "slivers" without imposing artificial minimum interaction costs. *(decided by: frontend-developer subagent)*
- [ ] The box **cannot** be dragged/resized past the visible viewport edges (§ decision: clamp to viewport, no auto-scroll/stitch — see §6 for rationale)
- [ ] Alongside the box, a comment box appears (positioned below the selection by default; flips above, or to whichever side has room, if insufficient space — same overflow logic as v1's popover)
- [ ] Comment box contains: a textarea (placeholder `"what should change here?"`, lowercase), a character counter (see below), and two buttons: **cancel** and **save**
- [ ] **Decision:** Text input max length 1000 characters; counter appears at 900+, turns red at 980+. **Rationale:** 1000-char limit allows richer descriptions than v1's 400; 90%/98% thresholds (900/980) provide appropriate warning and danger signals proportional to the expanded limit, giving users clear feedback before hitting the hard limit. *(decided by: frontend-developer subagent)*
- [ ] **save** is disabled while the textarea is empty
- [ ] Only clicking **cancel** discards the in-progress box and exits add mode with no feedback item created. Clicking outside the box/comment area does **nothing** — no wiggle, no dismiss, no effect at all — regardless of whether the textarea is empty or not. The user must explicitly click **save** or **cancel** to leave the in-progress state.
- [ ] Clicking **save**:
  1. The selection box outline, resize hit zones, dimming overlay, and comment box are hidden for the single frame of capture (these are drawn within the page area and would otherwise appear in the screenshot). The sidebar's note list also has its dock magnification suspended for the whole of add mode, since a magnified item grows out over the page and could otherwise bleed into a capture. The sidebar itself does **not** need to be hidden — since it resizes the page rather than overlaying it, the page's visible viewport never extends under the sidebar, so the sidebar can never fall inside a selection's crop bounds.
  2. Extension captures a screenshot cropped to the selection box's pixel bounds
  3. Extension captures DOM/page context for the selected area (see §1.4)
  4. Add mode exits; sidebar restores; a new thumbnail appears at the bottom of the sidebar list showing the screenshot + note text beneath it
- [ ] Each feedback item gets a globally unique, sequential ID (continues incrementing across all URLs of the domain — mirrors v1's continuous pin numbering — so a reference like "item #7" is unambiguous even across pages)

### 1.3 Screenshot Capture — Technical Constraints
- [ ] Screenshot capture uses the browser's visible-tab capture API, which captures only the currently rendered viewport — this is why selections are clamped to the viewport (§1.2)
- [ ] Captured images are stored as PNG (lossless — preserves text sharpness for UI screenshots, at the cost of larger file size vs JPEG)
- [ ] **Decision:** Capture images are kept at native device pixel ratio (no downscaling to CSS pixels). **Rationale:** Developers receiving the bundle need to see exact pixel fidelity for their target platform; high-DPI captures are more useful for developers working on Retina/high-DPI screens; file size is secondary to output usefulness for this use case. *(decided by: frontend-developer subagent)*
- [ ] If capture fails (e.g. rate-limited, or the page is a restricted URL like `chrome://` where content scripts can't run), show an error and do not create a partial feedback item (see §5)

### 1.4 Context Capture (for a human or AI agent to locate the code)

Since feedback items are **not** re-rendered as live pins on the page (§1.5), the DOM/page context captured here has one job: let someone reading the exported `feedback.md` — a person or a coding agent — figure out **where in the source** the selected UI lives, without needing to load the live page. This replaces v1's "fingerprint for re-resolution" purpose with a "fingerprint for explanation" purpose, which lets us be more generous/verbose than v1's resolver-oriented selectors.

For each feedback item, at the moment of capture:

**A. Primary target** — the smallest DOM element that fully contains the selection rectangle (deepest common ancestor of everything visually inside the box):
- CSS selector path (reusing/extending v1's selector-building logic: prefer `id` / `data-*` attributes, fall back to tag + class + positional index; already hardened against framework-generated hash classes per the existing `pageDetectors` work)
- XPath (fallback identifier)
- Truncated `outerHTML` snippet. **Decision:** 1KB cap (with `<script>`/`<style>` contents and base64 data-URIs stripped, and a `"...[truncated]"` marker if cut). **Rationale:** 1KB provides sufficient context for humans and AI agents to locate and understand the element structure without bloating the export; truncation is applied first when total size governance (§1.4E) is exceeded. *(decided by: api-designer subagent)*

**B. Contained elements** — a lightweight list (not full HTML) of descendant elements whose bounding box intersects the selection rectangle. **Decision:** Cap at 15 elements, prioritized toward elements with distinguishing attributes or visible text over bare layout `div`s. **Rationale:** 15 elements provides meaningful detail without overwhelming context; combined with the 2KB total cap (§1.4E), this prevents both structural overgrowth and size bloat. Elements are trimmed in order of relevance (attribute-rich or text-bearing first) if the total budget is exceeded. *(decided by: api-designer subagent)*
- tag, `id`, classes (flagged semantic vs. likely-auto-generated), key attributes (`data-*`, `aria-*`, `role`, `href`, `alt`, `name`, `type`, `placeholder`)
- direct visible text only (not full subtree text, to avoid duplication) — trimmed, capped at ~100 chars each

**C. Area text** — all visible text whose position falls within the selection rectangle, aggregated into one flat block. This is a fast semantic summary distinct from the structural dump in A/B, useful when an agent just needs "what did this say" rather than "where is this in the DOM."

**D. Page-level metadata** (attached to every item):
- Full URL and normalized URL (see edge cases for normalization rules)
- Page `<title>`
- Viewport dimensions + device pixel ratio at capture time
- Selection rectangle (x, y, width, height) in page coordinates
- Capture timestamp (ISO 8601)

**E. Size governance** — **Decision:** Cap total captured context per item at 2KB (A + B + C + D combined). **Rationale:** 2KB keeps each item's context skimmable in a markdown viewer or IDE, balancing detail against file size (outerHTML + 15 elements + area text + metadata fit within this budget; the 1KB outerHTML cap and 15-element cap in A/B are guidance, not strict independent limits—both truncate first if total budget is approached). If exceeded, truncate in this order: outerHTML snippet first, then the contained-elements list — always with a visible truncation marker, never a silent cut. *(decided by: api-designer subagent)*

Decision: no computed styles (e.g. `position`, `display`, `background-color`) in v1 — keeping context capture lean and structural/textual only. Revisit if visual-bug feedback (not just "add this here") turns out to need it.

### 1.5 Viewing & Managing Feedback

- [ ] Sidebar shows thumbnails only for feedback items belonging to the current normalized URL — feedback for other URLs is stored but hidden until the user navigates there
- [ ] Each thumbnail shows the screenshot image and the note text beneath it
- [ ] Clicking a thumbnail opens the **enlarged view**: the sidebar itself expands to ~75% of the viewport (the page is not re-laid out; the remaining strip is dimmed by a scrim), showing the note's large screenshot, "feedback #n" with its position ("n / total"), and an editable note. The previous and next notes peek in at the top and bottom (click to move to them); a rail of **x** / **↑** / **↓** buttons exits or navigates, as do Esc and the arrow keys. Clicking the scrim collapses back to the list.
- [ ] In the enlarged view: user can edit the note text, or delete the item entirely. **The screenshot/selection area itself is not editable in v1** (delete and recapture instead) — cropping/repositioning is deferred (§7)
- [ ] Delete is immediate — no confirmation dialog (consistent with v1's single-item delete). The view then moves on to the next note (or the previous one if it was the last); deleting the only note collapses back to the list.
- [ ] **Decision (Salamander v2):** note edits autosave (shortly after typing stops, and whenever the user navigates or collapses) — there is no save button; a brief "saved" hint confirms it, and a failed save shows an inline error and is retried. **A note can never be empty:** an emptied note is never saved, and leaving it (navigate, collapse, Esc, closing the sidebar) is blocked with the inline error "a note can't be empty. add some text to continue." until text is entered — every screenshot must keep a description. Deleting the whole note is still allowed.
- [ ] Deleting a feedback item also deletes its stored screenshot blob (no orphaned images in storage)
- [ ] **No persistent visual marker is placed on the live page for saved feedback items** — this is an explicit decision (not a v1-parity gap): re-locating elements after the fact proved unreliable in the pin-based version when pages changed or viewport size differed. Sidebar thumbnails are the sole record. (Future consideration, not a v1 blocker: revisit if this proves hard to use in practice, e.g. correlating a thumbnail back to its page location.)

### 1.6 Exporting
- [ ] User clicks **export** → downloads a `.zip` bundle containing **all** feedback items across **all URLs** of the current domain (not just the current page — mirrors v1's "export everything, filtered view only in the UI" model)
- [ ] If there are zero feedback items for the domain: `alert("nothing to export")`, no download
- [ ] Bundle contents — just two things, no separate machine-only file:
  - `screenshots/{id}.png` — one file per feedback item
  - `feedback.md` — the single source of truth, human/agent-readable **and** what the extension re-parses on import
- [ ] `feedback.md` structure:
  - One `##` section per URL, in order of that URL's first-captured item
  - Within a URL section, items in chronological (capture) order
  - Each item shows: item number, inline image reference (`![](screenshots/{id}.png)`) so the screenshot renders alongside the note in any standard markdown viewer, and the note text as plain prose
  - The captured context from §1.4 (selector, xpath, contained elements, area text, page metadata) is embedded per item as a fenced ` ```yaml ` block directly under the note. This keeps everything in one file while staying reliably re-importable: a human/agent reading the file sees clean structured data in a code block, and the extension's importer just extracts and parses that fence back into an object — no need to parse loose prose.
- [ ] **Decision:** Default filename is `feedback-{domain}-{date}.zip`, where domain dots are replaced with underscores and {date} is YYYY-MM-DD. **Rationale:** Mirrors v1's naming convention for familiarity; ISO date format is unambiguous and sorts chronologically; domain normalization (dots→underscores) ensures valid filenames across OSes. Example: `feedback-example_com-2026-09-18.zip`. *(decided by: api-designer subagent)*

### 1.7 Importing
- [ ] User clicks **import** → native file picker (accepts `.zip` only)
- [ ] Import behavior is unified — no distinction between "resuming your own export" and "loading someone else's bundle"; both go through the same flow
- [ ] Extension reads `feedback.md` from the zip, extracts each item's fenced `yaml` metadata block, and loads all feedback items + screenshots into storage
- [ ] If domain in the bundle doesn't match the current site: reject with an error (mirrors v1's domain-mismatch handling)
- [ ] If existing feedback already exists for this domain: confirmation dialog before replacing (mirrors v1's "uploading this file will replace..." pattern). **Decision:** Import **replaces** existing domain feedback entirely; no merge-by-ID in v1. **Rationale:** Replace-only is simpler to implement and reason about for a solo-project v1; merge logic adds complexity without a clear v1 use case. Merging is explicitly deferred to §7 / v2 as out-of-scope. Users can export before importing if they need to preserve old feedback. *(decided by: api-designer subagent)*
- [ ] After successful import, sidebar opens (if not already) showing thumbnails for the current URL, if any are included in the bundle

---

## 2. Non-Functional Requirements

### Permissions
- Extension requests host permission for all websites at install time (unchanged from v1 — needed for content script injection)
- Screenshot capture uses the browser's visible-tab capture API, which is subject to a rate limit (historically ~2 calls/second) — rapid successive captures may need to be throttled/queued client-side
- **Decision:** Request `unlimitedStorage` permission. **Rationale:** Screenshot blobs are unavoidable and will exceed the 10MB default `chrome.storage.local` quota quickly (dozens of PNGs per domain easily hits this); IndexedDB also benefits from the quota lift. Storage is local and on-device only, so the tradeoff is justified. *(decided by: backend-developer subagent)*

### Security
- No network calls, analytics, or telemetry — all data stays on-device (unchanged from v1)
- Screenshots are captured and stored entirely locally; nothing leaves the device except via explicit user-initiated export
- **Decision:** Out of scope for v1; document as a known limitation. **Rationale:** Visual masking (blur/pixelation) of password inputs adds complexity (detection, rendering, capture-time handling) not justified for v1. Users can be made aware via UX warnings when a selection contains form inputs. Revisit in v2 if real-world usage reveals this as critical. *(decided by: backend-developer subagent)*

### Storage
- **Decision:** Use IndexedDB for screenshot PNG blobs; use `chrome.storage.local` for feedback metadata and item records. **Rationale:** IndexedDB is better suited for large binary media (flexible storage model, efficient blob handling); `chrome.storage.local` is simpler and sufficient for lightweight metadata (selectors, context, URLs). Both benefit from `unlimitedStorage`, and this split allows efficient querying of metadata without touching large image payloads. *(decided by: backend-developer subagent)*
- Feedback data persists indefinitely until deleted or the extension is uninstalled (unchanged principle from v1)
- Storage is local to the device/profile — no cross-device sync in v1

### Performance
- Hiding/restoring the in-page overlay UI (selection box, handles, dimming scrim, comment box) around the capture call must be fast enough to be visually imperceptible and must never appear in the captured image
- Add-mode interactions (drawing, resizing) should feel instant — no lag

### Compatibility — keyboard isolation from the host page
- **Decision:** Keyboard input into any extension-owned text field (the add-mode comment box, the enlarged view's note editor) must never leak to the host page's own keyboard-shortcut handlers, and the host page's shortcuts must never fire while the user is typing into extension UI. **Rationale:** Real-world testing surfaced this as a functional bug, not a hypothetical: sites like Gmail and Instagram attach global keyboard-shortcut listeners to `document`, and since the extension's UI lives in a closed shadow root, the host page cannot see that an input has focus (its `document.activeElement` check fails), so it fires its own shortcut instead — on Instagram, pressing "n" opened the site's notifications panel instead of typing an "n"; on both sites, some keystrokes were dropped entirely because the host page's shortcut handler called `preventDefault()` on them. **Mechanism:** a capture-phase listener on `window` for `keydown`/`keyup`/`keypress` calls `stopPropagation()` (never `preventDefault()`) for any event targeting extension UI, installed only while that UI is open. *(found and fixed via real browser testing on Gmail and Instagram)*

---

## 3. UX / UI Requirements

### 3.1 Sidebar (Idle State)
- [ ] Docked right-edge panel that resizes the page's viewport (not an overlay) — page content is never blocked or covered by it (see §6 #13 for the app-shell sites where this is not achievable)
- [ ] Drag handle on the panel's left edge: a 1px hairline at rest, turns to the accent colour on hover/focus/drag, `ew-resize` cursor
- [ ] Header row: logo + "salamander" wordmark, a theme toggle (cycles `auto` → `light` → `dark`), and **close**. A separate action row below it holds the primary **add note** button plus **export**/**import** icon buttons. **Decision (Salamander redesign):** add/export/import moved out of the header into their own action row, with the header itself carrying brand identity and the theme toggle instead. **Rationale:** separates "who/what is this" (identity, theme) from "what can I do" (actions), and gives the new theme toggle a natural home next to the wordmark rather than crowding four peer icon buttons into one row. *(decided by: frontend-developer subagent)*
- [ ] Notification banner (error/warning) renders as a small inline rounded banner under the action row — not the old full-bleed black bar — auto-clearing after 8s
- [ ] Below the action row: a "this page (n)" heading (shown only once there is at least one item) above the scrollable list of thumbnails for the current URL. **Decision:** Empty state shows "no feedback on this page yet". **Rationale:** Clear, descriptive message that is lowercase-consistent with v1 convention (§3.4), reassures user the sidebar is working, and encourages action via the **add note** button. *(decided by: frontend-developer subagent)*
- [ ] Narrow-width behaviour: below ~220px the wordmark hides and **add note** collapses to icon-only; at the 100px floor the action row wraps to a column so every control stays reachable with nothing clipped
- [ ] **Decision:** Note-list items magnify under the pointer position (and under keyboard focus), continuously and smoothly, in a macOS-Dock-style spring animation; disabled in favour of a plain hover/focus background under `prefers-reduced-motion`. **Rationale:** matches user-requested "feel like the macOS Dock" affordance for a list that is otherwise plain text + a thumbnail, while still degrading to a static, fully accessible state for reduced-motion users. *(decided by: frontend-developer subagent)*

### 3.2 Add Mode — Selection Box
- [ ] Selection box resizes from any edge or corner via invisible hit zones (edges ~10px thick, corners ~16×16, matching `ns`/`ew`/`nwse`/`nesw` resize cursors) — no visible square handles
- [ ] **Decision:** Selection box outline and every other UI surface draw from the Salamander design tokens rather than hardcoded colours; the accent yellow (`#FEC800`) carries over from v1 as the token's value in both light and dark themes. **Rationale:** proven high-contrast yellow is distinctly overlay-like without being distracting and gives continuity with v1, while token-based colour lets every surface repaint consistently for light/dark/auto. *(decided by: frontend-developer subagent)*
- [ ] Everything **outside** the selection box is dimmed with a translucent scrim, matching the macOS screenshot-selection tool's visual pattern — the box itself (rounded corners) stays fully clear/undimmed so the user can see exactly what they're capturing
- [ ] Comment box appears attached to the selection box, flipping position (below → above → side) based on available viewport space. It is a rounded text area with a button bar tucked under it as an "extension" (same width, rounded bottom corners) holding the character counter and padded ghost **cancel** / **save** buttons; the text area's border darkens on hover and turns yellow on focus. **Decision:** the confirm button is labelled **save** (was "ok" in v1) and is disabled while the trimmed note is empty; a character counter appears once the note passes 900 characters and turns danger-coloured at 980+. **Rationale:** "save" reads more clearly as committing the note than "ok" does. *(decided by: frontend-developer subagent)*

### 3.3 Thumbnail & Enlarged View
- [ ] Thumbnail: screenshot image (rounded on all four corners) + note text truncated to 3 lines, item number badge. On hover/focus the note text gains a background that tucks under the thumbnail's bottom edge as an "extension" of it (same width, rounded bottom corners); the text itself never moves.
- [ ] **Decision:** Thumbnails render in a fixed-size image box (100px height, width fills the available sidebar content area) regardless of the captured screenshot's actual dimensions, with the image scaled via `object-fit: contain`. **Rationale:** Screenshots vary widely in size/aspect ratio depending on what was selected; a fixed box keeps the sidebar list visually even, and `contain` (rather than `cover`) ensures the full captured screenshot is always visible rather than cropped — losing part of the screenshot would undermine the tool's core purpose.
- [ ] Enlarged view (replaces v1's modal — see §1.5): the sidebar expands leftward with shared-element motion — the clicked thumbnail grows into the large screenshot and its neighbours grow into the peek slots, while view-specific controls fade; collapsing reverses it. Prev/next run as a carousel of the same morphs. Peeks are ~3/4 the size of the main note, right-aligned with the rail, with no badges and no blur. Motion follows `design/MOTION_SPEC.md`; under `prefers-reduced-motion` layout changes instantly with crossfades only. The note editor uses the add-mode comment box's text-area + tucked-bar style, with a danger **delete** on the left of the bar and the "saved" hint on the right. *(decided by: user, Salamander v2)*

### 3.4 Text Case
- [ ] Carry forward v1's "all visible UI text is lowercase" convention (buttons, placeholders, errors, dialogs) — confirmed, still applies

### 3.5 Design Language ("Salamander")
- [ ] **Decision:** Replaces v1's ad hoc colours with a token-based design language — a light and a dark theme built from the same named token set (`bg`/`surface`/`text`/`accent`/`danger`/`warn`/etc., black + the v1 yellow accent), plus an `auto` mode that follows `prefers-color-scheme`. The active mode is persisted (`chrome.storage.local`, key `themeMode`) and kept in sync live — across browser tabs and across every extension surface (sidebar incl. the enlarged view, add mode) — via a theme toggle in the sidebar header. **Rationale:** a single token source keeps every surface visually consistent and themeable without hardcoding colours per component, and `auto` respects the user's OS preference by default. *(decided by: frontend-developer subagent)*
- [ ] **Decision:** Typography is Instrument Serif italic (wordmark, enlarged-view and section titles), Instrument Sans (body UI text), and JetBrains Mono (numbers — badges, the character counter) — bundled as local woff2 files and loaded via `FontFace` from the content script (Shadow DOM `@font-face` is ignored by Chrome, and host-page CSP can block extension font URLs). **Rationale:** namespaced, locally-bundled fonts give the UI a distinct, legible identity with no network requests and no risk of colliding with the host page's own fonts. *(decided by: frontend-developer subagent)*
- [ ] Rounded rectangles throughout (never pill shapes), and one consistent set of interaction states (regular/hover/press/focus-visible/disabled) applied to every button and control across all three surfaces

---

## 4. User Journeys

### Journey 1 — Capturing and Exporting Feedback
1. User clicks the extension icon → sidebar opens on the current page
2. User clicks **add** → pointer becomes a selection tool
3. User clicks a spot on the page → default-sized box appears; user drags from an edge/corner to resize over the area they want to flag
4. A comment box appears next to the box; user types a note and clicks **save**
5. Extension hides its own UI, captures the screenshot + DOM context, restores its UI, exits add mode
6. A new thumbnail appears in the sidebar (item #1)
7. User repeats for other areas on the page (and other pages, navigating normally — sidebar persists per §1.1) — thumbnails only show for the page currently open, numbering continues globally
8. User clicks **export** → downloads a `.zip` with all screenshots and a single `feedback.md` for the whole domain

### Journey 2 — Reviewing / Importing Feedback
1. Recipient (developer, or the same user on another session) opens the same site, opens the sidebar
2. Clicks **import**, selects the `.zip` bundle
3. Extension validates domain match, loads all feedback into storage
4. Sidebar shows thumbnails for the current URL; navigating to other URLs in the bundle reveals their thumbnails too
5. Recipient can read `feedback.md` directly (e.g. hand it to an AI coding agent) without ever opening the extension, since it's self-contained with inline screenshot references and captured DOM context per item

---

## 5. Error Handling

| # | Case | Type | Behavior |
|---|------|------|----------|
| 1 | Wrong file type on import (not `.zip`) | 🔴 Error | "invalid file type. please upload a .zip feedback bundle." |
| 2 | Zip is corrupted / not a valid archive | 🔴 Error | "could not read this file — it appears to be corrupted." |
| 3 | Zip is missing `feedback.md` | 🔴 Error | "this doesn't look like a feedback bundle." |
| 4 | An item's metadata block references a screenshot file that isn't in the zip | 🔴 Error | "this file is missing screenshot data and can't be imported." |
| 4b | `feedback.md` exists but an item's fenced metadata block is missing/malformed | 🔴 Error | "this bundle appears to be corrupted (couldn't read feedback data)." |
| 5 | Domain mismatch on import | 🔴 Error | "this bundle contains feedback for '{other-domain}', but you're currently on '{current-domain}'." |
| 6 | Bundle schema version newer than current extension | 🟡 Warning | "this bundle was created with a newer version of the extension. some feedback may not display correctly." Import proceeds. |
| 7 | Export with zero feedback items on the domain | 🔴 Error | `alert("nothing to export")` |
| 8 | Screenshot capture fails (rate limit, restricted page) | 🔴 Error | "couldn't capture a screenshot here. try again." Feedback item is not created. |
| 9 | Add mode attempted on a page where content scripts can't run (`chrome://`, Web Store, PDF viewer) | 🔴 Error | Extension icon / add button indicates unavailability; explanatory message on attempt |
| 10 | Existing feedback present for domain + user imports a bundle | 💬 Confirmation | "importing will replace your current N feedback item(s) for this site. this cannot be undone. continue?" |
| 11 | Duplicate/invalid IDs within an imported bundle | 🔴 Error | "this bundle appears to be corrupted (duplicate item ids)." |

---

## 6. Edge Cases

| # | Scenario | Behavior |
|---|----------|----------|
| 1 | Selection box would extend past the visible viewport | Clamped to viewport edges — cannot drag/resize further in that direction. Rationale: the underlying capture API only captures the rendered viewport; auto-scroll+stitch was considered and deferred as unnecessary complexity for v1. |
| 2 | Selection box / handles / dimming scrim / comment box visible at moment of capture | This in-page overlay UI is hidden immediately before the capture call and restored immediately after — must never appear in the resulting screenshot. The sidebar itself doesn't need special handling here since it resizes the page and can never overlap a selection's crop bounds (see §1.2). |
| 3 | Selection box drawn too small (accidental click) | Enforced minimum dimensions: 20×20px (see §1.2 for rationale) |
| 4 | High-DPI / Retina display | Capture naturally reflects device pixel ratio; captured resolution may exceed CSS pixel dimensions of the selection |
| 5 | Browser zoom ≠ 100% | Selection coordinates and capture are computed against rendered pixels, so zoom is inherently accounted for |
| 6 | Selection area contains a cross-origin `<iframe>` | Screenshot pixels still capture correctly (visible-tab capture doesn't care about origin), but DOM/context capture (§1.4) cannot see inside the iframe due to same-origin restrictions — context for that region is limited to the iframe element's own tag/attributes/`src` |
| 7 | Viewport resized between sessions/captures | Each feedback item's screenshot is a fixed image; stored selection coordinates are archival only (not used to re-render anything live), so no re-render inconsistency is possible |
| 8 | Rapid successive captures | Visible-tab capture API is rate-limited (~2/sec historically) — client should throttle/queue if the user captures faster than that |
| 9 | Very large selection (covers most of the viewport) | Context capture size governance (§1.4E) applies — truncates with a visible marker rather than producing an unbounded export |
| 10 | Same URL revisited in a later session | Sidebar reloads all previously stored feedback items for that normalized URL |
| 11 | URL normalization | **Decision:** Carry forward v1's normalization rules unchanged: strip query params and fragments, strip `www.`, strip trailing slash, use case-sensitive path, strip default ports, preserve non-standard ports. **Rationale:** These are proven heuristics that balance URL grouping (query params and default ports don't change the "page") with precise targeting (case-sensitive paths distinguish similar URIs). No new requirements suggest changes. *(decided by: backend-developer subagent)* |
| 12 | Sensitive form fields (passwords) within a selection | Out of scope for v1 — see §2 Security. UX can warn users at capture time, but no visual masking or field skipping in v1. |
| 13 | App-shell sites whose layout ignores the page shrink (**youtube.com** is the known example) | **Known limitation, not a fixable bug.** The sidebar shrinks the page by giving `<html>` a `!important` right margin (defended by both an injected backstop stylesheet and a `MutationObserver` that re-asserts it). Two page-side patterns defeat *any* root-box shrink and cannot be worked around from a content script: (a) containers sized in **viewport units** — `100vw`/`100dvw` resolve against the real browser viewport by CSS spec, never against an element's used width, so they keep full-viewport width no matter what we set on the root (YouTube's full-bleed/theater player container); and (b) layouts that **measure `window.innerWidth` in JS** and set their own pixel widths from it — shrinking the root does not change `innerWidth`, so they recompute to the same too-wide value (YouTube's Polymer `ytd-watch-flexy` player sizing). A synthetic `resize` event is dispatched after every apply so such layouts at least re-run. On top of that, a page's own `position: fixed` elements (YouTube's masthead) never move for an ancestor width change — the general fixed-element case already noted in §1.1. **Degradation:** the sidebar host carries an explicit near-max `z-index`, so on such pages the panel stays fully visible and usable and the page simply reads as partly covered; closing the sidebar restores the page exactly. Rewriting the page's own stylesheets to neutralize `vw` units was considered and rejected as unsafe and unreliable. |

---

## 7. Out of Scope (v1)

- Drawing/annotating directly on top of a captured screenshot (freehand markup) — planned as the **next** milestone after this one, not this one
- Repositioning or re-cropping an existing feedback item's screenshot after capture (delete + recapture instead) — cropping is a planned future improvement
- Persistent visual markers/highlights on the live page for saved feedback — explicitly dropped in this rewrite (see §1.5); may revisit
- Auto-scroll + stitch capture for selections that exceed the viewport
- Merging feedback on import (import always replaces existing domain data, never merges by ID)
- Cloud sync / backend / real-time collaboration
- Multi-tab live sync of sidebar state — **Decision:** Out of scope for v1; defer to v2. **Rationale:** v1's multi-tab sync was meaningful because pins lived as interactive markers on the page. This design has no live pins—only sidebar thumbnails per-URL. Each tab's sidebar independently shows only that tab's current URL's feedback, so cross-tab sync adds complexity without clear benefit. Users can click the extension icon on each tab if needed. *(decided by: backend-developer subagent)*
- Mobile / non-Chrome browsers
