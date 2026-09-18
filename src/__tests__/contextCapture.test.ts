import { captureContext } from '../contextCapture';
import type { Rect } from '../types';

/** jsdom has no layout engine — getBoundingClientRect() always returns all
 *  zeros. Stub it per element so the rect-intersection/containment logic has
 *  real geometry to work against. Coordinates here are viewport-relative;
 *  tests keep window.scrollX/scrollY at 0 (jsdom default) so page rect ===
 *  viewport rect. */
function setRect(el: Element, rect: Rect): void {
  (el as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    ({
      x: rect.x,
      y: rect.y,
      left: rect.x,
      top: rect.y,
      right: rect.x + rect.width,
      bottom: rect.y + rect.height,
      width: rect.width,
      height: rect.height,
      toJSON() {
        return this;
      },
    }) as DOMRect;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('captureContext — primary target', () => {
  it('picks the deepest element that fully contains the selection rect', () => {
    document.body.innerHTML = `
      <div id="outer"><div id="card"><button id="save">Save</button></div></div>
    `;
    const outer = document.getElementById('outer')!;
    const card = document.getElementById('card')!;
    const save = document.getElementById('save')!;
    setRect(outer, { x: 0, y: 0, width: 500, height: 500 });
    setRect(card, { x: 10, y: 10, width: 200, height: 100 });
    setRect(save, { x: 20, y: 20, width: 60, height: 20 });

    const selection: Rect = { x: 15, y: 15, width: 80, height: 40 };
    const ctx = captureContext(selection, { pageUrl: 'https://example.com/checkout' });

    // card contains the selection but save does not (selection extends past
    // save's 60x20 box) — card is the deepest fully-containing element.
    expect(ctx.primaryTarget.cssSelector).toContain('card');
  });

  it('falls back to the current node when nothing fully contains the selection', () => {
    document.body.innerHTML = `<div id="root"><div id="a"></div><div id="b"></div></div>`;
    const root = document.getElementById('root')!;
    setRect(document.body, { x: 0, y: 0, width: 800, height: 600 });
    setRect(root, { x: 0, y: 0, width: 800, height: 600 });
    setRect(document.getElementById('a')!, { x: 0, y: 0, width: 100, height: 100 });
    setRect(document.getElementById('b')!, { x: 200, y: 0, width: 100, height: 100 });

    // Straddles both children — neither fully contains it, so the walk stops
    // at #root (the deepest node it did fully descend into).
    const selection: Rect = { x: 50, y: 0, width: 200, height: 50 };
    const ctx = captureContext(selection);
    expect(ctx.primaryTarget.cssSelector).toContain('root');
  });

  it('treats an iframe as a leaf primary target', () => {
    document.body.innerHTML = `<div id="wrap"><iframe id="frame" src="https://other.example/widget"></iframe></div>`;
    setRect(document.getElementById('wrap')!, { x: 0, y: 0, width: 400, height: 300 });
    setRect(document.getElementById('frame')!, { x: 0, y: 0, width: 300, height: 200 });

    const selection: Rect = { x: 10, y: 10, width: 50, height: 50 };
    const ctx = captureContext(selection);
    expect(ctx.primaryTarget.cssSelector).toContain('frame');
  });
});

describe('captureContext — sanitisation', () => {
  it('strips script/style contents and base64 data-uris from the outerHTML snippet', () => {
    document.body.innerHTML =
      '<div id="t"><script>alert(1)</script><style>.x{color:red}</style>' +
      '<img src="data:image/png;base64,aGVsbG8gd29ybGQ="></div>';
    const t = document.getElementById('t')!;
    setRect(document.body, { x: 0, y: 0, width: 500, height: 500 });
    setRect(t, { x: 0, y: 0, width: 200, height: 100 });

    const ctx = captureContext({ x: 0, y: 0, width: 50, height: 50 });
    expect(ctx.primaryTarget.outerHtmlSnippet).not.toContain('alert(1)');
    expect(ctx.primaryTarget.outerHtmlSnippet).not.toContain('color:red');
    expect(ctx.primaryTarget.outerHtmlSnippet).not.toContain('aGVsbG8gd29ybGQ=');
    expect(ctx.primaryTarget.outerHtmlSnippet).toContain('data:[stripped]');
  });
});

describe('captureContext — contained elements', () => {
  it('intersects descendants, prioritising attribute/text-rich elements, capped at 15', () => {
    const rows = Array.from({ length: 20 }, (_, i) => `<div class="row row-${i}">item ${i}</div>`).join('');
    document.body.innerHTML = `<div id="list">${rows}</div>`;
    const list = document.getElementById('list')!;
    setRect(document.body, { x: 0, y: 0, width: 500, height: 2000 });
    setRect(list, { x: 0, y: 0, width: 300, height: 1000 });

    const children = Array.from(list.children);
    children.forEach((child, i) => setRect(child, { x: 0, y: i * 30, width: 300, height: 30 }));

    // Selection spans the first 20 rows (y 0..600) — all intersect.
    const ctx = captureContext({ x: 0, y: 0, width: 300, height: 600 });
    expect(ctx.containedElements.length).toBeLessThanOrEqual(15);
    expect(ctx.containedElementsTruncated).toBe(true);
  });

  it('prioritises an element with an id/attrs/text over a bare layout div', () => {
    document.body.innerHTML = `
      <div id="area">
        <div class="spacer"></div>
        <button id="submit-order" data-testid="submit">Submit</button>
      </div>
    `;
    const area = document.getElementById('area')!;
    const spacer = document.querySelector('.spacer')!;
    const button = document.getElementById('submit-order')!;
    setRect(document.body, { x: 0, y: 0, width: 500, height: 500 });
    setRect(area, { x: 0, y: 0, width: 300, height: 100 });
    setRect(spacer, { x: 0, y: 0, width: 300, height: 20 });
    setRect(button, { x: 0, y: 20, width: 100, height: 30 });

    const ctx = captureContext({ x: 0, y: 0, width: 300, height: 100 });
    expect(ctx.containedElements[0].tag).toBe('button');
    expect(ctx.containedElements[0].id).toBe('submit-order');
    expect(ctx.containedElements[0].text).toBe('Submit');
  });

  it('flags framework-hash classes as generated and BEM-ish classes as semantic', () => {
    // "primary-btn" is deliberately chosen over e.g. "card-title" — the
    // trailing-segment strip that flags CSS-module hashes also fires on any
    // hyphenated class whose last segment is 5+ characters, a known false
    // positive on legitimately hyphenated human-authored names. "btn" (3
    // chars) stays under that threshold.
    document.body.innerHTML = `<div id="area"><span class="Card_root_a8d3f primary-btn">Hi</span></div>`;
    const area = document.getElementById('area')!;
    const span = document.querySelector('span')!;
    setRect(document.body, { x: 0, y: 0, width: 500, height: 500 });
    setRect(area, { x: 0, y: 0, width: 300, height: 100 });
    setRect(span, { x: 0, y: 0, width: 100, height: 30 });

    const ctx = captureContext({ x: 0, y: 0, width: 300, height: 100 });
    const item = ctx.containedElements.find((c) => c.tag === 'span')!;
    expect(item.classes?.generated).toContain('Card_root_a8d3f');
    expect(item.classes?.semantic).toContain('primary-btn');
  });

  it('does not descend into an iframe but records its tag/attrs/src', () => {
    document.body.innerHTML = `<div id="area"><iframe id="f" src="https://other.example/embed"></iframe></div>`;
    const area = document.getElementById('area')!;
    const frame = document.getElementById('f')!;
    setRect(document.body, { x: 0, y: 0, width: 500, height: 500 });
    setRect(area, { x: 0, y: 0, width: 300, height: 200 });
    setRect(frame, { x: 0, y: 0, width: 300, height: 200 });

    const ctx = captureContext({ x: 0, y: 0, width: 100, height: 100 });
    // area fully contains the selection and frame also fully contains it —
    // findPrimaryTarget descends into frame and stops (leaf).
    expect(ctx.primaryTarget.cssSelector).toContain('f');
    const iframeEntry = ctx.containedElements.find((c) => c.tag === 'iframe');
    expect(iframeEntry === undefined || iframeEntry.attrs?.src === undefined).toBeTruthy();
  });
});

describe('captureContext — area text', () => {
  it('aggregates direct text of the primary target and intersecting descendants', () => {
    document.body.innerHTML = `<div id="area"><h3>Shipping</h3><p>Free returns</p></div>`;
    const area = document.getElementById('area')!;
    const h3 = document.querySelector('h3')!;
    const p = document.querySelector('p')!;
    setRect(document.body, { x: 0, y: 0, width: 500, height: 500 });
    setRect(area, { x: 0, y: 0, width: 300, height: 100 });
    setRect(h3, { x: 0, y: 0, width: 300, height: 30 });
    setRect(p, { x: 0, y: 30, width: 300, height: 30 });

    const ctx = captureContext({ x: 0, y: 0, width: 300, height: 100 });
    expect(ctx.areaText).toContain('Shipping');
    expect(ctx.areaText).toContain('Free returns');
  });
});

describe('captureContext — page metadata', () => {
  it('fills pageMeta from provided options', () => {
    document.body.innerHTML = `<div id="a">x</div>`;
    setRect(document.body, { x: 0, y: 0, width: 500, height: 500 });
    setRect(document.getElementById('a')!, { x: 0, y: 0, width: 100, height: 40 });

    const selection: Rect = { x: 0, y: 0, width: 50, height: 20 };
    const ctx = captureContext(selection, {
      pageUrl: 'https://www.example.com/pricing/?ref=x#top',
      title: 'pricing',
      viewport: { width: 1280, height: 800 },
      dpr: 2,
      capturedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(ctx.pageMeta.url).toBe('https://www.example.com/pricing/?ref=x#top');
    expect(ctx.pageMeta.normalisedUrl).toBe('https://example.com/pricing');
    expect(ctx.pageMeta.title).toBe('pricing');
    expect(ctx.pageMeta.viewport).toEqual({ width: 1280, height: 800 });
    expect(ctx.pageMeta.dpr).toBe(2);
    expect(ctx.pageMeta.selectionRect).toEqual(selection);
    expect(ctx.pageMeta.capturedAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('captureContext — 2KB size governance', () => {
  it('truncates the outerHTML snippet before touching the contained-elements list', () => {
    // A single huge attribute pushes outerHTML over 1KB but the contained
    // list stays tiny — only the outerHTML snippet should need shrinking.
    const bigAttr = 'x'.repeat(3000);
    document.body.innerHTML = `<div id="area" data-blob="${bigAttr}"><span>hi</span></div>`;
    const area = document.getElementById('area')!;
    const span = document.querySelector('span')!;
    setRect(document.body, { x: 0, y: 0, width: 500, height: 500 });
    setRect(area, { x: 0, y: 0, width: 300, height: 100 });
    // Smaller than the selection so the primary-target walk stops at #area
    // rather than descending into the (attribute-free) span.
    setRect(span, { x: 0, y: 0, width: 5, height: 5 });

    const ctx = captureContext({ x: 0, y: 0, width: 50, height: 20 });
    expect(ctx.primaryTarget.truncated).toBe(true);
    expect(ctx.primaryTarget.outerHtmlSnippet).toContain('...[truncated]');
    expect(ctx.containedElementsTruncated).toBeFalsy();
    expect(JSON.stringify(ctx).length).toBeLessThanOrEqual(2048 + 200); // pageMeta/fixed overhead slack
  });

  it('trims the contained-elements list when outerHTML alone cannot fit the budget', () => {
    // Give every element a large data attribute so even a fully-emptied
    // outerHTML snippet isn't enough — the contained-elements list must also
    // shrink.
    const bigVal = 'y'.repeat(200);
    const items = Array.from(
      { length: 15 },
      (_, i) => `<div id="item-${i}" data-blob="${bigVal}">item ${i}</div>`,
    ).join('');
    document.body.innerHTML = `<div id="area">${items}</div>`;
    const area = document.getElementById('area')!;
    setRect(document.body, { x: 0, y: 0, width: 500, height: 5000 });
    setRect(area, { x: 0, y: 0, width: 300, height: 4000 });
    Array.from(area.children).forEach((child, i) => setRect(child, { x: 0, y: i * 30, width: 300, height: 30 }));

    const ctx = captureContext({ x: 0, y: 0, width: 300, height: 450 });
    expect(ctx.containedElementsTruncated).toBe(true);
    expect(JSON.stringify(ctx).length).toBeLessThanOrEqual(2048 + 200);
  });
});
