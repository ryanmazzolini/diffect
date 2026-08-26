import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "./paths.js";
import { writePrivateJson } from "./private-json.js";

export interface ManagedDaemonRecord {
  origin: string;
  pid: number;
  version: string;
  buildId: string;
  webAssetId: string;
  instanceId: string;
  stopToken: string;
  updatedAt: string;
}

export function managedDaemonPath(): string {
  return join(configDir(), "daemon-lifecycle.json");
}

export async function readManagedDaemon(): Promise<ManagedDaemonRecord | null> {
  try {
    const value = JSON.parse(await readFile(managedDaemonPath(), "utf8")) as Partial<ManagedDaemonRecord>;
    return isManagedDaemonRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export async function writeManagedDaemon(
  record: Omit<ManagedDaemonRecord, "pid" | "updatedAt">,
): Promise<void> {
  await writePrivateJson(managedDaemonPath(), {
    ...record,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
  });
}

function isManagedDaemonRecord(
  value: Partial<ManagedDaemonRecord>,
): value is ManagedDaemonRecord {
  return typeof value.origin === "string" &&
    typeof value.pid === "number" &&
    typeof value.version === "string" &&
    typeof value.buildId === "string" &&
    typeof value.webAssetId === "string" &&
    typeof value.instanceId === "string" &&
    typeof value.stopToken === "string" &&
    typeof value.updatedAt === "string";
}
