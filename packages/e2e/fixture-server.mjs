// Launches diffectd against a freshly-built fixture workspace, serving the built
// web SPA. Used as Playwright's webServer. Prints nothing the test needs beyond
// listening on $PORT.
//
// FIXTURE_MULTI=1 seeds a container holding two sibling repos instead of one,
// so discovery returns N=2 and the SPA renders the stacked modules view. The
// default (single-repo) path is unchanged — its seeded tree stays byte-identical
// to the fixture the existing specs assert against.
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
const multi = process.env.FIXTURE_MULTI === "1";
// A literal newline kept as a value, so generated file contents are assembled
// without any backslash escape sequences in this source.
const NL = String.fromCharCode(10);

const git = (cwd, args) =>
  ex("git", args, { cwd, env: { ...process.env, GIT_PAGER: "cat", LC_ALL: "C" } });

const dir = mkdtempSync(join(tmpdir(), "diffect-e2e-"));
// Isolate the central review store + workspace registry so e2e never reads or
// writes the developer's real ~/.config/diffect.
const xdg = mkdtempSync(join(tmpdir(), "diffect-e2e-xdg-"));
process.env.XDG_CONFIG_HOME = xdg;
// Isolate HOME too so /recommendations reads a fixture session store (seeded in
// main) rather than the developer's real ~/.claude and ~/.pi.
const fakeHome = mkdtempSync(join(tmpdir(), "diffect-e2e-home-"));
process.env.HOME = fakeHome;

/**
 * Seed one repo: a base commit followed by a non-empty work diff. A head of
 * constants pushes the changed function deep in calc.js (leaving a collapsed gap
 * above the hunk for the unfold test); a nested math.js gives the sidebar a
 * single-child folder chain; README.md is tracked but unchanged, so it's offered
 * by the cross-file comment picker yet absent from the diff. With `marker` set
 * (multi-repo mode) the repo also gets a uniquely named file so each module's
 * diff is identifiable; passing none keeps the tree byte-identical to the
 * long-standing single-repo fixture.
 */
async function seedRepo(repoDir, marker) {
  await git(repoDir, ["init", "-b", "main"]);
  await git(repoDir, ["config", "user.email", "e2e@example.com"]);
  await git(repoDir, ["config", "user.name", "E2E"]);
  const head = Array.from({ length: 25 }, (_, i) => `export const k${i} = ${i};`).join(NL);
  const calc = (todo) =>
    `${head}

export function add(a, b) {
  return a + b${todo}
}

export function mul(a, b) {
  return a * b
}
`;
  writeFileSync(join(repoDir, "calc.js"), calc(""));
  const math = (todo) =>
    `export const PI = 3.14
export function square(x) {
  return x * x${todo}
}
`;
  mkdirSync(join(repoDir, "src", "util"), { recursive: true });
  writeFileSync(join(repoDir, "src", "util", "math.js"), math(""));
  writeFileSync(
    join(repoDir, "README.md"),
    `# Fixture

Line one.
Line two.
`,
  );
  writeFileSync(
    join(repoDir, "schema.graphql"),
    `type Query {
  greeting: String
}
`,
  );
  const tag = (todo) =>
    `export const REPO = ${JSON.stringify(marker)}
export function id() {
  return REPO${todo}
}
`;
  if (marker) writeFileSync(join(repoDir, `${marker}.js`), tag(""));
  await git(repoDir, ["add", "."]);
  await git(repoDir, ["commit", "-m", "base"]);
  // Work changes so the default diff is non-empty.
  writeFileSync(join(repoDir, "calc.js"), calc(" // TODO: overflow?"));
  writeFileSync(join(repoDir, "src", "util", "math.js"), math(" // TODO"));
  writeFileSync(
    join(repoDir, "schema.graphql"),
    `type Query {
  greeting: String
  viewer: User
}

type User {
  id: ID!
}
`,
  );
  if (marker) writeFileSync(join(repoDir, `${marker}.js`), tag(` // TODO ${marker}`));
}

async function main() {
  let workspacePath;
  if (multi) {
    // A container holding two sibling repos. discoverWorkspace walks depth 1-2,
    // finds both working trees, and the workspace root stays the container — so
    // /workspace reports repos.length === 2 and the SPA stacks two modules.
    mkdirSync(join(dir, "alpha"));
    mkdirSync(join(dir, "beta"));
    await seedRepo(join(dir, "alpha"), "alpha");
    await seedRepo(join(dir, "beta"), "beta");
    workspacePath = dir;
  } else {
    await seedRepo(dir, null);
    workspacePath = dir;
  }

  // Seed a fake Claude session pointing at the workspace so the add-workspace
  // dialog's "Recent projects" list is deterministic in e2e.
  const projDir = join(fakeHome, ".claude", "projects", "-fixture");
  mkdirSync(projDir, { recursive: true });
  writeFileSync(
    join(projDir, "s.jsonl"),
    `${JSON.stringify({ cwd: workspacePath })}
`,
  );

  const server = await createServer({ workspacePath, webRoot });
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`fixture diffectd listening on ${port} (ws=${workspacePath})
`);
  });

  const shutdown = () => {
    server.close(() => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  process.stderr.write(`fixture-server: ${err?.stack ?? err}
`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
});
