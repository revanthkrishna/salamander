# Annotator — Requirements

> Chrome extension for inline web annotations. Annotate any webpage on any website, export as a file, share with others who can import and view the same annotations.

---

## Status: 🟡 Draft — In Progress

---

## 1. Functional Requirements

### 1.1 Annotating
- [ ] User can activate annotation mode on any webpage via the extension
- [ ] User can click any element on the page to select it
- [ ] User can attach a text note to the selected element
- [ ] User can edit an existing annotation
- [ ] User can delete an existing annotation
- [ ] Annotations persist across page reloads (within the same session/browser)
- [ ] Annotations are numbered globally and continuously across all pages of a domain (e.g. pins 1–3 on page A, pins 4–6 on page B)
- [ ] Annotation numbering continues from the last used number even across page navigations

### 1.2 Element Targeting (How Annotations Attach to Elements)

This is critical for annotations to re-appear correctly when a file is imported on another machine.

When an annotation is placed, the extension captures a **multi-signal fingerprint** of the target element:

- **Primary:** CSS selector path (using id, stable class names, tag, and positional index)
- **Secondary:** XPath of the element
- **Tertiary:** Text content snippet (first ~50 chars of the element's text, if any)
- **Metadata:** Tag name, bounding box position (as a hint, not primary key)

On import, the extension attempts to locate each element in order:
1. Try CSS selector — if found and unique, use it
2. Try XPath — if found, use it
3. Try text content match — find element with matching tag + text
4. If none match: mark annotation as **unresolved** (see §3.3 Import Error States)

**Known limitation:** Highly dynamic pages (React/SPA apps with auto-generated class names or no stable IDs) may produce fragile selectors. Annotations on such elements may fail to resolve on re-import. This is a known v1 limitation and should be surfaced to the user.

### 1.3 Exporting
- [ ] User can export all annotations across all pages of the current domain as a single file
- [ ] Export is only enabled when at least one annotation exists
- [ ] Export file format: YAML
- [ ] Default filename: `{domain}-annotations.yaml` (e.g. `figma.com-annotations.yaml`)
- [ ] Export file includes: website domain, per-page URL, element fingerprint (CSS selector, XPath, text snippet), annotation text, pin number, timestamp

### 1.4 Importing
- [ ] User can import an annotation file via a file picker
- [ ] Extension applies annotations to the correct elements on the current page (and stores the rest for other pages in the domain)
- [ ] Only one file can be active at a time — importing a new file replaces the current state entirely
- [ ] The toolbar displays the active filename to indicate a file is loaded
- [ ] If the user edits, adds, or deletes any annotation after importing, the filename indicator is removed (unsaved changes state)
- [ ] Graceful, specific error handling for all import failure cases (see §5)

### 1.5 Managing Annotations
- [ ] User can view a list of all annotations for the current page in the extension panel
- [ ] User can delete an individual annotation

---

## 2. Non-Functional Requirements

- Works on any public webpage
- No backend / server required — fully local and file-based in v1
- Annotation file is human-readable (YAML)
- Import is fault-tolerant — shows specific errors, never crashes
- Annotations render without breaking or obscuring page layout
- Clicking an annotated element in annotation mode does not trigger the page's native click behavior
- Fast — annotation interactions feel instant (no lag)
- Chrome desktop only (v1)

---

## 3. UX / UI Requirements

### 3.1 Annotation Mode
- [ ] Entering annotation mode: all native element click behaviors are suppressed
- [ ] Hovering over an element highlights it with a visible outline to indicate it is selectable
- [ ] Clicking an element opens a comment popover anchored near the click point (Figma-style)
- [ ] Popover contains: text input + "Add" button + cancel/close option
- [ ] Clicking "Add" saves the annotation and closes the popover
- [ ] Pressing Escape cancels the annotation without saving

### 3.2 Annotation Display
- [ ] Annotations are shown as round magenta/pink pins
- [ ] Each pin displays its annotation number
- [ ] Pins are anchored to the annotated element (top-left corner or closest visible edge)
- [ ] Clicking a pin (outside of annotation mode) shows the annotation text in a tooltip or popover
- [ ] Pins do not obscure critical page content where avoidable

### 3.3 Floating Toolbar
- [ ] A floating toolbar appears in the bottom-right corner of the page when the extension is active
- [ ] Toolbar buttons: **Start Annotating** | **Export** | **Upload**
- [ ] When in annotation mode: toolbar shows **Exit** button instead of Start Annotating; Export button remains
- [ ] Export button is disabled (greyed out) when there are no annotations; enabled when at least one exists
- [ ] When a file is loaded via import: toolbar displays the filename below or beside the buttons
- [ ] When annotations are modified after import: filename indicator disappears

### 3.4 Keyboard Shortcuts
- [ ] `Esc` — cancel an in-progress annotation popover
- [ ] Additional shortcuts: TBD

---

## 4. User Journeys

### Journey 1 — Creating and Exporting Annotations

1. User opens any website in Chrome
2. User clicks the Extensions icon (puzzle piece, top right) and opens **Annotator**
3. If the extension hasn't been granted permission to run on this page, it prompts for it
4. Once permitted, a floating toolbar appears in the bottom-right corner with three buttons: **Start Annotating**, **Export** (disabled), **Upload**
5. User clicks **Start Annotating** — annotation mode activates
   - Toolbar updates to show **Exit** and **Export** (still disabled until first annotation)
   - Hovering over page elements highlights them with an outline
   - Native click behavior on all elements is suppressed
6. User clicks an element → a comment popover appears near the click point
7. User types their note and clicks **Add**
   - A round magenta pin numbered **1** appears anchored to that element
   - Export button becomes enabled
8. User continues annotating more elements → pins are numbered sequentially (2, 3, 4…)
9. User clicks **Exit** — leaves annotation mode. Pins remain visible. Page returns to normal behavior.
10. User navigates to another page on the same domain
    - The toolbar reappears. Annotations from the previous page are not shown here (they're stored)
    - Pin numbering continues from where it left off (e.g. starts at 5)
11. User annotates more elements on this page
12. User clicks **Export** → browser downloads `{domain}-annotations.yaml` containing all annotations across all pages visited

### Journey 2 — Viewing Shared Annotations

1. User opens the same website in Chrome
2. User opens **Annotator** from the Extensions menu
3. Permission is requested if not already granted
4. Floating toolbar appears with **Start Annotating**, **Export** (disabled), **Upload**
5. User clicks **Upload** → native file picker opens
6. User selects the `.yaml` annotation file received from the first user
7. Extension validates and loads the file:
   - Toolbar displays the filename (e.g. `figma.com-annotations.yaml`) as an indicator
   - Annotations for the current page are applied — magenta pins appear on their respective elements
   - Annotations for other pages in the domain are stored and will appear when the user visits those pages
8. User can browse the site and see annotations appear on each relevant page
9. User can add, edit, or delete annotations
   - As soon as any change is made, the filename indicator disappears (indicating unsaved/modified state)
10. User can export the modified annotation set as a new file

---

## 5. Import Error Handling

All errors must be surfaced clearly in the UI — never silent failures, never crashes.

| # | Error Case | Suggested Behavior |
|---|------------|-------------------|
| 1 | Wrong file type (not `.yaml` or `.yml`) | Show inline error: "Invalid file type. Please upload a `.yaml` annotation file." File is rejected. |
| 2 | File is empty | Show error: "This file is empty. Nothing to import." |
| 3 | File is not valid YAML (corrupted or malformed) | Show error: "Could not read this file — it appears to be corrupted or incorrectly formatted." |
| 4 | Valid YAML but wrong schema (missing required fields) | Show error: "This file doesn't look like an Annotator file. Please check you're uploading the right file." |
| 5 | File version mismatch (future-proofing) | Show warning: "This file was created with a newer version of Annotator. Some annotations may not display correctly." Allow import. |
| 6 | Domain mismatch — file was exported from a completely different website | Show warning: "This file contains annotations for `{other-domain}`, but you're on `{current-domain}`. Import anyway?" — with confirm/cancel. |
| 7 | Domain matches but no annotations apply to the current page | Import succeeds silently. Toolbar shows filename. No pins appear. If user navigates to a matching page, pins appear there. |
| 8 | File has annotations but zero elements could be resolved on the current page | Show warning: "Annotations were loaded, but we couldn't find the annotated elements on this page. The page may have changed since this file was created." |
| 9 | File partially resolves — some elements found, some not | Show warning: "X of Y annotations could not be placed — the page may have changed. Resolved annotations are shown." Unresolved annotations appear in the panel as a list with a warning icon. |
| 10 | File has no annotations (empty annotations list) | Show message: "This file exists but contains no annotations." |
| 11 | User already has annotations and uploads a file | Show confirmation dialog: "Uploading a file will replace your current X annotation(s). Continue?" — with confirm/cancel. |

---

## 6. Edge Cases & Open Questions

### Interaction Edge Cases

| # | Scenario | Expected Behavior / Decision Needed |
|---|----------|-------------------------------------|
| 1 | User has existing annotations → uploads a file | Confirm dialog warns that current annotations will be replaced (see §5, #11). If confirmed, current annotations are wiped and file annotations are loaded. |
| 2 | User uploads a file → makes changes → tries to upload another file | Confirm dialog: "You have unsaved changes. Uploading a new file will discard them. Continue?" |
| 3 | User uploads a file → clicks Export | The exported file contains all annotations (from the file + any new ones added). The original file is not overwritten — a new download is triggered. |
| 4 | User annotates page A (pins 1–3) → deletes pin 2 → continues annotating | Does the next pin become 2 (backfill) or 4 (continue)? **Decision needed.** Recommendation: continue from highest number (no backfill) to avoid confusion. |
| 5 | User annotates the same element twice | Two separate pins on the same element, both valid. No restriction. |
| 6 | User tries to annotate inside an `<iframe>` | Out of scope v1. Iframes are not selectable. Hovering over an iframe does not highlight it. |
| 7 | Page URL includes query params or fragments (e.g. `?tab=2` or `#section`) | The full URL including params/fragments is stored. On import, exact URL match is attempted first; if none, a fuzzy match on base URL is attempted. **Decision needed on fuzzy matching rules.** |
| 8 | HTTP vs HTTPS same page | Treated as different URLs. Recommend normalizing to HTTPS where possible. |
| 9 | User annotates a dynamic element (e.g. a modal or dropdown that's only sometimes visible) | Selector is captured at annotation time. On import, if the element isn't in the DOM, annotation is marked unresolved. It is not re-attempted dynamically. |
| 10 | Annotation pin overlaps another pin or important UI | Pins are rendered at the element's top-left corner. Overlap is possible. No collision detection in v1. **Possible future improvement.** |
| 11 | Very long annotation text | Text in the popover should be scrollable. Pin tooltip should truncate with a "read more" or show full text in a popover. **Decision needed on display max-length.** |
| 12 | Export filename collision (user exports twice) | Browser handles it natively (appends `(1)`, `(2)`, etc.). No special handling needed. |

### Dynamic Pages (SPA / React) — Deeper Discussion Needed

Pages built with React, Vue, or similar frameworks pose a challenge because:
- Class names are often auto-generated and change between deployments (e.g. `.css-1a2b3c`)
- Elements may not exist in the DOM at page load — they render asynchronously
- The same logical "element" may have a completely different DOM path after a re-render

**Current approach (v1):** Best-effort multi-signal fingerprint (CSS selector + XPath + text content). This works well for static or server-rendered pages. For SPAs, accuracy degrades.

**Options to consider:**
- **Option A:** Accept degraded accuracy as a v1 known limitation. Show a warning on import if resolution rate is low.
- **Option B:** Prefer `id` and `data-*` attributes heavily in selector generation — more stable across re-renders.
- **Option C:** Use a MutationObserver to watch for elements appearing after load and re-attempt resolution.

**Recommendation:** Ship Option B as default behavior (prefer stable attributes), with Option A as the fallback UX. Option C is a v2 candidate.

**Decision needed:** Accept this recommendation or discuss further?

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
- MutationObserver-based dynamic re-resolution (v2 candidate)
