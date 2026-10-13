const esbuild = require('esbuild');
const path = require('path');

const fs = require('fs');
const { stripCssComments, STYLES_FILE_RE } = require('./build/stripCssComments');

const isWatch = process.argv.includes('--watch');

// The stylesheets (src/styles/*.css.ts) are commented for whoever reads the
// CSS; the comments are stripped here so they are not shipped inside
// content.js (build/stripCssComments.js says exactly what is removed).
const stripCssCommentsPlugin = {
  name: 'strip-css-comments',
  setup(build) {
    build.onLoad({ filter: STYLES_FILE_RE }, async (args) => {
      const source = await fs.promises.readFile(args.path, 'utf8');
      return { contents: stripCssComments(source, args.path), loader: 'ts' };
    });
  },
};

const buildOptions = {
  entryPoints: {
    'background': 'src/background.ts',
    'content': 'src/content.ts',
  },
  bundle: true,
  outdir: 'dist',
  platform: 'browser',
  target: ['chrome100'],
  format: 'iife',
  sourcemap: true,
  // content.js is injected into every page the sidebar opens on and
  // re-injected on every full reload while it is open (background.ts's
  // handleTabUpdated), so its parse/memory cost lands on the host page. Minify
  // both bundles; the sourcemaps keep them debuggable.
  minify: true,
  external: [],
  plugins: [stripCssCommentsPlugin],
};

if (isWatch) {
  esbuild.context(buildOptions).then(ctx => ctx.watch());
} else {
  esbuild.build(buildOptions).catch(() => process.exit(1));
}
