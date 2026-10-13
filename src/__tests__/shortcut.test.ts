// The add-note keyboard shortcut's matching and "is the user typing" rules
// (src/shortcut.ts). Its wiring into content.ts is covered in content.test.ts.

import { addNoteShortcutLabel, isAddNoteShortcut, isTypingTarget } from '../shortcut';

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', { code: 'KeyN', key: 'Dead', altKey: true, ...init });
}

describe('isAddNoteShortcut', () => {
  test('Option/Alt+N matches on the physical key, whatever character it reports', () => {
    expect(isAddNoteShortcut(key({}))).toBe(true); // macOS: the tilde dead key
    expect(isAddNoteShortcut(key({ key: 'n' }))).toBe(true); // Windows
    expect(isAddNoteShortcut(key({ key: '˜' }))).toBe(true);
  });

  test('other keys and modifier mixes do not match', () => {
    expect(isAddNoteShortcut(key({ code: 'KeyM' }))).toBe(false);
    expect(isAddNoteShortcut(key({ altKey: false }))).toBe(false);
    expect(isAddNoteShortcut(key({ ctrlKey: true }))).toBe(false); // AltGr on Windows
    expect(isAddNoteShortcut(key({ metaKey: true }))).toBe(false);
    expect(isAddNoteShortcut(key({ shiftKey: true }))).toBe(false);
  });

  test('a held key and IME composition do not match', () => {
    expect(isAddNoteShortcut(key({ repeat: true }))).toBe(false);
    expect(isAddNoteShortcut(key({ isComposing: true }))).toBe(false);
  });
});

describe('addNoteShortcutLabel', () => {
  const original = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform');
  afterEach(() => {
    if (original) Object.defineProperty(Navigator.prototype, 'platform', original);
  });
  function platform(p: string): void {
    Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => p });
  }

  test('⌥N on a Mac, Alt+N elsewhere', () => {
    platform('MacIntel');
    expect(addNoteShortcutLabel()).toBe('⌥N');
    platform('Win32');
    expect(addNoteShortcutLabel()).toBe('Alt+N');
  });
});

describe('isTypingTarget', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('text inputs, textareas, selects and editable regions count as typing', () => {
    for (const html of ['<input type="text">', '<input type="search">', '<textarea></textarea>', '<select><option>a</option></select>', '<div contenteditable="true" tabindex="0">x</div>']) {
      document.body.innerHTML = html;
      (document.body.firstElementChild as HTMLElement).focus();
      expect(isTypingTarget()).toBe(true);
    }
  });

  test('buttons, checkboxes and the page body do not', () => {
    document.body.innerHTML = '<button>b</button><input type="checkbox">';
    expect(isTypingTarget()).toBe(false);
    (document.querySelector('button') as HTMLElement).focus();
    expect(isTypingTarget()).toBe(false);
    (document.querySelector('input') as HTMLElement).focus();
    expect(isTypingTarget()).toBe(false);
  });

  test('focus inside an open shadow root is followed to the real field', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<input type="text">';
    (root.querySelector('input') as HTMLElement).focus();
    expect(isTypingTarget()).toBe(true);
  });
});
