import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The built SPA is served by diffectd from packages/web/dist. In dev, proxy the
// API to a locally running daemon so the browser and daemon share one origin.
const DAEMON = process.env.DIFFECTD_URL ?? "http://127.0.0.1:7421";

// Consume @diffect/shared from source so the dev server needs no prebuild; the
// production bundle inlines it either way.
const sharedSrc = fileURLToPath(
  new URL("../shared/src/index.ts", import.meta.url),
);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@diffect/shared": sharedSrc },
  },
  server: {
    proxy: {
      "/workspace": DAEMON,
      "/repos": DAEMON,
      "/threads": DAEMON,
      "/events": DAEMON,
      "/open": DAEMON,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
