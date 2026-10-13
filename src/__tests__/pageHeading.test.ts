// A page's heading in the enlarged view (src/pageHeading.ts, design spec
// §AH): the address fitted to its room with a middle ellipsis, a cut-short
// name's tooltip, and every heading fitted in one layout pass. The rename
// itself is covered through the view (enlargedView.test.ts).

import { fitHeadings, PageHeading } from '../pageHeading';

function heading(url: string, name = 'Pricing'): PageHeading {
  const h = new PageHeading({
    url,
    isCurrent: false,
    defaultName: name,
    editedName: null,
    idPrefix: `h-${url.length}`,
    onRename: async () => 'saved',
    onNameChanged: () => {},
  });
  document.body.appendChild(h.el);
  return h;
}

/** jsdom has no layout: give an element the widths Chrome would. */
function widths(el: Element, client: number, scroll: number): void {
  Object.defineProperty(el, 'clientWidth', { value: client, configurable: true });
  Object.defineProperty(el, 'scrollWidth', { value: scroll, configurable: true });
}

afterEach(() => {
  document.body.innerHTML = '';
  jest.restoreAllMocks();
});

test('an address too long for its room is ellipsized in the middle to as many characters as fit', () => {
  const h = heading('https://example.com/blog/2026/10/how-we-built-it');
  const url = h.el.querySelector('.xp-page-url')!;
  widths(url, 72, 300); // room for ten 7.2px characters
  fitHeadings([h], 7.2);
  expect(url.textContent).toBe('examp…t-it');
});

test('an address that fits is shown whole, without its scheme', () => {
  const h = heading('https://example.com/a');
  const url = h.el.querySelector('.xp-page-url')!;
  widths(url, 200, 100);
  fitHeadings([h], 7.2);
  expect(url.textContent).toBe('example.com/a');
});

test('a name cut short by its cap gets a tooltip with all of it; a whole one has none', () => {
  const h = heading('https://example.com/a', 'a very long page name indeed');
  const name = h.el.querySelector<HTMLElement>('.xp-page-name')!;
  widths(name, 100, 260);
  fitHeadings([h], 7.2);
  expect(name.dataset.tip).toBe('a very long page name indeed');
  widths(name, 260, 260);
  fitHeadings([h], 7.2);
  expect(name.dataset.tip).toBeUndefined();
});

test('every heading is fitted in one layout: all the writes, then all the reads, then the writes', () => {
  const hs = [heading('https://example.com/a'), heading('https://example.com/bb'), heading('https://example.com/ccc')];
  const order: string[] = [];
  for (const [i, h] of hs.entries()) {
    const prepare = h.prepareFit.bind(h);
    const measure = h.measureFit.bind(h);
    const apply = h.applyFit.bind(h);
    jest.spyOn(h, 'prepareFit').mockImplementation(() => {
      order.push(`write${i}`);
      prepare();
    });
    jest.spyOn(h, 'measureFit').mockImplementation(() => {
      order.push(`read${i}`);
      return measure();
    });
    jest.spyOn(h, 'applyFit').mockImplementation((fit, charW) => {
      order.push(`apply${i}`);
      apply(fit, charW);
    });
  }
  fitHeadings(hs, 7.2);
  expect(order).toEqual(['write0', 'write1', 'write2', 'read0', 'read1', 'read2', 'apply0', 'apply1', 'apply2']);
});
