// Starts one disposable diffectd fixture for a single Playwright test. The test
// fixture launches this process with PORT=0, reads the selected URL from stdout,
// and terminates the process after the browser context closes.
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createServer } from "../core/dist/daemon.js";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..", "web", "dist");
const requestedPort = Number(process.env.PORT ?? 0);
const multi = process.env.FIXTURE_MULTI === "1";
const newline = String.fromCharCode(10);

const workspaceDir = mkdtempSync(join(tmpdir(), "diffect-e2e-"));
const xdg = mkdtempSync(join(tmpdir(), "diffect-e2e-xdg-"));
const fakeHome = mkdtempSync(join(tmpdir(), "diffect-e2e-home-"));
process.env.XDG_CONFIG_HOME = xdg;
process.env.HOME = fakeHome;

const git = (cwd, args) =>
  execFileAsync("git", args, {
    cwd,
    env: { ...process.env, GIT_PAGER: "cat", LC_ALL: "C" },
  });

async function seedRepo(repoDir, marker) {
  await git(repoDir, ["init", "-b", "main"]);
  await git(repoDir, ["config", "user.email", "e2e@example.com"]);
  await git(repoDir, ["config", "user.name", "E2E"]);
  const head = Array.from({ length: 25 }, (_, index) => `export const k${index} = ${index};`).join(newline);
  const calc = (todo) => `${head}

export function add(a, b) {
  return a + b${todo}
}

export function mul(a, b) {
  return a * b
}
`;
  const math = (todo) => `export const PI = 3.14
export function square(x) {
  return x * x${todo}
}
`;
  const tag = (todo) => `export const REPO = ${JSON.stringify(marker)}
export function id() {
  return REPO${todo}
}
`;

  writeFileSync(join(repoDir, "calc.js"), calc(""));
  mkdirSync(join(repoDir, "src", "util"), { recursive: true });
  writeFileSync(join(repoDir, "src", "util", "math.js"), math(""));
  writeFileSync(join(repoDir, "README.md"), `# Fixture

Line one.
Line two.
`);
  writeFileSync(join(repoDir, "schema.graphql"), `type Query {
  greeting: String
}
`);
  if (marker) writeFileSync(join(repoDir, `${marker}.js`), tag(""));

  await git(repoDir, ["add", "."]);
  await git(repoDir, ["commit", "-m", "base"]);

  writeFileSync(join(repoDir, ".git", "info", "exclude"), ".plans/\n");
  mkdirSync(join(repoDir, ".plans"), { recursive: true });
  writeFileSync(join(repoDir, ".plans", "plan.md"), "# Local plan\n");
  writeFileSync(join(repoDir, "calc.js"), calc(" // TODO: overflow?"));
  writeFileSync(join(repoDir, "src", "util", "math.js"), math(" // TODO"));
  writeFileSync(join(repoDir, "schema.graphql"), `type Query {
  greeting: String
  viewer: User
}

type User {
  id: ID!
}
`);
  if (marker) writeFileSync(join(repoDir, `${marker}.js`), tag(` // TODO ${marker}`));
}

function cleanup() {
  rmSync(workspaceDir, { recursive: true, force: true });
  rmSync(xdg, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
}
process.once("exit", cleanup);

async function main() {
  if (multi) {
    mkdirSync(join(workspaceDir, "alpha"));
    mkdirSync(join(workspaceDir, "beta"));
    await seedRepo(join(workspaceDir, "alpha"), "alpha");
    await seedRepo(join(workspaceDir, "beta"), "beta");
  } else {
    await seedRepo(workspaceDir, null);
  }

  const projectDir = join(fakeHome, ".claude", "projects", "-fixture");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, "s.jsonl"),
    `${JSON.stringify({ cwd: workspaceDir })}${newline}`,
  );

  const server = await createServer({ workspacePath: workspaceDir, webRoot });
  server.listen(requestedPort, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : requestedPort;
    process.stdout.write(`fixture diffectd ready http://127.0.0.1:${port}\n`);
  });

  const shutdown = () => {
    const forceExit = setTimeout(() => process.exit(1), 2_000);
    forceExit.unref();
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
