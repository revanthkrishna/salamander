// build/stripCssComments.js: what the bundle (and, through
// build/jestStripCssTransform.js, these tests) remove from the stylesheets.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { stripCssComments, stripTemplateText } = require('../../build/stripCssComments') as {
  stripCssComments: (source: string, fileName?: string) => string;
  stripTemplateText: (text: string, where: string) => string;
};

describe('stripTemplateText', () => {
  test('a comment alone on its lines goes with them', () => {
    expect(stripTemplateText('a {\n  /* why,\n     at length */\n  color: red;\n}\n', 't')).toBe('a {\n  color: red;\n}\n');
  });

  test('a comment after a declaration goes with the spaces before it', () => {
    expect(stripTemplateText('  color: red; /* why */\n', 't')).toBe('  color: red;\n');
  });

  test('a comment between two tokens leaves them two tokens', () => {
    expect(stripTemplateText('1px/**/solid', 't')).toBe('1px solid');
    expect(stripTemplateText('a /* x */ b', 't')).toBe('a b');
  });

  test('nothing else changes: blank lines, indentation and values stay as written', () => {
    const css = '  .a { margin: 0px; opacity: .2; }\n\n  .b { }\n';
    expect(stripTemplateText(css, 't')).toBe(css);
  });

  test('a comment left open (one spanning an interpolation) fails the build', () => {
    expect(() => stripTemplateText('a { /* open', 'x.css.ts')).toThrow(/not closed/);
  });
});

describe('stripCssComments', () => {
  test('only template literal text is touched', () => {
    const source = [
      "// a line comment that mentions /* without closing it",
      "const S = '/* a string, not CSS */';",
      'const X = 1;',
      'export const CSS = `',
      '  /* gone */',
      '  .a { width: ${X}px; } /* gone too */',
      '  .b { color: red; }',
      '`;',
    ].join('\n');
    expect(stripCssComments(source)).toBe(
      [
        "// a line comment that mentions /* without closing it",
        "const S = '/* a string, not CSS */';",
        'const X = 1;',
        'export const CSS = `',
        '  .a { width: ${X}px; }',
        '  .b { color: red; }',
        '`;',
      ].join('\n'),
    );
  });

  test('every part of a template with interpolations is stripped', () => {
    const source = 'const a = 1;\nexport const CSS = `/* h */x${a}/* m */y${a}z /* t */`;\n';
    expect(stripCssComments(source)).toBe('const a = 1;\nexport const CSS = `x${a}y${a}z`;\n');
  });
});
