import { defineConfig, devices } from '@playwright/test';

/**
 * E2E for the donor→recipient journey across the web app.
 *
 * Expects both servers: the API (for the listings page fetch) and the web
 * app. `webServer` below starts them from their *built* outputs, so run
 * `npm run build` in apps/api and apps/web first (the CI e2e job does).
 * Set PLAYWRIGHT_SKIP_WEBSERVER=1 to run against already-running servers.
 */
const skipWebServer = process.env.PLAYWRIGHT_SKIP_WEBSERVER === '1';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: skipWebServer
    ? undefined
    : [
        {
          command: 'node ../api/dist/main.js',
          url: 'http://localhost:4000/health',
          reuseExistingServer: !process.env.CI,
          timeout: 30_000,
          env: { PORT: '4000' },
        },
        {
          command: 'npm run start',
          url: 'http://localhost:3000',
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
      ],
});
