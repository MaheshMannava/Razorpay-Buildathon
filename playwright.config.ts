import { defineConfig } from "@playwright/test";

const port = 3014;

export default defineConfig({
  testDir: "./tests",
  testMatch: "browser.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: {
    command: `NODE_ENV=production PUBLIC_DEMO_ENABLED=true APP_ORIGIN=http://127.0.0.1:${port} PORT=${port} DATABASE_PATH=/tmp/rasoi-playwright.sqlite pnpm start`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 20_000
  }
});
