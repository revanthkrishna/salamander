import { normaliseUrl, normaliseDomain, exportFilename } from '../urlNorm';

describe('normaliseUrl', () => {
  // Full normalization example from TECH_DESIGN.md §2.4
  test('full normalization example', () => {
    expect(normaliseUrl('http://www.figma.com/blog/How-We-Built-Figma?ref=twitter#intro'))
      .toBe('https://figma.com/blog/How-We-Built-Figma');
  });

  // §6 Edge Case #16: www prefix
  test('strips www. prefix', () => {
    expect(normaliseUrl('https://www.example.com/page'))
      .toBe('https://example.com/page');
  });

  // Does NOT strip non-www subdomains
  test('keeps non-www subdomains', () => {
    expect(normaliseUrl('https://app.example.com/page'))
      .toBe('https://app.example.com/page');
  });

  // §6 Edge Case #14: trailing slash
  test('strips trailing slash from path', () => {
    expect(normaliseUrl('https://example.com/page/'))
      .toBe('https://example.com/page');
  });

  test('handles root URL trailing slash', () => {
    expect(normaliseUrl('https://example.com/'))
      .toBe('https://example.com');
  });

  // §6 Edge Case #15: URL case sensitivity
  test('preserves path case', () => {
    expect(normaliseUrl('https://example.com/Blog/Post'))
      .toBe('https://example.com/Blog/Post');
  });

  test('lowercases hostname', () => {
    expect(normaliseUrl('https://EXAMPLE.COM/page'))
      .toBe('https://example.com/page');
  });

  // §6 Edge Case #8: http → https
  test('normalises http to https', () => {
    expect(normaliseUrl('http://example.com/page'))
      .toBe('https://example.com/page');
  });

  // §6 Edge Case #7: strips query params
  test('strips query parameters', () => {
    expect(normaliseUrl('https://example.com/page?foo=bar&baz=1'))
      .toBe('https://example.com/page');
  });

  // Strips fragment
  test('strips fragments', () => {
    expect(normaliseUrl('https://example.com/page#section'))
      .toBe('https://example.com/page');
  });

  // §6 Edge Case #17: port numbers
  test('ignores port numbers', () => {
    expect(normaliseUrl('https://example.com:8080/page'))
      .toBe('https://example.com/page');
  });

  test('strips both query and fragment', () => {
    expect(normaliseUrl('https://example.com/path?q=1#anchor'))
      .toBe('https://example.com/path');
  });

  test('deep path preserved', () => {
    expect(normaliseUrl('https://example.com/a/b/c/d'))
      .toBe('https://example.com/a/b/c/d');
  });

  test('www with port and query', () => {
    expect(normaliseUrl('http://www.example.com:3000/path?x=1'))
      .toBe('https://example.com/path');
  });
});

describe('normaliseDomain', () => {
  test('strips www.', () => {
    expect(normaliseDomain('www.figma.com')).toBe('figma.com');
  });

  test('keeps app subdomain', () => {
    expect(normaliseDomain('app.example.com')).toBe('app.example.com');
  });

  test('lowercases', () => {
    expect(normaliseDomain('EXAMPLE.COM')).toBe('example.com');
  });

  test('strips port', () => {
    expect(normaliseDomain('example.com:3000')).toBe('example.com');
  });

  test('strips port 8080', () => {
    expect(normaliseDomain('example.com:8080')).toBe('example.com');
  });

  test('handles plain domain already normalised', () => {
    expect(normaliseDomain('figma.com')).toBe('figma.com');
  });

  test('keeps aws subdomain', () => {
    expect(normaliseDomain('aws.amazon.com')).toBe('aws.amazon.com');
  });
});

describe('exportFilename', () => {
  test('replaces dots with underscores', () => {
    expect(exportFilename('figma.com')).toBe('annotations-figma_com.yaml');
  });

  test('multi-part domain', () => {
    expect(exportFilename('app.example.com')).toBe('annotations-app_example_com.yaml');
  });

  test('simple tld', () => {
    expect(exportFilename('example.io')).toBe('annotations-example_io.yaml');
  });
});
