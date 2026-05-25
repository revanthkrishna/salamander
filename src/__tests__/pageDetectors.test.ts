import {
  detectPageLimitations,
  combineIssueMessages,
  DEFAULT_DETECTOR_CONFIG,
  type DetectedIssue,
} from '../pageDetectors';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-test override for getBoundingClientRect. jsdom's default returns a
 * zero-rect for every element, but the size threshold needs real numbers, so
 * we install a tag-aware mock that consults a data-w / data-h attribute.
 *
 * Returns a teardown function that restores the original prototype method.
 */
function mockBoundingRectFromDataAttrs(): () => void {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const w = parseFloat(this.getAttribute('data-w') ?? '0');
    const h = parseFloat(this.getAttribute('data-h') ?? '0');
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: w,
      bottom: h,
      width: w,
      height: h,
      toJSON: () => ({}),
    } as DOMRect;
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// combineIssueMessages
// ─────────────────────────────────────────────────────────────────────────────

describe('combineIssueMessages', () => {
  test('0 issues → empty string', () => {
    expect(combineIssueMessages([])).toBe('');
  });

  test('1 issue → that exact message', () => {
    const issues: DetectedIssue[] = [{ type: 'iframe', message: 'm1' }];
    expect(combineIssueMessages(issues)).toBe('m1');
  });

  test('2 issues → "heads up — {a} also, {b}"', () => {
    const issues: DetectedIssue[] = [
      { type: 'iframe', message: 'a-msg' },
      { type: 'canvas', message: 'b-msg' },
    ];
    expect(combineIssueMessages(issues)).toBe('heads up — a-msg also, b-msg');
  });

  test('3 issues → multi-issue preamble + space-joined messages', () => {
    const issues: DetectedIssue[] = [
      { type: 'iframe', message: 'a' },
      { type: 'canvas', message: 'b' },
      { type: 'closedShadow', message: 'c' },
    ];
    expect(combineIssueMessages(issues)).toBe(
      'heads up — this page has several things that can limit pinning: a b c'
    );
  });

  test('4 issues → same preamble, still space-joined', () => {
    const issues: DetectedIssue[] = [
      { type: 'iframe', message: 'a' },
      { type: 'canvas', message: 'b' },
      { type: 'closedShadow', message: 'c' },
      { type: 'spa', message: 'd' },
    ];
    expect(combineIssueMessages(issues)).toBe(
      'heads up — this page has several things that can limit pinning: a b c d'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detectIframes (via detectPageLimitations with only iframe enabled)
// ─────────────────────────────────────────────────────────────────────────────

describe('detectIframes', () => {
  let restoreRect: () => void;

  beforeEach(() => {
    document.body.innerHTML = '';
    restoreRect = mockBoundingRectFromDataAttrs();
  });

  afterEach(() => {
    restoreRect();
  });

  test('empty page → no issue', () => {
    const issues = detectPageLimitations(DEFAULT_DETECTOR_CONFIG);
    expect(issues).toEqual([]);
  });

  test('one large iframe → iframe issue with count=1', () => {
    document.body.innerHTML =
      '<iframe data-w="500" data-h="500" src="about:blank"></iframe>';
    const issues = detectPageLimitations(DEFAULT_DETECTOR_CONFIG);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('iframe');
    expect(issues[0].count).toBe(1);
  });

  test('two large iframes → single iframe issue with count=2', () => {
    document.body.innerHTML =
      '<iframe data-w="400" data-h="400" src="about:blank"></iframe>' +
      '<iframe data-w="600" data-h="600" src="about:blank"></iframe>';
    const issues = detectPageLimitations(DEFAULT_DETECTOR_CONFIG);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('iframe');
    expect(issues[0].count).toBe(2);
  });

  test('iframe below 200x200 threshold → no issue', () => {
    document.body.innerHTML =
      '<iframe data-w="50" data-h="50" src="about:blank"></iframe>';
    expect(detectPageLimitations(DEFAULT_DETECTOR_CONFIG)).toEqual([]);
  });

  test('iframe with display:none → no issue', () => {
    document.body.innerHTML =
      '<iframe data-w="500" data-h="500" style="display:none" src="about:blank"></iframe>';
    expect(detectPageLimitations(DEFAULT_DETECTOR_CONFIG)).toEqual([]);
  });

  test('iframe 199x199 (off-by-one under) → no issue', () => {
    document.body.innerHTML =
      '<iframe data-w="199" data-h="199" src="about:blank"></iframe>';
    expect(detectPageLimitations(DEFAULT_DETECTOR_CONFIG)).toEqual([]);
  });

  test('iframe 200x200 (boundary) → issue fires', () => {
    document.body.innerHTML =
      '<iframe data-w="200" data-h="200" src="about:blank"></iframe>';
    const issues = detectPageLimitations(DEFAULT_DETECTOR_CONFIG);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('iframe');
  });

  test('iframe 201x201 (off-by-one over) → issue fires', () => {
    document.body.innerHTML =
      '<iframe data-w="201" data-h="201" src="about:blank"></iframe>';
    const issues = detectPageLimitations(DEFAULT_DETECTOR_CONFIG);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('iframe');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detectCanvases (via detectPageLimitations with only canvas enabled)
// ─────────────────────────────────────────────────────────────────────────────

describe('detectCanvases', () => {
  let restoreRect: () => void;

  beforeEach(() => {
    document.body.innerHTML = '';
    restoreRect = mockBoundingRectFromDataAttrs();
  });

  afterEach(() => {
    restoreRect();
  });

  test('empty page → no issue', () => {
    expect(detectPageLimitations(DEFAULT_DETECTOR_CONFIG)).toEqual([]);
  });

  test('one large canvas → canvas issue with count=1', () => {
    document.body.innerHTML = '<canvas data-w="500" data-h="500"></canvas>';
    const issues = detectPageLimitations(DEFAULT_DETECTOR_CONFIG);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('canvas');
    expect(issues[0].count).toBe(1);
  });

  test('two large canvases → single canvas issue with count=2', () => {
    document.body.innerHTML =
      '<canvas data-w="400" data-h="400"></canvas>' +
      '<canvas data-w="600" data-h="600"></canvas>';
    const issues = detectPageLimitations(DEFAULT_DETECTOR_CONFIG);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('canvas');
    expect(issues[0].count).toBe(2);
  });

  test('canvas below 200x200 threshold → no issue', () => {
    document.body.innerHTML = '<canvas data-w="50" data-h="50"></canvas>';
    expect(detectPageLimitations(DEFAULT_DETECTOR_CONFIG)).toEqual([]);
  });

  test('canvas with display:none → no issue', () => {
    document.body.innerHTML =
      '<canvas data-w="500" data-h="500" style="display:none"></canvas>';
    expect(detectPageLimitations(DEFAULT_DETECTOR_CONFIG)).toEqual([]);
  });

  test('canvas 199x199 (off-by-one under) → no issue', () => {
    document.body.innerHTML = '<canvas data-w="199" data-h="199"></canvas>';
    expect(detectPageLimitations(DEFAULT_DETECTOR_CONFIG)).toEqual([]);
  });

  test('canvas 200x200 (boundary) → issue fires', () => {
    document.body.innerHTML = '<canvas data-w="200" data-h="200"></canvas>';
    const issues = detectPageLimitations(DEFAULT_DETECTOR_CONFIG);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('canvas');
  });

  test('canvas 201x201 (off-by-one over) → issue fires', () => {
    document.body.innerHTML = '<canvas data-w="201" data-h="201"></canvas>';
    const issues = detectPageLimitations(DEFAULT_DETECTOR_CONFIG);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('canvas');
  });

  test('canvas disabled in config → not reported', () => {
    document.body.innerHTML = '<canvas data-w="500" data-h="500"></canvas>';
    const issues = detectPageLimitations({
      ...DEFAULT_DETECTOR_CONFIG,
      canvas: false,
    });
    expect(issues).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detectPageLimitations — config + ordering
// ─────────────────────────────────────────────────────────────────────────────

describe('detectPageLimitations — config + ordering', () => {
  let restoreRect: () => void;

  beforeEach(() => {
    document.body.innerHTML = '';
    restoreRect = mockBoundingRectFromDataAttrs();
  });

  afterEach(() => {
    restoreRect();
  });

  test('iframe disabled in config → iframe not reported', () => {
    document.body.innerHTML =
      '<iframe data-w="500" data-h="500" src="about:blank"></iframe>';
    const issues = detectPageLimitations({
      ...DEFAULT_DETECTOR_CONFIG,
      iframe: false,
    });
    expect(issues).toEqual([]);
  });

  test('stable order: iframe before canvas regardless of DOM order', () => {
    document.body.innerHTML =
      '<canvas data-w="500" data-h="500"></canvas>' +
      '<iframe data-w="500" data-h="500" src="about:blank"></iframe>';
    const issues = detectPageLimitations(DEFAULT_DETECTOR_CONFIG);
    expect(issues.map((i) => i.type)).toEqual(['iframe', 'canvas']);
  });

  test('multiple issues: combined message uses 2-issue form', () => {
    document.body.innerHTML =
      '<iframe data-w="500" data-h="500" src="about:blank"></iframe>' +
      '<canvas data-w="500" data-h="500"></canvas>';
    const issues = detectPageLimitations(DEFAULT_DETECTOR_CONFIG);
    expect(issues).toHaveLength(2);
    const combined = combineIssueMessages(issues);
    expect(combined).toMatch(/^heads up — /);
    expect(combined).toContain(' also, ');
  });
});
