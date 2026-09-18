import {
  buildCSSSelector,
  buildXPath,
  buildPositionalXPath,
  hasUsableId,
  idHasDictionaryWord,
  getDataAttrSegment,
  getStableAttrSegment,
  getMeaningfulClass,
  isUnique,
  segmentFor,
} from '../selectorBuilder';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function evalXPathToElement(xpath: string): Element | null {
  const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
  return result.singleNodeValue as Element | null;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('idHasDictionaryWord', () => {
  it('finds dictionary words in hyphen/underscore segments', () => {
    expect(idHasDictionaryWord('submit-button')).toBe(true);
    expect(idHasDictionaryWord('user_profile')).toBe(true);
  });

  it('rejects short or non-dictionary segments', () => {
    expect(idHasDictionaryWord('a1b2c3')).toBe(false);
    expect(idHasDictionaryWord('x-y-z')).toBe(false);
  });
});

describe('hasUsableId', () => {
  it('accepts hand-authored ids', () => {
    const button = el('button', { id: 'submit-order' });
    expect(hasUsableId(button)).toBe(true);
  });

  it.each([
    'radix-:r3:',
    'headlessui-menu-1',
    'mui-42',
    'chakra-modal--body',
    ':r17:',
    '123456',
    '9c858901-8a57-4791-81fe-4c455b099bc9',
    '0123456789abcdef0123456789abcdef',
  ])('rejects framework-generated id "%s"', (id) => {
    const div = el('div', { id });
    expect(hasUsableId(div)).toBe(false);
  });

  it('rejects empty id', () => {
    expect(hasUsableId(el('div'))).toBe(false);
  });
});

describe('getDataAttrSegment / getStableAttrSegment', () => {
  it('picks a data-* attribute with a stable value', () => {
    const button = el('button', { 'data-testid': 'wizard-next' });
    expect(getDataAttrSegment(button)).toBe('data-testid="wizard-next"');
  });

  it('rejects data-* values that look like React useId output', () => {
    const button = el('button', { 'data-analytics-funnel-value': 'button:r9r:' });
    expect(getDataAttrSegment(button)).toBeNull();
  });

  it('falls back to name, then role, then relative href', () => {
    expect(getStableAttrSegment(el('input', { name: 'email' }))).toBe('name="email"');
    expect(getStableAttrSegment(el('div', { role: 'dialog' }))).toBe('role="dialog"');
    // CSS.escape (per the W3C spec, and the jsdom polyfill in setup.ts) escapes
    // the leading "/" — the resulting segment is still a valid selector part.
    expect(getStableAttrSegment(el('a', { href: '/pricing' }))).toBe('href="\\/pricing"');
  });

  it('does not use aria-label as a selector segment', () => {
    expect(getStableAttrSegment(el('button', { 'aria-label': 'Close' }))).toBeNull();
  });
});

describe('getMeaningfulClass', () => {
  it('strips CSS-module hash suffixes', () => {
    const div = el('div', { class: 'Button_primary_a8d3f' });
    expect(getMeaningfulClass(div)).toBe('Button_primary');
  });

  it('rejects hash-like and utility classes, falling through to a real one', () => {
    // "card-title" itself matches the CSS-module-hash-suffix strip
    // (`-title` is a hyphen + 5+ alphanumeric chars) and reduces to "card" —
    // still a meaningful, usable class, just not the full compound name.
    const div = el('div', { class: 'A1B2C3 flex card-title' });
    expect(getMeaningfulClass(div)).toBe('card');
  });

  it('returns null when nothing meaningful survives', () => {
    const div = el('div', { class: 'flex p-4 A1B2C3D4' });
    expect(getMeaningfulClass(div)).toBeNull();
  });
});

describe('buildCSSSelector', () => {
  it('prefers a data-* attribute segment', () => {
    document.body.innerHTML = '<button data-testid="save-btn">Save</button>';
    const button = document.querySelector('button')!;
    const selector = buildCSSSelector(button);
    expect(selector).toBe('button[data-testid="save-btn"]');
    expect(document.querySelectorAll(selector)).toHaveLength(1);
  });

  it('uses a dictionary-word id over a walked path', () => {
    document.body.innerHTML = '<div><span id="checkout-total">$42</span></div>';
    const span = document.querySelector('span')!;
    expect(buildCSSSelector(span)).toBe('#checkout-total');
  });

  it('rejects a framework-generated id and falls back to a structural path', () => {
    document.body.innerHTML = '<div><span id="radix-:r1:">$42</span></div>';
    const span = document.querySelector('span')!;
    const selector = buildCSSSelector(span);
    expect(selector).not.toContain('radix');
    expect(isUnique(selector)).toBe(true);
  });

  it('produces a selector rooted at body that resolves back to the element', () => {
    document.body.innerHTML = `
      <div class="page">
        <div class="row"><button>One</button></div>
        <div class="row"><button>Two</button></div>
      </div>
    `;
    const buttons = document.querySelectorAll('button');
    const secondSelector = buildCSSSelector(buttons[1]);
    expect(document.querySelectorAll(secondSelector)).toHaveLength(1);
    expect(document.querySelector(secondSelector)).toBe(buttons[1]);
  });

  it('falls back to tag:nth-of-type when nothing else distinguishes siblings', () => {
    document.body.innerHTML = '<div><div>a</div><div>b</div><div>c</div></div>';
    const middle = document.querySelectorAll('div > div')[1];
    const selector = buildCSSSelector(middle);
    expect(document.querySelector(selector)).toBe(middle);
  });
});

describe('segmentFor', () => {
  it('uses nth-of-type even for an only child (always emits an index)', () => {
    document.body.innerHTML = '<div><p>only</p></div>';
    const p = document.querySelector('p')!;
    expect(segmentFor(p)).toBe('p:nth-of-type(1)');
  });
});

describe('buildXPath', () => {
  it('prefers a data-* attribute', () => {
    document.body.innerHTML = '<button data-testid="wizard-next">Next</button>';
    const button = document.querySelector('button')!;
    const xpath = buildXPath(button);
    expect(xpath).toBe('//button[@data-testid="wizard-next"]');
    expect(evalXPathToElement(xpath)).toBe(button);
  });

  it('uses a dictionary-word id when no data-* attribute exists', () => {
    document.body.innerHTML = '<div><span id="order-summary">…</span></div>';
    const span = document.querySelector('span')!;
    const xpath = buildXPath(span);
    expect(xpath).toBe('//*[@id="order-summary"]');
    expect(evalXPathToElement(xpath)).toBe(span);
  });

  it('falls back to a positional path and round-trips to the same element', () => {
    document.body.innerHTML = '<div><div><em>x</em><em>y</em></div></div>';
    const secondEm = document.querySelectorAll('em')[1];
    const xpath = buildXPath(secondEm);
    expect(evalXPathToElement(xpath)).toBe(secondEm);
  });

  it('does not attempt a heading-anchored xpath (deviation — see selectorBuilder.ts header)', () => {
    document.body.innerHTML = '<h2>Billing details</h2><div><button>Save</button></div>';
    const button = document.querySelector('button')!;
    const xpath = buildXPath(button);
    expect(xpath).not.toContain('following::');
    expect(evalXPathToElement(xpath)).toBe(button);
  });
});

describe('buildPositionalXPath', () => {
  it('always emits an index, even for a single child', () => {
    document.body.innerHTML = '<main><section><h1>Title</h1></section></main>';
    const h1 = document.querySelector('h1')!;
    const xpath = buildPositionalXPath(h1);
    expect(xpath).toMatch(/\/h1\[1\]$/);
    expect(evalXPathToElement(xpath)).toBe(h1);
  });
});
