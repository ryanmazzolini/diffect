// Launches diffectd against a freshly-built fixture workspace, serving the built
// web SPA. Used as Playwright's webServer. Prints nothing the test needs beyond
// listening on $PORT.
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createServer } from "../core/dist/daemon.js";

const ex = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..", "web", "dist");
const port = Number(process.env.PORT ?? 7460);

const git = (cwd, args) =>
  ex("git", args, { cwd, env: { ...process.env, GIT_PAGER: "cat", LC_ALL: "C" } });

const dir = mkdtempSync(join(tmpdir(), "diffect-e2e-"));
// Isolate the central review store + workspace registry so e2e never reads or
// writes the developer's real ~/.config/diffect.
const xdg = mkdtempSync(join(tmpdir(), "diffect-e2e-xdg-"));
process.env.XDG_CONFIG_HOME = xdg;

async function main() {
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "e2e@example.com"]);
  await git(dir, ["config", "user.name", "E2E"]);
  // A head of constants so the changed function sits deep in the file — this
  // leaves a collapsed gap above the hunk for the unfold (expand-context) test.
  const head = Array.from({ length: 25 }, (_, i) => `export const k${i} = ${i};`).join(
    "\n",
  );
  const calc = (todo) =>
    `${head}\n\nexport function add(a, b) {\n  return a + b${todo}\n}\n\nexport function mul(a, b) {\n  return a * b\n}\n`;
  writeFileSync(join(dir, "calc.js"), calc(""));
  // A nested file so the sidebar file tree has a (single-child, collapsible)
  // folder chain to render.
  const math = (todo) => `export const PI = 3.14\nexport function square(x) {\n  return x * x${todo}\n}\n`;
  mkdirSync(join(dir, "src", "util"), { recursive: true });
  writeFileSync(join(dir, "src", "util", "math.js"), math(""));
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "base"]);
  // Work changes so the default diff is non-empty.
  writeFileSync(join(dir, "calc.js"), calc(" // TODO: overflow?"));
  writeFileSync(join(dir, "src", "util", "math.js"), math(" // TODO"));

  const server = await createServer({ workspacePath: dir, webRoot });
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`fixture diffectd listening on ${port} (ws=${dir})\n`);
  });

  const shutdown = () => {
    server.close(() => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  process.stderr.write(`fixture-server: ${err?.stack ?? err}\n`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
});
