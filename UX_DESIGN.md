# Annotator — UX Design Specification

> **Status:** Complete
> **Version:** 2.0
> **Author:** Phase 1A UX Designer (rev. 2026-05-16)
> **Audience:** Engineers implementing the Annotator Chrome extension
> **Source of truth:** REQUIREMENTS.md (do not modify). TECH_DESIGN.md governs implementation details.

Every value in this document is a specific number, color hex, or literal string. If you see a vague word like "appropriate" or "some padding," treat it as a bug in this document and ask for clarification.

---

## Style Guidelines

### Lowercase Everywhere
**All visible text in the UI must be lowercase — no exceptions.**
This applies to:
- All button labels (e.g. `save`, `delete`, `export`, `import`)
- All placeholder text (e.g. `type something...`)
- All error, warning, and status messages
- All browser `alert()`, `confirm()`, and `prompt()` text
- All tooltips
- Filenames displayed in the UI (display as-is — do not transform)

The only exception is filenames, which are rendered as-is from the file system. All other copy is lowercase.

---

## Table of Contents

1. [Design Tokens / Variables](#1-design-tokens--variables)
2. [S Button (Idle State)](#2-s-button-idle-state)
3. [Floating Toolbar (Annotation Mode)](#3-floating-toolbar-annotation-mode)
   - 3.1 [Toolbar Layout](#31-toolbar-layout)
   - 3.2 [Filename Bar](#32-filename-bar)
   - 3.3 [Warning / Error Area](#33-warning--error-area)
   - 3.4 [Icon Button Row](#34-icon-button-row)
   - 3.5 [Toolbar States](#35-toolbar-states)
4. [Annotation Mode Hover Highlight](#4-annotation-mode-hover-highlight)
5. [Annotation Pins](#5-annotation-pins)
6. [Annotation Popover](#6-annotation-popover)
   - 6.1 [Layout](#61-layout)
   - 6.2 [New Annotation State (CREATE)](#62-new-annotation-state-create)
   - 6.3 [Existing Annotation State (EDIT)](#63-existing-annotation-state-edit)
   - 6.4 [Popover Positioning (Overflow Handling)](#64-popover-positioning-overflow-handling)
7. [Import / Export Behavior](#7-import--export-behavior)
8. [Error & Warning Messages](#8-error--warning-messages)
9. [Interaction Flows](#9-interaction-flows)
10. [Accessibility Notes](#10-accessibility-notes)
11. [Implementation Notes for Engineers](#11-implementation-notes-for-engineers)

---

## 1. Design Tokens / Variables

All values are the canonical source. Use CSS custom properties (see §11) throughout implementation.

### Colors

| Token | Value | Usage |
|-------|-------|-------|
| `--annotator-accent` | `#FEC800` | Hover state: icon/text color on all buttons |
| `--annotator-error` | `#FB645A` | Error bar text and icon tint |
| `--annotator-warning` | `#D6AE7C` | Warning bar text and icon tint |
| `--annotator-bg-toolbar` | `#000000` | Toolbar, S button, popover footer, filename/warning bars |
| `--annotator-bg-popover` | `#3E3E3E` | Popover textarea area background |
| `--annotator-text-primary` | `#FFFFFF` | Icons, button text (default state) |
| `--annotator-text-secondary` | `#B7B7B7` | Filename text and clip icon |
| `--annotator-text-placeholder` | `#D1D1D1` | Popover textarea placeholder color |
| `--annotator-pin-bg` | `#FEC800` | Pin background |
| `--annotator-pin-border` | `#000000` | Pin border (1px solid) |
| `--annotator-pin-text` | `#000000` | Pin number text |

### Typography

| Property | Value |
|----------|-------|
| Font family | `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif` |
| No web fonts | True — zero network requests for fonts |
| Base font size | `13px` |
| Pin number font size | `11px` |
| Pin number font weight | `700` (bold) |
| Button font weight | `500` (medium) |

### Dimensions

| Token | Value | Usage |
|-------|-------|-------|
| `--annotator-s-btn-size` | `56px` | S button width and height |
| `--annotator-toolbar-margin` | `16px` | Distance from viewport right and bottom edges |
| `--annotator-icon-btn-size` | `56px` | Each icon button width and height in toolbar |
| `--annotator-toolbar-total-width` | `224px` | Total toolbar width (4 × 56px) |
| `--annotator-filename-bar-height` | `35px` | Filename bar height |
| `--annotator-warning-bar-height` | `44px` | Warning bar height |
| `--annotator-error-bar-height` | `32px` | Error bar height |
| `--annotator-pin-height` | `14px` | Pin height |
| `--annotator-pin-min-width` | `14px` | Pin minimum width (expands for multi-digit) |
| `--annotator-pin-padding` | `0 2px` | Pin horizontal padding |
| `--annotator-popover-width` | `300px` | Fixed popover width |
| `--annotator-popover-textarea-height` | `79px` | Popover textarea section height |
| `--annotator-popover-footer-height` | `40px` | Popover footer bar height |
| `--annotator-popover-margin` | `8px` | Gap between pin edge and popover edge |
| `--annotator-radius-large` | `16px` | S button, toolbar end caps, popover corners |
| `--annotator-radius-pin` | `30px` | Pin border radius (pill shape for all) |

### Shadows

All shadow values use `filter: drop-shadow(...)` (not `box-shadow`) so they correctly follow non-rectangular shapes like the pill toolbar.

| Element | Shadow value |
|---------|-------------|
| S button | `filter: drop-shadow(0px 0px 8px rgba(0, 0, 0, 0.25))` |
| Toolbar | `filter: drop-shadow(0px 0px 8px rgba(0, 0, 0, 0.25))` |
| Popover | `filter: drop-shadow(0px 0px 8px rgba(0, 0, 0, 0.25))` |
| Pin | `box-shadow: 0 1px 3px rgba(0, 0, 0, 0.40)` (box-shadow is fine for pill shape) |

### Z-Indexes

| Layer | Z-index |
|-------|---------|
| Pins | `2147483640` |
| S Button / Toolbar | `2147483644` |
| Popover | `2147483646` |

---

## 2. S Button (Idle State)

The S button is the extension's resting state — visible when annotation mode is **off**.

**Appearance:**
- Shape: rounded square
- Size: `44px × 44px`
- Border-radius: `12px`
- Background: `rgba(18, 18, 18, 0.97)`
- Box-shadow: `0 4px 24px rgba(0,0,0,0.40), 0 1px 6px rgba(0,0,0,0.30)`
- Z-index: `2147483644`

**Label:**
- Text: `S`
- Font size: `18px`
- Font weight: `700`
- Color: `#FFFFFF`
- Centered (`display: flex; align-items: center; justify-content: center`)

**Position:**
- `position: fixed; bottom: 16px; right: 16px`

**Hover state:**
- Background: `rgba(40, 40, 40, 0.97)` (slightly lighter)
- Cursor: `pointer`

**Behavior:**
- Clicking the S button starts annotation mode and replaces it with the floating toolbar.
- The S button is `display: none` when the toolbar is visible.
- The toolbar is `display: none` when the S button is visible.
- They share the same fixed position — only one is shown at a time.

---

## 3. Floating Toolbar (Annotation Mode)

The toolbar is visible when annotation mode is **on**. It replaces the S button in the same bottom-right position.

The toolbar lives in a Shadow DOM host (`<div id="annotator-host">`). All CSS is scoped inside the shadow root.

### 3.1 Toolbar Layout

**Position:** `position: fixed; bottom: 16px; right: 16px`
**Background:** `rgba(18, 18, 18, 0.97)`
**Border-radius:** `12px`
**Box-shadow:** `0 4px 24px rgba(0,0,0,0.40), 0 1px 6px rgba(0,0,0,0.30)`
**Z-index:** `2147483644`
**Width:** auto (fits content)
**Overflow:** `hidden`

**Internal section order (top to bottom):**

1. **Filename bar** — optional, shown when a file is loaded
2. **Warning / Error area** — optional, shown when there's a message
3. **Icon button row** — always visible

Each section is `display: none` when not applicable. A `1px` divider (`rgba(255,255,255,0.10)`) separates visible sections.

---

### 3.2 Filename Bar

Shown when a file has been successfully imported.

**Layout:** `display: flex; align-items: center; justify-content: space-between`
**Padding:** `8px 12px`
**Border-bottom:** `1px solid rgba(255,255,255,0.10)`

**Filename text:**
- Font size: `11px`
- Color: `rgba(255,255,255,0.60)`
- Max-width: truncate with `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`
- Prefix: `📎 ` (paperclip emoji + space) before the filename, via `textContent`

**Dismiss button (✕):**
- Size: `16px × 16px`
- Icon: `✕` or `×`
- Color: `rgba(255,255,255,0.50)`
- Hover: color `#FFFFFF`
- Background: transparent
- Cursor: `pointer`
- `aria-label="remove file"`
- `flex-shrink: 0; margin-left: 8px`

**Behavior on dismiss:**
- Removes the imported file reference
- **Also removes all annotations** that were loaded from that file
- Toolbar transitions to TOOLBAR_EMPTY state
- Filename bar hides

---

### 3.3 Warning / Error Area

Shown when there is an active warning or error message.

**Padding:** `8px 12px`
**Font size:** `12px`
**Font weight:** `400`
**Line height:** `1.4`
**Border-bottom:** `1px solid rgba(255,255,255,0.10)` when visible

**Color by type:**
- Error: `#F44336`
- Warning: `#FF9800`

**Persistence:** Messages in this area are **persistent** — they do not auto-clear. They are replaced only when a new message is set, or when the relevant state is resolved (e.g. file is dismissed).

This area is used for import resolution alerts (e.g. `16 of 17 annotations could not be placed on this page`) and file-level errors (e.g. `file is corrupted`).

See §8 for the full list of message cases and exact copy.

---

### 3.4 Icon Button Row

The row of 4 action icon buttons, always visible when the toolbar is shown.

**Layout:** `display: flex; flex-direction: row; align-items: center; padding: 6px; gap: 4px`
**Background:** inherits toolbar background

**Button order (left to right):**
1. **Export** (⬇ download icon)
2. **Import / Upload** (⬆ upload icon)
3. **Delete All** (🗑 trash icon)
4. **Exit** (✕ close icon)

**Each icon button:**
- Size: `40px × 40px`
- Border-radius: `8px`
- Background: `transparent`
- Color: `#FFFFFF`
- Hover background: `rgba(255, 255, 255, 0.12)`
- Cursor: `pointer`
- `display: flex; align-items: center; justify-content: center`
- Tooltip (`title` attribute): lowercase label — `export`, `import`, `delete all`, `exit`

**Button behaviors:**

| Button | Behavior |
|--------|----------|
| Export | Always enabled. If no annotations exist → `alert("nothing to export")`. Otherwise → download YAML immediately. |
| Import | Always enabled. Opens native file picker. See §9.1 for import flow. |
| Delete All | If no annotations exist → do nothing (no alert, no feedback). If annotations exist → `confirm("delete all [n] annotation[s]? this cannot be undone.")`. Confirmed → delete all, toolbar goes to TOOLBAR_EMPTY. |
| Exit | Always enabled. Exits annotation mode → hides toolbar, shows S button. Annotations remain. |

**No disabled states.** All 4 buttons are always enabled (export and delete handle the empty case programmatically).

---

### 3.5 Toolbar States

States describe what sections are visible in the toolbar. Button row is always visible in all states.

---

#### TOOLBAR_EMPTY
**Trigger:** Annotation mode active, no annotations, no file loaded.

| Section | Visible? |
|---------|----------|
| Filename bar | No |
| Warning / Error area | No |
| Icon button row | Yes |

---

#### TOOLBAR_HAS_ANNOTATIONS
**Trigger:** Annotation mode active, annotations exist, no file loaded.

| Section | Visible? |
|---------|----------|
| Filename bar | No |
| Warning / Error area | No |
| Icon button row | Yes |

---

#### TOOLBAR_FILE_LOADED
**Trigger:** File successfully imported.

| Section | Visible? | Content |
|---------|----------|---------|
| Filename bar | Yes | `📎 [filename]` with ✕ button |
| Warning / Error area | Conditional | Only if some/all annotations couldn't be placed on current page |
| Icon button row | Yes | — |

---

#### TOOLBAR_FILE_LOAD_ERROR
**Trigger:** File import failed, or file was valid but had resolution issues.

| Section | Visible? | Content |
|---------|----------|---------|
| Filename bar | Conditional | Shown if a file was previously loaded |
| Warning / Error area | Yes | Error or warning message text |
| Icon button row | Yes | — |

---

## 4. Annotation Mode Hover Highlight

When annotation mode is active (toolbar is visible) and the user hovers over a page element:

- **Outline:** `2px solid #FFC107`
- **Outline-offset:** `2px`
- **Cursor:** `crosshair`
- **No background dim.** Only the outline is applied.
- **Box-sizing:** `border-box !important` (prevent layout shift)

Iframes are **not highlighted** on hover (out of scope per REQUIREMENTS.md §6).

When the popover is open, hover highlighting is **suspended** — no outline changes while the popover is visible.

CSS injected into the page (not Shadow DOM):
```css
.annotator-highlighted {
  outline: 2px solid #FFC107 !important;
  outline-offset: 2px !important;
  cursor: crosshair !important;
  box-sizing: border-box !important;
}
```

---

## 5. Annotation Pins

### Shape & Appearance

Pins are **always visible** regardless of whether annotation mode is on or off. They are removed only when explicitly deleted.

**Single-digit numbers (1–9):**
- Shape: circle
- Size: `24px × 24px`
- Border-radius: `50%`
- Background: `#FFC107`
- Box-shadow: `0 2px 6px rgba(0,0,0,0.50), 0 1px 2px rgba(0,0,0,0.30)`

**Multi-digit numbers (10+):**
- Shape: pill (width expands to fit)
- Height: `24px`
- Min-width: `24px`
- Padding: `0 6px`
- Border-radius: `12px` (half of height — full pill)
- Background: `#FFC107`
- Box-shadow: same as above

**No border** on pins.

### Number Label

| Property | Value |
|----------|-------|
| Font size | `11px` |
| Font weight | `700` |
| Color | `#000000` |
| Text align | `center` |
| Vertical align | `display: flex; align-items: center; justify-content: center` |
| User-select | `none` |
| White-space | `nowrap` |

### Interactivity

- **Annotation mode OFF (S button shown):** Pins are visible but **not clickable** (`pointer-events: none`).
- **Annotation mode ON (toolbar shown):** Pins are visible and **clickable** (`pointer-events: auto`, `cursor: pointer`). Clicking opens the EDIT popover.

```css
/* default: always visible */
.annotator-pin {
  pointer-events: none;
}

/* in annotation mode: clickable */
body.annotator-active .annotator-pin {
  pointer-events: auto !important;
  cursor: pointer !important;
}
```

### Animation on Pin Appearance

```css
@keyframes annotator-pin-appear {
  from { transform: scale(0.5); opacity: 0; }
  to   { transform: scale(1);   opacity: 1; }
}
.annotator-pin {
  animation: annotator-pin-appear 150ms ease-out;
}
```

---

## 6. Annotation Popover

The popover is a Shadow DOM host (`<div id="annotator-popover-host">`). It has two states: CREATE (new annotation) and EDIT (existing annotation).

### 6.1 Layout

**Dimensions:**
- Width: `280px` (fixed)
- Height: auto (textarea is fixed height)

**Appearance:**
- Border-radius: `12px`
- Box-shadow: `0 8px 32px rgba(0,0,0,0.50), 0 2px 8px rgba(0,0,0,0.30)`
- Z-index: `2147483646`
- Position: `fixed`
- Overflow: `hidden` (border-radius clips footer)

**Internal structure:**

```
┌──────────────────────────────────────┐
│  textarea area (dark bg)              │  — grows with content (min: 80px)
│  placeholder: "type something..."     │
│──────────────────────────────────────│
│  footer bar (darker/black bg)         │  — 44px tall
│  [✕ cancel]   [🗑 delete]   [✓ save] │
└──────────────────────────────────────┘
```

**Pin number badge:**
A small pin badge (same style as annotation pins, §5) is shown anchored to the top-left corner of the popover, overlapping the border. It indicates which pin number this popover belongs to.
- Offset: `-8px` from top-left corner of popover (`position: absolute; top: -8px; left: -8px`)
- Z-index: above popover

---

**Textarea area:**
- Background: `rgba(36, 36, 38, 0.98)`
- Padding: `12px`
- Width: `100%` (fills popover width)

**Textarea element:**
- Width: `100%`
- Min-height: `80px`
- Height: auto (grows with content, up to a max)
- Max-height: `160px`
- Overflow-y: `auto` (scroll when content exceeds max-height)
- Resize: `none`
- Background: `transparent`
- Border: `none`
- Outline: `none`
- Font size: `13px`
- Color: `#FFFFFF`
- Placeholder: `type something...` (all lowercase)
- Placeholder color: `rgba(255, 255, 255, 0.35)`
- `maxlength="400"`
- `spellcheck="true"`

**Footer bar:**
- Background: `rgba(18, 18, 18, 1.00)`
- Height: `44px`
- Padding: `0 12px`
- `display: flex; align-items: center; justify-content: space-between`

---

### 6.2 New Annotation State (CREATE)

**Trigger:** User clicked a non-annotated element in annotation mode.

**Footer contents:**

| Position | Element | Details |
|----------|---------|---------|
| Left | ✕ cancel button | Icon or text `✕` |
| After left buttons | character counter | Hidden when count < 350. Shows `"[n] / 400"` at ≥350, turns `#FB645A` at ≥380 |
| Right | ✓ save button | Enabled only when textarea has ≥ 1 non-whitespace character |

**Character counter:** lives in the footer bar between the left-side buttons (cancel/delete) and the spacer. `display: none` when count < 350; visible at 350+. Color `rgba(255,255,255,0.60)` at 350–379, `#FB645A` at 380+.

**Delete button:** hidden (not rendered)

**Cancel behavior:**
- Closes popover
- **Removes the pin** that was just placed
- Returns to annotation mode (hover highlighting resumes)

**Save behavior:**
- Saves annotation to storage
- Closes popover
- Pin remains on the page
- Returns to annotation mode

**Save button states:**

| State | Background | Color | Condition |
|-------|------------|-------|-----------|
| Disabled | `rgba(255, 255, 255, 0.08)` | `rgba(255, 255, 255, 0.38)` | Textarea empty or whitespace-only |
| Enabled | `#FFC107` | `#000000` | ≥ 1 non-whitespace character |
| Hover (enabled) | `#e6ac00` (10% darker) | `#000000` | — |

**Save button dimensions:**
- Height: `28px`
- Padding: `0 12px`
- Border-radius: `6px`
- Font size: `13px`
- Font weight: `500`
- Label: `✓ save` (checkmark + space + lowercase "save")

**Cancel button:**
- Label: `✕`
- Background: transparent
- Color: `rgba(255, 255, 255, 0.60)`
- Hover: color `#FFFFFF`
- Size: `28px × 28px`
- Border-radius: `50%`
- `aria-label="cancel"`

---

### 6.3 Existing Annotation State (EDIT)

**Trigger:** User clicked an existing pin in annotation mode.

**Footer contents:**

| Position | Element | Details |
|----------|---------|---------|
| Left | ✕ cancel button | Same style as CREATE state |
| Center | 🗑 delete button | Icon-only, destructive |
| Right | ✓ save button | Enabled (pre-filled text is non-empty) |

**Textarea:** pre-filled with existing annotation text. Cursor at end. Focused immediately.

**Cancel behavior:** Closes popover, no changes saved.

**Delete button:**
- Icon: trash icon (`🗑` or SVG)
- Background: transparent
- Color: `#F44336`
- Hover background: `rgba(244, 67, 54, 0.15)`
- Size: `28px × 28px`
- Border-radius: `50%`
- `aria-label="delete annotation"`

**Delete behavior:**
- No inline confirmation, no separate modal
- Immediately deletes the annotation from storage
- Removes the pin from the page
- Closes the popover
- Renumbers remaining pins sequentially

**Save button:** same style as CREATE state, always enabled in EDIT state (pre-filled content is non-empty).

**Save behavior:** Updates annotation in storage, closes popover, pin remains.

---

### 6.4 Popover Positioning (Overflow Handling)

The MARGIN constant (gap between pin edge and popover edge) is `8px`.
Pin diameter: `24px`.
Popover width: `280px`.

Four candidate positions, attempted in this order:

| Priority | Position | `left` | `top` |
|----------|----------|--------|-------|
| 1 (default) | Bottom-right of pin | `pinX + 24 + 8` | `pinY` |
| 2 | Top-right of pin | `pinX + 24 + 8` | `pinY - popoverH + 24` |
| 3 | Top-left of pin | `pinX - 280 - 8` | `pinY - popoverH + 24` |
| 4 | Bottom-left of pin | `pinX - 280 - 8` | `pinY` |

Where `pinX` / `pinY` = top-left of pin in viewport coords (from `getBoundingClientRect()`).
`popoverH` = `popoverHost.offsetHeight` after first render, or `160` as fallback.

A position is **valid** when:
- `left >= 0` and `left + 280 <= window.innerWidth`
- `top >= 0` and `top + popoverH <= window.innerHeight`

Use the first valid candidate. If all four overflow, fall back to candidate 1.

---

## 7. Import / Export Behavior

### Export
- Always enabled (button is never disabled)
- If no annotations exist: `alert("nothing to export")`
- Otherwise: triggers download of `annotations-{domain}.yaml` immediately
- No loading state, no success message

### Import
- Always enabled
- Opens native file picker: `<input type="file" accept=".yaml,.yml">`
- On file selection: runs validation pipeline (see §8)
- **If user has existing annotations:** `confirm("importing this file will replace your [n] annotation[s]. this cannot be undone. continue?")`
  - Confirmed → proceed with import, replace all annotations
  - Cancelled → abort, reset file input

### File Removal (dismiss ✕ on filename bar)
- Removes the imported file reference
- **Also removes all annotations** loaded from that file
- Toolbar transitions to TOOLBAR_EMPTY state
- No confirmation dialog required

---

## 8. Error & Warning Messages

Messages appear in the **Warning / Error Area** (§3.3) of the toolbar. They are persistent until resolved.

All message copy is **lowercase** (per style guidelines).

### Import Validation Messages

| # | Case | Type | Exact Copy |
|---|------|------|------------|
| 1 | Wrong file type | ❌ Error | `invalid file type. please upload a .yaml annotation file.` |
| 2 | File is empty | ❌ Error | `this file is empty. nothing to import.` |
| 3 | File is not valid YAML | ❌ Error | `could not read this file — it appears to be corrupted or incorrectly formatted.` |
| 4 | Valid YAML, wrong schema | ❌ Error | `this file doesn't look like an annotator file. please check you're uploading the right file.` |
| 5 | Domain mismatch | ❌ Error | `this file contains annotations for "{fileDomain}", but you're currently on "{currentDomain}".` |
| 6 | Version mismatch (newer file) | ⚠️ Warning | `this file was created with a newer version of annotator. some annotations may not display correctly.` |
| 7 | File has no annotations | ❌ Error | `this file exists but contains no annotations.` |
| 8 | File exceeds 8MB | ❌ Error | `this file is too large to import (max 8mb).` |
| 9 | Duplicate pin numbers in file | ❌ Error | `this file appears to be corrupted (duplicate pin numbers detected).` |

### Import Resolution Messages (post-import, per page)

Shown after successful import when some/all annotations couldn't be placed on the current page.

| Scenario | Type | Exact Copy |
|----------|------|------------|
| Some couldn't be placed | ⚠️ Warning | `[x] of [y] annotations could not be placed on this page.` |
| None could be placed | ❌ Error | `none of the annotations could be placed on this page.` |
| All resolved | *(hidden)* | — |

These are recalculated on every SPA navigation.

### Confirmation Dialogs (browser `confirm()`)

Use native browser `confirm()` for destructive confirmations. All copy is lowercase.

| Case | Copy |
|------|------|
| Delete all annotations | `delete all [n] annotation[s]? this cannot be undone.` |
| Import replaces existing | `importing this file will replace your [n] annotation[s]. this cannot be undone. continue?` |

Where `[n]` = integer count and `[s]` = `s` when n ≠ 1.

Singular: `delete all 1 annotation? this cannot be undone.`
Plural: `delete all 3 annotations? this cannot be undone.`

---

## 9. Interaction Flows

### 9.1 Extension Activation Flow

1. User clicks the extension icon in Chrome's toolbar → the **S button** appears at bottom-right of the page.
2. User clicks the S button → annotation mode activates, S button is replaced by the floating toolbar.
3. Hover highlights are activated. User can now click elements to annotate.
4. User clicks **✕ exit** in toolbar → annotation mode deactivates, toolbar is replaced by S button. Annotations and pins remain.

### 9.2 Annotation Create Flow

1. In annotation mode, user hovers an element → yellow outline appears (`2px solid #FFC107`).
2. User clicks the element:
   - Click suppressed (capturing-phase listener)
   - Hover outline cleared
   - Pin placed at click point with next sequential number, pop-in animation (`150ms ease-out`)
   - Popover opens in CREATE state, positioned at best valid candidate (§6.4)
   - Textarea is focused immediately (`requestAnimationFrame(() => textarea.focus())`)
3. User types their note → save button becomes enabled at ≥ 1 non-whitespace character.
4. User clicks **✓ save**:
   - Annotation saved to `chrome.storage.local`
   - Popover closes
   - User remains in annotation mode
5. User clicks **✕ cancel** (or clicks outside popover):
   - Popover closes
   - **Pin is removed** (since it was not saved)
   - User remains in annotation mode

### 9.3 Annotation Edit Flow

1. In annotation mode, user clicks an existing pin.
2. Popover opens in EDIT state, pre-filled with annotation text, cursor at end.
3. Options:
   - **Save:** updates annotation, closes popover
   - **Delete:** immediately deletes annotation + removes pin, closes popover (no confirmation)
   - **Cancel / click outside:** closes popover, no changes

### 9.4 Import Flow

1. User clicks **⬆ import** → hidden `<input type="file" accept=".yaml,.yml">` is clicked, native file picker opens.
2. User selects a file → validation runs.
3. **If existing annotations:** `confirm()` dialog shown (see §8). User must confirm to continue.
4. **Validation error:** error message shown in warning/error area. File input reset.
5. **Success:** filename bar appears with filename and ✕. Pins appear for resolved annotations on current page. Resolution message shown if some couldn't be placed.

### 9.5 Export Flow

1. User clicks **⬇ export**.
2. If no annotations → `alert("nothing to export")`.
3. Otherwise → download begins immediately. Filename: `annotations-{domain}.yaml`.

### 9.6 Delete All Flow

1. User clicks **🗑 delete all**.
2. If no annotations → do nothing.
3. If annotations exist → `confirm("delete all [n] annotation[s]? this cannot be undone.")`
4. Confirmed → all annotations deleted, pins removed, toolbar transitions to TOOLBAR_EMPTY.
5. Cancelled → no changes.

### 9.7 Click-Outside Behavior

When popover is open and user clicks outside (not on a pin or toolbar):

**CREATE mode, textarea is empty:**
- Popover closes
- The annotation listener immediately fires (the event is not suppressed) and opens a new popover at the newly clicked element—effectively “moving” the annotation target

**CREATE mode, textarea has content:**
- Popover does NOT close
- Popover wiggles (380ms shake animation) to indicate the user must save or cancel first
- Click is fully suppressed (`stopImmediatePropagation` + `preventDefault`)

**EDIT mode (any content):**
- Popover does NOT close
- Popover wiggles
- Click is fully suppressed

---

## 10. Accessibility Notes

| Element | Requirement |
|---------|-------------|
| S button | `aria-label="start annotating"` |
| Exit button | `aria-label="exit annotation mode"` |
| Export button | `aria-label="export"` |
| Import button | `aria-label="import"` |
| Delete All button | `aria-label="delete all"` |
| Filename dismiss ✕ | `aria-label="remove file"` |
| Popover cancel ✕ | `aria-label="cancel"` |
| Popover delete 🗑 | `aria-label="delete annotation"` |
| Popover save | `aria-label="save annotation"` |
| All toolbar buttons | Use `<button>` elements, not `<div>` |
| Popover textarea | `placeholder="type something..."` |
| Focus on popover open | `requestAnimationFrame(() => textarea.focus())` |
| Pin elements | `aria-label="annotation [n]"` on each pin |
| Popover container | `role="dialog"; aria-label="annotation note"` |
| Color as sole indicator | Never — all messages include descriptive text |

---

## 11. Implementation Notes for Engineers

### CSS Custom Properties

Define in Shadow DOM `:host` for both the toolbar shadow root and popover shadow root:

```css
:host {
  --annotator-accent:               #FEC800;
  --annotator-error:                #FB645A;
  --annotator-warning:              #D6AE7C;
  --annotator-bg-toolbar:           #000000;
  --annotator-bg-popover:           #3E3E3E;
  --annotator-text-primary:         #FFFFFF;
  --annotator-text-secondary:       #B7B7B7;
  --annotator-text-placeholder:     #D1D1D1;
  --annotator-pin-bg:               #FEC800;
  --annotator-pin-border:           #000000;
  --annotator-pin-text:             #000000;
  --annotator-s-btn-size:           56px;
  --annotator-toolbar-margin:       16px;
  --annotator-icon-btn-size:        56px;
  --annotator-pin-height:           14px;
  --annotator-pin-min-width:        14px;
  --annotator-popover-width:        300px;
  --annotator-radius-large:         16px;
  --annotator-radius-pin:           30px;
}
```

### Z-Index Values

```js
const Z = {
  PINS:    2147483640,
  TOOLBAR: 2147483644,  // also used for S button
  POPOVER: 2147483646,
};
```

### Font Stack

```css
font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
```

### Key CSS Patterns

**Hover highlight (injected into page):**
```css
.annotator-highlighted {
  outline: 2px solid #FFC107 !important;
  outline-offset: 2px !important;
  cursor: crosshair !important;
  box-sizing: border-box !important;
}
```

**Pin visibility & interactivity:**
```css
/* Pins always visible */
.annotator-pin {
  display: block;
  pointer-events: none; /* not clickable when toolbar closed */
}

/* Clickable only in annotation mode */
body.annotator-active .annotator-pin {
  pointer-events: auto !important;
  cursor: pointer !important;
}
```

**Pin shape — single vs multi-digit:**
```css
.annotator-pin {
  height: 24px;
  min-width: 24px;
  border-radius: 12px; /* pill for all — looks like circle when min-width = height */
  padding: 0 5px;
  background: #FFC107;
  color: #000000;
  font-size: 11px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  white-space: nowrap;
  box-sizing: border-box;
}
```

**S button / toolbar mutual exclusion:**
```css
/* JS-controlled — add/remove .annotator-active on <body> */
#annotator-s-btn   { display: flex; }  /* default */
#annotator-host    { display: none; }  /* default */

body.annotator-active #annotator-s-btn  { display: none; }
body.annotator-active #annotator-host   { display: block; }
```

**Pin pop-in animation:**
```css
@keyframes annotator-pin-appear {
  from { transform: scale(0.5); opacity: 0; }
  to   { transform: scale(1);   opacity: 1; }
}
.annotator-pin {
  animation: annotator-pin-appear 150ms ease-out;
}
```

### CSS Gotchas

1. **Shadow DOM `closed` mode — store the reference.** `attachShadow({ mode: 'closed' })` returns the shadow root once; after that `host.shadowRoot` is `null`. Store the returned reference.

2. **Popover width for position calculation.** Use the constant `280` (not `popover.offsetWidth`) when computing candidate positions — `offsetWidth` is `0` before layout.

3. **Pin for fixed-position elements.** Detect `position: fixed` ancestors. Use viewport coordinates (skip `window.scrollX/Y` addition) for pinning to fixed elements.

4. **`textContent` only — never `innerHTML`.** Filenames, annotation text, domain names from files — all via `textContent` or `.value`. Never `innerHTML`.

5. **Disabled buttons.** Use the `disabled` attribute on `<button>`, not just `pointer-events: none`. (`pointer-events: none` does not prevent keyboard activation or provide accessibility semantics.)

6. **File input reset.** After any import error or cancellation, reset with `input.value = ''` so the same file can be re-selected.

7. **Cancel on CREATE removes pin.** When the user cancels a new annotation (or clicks outside the popover while in CREATE state), the freshly placed pin must be removed from the DOM and from storage.

8. **Delete in EDIT has no confirmation.** Single-annotation delete is immediate — no inline confirm, no modal. Only "Delete All" uses `confirm()`.

9. **Pins always in DOM, not toggled by annotation mode.** Pins are rendered and visible at all times. Only their `pointer-events` changes based on annotation mode. Do not use `display: none` on pins to hide them.
