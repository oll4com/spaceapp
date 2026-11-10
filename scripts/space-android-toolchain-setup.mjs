#!/usr/bin/env node
// Installs the Android toolchain App Studio builds APKs with, once, outside the repository and without root, the way
// scripts/space-video-tools-setup.mjs installs the Video tools: the JDK, the SDK command-line tools and Gradle pinned by URL,
// SHA-256 and size in scripts/android-toolchain/manifest.json, then the SDK packages at their exact revisions through sdkmanager
// (which checks each archive against Google's repository). Rerunning fetches only what is missing or wrong. Run as spaceapp-user.
// dir is /opt/spaceapp/var/toolchains/android or SPACE_ANDROID_TOOLCHAIN_DIR:
//   <dir>/jdk/<jdk>/  <dir>/sdk/{cmdline-tools/latest,platforms,build-tools,ndk,cmake}/  <dir>/gradle/<gradle>/  <dir>/gradle-home/
//   node scripts/space-android-toolchain-setup.mjs --status     JSON: what is installed and what is missing
//   node scripts/space-android-toolchain-setup.mjs --install
//   node scripts/space-android-toolchain-setup.mjs --smoke      builds a blank Expo app into an APK (no upload) and seeds the Gradle cache
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TOOLCHAIN_DIR = "/opt/spaceapp/var/toolchains/android";
export const MANIFEST = JSON.parse(readFileSync(join(scriptsDir, "android-toolchain", "manifest.json"), "utf8"));

/** Where each piece lives under the toolchain dir; the build script reads the same paths. */
export function toolchainPaths(dir) {
  const javaHome = join(dir, "jdk", MANIFEST.jdk.dir);
  const sdk = join(dir, "sdk");
  return {
    dir, javaHome, java: join(javaHome, "bin", "java"), sdk,
    sdkmanager: join(sdk, "cmdline-tools", "latest", "bin", "sdkmanager"),
    gradle: join(dir, "gradle", MANIFEST.gradle.dir, "bin", "gradle"),
    gradleHome: join(dir, "gradle-home"),
    buildTools: join(sdk, "build-tools", Object.keys(MANIFEST.sdkPackages).find((id) => id.startsWith("build-tools;")).split(";")[1])
  };
}
/** "ndk;27.1.12297006" → <sdk>/ndk/27.1.12297006 (sdkmanager's own layout). */
export const sdkPackageDir = (sdk, id) => join(sdk, ...id.split(";"));
/** Pkg.Revision of an installed SDK package (source.properties), null when absent. */
export function sdkPackageRevision(sdk, id) {
  const text = existsSync(join(sdkPackageDir(sdk, id), "source.properties")) ? readFileSync(join(sdkPackageDir(sdk, id), "source.properties"), "utf8") : "";
  return /^Pkg\.Revision\s*=\s*(.+)$/m.exec(text)?.[1].trim() ?? null;
}

const sha256 = (path) => new Promise((resolve, reject) => {
  const hash = createHash("sha256");
  createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex"))).on("error", reject);
});
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: ["pipe", "inherit", "inherit"], ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status}).`);
};

export async function status(dir) {
  const paths = toolchainPaths(dir);
  const sdkPackages = Object.fromEntries(Object.entries(MANIFEST.sdkPackages).map(([id, revision]) => {
    const installed = sdkPackageRevision(paths.sdk, id);
    return [id, { pinned: revision, installed, ok: installed === revision }];
  }));
  const present = { jdk: existsSync(paths.java), cmdlineTools: existsSync(paths.sdkmanager), gradle: existsSync(paths.gradle), gradleHome: existsSync(paths.gradleHome) };
  const missing = [...Object.entries(present).filter(([, ok]) => !ok).map(([name]) => name), ...Object.entries(sdkPackages).filter(([, entry]) => !entry.ok).map(([id]) => id)];
  return { ok: missing.length === 0, dir, expoSdk: MANIFEST.expoSdk, jdk: MANIFEST.jdk.version, cmdlineTools: MANIFEST.cmdlineTools.version, gradle: MANIFEST.gradle.version,
    present, sdkPackages, missing };
}

/** Downloads one pinned archive and checks its SHA-256 and size before anything unpacks it. */
async function fetchPinned(dir, name, spec) {
  const target = join(dir, "downloads", spec.url.split("/").pop().replace(/%2B/g, "+"));
  if (existsSync(target) && await sha256(target) === spec.sha256) return target;
  await mkdir(dirname(target), { recursive: true });
  const response = await fetch(spec.url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`${name}: HTTP ${response.status}.`);
  const partial = `${target}.partial`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  const actual = await sha256(partial), size = (await stat(partial)).size;
  if (actual !== spec.sha256 || size !== spec.size) {
    await rm(partial);
    throw new Error(`${name}: SHA-256 ${actual} (${size} bytes) is not the pinned ${spec.sha256} (${spec.size} bytes).`);
  }
  await rename(partial, target);
  return target;
}
/** Unpacks into a fresh folder next to the destination and moves the one top-level entry into place. */
async function unpack(archive, destination, inner) {
  const staging = `${destination}.unpacking`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  if (archive.endsWith(".zip")) run("unzip", ["-q", archive, "-d", staging]);
  else run("tar", ["-xzf", archive, "-C", staging]);
  await rm(destination, { recursive: true, force: true });
  await mkdir(dirname(destination), { recursive: true });
  await rename(join(staging, inner), destination);
  await rm(staging, { recursive: true, force: true });
}

export async function install(dir) {
  const paths = toolchainPaths(dir);
  if (!existsSync(paths.java)) await unpack(await fetchPinned(dir, "jdk", MANIFEST.jdk), paths.javaHome, MANIFEST.jdk.dir);
  console.log(`ok jdk ${MANIFEST.jdk.version}`);
  if (!existsSync(paths.sdkmanager)) await unpack(await fetchPinned(dir, "cmdline-tools", MANIFEST.cmdlineTools), join(paths.sdk, "cmdline-tools", "latest"), "cmdline-tools");
  console.log(`ok cmdline-tools ${MANIFEST.cmdlineTools.version}`);
  if (!existsSync(paths.gradle)) await unpack(await fetchPinned(dir, "gradle", MANIFEST.gradle), join(dir, "gradle", MANIFEST.gradle.dir), MANIFEST.gradle.dir);
  console.log(`ok gradle ${MANIFEST.gradle.version}`);
  await mkdir(paths.gradleHome, { recursive: true });
  const env = { ...process.env, JAVA_HOME: paths.javaHome, PATH: `${join(paths.javaHome, "bin")}:${process.env.PATH ?? ""}` };
  const wanted = Object.entries(MANIFEST.sdkPackages).filter(([id, revision]) => sdkPackageRevision(paths.sdk, id) !== revision).map(([id]) => id);
  if (wanted.length) {
    // The operator asked for this toolchain (plan clipboard:VLBu2ge110ho): the SDK licenses are accepted for this SDK root only.
    run(paths.sdkmanager, [`--sdk_root=${paths.sdk}`, "--licenses"], { env, input: "y\n".repeat(20) });
    run(paths.sdkmanager, [`--sdk_root=${paths.sdk}`, "--install", ...wanted], { env, input: "y\n".repeat(20) });
  }
  for (const [id, revision] of Object.entries(MANIFEST.sdkPackages)) {
    const installed = sdkPackageRevision(paths.sdk, id);
    if (installed !== revision) throw new Error(`${id}: sdkmanager installed revision ${installed}, the manifest pins ${revision}.`);
    console.log(`ok ${id} ${revision}`);
  }
  await rm(join(dir, "downloads"), { recursive: true, force: true });
  console.log(JSON.stringify(await status(dir)));
}

/** A blank Expo app of the pinned SDK, built into an APK without an upload: proves the toolchain and seeds the shared Gradle cache. */
export async function smoke(dir) {
  const app = join(dir, "smoke", "app");
  if (!existsSync(join(app, "node_modules", "expo"))) {
    await rm(join(dir, "smoke"), { recursive: true, force: true });
    await mkdir(join(dir, "smoke"), { recursive: true });
    run("npx", ["--yes", "create-expo-app@5", "app", "--template", `blank-typescript@sdk-${MANIFEST.expoSdk}`], { cwd: join(dir, "smoke"), env: { ...process.env, CI: "1" } });
    const config = JSON.parse(await readFile(join(app, "app.json"), "utf8"));
    config.expo.android = { ...config.expo.android, package: "dev.spaceapp.toolchainsmoke" };
    await writeFile(join(app, "app.json"), `${JSON.stringify(config, null, 2)}\n`);
  }
  const { runBuild } = await import("./space-app-studio-build.mjs");
  // The smoke app belongs to no pane: run outside the pane rule even from a pane's shell.
  const result = await runBuild(app, { upload: false, toolchainDir: dir, log: (line) => console.log(line), env: { ...process.env, SPACE_PANE_ID: "" } });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const args = new Set(process.argv.slice(2));
  const dir = process.env.SPACE_ANDROID_TOOLCHAIN_DIR || DEFAULT_TOOLCHAIN_DIR;
  (async () => {
    if (args.has("--status")) console.log(JSON.stringify(await status(dir), null, 2));
    else if (args.has("--install")) await install(dir);
    else if (args.has("--smoke")) await smoke(dir);
    else throw new Error("Usage: space-android-toolchain-setup.mjs --status | --install | --smoke");
  })().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
