import { existsSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "./daemon.js";
import { addWorkspaceToRegistry } from "./store/registry.js";

export interface DaemonArgs {
  /** Workspace to seed and register at boot; null serves registry-only. */
  workspace: string | null;
  /** Requested port; 0 asks the OS for a free one. */
  port: number;
  host: string;
  /** Explicit web asset dir; omitted falls back to the monorepo layout. */
  webRoot?: string;
}

export function parseArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): DaemonArgs {
  let workspace: string | null = process.cwd();
  let port = Number(env.DIFFECTD_PORT ?? 7421);
  let host = env.DIFFECTD_HOST ?? "127.0.0.1";
  let webRoot = env.DIFFECTD_WEB_ROOT;
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
    }
  }
  return { workspace, port, host, webRoot: webRoot ? resolve(webRoot) : undefined };
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

interface RunDaemonIo {
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
}

/**
 * Start diffectd from CLI args and announce readiness on stdout. The first
 * line is the machine-readable contract `DIFFECTD_READY <url>` carrying the
 * *resolved* port — embedders start us with `--port 0` and parse it to learn
 * where to point their webview.
 */
export async function runDaemon(
  argv: string[],
  io: RunDaemonIo = {},
): Promise<Server> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const args = parseArgs(argv);
  if (args.workspace !== null) {
    // Remember this workspace so it persists across restarts (non-fatal, but
    // warn so a "where are my workspaces?" debug session has a breadcrumb).
    await addWorkspaceToRegistry(args.workspace).catch((err) =>
      stderr.write(`diffectd: could not persist workspace: ${err?.message ?? err}\n`),
    );
  }
  const webRoot = resolveWebRoot(args.webRoot);
  const server = await createServer({
    workspacePath: args.workspace ?? undefined,
    webRoot,
    host: args.host,
  });
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(args.port, args.host, () => res());
  });
  const { port } = server.address() as AddressInfo;
  const url = formatUrl(args.host, port);
  const where = webRoot ? "browser + API" : "API only";
  stdout.write(`DIFFECTD_READY ${url}\n`);
  stdout.write(
    `diffectd reviewing ${args.workspace ?? "registered workspaces"}\n` +
      `  ${where} on ${url}\n`,
  );
  return server;
}
