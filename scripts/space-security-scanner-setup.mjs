#!/usr/bin/env node
// Installs the container image scanner of the Security Copilot (plan clipboard:8ce8_URHW9Dk step 13 B) once, outside the repository and
// without root, the way scripts/space-android-toolchain-setup.mjs installs its toolchain: Trivy pinned by version, URL, SHA-256 and size,
// the version run-spaceapp's release gates scan with. Its vulnerability database lives in <dir>/cache. Run as spaceapp-user.
// dir is /opt/spaceapp/var/toolchains/trivy or SPACE_SECURITY_SCANNER_DIR:
//   node scripts/space-security-scanner-setup.mjs --status     JSON: installed or not
//   node scripts/space-security-scanner-setup.mjs --install
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const DEFAULT_SCANNER_DIR = "/opt/spaceapp/var/toolchains/trivy";
export const TRIVY = {
  version: "0.70.0",
  url: "https://github.com/aquasecurity/trivy/releases/download/v0.70.0/trivy_0.70.0_Linux-64bit.tar.gz",
  sha256: "8b4376d5d6befe5c24d503f10ff136d9e0c49f9127a4279fd110b727929a5aa9",
  size: 47748408
};
export const scannerDir = () => process.env.SPACE_SECURITY_SCANNER_DIR || DEFAULT_SCANNER_DIR;
export const trivyPaths = (dir = scannerDir()) => ({ binary: join(dir, TRIVY.version, "trivy"), cache: join(dir, "cache") });

const sha256 = (file) => new Promise((resolve, reject) => {
  const hash = createHash("sha256");
  createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex"))).on("error", reject);
});

export function status(dir = scannerDir()) {
  const paths = trivyPaths(dir);
  const installed = existsSync(paths.binary);
  const version = installed ? /Version:\s*(\S+)/.exec(spawnSync(paths.binary, ["--version"], { encoding: "utf8" }).stdout ?? "")?.[1] ?? null : null;
  return { ok: version === TRIVY.version, dir, pinned: TRIVY.version, installed: version, binary: paths.binary, cache: paths.cache };
}

export async function install(dir = scannerDir()) {
  const paths = trivyPaths(dir);
  if (status(dir).ok) return status(dir);
  const staging = join(dir, `${TRIVY.version}.installing`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const archive = join(staging, "trivy.tar.gz");
  const response = await fetch(TRIVY.url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`trivy: HTTP ${response.status}.`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
  const actual = await sha256(archive), size = (await stat(archive)).size;
  if (actual !== TRIVY.sha256 || size !== TRIVY.size) {
    await rm(staging, { recursive: true, force: true });
    throw new Error(`trivy: SHA-256 ${actual} (${size} bytes) is not the pinned ${TRIVY.sha256} (${TRIVY.size} bytes).`);
  }
  const untar = spawnSync("tar", ["-xzf", archive, "-C", staging, "trivy"], { stdio: "inherit" });
  if (untar.status !== 0) throw new Error("trivy: the archive did not unpack.");
  await chmod(join(staging, "trivy"), 0o755);
  await rm(archive);
  await rm(join(dir, TRIVY.version), { recursive: true, force: true });
  await rename(staging, join(dir, TRIVY.version));
  await mkdir(paths.cache, { recursive: true });
  return status(dir);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const args = new Set(process.argv.slice(2));
  (async () => {
    if (args.has("--status")) console.log(JSON.stringify(status(), null, 2));
    else if (args.has("--install")) console.log(JSON.stringify(await install(), null, 2));
    else throw new Error("Usage: space-security-scanner-setup.mjs --status | --install");
  })().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
