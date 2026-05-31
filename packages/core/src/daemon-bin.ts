#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createServer } from "./daemon.js";

interface CliArgs {
  workspace: string;
  port: number;
  host: string;
}

function parseArgs(argv: string[]): CliArgs {
  let workspace = process.cwd();
  let port = Number(process.env.DIFFECTD_PORT ?? 7421);
  let host = process.env.DIFFECTD_HOST ?? "127.0.0.1";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--workspace" || arg === "-w") {
      workspace = resolve(argv[++i] ?? ".");
    } else if (arg === "--port" || arg === "-p") {
      port = Number(argv[++i]);
    } else if (arg === "--host") {
      host = argv[++i] ?? host;
    }
  }
  return { workspace, port, host };
}

function locateWebRoot(): string | undefined {
  // Built web assets live in packages/web/dist; resolve relative to this file
  // whether running from dist/ or via the dev runner.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../../web/dist"),
    resolve(here, "../../../web/dist"),
  ];
  return candidates.find((c) => existsSync(c));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const webRoot = locateWebRoot();
  const server = await createServer({ workspacePath: args.workspace, webRoot });
  server.listen(args.port, args.host, () => {
    const where = webRoot ? "browser + API" : "API only";
    process.stdout.write(
      `diffectd reviewing ${args.workspace}\n` +
        `  ${where} on http://${args.host}:${args.port}\n`,
    );
  });
}

main().catch((err) => {
  process.stderr.write(`diffectd: ${err?.message ?? err}\n`);
  process.exit(1);
});
