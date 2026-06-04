import { defineConfig, devices } from "@playwright/test";

const PORT = 7460;

export default defineConfig({
  testDir: "./tests",
  // CX flows touch live SSE; keep them serial and give fetches room.
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `node fixture-server.mjs`,
    url: `http://127.0.0.1:${PORT}/workspace`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { PORT: String(PORT) },
  },
});
