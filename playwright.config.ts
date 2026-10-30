import { defineConfig, devices } from "@playwright/test";

import { APP_URL } from "./e2e/env";

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  forbidOnly: Boolean(process.env.CI),
  // CI's runners have 4 CPUs; Playwright's default (half of them) leaves the suite twice as long.
  workers: process.env.CI ? 4 : undefined,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: APP_URL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
