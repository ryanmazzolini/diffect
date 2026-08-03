// One disposable clean Review daemon and Git fixture per Playwright test.
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createServer } from "../core/dist/daemon.js";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..", "web", "dist");
const requestedPort = Number(process.env.PORT ?? 0);
const workspace = mkdtempSync(join(tmpdir(), "diffect-e2e-"));
const xdg = mkdtempSync(join(tmpdir(), "diffect-e2e-xdg-"));
process.env.XDG_CONFIG_HOME = xdg;
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const git = (args) =>
  execFileAsync("git", args, {
    cwd: workspace,
    env: { ...process.env, GIT_PAGER: "cat", LC_ALL: "C" },
  });

function cleanup() {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(xdg, { recursive: true, force: true });
}
process.once("exit", cleanup);

async function main() {
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "e2e@example.com"]);
  await git(["config", "user.name", "E2E"]);
  writeFileSync(
    join(workspace, "example.ts"),
    "export const answer = 41;\n\nexport function label() {\n  return 'old';\n}\n",
  );
  await git(["add", "."]);
  await git(["commit", "-m", "base"]);
  writeFileSync(
    join(workspace, "example.ts"),
    "export const answer = 42;\n\nexport function label() {\n  return 'review';\n}\n",
  );

  const server = await createServer({ workspacePath: workspace, webRoot });
  server.listen(requestedPort, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : requestedPort;
    process.stdout.write(`fixture diffectd ready http://127.0.0.1:${port}\n`);
  });

  const shutdown = () => {
    const force = setTimeout(() => process.exit(1), 2_000);
    force.unref();
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((error) => {
  process.stderr.write(`fixture-server: ${error?.stack ?? error}\n`);
  process.exit(1);
});
