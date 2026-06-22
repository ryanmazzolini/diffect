import { defineConfig, devices } from "@playwright/test";

const PORT = 7460;
// A second daemon seeded with two repos (FIXTURE_MULTI=1), on its own port, so
// the modules-view spec exercises the real N≥2 stacked layout. The single-repo
// server on PORT is untouched — every existing spec keeps hitting it.
const MULTI_PORT = 7461;

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
    {
      name: "chromium",
      testIgnore: "**/multi-repo.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium-multi",
      testMatch: "**/multi-repo.spec.ts",
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${MULTI_PORT}` },
    },
  ],
  webServer: [
    {
      command: `node fixture-server.mjs`,
      url: `http://127.0.0.1:${PORT}/workspace`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { PORT: String(PORT) },
    },
    {
      command: `node fixture-server.mjs`,
      url: `http://127.0.0.1:${MULTI_PORT}/workspace`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { PORT: String(MULTI_PORT), FIXTURE_MULTI: "1" },
    },
  ],
});
