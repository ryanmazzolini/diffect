import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { configDir } from "./paths.js";
import { writePrivateJson } from "./private-json.js";

export type InstallationSource =
  | "package-manager"
  | "macos-app"
  | "appimage"
  | "explicit";

export interface Installation {
  version: string;
  buildId: string;
  launcherPath: string;
  source: InstallationSource;
  updatedAt: string;
}

export interface InstallationCandidate {
  version: string;
  buildId: string;
  launcherPath: string;
  source: InstallationSource;
}

export class InstallationAuthorityError extends Error {}
export class InstallationReadError extends Error {}

export function installationPath(): string {
  return join(configDir(), "installation.json");
}

export async function readInstallation(): Promise<Installation | null> {
  let raw: string;
  try {
    raw = await readFile(installationPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new InstallationReadError(`could not read Diffect installation record: ${(error as Error).message}`);
  }
  try {
    const value = JSON.parse(raw) as Partial<Installation>;
    if (!isInstallation(value)) throw new Error("invalid fields");
    return value;
  } catch (error) {
    throw new InstallationReadError(
      `Diffect installation record is invalid: ${(error as Error).message}`,
    );
  }
}

export async function activateInstallation(
  candidate: InstallationCandidate,
  options: { confirmRollback?: boolean; daemonRunning?: boolean } = {},
): Promise<Installation> {
  validateCandidate(candidate);
  const normalized: InstallationCandidate = {
    ...candidate,
    launcherPath: resolve(candidate.launcherPath),
  };
  const current = await readInstallation();

  if (!current) return writeInstallation(normalized);
  if (current.buildId === normalized.buildId && current.version === normalized.version) {
    if (
      current.launcherPath === normalized.launcherPath &&
      current.source === normalized.source
    ) {
      return current;
    }
    return writeInstallation(normalized);
  }

  const order = compareSemver(normalized.version, current.version);
  if (order > 0) return writeInstallation(normalized);
  if (order === 0) {
    throw new InstallationAuthorityError(
      `Diffect ${current.version} is already activated with a different build`,
    );
  }
  if (!options.confirmRollback) {
    throw new InstallationAuthorityError(
      `Diffect ${current.version} is activated; ${normalized.version} cannot replace it without confirmed rollback`,
    );
  }
  if (options.daemonRunning) {
    throw new InstallationAuthorityError(
      "stop the running Diffect daemon before activating an older release",
    );
  }
  return writeInstallation(normalized);
}

export async function requireAuthoritativeInstallation(
  candidate: InstallationCandidate,
): Promise<Installation> {
  validateCandidate(candidate);
  const current = await readInstallation();
  if (!current) {
    throw new InstallationAuthorityError("no Diffect installation is activated");
  }
  if (
    current.version !== candidate.version ||
    current.buildId !== candidate.buildId ||
    current.launcherPath !== resolve(candidate.launcherPath)
  ) {
    throw new InstallationAuthorityError(
      `Diffect ${current.version} (${current.buildId}) is the activated installation`,
    );
  }
  return current;
}

async function writeInstallation(
  candidate: InstallationCandidate,
): Promise<Installation> {
  const installation: Installation = {
    ...candidate,
    updatedAt: new Date().toISOString(),
  };
  await writePrivateJson(installationPath(), installation);
  return installation;
}

function validateCandidate(candidate: InstallationCandidate): void {
  parseSemver(candidate.version);
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(candidate.buildId)) {
    throw new InstallationAuthorityError("Diffect build ID is invalid");
  }
  if (!isAbsolute(candidate.launcherPath)) {
    throw new InstallationAuthorityError("Diffect launcher path must be absolute");
  }
  if (
    candidate.source !== "package-manager" &&
    candidate.source !== "macos-app" &&
    candidate.source !== "appimage" &&
    candidate.source !== "explicit"
  ) {
    throw new InstallationAuthorityError("Diffect installation source is invalid");
  }
}

type Semver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

function parseSemver(value: string): Semver {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) throw new InstallationAuthorityError(`invalid Diffect version: ${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

export function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length
      ? 0
      : a.prerelease.length === 0
        ? 1
        : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    if (x === y) continue;
    const xNumber = /^\d+$/.test(x) ? Number(x) : null;
    const yNumber = /^\d+$/.test(y) ? Number(y) : null;
    if (xNumber !== null && yNumber !== null) return xNumber > yNumber ? 1 : -1;
    if (xNumber !== null || yNumber !== null) return xNumber !== null ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function isInstallation(value: Partial<Installation>): value is Installation {
  try {
    if (
      typeof value.version !== "string" ||
      typeof value.buildId !== "string" ||
      typeof value.launcherPath !== "string" ||
      typeof value.source !== "string" ||
      typeof value.updatedAt !== "string"
    ) {
      return false;
    }
    validateCandidate(value as InstallationCandidate);
    return true;
  } catch {
    return false;
  }
}
