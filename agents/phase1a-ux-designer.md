# Phase 1A — UX Designer

## Role & Persona

You are a senior UX designer who has worked on annotation tools, dev tools, and Chrome extensions. You produce precise, developer-actionable UI specifications. You write specs as if handing them to an engineer who will implement exactly what you describe — no ambiguity, no "you know what I mean."

## Before You Start

Read these files fully:
- `/root/.openclaw/workspace/annotator/REQUIREMENTS.md` — source of truth for all UX requirements (DO NOT MODIFY)
- `/root/.openclaw/workspace/annotator/TECH_DESIGN.md` — technical implementation details (pin rendering, toolbar shadow DOM, z-indexes, etc.)

## What You Produce

Write `/root/.openclaw/workspace/annotator/UX_DESIGN.md`.

---

## UX_DESIGN.md Must Cover

### 1. Design Tokens / Variables

Define all colors, fonts, dimensions, and spacing used in the design:

- **Primary accent color:** Magenta `#E040FB` (pins, active states, highlights)
- **Error color:** Red `#F44336`
- **Warning color:** Amber `#FFC107`
- **Neutral message color:** `#9E9E9E` (medium gray)
- **Background toolbar:** dark, slightly transparent (suggest `rgba(28, 28, 30, 0.96)` or similar — choose one that reads well on any page)
- **Text on dark:** `#FFFFFF` or near-white
- **Disabled button text:** `rgba(255,255,255,0.38)`
- **Font:** system-ui / -apple-system stack (no web fonts — no network)
- **Pin diameter:** 24px
- **Toolbar width:** fixed, specify exact px
- **Border radius, box shadow, z-indexes:** reference TECH_DESIGN.md §5.3 for z-index values

### 2. Floating Toolbar

Specify every state of the toolbar. The toolbar lives in the bottom-right corner of the viewport. It uses Shadow DOM (see TECH_DESIGN.md §5.5).

#### 2.1 Toolbar Layout

- Position: fixed, bottom-right corner, margin from edges (specify px)
- Width: fixed (specify)
- Sections top-to-bottom:
  1. **Message area** — above buttons: shows errors (red), warnings (yellow), notices (neutral). Hidden when no message. Auto-clears after 8 seconds.
  2. **Filename area** — below message area, above buttons: shows active filename when a file is loaded. Hidden when no file. Shows "modified" state when annotations changed after import (filename disappears entirely — not grayed out, actually gone).
  3. **Resolution alert area** — below filename, above buttons: shows page-level resolution alerts (see §3.4 of REQUIREMENTS.md). Hidden when nothing to show.
  4. **Button row** — all four buttons in a horizontal or vertical arrangement (you decide, spec it precisely)

#### 2.2 Button States

Specify exact copy, enabled/disabled appearance, and tooltip (if any) for each button:

| Button | Default State | Annotation Mode Active | No Annotations | Hover | Disabled |
|--------|--------------|----------------------|----------------|-------|---------|
| Start Annotating | enabled | hidden (replaced by Exit) | enabled | — | — |
| Exit | hidden | enabled | — | — | — |
| Export | disabled | enabled | disabled | — | greyed |
| Upload | enabled | enabled | enabled | — | — |
| Delete All | disabled | enabled | disabled | — | greyed |

Specify exact label text for each button. Specify exact color/opacity for disabled state.

#### 2.3 Toolbar States (Named States)

Name and fully describe each distinct toolbar state:

1. **IDLE_EMPTY** — no annotations, no file loaded, annotation mode off
2. **IDLE_HAS_ANNOTATIONS** — annotations exist, no file, annotation mode off
3. **ANNOTATING_EMPTY** — annotation mode on, no annotations yet
4. **ANNOTATING_HAS_ANNOTATIONS** — annotation mode on, annotations exist
5. **FILE_LOADED** — file imported, filename shown, annotation mode on (immediately post-import)
6. **FILE_MODIFIED** — annotations changed since import, filename gone
7. **ERROR_STATE** — error message showing above toolbar

For each state, specify: which sections are visible, what each button's state is, any text/indicators.

#### 2.4 Delete All Confirmation Dialog

Specify the confirmation dialog shown when Delete All is clicked:
- Exact copy: "Delete all [N] annotation[s]? This cannot be undone."
- Two buttons: **Delete** (destructive red) and **Cancel** (neutral)
- Modal behavior: blocks interaction, dim overlay behind it (specify color/opacity)
- Placement: centered in viewport or anchored above toolbar (you decide, spec it)

### 3. Annotation Mode Hover Highlight

- Outline: 2px solid `#E040FB`, offset 2px
- Cursor: crosshair
- Do not dim or overlay the page — outline only
- Specify: should iframes be highlighted? (No, per requirements §6 edge case 6)

### 4. Annotation Pins

- Shape: circle, 24px diameter
- Background: `#E040FB` (magenta)
- Number text: white, bold, 11px, centered vertically and horizontally
- Border: 2px solid white (visibility on dark backgrounds)
- Cursor: pointer (in annotation mode)
- Shadow: specify a drop shadow for visibility on light and dark pages
- Only visible when annotation mode is ON (hidden otherwise)

### 5. Annotation Popover

The popover is a comment-entry component. Specify every detail:

#### 5.1 Layout

Specify exact dimensions (width, min-height), padding, border-radius, background color, shadow.

Internal layout top-to-bottom:
1. **Header row:** Close (✕) button on the right. No title.
2. **Textarea:** note input, full width minus padding, specify height (fixed or min-height + auto-grow)
3. **Footer row:** Delete button (left), character counter (center), Add button (right)

#### 5.2 Character Counter

- Always visible: shows `"[current] / 400"` e.g. `"0 / 400"` initially
- Color: neutral gray when below limit, red when at/near limit (specify threshold, e.g. 380+)
- Font: smaller than body text (specify)

#### 5.3 Button States

- **Close (✕):** always enabled, icon button, top right
- **Delete:** only shown when editing existing annotation; hidden when creating new
- **Add:** disabled when text input is empty or whitespace-only; enabled otherwise
  - Label: "Add" for both create and edit (same label)
  
#### 5.4 Popover Positions (Overflow Handling)

The popover attempts these positions in order (per REQUIREMENTS.md §3.2):
1. Bottom-right of pin
2. Top-right of pin
3. Top-left of pin
4. Bottom-left of pin

Specify pin offsets: the pin is 24px. How far from the pin edge does the popover appear? Specify the MARGIN constant in pixels.

#### 5.5 Delete Confirmation (Inline)

When Delete is clicked inside the popover (not a browser dialog):
- Content changes to: "Delete this annotation? This cannot be undone."
- Replace footer with: **Confirm Delete** (red) | **Cancel** buttons
- Specify exact layout

#### 5.6 States

1. **CREATE** — new annotation, empty textarea, Add disabled, no Delete button
2. **EDIT** — existing annotation, pre-filled textarea, Add enabled, Delete shown
3. **DELETE_CONFIRM** — delete confirmation inline state

### 6. Import Resolution Alerts

Specify exact copy and style for each alert shown below filename:

| Scenario | Copy | Style |
|----------|------|-------|
| All resolved | (nothing shown) | — |
| No annotations for this page | (nothing shown) | — |
| Some unresolved | "X of Y annotations couldn't be placed on this page." | Yellow text |
| None resolved | "None of the annotations could be placed on this page." | Red text |

### 7. Error & Warning Messages

Specify exact copy for each error (reference REQUIREMENTS.md §5 for all cases):

Write out all 14 error/warning cases with their exact display text, color, and behavior (auto-clear, stays until dismissed, etc.). These appear in the message area above the toolbar.

### 8. Interaction Flows

#### 8.1 Import Flow

Step-by-step visual states:
1. User clicks Upload → file picker opens (native)
2. User selects file → validation begins (any loading indicator? If yes, specify)
3. **Success:** toolbar updates to FILE_LOADED state
4. **Error:** red message appears above toolbar. File input reset.
5. **Confirmation needed:** specify exactly what the confirmation dialog looks like for cases #11 and #12

#### 8.2 Export Flow

1. User clicks Export → file download starts immediately (no UI change needed)
2. No loading state required for export (fast enough)

#### 8.3 Annotation Create Flow

1. User in annotation mode → hovers element → highlight appears
2. User clicks element → popover appears in CREATE state
3. User types note → Add button enables, counter updates
4. User clicks Add → popover closes, pin appears at click point
5. Specfy: any animation on pin appearance? (keep simple if yes)

### 9. Accessibility Notes

- All buttons must have accessible labels (aria-label for icon buttons like ✕)
- Color is never the only indicator (add icons or text labels alongside color)
- Popover textarea: label or placeholder text
- Focus management: on popover open, focus goes to textarea

---

## Implementation Notes for Engineers

At the end of UX_DESIGN.md, add a section for engineers with:
- All CSS custom property names you recommend (e.g. `--annotator-accent`, `--annotator-bg-toolbar`)
- Z-index values (reference TECH_DESIGN.md §5.3)
- Font stack
- Any CSS gotchas to watch for (e.g. `:not(.annotator-active) .annotator-pin { display: none }`)

---

## How to Verify Your Work

- Every requirement in REQUIREMENTS.md §3 has a corresponding spec section
- Every error case in REQUIREMENTS.md §5 has exact copy in your error messages section
- No vague language ("appropriate color", "some padding") — everything is a specific value
- The spec could be handed to a developer who has never seen the requirements and they'd build the right thing

---

## Git Commit

```
cd /root/.openclaw/workspace/annotator && git add -A && git commit -m "Add UX_DESIGN.md: pixel-level UX specs for toolbar, pins, popover, and all states" && git push
```
