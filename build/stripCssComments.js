// build/stripCssComments.js
// Removes CSS comments from the stylesheets in src/styles/*.css.ts at build
// time, so they are not shipped (and parsed on every page) inside
// content.js. The comments stay in the source, where they explain the CSS.
//
// Only the text of template literals is touched — the stylesheets are
// template literals — found with TypeScript's own parser, so a `/*` in a
// line comment or a string can never start a "comment". Within that text:
//   - a comment alone on its line(s) goes with its line;
//   - any other comment goes with the spaces before it, and leaves one
//     space if it sat between two tokens (CSS reads a comment as a token
//     separator, so `1px/**/solid` must stay two tokens).
// Nothing else changes: no minifying, no reformatting (a minifier would
// rewrite values like `0px` and `.2`, which the emitted CSS keeps).
//
// Used by esbuild.config.js (the bundle) and by
// build/jestStripCssTransform.js (the unit tests), so the CSS the tests pin
// in src/__tests__/__golden__/ is exactly the CSS that ships.

'use strict';

const ts = require('typescript');

/** Strip the comments from one template literal's raw text. Throws on a
 *  comment left open, which would mean one spanning an interpolation. */
function stripTemplateText(text, where) {
  let out = '';
  let i = 0;
  for (;;) {
    const start = text.indexOf('/*', i);
    if (start < 0) {
      out += text.slice(i);
      return out;
    }
    const close = text.indexOf('*/', start + 2);
    if (close < 0) throw new Error(`${where}: a CSS comment is not closed within one template part`);
    const end = close + 2;
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const nl = text.indexOf('\n', end);
    const lineEnd = nl < 0 ? text.length : nl;
    const alone =
      lineStart >= i && /^[ \t]*$/.test(text.slice(lineStart, start)) && /^[ \t]*$/.test(text.slice(end, lineEnd));
    if (alone && nl >= 0) {
      out += text.slice(i, lineStart);
      i = nl + 1;
      continue;
    }
    const kept = text.slice(i, start).replace(/[ \t]+$/, '');
    const prev = kept.length > 0 ? kept[kept.length - 1] : out.length > 0 ? out[out.length - 1] : '';
    const next = end < text.length ? text[end] : '';
    const glue = prev !== '' && !/\s/.test(prev) && next !== '' && !/\s/.test(next);
    out += kept + (glue ? ' ' : '');
    i = end;
  }
}

/** The source of a *.css.ts module with every template literal's CSS
 *  comments removed; everything outside template literals unchanged. */
function stripCssComments(source, fileName = 'styles.css.ts') {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  /** [start, end) spans of template-literal text, in source order. */
  const spans = [];
  const visit = (node) => {
    if (ts.isNoSubstitutionTemplateLiteral(node)) {
      spans.push([node.getStart(file) + 1, node.end - 1]);
    } else if (ts.isTemplateExpression(node)) {
      // head: `...${   middle: }...${   tail: }...`
      spans.push([node.head.getStart(file) + 1, node.head.end - 2]);
      for (const part of node.templateSpans) {
        const lit = part.literal;
        const closing = ts.isTemplateTail(lit) ? 1 : 2;
        spans.push([lit.getStart(file) + 1, lit.end - closing]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  spans.sort((a, b) => a[0] - b[0]);
  let out = '';
  let at = 0;
  for (const [start, end] of spans) {
    out += source.slice(at, start) + stripTemplateText(source.slice(start, end), fileName);
    at = end;
  }
  return out + source.slice(at);
}

/** The files this applies to. */
const STYLES_FILE_RE = /[\\/]src[\\/]styles[\\/][^\\/]+\.css\.ts$/;

module.exports = { stripCssComments, stripTemplateText, STYLES_FILE_RE };
