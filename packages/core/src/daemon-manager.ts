import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createConnection } from "node:net";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { lock, type LockOptions } from "proper-lockfile";
import {
  activateInstallation,
  readInstallation,
  requireAuthoritativeInstallation,
  type Installation,
  type InstallationCandidate,
} from "./store/installation.js";
import { configDir } from "./store/paths.js";
import { ensurePrivateDirectory } from "./store/private-json.js";
import {
  readManagedDaemon,
  type ManagedDaemonRecord,
} from "./store/managed-daemon.js";

export const CANONICAL_LOCAL_ORIGIN = "http://127.0.0.1:13433";

export interface DaemonExecutable {
  command: string;
  args: string[];
}

export interface DaemonManagerOptions {
  installation: InstallationCandidate;
  executable: DaemonExecutable;
  webRoot: string;
  webAssetId: string;
  origin?: string;
  env?: NodeJS.ProcessEnv;
}

export interface DaemonHealth {
  service: "diffect";
  version: string;
  buildId: string;
  webAssetId: string;
  instanceId: string;
  origin: string;
  lifecycle: "starting" | "ready" | "draining";
  activeMutations: number;
  web: true;
}

export type DaemonStatus =
  | { state: "absent"; installation: Installation | null }
  | { state: "conflict"; installation: Installation | null }
  | { state: "running"; installation: Installation | null; daemon: DaemonHealth };

export class DaemonConflictError extends Error {}
export class DaemonBuildMismatchError extends Error {}
export class DaemonLifecycleError extends Error {}

const LOCK_OPTIONS: LockOptions = {
  stale: 30_000,
  update: 5_000,
  realpath: false,
  retries: { retries: 80, factor: 1.2, minTimeout: 20, maxTimeout: 150 },
};

export async function activateManagedInstallation(
  options: DaemonManagerOptions,
  confirmRollback = false,
): Promise<Installation> {
  return withLifecycleLock(async () => {
    const state = await probeDaemon(options.origin ?? CANONICAL_LOCAL_ORIGIN);
    return activateInstallation(options.installation, {
      confirmRollback,
      daemonRunning: state.kind === "diffect",
    });
  });
}

export async function ensureManagedDaemon(
  options: DaemonManagerOptions,
): Promise<DaemonHealth> {
  return withLifecycleLock(async () => {
    await activateInstallation(options.installation);
    await requireAuthoritativeInstallation(options.installation);
    const origin = options.origin ?? CANONICAL_LOCAL_ORIGIN;
    const existing = await probeDaemon(origin);
    if (existing.kind === "diffect") {
      return requireReusableDaemon(
        existing.health,
        { ...options.installation, webAssetId: options.webAssetId },
        await readManagedDaemon(),
      );
    }
    if (existing.kind === "conflict") throw portConflict(origin);
    const pid = await spawnManagedDaemon(options, origin);
    try {
      return await waitForReady(
        { ...options.installation, webAssetId: options.webAssetId },
        origin,
        pid,
      );
    } catch (error) {
      await terminateUnreadyChild(pid);
      throw error;
    }
  });
}

export async function attachManagedDaemon(options: {
  version: string;
  buildId: string;
  webAssetId: string;
  origin?: string;
}): Promise<DaemonHealth> {
  return withLifecycleLock(async () => {
    const installation = await readInstallation();
    if (
      !installation ||
      installation.version !== options.version ||
      installation.buildId !== options.buildId
    ) {
      throw new DaemonBuildMismatchError(
        "this Diffect build is not the activated installation",
      );
    }
    const origin = options.origin ?? CANONICAL_LOCAL_ORIGIN;
    const state = await probeDaemon(origin);
    if (state.kind === "absent") {
      throw new DaemonLifecycleError(
        "the activated Diffect daemon is not running; launch it from the installed app",
      );
    }
    if (state.kind === "conflict") throw portConflict(origin);
    return requireReusableDaemon(state.health, options, await readManagedDaemon());
  });
}

export async function statusManagedDaemon(
  options: Pick<DaemonManagerOptions, "origin"> = {},
): Promise<DaemonStatus> {
  const installation = await readInstallation();
  const state = await probeDaemon(options.origin ?? CANONICAL_LOCAL_ORIGIN);
  if (state.kind === "absent") return { state: "absent", installation };
  if (state.kind === "conflict") return { state: "conflict", installation };
  return { state: "running", installation, daemon: state.health };
}

export async function stopManagedDaemon(
  options: DaemonManagerOptions,
): Promise<void> {
  return withLifecycleLock(async () => {
    await requireAuthoritativeInstallation(options.installation);
    const origin = options.origin ?? CANONICAL_LOCAL_ORIGIN;
    const state = await probeDaemon(origin);
    if (state.kind === "absent") return;
    if (state.kind === "conflict") throw portConflict(origin);
    const record = await requestManagedStop(origin, state.health, await readManagedDaemon());
    await waitForStopped(origin, record);
  });
}

export async function restartManagedDaemon(
  options: DaemonManagerOptions,
): Promise<DaemonHealth> {
  return withLifecycleLock(async () => {
    await requireAuthoritativeInstallation(options.installation);
    const origin = options.origin ?? CANONICAL_LOCAL_ORIGIN;
    const state = await probeDaemon(origin);
    if (state.kind === "conflict") throw portConflict(origin);
    if (state.kind === "diffect") {
      const record = await requestManagedStop(origin, state.health, await readManagedDaemon());
      await waitForStopped(origin, record);
    }
    const pid = await spawnManagedDaemon(options, origin);
    try {
      return await waitForReady(
        { ...options.installation, webAssetId: options.webAssetId },
        origin,
        pid,
      );
    } catch (error) {
      await terminateUnreadyChild(pid);
      throw error;
    }
  });
}

async function withLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
  const directory = configDir();
  await ensurePrivateDirectory(directory);
  const target = join(directory, "daemon-lifecycle");
  const targetFile = await open(target, "a", 0o600);
  await targetFile.close();

  let compromised: Error | undefined;
  const release = await lock(target, {
    ...LOCK_OPTIONS,
    onCompromised(error) {
      compromised ??= error;
    },
  });
  let result: T;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }
  let releaseError: unknown;
  try {
    await release();
  } catch (error) {
    releaseError = error;
  }
  if (operationError) throw operationError;
  if (compromised) throw new DaemonLifecycleError("daemon lifecycle lock was compromised");
  if (releaseError) throw releaseError;
  return result!;
}

async function requireReusableDaemon(
  health: DaemonHealth,
  installation: { version: string; buildId: string; webAssetId: string },
  record: ManagedDaemonRecord | null,
): Promise<DaemonHealth> {
  if (
    health.buildId !== installation.buildId ||
    health.version !== installation.version ||
    health.webAssetId !== installation.webAssetId
  ) {
    throw new DaemonBuildMismatchError(
      `Diffect ${health.version} (${health.buildId}) is running; quit desktop clients and restart the activated ${installation.version} build`,
    );
  }
  if (health.lifecycle !== "ready") {
    throw new DaemonLifecycleError(`diffectd is ${health.lifecycle}; retry shortly`);
  }
  requireMatchingRecord(health, record);
  await proveDaemon(health.origin, health, record);
  return health;
}

function requireMatchingRecord(
  health: DaemonHealth,
  record: ManagedDaemonRecord | null,
): asserts record is ManagedDaemonRecord {
  if (
    !record ||
    record.origin !== health.origin ||
    record.version !== health.version ||
    record.buildId !== health.buildId ||
    record.webAssetId !== health.webAssetId ||
    record.instanceId !== health.instanceId ||
    !/^[a-f0-9]{64}$/.test(record.stopToken)
  ) {
    throw new DaemonLifecycleError(
      "the running Diffect daemon has no matching lifecycle record",
    );
  }
}

async function proveDaemon(
  origin: string,
  health: DaemonHealth,
  record: ManagedDaemonRecord,
): Promise<void> {
  const nonce = randomBytes(32).toString("hex");
  const response = await fetch(`${origin}/daemon/prove`, {
    method: "POST",
    headers: { "x-diffect-daemon-challenge": nonce },
    signal: AbortSignal.timeout(1_000),
  }).catch((error) => {
    throw new DaemonLifecycleError(`could not authenticate diffectd: ${error?.message ?? error}`);
  });
  if (!response.ok) {
    throw new DaemonLifecycleError(`diffectd rejected lifecycle proof (${response.status})`);
  }
  const value = await response.json().catch(() => null) as { proof?: unknown } | null;
  const proof = typeof value?.proof === "string" ? Buffer.from(value.proof, "hex") : Buffer.alloc(0);
  const expected = Buffer.from(
    createHmac("sha256", Buffer.from(record.stopToken, "hex"))
      .update(`${health.instanceId}:${nonce}`, "utf8")
      .digest("hex"),
    "hex",
  );
  if (proof.length !== expected.length || !timingSafeEqual(proof, expected)) {
    throw new DaemonLifecycleError("the listener on the Diffect origin failed lifecycle proof");
  }
}

async function requestManagedStop(
  origin: string,
  health: DaemonHealth,
  record: ManagedDaemonRecord | null,
): Promise<ManagedDaemonRecord> {
  requireMatchingRecord(health, record);
  if (health.lifecycle === "draining") return record;
  await proveDaemon(origin, health, record);
  const response = await fetch(`${origin}/daemon/stop`, {
    method: "POST",
    headers: { "x-diffect-daemon-token": record.stopToken },
    signal: AbortSignal.timeout(1_000),
  }).catch((error) => {
    throw new DaemonLifecycleError(`could not stop diffectd: ${error?.message ?? error}`);
  });
  if (response.status !== 202) {
    throw new DaemonLifecycleError(`diffectd rejected stop request (${response.status})`);
  }
  return record;
}

async function spawnManagedDaemon(
  options: DaemonManagerOptions,
  origin: string,
): Promise<number> {
  const parsed = new URL(origin);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port) {
    throw new DaemonLifecycleError(`managed daemon origin is invalid: ${origin}`);
  }
  await ensurePrivateDirectory(configDir());
  const log = await open(join(configDir(), "diffectd.log"), "a", 0o600);
  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    DIFFECT_MANAGED_VERSION: options.installation.version,
    DIFFECT_MANAGED_BUILD_ID: options.installation.buildId,
  };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  try {
    const child = spawn(
      options.executable.command,
      [
        ...options.executable.args,
        "serve",
        "--no-workspace",
        "--host",
        "127.0.0.1",
        "--port",
        parsed.port,
        "--web-root",
        options.webRoot,
      ],
      {
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
        env,
      },
    );
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    child.removeAllListeners("error");
    child.on("error", () => {});
    child.unref();
    if (child.pid === undefined) {
      throw new DaemonLifecycleError("diffectd started without a process ID");
    }
    return child.pid;
  } finally {
    await log.close();
  }
}

async function waitForReady(
  installation: InstallationCandidate & { webAssetId: string },
  origin: string,
  childPid: number,
): Promise<DaemonHealth> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await probeDaemon(origin);
    if (state.kind === "diffect") {
      if (
        state.health.version === installation.version &&
        state.health.buildId === installation.buildId &&
        state.health.webAssetId === installation.webAssetId &&
        state.health.lifecycle === "ready"
      ) {
        const record = await readManagedDaemon();
        requireMatchingRecord(state.health, record);
        await proveDaemon(origin, state.health, record);
        return state.health;
      }
      if (
        state.health.version !== installation.version ||
        state.health.buildId !== installation.buildId ||
        state.health.webAssetId !== installation.webAssetId
      ) {
        throw new DaemonBuildMismatchError(
          `another Diffect build claimed ${origin} during startup`,
        );
      }
    } else if (state.kind === "conflict" && !processExists(childPid)) {
      throw portConflict(origin);
    }
    await delay(50);
  }
  throw new DaemonLifecycleError(`diffectd did not become ready on ${origin}`);
}

async function waitForStopped(
  origin: string,
  record: ManagedDaemonRecord,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await probeDaemon(origin);
    if (state.kind === "conflict" && !processExists(record.pid)) {
      throw portConflict(origin);
    }
    if (state.kind === "diffect" && state.health.instanceId !== record.instanceId) {
      throw new DaemonLifecycleError("another Diffect daemon claimed the canonical origin during restart");
    }
    if (state.kind === "absent" && !processExists(record.pid)) return;
    await delay(50);
  }
  throw new DaemonLifecycleError(
    "diffectd is still draining active work; retry after it finishes",
  );
}

type ProbeResult =
  | { kind: "absent" }
  | { kind: "conflict" }
  | { kind: "diffect"; health: DaemonHealth };

async function probeDaemon(origin: string): Promise<ProbeResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await probeDaemonOnce(origin);
    if (result.kind !== "conflict" || attempt === 2) return result;
    await delay(50);
  }
  return { kind: "conflict" };
}

async function probeDaemonOnce(origin: string): Promise<ProbeResult> {
  const response = await fetch(`${origin}/health`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(250),
  }).catch(() => null);
  if (response?.ok) {
    const value = await response.json().catch(() => null);
    const health = parseHealth(value, origin);
    if (health) return { kind: "diffect", health };
  }
  return await portInUse(origin) ? { kind: "conflict" } : { kind: "absent" };
}

function parseHealth(value: unknown, expectedOrigin: string): DaemonHealth | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const health = value as Record<string, unknown>;
  if (
    health.service !== "diffect" ||
    typeof health.version !== "string" ||
    typeof health.buildId !== "string" ||
    typeof health.webAssetId !== "string" ||
    !/^[a-f0-9]{64}$/.test(health.webAssetId) ||
    typeof health.instanceId !== "string" ||
    (health.origin !== expectedOrigin &&
      !(health.origin === null && health.lifecycle === "starting")) ||
    (health.lifecycle !== "starting" &&
      health.lifecycle !== "ready" &&
      health.lifecycle !== "draining") ||
    typeof health.activeMutations !== "number" ||
    !Number.isInteger(health.activeMutations) ||
    health.activeMutations < 0 ||
    health.web !== true
  ) {
    return null;
  }
  return {
    ...health,
    origin: expectedOrigin,
  } as unknown as DaemonHealth;
}

async function terminateUnreadyChild(pid: number): Promise<void> {
  if (!processExists(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await delay(25);
  }
  // This process never reached ready, so it has accepted no client work.
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
  const killDeadline = Date.now() + 1_000;
  while (processExists(pid) && Date.now() < killDeadline) await delay(25);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function portInUse(origin: string): Promise<boolean> {
  const url = new URL(origin);
  return new Promise((resolvePort) => {
    const socket = createConnection({
      host: url.hostname,
      port: Number(url.port),
    });
    const finish = (used: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolvePort(used);
    };
    socket.setTimeout(250);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

function portConflict(origin: string): DaemonConflictError {
  return new DaemonConflictError(
    `${origin} is occupied by a process that is not the activated Diffect daemon`,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
