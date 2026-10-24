import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

export default defineConfig({
  testDir: "./test/e2e",
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: "http://127.0.0.1:3100",
    launchOptions: {
      executablePath:
        process.env.CHROMIUM_PATH ||
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
      args: ["--no-sandbox"],
    },
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
    {
      name: "samsung-size",
      use: { ...devices["Galaxy S9+"], defaultBrowserType: "chromium" },
    },
    {
      name: "iphone-size",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
  webServer: {
    command: "node test/e2e-server.js",
    url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: false,
  },
});
