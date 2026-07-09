import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  // Every test gets its own daemon, Git fixture, and config store, so test files
  // can run concurrently without leaking review targets, comments, or edits.
  fullyParallel: true,
  workers: 4,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: "**/multi-repo.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium-multi",
      testMatch: "**/multi-repo.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
