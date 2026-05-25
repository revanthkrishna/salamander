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
  const MULTIPLE = 'pins may not work properly. this page contains dynamic content.';

  test('0 issues → empty string', () => {
    expect(combineIssueMessages([])).toBe('');
  });

  test('1 issue → that exact message', () => {
    const issues: DetectedIssue[] = [{ type: 'iframe', message: 'm1' }];
    expect(combineIssueMessages(issues)).toBe('m1');
  });

  test('2 issues → generic catch-all (individual messages collapsed)', () => {
    const issues: DetectedIssue[] = [
      { type: 'iframe', message: 'a-msg' },
      { type: 'canvas', message: 'b-msg' },
    ];
    expect(combineIssueMessages(issues)).toBe(MULTIPLE);
  });

  test('3 issues → same generic catch-all', () => {
    const issues: DetectedIssue[] = [
      { type: 'iframe', message: 'a' },
      { type: 'canvas', message: 'b' },
      { type: 'closedShadow', message: 'c' },
    ];
    expect(combineIssueMessages(issues)).toBe(MULTIPLE);
  });

  test('4 issues → still the same generic catch-all', () => {
    const issues: DetectedIssue[] = [
      { type: 'iframe', message: 'a' },
      { type: 'canvas', message: 'b' },
      { type: 'closedShadow', message: 'c' },
      { type: 'spa', message: 'd' },
    ];
    expect(combineIssueMessages(issues)).toBe(MULTIPLE);
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
// detectClosedShadowRoots (heuristic)
// ─────────────────────────────────────────────────────────────────────────────

describe('detectClosedShadowRoots', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  test('regular div → ignored', () => {
    document.body.innerHTML = '<div>hello</div>';
    expect(detectPageLimitations(DEFAULT_DETECTOR_CONFIG)).toEqual([]);
  });

  test('custom element with OPEN shadow root + rendered content → ignored', () => {
    document.body.innerHTML = '<my-widget></my-widget>';
    const el = document.querySelector('my-widget')!;
    const sr = el.attachShadow({ mode: 'open' });
    sr.innerHTML = '<span>visible</span>';
    expect(detectPageLimitations(DEFAULT_DETECTOR_CONFIG)).toEqual([]);
  });

  test('custom element with light-DOM children → ignored', () => {
    document.body.innerHTML = '<my-thing><span>child</span></my-thing>';
    expect(detectPageLimitations(DEFAULT_DETECTOR_CONFIG)).toEqual([]);
  });

  test('empty custom element with non-zero size → flagged', () => {
    document.body.innerHTML = '<closed-widget></closed-widget>';
    const issues = detectPageLimitations(DEFAULT_DETECTOR_CONFIG);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('closedShadow');
    expect(issues[0].count).toBe(1);
  });

  test('closedShadow disabled in config → not reported', () => {
    document.body.innerHTML = '<closed-widget></closed-widget>';
    const issues = detectPageLimitations({
      ...DEFAULT_DETECTOR_CONFIG,
      closedShadow: false,
    });
    expect(issues).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detectSpa (framework sniff — init only)
// ─────────────────────────────────────────────────────────────────────────────

describe('detectSpa', () => {
  // Track every window global we touch so we can scrub it in afterEach. Test
  // isolation matters here — these are real globals on the jsdom window and
  // they will absolutely bleed across tests if we forget (see pitfall E).
  const windowKeysToScrub: string[] = [];

  function setWindowFlag(key: string, value: unknown): void {
    (window as unknown as Record<string, unknown>)[key] = value;
    windowKeysToScrub.push(key);
  }

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    while (windowKeysToScrub.length) {
      const k = windowKeysToScrub.pop()!;
      delete (window as unknown as Record<string, unknown>)[k];
    }
  });

  test('plain page → no SPA issue', () => {
    expect(detectPageLimitations(DEFAULT_DETECTOR_CONFIG)).toEqual([]);
  });

  test('window.React present → flagged', () => {
    setWindowFlag('React', {});
    const issues = detectPageLimitations(DEFAULT_DETECTOR_CONFIG);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('spa');
  });

  test('window.__REACT_DEVTOOLS_GLOBAL_HOOK__ present → flagged', () => {
    setWindowFlag('__REACT_DEVTOOLS_GLOBAL_HOOK__', {});
    const issues = detectPageLimitations(DEFAULT_DETECTOR_CONFIG);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('spa');
  });

  test('[data-reactroot] in DOM → flagged', () => {
    document.body.innerHTML = '<div data-reactroot></div>';
    const issues = detectPageLimitations(DEFAULT_DETECTOR_CONFIG);
    expect(issues.some((i) => i.type === 'spa')).toBe(true);
  });

  test('#__next (Next.js) in DOM → flagged', () => {
    document.body.innerHTML = '<div id="__next"></div>';
    const issues = detectPageLimitations(DEFAULT_DETECTOR_CONFIG);
    expect(issues.some((i) => i.type === 'spa')).toBe(true);
  });

  test('[data-react-helmet] in DOM → flagged', () => {
    document.head.innerHTML = '<meta data-react-helmet="true">';
    const issues = detectPageLimitations(DEFAULT_DETECTOR_CONFIG);
    expect(issues.some((i) => i.type === 'spa')).toBe(true);
    // tidy up document.head ourselves — afterEach only clears body.
    document.head.innerHTML = '';
  });

  test('window.Vue present → flagged', () => {
    setWindowFlag('Vue', {});
    const issues = detectPageLimitations(DEFAULT_DETECTOR_CONFIG);
    expect(issues.some((i) => i.type === 'spa')).toBe(true);
  });

  test('window.__VUE__ present → flagged', () => {
    setWindowFlag('__VUE__', {});
    const issues = detectPageLimitations(DEFAULT_DETECTOR_CONFIG);
    expect(issues.some((i) => i.type === 'spa')).toBe(true);
  });

  test('[data-v-app] (Vue 3) in DOM → flagged', () => {
    document.body.innerHTML = '<div data-v-app></div>';
    expect(
      detectPageLimitations(DEFAULT_DETECTOR_CONFIG).some((i) => i.type === 'spa')
    ).toBe(true);
  });

  test('#__nuxt in DOM → flagged', () => {
    document.body.innerHTML = '<div id="__nuxt"></div>';
    expect(
      detectPageLimitations(DEFAULT_DETECTOR_CONFIG).some((i) => i.type === 'spa')
    ).toBe(true);
  });

  test('[data-server-rendered] in DOM → flagged', () => {
    document.body.innerHTML = '<div data-server-rendered="true"></div>';
    expect(
      detectPageLimitations(DEFAULT_DETECTOR_CONFIG).some((i) => i.type === 'spa')
    ).toBe(true);
  });

  test('window.ng (Angular) present → flagged', () => {
    setWindowFlag('ng', {});
    const issues = detectPageLimitations(DEFAULT_DETECTOR_CONFIG);
    expect(issues.some((i) => i.type === 'spa')).toBe(true);
  });

  test('[ng-version] in DOM → flagged', () => {
    document.body.innerHTML = '<div ng-version="17.0.0"></div>';
    expect(
      detectPageLimitations(DEFAULT_DETECTOR_CONFIG).some((i) => i.type === 'spa')
    ).toBe(true);
  });

  test('[ng-app] in DOM → flagged', () => {
    document.body.innerHTML = '<div ng-app></div>';
    expect(
      detectPageLimitations(DEFAULT_DETECTOR_CONFIG).some((i) => i.type === 'spa')
    ).toBe(true);
  });

  test('[data-sveltekit-preload-data] in DOM → flagged', () => {
    document.body.innerHTML = '<a data-sveltekit-preload-data="hover">x</a>';
    expect(
      detectPageLimitations(DEFAULT_DETECTOR_CONFIG).some((i) => i.type === 'spa')
    ).toBe(true);
  });

  test('window.Ember present → flagged', () => {
    setWindowFlag('Ember', {});
    const issues = detectPageLimitations(DEFAULT_DETECTOR_CONFIG);
    expect(issues.some((i) => i.type === 'spa')).toBe(true);
  });

  test('spa disabled in config → not reported even when signals present', () => {
    setWindowFlag('React', {});
    const issues = detectPageLimitations({
      ...DEFAULT_DETECTOR_CONFIG,
      spa: false,
    });
    expect(issues).toEqual([]);
  });

  test('test isolation: previous test\'s window.React does not leak', () => {
    // If our afterEach scrubbing is wrong, the React flag from earlier tests
    // would survive and this assertion would fail.
    expect(
      detectPageLimitations(DEFAULT_DETECTOR_CONFIG).some((i) => i.type === 'spa')
    ).toBe(false);
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

  test('multiple issues: combined message is the generic catch-all', () => {
    document.body.innerHTML =
      '<iframe data-w="500" data-h="500" src="about:blank"></iframe>' +
      '<canvas data-w="500" data-h="500"></canvas>';
    const issues = detectPageLimitations(DEFAULT_DETECTOR_CONFIG);
    expect(issues).toHaveLength(2);
    expect(combineIssueMessages(issues)).toBe(
      'pins may not work properly. this page contains dynamic content.'
    );
  });

  test('all four detectors firing → stable order iframe, canvas, closedShadow, spa', () => {
    document.body.innerHTML =
      // intentionally not in detector order
      '<closed-widget></closed-widget>' +
      '<canvas data-w="500" data-h="500"></canvas>' +
      '<iframe data-w="500" data-h="500" src="about:blank"></iframe>' +
      '<div data-reactroot></div>';
    const issues = detectPageLimitations(DEFAULT_DETECTOR_CONFIG);
    expect(issues.map((i) => i.type)).toEqual([
      'iframe',
      'canvas',
      'closedShadow',
      'spa',
    ]);
    expect(combineIssueMessages(issues)).toBe(
      'pins may not work properly. this page contains dynamic content.'
    );
  });
});
