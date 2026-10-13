// build/jestStripCssTransform.js
// Jest transformer for src/styles/*.css.ts: strips the stylesheets' CSS
// comments exactly as the bundle does (build/stripCssComments.js), then
// hands the file to ts-jest like every other TypeScript file. So the unit
// tests — the golden files above all — see the CSS that ships.

'use strict';

const { TsJestTransformer } = require('ts-jest');
const { stripCssComments } = require('./stripCssComments');

module.exports = {
  createTransformer(options) {
    const tsJest = new TsJestTransformer(options);
    return {
      canInstrument: tsJest.canInstrument,
      process(source, path, config) {
        return tsJest.process(stripCssComments(source, path), path, config);
      },
      processAsync(source, path, config) {
        return tsJest.processAsync(stripCssComments(source, path), path, config);
      },
      getCacheKey(source, path, config) {
        return tsJest.getCacheKey(stripCssComments(source, path), path, config);
      },
      getCacheKeyAsync(source, path, config) {
        return tsJest.getCacheKeyAsync(stripCssComments(source, path), path, config);
      },
    };
  },
};
