import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve @diffect/shared to its TypeScript source for tests so the suite runs
// without a prior build step; the published artifacts still consume dist/.
const sharedSrc = fileURLToPath(
  new URL("../shared/src/index.ts", import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: { "@diffect/shared": sharedSrc },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // Git fixtures spin up real repos; give them room.
    testTimeout: 20_000,
  },
});
