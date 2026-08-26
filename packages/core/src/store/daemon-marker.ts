import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "./paths.js";
import { writePrivateJson } from "./private-json.js";

/** Legacy diagnostic/routing marker. Managed lifecycle credentials live separately. */
export interface DaemonMarker {
  url: string;
  pid: number;
  updatedAt: string;
}

export function daemonMarkerPath(): string {
  return join(configDir(), "daemon.json");
}

export async function readDaemonMarker(): Promise<DaemonMarker | null> {
  try {
    const value = JSON.parse(await readFile(daemonMarkerPath(), "utf8")) as Partial<DaemonMarker>;
    return typeof value.url === "string" &&
      typeof value.pid === "number" &&
      typeof value.updatedAt === "string"
      ? { url: value.url, pid: value.pid, updatedAt: value.updatedAt }
      : null;
  } catch {
    return null;
  }
}

export async function writeDaemonMarker(url: string): Promise<void> {
  await writePrivateJson(daemonMarkerPath(), {
    url,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
  });
}
