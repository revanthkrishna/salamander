// src/copy.ts — the §5 copy, byte-exact. REQUIREMENTS §5's rows are
// verbatim user-facing text (lowercase, §3.4); this file is what makes an
// edit to any of them a failing test rather than a silent drift.

import {
  CAPTURE_FAILED_MESSAGE,
  DELETE_ERROR_MESSAGE,
  DOMAIN_COUNT_FAILED_MESSAGE,
  EMPTY_NOTE_MESSAGE,
  EXPORT_FAILED_MESSAGE,
  FINISH_NOTE_FIRST_MESSAGE,
  IMAGE_LOAD_FAILED_MESSAGE,
  IMPORT_FAILED_MESSAGE,
  ITEM_LOAD_FAILED_MESSAGE,
  NOTHING_TO_EXPORT_MESSAGE,
  SAVE_ERROR_MESSAGE,
  importErrorMessage,
  importReplaceConfirmMessage,
  saveErrorFor,
} from '../copy';

describe('§5 import copy (verbatim)', () => {
  test.each([
    ['INVALID_FILE_TYPE', 'invalid file type. please upload a .zip feedback bundle.'],
    ['CORRUPT_ARCHIVE', 'could not read this file — it appears to be corrupted.'],
    ['MISSING_MANIFEST', "this doesn't look like a feedback bundle."],
    ['UNSUPPORTED_FORMAT', "this bundle was made by a different version of the extension and can't be imported."],
    ['MALFORMED_CONTEXT', "this bundle appears to be corrupted (couldn't read feedback data)."],
    ['MISSING_SCREENSHOT', "this file is missing screenshot data and can't be imported."],
    ['DUPLICATE_IDS', 'this bundle appears to be corrupted (duplicate item ids).'],
  ] as const)('%s', (code, expected) => {
    expect(importErrorMessage(code)).toBe(expected);
  });

  test('#5 domain mismatch fills in both domains', () => {
    expect(importErrorMessage('DOMAIN_MISMATCH', { fileDomain: 'a.example', currentDomain: 'b.example' })).toBe(
      "this bundle contains feedback for 'a.example', but you're currently on 'b.example'.",
    );
  });

  test('#10 confirmation', () => {
    expect(importReplaceConfirmMessage(3)).toBe(
      'importing will replace your current 3 feedback item(s) for this site. this cannot be undone. continue?',
    );
  });

  test('#7 and #8', () => {
    expect(NOTHING_TO_EXPORT_MESSAGE).toBe('nothing to export');
    expect(CAPTURE_FAILED_MESSAGE).toBe("couldn't capture a screenshot here. try again.");
  });
});

describe('the rest of the copy is lowercase and stable', () => {
  test.each([
    ITEM_LOAD_FAILED_MESSAGE,
    IMAGE_LOAD_FAILED_MESSAGE,
    SAVE_ERROR_MESSAGE,
    saveErrorFor(12),
    DELETE_ERROR_MESSAGE,
    EMPTY_NOTE_MESSAGE,
    FINISH_NOTE_FIRST_MESSAGE,
    EXPORT_FAILED_MESSAGE,
    DOMAIN_COUNT_FAILED_MESSAGE,
    IMPORT_FAILED_MESSAGE,
  ])('%s', (message) => {
    expect(message).toBe(message.toLowerCase());
    expect(message.endsWith('.') || message.endsWith('?')).toBe(true);
  });

  test('a save failure for another note names it', () => {
    expect(saveErrorFor(7)).toBe("couldn't save note #7. try again.");
    expect(SAVE_ERROR_MESSAGE).toBe("couldn't save note. try again.");
    expect(DELETE_ERROR_MESSAGE).toBe("couldn't delete item. try again.");
    expect(EMPTY_NOTE_MESSAGE).toBe("a note can't be empty. add some text to continue.");
  });
});
