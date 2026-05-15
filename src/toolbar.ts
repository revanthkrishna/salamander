// src/toolbar.ts
// Phase 2D — Floating Toolbar UI (Shadow DOM)
// Implements all toolbar state, buttons, message area, resolution alerts,
// confirm dialogs, and file upload trigger.
// Does NOT implement annotation mode logic, pin rendering, import/export, or storage.

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface ToolbarCallbacks {
  onStartAnnotating: () => void;
  onExitAnnotating: () => void;
  onExport: () => void;
  onUploadFile: (file: File) => void;
  onDeleteAll: () => void;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let toolbarHost: HTMLDivElement | null = null;
// CRITICAL: attachShadow({ mode: 'closed' }) returns the shadow root here;
// after that, toolbarHost.shadowRoot === null. Always use toolbarShadow.
let toolbarShadow: ShadowRoot | null = null;

// Cached DOM refs inside the shadow root (populated by initToolbar)
let elMessageArea: HTMLDivElement | null = null;
let elFilenameArea: HTMLDivElement | null = null;
let elFilenameText: HTMLSpanElement | null = null;
let elResolutionAlert: HTMLDivElement | null = null;
let elBtnStart: HTMLButtonElement | null = null;
let elBtnExit: HTMLButtonElement | null = null;
let elBtnExport: HTMLButtonElement | null = null;
let elBtnUpload: HTMLButtonElement | null = null;
let elBtnDeleteAll: HTMLButtonElement | null = null;
let elFileInput: HTMLInputElement | null = null;
let elConfirmDialog: HTMLDivElement | null = null;
let elConfirmBackdrop: HTMLDivElement | null = null;
let elConfirmMessage: HTMLParagraphElement | null = null;
let elConfirmOk: HTMLButtonElement | null = null;
let elConfirmCancel: HTMLButtonElement | null = null;

// Notification auto-clear timer — single instance; cancel-before-set
let notifTimer: ReturnType<typeof setTimeout> | null = null;

// Annotation count — stored here so confirmDialog can build "Delete all N annotations?" message
let currentAnnotationCount = 0;

// Pending Promise resolver for the confirm dialog
let confirmResolve: ((value: boolean) => void) | null = null;

// ---------------------------------------------------------------------------
// CSS (inside Shadow DOM — never leaks to the page)
// ---------------------------------------------------------------------------

const TOOLBAR_CSS = `
  :host {
    /* Design tokens */
    --annotator-accent:                #E040FB;
    --annotator-error:                 #F44336;
    --annotator-warning:               #FFC107;
    --annotator-neutral-msg:           #9E9E9E;
    --annotator-bg-toolbar:            rgba(28, 28, 30, 0.96);
    --annotator-bg-popover:            rgba(36, 36, 38, 0.98);
    --annotator-text-primary:          #FFFFFF;
    --annotator-text-secondary:        rgba(255, 255, 255, 0.60);
    --annotator-text-disabled:         rgba(255, 255, 255, 0.38);
    --annotator-btn-secondary-bg:      rgba(255, 255, 255, 0.10);
    --annotator-btn-secondary-hover:   rgba(255, 255, 255, 0.18);
    --annotator-btn-destructive-bg:    #F44336;
    --annotator-btn-destructive-text:  #FFFFFF;
    --annotator-btn-disabled-bg:       rgba(255, 255, 255, 0.08);
    --annotator-divider:               rgba(255, 255, 255, 0.10);
    --annotator-overlay:               rgba(0, 0, 0, 0.55);
    --annotator-radius-toolbar:        12px;
    --annotator-radius-btn:            6px;

    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
  }

  *, *::before, *::after {
    box-sizing: border-box;
  }

  /* ---- Toolbar container ---- */
  .annotator-toolbar {
    position: fixed;
    bottom: 16px;
    right: 16px;
    width: 220px;
    max-width: 220px;
    background: var(--annotator-bg-toolbar);
    border-radius: var(--annotator-radius-toolbar);
    box-shadow: 0 4px 24px rgba(0,0,0,0.40), 0 1px 6px rgba(0,0,0,0.30);
    overflow: hidden;
    font-family: inherit;
    font-size: 13px;
    color: var(--annotator-text-primary);
    pointer-events: auto;
  }

  /* ---- Message area (Section 1) ---- */
  .message-area {
    padding: 10px 12px;
    font-size: 12px;
    font-weight: 400;
    line-height: 1.4;
    border-bottom: 1px solid var(--annotator-divider);
  }
  .message-area[hidden] { display: none !important; }
  .message-area.error   { color: var(--annotator-error); }
  .message-area.warning { color: var(--annotator-warning); }
  .message-area.notice  { color: var(--annotator-neutral-msg); }

  /* ---- Filename area (Section 2) ---- */
  .filename-area {
    padding: 8px 12px;
    font-size: 11px;
    font-weight: 400;
    color: var(--annotator-text-secondary);
    border-bottom: 1px solid var(--annotator-divider);
    overflow: hidden;
  }
  .filename-area[hidden] { display: none !important; }

  .filename-text {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ---- Resolution alert (Section 3) ---- */
  .resolution-alert {
    padding: 8px 12px;
    font-size: 12px;
    font-weight: 400;
    line-height: 1.4;
    border-bottom: 1px solid var(--annotator-divider);
  }
  .resolution-alert[hidden] { display: none !important; }
  .resolution-alert.error   { color: var(--annotator-error); }
  .resolution-alert.warning { color: var(--annotator-warning); }

  /* ---- Button row (Section 4) ---- */
  .button-row {
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .btn {
    width: 100%;
    height: 36px;
    border: none;
    border-radius: var(--annotator-radius-btn);
    font-size: 13px;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    color: var(--annotator-text-primary);
    transition: background 0.1s ease;
    background: var(--annotator-btn-secondary-bg);
  }
  .btn:focus {
    outline: 2px solid var(--annotator-accent);
    outline-offset: 1px;
  }
  .btn:hover:not(:disabled) {
    background: var(--annotator-btn-secondary-hover);
  }
  .btn:disabled {
    background: var(--annotator-btn-disabled-bg);
    color: var(--annotator-text-disabled);
    cursor: default;
    pointer-events: none;
  }
  .btn[hidden] { display: none !important; }

  /* ---- Confirm Dialog ---- */
  /* The dialog wraps backdrop + box; position:fixed covers viewport */
  .confirm-dialog {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2147483647;
  }
  .confirm-dialog[hidden] { display: none !important; }

  .confirm-backdrop {
    position: fixed;
    inset: 0;
    background: var(--annotator-overlay);
    z-index: 2147483646;
  }

  .confirm-box {
    position: relative;
    z-index: 2147483647;
    width: 300px;
    background: var(--annotator-bg-popover);
    border-radius: 12px;
    box-shadow: 0 8px 40px rgba(0,0,0,0.60);
    padding: 20px;
    color: var(--annotator-text-primary);
    font-family: inherit;
  }

  .confirm-message {
    font-size: 14px;
    line-height: 1.5;
    color: var(--annotator-text-primary);
    margin: 0 0 16px 0;
  }

  .confirm-buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .btn-confirm-cancel,
  .btn-confirm-ok {
    height: 36px;
    padding: 0 16px;
    border: none;
    border-radius: var(--annotator-radius-btn);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
  }

  .btn-confirm-cancel {
    background: var(--annotator-btn-secondary-bg);
    color: var(--annotator-text-primary);
  }
  .btn-confirm-cancel:hover {
    background: var(--annotator-btn-secondary-hover);
  }

  .btn-confirm-ok {
    background: var(--annotator-btn-destructive-bg);
    color: var(--annotator-btn-destructive-text);
  }
  .btn-confirm-ok:hover {
    background: #d32f2f;
  }
`;

// ---------------------------------------------------------------------------
// Helper: build toolbar HTML inside the shadow root
// ---------------------------------------------------------------------------

function buildToolbarDOM(shadow: ShadowRoot): void {
  // Style element
  const style = document.createElement('style');
  style.textContent = TOOLBAR_CSS;
  shadow.appendChild(style);

  // Root toolbar container
  const toolbar = document.createElement('div');
  toolbar.className = 'annotator-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Annotator');

  // -- Section 1: Message area --
  elMessageArea = document.createElement('div');
  elMessageArea.className = 'message-area';
  elMessageArea.setAttribute('hidden', '');
  toolbar.appendChild(elMessageArea);

  // -- Section 2: Filename area --
  elFilenameArea = document.createElement('div');
  elFilenameArea.className = 'filename-area';
  elFilenameArea.setAttribute('hidden', '');
  elFilenameText = document.createElement('span');
  elFilenameText.className = 'filename-text';
  elFilenameArea.appendChild(elFilenameText);
  toolbar.appendChild(elFilenameArea);

  // -- Section 3: Resolution alert --
  elResolutionAlert = document.createElement('div');
  elResolutionAlert.className = 'resolution-alert';
  elResolutionAlert.setAttribute('hidden', '');
  toolbar.appendChild(elResolutionAlert);

  // -- Section 4: Button row --
  const buttonRow = document.createElement('div');
  buttonRow.className = 'button-row';

  elBtnStart = document.createElement('button');
  elBtnStart.className = 'btn btn-start';
  elBtnStart.id = 'btn-start-annotating';
  elBtnStart.textContent = 'Start Annotating';

  elBtnExit = document.createElement('button');
  elBtnExit.className = 'btn btn-exit';
  elBtnExit.id = 'btn-exit';
  elBtnExit.textContent = 'Exit';
  elBtnExit.setAttribute('hidden', '');

  elBtnExport = document.createElement('button');
  elBtnExport.className = 'btn btn-export';
  elBtnExport.id = 'btn-export';
  elBtnExport.textContent = 'Export';
  elBtnExport.disabled = true;

  elBtnUpload = document.createElement('button');
  elBtnUpload.className = 'btn btn-upload';
  elBtnUpload.id = 'btn-upload';
  elBtnUpload.textContent = 'Upload';

  elBtnDeleteAll = document.createElement('button');
  elBtnDeleteAll.className = 'btn btn-delete-all';
  elBtnDeleteAll.id = 'btn-delete-all';
  elBtnDeleteAll.textContent = 'Delete All';
  elBtnDeleteAll.disabled = true;

  buttonRow.appendChild(elBtnStart);
  buttonRow.appendChild(elBtnExit);
  buttonRow.appendChild(elBtnExport);
  buttonRow.appendChild(elBtnUpload);
  buttonRow.appendChild(elBtnDeleteAll);
  toolbar.appendChild(buttonRow);

  // -- Hidden file input for import --
  elFileInput = document.createElement('input');
  elFileInput.type = 'file';
  elFileInput.id = 'file-input';
  elFileInput.accept = '.yaml,.yml';
  elFileInput.style.display = 'none';
  toolbar.appendChild(elFileInput);

  // -- Confirm Dialog (modal, inside shadow root) --
  elConfirmDialog = document.createElement('div');
  elConfirmDialog.className = 'confirm-dialog';
  elConfirmDialog.setAttribute('hidden', '');
  elConfirmDialog.setAttribute('role', 'dialog');
  elConfirmDialog.setAttribute('aria-modal', 'true');

  elConfirmBackdrop = document.createElement('div');
  elConfirmBackdrop.className = 'confirm-backdrop';

  const confirmBox = document.createElement('div');
  confirmBox.className = 'confirm-box';

  elConfirmMessage = document.createElement('p');
  elConfirmMessage.className = 'confirm-message';

  const confirmButtons = document.createElement('div');
  confirmButtons.className = 'confirm-buttons';

  elConfirmCancel = document.createElement('button');
  elConfirmCancel.className = 'btn-confirm-cancel';
  elConfirmCancel.textContent = 'Cancel';

  elConfirmOk = document.createElement('button');
  elConfirmOk.className = 'btn-confirm-ok';
  elConfirmOk.textContent = 'Confirm';

  confirmButtons.appendChild(elConfirmCancel);
  confirmButtons.appendChild(elConfirmOk);
  confirmBox.appendChild(elConfirmMessage);
  confirmBox.appendChild(confirmButtons);
  elConfirmDialog.appendChild(elConfirmBackdrop);
  elConfirmDialog.appendChild(confirmBox);

  // Append dialog to shadow root directly (not inside toolbar div)
  // so it can cover the full viewport without being clipped by overflow:hidden
  shadow.appendChild(toolbar);
  shadow.appendChild(elConfirmDialog);
}

// ---------------------------------------------------------------------------
// Internal: show a message in the message area
// ---------------------------------------------------------------------------

function showMessageInternal(msg: string, style: 'error' | 'warning' | 'notice'): void {
  if (!elMessageArea) return;
  // Cancel any pending auto-clear before starting a new one
  if (notifTimer !== null) {
    clearTimeout(notifTimer);
    notifTimer = null;
  }
  elMessageArea.textContent = msg;
  elMessageArea.className = `message-area ${style}`;
  elMessageArea.removeAttribute('hidden');
  notifTimer = setTimeout(() => clearMessage(), 8000);
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/**
 * Initialize and inject the toolbar into the page.
 * Must be called once. Returns a cleanup function.
 */
export function initToolbar(callbacks: ToolbarCallbacks): () => void {
  if (toolbarHost) {
    // Already initialized — idempotent
    return () => destroyToolbar();
  }

  // Create shadow host
  toolbarHost = document.createElement('div');
  toolbarHost.id = 'annotator-host';
  // z-index on the host ensures it stacks above all page content
  toolbarHost.style.cssText = 'position: fixed; bottom: 0; right: 0; width: 0; height: 0; z-index: 2147483644; pointer-events: none;';

  // CRITICAL: store the returned shadow root — host.shadowRoot is null after this
  toolbarShadow = toolbarHost.attachShadow({ mode: 'closed' });
  document.body.appendChild(toolbarHost);

  // Build DOM inside shadow root
  buildToolbarDOM(toolbarShadow);

  // --- Wire up button event listeners ---

  elBtnStart!.addEventListener('click', () => {
    callbacks.onStartAnnotating();
  });

  elBtnExit!.addEventListener('click', () => {
    callbacks.onExitAnnotating();
  });

  elBtnExport!.addEventListener('click', () => {
    callbacks.onExport();
  });

  // Upload: trigger the hidden file input
  elBtnUpload!.addEventListener('click', () => {
    elFileInput!.click();
  });

  // File input change → pass File to callback, then reset input
  elFileInput!.addEventListener('change', () => {
    const file = elFileInput!.files?.[0];
    if (file) {
      callbacks.onUploadFile(file);
    }
    // Reset so the same file can be re-selected if needed
    elFileInput!.value = '';
  });

  // Delete All: delegate entirely to the content layer which owns the
  // confirmation dialog (avoids double-confirm when toolbar + content.ts
  // both showed a dialog independently).
  elBtnDeleteAll!.addEventListener('click', () => {
    callbacks.onDeleteAll();
  });

  // Confirm dialog buttons
  elConfirmOk!.addEventListener('click', () => {
    resolveConfirmDialog(true);
  });

  elConfirmCancel!.addEventListener('click', () => {
    resolveConfirmDialog(false);
  });

  // Clicking the backdrop also cancels
  elConfirmBackdrop!.addEventListener('click', () => {
    resolveConfirmDialog(false);
  });

  return () => destroyToolbar();
}

/**
 * Update toolbar to reflect annotation mode state.
 * annotationMode=true: hide "Start Annotating", show "Exit"
 * annotationMode=false: show "Start Annotating", hide "Exit"
 */
export function setAnnotationMode(active: boolean): void {
  if (!elBtnStart || !elBtnExit) return;
  if (active) {
    elBtnStart.setAttribute('hidden', '');
    elBtnExit.removeAttribute('hidden');
  } else {
    elBtnStart.removeAttribute('hidden');
    elBtnExit.setAttribute('hidden', '');
  }
}

/**
 * Set the active filename (from import).
 * null = no file loaded / modified state (hide filename area)
 */
export function setFilename(filename: string | null): void {
  if (!elFilenameArea || !elFilenameText) return;
  if (filename === null) {
    elFilenameArea.setAttribute('hidden', '');
    elFilenameText.textContent = '';
  } else {
    // Prefix with file emoji — set via textContent only (no innerHTML)
    elFilenameText.textContent = `📄 ${filename}`;
    elFilenameArea.removeAttribute('hidden');
  }
}

/**
 * Show error message above toolbar (red). Auto-clears after 8 seconds.
 */
export function showError(message: string): void {
  showMessageInternal(message, 'error');
}

/**
 * Show warning message above toolbar (yellow). Auto-clears after 8 seconds.
 */
export function showWarning(message: string): void {
  showMessageInternal(message, 'warning');
}

/**
 * Show neutral notice message. Auto-clears after 8 seconds.
 */
export function showNotice(message: string): void {
  showMessageInternal(message, 'notice');
}

/**
 * Clear any active message immediately.
 */
export function clearMessage(): void {
  if (notifTimer !== null) {
    clearTimeout(notifTimer);
    notifTimer = null;
  }
  if (!elMessageArea) return;
  elMessageArea.textContent = '';
  elMessageArea.className = 'message-area';
  elMessageArea.setAttribute('hidden', '');
}

/**
 * Update button states based on current annotation state.
 * @param hasAnnotations - whether any annotations exist (enables Export, Delete All)
 * @param annotationMode - whether annotation mode is active
 */
export function updateButtonStates(hasAnnotations: boolean, annotationMode: boolean): void {
  if (!elBtnStart || !elBtnExit || !elBtnExport || !elBtnDeleteAll) return;

  // Start / Exit toggle
  if (annotationMode) {
    elBtnStart.setAttribute('hidden', '');
    elBtnExit.removeAttribute('hidden');
  } else {
    elBtnStart.removeAttribute('hidden');
    elBtnExit.setAttribute('hidden', '');
  }

  // Export and Delete All enabled only when annotations exist
  elBtnExport.disabled = !hasAnnotations;
  elBtnDeleteAll.disabled = !hasAnnotations;
}

/**
 * Show/update the per-page resolution alert below the filename.
 * unresolvedCount=0, total=0: hide alert
 * unresolvedCount=total (>0): all failed → red
 * unresolvedCount>0, <total: some failed → yellow
 * unresolvedCount=0, total>0: all resolved → hide alert
 */
export function showResolutionAlert(unresolvedCount: number, total: number): void {
  if (!elResolutionAlert) return;

  if (unresolvedCount === 0 || total === 0) {
    // No alert needed
    elResolutionAlert.setAttribute('hidden', '');
    elResolutionAlert.textContent = '';
    elResolutionAlert.className = 'resolution-alert';
    return;
  }

  if (unresolvedCount === total) {
    // All failed — red
    elResolutionAlert.textContent = 'None of the annotations could be placed on this page.';
    elResolutionAlert.className = 'resolution-alert error';
    elResolutionAlert.removeAttribute('hidden');
  } else {
    // Some failed — yellow
    elResolutionAlert.textContent = `${unresolvedCount} of ${total} annotations couldn't be placed on this page.`;
    elResolutionAlert.className = 'resolution-alert warning';
    elResolutionAlert.removeAttribute('hidden');
  }
}

/**
 * Set annotation count so the toolbar can build the correct
 * "Delete all N annotations?" confirmation message.
 */
export function setAnnotationCount(count: number): void {
  currentAnnotationCount = count;
}

/**
 * Show a blocking confirmation dialog.
 * Returns true if user confirmed, false if cancelled.
 */
export function showConfirmDialog(message: string): Promise<boolean> {
  if (!elConfirmDialog || !elConfirmMessage) {
    // Fallback if toolbar not initialised (shouldn't happen in normal usage)
    return Promise.resolve(false);
  }

  // If a dialog is already open, resolve the previous one as cancelled
  if (confirmResolve) {
    confirmResolve(false);
    confirmResolve = null;
  }

  elConfirmMessage.textContent = message;
  elConfirmDialog.removeAttribute('hidden');

  return new Promise<boolean>((resolve) => {
    confirmResolve = resolve;
  });
}

/** Internal: resolve the confirm dialog and clean up. */
function resolveConfirmDialog(value: boolean): void {
  if (!elConfirmDialog) return;
  elConfirmDialog.setAttribute('hidden', '');
  if (confirmResolve) {
    const resolve = confirmResolve;
    confirmResolve = null;
    resolve(value);
  }
}

/**
 * Remove the toolbar from the DOM. Call on beforeunload.
 */
export function destroyToolbar(): void {
  // Cancel any pending notification timer
  if (notifTimer !== null) {
    clearTimeout(notifTimer);
    notifTimer = null;
  }

  // Resolve any pending confirm dialog as cancelled
  if (confirmResolve) {
    confirmResolve(false);
    confirmResolve = null;
  }

  // Remove host from DOM
  if (toolbarHost && toolbarHost.parentNode) {
    toolbarHost.parentNode.removeChild(toolbarHost);
  }

  // Clear all refs
  toolbarHost = null;
  toolbarShadow = null;
  elMessageArea = null;
  elFilenameArea = null;
  elFilenameText = null;
  elResolutionAlert = null;
  elBtnStart = null;
  elBtnExit = null;
  elBtnExport = null;
  elBtnUpload = null;
  elBtnDeleteAll = null;
  elFileInput = null;
  elConfirmDialog = null;
  elConfirmBackdrop = null;
  elConfirmMessage = null;
  elConfirmOk = null;
  elConfirmCancel = null;
}
