// Render review stills from one bundle: node stills.mjs <outDir> <frame> [frame...]
import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';
import path from 'path';

const out = process.argv[2];
const frames = process.argv.slice(3).map(Number);
const serveUrl = await bundle({ entryPoint: path.resolve('src/index.ts') });
const composition = await selectComposition({ serveUrl, id: 'Promo' });
for (const frame of frames) {
  await renderStill({ composition, serveUrl, output: path.join(out, `f${String(frame).padStart(4, '0')}.png`), frame, scale: 0.5 });
  process.stdout.write(frame + ' ');
}
console.log('done');
