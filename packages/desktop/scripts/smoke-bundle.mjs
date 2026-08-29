import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const desktop = resolve(import.meta.dirname, "..");
const root = resolve(desktop, "../..");
const target = join(desktop, "src-tauri/target/release/bundle");
let launcher;
const platformEnv = {};
if (process.platform === "darwin") {
  launcher = join(target, "macos/Diffect.app/Contents/MacOS/diffect-desktop");
  platformEnv.DIFFECT_APP_PATH = launcher;
} else if (process.platform === "linux") {
  const directory = join(target, "appimage");
  const appImage = readdirSync(directory).find((name) => name.endsWith(".AppImage"));
  if (!appImage) throw new Error(`no AppImage found under ${directory}`);
  launcher = join(directory, appImage);
  platformEnv.APPIMAGE = launcher;
  platformEnv.APPIMAGE_EXTRACT_AND_RUN = "1";
} else {
  throw new Error(`packaged daemon smoke is not implemented on ${process.platform}`);
}
if (!existsSync(launcher)) throw new Error(`desktop launcher not found: ${launcher}`);

const config = mkdtempSync(join(tmpdir(), "diffect-packaged-smoke-"));
const env = {
  ...process.env,
  ...platformEnv,
  XDG_CONFIG_HOME: config,
  // The Rust launcher must not forward an inherited Node preload into the SEA.
  NODE_OPTIONS: "--require=/diffect-packaged-smoke-must-not-load.cjs",
};

function command(name) {
  const stdout = execFileSync(launcher, ["daemon", name, "--json"], {
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  return JSON.parse(stdout);
}

function lifecycle() {
  return JSON.parse(readFileSync(join(config, "diffect/daemon-lifecycle.json"), "utf8"));
}

async function waitFor(check, message) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

try {
  const first = command("ensure");
  if (first.daemon.origin !== "http://127.0.0.1:13433" || !first.daemon.web) {
    throw new Error(`unexpected ensure response: ${JSON.stringify(first)}`);
  }
  const firstLifecycle = lifecycle();
  const installation = JSON.parse(
    readFileSync(join(config, "diffect/installation.json"), "utf8"),
  );
  if (
    installation.launcherPath !== launcher ||
    installation.source !== (process.platform === "linux" ? "appimage" : "explicit")
  ) {
    throw new Error(`unexpected packaged launcher authority: ${JSON.stringify(installation)}`);
  }
  const second = command("ensure");
  if (second.daemon.instanceId !== first.daemon.instanceId || lifecycle().pid !== firstLifecycle.pid) {
    throw new Error("a second packaged ensure did not reuse the daemon");
  }
  const index = await fetch("http://127.0.0.1:13433/");
  if (!index.ok || !(await index.text()).includes("<div id=\"root\"></div>")) {
    throw new Error("the packaged daemon did not serve its bundled web UI");
  }

  process.kill(firstLifecycle.pid, "SIGKILL");
  await waitFor(async () => {
    try {
      process.kill(firstLifecycle.pid, 0);
      return false;
    } catch {
      return true;
    }
  }, "the killed packaged daemon remained alive");

  const recovered = command("ensure");
  if (recovered.daemon.instanceId === first.daemon.instanceId) {
    throw new Error("packaged ensure did not recover the killed daemon");
  }
  command("stop");
  await waitFor(
    async () => !await fetch("http://127.0.0.1:13433/health").then(() => true, () => false),
    "the packaged daemon remained reachable after stop",
  );
  console.log("packaged daemon smoke passed");
} finally {
  try {
    const { pid } = lifecycle();
    process.kill(pid, "SIGTERM");
  } catch {}
  rmSync(config, { recursive: true, force: true });
}

execFileSync(
  "pnpm",
  ["--filter", "@diffect/core", "exec", "vitest", "run", "test/pi-daemon-launch.test.ts", "--reporter=dot"],
  {
    cwd: root,
    env: {
      ...process.env,
      ...platformEnv,
      DIFFECT_PACKAGED_LAUNCHER: launcher,
      DIFFECT_PACKAGED_SOURCE: process.platform === "linux" ? "appimage" : "explicit",
    },
    stdio: "inherit",
    timeout: 120_000,
  },
);
