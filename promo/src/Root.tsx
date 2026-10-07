import React from 'react';
import { Composition, continueRender, delayRender, staticFile } from 'remotion';
import { DURATION, Film } from './Film';
import { FPS, H, W } from './lib';

// Brand fonts, loaded before any frame renders.
const FACES: [string, string, string, string][] = [
  ['Instrument Sans', 'instrument-sans-latin-400-normal', '400', 'normal'],
  ['Instrument Sans', 'instrument-sans-latin-500-normal', '500', 'normal'],
  ['Instrument Sans', 'instrument-sans-latin-600-normal', '600', 'normal'],
  ['Instrument Sans', 'instrument-sans-latin-700-normal', '700', 'normal'],
  ['Instrument Serif', 'instrument-serif-latin-400-italic', '400', 'italic'],
];
if (typeof document !== 'undefined') {
  const handle = delayRender('fonts');
  Promise.all(
    FACES.map(([family, file, weight, style]) => {
      const face = new FontFace(family, `url(${staticFile(`fonts/${file}.woff2`)})`, { weight, style });
      document.fonts.add(face);
      return face.load();
    }),
  ).then(() => continueRender(handle), () => continueRender(handle));
}

export const Root: React.FC = () => (
  <Composition id="Promo" component={Film} durationInFrames={DURATION} fps={FPS} width={W} height={H} />
);
