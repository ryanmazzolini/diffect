import { readFileSync } from "node:fs";

const root = JSON.parse(readFileSync("package.json", "utf8"));
const tauri = JSON.parse(readFileSync("packages/desktop/src-tauri/tauri.conf.json", "utf8"));
const cargo = readFileSync("packages/desktop/src-tauri/Cargo.toml", "utf8");
const cargoLock = readFileSync("packages/desktop/src-tauri/Cargo.lock", "utf8");

const cargoVersion = cargo.match(/^version = "([^"]+)"$/m)?.[1];
const cargoLockVersion = cargoLock.match(/^name = "diffect-desktop"\nversion = "([^"]+)"$/m)?.[1];
const versions = {
  package: root.version,
  tauri: tauri.version,
  cargo: cargoVersion,
  cargoLock: cargoLockVersion,
};

if (!/^\d+\.\d+\.\d+$/.test(root.version) || Object.values(versions).some((version) => version !== root.version)) {
  throw new Error(`release versions disagree: ${JSON.stringify(versions)}`);
}

console.log(`release version ${root.version}`);
