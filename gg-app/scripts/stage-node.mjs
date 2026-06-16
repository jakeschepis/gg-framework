// Stage a per-platform Node runtime into src-tauri/binaries/ as a Tauri
// `externalBin`. Tauri requires the file to be named with the host target
// triple suffix (e.g. ggnode-aarch64-apple-darwin) and auto-copies it next to
// the app executable at bundle time, so the packaged app never depends on a
// Node install on the user's PATH.
//
// We download the *official* Node.js distribution for the build platform/arch
// (NOT `process.execPath` — package-manager Node builds like Homebrew's are
// dynamically linked to libnode.dylib and are not self-contained). Official
// nodejs.org builds are standalone (link only against system libraries).
//
// Because each OS/arch bundle is produced on its own CI runner, the staged
// binary always matches the platform it ships to. Override the version with
// GG_NODE_VERSION, or point GG_NODE_SOURCE at a prebuilt standalone binary to
// skip the download.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcTauri = join(here, "..", "src-tauri");
const binDir = join(srcTauri, "binaries");

const NODE_VERSION = process.env.GG_NODE_VERSION || "22.12.0";

/** Resolve the Rust host target triple (e.g. aarch64-apple-darwin). */
function hostTriple() {
  return execFileSync("rustc", ["--print", "host-tuple"], {
    encoding: "utf8",
  }).trim();
}

/** Map the build platform/arch → official Node dist slug + archive extension. */
function nodeDist() {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  switch (process.platform) {
    case "darwin":
      return { slug: `darwin-${arch}`, ext: "tar.gz" };
    case "linux":
      return { slug: `linux-${arch}`, ext: "tar.xz" };
    case "win32":
      return { slug: `win-${arch}`, ext: "zip" };
    default:
      throw new Error(`unsupported platform: ${process.platform}`);
  }
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`download failed (${res.status}): ${url}`);
  }
  await pipeline(res.body, createWriteStream(dest));
}

/** Download + extract official Node, returning the path to the node binary. */
async function fetchNode(work) {
  const { slug, ext } = nodeDist();
  const name = `node-v${NODE_VERSION}-${slug}`;
  const archive = join(work, `node.${ext}`);
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${name}.${ext}`;
  console.log(`downloading ${url}`);
  await download(url, archive);

  if (ext === "zip") {
    // Windows: PowerShell Expand-Archive is always available on CI runners.
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${archive}' -DestinationPath '${work}' -Force`,
      ],
      { stdio: "inherit" },
    );
    return join(work, name, "node.exe");
  }
  execFileSync("tar", ["xf", archive, "-C", work], { stdio: "inherit" });
  return join(work, name, "bin", "node");
}

async function main() {
  const triple = hostTriple();
  const isWindows = process.platform === "win32";
  const ext = isWindows ? ".exe" : "";

  mkdirSync(binDir, { recursive: true });
  const dest = join(binDir, `ggnode-${triple}${ext}`);

  let source = process.env.GG_NODE_SOURCE;
  let work;
  if (!source) {
    work = mkdtempSync(join(tmpdir(), "ggnode-"));
    source = await fetchNode(work);
  }
  if (!existsSync(source)) {
    throw new Error(`node source not found: ${source}`);
  }

  copyFileSync(source, dest);
  if (!isWindows) {
    chmodSync(dest, 0o755);
  }
  if (work) {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`staged node runtime (v${NODE_VERSION}): ${dest}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
