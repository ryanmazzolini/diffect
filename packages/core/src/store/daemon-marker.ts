import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "./paths.js";

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
    const parsed = JSON.parse(await readFile(daemonMarkerPath(), "utf8")) as Partial<DaemonMarker>;
    return typeof parsed.url === "string" &&
      typeof parsed.pid === "number" &&
      typeof parsed.updatedAt === "string"
      ? { url: parsed.url, pid: parsed.pid, updatedAt: parsed.updatedAt }
      : null;
  } catch {
    return null;
  }
}

export async function writeDaemonMarker(url: string): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await writeFile(
    daemonMarkerPath(),
    JSON.stringify({ url, pid: process.pid, updatedAt: new Date().toISOString() }, null, 2) + "\n",
    "utf8",
  );
}

export async function clearDaemonMarker(url: string): Promise<void> {
  const marker = await readDaemonMarker();
  if (marker?.url === url && marker.pid === process.pid) {
    await rm(daemonMarkerPath(), { force: true });
  }
}
