// The emitted CSS, byte for byte (architecture review A1/T11). Every
// stylesheet salamander puts on a page is compared with a golden file in
// __golden__/: the sidebar's shadow root (theme tokens, the panel, the
// enlarged view and the tooltip), add mode's shadow root (theme tokens, add
// mode and the tooltip) and the page-resize sheet on <html>, as shipped:
// with the stylesheets' comments stripped, as the bundle strips them
// (build/stripCssComments.js, wired into jest by
// build/jestStripCssTransform.js). A refactor that moves CSS between modules
// must leave these unchanged; a deliberate visual change regenerates them
// with `UPDATE_GOLDEN=1 npx jest emittedCss` and the diff is reviewed as CSS.

import * as fs from 'fs';
import * as path from 'path';

const GOLDEN_DIR = path.join(__dirname, '__golden__');

function matchesGolden(name: string, actual: string): void {
  // The stylesheets' comments are stripped at build time
  // (build/stripCssComments.js): none may ship.
  expect(actual).not.toMatch(/\/\*|\*\//);
  const file = path.join(GOLDEN_DIR, name);
  if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(file, actual);
  expect(fs.existsSync(file)).toBe(true);
  // A plain string comparison: a mismatch prints the first differing line.
  expect(actual).toBe(fs.readFileSync(file, 'utf8'));
}

const originalAttachShadow = HTMLElement.prototype.attachShadow;
beforeAll(() => {
  HTMLElement.prototype.attachShadow = function (init: ShadowRootInit) {
    return originalAttachShadow.call(this, { ...init, mode: 'open' });
  };
});
afterAll(() => {
  HTMLElement.prototype.attachShadow = originalAttachShadow;
});

function styleOf(hostId: string): string {
  const host = document.getElementById(hostId);
  const style = host?.shadowRoot?.querySelector('style');
  return style?.textContent ?? '';
}

describe('emitted CSS (golden)', () => {
  let sidebar: typeof import('../sidebar');
  let addMode: typeof import('../addMode');

  beforeEach(() => {
    jest.resetModules();
    document.documentElement.innerHTML = '<head></head><body></body>';
    sidebar = require('../sidebar');
    addMode = require('../addMode');
  });

  afterEach(() => {
    addMode.exitAddMode();
    sidebar.destroySidebar();
  });

  test("the sidebar's shadow root", () => {
    sidebar.initSidebar({ onAdd() {}, onExport() {}, onImport() {}, onImportFile() {}, onDeleteAll() {}, onClose() {}, onOpenItem() {} });
    const css = styleOf('annotator-sidebar-host');
    expect(css.length).toBeGreaterThan(1000);
    matchesGolden('sidebar-root.css', css);
  });

  test("add mode's shadow root", () => {
    addMode.startAddMode({ onOk() {}, onCancel() {} });
    const css = styleOf('annotator-addmode-host');
    expect(css.length).toBeGreaterThan(1000);
    matchesGolden('addmode-root.css', css);
  });

  test('the page-resize sheet on <html>', () => {
    sidebar.initSidebar({ onAdd() {}, onExport() {}, onImport() {}, onImportFile() {}, onDeleteAll() {}, onClose() {}, onOpenItem() {} });
    sidebar.openSidebar();
    const sheet = document.getElementById('annotator-page-resize')?.textContent ?? '';
    expect(sheet).not.toBe('');
    matchesGolden('page-resize.css', sheet);
  });
});
