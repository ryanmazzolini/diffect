import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activateInstallation,
  compareSemver,
  InstallationAuthorityError,
  InstallationReadError,
  installationPath,
  readInstallation,
  type InstallationCandidate,
} from "../src/store/installation.js";
import { daemonMarkerPath, writeDaemonMarker } from "../src/store/daemon-marker.js";
import {
  managedDaemonPath,
  readManagedDaemon,
  writeManagedDaemon,
} from "../src/store/managed-daemon.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "diffect-install-"));
  process.env.XDG_CONFIG_HOME = root;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function candidate(
  version: string,
  buildId = `build-${version}`,
  launcherPath = join(root, `diffect-${version}`),
): InstallationCandidate {
  return { version, buildId, launcherPath, source: "explicit" };
}

describe("installed build authority", () => {
  it("selects the first build, follows the same build after a move, and advances only", async () => {
    await activateInstallation(candidate("1.2.0"));
    await activateInstallation(candidate("1.2.0", "build-1.2.0", join(root, "moved")));
    expect(await readInstallation()).toMatchObject({
      version: "1.2.0",
      buildId: "build-1.2.0",
      launcherPath: join(root, "moved"),
    });

    await activateInstallation(candidate("1.3.0"));
    await expect(activateInstallation(candidate("1.2.1"))).rejects.toThrow(
      InstallationAuthorityError,
    );
    expect((await readInstallation())?.version).toBe("1.3.0");
  });

  it("rejects republished builds and requires a stopped daemon for confirmed rollback", async () => {
    await activateInstallation(candidate("2.0.0", "release-a"));
    await expect(
      activateInstallation(candidate("2.0.0", "release-b")),
    ).rejects.toThrow(/different build/);
    await expect(
      activateInstallation(candidate("1.9.0"), {
        confirmRollback: true,
        daemonRunning: true,
      }),
    ).rejects.toThrow(/stop the running/);

    await activateInstallation(candidate("1.9.0"), { confirmRollback: true });
    expect((await readInstallation())?.version).toBe("1.9.0");
  });

  it("fails closed on a corrupt authority record", async () => {
    await activateInstallation(candidate("1.0.0"));
    await writeFile(installationPath(), "not json", "utf8");
    await expect(activateInstallation(candidate("2.0.0"))).rejects.toThrow(
      InstallationReadError,
    );
    expect(await readFile(installationPath(), "utf8")).toBe("not json");
  });

  it("orders stable and prerelease versions with SemVer precedence", () => {
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0-rc.2", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBeLessThan(0);
  });
});

describe("private lifecycle records", () => {
  it("atomically creates owner-only installation and daemon records", async () => {
    await activateInstallation(candidate("1.0.0"));
    await writeDaemonMarker("http://127.0.0.1:13433");
    await writeManagedDaemon({
      origin: "http://127.0.0.1:13433",
      version: "1.0.0",
      buildId: "build-1.0.0",
      webAssetId: "b".repeat(64),
      instanceId: "instance",
      stopToken: "a".repeat(64),
    });

    expect((await stat(installationPath())).mode & 0o777).toBe(0o600);
    expect((await stat(daemonMarkerPath())).mode & 0o777).toBe(0o600);
    expect((await stat(managedDaemonPath())).mode & 0o777).toBe(0o600);
    expect(await readManagedDaemon()).toMatchObject({
      version: "1.0.0",
      instanceId: "instance",
      stopToken: "a".repeat(64),
    });
  });
});
