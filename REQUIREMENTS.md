# Annotator — Requirements

> Chrome extension for inline web annotations. Annotate any webpage on any website, export as a file, share with others who can import and view the same annotations.

---

## Definition: "Active"
The extension is considered **active** on a page when the floating S button or toolbar panel is visible. The extension is inactive when neither is shown (e.g. on a new tab before the user clicks the extension icon).

**Annotation mode** is the state where the user can click elements to create annotations. It is entered by clicking the S button, and exited by clicking the Exit (✕) button in the toolbar.

---

## Status: 🟡 Draft — In Progress

---

## 1. Functional Requirements

### 1.1 Annotating
- [ ] User can activate annotation mode on any webpage via the extension
- [ ] User can click any element on the page to select it
- [ ] User can attach a text note to the selected element (max 400 characters)
- [ ] User can edit an existing annotation
- [ ] User can delete an existing annotation
- [ ] Annotations persist across page reloads (within the same session/browser)
- [ ] Annotations are numbered globally and continuously across all pages of a domain (e.g. pins 1–3 on page A, pins 4–6 on page B)
- [ ] Annotation numbering always continues from the **highest pin number currently in storage** — this applies whether pins were created by the user or imported from a file
- [ ] Gaps from deletions are not backfilled (e.g. if pins 1, 2, 4, 7 exist, the next pin is 8)
- [ ] On import: if the file contains pins 1–20, the next annotation the user creates is pin 21 — regardless of gaps in the file (e.g. file has 1, 2, 4, 7 → next pin is 8)

### 1.2 Element Targeting (How Annotations Attach to Elements)

This is critical for annotations to re-appear correctly when a file is imported on another machine.

When an annotation is placed, the extension captures a **multi-signal fingerprint** of the target element:

- **Primary:** CSS selector path (preferring `id` and `data-*` attributes; falling back to tag + class + positional index)
- **Secondary:** XPath of the element
- **Tertiary:** Text content snippet (first ~50 chars of the element's text, if any)
- **Metadata:** Tag name, bounding box position (as a hint, not primary key)

On import, the extension attempts to locate each element in order:
1. Try CSS selector — if found and unique, use it
2. Try XPath — if found, use it
3. Try text content match — find element with matching tag + text
4. If none match: annotation is unresolved — no pin placed. This contributes to the page-level resolution alert (see §3.4)

**Known limitation (v1):** Highly dynamic pages (React/SPA apps with auto-generated class names or no stable IDs) may produce fragile selectors. Annotations on such elements may fail to resolve on re-import. This is accepted as a v1 limitation.

### 1.3 Exporting
- [ ] User can export all annotations across all pages of the current domain as a single file
- [ ] Export button is always enabled. If clicked with no annotations, shows `alert("nothing to export")` and does nothing
- [ ] Export file format: YAML
- [ ] Default filename: `annotations-{domain}.yaml` where domain dots are replaced with underscores (e.g. `annotations-figma_com.yaml`)
- [ ] Export file includes all data described in §1.3.1 below

#### 1.3.1 Export File Contents (YAML)

The exported YAML file must contain the following. Exact schema and field names are for technical design to decide.

**File-level metadata:**
- Extension version number (for forward compatibility — enables version mismatch detection on import)
- Creation timestamp (ISO 8601 format — for human reference when reading the file)
- Website domain the annotations belong to

**Annotations:**
- A flat list of annotations, ordered by pin number
- Each annotation contains:
  - Pin number
  - Page URL (base URL only — no query params or fragments)
  - Annotation text
  - Element fingerprint: CSS selector, XPath, text content snippet (~50 chars), element tag name
  - Pin position: click offset relative to the element's top-left corner (x, y in pixels)

**Readability standard:** The file should be readable and debuggable by a developer. It does not need to be friendly to non-technical users. Field names should be self-explanatory (e.g. `pin_number` not `pn`).

### 1.4 Importing
- [ ] User can import an annotation file via a file picker
- [ ] On successful import, the extension **automatically enters annotation mode** on the current page
- [ ] Extension applies annotations to the correct elements on the current page (and stores the rest for other pages in the domain)
- [ ] On export, **all stored annotations are included** — not just those for the currently-visited page. Annotations for pages the user has not visited since importing are preserved in storage and included in the export. Importing then re-exporting a file produces a complete round-trip with no data loss.
- [ ] Only one file can be active at a time — importing a new file replaces the current state entirely
- [ ] The toolbar displays the active filename to indicate a file is loaded
- [ ] If the user edits, adds, or deletes any annotation after importing, the filename indicator is removed (unsaved/modified state)
- [ ] Graceful, specific error handling for all import failure cases (see §5)

### 1.5 Managing Annotations
- [ ] User can edit an individual annotation
- [ ] User can delete an individual annotation — **immediately, no confirmation dialog required**
- [ ] User can delete all annotations at once via a **Delete All** button in the toolbar
  - If no annotations exist: silent no-op (no alert, no confirm)
  - If annotations exist: requires a browser `confirm()` dialog before proceeding
  - Deletes all annotations across all pages of the current domain
  - If a file was imported, the in-extension annotations are cleared — but the original file on the user’s device is untouched
  - After deletion: toolbar returns to its default empty state (filename indicator gone)
- [ ] All annotation changes (add, edit, delete, delete all) are **auto-saved immediately** — there is no manual save step

---

## 2. Non-Functional Requirements

- Works on any public webpage
- No backend / server required — fully local and file-based in v1
- Annotation file is human-readable (YAML)
- Import is fault-tolerant — shows specific errors, never crashes
- Annotations render without breaking or obscuring page layout
- Pins scroll with the page (positioned relative to elements, not fixed to the viewport)
- Clicking elements in annotation mode does not trigger the page's native click behavior
- Fast — annotation interactions feel instant (no lag)
- Chrome desktop only (v1)

### Permissions
- The extension requests permission to run on **all websites** at install time — no per-site prompts after that
- After initial permission grant, the extension toolbar injects directly into the page — no intermediate popup
- The extension icon click: shows a permission prompt only on first use (or if permission was revoked); otherwise injects the toolbar directly into the page

### Security
- The extension must **never transmit any user data outside the device** — no network calls, no analytics, no telemetry
- All data stays local: annotation storage, export files, and import processing all happen entirely on-device
- The extension must not inject or execute any remotely-loaded scripts
- The extension must request only the minimum permissions required to function
- The codebase will be open-source — the implementation must be auditable and free of obfuscation

### Multi-Tab Behavior
- Annotations written on one tab are **immediately visible on other tabs** open on the same domain
- When the user switches to another tab on the same domain, that tab's pins reflect the latest stored state (including any annotations added on other tabs)
- `chrome.storage.onChanged` events should be used to keep all active tabs in sync
- Last-write-wins for concurrent edits across tabs (no merge strategy needed in v1)

### Toolbar Activation & Persistence
- The toolbar is **on-demand** — it only appears when the user explicitly clicks the extension icon on a tab
- The toolbar does not appear automatically on any website, even if the user has previously annotated that domain
- **New tab:** requires clicking the extension icon to activate the toolbar
- **Full page reload (same tab):** toolbar re-activates automatically — no need to click the extension icon again
- **SPA navigation (same tab, no reload):** toolbar remains visible **and annotation mode stays active**, any open popover closes, hover highlight clears, pins update to reflect the new page’s annotations

### Storage
- Annotations must persist across browser close and reopen — they survive indefinitely until the user deletes them or uninstalls the extension
- Storage is local to the device and Chrome profile — no sync across devices in v1
- The storage mechanism must support at least 8MB of annotation data
- Storage quota handling and quota-exceeded errors are **out of scope for v1** — no special behavior required when storage limits are reached
- Suggestion: `chrome.storage.local` is a strong candidate — it meets all the above requirements (local, persistent, ~10MB default limit). Final storage implementation decision to be made during technical design.

---

## 3. UX / UI Requirements

### 3.1 Annotation Mode
- [ ] Annotation mode is **entered by clicking the S button** (the idle-state button). Annotation mode is **exited by clicking the Exit (✕) icon** in the toolbar.
- [ ] In annotation mode: all native element click behaviors are suppressed — the page cannot be interacted with via clicks. This applies to all pages including complex MFEs (Gmail, SPAs, etc.) — the suppression happens at the `window` capture phase, before any page handler fires.
- [ ] Scrolling continues to work normally in annotation mode
- [ ] To navigate to another page in annotation mode, the user can click links normally only after exiting (via the Exit button). While in annotation mode, clicking links does not navigate
- [ ] Hovering over an element highlights it with a yellow (#FEC800) outline to indicate it is selectable
- [ ] Clicking a non-annotated element opens a comment popover anchored near the click point
- [ ] Clicking an existing pin opens the same popover pre-filled with the annotation’s current text
- [ ] **Import triggers annotation mode:** when a file is successfully imported, annotation mode is automatically entered on the current page (consistent with §1.4)

### 3.2 Annotation Popover
- [ ] Popover has two sections: a dark grey textarea area (top, rounded 16px top corners) and a black footer bar (bottom, rounded 16px bottom corners).
- [ ] Popover footer layout:
  - **Create mode (new annotation):** [Cancel (✕) — bottom-left] [spacer] [Save — bottom-right]
  - **Edit mode (existing annotation):** [Cancel (✕) — bottom-left] [Delete (🗑) — next to cancel] [spacer] [Save — bottom-right]
- [ ] The **Save** button is disabled when the text input is empty in create mode; always enabled in edit mode
- [ ] All button labels and placeholder text are **lowercase**: "save", "type something..."
- [ ] Text input has a max of 400 characters
- [ ] **Character counter:** visible in the footer bar (between the left buttons and spacer) **only when the character count reaches 350 or more**. Shows current count e.g. `"350 / 400"`. Turns red (#FB645A) at 380+ chars.
- [ ] **Delete is immediate** — no confirmation dialog for single-annotation delete
- [ ] **Click-outside behavior:**
  - **Create mode, empty textarea:** popover closes; the annotation listener immediately opens a new popover at the clicked element (effectively “moves” the annotation target)
  - **Create mode, textarea has content:** popover wiggles (short shake animation) to indicate the user must save or cancel first. Click is fully suppressed.
  - **Edit mode:** popover wiggles. Click is fully suppressed.
- [ ] Popover default position: right of the pin at the same vertical level
- [ ] Overflow handling: try right → top-right → top-left → left (whichever fits in the viewport)

### 3.3 Annotation Display
- [ ] Pins are **only visible in annotation mode** — when annotation mode is off, pins are hidden and the page behaves normally
- [ ] Annotations are shown as **yellow (#FEC800) pill-shaped pins** with a black border (`1px solid #000`)
  - Single-digit numbers: circular (min-width = height)
  - Multi-digit numbers: pill widens to fit the text
- [ ] Each pin displays its annotation number in black, bold text
- [ ] **Pin placement:** the pin appears at the exact point where the user clicked on the element. The position is stored as an (x, y) offset relative to the element's top-left corner. When the element moves (scroll, reflow, resize), the pin recalculates its screen position as: element's current top-left + stored offset. The pin always stays at the same visual point on the element.
- [ ] Pin overlap is possible; no automatic collision avoidance in v1

### 3.4 Floating Toolbar

#### Idle State (annotation mode OFF)
- [ ] A floating **S button** (56×56px, black, rounded) appears in the bottom-right corner when the extension is active but annotation mode is off
- [ ] Clicking the S button enters annotation mode and replaces itself with the expanded toolbar panel

#### Annotation Mode (toolbar panel visible)
- [ ] The toolbar panel replaces the S button. It contains (left to right): **[Export icon] [Import icon] [Delete All icon] [Exit icon]** — icon-only buttons, no text labels
- [ ] All 4 buttons are always enabled (never greyed out)
- [ ] **Export:** if no annotations exist, shows `alert("nothing to export")`. Otherwise triggers file download.
- [ ] **Import:** opens native file picker
- [ ] **Delete All:** if no annotations, silent no-op. If annotations exist, shows `confirm("delete all N annotation(s)? this cannot be undone.")` (all lowercase). On confirm: deletes all annotations, clears pins.
- [ ] **Exit:** collapses toolbar back to S button. Annotation mode ends. Pins hide. Annotations are preserved.
- [ ] When a file is loaded via import: a filename bar appears **above** the button row, showing the filename and a dismiss (✕) button. Dismissing removes the file reference **and all imported annotations**.
- [ ] When annotations are modified after import: filename indicator disappears
- [ ] Warnings appear **below the filename bar** (or below the button row if no filename) in amber (#D6AE7C)
- [ ] Errors appear below the filename bar in red (#FB645A)

#### Text Case
- [ ] **All visible text in the UI is lowercase** — button labels, error messages, warning messages, confirm/alert dialog text, placeholder text, tooltips. No exceptions.

#### Stacking order (top to bottom inside toolbar panel)
1. Filename bar (conditional)
2. Warning/error bar (conditional)
3. Icon button row (always visible in annotation mode)

#### Import Resolution Alerts (below filename, page-level)
After a file is successfully imported, the toolbar shows a page-level alert **directly below the filename** indicating how many annotations could be placed on the current page. This alert updates automatically whenever the user navigates to a new page.

| Scenario | Alert | Style |
|----------|-------|-------|
| All annotations for this page resolved successfully | No alert shown | — |
| No annotations in the file target this page | No alert shown | — |
| Annotations exist for this page but **some** couldn't be placed | "X of Y annotations couldn't be placed on this page." | 🟡 Yellow |
| Annotations exist for this page but **none** could be placed | "None of the annotations could be placed on this page." | 🔴 Red |

- These alerts are **per-page** — they reflect the resolution result for the current page only
- On navigation to a new page, the alert is recalculated and updated for that page
- These alerts are separate from import-time errors (wrong file type, domain mismatch, etc.) which appear above the toolbar and reject the file

---

## 4. User Journeys

### Journey 1 — Creating and Exporting Annotations

1. User opens any website in Chrome
2. User clicks the Extensions icon (puzzle piece, top right) and selects **Annotator**
3. On first ever use: Chrome shows a one-time permission prompt — user approves
4. A floating **S button** appears in the bottom-right corner
5. User clicks the **S button** — annotation mode activates, S button is replaced by the toolbar panel
   - Hovering over page elements highlights them with a yellow outline
   - All native click behavior on page elements is suppressed
6. User clicks an element → a popover appears near the click point with a textarea
7. User types their note and clicks **save**
   - A yellow pill pin numbered **1** appears anchored to that element
8. User continues annotating more elements → pins numbered sequentially (2, 3, 4…)
9. User clicks the **Exit (✕)** button — leaves annotation mode. Pins hide. Page returns to normal. Annotations are auto-saved.
10. User navigates to another page on the same domain:
    - **SPA navigation:** toolbar panel stays visible, annotation mode stays active, pins update for new page
    - **Full page reload:** toolbar disappears; user clicks extension icon again to reactivate
11. User annotates more elements on this page (pin numbering continues from highest stored)
12. User clicks **Export** icon → browser downloads `annotations-{domain}.yaml` containing all annotations across all pages

### Journey 2 — Viewing Shared Annotations

1. User opens the same website in Chrome
2. User opens **Annotator** from the Extensions menu
3. Permission is requested if not already granted (first use only)
4. A floating **S button** appears in the bottom-right corner
5. User clicks **Import** icon (visible after clicking S button to enter annotation mode) → native file picker opens
6. User selects the `.yaml` annotation file received from the first user
7. Extension validates and loads the file:
   - Toolbar displays the filename above the button row with a dismiss (✕) button
   - Extension enters annotation mode automatically
   - Yellow pins appear on all resolved elements for the current page
   - Annotations for other pages in the domain are stored and will appear when the user visits those pages
8. User can browse the site — entering annotation mode on each page reveals the imported pins
9. User can add, edit, or delete annotations
   - As soon as any change is made, the filename indicator disappears (modified state)
10. User can export the current annotation set as a new file — this is simply the current state (imported annotations + any additions/edits/deletions made since). There is no separate tracking of "original" vs "changed" annotations; it is all one unified state.

---

## 5. Import Error Handling

Errors appear **in red in the toolbar** (below filename bar if present). Warnings in amber. Never silent failures, never crashes.

**All error/warning/confirm text must be lowercase** (per the global text case rule in §3.4).

**Two distinct patterns are used:**
- **Error/Warning messages** — passive inline text shown above the toolbar. Used when the file is rejected or something went wrong.
- **Confirmation dialogs** — blocking modal with Confirm/Cancel buttons. Used when the action is valid but destructive (would overwrite or discard existing data). Same modal pattern as the Delete All confirmation in §1.5. The user must explicitly confirm before the import proceeds; cancelling leaves the current state untouched.

| # | Error Case | Type | Behavior |
|---|------------|------|----------|
| 1 | Wrong file type (not `.yaml` or `.yml`) | 🔴 Error | "Invalid file type. Please upload a `.yaml` annotation file." File rejected. |
| 2 | File is empty | 🔴 Error | "This file is empty. Nothing to import." |
| 3 | File is not valid YAML (corrupted or malformed) | 🔴 Error | "Could not read this file — it appears to be corrupted or incorrectly formatted." |
| 4 | Valid YAML but wrong schema (missing required fields) | 🔴 Error | "This file doesn't look like an Annotator file. Please check you're uploading the right file." |
| 5 | Domain mismatch — file is from a different website | 🔴 Error | "this file contains annotations for '{other-domain}', but you're currently on '{current-domain}'." File rejected — no proceed option. |
| 6 | File version mismatch (future-proofing) | 🟡 Warning | "This file was created with a newer version of Annotator. Some annotations may not display correctly." Import proceeds. |
| 7 | Domain matches but no annotations in the file target the current page | ℹ️ Silent | Import succeeds. Toolbar shows filename. No pins appear on this page (expected). No alert shown. Pins appear when user navigates to pages that have annotations. |
| 8 | File has annotations for this page but **zero** elements could be resolved | 🔴 Alert (toolbar, below filename) | "None of the annotations could be placed on this page." Shown in red below filename. Updates per-page on navigation. |
| 9 | File has annotations for this page and **some** (but not all) elements resolved | 🟡 Alert (toolbar, below filename) | "X of Y annotations couldn't be placed on this page." Shown in yellow below filename. Resolved pins are shown; unresolved ones skipped. Updates per-page on navigation. |
| 10 | File has no annotations (empty list) | 🔴 Error | "This file exists but contains no annotations." |
| 13 | Import file exceeds 8MB | 🔴 Error | "This file is too large to import (max 8MB)." File rejected. |
| 14 | Duplicate pin numbers in imported file | 🔴 Error | "This file appears to be corrupted (duplicate pin numbers detected)." Shown as a red error above the toolbar. File rejected. |
| 11 | User already has annotations → uploads a file | 💬 Confirmation dialog | "Uploading this file will replace your current X annotation(s). This cannot be undone. Continue?" Confirm/Cancel. If confirmed, current annotations wiped and file loaded. If cancelled, nothing changes. |
| 12 | User has unsaved changes (post-import edits) → uploads another file | 💬 Confirmation dialog | "You have unsaved changes. Uploading a new file will discard them. This cannot be undone. Continue?" Confirm/Cancel. If confirmed, proceed with import. If cancelled, nothing changes. |

---

## 6. Edge Cases

| # | Scenario | Behavior |
|---|----------|----------|
| 1 | User has existing annotations → uploads a file | Confirmation dialog (§5 #11). If confirmed: wipe current, load file. |
| 2 | User uploads file → makes changes → uploads another file | Confirmation dialog (§5 #12). If confirmed: proceed. |
| 3 | User uploads file → clicks Export | Exported file contains all annotations (from file + any additions/edits). New download triggered; original file not touched. |
| 4 | Pin deleted → user continues annotating | Numbering continues from highest used number. No backfill of gaps. |
| 5 | Same element annotated twice | Two separate pins on the same element. Both valid. No restriction. |
| 6 | User tries to annotate inside an `<iframe>` | Out of scope v1. Iframes are not selectable. No highlight on hover. |
| 7 | URL includes query params or fragments | Params and fragments are stripped. Base URL only is stored and matched. |
| 8 | HTTP vs HTTPS same page | Treated as the same URL — normalized to HTTPS. |
| 14 | Trailing slash in URL | `example.com/page` and `example.com/page/` are treated as the **same URL** — trailing slash is stripped during normalization. |
| 15 | URL case sensitivity | URLs are treated as **case-sensitive** — `example.com/Page` and `example.com/page` are different pages. Only the scheme and hostname are lowercased; the path preserves its original case. |
| 16 | www prefix | `www.example.com` and `example.com` are treated as the **same domain** — the `www.` prefix is stripped during normalization. Other subdomains (e.g. `app.example.com`, `aws.amazon.com`) are treated as distinct domains. |
| 17 | Port numbers in URL | Non-standard ports are **preserved** — `example.com:8080` and `example.com` are treated as distinct domains. This is required so localhost dev servers (`localhost:3000`, `localhost:5173`) can be annotated as separate targets. Standard ports (`:80` on http, `:443` on https) are stripped as redundant. |
| 18 | Extension icon clicked while toolbar is already visible | Toolbar stays open. No toggle, no duplicate injection. Clicking the icon again does nothing if the toolbar is already active on that tab. |
| 19 | Annotating a page behind authentication | If the recipient doesn't have access, the page content will differ from the sharer's — elements won't be found, triggering the standard page-level resolution alert (red: "None of the annotations could be placed on this page."). No special handling needed beyond existing error cases. |
| 20 | Fixed-position elements (sticky headers, fixed navbars) | Pins must remain correctly anchored to their element as the user scrolls. Pin position calculation must account for `position: fixed` elements — use viewport-relative coordinates (`getBoundingClientRect`) rather than document-relative offsets when rendering pins on fixed elements. |
| 21 | YAML file character encoding | Export files must be written as **UTF-8**. This ensures annotation text containing emoji, CJK characters, RTL text, or other non-ASCII content round-trips correctly. The import parser must also read files as UTF-8. |
| 9 | User annotates a dynamic element (modal, dropdown) not always in DOM | Selector captured at annotation time. On import, if element not in DOM, annotation is silently skipped. |
| 10 | Pin overlaps another pin or page UI | Possible in v1. No collision detection. Future improvement candidate. |
| 11 | Annotation text reaches 400 char limit | Input is capped at 400 chars. Character counter shown in popover. |
| 12 | Export filename collision | Browser handles natively (appends `(1)`, `(2)`, etc.). No special handling needed. |
| 13 | Dynamic/SPA page (React, Vue, etc.) | Accepted v1 limitation. Multi-signal fingerprint used best-effort. If individual annotations fail to resolve, they are silently skipped — but the page-level alert (§3.4) will reflect the count of unresolved annotations. |

---

## 7. Out of Scope (v1)

- Real-time collaboration
- Cloud sync or backend
- Multi-tab conflict resolution (last-write-wins is acceptable in v1; no merge strategy needed)
- Comment threads / replies
- Multiple files active simultaneously / file merging
- Mobile / non-Chrome browsers
- Video or audio annotations
- Auth / user accounts
- Annotation collision detection / auto-layout
- Keyboard shortcuts
- MutationObserver-based dynamic re-resolution (v2 candidate)
