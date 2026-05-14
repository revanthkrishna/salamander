# Annotator — UX Design Specification

> **Status:** Complete  
> **Version:** 1.0  
> **Author:** Phase 1A UX Designer  
> **Audience:** Engineers implementing the Annotator Chrome extension  
> **Source of truth:** REQUIREMENTS.md (do not modify). TECH_DESIGN.md governs implementation details.

Every value in this document is a specific number, color hex, or literal string. If you see a vague word like "appropriate" or "some padding," treat it as a bug in this document and ask for clarification.

---

## Table of Contents

1. [Design Tokens / Variables](#1-design-tokens--variables)
2. [Floating Toolbar](#2-floating-toolbar)
   - 2.1 [Toolbar Layout](#21-toolbar-layout)
   - 2.2 [Button States](#22-button-states)
   - 2.3 [Toolbar Named States](#23-toolbar-named-states)
   - 2.4 [Delete All Confirmation Dialog](#24-delete-all-confirmation-dialog)
3. [Annotation Mode Hover Highlight](#3-annotation-mode-hover-highlight)
4. [Annotation Pins](#4-annotation-pins)
5. [Annotation Popover](#5-annotation-popover)
   - 5.1 [Layout](#51-layout)
   - 5.2 [Character Counter](#52-character-counter)
   - 5.3 [Button States](#53-button-states)
   - 5.4 [Popover Positions (Overflow Handling)](#54-popover-positions-overflow-handling)
   - 5.5 [Delete Confirmation (Inline)](#55-delete-confirmation-inline)
   - 5.6 [Popover States](#56-popover-states)
6. [Import Resolution Alerts](#6-import-resolution-alerts)
7. [Error & Warning Messages](#7-error--warning-messages)
8. [Interaction Flows](#8-interaction-flows)
9. [Accessibility Notes](#9-accessibility-notes)
10. [Implementation Notes for Engineers](#10-implementation-notes-for-engineers)

---

## 1. Design Tokens / Variables

All values in this section are the canonical source. Use CSS custom properties (see §10) to reference them throughout implementation.

### Colors

| Token | Value | Usage |
|-------|-------|-------|
| `--annotator-accent` | `#E040FB` | Pins, active state highlights |
| `--annotator-error` | `#F44336` | Error messages, destructive actions, red alerts |
| `--annotator-warning` | `#FFC107` | Warning messages, yellow alerts |
| `--annotator-neutral-msg` | `#9E9E9E` | Neutral notices in message area |
| `--annotator-bg-toolbar` | `rgba(28, 28, 30, 0.96)` | Toolbar background |
| `--annotator-bg-popover` | `rgba(36, 36, 38, 0.98)` | Popover background |
| `--annotator-text-primary` | `#FFFFFF` | Primary text on dark backgrounds |
| `--annotator-text-secondary` | `rgba(255, 255, 255, 0.60)` | Secondary text, placeholders, subtle labels |
| `--annotator-text-disabled` | `rgba(255, 255, 255, 0.38)` | Disabled button labels |
| `--annotator-btn-primary-bg` | `#E040FB` | Primary/accent button background |
| `--annotator-btn-primary-text` | `#FFFFFF` | Primary button label |
| `--annotator-btn-secondary-bg` | `rgba(255, 255, 255, 0.10)` | Secondary button background (default/neutral) |
| `--annotator-btn-secondary-bg-hover` | `rgba(255, 255, 255, 0.18)` | Secondary button hover |
| `--annotator-btn-destructive-bg` | `#F44336` | Delete / Confirm Delete background |
| `--annotator-btn-destructive-text` | `#FFFFFF` | Delete button label |
| `--annotator-btn-disabled-bg` | `rgba(255, 255, 255, 0.08)` | Disabled button background |
| `--annotator-divider` | `rgba(255, 255, 255, 0.10)` | Dividers between toolbar sections |
| `--annotator-overlay` | `rgba(0, 0, 0, 0.55)` | Modal dialog background overlay |
| `--annotator-counter-normal` | `rgba(255, 255, 255, 0.50)` | Character counter, within limit |
| `--annotator-counter-warning` | `#F44336` | Character counter, at/near limit (≥ 380 chars) |
| `--annotator-pin-bg` | `#E040FB` | Pin background |
| `--annotator-pin-border` | `#FFFFFF` | Pin border |
| `--annotator-pin-text` | `#FFFFFF` | Pin number text |

### Typography

| Property | Value |
|----------|-------|
| Font family | `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif` |
| No web fonts | True — zero network requests for fonts |
| Base font size (toolbar) | `13px` |
| Base font size (popover) | `13px` |
| Char counter font size | `11px` |
| Pin number font size | `11px` |
| Pin number font weight | `700` (bold) |
| Button font weight | `500` (medium) |

### Dimensions

| Token | Value | Usage |
|-------|-------|-------|
| `--annotator-toolbar-width` | `220px` | Fixed toolbar width |
| `--annotator-toolbar-margin` | `16px` | Distance from viewport right and bottom edges |
| `--annotator-pin-size` | `24px` | Pin diameter |
| `--annotator-popover-width` | `280px` | Fixed popover width |
| `--annotator-popover-min-height` | `160px` | Popover minimum height |
| `--annotator-popover-margin` | `8px` | Gap between pin edge and popover edge |
| `--annotator-radius-toolbar` | `12px` | Toolbar border radius |
| `--annotator-radius-popover` | `10px` | Popover border radius |
| `--annotator-radius-btn` | `6px` | Button border radius |
| `--annotator-radius-pin` | `50%` | Pin border radius (full circle) |

### Shadows

| Element | Shadow value |
|---------|-------------|
| Toolbar | `0 4px 24px rgba(0, 0, 0, 0.40), 0 1px 6px rgba(0, 0, 0, 0.30)` |
| Popover | `0 8px 32px rgba(0, 0, 0, 0.50), 0 2px 8px rgba(0, 0, 0, 0.30)` |
| Pin | `0 2px 6px rgba(0, 0, 0, 0.50), 0 1px 2px rgba(0, 0, 0, 0.30)` |
| Modal dialog | `0 8px 40px rgba(0, 0, 0, 0.60)` |

### Z-Indexes (from TECH_DESIGN.md §5.3)

| Layer | Z-index |
|-------|---------|
| Pins | `2147483640` |
| Toolbar | `2147483644` |
| Popover | `2147483646` |
| Modal dialog overlay | `2147483647` |

---

## 2. Floating Toolbar

The toolbar lives in a Shadow DOM host (`<div id="annotator-host">`). All toolbar CSS is scoped inside the shadow root. See TECH_DESIGN.md §5.5 for Shadow DOM implementation.

### 2.1 Toolbar Layout

**Position:** `position: fixed; bottom: 16px; right: 16px;`  
**Width:** `220px` (fixed — does not expand or shrink)  
**Max-width:** `220px`  
**Background:** `rgba(28, 28, 30, 0.96)`  
**Border-radius:** `12px`  
**Box-shadow:** `0 4px 24px rgba(0,0,0,0.40), 0 1px 6px rgba(0,0,0,0.30)`  
**Z-index:** `2147483644`  
**Padding:** `0` (internal sections use their own padding)  
**Overflow:** `hidden` (rounded corners clip child sections)

#### Internal Section Order (top to bottom)

All sections stack vertically inside the toolbar. Each section is `display: none` when hidden. A `1px` divider (`rgba(255,255,255,0.10)`) separates adjacent visible sections.

---

**Section 1 — Message Area**

- **Purpose:** Display errors (red), warnings (yellow), and neutral notices.
- **Visibility:** Hidden when no message is active. Visible when a message is set.
- **Padding:** `10px 12px`
- **Font size:** `12px`
- **Font weight:** `400`
- **Line height:** `1.4`
- **Color:** Determined by message type:
  - Error: `#F44336`
  - Warning: `#FFC107`
  - Neutral: `#9E9E9E`
- **Auto-clear:** Message disappears after **8 seconds**. A new message resets the 8-second timer.
- **No dismiss button.** Messages auto-clear only.
- **Background:** Inherits toolbar background (no separate background for this section).
- **Border-bottom:** `1px solid rgba(255,255,255,0.10)` when visible (divider below it, above filename or buttons).

---

**Section 2 — Filename Area**

- **Purpose:** Show the active imported filename (e.g. `annotations-figma_com.yaml`).
- **Visibility:**
  - Visible when a file is loaded AND annotations have not been modified since import.
  - **Completely hidden** (`display: none`) when:
    - No file has been imported, or
    - Annotations were modified after import (FILE_MODIFIED state — filename disappears entirely, not grayed out).
- **Padding:** `8px 12px`
- **Font size:** `11px`
- **Font weight:** `400`
- **Color:** `rgba(255,255,255,0.60)` (secondary text)
- **Prefix text:** `📄 ` (file emoji + space) before the filename string — rendered via `textContent`, not `innerHTML`
- **Truncation:** Truncate with `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` if filename exceeds 220px width.
- **Border-bottom:** `1px solid rgba(255,255,255,0.10)` when visible.

---

**Section 3 — Resolution Alert Area**

- **Purpose:** Show page-level import resolution alerts (some or all annotations couldn't be placed on this page).
- **Visibility:** Hidden when no alert applies (see §6 for full logic).
- **Padding:** `8px 12px`
- **Font size:** `12px`
- **Font weight:** `400`
- **Line height:** `1.4`
- **Color:** `#FFC107` (yellow, partial failure) or `#F44336` (red, total failure) — see §6.
- **Border-bottom:** `1px solid rgba(255,255,255,0.10)` when visible.
- **Updates:** Recalculated and re-rendered on every SPA navigation.

---

**Section 4 — Button Row**

- **Purpose:** The four action buttons.
- **Layout:** Vertical stack of buttons, one per row.
- **Padding:** `8px` (around the button group; `4px` vertical gap between buttons)
- **Button dimensions:** Full width (`width: 100%`), height `36px`
- **Button border-radius:** `6px`
- **Button font size:** `13px`
- **Button font weight:** `500`
- **Button gap:** `4px` between adjacent buttons

Button order (top to bottom within section):
1. **Start Annotating** (or **Exit** in annotation mode — mutually exclusive)
2. **Export**
3. **Upload**
4. **Delete All**

### 2.2 Button States

#### Button: Start Annotating / Exit

These are the same button slot — they swap based on annotation mode.

| State | Label | Visible? | Background | Text Color | Cursor |
|-------|-------|----------|------------|------------|--------|
| Default (idle) | `Start Annotating` | Yes | `rgba(255,255,255,0.10)` | `#FFFFFF` | `pointer` |
| Hover (idle) | `Start Annotating` | Yes | `rgba(255,255,255,0.18)` | `#FFFFFF` | `pointer` |
| Annotation mode ON | `Exit` | Yes (replaces Start) | `rgba(255,255,255,0.10)` | `#FFFFFF` | `pointer` |
| Hover (annotation mode) | `Exit` | Yes | `rgba(255,255,255,0.18)` | `#FFFFFF` | `pointer` |

"Start Annotating" is `display: block` when annotation mode is off; `display: none` when on.  
"Exit" is `display: block` when annotation mode is on; `display: none` when off.

#### Button: Export

| State | Label | Background | Text Color | Cursor |
|-------|-------|------------|------------|--------|
| Enabled | `Export` | `rgba(255,255,255,0.10)` | `#FFFFFF` | `pointer` |
| Hover (enabled) | `Export` | `rgba(255,255,255,0.18)` | `#FFFFFF` | `pointer` |
| Disabled | `Export` | `rgba(255,255,255,0.08)` | `rgba(255,255,255,0.38)` | `default` |

Enabled when: at least one annotation exists (across all pages on the domain).  
Disabled when: zero annotations exist.  
`pointer-events: none` when disabled.

#### Button: Upload

| State | Label | Background | Text Color | Cursor |
|-------|-------|------------|------------|--------|
| Always enabled | `Upload` | `rgba(255,255,255,0.10)` | `#FFFFFF` | `pointer` |
| Hover | `Upload` | `rgba(255,255,255,0.18)` | `#FFFFFF` | `pointer` |

Upload is always enabled regardless of state.

#### Button: Delete All

| State | Label | Background | Text Color | Cursor |
|-------|-------|------------|------------|--------|
| Enabled | `Delete All` | `rgba(255,255,255,0.10)` | `#FFFFFF` | `pointer` |
| Hover (enabled) | `Delete All` | `rgba(255,255,255,0.18)` | `#FFFFFF` | `pointer` |
| Disabled | `Delete All` | `rgba(255,255,255,0.08)` | `rgba(255,255,255,0.38)` | `default` |

Enabled when: at least one annotation exists.  
Disabled when: zero annotations exist.  
`pointer-events: none` when disabled.

**No tooltips** on any buttons — labels are self-explanatory and always visible.

### 2.3 Toolbar Named States

Each state is named for developer reference. States map to which sections are visible and which button states are active.

---

#### State: IDLE_EMPTY
**Trigger:** Toolbar just activated (no annotations, no file imported, annotation mode off)

| Section | Visible? | Content |
|---------|----------|---------|
| Message area | No | — |
| Filename area | No | — |
| Resolution alert | No | — |
| Button row | Yes | See below |

| Button | State |
|--------|-------|
| Start Annotating | Enabled |
| Exit | Hidden |
| Export | Disabled |
| Upload | Enabled |
| Delete All | Disabled |

---

#### State: IDLE_HAS_ANNOTATIONS
**Trigger:** Annotations exist, no file loaded, annotation mode off

| Section | Visible? | Content |
|---------|----------|---------|
| Message area | No | — |
| Filename area | No | — |
| Resolution alert | No | — |
| Button row | Yes | See below |

| Button | State |
|--------|-------|
| Start Annotating | Enabled |
| Exit | Hidden |
| Export | Enabled |
| Upload | Enabled |
| Delete All | Enabled |

---

#### State: ANNOTATING_EMPTY
**Trigger:** Annotation mode on, zero annotations exist

| Section | Visible? | Content |
|---------|----------|---------|
| Message area | No | — |
| Filename area | No | — |
| Resolution alert | No | — |
| Button row | Yes | See below |

| Button | State |
|--------|-------|
| Start Annotating | Hidden |
| Exit | Enabled |
| Export | Disabled |
| Upload | Enabled |
| Delete All | Disabled |

---

#### State: ANNOTATING_HAS_ANNOTATIONS
**Trigger:** Annotation mode on, at least one annotation exists

| Section | Visible? | Content |
|---------|----------|---------|
| Message area | No | — |
| Filename area | No | — |
| Resolution alert | No | — |
| Button row | Yes | See below |

| Button | State |
|--------|-------|
| Start Annotating | Hidden |
| Exit | Enabled |
| Export | Enabled |
| Upload | Enabled |
| Delete All | Enabled |

---

#### State: FILE_LOADED
**Trigger:** File successfully imported. Annotation mode automatically enters.

| Section | Visible? | Content |
|---------|----------|---------|
| Message area | No | — |
| Filename area | Yes | `📄 annotations-figma_com.yaml` (actual filename) |
| Resolution alert | Conditional | See §6 — shows only if some/all annotations couldn't be placed on current page |
| Button row | Yes | See below |

| Button | State |
|--------|-------|
| Start Annotating | Hidden (annotation mode is on post-import) |
| Exit | Enabled |
| Export | Enabled (imported file has annotations) |
| Upload | Enabled |
| Delete All | Enabled |

Note: Annotation mode is automatically entered on successful import (per REQUIREMENTS.md §1.4). The toolbar immediately shows the Exit button, not Start Annotating.

---

#### State: FILE_MODIFIED
**Trigger:** Any annotation is added, edited, or deleted after a file was imported.

| Section | Visible? | Content |
|---------|----------|---------|
| Message area | No | — |
| Filename area | **No — completely hidden** | Filename indicator removed |
| Resolution alert | Conditional | Still shown if applicable to current page |
| Button row | Yes | Same as ANNOTATING_HAS_ANNOTATIONS |

The filename disappears the moment any mutation occurs. There is no "modified" indicator — the filename simply goes away. The resolution alert area may still be visible if it was showing before the modification.

---

#### State: ERROR_STATE
**Trigger:** An error or warning message is set (e.g., import failed).

| Section | Visible? | Content |
|---------|----------|---------|
| Message area | **Yes** | Error (red), warning (yellow), or neutral message text |
| Filename area | Conditional | Unchanged from previous state |
| Resolution alert | Conditional | Unchanged from previous state |
| Button row | Yes | Unchanged from previous state |

ERROR_STATE overlays on top of any other state — it adds the message area without changing button states. After 8 seconds the message area hides and the toolbar reverts to whichever base state it was in.

### 2.4 Delete All Confirmation Dialog

The confirmation dialog is a **centered modal** — not anchored to the toolbar.

**Placement:** Centered in the viewport (`position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%)`).

**Overlay:** A full-viewport dim layer behind the dialog:
- `position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 2147483646`

**Dialog container:**
- `position: fixed; z-index: 2147483647`
- `width: 300px`
- `background: rgba(36, 36, 38, 0.98)`
- `border-radius: 12px`
- `box-shadow: 0 8px 40px rgba(0,0,0,0.60)`
- `padding: 20px`
- `color: #FFFFFF`
- `font-family:` system-ui stack (see §1)

**Dialog copy:**  
`"Delete all [N] annotation[s]? This cannot be undone."`

Where `[N]` is the exact count of annotations across all pages of the domain, and `[s]` is the literal letter "s" when N ≠ 1 (singular: "Delete all 1 annotation?", plural: "Delete all 3 annotations?").

**Example:**  
- 1 annotation: `Delete all 1 annotation? This cannot be undone.`
- 4 annotations: `Delete all 4 annotations? This cannot be undone.`

**Copy styling:**
- Font size: `14px`
- Line height: `1.5`
- Color: `#FFFFFF`
- Margin below text: `16px`

**Button row layout:**
- Two buttons side by side: `display: flex; justify-content: flex-end; gap: 8px`

| Button | Label | Background | Text Color | Width |
|--------|-------|------------|------------|-------|
| Cancel | `Cancel` | `rgba(255,255,255,0.10)` | `#FFFFFF` | `auto` |
| Delete | `Delete` | `#F44336` | `#FFFFFF` | `auto` |

Both buttons: `height: 36px; padding: 0 16px; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: pointer; border: none`

**Cancel** is on the left, **Delete** (destructive) is on the right.

**Behavior:**
- Dialog blocks all interaction with the page and toolbar behind it.
- Pressing **Delete:** destroys all annotations across all pages for the current domain, closes dialog, toolbar transitions to IDLE_EMPTY.
- Pressing **Cancel:** closes dialog, no changes made, toolbar returns to previous state.
- Clicking the dim overlay: same as Cancel (closes without action).
- No keyboard shortcut for confirm/cancel in v1 (no keyboard shortcut spec in requirements).

---

## 3. Annotation Mode Hover Highlight

When annotation mode is active and the user hovers a page element:

- **Outline:** `2px solid #E040FB`
- **Outline-offset:** `2px` (outline draws outside the element boundary by 2px)
- **Cursor:** `crosshair`
- **No dim overlay:** The rest of the page is not dimmed or obscured. Outline only.
- **Box-sizing:** `border-box !important` (prevent layout shift on outline)

Iframes are **not highlighted** on hover. The hover listener skips elements inside `<iframe>` (iframes are out of scope, REQUIREMENTS.md §6 edge case 6).

When the popover is open, hover highlighting is suspended — no highlight changes while the popover is visible (per TECH_DESIGN.md §6.6).

CSS injected into the page (not Shadow DOM):
```css
.annotator-highlighted {
  outline: 2px solid #E040FB !important;
  outline-offset: 2px !important;
  cursor: crosshair !important;
  box-sizing: border-box !important;
}
```

---

## 4. Annotation Pins

### Shape & Appearance

| Property | Value |
|----------|-------|
| Shape | Circle |
| Diameter | `24px` (width and height both `24px`) |
| Border-radius | `50%` |
| Background | `#E040FB` |
| Border | `2px solid #FFFFFF` |
| Box-shadow | `0 2px 6px rgba(0,0,0,0.50), 0 1px 2px rgba(0,0,0,0.30)` |
| Z-index | `2147483640` |

### Number Label

| Property | Value |
|----------|-------|
| Font size | `11px` |
| Font weight | `700` (bold) |
| Color | `#FFFFFF` |
| Text align | `center` |
| Vertical align | `middle` (use `display: flex; align-items: center; justify-content: center` on the pin div) |
| User-select | `none` |

### Visibility

- **Annotation mode ON:** `display: block; pointer-events: auto`
- **Annotation mode OFF:** `display: none; pointer-events: none`

Implemented by toggling `.annotator-active` on `<body>`:
```css
body:not(.annotator-active) .annotator-pin {
  display: none !important;
  pointer-events: none !important;
}
```

### Cursor

When annotation mode is ON: `cursor: pointer` on pins (clicking opens the edit popover).

### Animation on Pin Appearance

When a new pin is created, apply a brief pop-in animation:
```css
@keyframes annotator-pin-appear {
  from { transform: scale(0.5); opacity: 0; }
  to   { transform: scale(1);   opacity: 1; }
}
.annotator-pin {
  animation: annotator-pin-appear 150ms ease-out;
}
```

Duration: `150ms`. Easing: `ease-out`. Keep it subtle — not distracting.

---

## 5. Annotation Popover

The popover is a separate Shadow DOM host (`<div id="annotator-popover-host">`). See TECH_DESIGN.md §6.7.

### 5.1 Layout

**Dimensions:**
- Width: `280px` (fixed)
- Min-height: `160px`
- Height: grows with content (textarea is fixed height — see below)

**Appearance:**
- Background: `rgba(36, 36, 38, 0.98)`
- Border-radius: `10px`
- Box-shadow: `0 8px 32px rgba(0,0,0,0.50), 0 2px 8px rgba(0,0,0,0.30)`
- Z-index: `2147483646`
- Position: `fixed`
- Color: `#FFFFFF`
- Font-family: system-ui stack

**Internal structure (top to bottom):**

```
┌─────────────────────────────────────┐
│  [Header row: ✕ button right-aligned] │  — 36px tall
│─────────────────────────────────────│
│  [Textarea: note input]              │  — 88px fixed height
│─────────────────────────────────────│
│  [Footer row: Delete | counter | Add] │  — 40px tall
└─────────────────────────────────────┘
```

**Overall internal padding:** `12px` on all four sides.

---

**Header row:**
- `display: flex; justify-content: flex-end; align-items: center`
- Height: `28px`
- Margin-bottom: `8px`
- Close button (✕): right-aligned, `24px × 24px`, icon-only, border-radius `50%`
  - Background: transparent
  - Color: `rgba(255,255,255,0.60)`
  - Hover: background `rgba(255,255,255,0.12)`, color `#FFFFFF`
  - Font: `16px`, content: `✕` (U+2715 MULTIPLICATION X)
  - `aria-label="Close"`

**Textarea:**
- Width: `100%` (full width minus container padding — `calc(100% - 0px)` since padding is on container)
- Height: `88px` (fixed, no auto-grow in v1)
- Resize: `none`
- Background: `rgba(255,255,255,0.07)`
- Border: `1px solid rgba(255,255,255,0.15)`
- Border-radius: `6px`
- Padding: `8px 10px`
- Font size: `13px`
- Color: `#FFFFFF`
- Placeholder text: `Add a note…`
- Placeholder color: `rgba(255,255,255,0.35)`
- `maxlength="400"` (enforced at HTML level)
- `spellcheck="true"`
- Outline on focus: `2px solid #E040FB; outline-offset: 0`
- Margin-bottom: `8px`

**Footer row:**
- `display: flex; justify-content: space-between; align-items: center`
- Height: `36px`
- Gap between elements: `8px`

Layout of footer row items:
- **Left:** Delete button (or empty space in CREATE state)
- **Center:** Character counter
- **Right:** Add button

### 5.2 Character Counter

- Always visible in both CREATE and EDIT states.
- Format: `"[current] / 400"` — e.g. `"0 / 400"`, `"240 / 400"`, `"400 / 400"`
- Font size: `11px`
- Font weight: `400`
- **Color:**
  - `0–379 chars:` `rgba(255,255,255,0.50)` (neutral gray)
  - `380–400 chars:` `#F44336` (red — at or near limit)
  - Threshold: **380 characters** triggers the red color.
- `white-space: nowrap`
- `flex-shrink: 0`

### 5.3 Button States

**Close (✕) button:**
- Always enabled and visible in all popover states.
- Size: `24px × 24px`
- Background: `transparent`
- Color: `rgba(255,255,255,0.60)`
- Hover: `background: rgba(255,255,255,0.12); color: #FFFFFF`
- Border: none
- Border-radius: `50%`
- `aria-label="Close"`

**Delete button:**
- **Shown only in EDIT state.** Hidden (not just disabled) in CREATE state.
- Label: `Delete`
- Height: `30px`
- Padding: `0 12px`
- Background: `transparent`
- Color: `#F44336`
- Hover: `background: rgba(244,67,54,0.15)`
- Border: `1px solid rgba(244,67,54,0.50)`
- Border-radius: `6px`
- Font size: `13px`
- Font weight: `500`
- Cursor: `pointer`

**Add button:**
- Visible in both CREATE and EDIT states.
- Label: `Add` (same label for both create and edit)
- Height: `30px`
- Padding: `0 14px`
- Border-radius: `6px`
- Font size: `13px`
- Font weight: `500`
- **Enabled state:** Background `#E040FB`, color `#FFFFFF`, cursor `pointer`
- **Hover (enabled):** Background `#CE35DC` (10% darker than accent), color `#FFFFFF`
- **Disabled state:** Background `rgba(224,64,251,0.30)`, color `rgba(255,255,255,0.38)`, cursor `default`, `pointer-events: none`
- Disabled when: textarea content is empty or whitespace-only.
- Enabled when: textarea contains at least 1 non-whitespace character.

### 5.4 Popover Positions (Overflow Handling)

The pin is `24px` in diameter. The MARGIN constant (gap between pin edge and popover edge) is **`8px`**.

Four candidate positions, attempted in this order:

| Priority | Position | `left` | `top` |
|----------|----------|--------|-------|
| 1 (default) | Bottom-right of pin | `pinScreenX + 24 + 8` | `pinScreenY` |
| 2 | Top-right of pin | `pinScreenX + 24 + 8` | `pinScreenY - popoverHeight + 24` |
| 3 | Top-left of pin | `pinScreenX - 280 - 8` | `pinScreenY - popoverHeight + 24` |
| 4 | Bottom-left of pin | `pinScreenX - 280 - 8` | `pinScreenY` |

Where:
- `pinScreenX` = left edge of pin in viewport coordinates
- `pinScreenY` = top edge of pin in viewport coordinates
- `popoverHeight` = `popoverHost.offsetHeight` (measured after first render, or use `160` as pre-layout fallback)
- `280` = `--annotator-popover-width`

A position is **valid** if:
- `left >= 0`
- `top >= 0`
- `left + 280 <= window.innerWidth`
- `top + popoverHeight <= window.innerHeight`

Use the first valid candidate. If all four overflow, use candidate 1 (bottom-right) as the fallback — better to slightly overflow the viewport than to position the popover off-screen.

`pinScreenX` and `pinScreenY` are obtained from the pin element's `getBoundingClientRect()` at the moment the popover opens.

### 5.5 Delete Confirmation (Inline)

When the user clicks **Delete** inside a popover:

The popover content transforms inline — no separate modal dialog for single annotation deletion. The popover maintains its position and size.

**Visual transformation:**

1. The textarea is hidden (`display: none`).
2. A confirmation message replaces it: `"Delete this annotation? This cannot be undone."`
   - Font size: `13px`
   - Line height: `1.5`
   - Color: `#FFFFFF`
   - Padding: `8px 0` (vertical padding only — horizontal comes from container)
3. The header row (✕ button) remains visible.
4. The footer row is replaced with:

```
┌──────────────────────────────────────┐
│  [Confirm Delete (red)] [Cancel]     │
│  (left-aligned, flex row, gap: 8px)  │
└──────────────────────────────────────┘
```

| Button | Label | Background | Color | Border |
|--------|-------|------------|-------|--------|
| Confirm Delete | `Confirm Delete` | `#F44336` | `#FFFFFF` | none |
| Cancel | `Cancel` | `rgba(255,255,255,0.10)` | `#FFFFFF` | none |

Both buttons: `height: 30px; padding: 0 12px; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: pointer`

**Cancel** restores the popover to EDIT state (textarea re-appears with original content, original footer re-appears).  
**Confirm Delete** deletes the annotation from storage, closes the popover, removes the pin.

The character counter is hidden in DELETE_CONFIRM state.

### 5.6 Popover States

#### State: CREATE
**Trigger:** User clicked a non-annotated element.

| Element | State |
|---------|-------|
| Header (✕) | Visible, enabled |
| Textarea | Visible, empty, focused |
| Delete button | **Hidden** |
| Character counter | Visible: `"0 / 400"`, neutral color |
| Add button | **Disabled** |

#### State: EDIT
**Trigger:** User clicked an existing pin.

| Element | State |
|---------|-------|
| Header (✕) | Visible, enabled |
| Textarea | Visible, pre-filled with annotation text, focused, cursor at end |
| Delete button | **Visible, enabled** |
| Character counter | Visible: `"[N] / 400"`, color based on N |
| Add button | **Enabled** (pre-filled text is non-empty) |

#### State: DELETE_CONFIRM
**Trigger:** User clicked Delete in EDIT state.

| Element | State |
|---------|-------|
| Header (✕) | Visible, enabled (closes popover if clicked — no delete) |
| Textarea | Hidden |
| Confirmation text | Visible: `"Delete this annotation? This cannot be undone."` |
| Character counter | Hidden |
| Footer | Replaced: `Confirm Delete` (red) + `Cancel` buttons |

---

## 6. Import Resolution Alerts

Shown in **Section 3** of the toolbar (Resolution Alert Area), below the filename and above buttons. Updated on every page navigation.

| Scenario | Alert text | Color |
|----------|------------|-------|
| All annotations for this page resolved successfully | *(nothing shown — section hidden)* | — |
| No annotations in file target this page | *(nothing shown — section hidden)* | — |
| Annotations exist for this page but **some** couldn't be placed | `X of Y annotations couldn't be placed on this page.` | `#FFC107` (yellow) |
| Annotations exist for this page but **none** could be placed | `None of the annotations could be placed on this page.` | `#F44336` (red) |

Where `X` = number unresolved, `Y` = total targeting this page (both are integers rendered via `textContent`).

**Font size:** `12px`  
**Font weight:** `400`  
**Line height:** `1.4`

These alerts are **per-page** (recalculated on every SPA navigation or page reload). They are distinct from import-time errors, which appear in Section 1 (message area) and reject the file.

---

## 7. Error & Warning Messages

All messages appear in **Section 1** (Message Area) of the toolbar. Messages auto-clear after **8 seconds**. Starting a new message resets the timer.

**Error display:** red text (`#F44336`)  
**Warning display:** yellow text (`#FFC107`)  
**Neutral display:** gray text (`#9E9E9E`)

Confirmation dialogs (cases 11 and 12) use the same modal pattern as Delete All (§2.4): centered viewport modal with dim overlay.

### All 14 Error/Warning Cases

| # | Case | Display Type | Exact Copy |
|---|------|-------------|------------|
| 1 | Wrong file type | 🔴 Error (message area) | `Invalid file type. Please upload a .yaml annotation file.` |
| 2 | File is empty | 🔴 Error (message area) | `This file is empty. Nothing to import.` |
| 3 | File is not valid YAML | 🔴 Error (message area) | `Could not read this file — it appears to be corrupted or incorrectly formatted.` |
| 4 | Valid YAML, wrong schema | 🔴 Error (message area) | `This file doesn't look like an Annotator file. Please check you're uploading the right file.` |
| 5 | Domain mismatch | 🔴 Error (message area) | `This file contains annotations for \`{fileDomain}\`, but you're currently on \`{currentDomain}\`.` |
| 6 | Version mismatch (newer file) | 🟡 Warning (message area) | `This file was created with a newer version of Annotator. Some annotations may not display correctly.` |
| 7 | Domain matches, no annotations for this page | *(silent — no message)* | *(no display)* |
| 8 | Some annotations couldn't be placed | 🔴 Alert (resolution area, below filename) | `None of the annotations could be placed on this page.` |
| 9 | Partial resolution | 🟡 Alert (resolution area, below filename) | `X of Y annotations couldn't be placed on this page.` |
| 10 | File has no annotations | 🔴 Error (message area) | `This file exists but contains no annotations.` |
| 11 | User has annotations → uploads file | 💬 Confirmation dialog | `Uploading this file will replace your current X annotation(s). This cannot be undone. Continue?` |
| 12 | User has unsaved post-import changes → uploads another file | 💬 Confirmation dialog | `You have unsaved changes. Uploading a new file will discard them. This cannot be undone. Continue?` |
| 13 | File exceeds 8MB | 🔴 Error (message area) | `This file is too large to import (max 8MB).` |
| 14 | Duplicate pin numbers in file | 🔴 Error (message area) | `This file appears to be corrupted (duplicate pin numbers detected).` |

#### Case 5 — Domain Mismatch Formatting Note

The backtick-wrapped domain names (`` `figma.com` ``) should render as inline `code` style if the toolbar supports it. If rendering is plain text only, render as: `This file contains annotations for "figma.com", but you're currently on "other.com".` (use quotation marks). Use `textContent` — never `innerHTML`.

#### Cases 11 and 12 — Confirmation Dialog Spec

Same modal pattern as Delete All (§2.4):

| Property | Case 11 | Case 12 |
|----------|---------|---------|
| Copy | `Uploading this file will replace your current X annotation(s). This cannot be undone. Continue?` | `You have unsaved changes. Uploading a new file will discard them. This cannot be undone. Continue?` |
| Confirm button label | `Continue` | `Continue` |
| Confirm button color | `#F44336` (destructive) | `#F44336` (destructive) |
| Cancel button label | `Cancel` | `Cancel` |
| Overlay | `rgba(0,0,0,0.55)` | `rgba(0,0,0,0.55)` |

Case 11: `X` = number of existing annotations (integer). Singular/plural: `1 annotation` / `3 annotations`.  
Case 11 singular: `Uploading this file will replace your current 1 annotation. This cannot be undone. Continue?`

**Confirmed → Continue:** proceed with import pipeline, replace all current annotations.  
**Cancelled:** close dialog, leave current state untouched, reset file input.

---

## 8. Interaction Flows

### 8.1 Import Flow

**Step 1:** User clicks **Upload** button → toolbar triggers click on a hidden `<input type="file" accept=".yaml,.yml">` — the browser's native file picker opens. No UI change in toolbar.

**Step 2:** User selects a file → file picker closes → import validation begins immediately.

**No loading indicator.** File processing is synchronous/near-instant for valid files. Do not add a loading spinner.

**Step 3 — Success path:**
1. Filename area appears: `📄 [filename]`
2. If any annotations for the current page failed to resolve: resolution alert appears below filename.
3. Toolbar transitions to FILE_LOADED state.
4. Annotation mode automatically activates → Start Annotating hidden, Exit shown.
5. Pins appear on any resolved elements for the current page.

**Step 4 — Error path:**
1. Red error message appears in message area above buttons.
2. File input is reset (`input.value = ''`).
3. Toolbar returns to its pre-upload state.
4. Message auto-clears after 8 seconds.

**Step 5 — Confirmation needed (cases 11 and 12):**
1. Confirmation modal appears (centered, with dim overlay). See §7.
2. **User confirms:** import proceeds (Step 3 success path).
3. **User cancels:** modal closes, no changes, file input reset.

### 8.2 Export Flow

**Step 1:** User clicks **Export** → download begins immediately.  
**No UI change.** No loading state, no success message. The browser handles the download natively (file picker or auto-download based on browser settings).  
The export filename is: `annotations-{domain}.yaml` where domain dots are replaced with underscores.

### 8.3 Annotation Create Flow

1. User clicks **Start Annotating** → toolbar transitions (Start Annotating hidden, Exit shown). Cursor changes to `crosshair` on all hoverable elements.

2. User moves cursor over elements → hover highlight appears (magenta outline, `2px solid #E040FB`, offset 2px).

3. User clicks an element (non-annotated):
   - Native click behavior is suppressed (capturing-phase event listener).
   - Hover highlight is cleared from the element.
   - Popover appears in CREATE state, positioned at the best valid candidate position (§5.4), `position: fixed`.
   - Textarea receives focus immediately (`requestAnimationFrame` → `textarea.focus()`).

4. User types their note:
   - Character counter updates live on every keystroke: `"[N] / 400"`.
   - Counter turns red at 380+ characters.
   - Add button becomes enabled as soon as ≥ 1 non-whitespace character exists.
   - Input is capped at 400 characters (via `maxlength="400"` attribute).

5. User clicks **Add**:
   - Popover closes.
   - Pin appears at the exact click point with a `150ms ease-out` pop-in animation.
   - Pin is numbered with the next global pin number for the domain.
   - Export and Delete All buttons become enabled (if first annotation).
   - Annotation is written to `chrome.storage.local` immediately.

6. User remains in annotation mode and can continue clicking elements.

### 8.4 Annotation Edit Flow

1. User (in annotation mode) clicks an existing pin.
2. Popover appears in EDIT state, pre-filled with annotation text. Cursor is placed at end of text.
3. User edits text and clicks **Add** → annotation updated, popover closes, pin remains.
4. Or user clicks **Delete** → DELETE_CONFIRM inline state appears within popover.
5. Or user clicks **✕** or clicks outside popover → popover closes, no changes saved.

### 8.5 Click-Outside-to-Dismiss

When the popover is open:
- Clicking any area outside the popover (and outside annotator elements) closes the popover without saving.
- Any unsaved text in the textarea is discarded.
- If in DELETE_CONFIRM state: clicking outside cancels the deletion and closes the popover.
- Hover highlighting resumes after popover closes.

---

## 9. Accessibility Notes

| Element | Requirement |
|---------|-------------|
| Close (✕) button | `aria-label="Close"` required — icon-only button |
| Upload button | No special aria needed — label is `Upload` |
| All toolbar buttons | Use `<button>` elements (not `<div>`) for native keyboard accessibility |
| Disabled buttons | `disabled` attribute on `<button>` element (do not use only `pointer-events: none`) |
| Popover textarea | `placeholder="Add a note…"` as helper text; no separate `<label>` needed since context is clear |
| Focus management | On popover open: focus moves to `textarea` using `requestAnimationFrame(() => textarea.focus())` |
| Focus trap | No focus trap in v1. Tab navigates naturally. |
| Color as sole indicator | Never use color alone — error messages include descriptive text, not just color. Delete button uses label `Delete` not just red color. |
| Modal dialogs | Set `role="dialog"` and `aria-modal="true"` on the dialog container |
| Pin elements | `aria-label="Annotation [N]"` on each pin div |
| Popover | `role="dialog"` on the popover container; `aria-label="Annotation note"` |

---

## 10. Implementation Notes for Engineers

### CSS Custom Properties

Define all of the following in the Shadow DOM `:host` rule for the toolbar, and in the popover shadow root's `:host` rule:

```css
:host {
  --annotator-accent:               #E040FB;
  --annotator-error:                #F44336;
  --annotator-warning:              #FFC107;
  --annotator-neutral-msg:          #9E9E9E;
  --annotator-bg-toolbar:           rgba(28, 28, 30, 0.96);
  --annotator-bg-popover:           rgba(36, 36, 38, 0.98);
  --annotator-text-primary:         #FFFFFF;
  --annotator-text-secondary:       rgba(255, 255, 255, 0.60);
  --annotator-text-disabled:        rgba(255, 255, 255, 0.38);
  --annotator-btn-primary-bg:       #E040FB;
  --annotator-btn-primary-text:     #FFFFFF;
  --annotator-btn-secondary-bg:     rgba(255, 255, 255, 0.10);
  --annotator-btn-secondary-hover:  rgba(255, 255, 255, 0.18);
  --annotator-btn-destructive-bg:   #F44336;
  --annotator-btn-destructive-text: #FFFFFF;
  --annotator-btn-disabled-bg:      rgba(255, 255, 255, 0.08);
  --annotator-divider:              rgba(255, 255, 255, 0.10);
  --annotator-overlay:              rgba(0, 0, 0, 0.55);
  --annotator-counter-normal:       rgba(255, 255, 255, 0.50);
  --annotator-counter-warning:      #F44336;
  --annotator-pin-bg:               #E040FB;
  --annotator-pin-border:           #FFFFFF;
  --annotator-pin-text:             #FFFFFF;
  --annotator-toolbar-width:        220px;
  --annotator-toolbar-margin:       16px;
  --annotator-pin-size:             24px;
  --annotator-popover-width:        280px;
  --annotator-radius-toolbar:       12px;
  --annotator-radius-popover:       10px;
  --annotator-radius-btn:           6px;
}
```

### Z-Index Values (from TECH_DESIGN.md §5.3)

```js
const Z = {
  PINS:    2147483640,
  TOOLBAR: 2147483644,
  POPOVER: 2147483646,
  MODAL:   2147483647,
};
```

### Font Stack

```css
font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
```

### Key CSS Patterns

**Pin visibility toggle (injected into page, not Shadow DOM):**
```css
body:not(.annotator-active) .annotator-pin {
  display: none !important;
  pointer-events: none !important;
}
```

**Hover highlight (injected into page):**
```css
.annotator-highlighted {
  outline: 2px solid #E040FB !important;
  outline-offset: 2px !important;
  cursor: crosshair !important;
  box-sizing: border-box !important;
}
```

**Pin pop-in animation (injected into page):**
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

1. **Shadow DOM `closed` mode — store the reference.** `attachShadow({ mode: 'closed' })` returns the shadow root; after that, `host.shadowRoot` is `null`. Store the returned reference in module scope. See TECH_DESIGN.md §5.5.

2. **Popover width for position calculation.** Use the hardcoded constant `280` (not `popover.offsetWidth`) when calculating candidate positions. `offsetWidth` is `0` before the element is laid out. See TECH_DESIGN.md §6.7.

3. **Pin positioning for fixed elements.** Detect `position: fixed` on the target element's ancestor chain. Use viewport coordinates (no `window.scrollX/Y` addition) for fixed-position element pins. See TECH_DESIGN.md §5.4.

4. **Character counter threshold.** The red warning color activates at **380 characters** (not 400). At 400, the textarea is full (enforced by `maxlength`).

5. **`textContent` only — no `innerHTML`.** All user-provided strings (annotation notes, filenames, domain names from imported files) must be inserted via `textContent` or as textarea `.value`. Never `innerHTML`. See TECH_DESIGN.md §10.6.

6. **Disabled buttons.** Use the actual `disabled` attribute on `<button>` elements, not only `pointer-events: none`. The `disabled` attribute prevents focus, keyboard activation, and provides accessibility semantics.

7. **Resolution alert uses `textContent` for numbers.** The `X` and `Y` values in alert strings are integers — interpolate them into a string and set via `textContent`. Example: `alertEl.textContent = \`\${unresolved} of \${total} annotations couldn't be placed on this page.\``

8. **Notification timer management.** Always `clearTimeout` the existing notification timer before setting a new one. A stale timer clearing a newer message is a common bug. See TECH_DESIGN.md §8.6.

9. **File input reset.** After any import error or cancellation, reset the file input (`input.value = ''`) so the user can re-select the same file. The browser won't fire `change` events on a file already selected.

10. **Modal overlay must be in the same Shadow DOM or above it.** The dim overlay for Delete All and import confirmation dialogs should be in the toolbar's Shadow DOM host or appended to `<body>` with `z-index: 2147483647` to ensure it covers the toolbar itself.
