# Annotator — Requirements

> Chrome extension for inline web annotations. Annotate any webpage on any website, export as a file, share with others who can import and view the same annotations.

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
- [ ] Annotation numbering continues from the highest used number — gaps from deletions are not backfilled

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
4. If none match: annotation is silently unresolved (no pin placed)

**Known limitation (v1):** Highly dynamic pages (React/SPA apps with auto-generated class names or no stable IDs) may produce fragile selectors. Annotations on such elements may fail to resolve on re-import. This is accepted as a v1 limitation.

### 1.3 Exporting
- [ ] User can export all annotations across all pages of the current domain as a single file
- [ ] Export is only enabled when at least one annotation exists
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

**Readability standard:** The file should be readable and debuggable by a developer. It does not need to be friendly to non-technical users. Field names should be self-explanatory (e.g. `pin_number` not `pn`).

### 1.4 Importing
- [ ] User can import an annotation file via a file picker
- [ ] Extension applies annotations to the correct elements on the current page (and stores the rest for other pages in the domain)
- [ ] Only one file can be active at a time — importing a new file replaces the current state entirely
- [ ] The toolbar displays the active filename to indicate a file is loaded
- [ ] If the user edits, adds, or deletes any annotation after importing, the filename indicator is removed (unsaved/modified state)
- [ ] Graceful, specific error handling for all import failure cases (see §5)

### 1.5 Managing Annotations
- [ ] User can edit an individual annotation
- [ ] User can delete an individual annotation

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

### Storage
- Annotations must persist across browser close and reopen — they survive indefinitely until the user deletes them or uninstalls the extension
- Storage is local to the device and Chrome profile — no sync across devices in v1
- The storage mechanism must support at least 8MB of annotation data
- Suggestion: `chrome.storage.local` is a strong candidate — it meets all the above requirements (local, persistent, ~10MB default limit). Final storage implementation decision to be made during technical design.

---

## 3. UX / UI Requirements

### 3.1 Annotation Mode
- [ ] Entering annotation mode: all native element click behaviors are suppressed
- [ ] Hovering over an element highlights it with a visible outline to indicate it is selectable
- [ ] Clicking a non-annotated element opens a comment popover anchored near the click point (Figma-style)
- [ ] Popover contains: text input (max 400 chars) + character counter + "Add" button + cancel/close
- [ ] Clicking "Add" saves the annotation, closes the popover, and places a pin on the element
- [ ] Clicking an existing pin in annotation mode shows the annotation text and options to edit or delete

### 3.2 Annotation Display
- [ ] Pins are **only visible in annotation mode** — when annotation mode is off, pins are hidden and the page behaves normally
- [ ] Annotations are shown as round magenta/pink pins
- [ ] Each pin displays its annotation number
- [ ] Pins are anchored to the annotated element (top-left corner or closest visible edge)
- [ ] Pins scroll with the page — they move as the user scrolls, staying attached to their elements
- [ ] Pin overlap is possible; no automatic collision avoidance in v1

### 3.3 Floating Toolbar
- [ ] A floating toolbar appears in the bottom-right corner of the page when the extension is active
- [ ] Toolbar buttons: **Start Annotating** | **Export** | **Upload**
- [ ] When in annotation mode: toolbar shows **Exit** button instead of Start Annotating; Export button remains
- [ ] Export button is disabled (greyed out) when there are no annotations; enabled when at least one exists
- [ ] When a file is loaded via import: toolbar displays the filename above the buttons
- [ ] When annotations are modified after import: filename indicator disappears
- [ ] Errors appear in **red** above the toolbar
- [ ] Warnings appear in **yellow** above the toolbar
- [ ] Messages/notices appear in a neutral style above the toolbar

---

## 4. User Journeys

### Journey 1 — Creating and Exporting Annotations

1. User opens any website in Chrome
2. User clicks the Extensions icon (puzzle piece, top right) and opens **Annotator**
3. If the extension hasn't been granted permission to run on this page, it prompts for it
4. Once permitted, a floating toolbar appears in the bottom-right corner with three buttons: **Start Annotating**, **Export** (disabled), **Upload**
5. User clicks **Start Annotating** — annotation mode activates
   - Toolbar updates: **Start Annotating** becomes **Exit**; Export remains disabled
   - Hovering over page elements highlights them with an outline
   - Native click behavior on all elements is suppressed
6. User clicks an element → a comment popover appears near the click point
7. User types their note (up to 400 chars) and clicks **Add**
   - A round magenta pin numbered **1** appears anchored to that element
   - Export button becomes enabled
8. User continues annotating more elements → pins are numbered sequentially (2, 3, 4…)
9. User clicks **Exit** — leaves annotation mode
   - Pins disappear; the page returns to normal behavior
   - Annotations are saved in the background
10. User navigates to another page on the same domain
    - The toolbar reappears. No pins are visible (not in annotation mode)
    - User clicks **Start Annotating** — pin numbering continues from where it left off (e.g. starts at 5)
11. User annotates more elements on this page
12. User clicks **Export** → browser downloads `annotations-{domain}.yaml` containing all annotations across all pages visited

### Journey 2 — Viewing Shared Annotations

1. User opens the same website in Chrome
2. User opens **Annotator** from the Extensions menu
3. Permission is requested if not already granted
4. Floating toolbar appears with **Start Annotating**, **Export** (disabled), **Upload**
5. User clicks **Upload** → native file picker opens
6. User selects the `.yaml` annotation file received from the first user
7. Extension validates and loads the file:
   - Toolbar displays the filename (e.g. `annotations-figma_com.yaml`) above the buttons
   - Extension enters annotation mode automatically
   - Magenta pins appear on all resolved elements for the current page
   - Annotations for other pages in the domain are stored and will appear when the user visits those pages
8. User can browse the site — entering annotation mode on each page reveals the imported pins
9. User can add, edit, or delete annotations
   - As soon as any change is made, the filename indicator disappears (modified state)
10. User can export the full annotation set (original + changes) as a new file

---

## 5. Import Error Handling

Errors appear in **red above the toolbar**. Warnings in **yellow above the toolbar**. Never silent failures, never crashes.

| # | Error Case | Type | Behavior |
|---|------------|------|----------|
| 1 | Wrong file type (not `.yaml` or `.yml`) | 🔴 Error | "Invalid file type. Please upload a `.yaml` annotation file." File rejected. |
| 2 | File is empty | 🔴 Error | "This file is empty. Nothing to import." |
| 3 | File is not valid YAML (corrupted or malformed) | 🔴 Error | "Could not read this file — it appears to be corrupted or incorrectly formatted." |
| 4 | Valid YAML but wrong schema (missing required fields) | 🔴 Error | "This file doesn't look like an Annotator file. Please check you're uploading the right file." |
| 5 | Domain mismatch — file is from a different website | 🔴 Error | "This file contains annotations for `{other-domain}`. You're on `{current-domain}`. Import is not allowed." No proceed option. |
| 6 | File version mismatch (future-proofing) | 🟡 Warning | "This file was created with a newer version of Annotator. Some annotations may not display correctly." Import proceeds. |
| 7 | Domain matches but no annotations apply to the current page | ℹ️ Silent | Import succeeds. Toolbar shows filename. No pins appear on this page. Pins will appear on matching pages when navigated to. |
| 8 | File has annotations but zero elements could be resolved on the current page | 🟡 Warning | "Annotations were loaded, but we couldn't find the annotated elements on this page. The page may have changed." |
| 9 | File partially resolves — some elements found, some not | 🟡 Warning | "Some annotations couldn't be placed — the page may have changed since this file was created." Resolved pins shown; unresolved ones silently skipped. |
| 10 | File has no annotations (empty list) | 🔴 Error | "This file exists but contains no annotations." |
| 11 | User already has annotations → uploads a file | 🔴 Confirm | "Uploading a file will replace your current X annotation(s). Continue?" Confirm/Cancel. If confirmed, current annotations wiped and file loaded. |
| 12 | User has unsaved changes (post-import edits) → uploads another file | 🔴 Confirm | "You have unsaved changes. Uploading a new file will discard them. Continue?" Confirm/Cancel. |

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
| 9 | User annotates a dynamic element (modal, dropdown) not always in DOM | Selector captured at annotation time. On import, if element not in DOM, annotation is silently skipped. |
| 10 | Pin overlaps another pin or page UI | Possible in v1. No collision detection. Future improvement candidate. |
| 11 | Annotation text reaches 400 char limit | Input is capped at 400 chars. Character counter shown in popover. |
| 12 | Export filename collision | Browser handles natively (appends `(1)`, `(2)`, etc.). No special handling needed. |
| 13 | Dynamic/SPA page (React, Vue, etc.) | Accepted v1 limitation. Multi-signal fingerprint used best-effort. If resolution fails on import, annotation silently skipped. No special warning per annotation. |

---

## 7. Out of Scope (v1)

- Real-time collaboration
- Cloud sync or backend
- Comment threads / replies
- Multiple files active simultaneously / file merging
- Mobile / non-Chrome browsers
- Video or audio annotations
- Auth / user accounts
- Annotation collision detection / auto-layout
- Keyboard shortcuts
- MutationObserver-based dynamic re-resolution (v2 candidate)
