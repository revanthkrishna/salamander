const esbuild = require('esbuild');
const path = require('path');

const isWatch = process.argv.includes('--watch');

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
};

if (isWatch) {
  esbuild.context(buildOptions).then(ctx => ctx.watch());
} else {
  esbuild.build(buildOptions).catch(() => process.exit(1));
}
