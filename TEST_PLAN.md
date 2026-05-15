# Annotator — Manual Browser Test Plan

**Purpose:** Manual test cases for browser-based QA of the Annotator Chrome extension.
**Prerequisite:** Build the extension (`npm run build`), load it in Chrome from `dist/` via `chrome://extensions` with Developer Mode on.

---

## Test Environment Setup

1. Load the extension: `chrome://extensions` → Enable Developer Mode → Load Unpacked → select `/dist/`
2. Open a fresh Chrome window with no existing annotation data (or clear it via `chrome://extensions` → Annotator → Storage)
3. Navigate to a test site (https://example.com or any static page)

---

## 1. Basic Annotation Flow

**Objective:** Verify creating, editing, and deleting annotations.

### 1.1 Create First Annotation
1. Navigate to any webpage
2. Click the Annotator extension icon in the toolbar
3. **Expected:** Floating toolbar appears bottom-right with Start Annotating, Export (disabled), Upload, Delete All (disabled) buttons
4. Click **Start Annotating**
5. **Expected:** Toolbar shows Exit instead of Start Annotating. Hover over page elements shows magenta outline
6. Click any non-annotator element on the page
7. **Expected:** Comment popover appears near click point with empty textarea, character counter "0 / 400", and disabled Add button
8. Type a note (e.g. "This is pin 1")
9. **Expected:** Character counter updates. Add button becomes enabled
10. Click **Add**
11. **Expected:** Magenta pin labeled "1" appears at click position. Popover closes. Export button becomes enabled

### 1.2 Create Multiple Annotations
1. (Continuing from 1.1) Click another element
2. Add note "This is pin 2", click **Add**
3. **Expected:** Pin "2" appears. Pins are numbered sequentially
4. Click **Exit**
5. **Expected:** All pins disappear. Page behaves normally (links clickable)
6. Click **Start Annotating** again
7. **Expected:** Pins 1 and 2 reappear. New pin should be #3

### 1.3 Edit an Annotation
1. In annotation mode, click an existing pin
2. **Expected:** Popover opens pre-filled with the existing note. Delete button appears at bottom left
3. Modify the note text
4. Click **Add**
5. **Expected:** Note is saved. Popover closes

### 1.4 Delete an Annotation
1. In annotation mode, click an existing pin
2. Click **Delete**
3. **Expected:** Inline confirmation appears: "Delete this annotation? This cannot be undone."
4. Click **Confirm**
5. **Expected:** Pin is removed from page. If it was the last annotation, Export button disables

### 1.5 Character Counter and Limit
1. In annotation mode, click an element
2. Type exactly 400 characters
3. **Expected:** Counter shows "400 / 400". Cannot type more
4. Click **✕** to close without saving
5. **Expected:** Popover closes. No annotation created

---

## 2. Export Flow

**Objective:** Verify export file is created with correct content.

### 2.1 Basic Export
1. Create 2–3 annotations on a page
2. Click **Export**
3. **Expected:** Browser downloads `annotations-{domain}.yaml` (dots → underscores in filename)
4. Open the file in a text editor
5. **Expected:** YAML is readable; contains `version: 1`, `domain:`, `exported_at:`, and a flat `annotations:` list with pin_number, page_url, note, fingerprint, offset, created_at for each annotation

### 2.2 Export After Multi-Page Annotations
1. Annotate page A (create 2 annotations)
2. Navigate to page B (same domain), create 1 more annotation
3. Click **Export** on page B
4. **Expected:** Downloaded YAML contains all 3 annotations from both pages, ordered by pin number

### 2.3 Verify Filename Format
1. On `www.figma.com`, export annotations
2. **Expected:** Filename is `annotations-figma_com.yaml` (www stripped, dot → underscore)

---

## 3. Import Flow

**Objective:** Verify importing an exported file restores annotations.

### 3.1 Basic Import Round-Trip
1. Export annotations from step 2 above
2. Open a new tab to the same domain
3. Click the extension icon → toolbar appears
4. Click **Upload** → file picker opens
5. Select the exported YAML file
6. **Expected:**
   - Toolbar shows filename above buttons
   - Annotation mode activates automatically
   - Magenta pins appear for resolved elements on the current page
7. Navigate to another page in the domain (SPA navigation or new tab + reload)
8. Click **Start Annotating**
9. **Expected:** Pins for that page appear

### 3.2 Import with No Existing Annotations
1. Start fresh (no annotations for current domain)
2. Import a valid file
3. **Expected:** No confirmation dialog shown. Import succeeds immediately

### 3.3 Import Replaces Existing Annotations (Case #11)
1. Create 2 annotations manually
2. Click **Upload** and select a different valid YAML file for the same domain
3. **Expected:** Confirmation dialog: "Uploading this file will replace your current 2 annotation(s). This cannot be undone. Continue?"
4. Click **Confirm**
5. **Expected:** Previous annotations gone, imported ones appear

### 3.4 Pin Numbering After Import
1. Import a file with pins 1–5
2. Create a new annotation
3. **Expected:** New annotation is numbered 6 (continues from max imported pin)

---

## 4. Delete All

**Objective:** Verify Delete All with confirmation.

### 4.1 Delete All Flow
1. Create 3 annotations
2. Click **Delete All**
3. **Expected:** Confirmation dialog: "Delete all 3 annotations? This cannot be undone."
4. Click **Confirm**
5. **Expected:** All pins removed. Export button disabled. Delete All disabled. Toolbar returns to default empty state

### 4.2 Cancel Delete All
1. Create 2 annotations
2. Click **Delete All** → confirmation appears
3. Click **Cancel**
4. **Expected:** Annotations remain. No change

### 4.3 Delete All After Import Clears Filename
1. Import a file (filename shows in toolbar)
2. Click **Delete All** → Confirm
3. **Expected:** Filename indicator disappears. Toolbar shows empty state

---

## 5. Reload Persistence

**Objective:** Verify annotations survive page reloads.

### 5.1 Annotations Persist After Reload
1. Create 2 annotations on a page
2. Click **Exit** to leave annotation mode
3. Reload the page (F5 or Ctrl+R)
4. **Expected:** Toolbar reappears automatically (no need to click extension icon again)
5. Click **Start Annotating**
6. **Expected:** Both pins reappear at their correct positions

### 5.2 New Tab Requires Click
1. Open a new tab to the same domain
2. **Expected:** Toolbar does NOT appear automatically
3. Click the extension icon
4. **Expected:** Toolbar appears. Annotations (created in step 5.1) are accessible

---

## 6. SPA Navigation

**Objective:** Verify correct behavior on single-page apps.

### 6.1 SPA Navigation Test
1. Navigate to https://react.dev (or any React/SPA site)
2. Click extension icon → toolbar appears
3. Click **Start Annotating**, click an element, add a note, click **Add**
4. Click a navigation link (SPA navigation, no full reload)
5. **Expected:** Toolbar remains visible. Annotation mode is OFF after navigation. Previous page's pins hidden
6. Click **Start Annotating** on the new page
7. **Expected:** Any annotations for this page appear (none, since it's a new page)
8. Add an annotation on this page
9. Navigate back to the first page
10. **Expected:** First page's pin appears when annotation mode is activated

### 6.2 Annotation Numbering in SPA
1. Create pin 1 on page A
2. SPA-navigate to page B
3. Create a new annotation
4. **Expected:** New pin is numbered 2 (global numbering continues)

---

## 7. Cross-Tab Sync

**Objective:** Verify annotations sync across tabs.

### 7.1 Same Domain, Two Tabs
1. Open `https://example.com/page1` in Tab A
2. Open `https://example.com/page1` in Tab B
3. Activate extension in both tabs
4. In Tab A, create annotation pin 1
5. Switch to Tab B, click **Start Annotating**
6. **Expected:** Pin 1 appears in Tab B without any refresh

### 7.2 Delete in One Tab Removes in Another
1. (Continuing from 7.1) In Tab B, delete pin 1
2. Switch to Tab A, click **Start Annotating** (if needed)
3. **Expected:** Pin 1 is gone in Tab A as well

---

## 8. Import Error Cases

**Objective:** Verify each import error shows the correct message.

| # | Test | Input | Expected Error |
|---|------|-------|----------------|
| 1 | Wrong file type | Upload a `.json` file | "Invalid file type. Please upload a `.yaml` annotation file." |
| 2 | Empty file | Create a 0-byte `.yaml` file | "This file is empty. Nothing to import." |
| 3 | Malformed YAML | Upload a `.yaml` file with `{{{` | "Could not read this file — it appears to be corrupted or incorrectly formatted." |
| 4 | Wrong schema | Upload a `.yaml` with `name: test` | "This file doesn't look like an Annotator file. Please check you're uploading the right file." |
| 5 | Domain mismatch | On `example.com`, upload a file from `figma.com` | "This file contains annotations for `figma.com`, but you're currently on `example.com`." |
| 6 | Version mismatch | Upload a file with `version: 99` (future) | Yellow warning: "This file was created with a newer version of Annotator." Import still proceeds. |
| 7 | No page annotations | Import a valid file for a different page | No error. Toolbar shows filename. No pins on current page. |
| 8 | Empty annotations | Upload file with `annotations: []` | "This file exists but contains no annotations." |
| 9 | File > 8MB | Upload a large `.yaml` file | "This file is too large to import (max 8MB)." |
| 10 | Duplicate pins | Upload file with two `pin_number: 1` entries | "This file appears to be corrupted (duplicate pin numbers detected)." |

**Verify:** Each error appears in **red** above the toolbar. Warnings appear in **yellow**. Error disappears after 8 seconds.

---

## 9. Fixed-Position Elements

**Objective:** Verify pins stay anchored to fixed/sticky elements during scroll.

### 9.1 Sticky Header Annotation
1. Navigate to a page with a sticky/fixed header (e.g. any site with a `position: fixed` navbar)
2. Activate extension and start annotating
3. Click the sticky header element, add annotation
4. Scroll down the page
5. **Expected:** Pin moves with the sticky header (stays at the correct visual position on the element). It does NOT stay at a fixed viewport position while the header is off-screen — it follows the element

### 9.2 Non-Fixed Elements Scroll Away
1. Annotate a regular page element (non-fixed)
2. Scroll the page
3. **Expected:** Pin scrolls with the page content, staying attached to the element

---

## 10. Pin Numbering

**Objective:** Verify pin numbering gaps are not backfilled.

### 10.1 Gap Preservation
1. Create pins 1, 2, 3
2. Delete pin 2
3. **Expected:** Pins 1 and 3 remain
4. Create a new annotation
5. **Expected:** New pin is numbered **4** (not 2 — gap is not backfilled)

### 10.2 Import Sets Starting Pin Number
1. Import a file with pins 1, 2, 4, 7 (gaps)
2. Create a new annotation
3. **Expected:** New pin is numbered **8** (max imported pin + 1, gaps ignored)

---

## Notes

- Test on Chrome desktop only (v1 scope)
- SPA testing recommended on: react.dev, vuejs.org, or angular.io
- For cross-tab sync, open the second tab before activating the extension to ensure storage observer is registered
- All errors should appear in toolbar notification area above the buttons (never browser `alert()`)
- Pin position should recalculate correctly on window resize (resize browser window and verify pins reposition)
