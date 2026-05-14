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
  minify: false,
  external: [],
};

if (isWatch) {
  esbuild.context(buildOptions).then(ctx => ctx.watch());
} else {
  esbuild.build(buildOptions).catch(() => process.exit(1));
}
