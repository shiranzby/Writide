import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  workers: 1,
  timeout: 30000,
  webServer: {
    command: 'node test-server.mjs',
    url: 'http://127.0.0.1:5187',
    // Reuse only this dedicated port; tests still intercept every API request.
    reuseExistingServer: true,
    timeout: 120000,
  },
  use: {
    baseURL: 'http://127.0.0.1:5187',
    headless: true,
    serviceWorkers: 'block',
  },
});
