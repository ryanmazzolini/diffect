#!/usr/bin/env node
import { isAbsolute, resolve } from "node:path";
import {
  CANONICAL_LOCAL_ORIGIN,
  activateManagedInstallation,
  attachManagedDaemon,
  ensureManagedDaemon,
  restartManagedDaemon,
  statusManagedDaemon,
  stopManagedDaemon,
  type DaemonManagerOptions,
} from "./daemon-manager.js";
import { formatUrl, resolveWebRoot, runDaemon } from "./daemon-start.js";
import type { InstallationSource } from "./store/installation.js";

// The desktop sidecar build replaces these static references with immutable
// release literals. Source/test execution reads them from the process env.
const RELEASE_VERSION = process.env.DIFFECT_RELEASE_VERSION?.trim();
const BUILD_ID = process.env.DIFFECT_BUILD_ID?.trim();
const WEB_ASSET_ID = process.env.DIFFECT_WEB_ASSET_ID?.trim();

const [command, ...args] = process.argv.slice(2);

main().then(
  () => {},
  (error) => {
    process.stderr.write(`diffectd: ${error?.message ?? error}\n`);
    process.exit(1);
  },
);

async function main(): Promise<void> {
  if (command === "serve") {
    const version = process.env.DIFFECT_MANAGED_VERSION?.trim();
    const buildId = process.env.DIFFECT_MANAGED_BUILD_ID?.trim();
    await runDaemon(
      args,
      {},
      version && buildId && WEB_ASSET_ID
        ? { version, buildId, webAssetId: WEB_ASSET_ID, origin: managedOrigin() }
        : undefined,
    );
    return;
  }

  if (command === "attach") {
    print({
      daemon: await attachManagedDaemon({
        version: requiredIdentity("DIFFECT_RELEASE_VERSION", RELEASE_VERSION),
        buildId: requiredIdentity("DIFFECT_BUILD_ID", BUILD_ID),
        webAssetId: requiredIdentity("DIFFECT_WEB_ASSET_ID", WEB_ASSET_ID),
        origin: managedOrigin(),
      }),
    });
    return;
  }

  if (command === "status") {
    print(await statusManagedDaemon({ origin: managedOrigin() }));
    return;
  }

  if (command === "activate") {
    const options = managerOptions();
    const installation = await activateManagedInstallation(
      options,
      args.includes("--confirm-rollback"),
    );
    print({ installation });
    return;
  }

  if (command === "ensure") {
    print({ daemon: await ensureManagedDaemon(managerOptions()) });
    return;
  }

  if (command === "restart") {
    print({ daemon: await restartManagedDaemon(managerOptions()) });
    return;
  }

  if (command === "stop") {
    const options = managerOptions();
    await stopManagedDaemon(options);
    print({ stopped: true, origin: options.origin });
    return;
  }

  // Preserve the existing foreground CLI for explicit development and the
  // current desktop shell while clients migrate to the manager.
  await runDaemon(process.argv.slice(2));
}

function managerOptions(): DaemonManagerOptions {
  const version = requiredIdentity("DIFFECT_RELEASE_VERSION", RELEASE_VERSION);
  const buildId = requiredIdentity("DIFFECT_BUILD_ID", BUILD_ID);
  const webAssetId = requiredIdentity("DIFFECT_WEB_ASSET_ID", WEB_ASSET_ID);
  const source = requiredEnv("DIFFECT_INSTALL_SOURCE") as InstallationSource;
  const launcherPath = resolve(requiredEnv("DIFFECT_LAUNCHER_PATH"));
  const webRoot = resolveWebRoot(process.env.DIFFECT_WEB_ROOT?.trim());
  if (!webRoot) throw new Error("installed Diffect web assets were not found");

  return {
    installation: { version, buildId, launcherPath, source },
    executable: currentExecutable(),
    webRoot,
    webAssetId,
    origin: managedOrigin(),
    env: process.env,
  };
}

function currentExecutable(): { command: string; args: string[] } {
  const script = process.argv[1];
  return {
    command: process.execPath,
    args: script && isAbsolute(script) && resolve(script) !== resolve(process.execPath)
      ? [...process.execArgv, script]
      : [],
  };
}

function managedOrigin(): string {
  const testPort = process.env.DIFFECT_TEST_MANAGED_PORT;
  if (testPort === undefined) return CANONICAL_LOCAL_ORIGIN;
  if (process.env.NODE_ENV !== "test") {
    throw new Error("managed production daemon commands always use 127.0.0.1:13433");
  }
  const port = Number(testPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("DIFFECT_TEST_MANAGED_PORT must be an integer from 1 to 65535");
  }
  return formatUrl("127.0.0.1", port);
}

function requiredIdentity(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required for managed daemon commands`);
  return value;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for managed daemon commands`);
  return value;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
