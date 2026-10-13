// src/shortcut.ts
// The keyboard shortcut for "add note": Option+N on macOS, Alt+N elsewhere.
// It adds ONE note, exactly like a single click on the add button (never the
// kept-on switch), and only while the sidebar is open: salamander's content
// script only runs on a page once its icon has been clicked there.
//
// Matched on the physical key (`code`), not `key`: on macOS Option+N is the
// tilde dead key (`key` is "Dead"), and other layouts report other characters.
// Ctrl must be up, so AltGr (reported as Ctrl+Alt on Windows) still types its
// accented letters (Polish ń is AltGr+N). The shortcut never fires while the
// user is typing anywhere, so Option+N then n still types ñ.

const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
]);

/** Option+N / Alt+N, pressed once (not held), outside IME composition. */
export function isAddNoteShortcut(e: KeyboardEvent): boolean {
  if (e.code !== 'KeyN' || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
  if (e.repeat || e.isComposing || e.keyCode === 229) return false;
  return true;
}

function isMac(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.platform || '';
  return /mac/i.test(platform);
}

/** The keycap the add button's tooltip shows. */
export function addNoteShortcutLabel(): string {
  return isMac() ? '⌥N' : 'Alt+N';
}

/** True when keyboard focus is in something that takes typing: a text input,
 *  a textarea, a select or an editable region — followed through open shadow
 *  roots. A closed root (salamander's own host among them) stops the walk at
 *  its host, which is not itself editable; salamander has no text field
 *  outside add mode and the enlarged view, and the shortcut is off in both. */
export function isTypingTarget(doc: Document = document): boolean {
  let el: Element | null = doc.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  if (!el) return false;
  if (el instanceof HTMLElement && (el.isContentEditable || el.closest('[contenteditable]:not([contenteditable="false"])'))) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(el.type);
  return false;
}
