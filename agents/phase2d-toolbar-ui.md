# Phase 2D — Toolbar + UI Engineer

## Role & Persona

You are a frontend engineer who builds polished in-page Chrome extension UIs. You know Shadow DOM inside out, you know how to inject styles that don't pollute the host page, and you've implemented toolbar components before. You read the UX spec and implement exactly what it says — no improvising.

## Before You Start

Read these files fully — in this order:
1. `/root/.openclaw/workspace/annotator/REQUIREMENTS.md` — source of truth (DO NOT MODIFY), especially §3.4 (Floating Toolbar)
2. `/root/.openclaw/workspace/annotator/TECH_DESIGN.md` — §5.5 (Toolbar Shadow DOM), §6.5 (Toolbar State Machine), §6.6 (partially — hover/click interception, but you only implement the toolbar, NOT annotation mode or popover)
3. `/root/.openclaw/workspace/annotator/UX_DESIGN.md` — your visual specification. If this file doesn't exist yet, read REQUIREMENTS.md §3.4 very carefully and extrapolate reasonable defaults.

Also check the stub at:
- `/root/.openclaw/workspace/annotator/src/toolbar.ts`

## What You Produce

Fully implement one file: `src/toolbar.ts`

Do NOT modify any other files.

---

## Implementation Requirements

### What the Toolbar Module Does

The toolbar module:
1. Creates the floating toolbar DOM (via Shadow DOM) and injects it into `<body>`
2. Manages all toolbar state (button enabled/disabled, filename display, alerts, messages)
3. Emits events/calls callbacks when buttons are clicked (so the integration layer in `content.ts` can handle the logic)
4. Provides functions to update state from outside (e.g., `setAnnotationMode`, `showError`)

The toolbar does NOT implement annotation mode logic, pin rendering, import/export, or storage. It is purely a UI component.

### Shadow DOM Structure (per TECH_DESIGN.md §5.5)

```typescript
const toolbarHost = document.createElement('div');
toolbarHost.id = 'annotator-host';
// CRITICAL: store the returned shadow root — host.shadowRoot is null after attachShadow('closed')
const toolbarShadow = toolbarHost.attachShadow({ mode: 'closed' });
document.body.appendChild(toolbarHost);
```

All toolbar DOM lives inside `toolbarShadow`, never inside `toolbarHost` directly.

### Toolbar HTML Structure

Inside the shadow root, create:

```html
<div class="annotator-toolbar">
  <!-- Message area (errors/warnings/notices) -->
  <div class="message-area" hidden></div>
  
  <!-- Filename area (shown when file loaded) -->
  <div class="filename-area" hidden>
    <span class="filename-text"></span>
  </div>
  
  <!-- Resolution alert (per-page, below filename) -->
  <div class="resolution-alert" hidden></div>
  
  <!-- Button row -->
  <div class="button-row">
    <button class="btn btn-primary" id="btn-start-annotating">Start Annotating</button>
    <button class="btn btn-primary btn-exit" id="btn-exit" hidden>Exit</button>
    <button class="btn btn-secondary" id="btn-export" disabled>Export</button>
    <button class="btn btn-secondary" id="btn-upload">Upload</button>
    <button class="btn btn-danger" id="btn-delete-all" disabled>Delete All</button>
  </div>
  
  <!-- Hidden file input for import -->
  <input type="file" id="file-input" accept=".yaml,.yml" style="display:none">
</div>
```

### CSS (Inside Shadow DOM)

Write complete CSS for the toolbar. Requirements:
- Position: `fixed`, `bottom: 20px`, `right: 20px`
- Z-index: `2147483644` (per TECH_DESIGN.md §5.3)
- Dark background that reads on any page (e.g. `rgba(28, 28, 30, 0.96)`)
- Rounded corners, drop shadow for visibility
- Width: fixed (e.g. 200px or wider if needed)
- Buttons: clear visual distinction between enabled and disabled (disabled: reduced opacity + no cursor:pointer)
- Error message area: red text
- Warning message area: amber/yellow text
- Filename text: small, light gray, truncated with ellipsis if long
- Resolution alert text: matches error/warning colors

Use CSS custom properties inside the shadow root for easy theming.

All CSS lives inside a `<style>` element inside the shadow root — never injected into the page's `<head>`.

### API Design

The toolbar module exports a set of functions that the integration layer (`content.ts`) calls:

```typescript
export interface ToolbarCallbacks {
  onStartAnnotating: () => void;
  onExitAnnotating: () => void;
  onExport: () => void;
  onUploadFile: (file: File) => void;
  onDeleteAll: () => void;
}

/**
 * Initialize and inject the toolbar into the page.
 * Must be called once. Returns cleanup function.
 */
export function initToolbar(callbacks: ToolbarCallbacks): () => void

/**
 * Update toolbar to reflect annotation mode state.
 * annotationMode=true: hide "Start Annotating", show "Exit"
 * annotationMode=false: show "Start Annotating", hide "Exit"
 */
export function setAnnotationMode(active: boolean): void

/**
 * Set the active filename (from import).
 * null = no file loaded / modified state (hide filename area)
 */
export function setFilename(filename: string | null): void

/**
 * Show error message above toolbar (red). Auto-clears after 8 seconds.
 */
export function showError(message: string): void

/**
 * Show warning message above toolbar (yellow). Auto-clears after 8 seconds.
 */
export function showWarning(message: string): void

/**
 * Show neutral notice message. Auto-clears after 8 seconds.
 */
export function showNotice(message: string): void

/**
 * Clear any active message immediately.
 */
export function clearMessage(): void

/**
 * Update button states based on current annotation state.
 * @param hasAnnotations - whether any annotations exist (enables Export, Delete All)
 * @param annotationMode - whether annotation mode is active
 */
export function updateButtonStates(hasAnnotations: boolean, annotationMode: boolean): void

/**
 * Show/update the per-page resolution alert below the filename.
 * unresolvedCount=0, total=0: hide alert
 * unresolvedCount=total: all failed → red
 * unresolvedCount>0, <total: some failed → yellow
 * unresolvedCount=0, total>0: all resolved → no alert
 */
export function showResolutionAlert(unresolvedCount: number, total: number): void

/**
 * Show a blocking confirmation dialog.
 * Returns true if user confirmed, false if cancelled.
 * Used for:
 * - Delete All confirmation: message = "Delete all X annotations? This cannot be undone."
 * - Import overwrite confirmation: message = "Uploading this file will replace..."
 */
export function showConfirmDialog(message: string): Promise<boolean>

/**
 * Remove the toolbar from the DOM. Call on beforeunload.
 */
export function destroyToolbar(): void
```

### Implementation Details

#### Message Auto-Clear Timer

Per TECH_DESIGN.md §8.6, use a single timer with cancel-before-set pattern:

```typescript
let notifTimer: ReturnType<typeof setTimeout> | null = null;

function showMessageInternal(msg: string, style: 'error' | 'warning' | 'notice') {
  if (notifTimer !== null) clearTimeout(notifTimer);
  // set message content + style...
  notifTimer = setTimeout(() => clearMessage(), 8000);
}
```

#### File Upload Handler

When Upload button is clicked:
1. Trigger `fileInput.click()`
2. On `fileInput.change`, read `fileInput.files[0]`
3. Call `callbacks.onUploadFile(file)`
4. Reset: `fileInput.value = ''` (allows re-selecting same file)

#### Delete All Handler

1. Count annotations — but toolbar module doesn't know the count directly.
2. The `onDeleteAll` callback is called immediately. The integration layer (`content.ts`) handles the confirmation dialog via `showConfirmDialog`.

Actually, let the integration layer call `showConfirmDialog` with the count, then if confirmed, clear storage. OR: provide a `setAnnotationCount` function so the toolbar knows the count and can show the right confirmation message.

**Decision:** Export `setAnnotationCount(count: number): void` so the toolbar can build the correct "Delete all X annotations?" message.

```typescript
export function setAnnotationCount(count: number): void
```

The `onDeleteAll` callback is only fired AFTER the user confirms in the dialog.

#### Confirmation Dialog

Implement as a floating modal inside the Shadow DOM (not a browser `confirm()`):

```html
<div class="confirm-dialog" hidden>
  <div class="confirm-backdrop"></div>
  <div class="confirm-box">
    <p class="confirm-message"></p>
    <div class="confirm-buttons">
      <button class="btn-confirm-cancel">Cancel</button>
      <button class="btn-confirm-ok">Confirm</button>
    </div>
  </div>
</div>
```

The `showConfirmDialog` function:
1. Sets the message text
2. Shows the dialog
3. Returns a Promise that resolves when user clicks Confirm (true) or Cancel (false)
4. Hides the dialog afterward

#### Z-Index Values (TECH_DESIGN.md §5.3)

```
Annotator toolbar: 2,147,483,644
```

The toolbar host div gets `z-index: 2147483644` as an inline style.

---

## TypeScript Notes

- Shadow root reference MUST be stored in module scope: `const toolbarShadow = toolbarHost.attachShadow({ mode: 'closed' })`
- After `attachShadow({ mode: 'closed' })`, `toolbarHost.shadowRoot === null` — never use `toolbarHost.shadowRoot`
- Use `toolbarShadow.querySelector(...)` to find elements inside the shadow root

---

## How to Verify Your Work

1. `cd /root/.openclaw/workspace/annotator && npm run build` — zero TypeScript errors
2. All exported functions exist with the correct signatures
3. The Shadow DOM structure matches the spec
4. `showConfirmDialog` returns a Promise<boolean>

---

## Git Commit

```bash
cd /root/.openclaw/workspace/annotator && git add -A && git commit -m "Phase 2D: Implement toolbar.ts — Shadow DOM toolbar with all states, dialogs, message area" && git push
```
