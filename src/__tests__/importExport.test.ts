import { importFile } from '../importExport';
import type { ImportCallbacks } from '../importExport';

// Helper: create mock callbacks
const makeCallbacks = (overrides: Partial<ImportCallbacks> = {}): ImportCallbacks => ({
  showConfirm: jest.fn().mockResolvedValue(true),
  getAnnotationCount: jest.fn().mockResolvedValue(0),
  getCurrentDomain: jest.fn().mockReturnValue('example.com'),
  onImportSuccess: jest.fn(),
  showError: jest.fn(),
  showWarning: jest.fn(),
  ...overrides,
});

function makeFile(content: string, name = 'test.yaml', type = 'text/yaml'): File {
  return new File([content], name, { type });
}

const validYaml = `
version: 1
exported_at: "2026-05-14T00:00:00.000Z"
domain: "example.com"
annotations:
  - pin_number: 1
    page_url: "https://example.com/page"
    note: "test note"
    fingerprint:
      css_selector: "#main > p"
      xpath: "/html/body/p"
      text_snippet: "test"
      tag_name: "p"
    offset:
      x: 10
      y: 20
    created_at: "2026-05-14T00:00:00.000Z"
`;

describe('importFile - error handling', () => {
  test('rejects wrong file type (.json)', async () => {
    const cb = makeCallbacks();
    await importFile(makeFile('{}', 'test.json', 'application/json'), cb);
    expect(cb.showError).toHaveBeenCalledWith(
      expect.stringContaining('Invalid file type')
    );
    expect(cb.onImportSuccess).not.toHaveBeenCalled();
  });

  test('rejects wrong file type (.txt)', async () => {
    const cb = makeCallbacks();
    await importFile(makeFile('hello', 'test.txt', 'text/plain'), cb);
    expect(cb.showError).toHaveBeenCalledWith(
      expect.stringContaining('Invalid file type')
    );
  });

  test('accepts .yml extension', async () => {
    const cb = makeCallbacks();
    const ymlContent = validYaml.trim();
    await importFile(makeFile(ymlContent, 'annotations-example_com.yml'), cb);
    // Should NOT error on file type
    const errorCalls = (cb.showError as jest.Mock).mock.calls;
    const typeErrors = errorCalls.filter(([msg]: [string]) => msg.includes('Invalid file type'));
    expect(typeErrors).toHaveLength(0);
  });

  test('rejects empty file', async () => {
    const cb = makeCallbacks();
    await importFile(makeFile('', 'test.yaml'), cb);
    expect(cb.showError).toHaveBeenCalledWith(
      expect.stringContaining('empty')
    );
  });

  test('rejects whitespace-only file', async () => {
    const cb = makeCallbacks();
    await importFile(makeFile('   \n  \t  ', 'test.yaml'), cb);
    expect(cb.showError).toHaveBeenCalledWith(
      expect.stringContaining('empty')
    );
  });

  test('rejects malformed YAML', async () => {
    const cb = makeCallbacks();
    await importFile(makeFile(': : invalid yaml {{{{', 'test.yaml'), cb);
    expect(cb.showError).toHaveBeenCalledWith(
      expect.stringContaining('corrupted or incorrectly formatted')
    );
  });

  test('rejects wrong schema (missing version/domain/annotations)', async () => {
    const cb = makeCallbacks();
    await importFile(makeFile('name: "not an annotator file"', 'test.yaml'), cb);
    expect(cb.showError).toHaveBeenCalledWith(
      expect.stringContaining("doesn't look like an Annotator file")
    );
  });

  test('rejects empty annotations array', async () => {
    const cb = makeCallbacks();
    const yaml = 'version: 1\ndomain: "example.com"\nannotations: []\nexported_at: "2026-05-14T00:00:00Z"';
    await importFile(makeFile(yaml, 'test.yaml'), cb);
    expect(cb.showError).toHaveBeenCalledWith(
      expect.stringContaining('no annotations')
    );
  });

  test('rejects domain mismatch', async () => {
    const cb = makeCallbacks({ getCurrentDomain: jest.fn().mockReturnValue('other.com') });
    await importFile(makeFile(validYaml, 'test.yaml'), cb);
    expect(cb.showError).toHaveBeenCalledWith(
      expect.stringContaining('example.com')
    );
    expect(cb.onImportSuccess).not.toHaveBeenCalled();
  });

  test('rejects duplicate pin numbers', async () => {
    const cb = makeCallbacks();
    const yaml = `
version: 1
exported_at: "2026-05-14T00:00:00Z"
domain: "example.com"
annotations:
  - pin_number: 1
    page_url: "https://example.com/"
    note: "first"
    fingerprint:
      css_selector: "p"
      xpath: "/html/body/p"
      text_snippet: ""
      tag_name: "p"
    offset: {x: 0, y: 0}
    created_at: "2026-05-14T00:00:00Z"
  - pin_number: 1
    page_url: "https://example.com/"
    note: "duplicate!"
    fingerprint:
      css_selector: "p"
      xpath: "/html/body/p"
      text_snippet: ""
      tag_name: "p"
    offset: {x: 0, y: 0}
    created_at: "2026-05-14T00:00:00Z"
`;
    await importFile(makeFile(yaml, 'test.yaml'), cb);
    expect(cb.showError).toHaveBeenCalledWith(
      expect.stringContaining('duplicate pin numbers')
    );
    expect(cb.onImportSuccess).not.toHaveBeenCalled();
  });

  test('shows warning for version mismatch but calls onImportSuccess', async () => {
    const cb = makeCallbacks();
    const yaml = validYaml.replace('version: 1', 'version: 99');
    await importFile(makeFile(yaml, 'annotations-example_com.yaml'), cb);
    expect(cb.showWarning).toHaveBeenCalledWith(
      expect.stringContaining('newer version')
    );
    expect(cb.onImportSuccess).toHaveBeenCalled();
  });

  test('shows confirmation when annotations exist (count > 0)', async () => {
    const cb = makeCallbacks({ getAnnotationCount: jest.fn().mockResolvedValue(5) });
    await importFile(makeFile(validYaml, 'annotations-example_com.yaml'), cb);
    expect(cb.showConfirm).toHaveBeenCalledWith(
      expect.stringContaining('replace')
    );
  });

  test('aborts if user cancels confirmation', async () => {
    const cb = makeCallbacks({
      getAnnotationCount: jest.fn().mockResolvedValue(3),
      showConfirm: jest.fn().mockResolvedValue(false),
    });
    await importFile(makeFile(validYaml, 'annotations-example_com.yaml'), cb);
    expect(cb.onImportSuccess).not.toHaveBeenCalled();
    expect(cb.showError).not.toHaveBeenCalled();
  });

  test('does not show confirmation when no existing annotations', async () => {
    const cb = makeCallbacks({ getAnnotationCount: jest.fn().mockResolvedValue(0) });
    await importFile(makeFile(validYaml, 'annotations-example_com.yaml'), cb);
    expect(cb.showConfirm).not.toHaveBeenCalled();
  });

  test('succeeds with valid file — calls onImportSuccess with filename', async () => {
    const cb = makeCallbacks();
    await importFile(makeFile(validYaml, 'annotations-example_com.yaml'), cb);
    expect(cb.onImportSuccess).toHaveBeenCalledWith('annotations-example_com.yaml');
    expect(cb.showError).not.toHaveBeenCalled();
  });

  test('rejects file larger than 8MB', async () => {
    const cb = makeCallbacks();
    // Create a mock file with artificially large size
    const bigFile = new File(['x'], 'test.yaml', { type: 'text/yaml' });
    Object.defineProperty(bigFile, 'size', { value: 9 * 1024 * 1024 });
    await importFile(bigFile, cb);
    expect(cb.showError).toHaveBeenCalledWith(
      expect.stringContaining('too large')
    );
  });

  test('domain mismatch error message includes both domains', async () => {
    const cb = makeCallbacks({ getCurrentDomain: jest.fn().mockReturnValue('other.com') });
    await importFile(makeFile(validYaml, 'test.yaml'), cb);
    const errorMsg = (cb.showError as jest.Mock).mock.calls[0][0] as string;
    expect(errorMsg).toContain('example.com');
    expect(errorMsg).toContain('other.com');
  });

  test('succeeds when domain is www.example.com (normalised to example.com)', async () => {
    // The YAML says domain: example.com; the tab is on www.example.com — should match
    const cb = makeCallbacks({ getCurrentDomain: jest.fn().mockReturnValue('www.example.com') });
    await importFile(makeFile(validYaml, 'annotations-example_com.yaml'), cb);
    expect(cb.showError).not.toHaveBeenCalled();
    expect(cb.onImportSuccess).toHaveBeenCalled();
  });

  test('rejects annotation with missing fingerprint', async () => {
    const cb = makeCallbacks();
    const yaml = `
version: 1
exported_at: "2026-05-14T00:00:00Z"
domain: "example.com"
annotations:
  - pin_number: 1
    page_url: "https://example.com/"
    note: "test"
    offset: {x: 0, y: 0}
    created_at: "2026-05-14T00:00:00Z"
`;
    await importFile(makeFile(yaml, 'test.yaml'), cb);
    expect(cb.showError).toHaveBeenCalledWith(
      expect.stringContaining("doesn't look like an Annotator file")
    );
  });

  test('rejects annotation with invalid pin_number (zero)', async () => {
    const cb = makeCallbacks();
    const yaml = `
version: 1
exported_at: "2026-05-14T00:00:00Z"
domain: "example.com"
annotations:
  - pin_number: 0
    page_url: "https://example.com/"
    note: "bad pin number"
    fingerprint:
      css_selector: "p"
      xpath: "/html/body/p"
      text_snippet: ""
      tag_name: "p"
    offset: {x: 0, y: 0}
    created_at: "2026-05-14T00:00:00Z"
`;
    await importFile(makeFile(yaml, 'test.yaml'), cb);
    expect(cb.showError).toHaveBeenCalledWith(
      expect.stringContaining("doesn't look like an Annotator file")
    );
  });
});
