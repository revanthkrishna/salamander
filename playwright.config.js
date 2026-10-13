const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 45000,
  workers: 1,
  // One retry absorbs a headed browser's occasional hiccup, but a test that
  // only passed on its retry is flaky, and in CI that fails the run rather
  // than looking like a clean pass (the list reporter prints it either way).
  retries: 1,
  failOnFlakyTests: !!process.env.CI,
  use: {
    screenshot: 'only-on-failure',
    video: 'off',
  },
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
});
