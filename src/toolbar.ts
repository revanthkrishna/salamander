// src/toolbar.ts
// UI redesign — S button (idle) + horizontal icon toolbar (active).
// Toolbar widget anchored bottom-right. Shadow DOM isolates all styling.

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface ToolbarCallbacks {
  /** S button clicked: open toolbar + start annotation mode. */
  onSButtonClick: () => void;
  /** Exit (cross) clicked: collapse to S button + stop annotation mode. */
  onExit: () => void;
  /** Export button clicked. */
  onExport: () => void;
  /** Import: file selected from native picker. */
  onUploadFile: (file: File) => void;
  /** Delete-all button clicked. */
  onDeleteAll: () => void;
  /** Filename-bar dismiss button clicked (removes file + all annotations). */
  onDismissFile?: () => void;
}

// ---------------------------------------------------------------------------
// Inline SVG icon strings — fill="currentColor" so CSS hover can recolor them
// ---------------------------------------------------------------------------

const ICON_DOWNLOAD = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor" aria-hidden="true"><path d="M9.878,18.122a3,3,0,0,0,4.244,0l3.211-3.211A1,1,0,0,0,15.919,13.5l-2.926,2.927L13,1a1,1,0,0,0-1-1h0a1,1,0,0,0-1,1l-.009,15.408L8.081,13.5a1,1,0,0,0-1.414,1.415Z"/><path d="M23,16h0a1,1,0,0,0-1,1v4a1,1,0,0,1-1,1H3a1,1,0,0,1-1-1V17a1,1,0,0,0-1-1H1a1,1,0,0,0-1,1v4a3,3,0,0,0,3,3H21a3,3,0,0,0,3-3V17A1,1,0,0,0,23,16Z"/></svg>`;

const ICON_UPLOAD = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor" aria-hidden="true"><path d="M11.007,2.578,11,18.016a1,1,0,0,0,1,1h0a1,1,0,0,0,1-1l.007-15.421,2.912,2.913a1,1,0,0,0,1.414,0h0a1,1,0,0,0,0-1.414L14.122.879a3,3,0,0,0-4.244,0L6.667,4.091a1,1,0,0,0,0,1.414h0a1,1,0,0,0,1.414,0Z"/><path d="M22,17v4a1,1,0,0,1-1,1H3a1,1,0,0,1-1-1V17a1,1,0,0,0-1-1H1a1,1,0,0,0-1,1v4a3,3,0,0,0,3,3H21a3,3,0,0,0,3-3V17a1,1,0,0,0-1-1h0A1,1,0,0,0,22,17Z"/></svg>`;

const ICON_TRASH = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor" aria-hidden="true"><path d="M21,4H17.9A5.009,5.009,0,0,0,13,0H11A5.009,5.009,0,0,0,6.1,4H3A1,1,0,0,0,3,6H4V19a5.006,5.006,0,0,0,5,5h6a5.006,5.006,0,0,0,5-5V6h1a1,1,0,0,0,0-2ZM11,2h2a3.006,3.006,0,0,1,2.829,2H8.171A3.006,3.006,0,0,1,11,2Zm7,17a3,3,0,0,1-3,3H9a3,3,0,0,1-3-3V6H18Z"/><path d="M10,18a1,1,0,0,0,1-1V11a1,1,0,0,0-2,0v6A1,1,0,0,0,10,18Z"/><path d="M14,18a1,1,0,0,0,1-1V11a1,1,0,0,0-2,0v6A1,1,0,0,0,14,18Z"/></svg>`;

const ICON_CROSS_SMALL = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor" aria-hidden="true"><polygon points="18.707 6.707 17.293 5.293 12 10.586 6.707 5.293 5.293 6.707 10.586 12 5.293 17.293 6.707 18.707 12 13.414 17.293 18.707 18.707 17.293 13.414 12 18.707 6.707"/></svg>`;

const ICON_CLIP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor" aria-hidden="true"><path d="M22.95,9.6a1,1,0,0,0-1.414,0L10.644,20.539a5,5,0,1,1-7.072-7.071L14.121,2.876a3,3,0,0,1,4.243,4.242L7.815,17.71a1.022,1.022,0,0,1-1.414,0,1,1,0,0,1,0-1.414l9.392-9.435a1,1,0,0,0-1.414-1.414L4.987,14.882a3,3,0,0,0,0,4.243,3.073,3.073,0,0,0,4.243,0L19.778,8.532a5,5,0,0,0-7.071-7.07L2.158,12.054a7,7,0,0,0,9.9,9.9L22.95,11.018A1,1,0,0,0,22.95,9.6Z"/></svg>`;

const ICON_DELETE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor" aria-hidden="true"><path d="m19 2h-9.044a4.966 4.966 0 0 0 -3.946 1.931l-5.8 7.455a1 1 0 0 0 0 1.228l5.8 7.455a4.966 4.966 0 0 0 3.946 1.931h9.044a5.006 5.006 0 0 0 5-5v-10a5.006 5.006 0 0 0 -5-5zm3 15a3 3 0 0 1 -3 3h-9.044a2.979 2.979 0 0 1 -2.368-1.158l-5.321-6.842 5.321-6.842a2.979 2.979 0 0 1 2.368-1.158h9.044a3 3 0 0 1 3 3zm-4.793-6.793-1.793 1.793 1.793 1.793a1 1 0 1 1 -1.414 1.414l-1.793-1.793-1.793 1.793a1 1 0 0 1 -1.414-1.414l1.793-1.793-1.793-1.793a1 1 0 0 1 1.414-1.414l1.793 1.793 1.793-1.793a1 1 0 0 1 1.414 1.414z"/></svg>`;

const ICON_EXCLAMATION = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor" aria-hidden="true"><g><path d="M12,1C6.916,1,1.081,2.25,1.081,12s5.835,11,10.919,11,10.919-1.25,10.919-11S17.084,1,12,1Zm0,20c-5.354,0-8.919-1.53-8.919-9S6.646,3,12,3s8.919,1.53,8.919,9-3.565,9-8.919,9Z"/><path d="M12,6.461c-.553,0-1,.447-1,1v5.667c0,.553,.447,1,1,1s1-.447,1-1V7.461c0-.553-.447-1-1-1Z"/></g><path d="M12,15.544c-.552,0-.999,.447-.999,.999s.447,.999,.999,.999,.999-.447,.999-.999-.447-.999-.999-.999Z"/></svg>`;

const ICON_FACE_WOOZY = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor" aria-hidden="true"><path d="M12,0C5.383,0,0,5.383,0,12s5.383,12,12,12,12-5.383,12-12S18.617,0,12,0Zm0,22c-5.514,0-10-4.486-10-10S6.486,2,12,2s10,4.486,10,10-4.486,10-10,10ZM5.37,9.334l-.742-1.857c1.188-.474,2.268-1.373,3.04-2.531l1.664,1.109c-1.01,1.514-2.38,2.647-3.962,3.279Zm8.63,.666c0-1.657,.672-3,1.5-3s1.5,1.343,1.5,3-.672,3-1.5,3-1.5-1.343-1.5-3Zm-7.447,1.105l4-2,.895,1.789-4,2-.895-1.789Zm10.582,3.394l1.731,1c-.337,.584-2.129,3.5-4.289,3.5-.903,0-1.609-.68-2.232-1.28-.263-.252-.702-.676-.884-.724-.149,.003-.338,.124-.656,.335-.423,.282-1.002,.668-1.805,.668-1.276,0-3.018-1.604-3.707-2.293l1.414-1.415c.85,.849,1.951,1.663,2.311,1.708,.171,0,.359-.121,.678-.333,.423-.282,1.002-.668,1.805-.668,.903,0,1.609,.68,2.232,1.28,.263,.252,.702,.676,.884,.724,.684-.003,1.91-1.456,2.519-2.504Z"/></svg>`;

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let toolbarHost: HTMLDivElement | null = null;
let toolbarShadow: ShadowRoot | null = null;

// Cached DOM refs inside the shadow root
let elSButton: HTMLButtonElement | null = null;
let elToolbarPanel: HTMLDivElement | null = null;
let elFilenameBar: HTMLDivElement | null = null;
let elFilenameText: HTMLSpanElement | null = null;
let elFilenameDismissBtn: HTMLButtonElement | null = null;
let elWarningBar: HTMLDivElement | null = null;
let elWarningText: HTMLSpanElement | null = null;
let elErrorBar: HTMLDivElement | null = null;
let elErrorText: HTMLSpanElement | null = null;
let elBtnExport: HTMLButtonElement | null = null;
let elBtnUpload: HTMLButtonElement | null = null;
let elBtnDeleteAll: HTMLButtonElement | null = null;
let elBtnExit: HTMLButtonElement | null = null;
let elFileInput: HTMLInputElement | null = null;

let callbacksRef: ToolbarCallbacks | null = null;
let notifTimer: ReturnType<typeof setTimeout> | null = null;

// Track whether toolbar panel is expanded (annotation mode on)
let isExpanded = false;

// ---------------------------------------------------------------------------
// CSS — Figma-exact tokens
// ---------------------------------------------------------------------------

const TOOLBAR_CSS = `
  :host {
    --accent:        #FEC800;
    --error:         #FB645A;
    --warning:       #D6AE7C;
    --bg:            #000000;
    --text:          #FFFFFF;
    --text-muted:    #B7B7B7;
    --shadow:        drop-shadow(0px 0px 8px rgba(0,0,0,0.25));

    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: var(--text);
  }

  *, *::before, *::after { box-sizing: border-box; }

  /* ─── Anchor wrapper ─────────────────────────────────────────────────── */
  .anchor {
    position: fixed;
    bottom: 16px;
    right: 16px;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    pointer-events: none; /* children re-enable */
  }

  /* ─── S Button (idle state) ─────────────────────────────────────────── */
  .s-btn {
    width: 56px;
    height: 56px;
    background: var(--bg);
    border: none;
    border-radius: 16px;
    color: var(--text);
    font-size: 24px;
    font-family: inherit;
    font-weight: 400;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    filter: var(--shadow);
    pointer-events: auto;
    padding: 0;
    transition: color 120ms ease;
  }
  .s-btn:hover { color: var(--accent); }
  .s-btn:active img { transform: scale(0.92); }
  .s-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .s-btn[hidden] { display: none !important; }

  /* ─── Toolbar panel (expanded state) ─────────────────────────────────── */
  .panel {
    width: 224px;
    display: flex;
    flex-direction: column;
    border-radius: 16px;
    overflow: hidden;          /* clips all children to the rounded corners */
    filter: var(--shadow);
    pointer-events: auto;
    background: var(--bg);     /* solid fill so page background never bleeds through */
  }
  .panel[hidden] { display: none !important; }

  /* Filename bar */
  .filename-bar {
    display: flex;
    flex-direction: row;
    align-items: center;
    width: 224px;
    height: 35px;
    background: var(--bg);
  }
  .filename-bar[hidden] { display: none !important; }

  .filename-left {
    display: flex;
    flex-direction: row;
    align-items: center;
    flex: 1 1 auto;
    min-width: 0;
    padding: 8px 0 8px 16px;
    gap: 4px;
    color: var(--text-muted);
    overflow: hidden;
  }
  .filename-left .icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    display: inline-flex;
    color: var(--text-muted);
  }
  .filename-text {
    font-size: 16px;
    line-height: 1.2;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .filename-dismiss {
    width: 48px;
    height: 35px;
    padding: 8px 16px;
    background: var(--bg);
    border: none;
    color: var(--text);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: color 120ms ease;
  }
  .filename-dismiss .icon { width: 16px; height: 16px; display: inline-flex; }
  .filename-dismiss:hover { color: var(--accent); }
  .filename-dismiss:active .icon { transform: scale(0.88); }
  .filename-dismiss:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

  /* Warning bar */
  .warning-bar {
    display: flex;
    flex-direction: row;
    align-items: center;
    width: 224px;
    min-height: 44px;
    padding: 8px 16px;
    gap: 4px;
    background: var(--bg);
    color: var(--warning);
  }
  .warning-bar[hidden] { display: none !important; }
  .warning-bar .icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    display: inline-flex;
    color: var(--warning);
  }
  .warning-text {
    font-size: 12px;
    line-height: 14px;
    color: var(--warning);
    flex: 1 1 auto;
  }

  /* Error bar */
  .error-bar {
    display: flex;
    flex-direction: row;
    align-items: center;
    width: 224px;
    min-height: 32px;
    padding: 8px 16px;
    gap: 4px;
    background: var(--bg);
    color: var(--error);
  }
  .error-bar[hidden] { display: none !important; }
  .error-bar .icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    display: inline-flex;
    color: var(--error);
  }
  .error-text {
    font-size: 12px;
    line-height: 14px;
    color: var(--error);
    flex: 1 1 auto;
  }

  /* Button row */
  .button-row {
    display: flex;
    flex-direction: row;
    width: 224px;
    height: 56px;
    background: transparent;
  }

  .icon-btn {
    width: 56px;
    height: 56px;
    padding: 16px;
    background: var(--bg);
    border: none;
    color: var(--text);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 120ms ease;
  }
  .icon-btn:hover { color: var(--accent); }
  .icon-btn:active .icon { transform: scale(0.88); }
  .icon-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .icon-btn[disabled] {
    cursor: default;
    opacity: 0.38;
  }
  .icon-btn[disabled]:hover { color: var(--text); }

  .icon-btn .icon {
    width: 24px;
    height: 24px;
    display: inline-flex;
    transition: transform 80ms ease;
  }
  .icon-btn .icon svg { width: 100%; height: 100%; display: block; }

  /* No per-button border-radius needed — .panel has overflow:hidden + border-radius:16px
     which correctly clips all corners. Individual button radii would create rendering
     artifacts (visible gaps / mismatched curves) when bars are stacked above. */
`;

// ---------------------------------------------------------------------------
// Build the DOM
// ---------------------------------------------------------------------------

function buildDOM(shadow: ShadowRoot): void {
  const style = document.createElement('style');
  style.textContent = TOOLBAR_CSS;
  shadow.appendChild(style);

  // Anchor (bottom-right). Holds either the S button OR the panel.
  const anchor = document.createElement('div');
  anchor.className = 'anchor';

  // ── S button (idle state)
  elSButton = document.createElement('button');
  elSButton.type = 'button';
  elSButton.className = 's-btn';
  elSButton.setAttribute('aria-label', 'Open annotator');
  const logoImg = document.createElement('img');
  logoImg.src = chrome.runtime.getURL('icons/logo for use in floating button.svg');
  logoImg.alt = '';
  logoImg.setAttribute('aria-hidden', 'true');
  elSButton.appendChild(logoImg);

  // ── Panel (expanded state)
  elToolbarPanel = document.createElement('div');
  elToolbarPanel.className = 'panel';
  elToolbarPanel.setAttribute('role', 'toolbar');
  elToolbarPanel.setAttribute('aria-label', 'Annotator');
  elToolbarPanel.hidden = true;

  // Filename bar
  elFilenameBar = document.createElement('div');
  elFilenameBar.className = 'filename-bar';
  elFilenameBar.hidden = true;
  const filenameLeft = document.createElement('div');
  filenameLeft.className = 'filename-left';
  const clipIcon = document.createElement('span');
  clipIcon.className = 'icon';
  clipIcon.innerHTML = ICON_CLIP;
  elFilenameText = document.createElement('span');
  elFilenameText.className = 'filename-text';
  filenameLeft.appendChild(clipIcon);
  filenameLeft.appendChild(elFilenameText);
  elFilenameDismissBtn = document.createElement('button');
  elFilenameDismissBtn.type = 'button';
  elFilenameDismissBtn.className = 'filename-dismiss';
  elFilenameDismissBtn.setAttribute('aria-label', 'Dismiss file');
  const dismissIcon = document.createElement('span');
  dismissIcon.className = 'icon';
  dismissIcon.innerHTML = ICON_DELETE;
  elFilenameDismissBtn.appendChild(dismissIcon);
  elFilenameBar.appendChild(filenameLeft);
  elFilenameBar.appendChild(elFilenameDismissBtn);

  // Warning bar
  elWarningBar = document.createElement('div');
  elWarningBar.className = 'warning-bar';
  elWarningBar.setAttribute('role', 'status');
  elWarningBar.hidden = true;
  const warnIcon = document.createElement('span');
  warnIcon.className = 'icon';
  warnIcon.innerHTML = ICON_EXCLAMATION;
  elWarningText = document.createElement('span');
  elWarningText.className = 'warning-text';
  elWarningBar.appendChild(warnIcon);
  elWarningBar.appendChild(elWarningText);

  // Error bar
  elErrorBar = document.createElement('div');
  elErrorBar.className = 'error-bar';
  elErrorBar.setAttribute('role', 'alert');
  elErrorBar.hidden = true;
  const errIcon = document.createElement('span');
  errIcon.className = 'icon';
  errIcon.innerHTML = ICON_FACE_WOOZY;
  elErrorText = document.createElement('span');
  elErrorText.className = 'error-text';
  elErrorBar.appendChild(errIcon);
  elErrorBar.appendChild(elErrorText);

  // Button row: [export][import][delete-all][exit]
  const buttonRow = document.createElement('div');
  buttonRow.className = 'button-row';

  elBtnExport = makeIconButton(ICON_DOWNLOAD, 'Export annotations');
  elBtnUpload = makeIconButton(ICON_UPLOAD, 'Import annotations');
  elBtnDeleteAll = makeIconButton(ICON_TRASH, 'Delete all annotations');
  elBtnExit = makeIconButton(ICON_CROSS_SMALL, 'Exit annotation mode');

  buttonRow.appendChild(elBtnExport);
  buttonRow.appendChild(elBtnUpload);
  buttonRow.appendChild(elBtnDeleteAll);
  buttonRow.appendChild(elBtnExit);

  elToolbarPanel.appendChild(elFilenameBar);
  elToolbarPanel.appendChild(elWarningBar);
  elToolbarPanel.appendChild(elErrorBar);
  elToolbarPanel.appendChild(buttonRow);

  // Hidden file input for import
  elFileInput = document.createElement('input');
  elFileInput.type = 'file';
  elFileInput.accept = '.yaml,.yml';
  elFileInput.style.display = 'none';

  anchor.appendChild(elSButton);
  anchor.appendChild(elToolbarPanel);
  anchor.appendChild(elFileInput);
  shadow.appendChild(anchor);
}

function makeIconButton(svgMarkup: string, ariaLabel: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-btn';
  btn.setAttribute('aria-label', ariaLabel);
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = svgMarkup;
  btn.appendChild(span);
  return btn;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initToolbar(callbacks: ToolbarCallbacks): () => void {
  if (toolbarHost) {
    return () => destroyToolbar();
  }
  callbacksRef = callbacks;

  toolbarHost = document.createElement('div');
  toolbarHost.id = 'annotator-host';
  // Host div is a 0-size element; the anchor positions itself via fixed.
  toolbarHost.style.cssText = 'position: fixed; bottom: 0; right: 0; width: 0; height: 0; z-index: 2147483644; pointer-events: none;';

  toolbarShadow = toolbarHost.attachShadow({ mode: 'closed' });
  document.body.appendChild(toolbarHost);

  // KEY: even with pointer-events:none on the host, pointer events from shadow
  // DOM children still bubble out to the host (per spec / MDN). We use this to
  // set a reliable flag that the annotation-mode click listener can check.
  // This sidesteps all composed-path / stopPropagation unreliability with
  // zero-size closed shadow hosts in Chrome.
  toolbarHost.addEventListener('pointerdown', () => {
    (window as any).__annotatorToolbarPointerDown = true;
  });

  buildDOM(toolbarShadow);

  // Wire events.
  // IMPORTANT: every handler calls e.stopPropagation() so toolbar clicks never
  // bubble up to the document-level annotation click listener.
  elSButton!.addEventListener('click', (e) => {
    e.stopPropagation();
    setExpanded(true);
    callbacksRef?.onSButtonClick();
  });

  elBtnExit!.addEventListener('click', (e) => {
    e.stopPropagation();
    setExpanded(false);
    callbacksRef?.onExit();
  });

  elBtnExport!.addEventListener('click', (e) => {
    e.stopPropagation();
    callbacksRef?.onExport();
  });

  elBtnUpload!.addEventListener('click', (e) => {
    e.stopPropagation();
    elFileInput!.click();
  });

  elFileInput!.addEventListener('change', () => {
    const file = elFileInput!.files?.[0];
    if (file) callbacksRef?.onUploadFile(file);
    elFileInput!.value = '';
  });

  elBtnDeleteAll!.addEventListener('click', (e) => {
    e.stopPropagation();
    callbacksRef?.onDeleteAll();
  });

  elFilenameDismissBtn!.addEventListener('click', (e) => {
    e.stopPropagation();
    callbacksRef?.onDismissFile?.();
  });

  return () => destroyToolbar();
}

/** Switch between idle (S button) and expanded (toolbar panel). */
function setExpanded(expanded: boolean): void {
  isExpanded = expanded;
  if (!elSButton || !elToolbarPanel) return;
  if (expanded) {
    elSButton.hidden = true;
    elToolbarPanel.hidden = false;
  } else {
    elSButton.hidden = false;
    elToolbarPanel.hidden = true;
    // Also clear any transient message bars so they don't reappear on next open
    clearWarning();
    clearError();
  }
}

/**
 * Legacy API — for the new design, the S button IS the mode toggle.
 * When called with `true`, show the toolbar panel. With `false`, show the S button.
 * Kept for backward compatibility with content.ts.
 */
export function setAnnotationMode(active: boolean): void {
  setExpanded(active);
}

/** Show the toolbar panel (annotation mode on). */
export function showToolbar(): void {
  setExpanded(true);
}

/** Hide the toolbar panel and show the S button (annotation mode off). */
export function hideToolbar(): void {
  setExpanded(false);
}

/** Returns whether the toolbar panel is currently expanded. */
export function isToolbarExpanded(): boolean {
  return isExpanded;
}

/**
 * Set or clear the active filename (from import).
 * null = no file loaded / modified state (hide filename bar).
 */
export function setFilename(filename: string | null): void {
  if (!elFilenameBar || !elFilenameText) return;
  if (filename === null || filename === '') {
    elFilenameBar.hidden = true;
    elFilenameText.textContent = '';
  } else {
    elFilenameText.textContent = filename;
    elFilenameBar.hidden = false;
  }
}

/** Show error bar inside the toolbar. Auto-clears after 8s. */
export function showError(message: string): void {
  if (!elErrorBar || !elErrorText) return;
  if (notifTimer !== null) {
    clearTimeout(notifTimer);
    notifTimer = null;
  }
  elErrorText.textContent = message;
  elErrorBar.hidden = false;
  // Ensure panel is visible so the user sees it
  if (!isExpanded) setExpanded(true);
  notifTimer = setTimeout(() => {
    clearError();
    notifTimer = null;
  }, 8000);
}

/** Show warning bar inside the toolbar. Auto-clears after 8s. */
export function showWarning(message: string): void {
  if (!elWarningBar || !elWarningText) return;
  if (notifTimer !== null) {
    clearTimeout(notifTimer);
    notifTimer = null;
  }
  elWarningText.textContent = message;
  elWarningBar.hidden = false;
  if (!isExpanded) setExpanded(true);
  notifTimer = setTimeout(() => {
    clearWarning();
    notifTimer = null;
  }, 8000);
}

function clearError(): void {
  if (!elErrorBar || !elErrorText) return;
  elErrorBar.hidden = true;
  elErrorText.textContent = '';
}

function clearWarning(): void {
  if (!elWarningBar || !elWarningText) return;
  elWarningBar.hidden = true;
  elWarningText.textContent = '';
}

export function clearMessage(): void {
  if (notifTimer !== null) {
    clearTimeout(notifTimer);
    notifTimer = null;
  }
  clearError();
  clearWarning();
}

/**
 * Update button enabled/disabled states.
 * - hasAnnotations controls export + delete-all.
 * - isAnnotating is kept for API back-compat but no longer toggles a Start/Exit
 *   button (the S button IS the mode toggle). Effectively: when isAnnotating
 *   is true the panel should be expanded.
 */
export function updateButtonStates(hasAnnotations: boolean, isAnnotating: boolean): void {
  if (elBtnExport) {
    // Export is always enabled — clicking with 0 annotations triggers a
    // "nothing to export" alert in content.ts. This matches the new design.
    elBtnExport.disabled = false;
  }
  if (elBtnDeleteAll) {
    // Delete-all is always enabled visually — content.ts no-ops when count=0.
    elBtnDeleteAll.disabled = false;
  }
  // Silence unused-arg lint in environments that flag it
  void hasAnnotations;
  void isAnnotating;
}

/**
 * Resolution alert — re-implemented on top of the warning/error bars.
 * unresolvedCount === total (>0) → error
 * 0 < unresolvedCount < total    → warning
 * otherwise                      → clear both
 */
export function showResolutionAlert(unresolvedCount: number, total: number): void {
  if (unresolvedCount === 0 || total === 0) {
    clearError();
    clearWarning();
    return;
  }
  if (unresolvedCount === total) {
    if (!elErrorBar || !elErrorText) return;
    elErrorText.textContent = 'none of the annotations could be placed on this page.';
    elErrorBar.hidden = false;
    if (elWarningBar) elWarningBar.hidden = true;
  } else {
    if (!elWarningBar || !elWarningText) return;
    elWarningText.textContent = `${unresolvedCount} of ${total} annotations couldn't be placed on this page.`;
    elWarningBar.hidden = false;
    if (elErrorBar) elErrorBar.hidden = true;
  }
}

/** Native browser confirm — kept lowercase per spec. */
export function showConfirmDialog(message: string): Promise<boolean> {
  return Promise.resolve(window.confirm(message));
}

/** Back-compat no-op. */
export function setAnnotationCount(_count: number): void {
  // intentionally empty
}

/**
 * Returns true if the given viewport coordinates land on any visible part of
 * the toolbar widget (S button or expanded panel). Used by annotationMode.ts
 * to guard against intercepting toolbar button clicks.
 *
 * We use this coordinate approach because composedPath() from a document-level
 * capture listener is unreliable when the shadow host has pointer-events:none
 * and a zero bounding box — Chrome may not include the host in the composed
 * path in that configuration.
 */
export function isPointOnToolbar(x: number, y: number): boolean {
  const hit = (el: HTMLElement | null): boolean => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 &&
      x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  return hit(elSButton) || hit(elToolbarPanel) || hit(elFilenameBar) ||
         hit(elWarningBar) || hit(elErrorBar);
}

export function destroyToolbar(): void {
  if (notifTimer !== null) {
    clearTimeout(notifTimer);
    notifTimer = null;
  }
  if (toolbarHost && toolbarHost.parentNode) {
    toolbarHost.parentNode.removeChild(toolbarHost);
  }
  toolbarHost = null;
  toolbarShadow = null;
  elSButton = null;
  elToolbarPanel = null;
  elFilenameBar = null;
  elFilenameText = null;
  elFilenameDismissBtn = null;
  elWarningBar = null;
  elWarningText = null;
  elErrorBar = null;
  elErrorText = null;
  elBtnExport = null;
  elBtnUpload = null;
  elBtnDeleteAll = null;
  elBtnExit = null;
  elFileInput = null;
  callbacksRef = null;
  isExpanded = false;
}
