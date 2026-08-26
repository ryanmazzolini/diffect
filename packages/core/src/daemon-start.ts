import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ManagedDaemonServer } from "./daemon.js";
import { writeDaemonMarker } from "./store/daemon-marker.js";
import { writeManagedDaemon } from "./store/managed-daemon.js";
import { addWorkspaceToRegistry } from "./store/registry.js";

export interface DaemonArgs {
  /** Workspace to seed and register at boot; null serves registry-only. */
  workspace: string | null;
  /** Requested port; 0 asks the OS for a free one. */
  port: number;
  host: string;
  /** Explicit web asset dir; omitted falls back to the monorepo layout. */
  webRoot?: string;
  /** Exit when stdin reaches EOF — embedders hold a pipe open so the daemon
   * dies with them even when they are killed without running cleanup. */
  exitOnStdinClose: boolean;
}

export function parseArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): DaemonArgs {
  let workspace: string | null = process.cwd();
  let port = Number(env.DIFFECTD_PORT ?? 7421);
  let host = env.DIFFECTD_HOST ?? "127.0.0.1";
  let webRoot = env.DIFFECTD_WEB_ROOT;
  let exitOnStdinClose = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--workspace" || arg === "-w") {
      workspace = resolve(argv[++i] ?? ".");
    } else if (arg === "--no-workspace") {
      // Serve only registered workspaces; embedders (the desktop shell) must
      // not register their own cwd as a reviewable workspace.
      workspace = null;
    } else if (arg === "--port" || arg === "-p") {
      port = Number(argv[++i]);
    } else if (arg === "--host") {
      host = argv[++i] ?? host;
    } else if (arg === "--web-root") {
      webRoot = argv[++i] ?? webRoot;
    } else if (arg === "--exit-on-stdin-close") {
      exitOnStdinClose = true;
    }
  }
  return {
    workspace,
    port,
    host,
    webRoot: webRoot ? resolve(webRoot) : undefined,
    exitOnStdinClose,
  };
}

/**
 * An explicit web root must exist — a packaged app pointing at a missing
 * resource dir should fail loudly, not degrade to API-only. Without one, fall
 * back to the monorepo-relative lookup (dist/ or dev-runner layouts).
 */
export function resolveWebRoot(explicit?: string): string | undefined {
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`web root not found: ${explicit}`);
    }
    return explicit;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../../web/dist"),
    resolve(here, "../../../web/dist"),
  ];
  return candidates.find((c) => existsSync(c));
}

export function formatUrl(host: string, port: number): string {
  const h = host.includes(":") ? `[${host}]` : host;
  return `http://${h}:${port}`;
}

interface ManagedRunOptions {
  version: string;
  buildId: string;
  webAssetId: string;
  origin: string;
}

interface ManagedDaemonIdentity extends Omit<ManagedRunOptions, "origin"> {
  instanceId: string;
  stopToken: string;
}

interface RunDaemonIo {
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
  stdin?: { resume(): unknown; once(event: "end" | "close", cb: () => void): unknown };
  exit?: () => void;
}

/**
 * Start diffectd from CLI args and announce readiness on stdout. The first
 * line is the machine-readable contract `DIFFECTD_READY <url>` carrying the
 * resolved port. Managed production launchers use 13433; tests and explicit
 * development commands may request 0.
 */
export async function runDaemon(
  argv: string[],
  io: RunDaemonIo = {},
  managed?: ManagedRunOptions,
): Promise<Server> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const args = parseArgs(argv);
  if (args.exitOnStdinClose) {
    // Attach before any slow startup work: a parent that dies mid-boot must
    // still take the daemon down with it.
    const stdin = io.stdin ?? process.stdin;
    const exit = io.exit ?? (() => process.exit(0));
    stdin.resume();
    stdin.once("end", exit);
    stdin.once("close", exit);
  }
  if (args.workspace !== null) {
    // Remember this workspace so it persists across restarts (non-fatal, but
    // warn so a "where are my workspaces?" debug session has a breadcrumb).
    await addWorkspaceToRegistry(args.workspace).catch((err) =>
      stderr.write(`diffectd: could not persist workspace: ${err?.message ?? err}\n`),
    );
  }
  const webRoot = resolveWebRoot(args.webRoot);
  if (managed && !webRoot) {
    throw new Error("managed diffectd requires a web root");
  }
  if (managed && args.host !== "127.0.0.1") {
    throw new Error("managed diffectd must bind to 127.0.0.1");
  }
  if (managed && (args.port === 0 || formatUrl(args.host, args.port) !== managed.origin)) {
    throw new Error(`managed diffectd must bind to ${managed.origin}`);
  }
  const identity: ManagedDaemonIdentity | undefined = managed
    ? {
        version: managed.version,
        buildId: managed.buildId,
        webAssetId: managed.webAssetId,
        instanceId: randomUUID(),
        stopToken: randomBytes(32).toString("hex"),
      }
    : undefined;
  const server: ManagedDaemonServer = await createServer({
    workspacePath: args.workspace ?? undefined,
    webRoot,
    host: args.host,
    preloadWebAssets: Boolean(managed),
    lifecycle: identity,
  });
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(args.port, args.host, () => res());
  });
  const { port } = server.address() as AddressInfo;
  const url = formatUrl(args.host, port);
  if (identity) {
    try {
      await writeManagedDaemon({ origin: url, ...identity });
    } catch (error) {
      await server.drainAndClose().catch(() => {});
      throw new Error(`could not write managed daemon lifecycle record: ${(error as Error)?.message ?? error}`);
    }
  }
  await writeDaemonMarker(url).catch((error) =>
    stderr.write(`diffectd: could not write daemon marker: ${(error as Error)?.message ?? error}\n`),
  );
  server.markReady(url);
  // Markers are intentionally retained after exit. They are diagnostic only,
  // and the next launcher live-probes before reuse and atomically replaces them.
  if (managed) attachManagedSignals(server);
  const where = webRoot ? "browser + API" : "API only";
  stdout.write(`DIFFECTD_READY ${url}\n`);
  stdout.write(
    `diffectd reviewing ${args.workspace ?? "registered workspaces"}\n` +
      `  ${where} on ${url}\n`,
  );
  return server;
}

function attachManagedSignals(server: ManagedDaemonServer): void {
  const shutdown = () => void server.drainAndClose().catch((error) => {
    process.stderr.write(`diffectd: graceful shutdown failed: ${error?.message ?? error}\n`);
  });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.once("close", () => {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  });
}
