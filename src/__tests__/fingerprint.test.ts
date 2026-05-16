import { captureFingerprint, resolveElement } from '../fingerprint';

describe('captureFingerprint — CSS selector generation', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  test('uses ID when available', () => {
    document.body.innerHTML = '<div id="main"><p id="target">text</p></div>';
    const el = document.getElementById('target')!;
    const fp = captureFingerprint(el);
    expect(fp.cssSelector).toBe('#target');
  });

  test('uses data-testid when available', () => {
    document.body.innerHTML = '<div><button data-testid="submit-btn">Submit</button></div>';
    const el = document.querySelector('[data-testid="submit-btn"]')! as Element;
    const fp = captureFingerprint(el);
    expect(fp.cssSelector).toContain('data-testid');
    expect(fp.cssSelector).toContain('submit-btn');
  });

  test('falls back to nth-of-type for third paragraph', () => {
    document.body.innerHTML = '<div><p>one</p><p>two</p><p>three</p></div>';
    const el = document.querySelector('div > p:nth-of-type(3)')!;
    const fp = captureFingerprint(el);
    expect(fp.cssSelector).toContain('nth-of-type(3)');
  });

  test('rejects UUID data attribute as unstable', () => {
    document.body.innerHTML = '<button data-testid="3f8c5a1b-1234-1234-1234-1234567890ab">btn</button>';
    const el = document.querySelector('button')!;
    const fp = captureFingerprint(el);
    expect(fp.cssSelector).not.toContain('data-testid');
  });

  test('rejects purely numeric data attribute as unstable', () => {
    document.body.innerHTML = '<button data-id="12345">btn</button>';
    const el = document.querySelector('button')!;
    const fp = captureFingerprint(el);
    expect(fp.cssSelector).not.toContain('data-id');
  });

  test('stops at ID and does not continue walking up', () => {
    document.body.innerHTML = '<div id="container"><section><p>text</p></section></div>';
    const el = document.getElementById('container')!;
    const fp = captureFingerprint(el);
    expect(fp.cssSelector).toBe('#container');
  });

  test('captures text snippet', () => {
    document.body.innerHTML = '<p id="p1">Hello world, this is a test snippet.</p>';
    const el = document.getElementById('p1')!;
    const fp = captureFingerprint(el);
    expect(fp.textSnippet).toBe('Hello world, this is a test snippet.');
  });

  test('truncates text snippet to 50 chars', () => {
    document.body.innerHTML = `<p id="long">12345678901234567890123456789012345678901234567890EXTRA</p>`;
    const el = document.getElementById('long')!;
    const fp = captureFingerprint(el);
    expect(fp.textSnippet.length).toBeLessThanOrEqual(50);
    expect(fp.textSnippet).toBe('12345678901234567890123456789012345678901234567890');
  });

  test('captures tagName', () => {
    document.body.innerHTML = '<article id="a1">content</article>';
    const el = document.getElementById('a1')!;
    const fp = captureFingerprint(el);
    expect(fp.tagName).toBe('article');
  });

  test('captures XPath', () => {
    document.body.innerHTML = '<div><p>text</p></div>';
    const el = document.querySelector('p')!;
    const fp = captureFingerprint(el);
    expect(fp.xpath).toMatch(/^\/html\/body/);
    expect(fp.xpath).toContain('p');
  });

  test('single sibling — always emits nth-of-type(1) for determinism', () => {
    document.body.innerHTML = '<div><p>only child</p></div>';
    const el = document.querySelector('div > p')!;
    const fp = captureFingerprint(el);
    // Always emit a positional index, even for single siblings, so the
    // selector stays deterministic when same-tag siblings are added later.
    // (See DEEP_DIVE_B FP-2 / `segmentFor` in fingerprint.ts.)
    expect(fp.cssSelector).toContain('p:nth-of-type(1)');
    // And the selector is always body-anchored.
    expect(fp.cssSelector.startsWith('body > ')).toBe(true);
  });

  test('prefers data-testid over data-id', () => {
    document.body.innerHTML = '<button data-testid="my-btn" data-id="456abc">click</button>';
    const el = document.querySelector('button')!;
    const fp = captureFingerprint(el);
    expect(fp.cssSelector).toContain('data-testid');
  });
});

describe('resolveElement (round-trip)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  test('CSS selector round-trip via ID', () => {
    document.body.innerHTML = '<div id="content"><p>Hello world</p></div>';
    const el = document.querySelector('#content > p')!;
    const fp = captureFingerprint(el);
    const resolved = resolveElement(fp);
    expect(resolved).toBe(el);
  });

  test('XPath fallback when CSS selector not unique', () => {
    document.body.innerHTML = '<div><p>text</p></div><div><p>text</p></div>';
    const el = document.querySelectorAll('div > p')[1]!;
    const fp = captureFingerprint(el);
    // Force a non-unique CSS selector
    fp.cssSelector = 'div > p';
    const resolved = resolveElement(fp);
    // XPath should still find some element
    expect(resolved).not.toBeNull();
  });

  test('returns null for non-existent element', () => {
    document.body.innerHTML = '<div><p>some text</p></div>';
    const fp = {
      cssSelector: '#nonexistent-xyz-123',
      xpath: '/html/body/div[999]/p',
      textSnippet: '',
      tagName: 'p',
    };
    expect(resolveElement(fp)).toBeNull();
  });

  test('text content fallback when selector and XPath both fail', () => {
    document.body.innerHTML = '<section><p>The quick brown fox</p></section>';
    const el = document.querySelector('p')!;
    const fp = captureFingerprint(el);
    // Force failures on first two strategies
    fp.cssSelector = '#nonexistent';
    fp.xpath = '/html/body/invalid[999]';
    const resolved = resolveElement(fp);
    expect(resolved).toBe(el);
  });

  test('returns null when text snippet is empty and selector/xpath fail', () => {
    document.body.innerHTML = '<div></div>';
    const fp = {
      cssSelector: '#nonexistent',
      xpath: '/html/body/invalid[99]',
      textSnippet: '',
      tagName: 'p',
    };
    expect(resolveElement(fp)).toBeNull();
  });

  test('XPath round-trip for element without ID', () => {
    document.body.innerHTML = '<ul><li>one</li><li>two</li><li>three</li></ul>';
    const el = document.querySelectorAll('li')[2]!;
    const fp = captureFingerprint(el);
    expect(fp.xpath).toContain('li[3]');
    const resolved = resolveElement(fp);
    expect(resolved).toBe(el);
  });

  test('invalid CSS selector falls through to XPath', () => {
    document.body.innerHTML = '<div id="good"><p>text</p></div>';
    const el = document.querySelector('p')!;
    const fp = captureFingerprint(el);
    // Force invalid CSS selector
    fp.cssSelector = ':::invalid:::';
    const resolved = resolveElement(fp);
    // XPath should find it
    expect(resolved).not.toBeNull();
  });
});
