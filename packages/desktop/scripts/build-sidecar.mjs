// Build the diffectd sidecar: bundle the built daemon into one CJS file with
// esbuild, then turn it into a Node SEA (single executable application) so a
// packaged app runs on machines without Node. Output lands where Tauri's
// `externalBin` expects it: src-tauri/binaries/diffectd-<target-triple>.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { inject } from "postject";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const coreDist = resolve(desktop, "../core/dist");
const work = join(desktop, "src-tauri/target/sidecar");
const outDir = join(desktop, "src-tauri/binaries");

if (!existsSync(join(coreDist, "daemon-bin.js"))) {
  console.error(`daemon not built: ${coreDist} (run \`mise run build\` first)`);
  process.exit(1);
}

/** The suffix Tauri strips when bundling, matching the Rust compile target. */
function targetTriple() {
  try {
    const vv = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
    const host = vv.match(/^host: (.*)$/m)?.[1];
    if (host) return host;
  } catch {
    // rustc not on PATH; fall back to a platform map.
  }
  const triples = {
    "linux x64": "x86_64-unknown-linux-gnu",
    "linux arm64": "aarch64-unknown-linux-gnu",
    "darwin x64": "x86_64-apple-darwin",
    "darwin arm64": "aarch64-apple-darwin",
    "win32 x64": "x86_64-pc-windows-msvc",
    "win32 arm64": "aarch64-pc-windows-msvc",
  };
  const triple = triples[`${process.platform} ${process.arch}`];
  if (!triple) throw new Error(`no target triple known for ${process.platform} ${process.arch}`);
  return triple;
}

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(outDir, { recursive: true });

// SEA requires CommonJS; the daemon is ESM and dependency-free, so the bundle
// is just a format conversion. import.meta.url must be shimmed for the
// monorepo web-root fallback path (packaged runs always pass --web-root).
const bundle = join(work, "daemon-bundle.cjs");
await build({
  entryPoints: [join(coreDist, "daemon-bin.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: bundle,
  banner: {
    js: "const import_meta_url = require('node:url').pathToFileURL(__filename).href;",
  },
  define: { "import.meta.url": "import_meta_url" },
  logLevel: "warning",
});

const seaConfig = join(work, "sea-config.json");
const blob = join(work, "sea-prep.blob");
writeFileSync(
  seaConfig,
  JSON.stringify({
    main: bundle,
    output: blob,
    disableExperimentalSEAWarning: true,
  }),
);
execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });

const exe = process.platform === "win32" ? ".exe" : "";
const target = join(outDir, `diffectd-${targetTriple()}${exe}`);
copyFileSync(process.execPath, target);
chmodSync(target, 0o755);
if (process.platform === "darwin") {
  // The stock node binary is signed; injection would invalidate it.
  execFileSync("codesign", ["--remove-signature", target]);
}
await inject(target, "NODE_SEA_BLOB", readFileSync(blob), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(process.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
});
if (process.platform === "darwin") {
  execFileSync("codesign", ["--sign", "-", target]); // ad-hoc; real signing is a release concern
}
console.log(`sidecar: ${target}`);
