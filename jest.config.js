/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jest-environment-jsdom',
  testMatch: ['**/__tests__/**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
  // ts-jest options live on the transform entry; the older `globals['ts-jest']`
  // form is deprecated and warned on every run.
  // src/styles/*.css.ts first: their CSS comments are stripped as the
  // bundle strips them (esbuild.config.js), so the tests see what ships.
  transform: {
    '[\\/]src[\\/]styles[\\/][^\\/]+\\.css\\.ts$': ['<rootDir>/build/jestStripCssTransform.js', { tsconfig: { strict: true } }],
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { strict: true } }],
  },
};
