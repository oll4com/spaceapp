#!/usr/bin/env node
// App Studio APK builds (plan clipboard:VLBu2ge110ho step 2): the App Studio agent builds an installable APK of its own Expo app
// and the pane shows it for download. Runs as the agent itself, inside its CLI (no API process builds anything), with the
// pinned toolchain of scripts/space-android-toolchain-setup.mjs. The build: `expo prebuild --platform android`, then Gradle's
// release variant, which the Expo template signs with the project's debug keystore and which carries the JS bundle, so the APK
// runs on a phone without a Metro server. arm64-v8a only (every current phone). One build at a time, refused while the server is
// OVERLOADED, Gradle through space-load-gate. Never a store upload.
// Signing (Nous decision 2026-10-27, plan clipboard:3ehZgZQhxvio): debug by default; `release` re-signs the APK with the app's own
// kept key from the operator's Vault, only for an app id in RELEASE_KEYS. The key reaches this process only through
// space_vault_key_install, into 0600 files in the pane's builds folder that are deleted right after apksigner (also when it fails);
// it is never in a log, a report, Media or a repository, and the signer must be the certificate RELEASE_KEYS names.
// space_appstudio_build_apk / _build_status call the same code; an agent whose CLI predates them runs this from its shell:
//   node /opt/spaceapp/scripts/space-app-studio-build.mjs start <app dir> [--release] [--release-build]  {jobId, log}: the build runs in the background
//   node /opt/spaceapp/scripts/space-app-studio-build.mjs status [jobId] [--wait <s, ≤50>]              the job (the newest without jobId)
//   node /opt/spaceapp/scripts/space-app-studio-build.mjs run <app dir> [--release] [--release-build] [--no-upload]  the build in the foreground
// --release-build marks the APK a release: it is filed in Agent Files › Apps/Android, which the Nous app's updater reads. Without it the
// build is a test build, filed in Apps/Android/Builds (never offered as an update). --release is separate: it re-signs with the kept key.
// A release build is refused before Gradle while a brief done since the last release has no preview proof (space_appstudio_done items).
// Google Play (plan clipboard:kTV3y2lwO-99 step 18): `run <app dir> --aab --no-upload` also builds the Android App Bundle (bundleRelease,
// same R8 compat flags); signRelease(<.aab>) re-signs it with jarsigner (Play's upload signature), and
//   node /opt/spaceapp/scripts/space-app-studio-build.mjs pepk <app id> <pepk.jar> <encryption_public_key.pem> <out.zip>
// exports the kept key encrypted for Play App Signing, so Play signs with the certificate MOBILE_APP_SIGNERS pins.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, X509Certificate } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, openAsBlob, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TOOLCHAIN_DIR, MANIFEST, status as toolchainStatus, toolchainPaths } from "./space-android-toolchain-setup.mjs";
import { overloadReasons, readLoad } from "./space-load-gate.mjs";
import { appStudioEndpoint } from "./space-app-studio-mcp.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const loadGate = join(dirname(scriptPath), "space-load-gate.mjs");
const tokenHeader = "x-space-cli-browser-token";
/** The certificate the Android debug keystore carries: a debug build with any other signer is refused. */
export const DEBUG_SIGNER = /CN=Android Debug/;
const STATUS_WAIT_MAX_S = 50;
/**
 * Apps with their own kept release key in the operator's Vault, a reviewed list (Nous decision 2026-10-27): the Vault key ids of the
 * keystore (PKCS12, base64) and of its password, the key's alias and the public SHA-256 of its certificate. No other app id is
 * release-signed.
 */
export const RELEASE_KEYS = Object.freeze({
  "com.oll4.spaceapp.nous": Object.freeze({
    alias: "nous", keystoreKeyId: "vault_key:lK-K-GFyXteytsctAr7kyw", passwordKeyId: "vault_key:6vZtwHs6cXbc42kr3sQhAw",
    certSha256: "fd4581c014540252394c80a0584404b02846d2379562aafd1e3e3c9fe314beb6"
  }),
  // SpaceApp Android 0.2.0+ (plan clipboard:wcFCHovvfVmA): 0.1.25's key, so it installs over 0.1.25 as an update.
  "com.oll4.spaceapp": Object.freeze({
    alias: "spaceapp", keystoreKeyId: "vault_key:CfpjWwpVHMG7xqm6o45ZOg", passwordKeyId: "vault_key:lTd-LoasZrVGQkW71mPbzA",
    certSha256: "3a05ad527f584885b0a20f622c4dbbda912cd5d590a33de28a59c7d250b7192e"
  })
});
export const SIGNINGS = ["debug", "release"];
export const ABIS = ["arm64-v8a", "x86_64"];

const paneSlug = (env = process.env) => (env.SPACE_PANE_ID || "pane").replace(/[^A-Za-z0-9_-]/g, "_");
/** The pane's own folder (the preview's root): its apps, builds and logs. */
export const paneFolder = (env = process.env) => join(env.SPACE_APP_STUDIO_DIR || join(homedir(), "agent-workspace", "app-studio"), paneSlug(env));
const buildsDir = (env = process.env) => join(paneFolder(env), "builds");
const writable = (path) => { try { accessSync(path, constants.W_OK); return true; } catch { return false; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };

/**
 * The app folder, checked: absolute, an Expo project with its packages installed, and (in a pane) inside that pane's own folder,
 * so one pane never builds another pane's app.
 */
export async function resolveAppDir(dir, env = process.env) {
  if (typeof dir !== "string" || !dir.startsWith("/")) throw new Error("Give the absolute path of the Expo app folder (the one with package.json).");
  const app = await realpath(dir).catch(() => null);
  if (!app) throw new Error(`${dir} does not exist.`);
  if (env.SPACE_PANE_ID) {
    const own = await realpath(paneFolder(env)).catch(() => paneFolder(env));
    if (!app.startsWith(`${own}${sep}`)) throw new Error(`Build only this pane's own app: ${dir} is outside ${own}.`);
  }
  const pkg = JSON.parse(await readFile(join(app, "package.json"), "utf8").catch(() => "null"));
  if (!pkg?.dependencies?.expo) throw new Error(`${dir} is not an Expo app (package.json has no expo dependency).`);
  if (!existsSync(join(app, "node_modules", "expo"))) throw new Error(`${dir} has no node_modules: run npm install there first.`);
  const configFile = ["app.config.ts", "app.config.js", "app.config.mjs", "app.config.cjs"].some((name) => existsSync(join(app, name)));
  const config = JSON.parse(await readFile(join(app, "app.json"), "utf8").catch(() => "null"));
  if (!configFile && !config?.expo?.android?.package) throw new Error("Set expo.android.package in app.json (e.g. com.example.<slug>) before the first APK.");
  return app;
}

/** The Gradle home: the toolchain's shared cache where this CLI may write (stable), else the pane's own one reading the shared cache. */
export function gradleHomeFor(paths, env = process.env) {
  if (env.SPACE_APP_STUDIO_GRADLE_HOME) return { home: env.SPACE_APP_STUDIO_GRADLE_HOME, readOnlyCache: null };
  if (writable(paths.gradleHome)) return { home: paths.gradleHome, readOnlyCache: null };
  return { home: join(paneFolder(env), ".gradle-home"), readOnlyCache: existsSync(join(paths.gradleHome, "caches")) ? join(paths.gradleHome, "caches") : null };
}

/** The Gradle version a project's wrapper names (android/gradle/wrapper/gradle-wrapper.properties). */
export function wrapperGradleVersion(text) {
  return /distributionUrl=.*gradle-([0-9][0-9A-Za-z.-]*?)-(?:bin|all)\.zip/.exec(text)?.[1] ?? null;
}
/** package name, versionCode and versionName from `aapt2 dump badging`. */
export function parseBadging(text) {
  const line = /^package: (.*)$/m.exec(text)?.[1] ?? "";
  const field = (name) => new RegExp(`${name}='([^']*)'`).exec(line)?.[1] ?? null;
  return { packageName: field("name"), versionCode: Number(field("versionCode") ?? 0), versionName: field("versionName") };
}

function step(command, args, { cwd, env, logFd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", logFd, logFd] });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${[command, ...args].join(" ").slice(0, 200)} ended with ${signal ?? `exit ${code}`}; see the log.`)));
  });
}
function lockBuild(home) {
  const lock = join(home, ".space-app-studio-build.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => { try { unlinkSync(lock); } catch { /* already gone */ } };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const holder = Number(readFileSync(lock, "utf8"));
      if (holder && alive(holder)) throw new Error("Another App Studio APK build is running; one build at a time. Try again when it is done.", { cause: error });
      unlinkSync(lock);
    }
  }
  throw new Error("Could not take the build lock.");
}

/**
 * The build itself. Returns the APK's path, size, package and version, and (with upload) the room Media artifact the pane shows.
 * `log` gets one line per stage; the tools' output goes to logFd (the job's log file) or this process's own output.
 */
export async function runBuild(dir, { upload = true, signing = "debug", releaseBuild = false, minify = releaseBuild, abi = "arm64-v8a", bundle = false, toolchainDir = process.env.SPACE_ANDROID_TOOLCHAIN_DIR || DEFAULT_TOOLCHAIN_DIR, log = () => {}, logFd = "inherit", env: baseEnv = process.env } = {}) {
  const began = Date.now();
  if (!SIGNINGS.includes(signing)) throw new Error(`signing is debug or release, not ${signing}.`);
  // x86_64 only for the lab emulator (space-app-studio-apk-proof.mjs builds it without upload): phones run arm64.
  if (!ABIS.includes(abi) || (abi !== "arm64-v8a" && upload)) throw new Error(`abi is ${ABIS.join(" or ")}; x86_64 builds are for the lab emulator only (no upload).`);
  // The pane shows APKs; a bundle is for Play Console, which the operator uploads to.
  if (bundle && upload) throw new Error("An App Bundle (.aab) build is --no-upload: it is for Google Play, not the pane.");
  const app = await resolveAppDir(dir, baseEnv);
  const configured = await configuredPackage(app);
  if (signing === "release" && configured) releaseKeyFor(configured);
  if (releaseBuild && upload) await assertReleaseProven(baseEnv);
  const installed = await toolchainStatus(toolchainDir);
  if (!installed.ok) throw new Error(`The Android toolchain is not installed (${installed.missing.join(", ")}): node /opt/spaceapp/scripts/space-android-toolchain-setup.mjs --install.`);
  const paths = toolchainPaths(toolchainDir);
  const gradle = gradleHomeFor(paths, baseEnv);
  await mkdir(gradle.home, { recursive: true });
  const env = { ...baseEnv, CI: "1", EXPO_NO_TELEMETRY: "1", JAVA_HOME: paths.javaHome, ANDROID_HOME: paths.sdk, ANDROID_SDK_ROOT: paths.sdk, GRADLE_USER_HOME: gradle.home,
    ...(gradle.readOnlyCache ? { GRADLE_RO_DEP_CACHE: gradle.readOnlyCache } : {}), PATH: `${join(paths.javaHome, "bin")}:${baseEnv.PATH ?? ""}` };
  const unlock = lockBuild(gradle.home);
  const fd = logFd === "inherit" ? "inherit" : logFd;
  try {
    log("prebuild: npx expo prebuild --platform android");
    await step("npx", ["expo", "prebuild", "--platform", "android", "--no-install"], { cwd: app, env, logFd: fd });
    const wrapper = wrapperGradleVersion(await readFile(join(app, "android", "gradle", "wrapper", "gradle-wrapper.properties"), "utf8").catch(() => ""));
    if (wrapper && wrapper !== MANIFEST.gradle.version) {
      throw new Error(`This app's Gradle is ${wrapper}; the toolchain pins ${MANIFEST.gradle.version} (Expo SDK ${MANIFEST.expoSdk}). Ask Nous to update scripts/android-toolchain/manifest.json.`);
    }
    log(`gradle ${MANIFEST.gradle.version}: assembleRelease${bundle ? " bundleRelease" : ""} (debug keystore, ${abi}${minify ? ", R8" : ""}) through space-load-gate`);
    // MASVS L2 RESILIENCE-3: a release build is shrunk and obfuscated with R8 (Expo's and the libraries' consumer keep rules, the app's
    // proguard-rules.pro); test builds keep it off for speed. space-app-studio-apk-proof.mjs builds with R8 too, so it opens what ships.
    // Compat mode, not full mode: libraries' rules are written for ProGuard (Room 2.5's `-keep class * extends RoomDatabase` keeps the
    // constructor WorkManager instantiates only in compat mode; full mode removed it and the Nous app crashed at start, lab 2/11).
    await step(process.execPath, [loadGate, "--", paths.gradle, "-p", "android", "assembleRelease", ...(bundle ? ["bundleRelease"] : []), "--no-daemon", "--console=plain", "--max-workers=4",
      `-PreactNativeArchitectures=${abi}`, `-Pandroid.enableMinifyInReleaseBuilds=${minify}`, "-Pandroid.enableR8.fullMode=false"], { cwd: app, env, logFd: fd });
    const apk = join(app, "android", "app", "build", "outputs", "apk", "release", "app-release.apk");
    if (!existsSync(apk)) throw new Error("Gradle finished without android/app/build/outputs/apk/release/app-release.apk.");
    const signers = spawnSync(join(paths.buildTools, "apksigner"), ["verify", "--print-certs", apk], { env, encoding: "utf8" });
    if (signers.status !== 0 || !DEBUG_SIGNER.test(signers.stdout)) throw new Error("Gradle's APK is not signed with the Android debug keystore; App Studio starts from a debug-signed build.");
    const aab = bundle ? join(app, "android", "app", "build", "outputs", "bundle", "release", "app-release.aab") : null;
    if (aab && !DEBUG_SIGNER.test(spawnSync(join(paths.javaHome, "bin", "keytool"), ["-printcert", "-jarfile", aab], { env, encoding: "utf8" }).stdout ?? "")) {
      throw new Error("Gradle finished without a debug-signed android/app/build/outputs/bundle/release/app-release.aab.");
    }
    const badging = parseBadging(spawnSync(join(paths.buildTools, "aapt2"), ["dump", "badging", apk], { encoding: "utf8" }).stdout ?? "");
    // B (Nous 31/10): a release of this exact version only once it was installed and opened on the lab emulator (space-app-studio-apk-proof.mjs).
    if (releaseBuild && upload) await assertReleaseProven(baseEnv, badging);
    let signature = { signedWith: "android-debug-keystore" };
    if (signing === "release") {
      log(`sign: ${badging.packageName} with its kept release key from the Vault`);
      signature = await signRelease(apk, badging.packageName, { paths, env });
      if (aab) await signRelease(aab, badging.packageName, { paths, env });
    }
    const byteSize = (await stat(apk)).size;
    const buildMs = Date.now() - began;
    const result = { apk, byteSize, ...(aab ? { aab, aabByteSize: (await stat(aab)).size } : {}), ...badging, buildMs, ...signature, abi };
    if (!upload) return result;
    log("upload: the APK goes to the pane (room Media)");
    return { ...result, ...(await uploadApk(apk, { ...badging, buildMs, signedWith: signature.signedWith, release: releaseBuild }, baseEnv)) };
  } finally {
    unlock();
  }
}

/** A release build only once every brief done since the last release has its preview proof (operator 31/10 14:13 BKK); asked before Gradle. */
export async function assertReleaseProven(env = process.env, apk = null) {
  const endpoint = appStudioEndpoint(env), token = env.SPACE_BROWSER_ACTION_TOKEN || "";
  if (!endpoint || !token) throw new Error("A release build checks its briefs' proof through the App Studio bridge, which this CLI does not have (SPACE_BROWSER_COMMAND_ENDPOINT, SPACE_BROWSER_ACTION_TOKEN).");
  const body = JSON.stringify(apk ? { packageName: apk.packageName, versionName: apk.versionName } : {});
  const response = await fetch(`${endpoint}/release-check`, { method: "POST", headers: { "content-type": "application/json", [tokenHeader]: token }, body, signal: AbortSignal.timeout(30_000) });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || payload?.message || `The release check returned HTTP ${response.status}.`);
}

async function uploadApk(apk, info, env = process.env) {
  const endpoint = appStudioEndpoint(env), token = env.SPACE_BROWSER_ACTION_TOKEN || "";
  if (!endpoint || !token) throw new Error("Space App Studio bridge is not available for this pane (SPACE_BROWSER_COMMAND_ENDPOINT, SPACE_BROWSER_ACTION_TOKEN); the APK is at the path above.");
  const form = new FormData();
  // Fields first: the API reads them before the file.
  form.set("packageName", info.packageName ?? "");
  form.set("versionName", info.versionName ?? "");
  form.set("versionCode", String(info.versionCode ?? 0));
  form.set("buildMs", String(info.buildMs));
  form.set("signedWith", info.signedWith ?? "android-debug-keystore");
  if (info.release) form.set("release", "true");
  form.set("apk", await openAsBlob(apk, { type: "application/vnd.android.package-archive" }), "app-release.apk");
  const response = await fetch(`${endpoint}/apk`, { method: "POST", body: form, headers: { [tokenHeader]: token }, signal: AbortSignal.timeout(300_000) });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || payload?.message || `The APK upload returned HTTP ${response.status}.`);
  return payload;
}

/** The app's kept release key; refused for any app id not in RELEASE_KEYS (debug stays the default for every app). */
export function releaseKeyFor(packageName) {
  const key = Object.hasOwn(RELEASE_KEYS, packageName ?? "") ? RELEASE_KEYS[packageName] : null;
  if (!key) throw new Error(`${packageName || "This app"} has no kept release key in the Vault: App Studio release-signs only ${Object.keys(RELEASE_KEYS).join(", ")}. Build it debug-signed (the default).`);
  return key;
}
/**
 * Every certificate digest `apksigner verify --print-certs` names ("Signer #1 …" up to build-tools 36, "V3.0 Signer: …" in 37), or
 * `keytool -printcert -jarfile` for a bundle ("SHA256: AB:CD:…", one per certificate of every signer).
 */
const signerDigests = (text) => [...text.matchAll(/certificate SHA-256 digest: ([0-9a-f]{64})|SHA256: ((?:[0-9A-F]{2}:){31}[0-9A-F]{2})/g)]
  .map((match) => match[1] ?? match[2].replaceAll(":", "").toLowerCase());

/** space_vault_key_install through the pane's capability bridge: Space writes the value into `path` (0600); this process never sees it in an answer. */
export function vaultInstall(id, path, env = process.env) {
  const call = spawnSync("space-capability", ["call"], {
    input: JSON.stringify({ serverId: "space_vault", toolName: "space_vault_key_install", arguments: { id, path, content: "{{SPACE_VAULT_KEY}}", mode: "write" } }),
    encoding: "utf8", env, timeout: 60_000
  });
  // The answer is {status, path, bytes, auditId} or a refusal with its reason; never the value.
  let reply = null, answer = null;
  try { reply = JSON.parse(call.stdout); answer = reply.structuredContent ?? JSON.parse(reply.content?.[0]?.text ?? "null"); } catch { answer = null; }
  if (answer?.status !== "INSTALLED") {
    const reason = answer?.reason ?? (typeof reply?.error === "string" ? reply.error.slice(0, 200) : call.error?.message ?? "no answer");
    throw new Error(`The Vault did not install ${id} (${answer?.status ?? "FAILED"}: ${reason}).`);
  }
}

/**
 * Runs `use` with the app's kept keystore (PKCS12) and its password from the Vault, in a 0700 folder of 0600 files under the pane's
 * builds folder that is removed right after, whatever happened. No tool's output is kept: it may name the key's files.
 */
async function withReleaseKey(key, env, install, use) {
  await mkdir(buildsDir(env), { recursive: true, mode: 0o700 });
  // A build killed while it signed (no finally ran) left its key folder: it goes before anything else.
  for (const stale of (await readdir(buildsDir(env))).filter((name) => name.startsWith(".release-key-"))) await rm(join(buildsDir(env), stale), { recursive: true, force: true });
  const dir = await mkdtemp(join(buildsDir(env), ".release-key-"));
  await chmod(dir, 0o700);
  const keystoreText = join(dir, "keystore.b64"), keystore = join(dir, "keystore.p12"), password = join(dir, "password");
  try {
    await install(key.keystoreKeyId, keystoreText, env);
    await install(key.passwordKeyId, password, env);
    await writeFile(keystore, Buffer.from((await readFile(keystoreText, "utf8")).trim(), "base64"), { mode: 0o600 });
    return await use({ dir, keystore, password, alias: key.alias });
  } finally {
    // The key goes at once, also when the Vault, the decoding or the tool failed.
    await rm(dir, { recursive: true, force: true });
  }
}

// Gradle signed the bundle with the debug key: its v1 signature files go first, or the bundle would carry two signers.
const STRIP_JAR_SIGNATURES = `import re, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as src, zipfile.ZipFile(sys.argv[2], "w") as dst:
    for info in src.infolist():
        if not re.fullmatch(r"META-INF/(MANIFEST\\.MF|[^/]+\\.(SF|RSA|DSA|EC))", info.filename, re.I): dst.writestr(info, src.read(info))`;

/**
 * Re-signs `file` in place with the app's kept release key: an APK with apksigner (it replaces the debug signature), an .aab with
 * jarsigner after its debug signature is stripped (Play's upload signature). The new signers must all be the key's certificate.
 */
export async function signRelease(file, packageName, { paths, env = process.env, install = vaultInstall, sign = null, verify = null } = {}) {
  const key = releaseKeyFor(packageName);
  const bundle = file.endsWith(".aab");
  const signed = `${file}.release-signed`;
  const apksigner = paths?.buildTools ? join(paths.buildTools, "apksigner") : "apksigner";
  const jdk = (name) => (paths?.javaHome ? join(paths.javaHome, "bin", name) : name);
  const quiet = { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
  // PKCS12 has one password: apksigner and jarsigner take it for the key too. A --key-pass naming the same file would read past its end.
  const runSign = sign ?? (bundle
    ? ({ dir, keystore, password, alias }) => {
      const unsigned = join(dir, "unsigned.aab");
      return spawnSync("python3", ["-I", "-c", STRIP_JAR_SIGNATURES, file, unsigned], quiet).status === 0
        && spawnSync(jdk("jarsigner"), ["-keystore", keystore, "-storetype", "PKCS12", "-storepass:file", password, "-signedjar", signed, unsigned, alias], quiet).status === 0;
    }
    : ({ keystore, password, alias }) => spawnSync(apksigner, ["sign", "--ks", keystore, "--ks-type", "PKCS12", "--ks-key-alias", alias, "--ks-pass", `file:${password}`,
      "--out", signed, file], quiet).status === 0);
  const tool = bundle ? "jarsigner" : "apksigner";
  let ok = false;
  try {
    ok = await withReleaseKey(key, env, install, (k) => runSign({ ...k, out: signed, apk: file }));
  } catch (error) {
    await rm(signed, { force: true });
    throw error;
  }
  if (!ok) { await rm(signed, { force: true }); throw new Error(`${tool} could not sign ${packageName} with its release key (its output is not kept: it may name the key's files).`); }
  const printed = (verify ?? (bundle
    ? (path) => (spawnSync(jdk("jarsigner"), ["-verify", path], quiet).status === 0 ? spawnSync(jdk("keytool"), ["-printcert", "-jarfile", path], quiet).stdout ?? "" : "")
    : (path) => spawnSync(apksigner, ["verify", "--print-certs", path], { env, encoding: "utf8" }).stdout ?? ""))(signed);
  const digests = signerDigests(printed);
  if (!digests.length || digests.some((digest) => digest !== key.certSha256)) { await rm(signed, { force: true }); throw new Error(`The release-signed ${bundle ? "bundle" : "APK"}'s signer is not ${packageName}'s kept certificate.`); }
  await rename(signed, file);
  return { signedWith: "release", certSha256: key.certSha256 };
}

/**
 * Play App Signing (plan clipboard:kTV3y2lwO-99 step 18): the kept key, encrypted by Google's pepk.jar with Play Console's
 * encryption_public_key.pem, into `out` for "Export and upload a key from Java keystore". Play then signs with the same certificate,
 * so MOBILE_APP_SIGNERS and phones that sideloaded the app stay valid. The zip's certificate must be the kept one.
 */
export async function exportForPlay(packageName, { pepk, encryptionKey, out, paths, env = process.env, install = vaultInstall, run = null, certificate = null } = {}) {
  const key = releaseKeyFor(packageName);
  for (const [name, path] of [["pepk.jar", pepk], ["encryption_public_key.pem", encryptionKey]]) if (!path || !existsSync(path)) throw new Error(`${name} not found: ${path}.`);
  const jdk = (name) => (paths?.javaHome ? join(paths.javaHome, "bin", name) : name);
  const quiet = { env, stdio: ["ignore", "ignore", "ignore"] };
  await rm(out, { force: true });
  // pepk takes a password only on its command line or a console: it gets a one-time copy of the key under a one-time password.
  const ok = await withReleaseKey(key, env, install, run ?? (({ dir, keystore, password, alias }) => {
    const once = randomBytes(24).toString("base64url"), oncePath = join(dir, "once"), copy = join(dir, "once.p12");
    writeFileSync(oncePath, once, { mode: 0o600 });
    return spawnSync(jdk("keytool"), ["-importkeystore", "-noprompt", "-srckeystore", keystore, "-srcstoretype", "PKCS12", "-srcstorepass:file", password, "-srcalias", alias,
      "-destkeystore", copy, "-deststoretype", "PKCS12", "-deststorepass:file", oncePath, "-destalias", alias], quiet).status === 0
      && spawnSync(jdk("java"), ["-jar", pepk, `--keystore=${copy}`, `--alias=${alias}`, `--keystore-pass=${once}`, `--output=${out}`, "--include-cert",
        "--rsa-aes-encryption", `--encryption-key-path=${encryptionKey}`], quiet).status === 0;
  }));
  const pem = ok && existsSync(out) ? (certificate ?? ((zip) => spawnSync("unzip", ["-p", zip, "certificate.pem"], { env, encoding: "utf8" }).stdout ?? ""))(out) : "";
  let digest = null;
  try { digest = new X509Certificate(pem).fingerprint256.replaceAll(":", "").toLowerCase(); } catch { digest = null; }
  if (digest !== key.certSha256) { await rm(out, { force: true }); throw new Error(ok ? `pepk's certificate is not ${packageName}'s kept certificate.` : `pepk could not export ${packageName}'s release key (its output is not kept).`); }
  await chmod(out, 0o600);
  return { out, certSha256: key.certSha256 };
}

/** The app id app.json names, when it names one (app.config.* may compute it; the build checks the APK's own id again). */
async function configuredPackage(app) {
  const config = JSON.parse(await readFile(join(app, "app.json"), "utf8").catch(() => "null"));
  return typeof config?.expo?.android?.package === "string" ? config.expo.android.package : null;
}

// ---- jobs: a build runs in its own background process; its state is a JSON file next to its log --------------------
const jobFile = (id, env) => join(buildsDir(env), `${id}.json`);
async function writeJob(job, env = process.env) {
  await mkdir(buildsDir(env), { recursive: true, mode: 0o700 });
  await writeFile(jobFile(job.jobId, env), `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
}
async function readJob(id, env = process.env) {
  if (!/^apk-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/.test(id)) throw new Error(`Unknown build ${id}.`);
  const job = JSON.parse(await readFile(jobFile(id, env), "utf8").catch(() => "null"));
  if (!job) throw new Error(`Unknown build ${id}.`);
  return job;
}

/** Starts a build in the background: refused while the server is OVERLOADED, while another build runs, or before the toolchain. */
export async function startBuild(dir, { signing = "debug", releaseBuild = false, env = process.env, toolchainDir = env.SPACE_ANDROID_TOOLCHAIN_DIR || DEFAULT_TOOLCHAIN_DIR, load = readLoad } = {}) {
  if (!SIGNINGS.includes(signing)) throw new Error(`signing is debug or release, not ${signing}.`);
  const app = await resolveAppDir(dir, env);
  const configured = await configuredPackage(app);
  if (signing === "release" && configured) releaseKeyFor(configured);
  if (releaseBuild) await assertReleaseProven(env);
  const installed = await toolchainStatus(toolchainDir);
  if (!installed.ok) throw new Error(`The Android toolchain is not installed (${installed.missing.join(", ")}): ask Nous for node /opt/spaceapp/scripts/space-android-toolchain-setup.mjs --install.`);
  const busy = overloadReasons(await load());
  if (busy.length) throw new Error(`The server is OVERLOADED (${busy.join(", ")}): start the build again in a few minutes.`);
  const lock = join(gradleHomeFor(toolchainPaths(toolchainDir), env).home, ".space-app-studio-build.lock");
  if (existsSync(lock) && alive(Number(readFileSync(lock, "utf8")))) throw new Error("Another App Studio APK build is running; one build at a time.");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const jobId = `apk-${stamp}-${randomBytes(3).toString("hex")}`;
  const logPath = join(buildsDir(env), `${jobId}.log`);
  await writeJob({ jobId, status: "RUNNING", stage: "starting", dir: app, signing, log: logPath, startedAt: new Date().toISOString(), pid: null }, env);
  const logFd = openSync(logPath, "a", 0o600);
  const child = spawn(process.execPath, [scriptPath, "run", app, "--job", jobId, ...(signing === "release" ? ["--release"] : []), ...(releaseBuild ? ["--release-build"] : [])], { detached: true, stdio: ["ignore", logFd, logFd], env: { ...env, SPACE_ANDROID_TOOLCHAIN_DIR: toolchainDir } });
  closeSync(logFd);
  child.unref();
  await writeJob({ ...(await readJob(jobId, env)), pid: child.pid }, env);
  return { jobId, status: "RUNNING", log: logPath, next: `Takes 5-15 minutes. Read it with space_appstudio_build_status {"jobId":"${jobId}"} or node ${scriptPath} status ${jobId} --wait 50.` };
}

/** A build's state (the newest one without an id), waiting up to waitSeconds while it runs; the log's last lines when it failed. */
export async function buildStatus(jobId, { waitSeconds = 0, env = process.env } = {}) {
  let id = jobId;
  if (!id) {
    const newest = (await readdir(buildsDir(env)).catch(() => [])).filter((name) => /^apk-.*\.json$/.test(name)).sort().at(-1);
    if (!newest) return { status: "NONE", message: "No APK build yet." };
    id = newest.slice(0, -".json".length);
  }
  const deadline = Date.now() + Math.min(Math.max(waitSeconds, 0), STATUS_WAIT_MAX_S) * 1000;
  for (;;) {
    let job = await readJob(id, env);
    if (job.status === "RUNNING" && job.pid && !alive(job.pid)) {
      job = { ...job, status: "FAILED", error: "The build process ended without a result.", finishedAt: new Date().toISOString() };
      await writeJob(job, env);
    }
    if (job.status !== "RUNNING" || Date.now() >= deadline) {
      if (job.status === "FAILED") job.logTail = (await readFile(job.log, "utf8").catch(() => "")).split("\n").slice(-30).join("\n");
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function runJob(dir, jobId, signing, releaseBuild = false) {
  // One writer, in order: a stage line never lands after the final state.
  let job = await readJob(jobId);
  let writes = Promise.resolve();
  const update = (patch) => { job = { ...job, ...patch }; const snapshot = job; writes = writes.then(() => writeJob(snapshot)); return writes; };
  try {
    const result = await runBuild(dir, { signing, releaseBuild, logFd: 1, log: (line) => { console.log(`space-app-studio-build: ${line}`); void update({ stage: line.split(":")[0] }); } });
    await update({ status: "DONE", stage: "done", result, finishedAt: new Date().toISOString() });
  } catch (error) {
    await update({ status: "FAILED", error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() });
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const [command, target, ...rest] = process.argv.slice(2);
  const flag = (name) => rest.indexOf(name);
  (async () => {
    const signing = flag("--release") >= 0 ? "release" : "debug";
    const releaseBuild = flag("--release-build") >= 0;
    if (command === "start") console.log(JSON.stringify(await startBuild(target, { signing, releaseBuild }), null, 2));
    else if (command === "status") {
      const args = [target, ...rest];
      const wait = args.indexOf("--wait");
      console.log(JSON.stringify(await buildStatus(args.find((arg) => /^apk-/.test(arg ?? "")), { waitSeconds: wait >= 0 ? Number(args[wait + 1]) || 0 : 0 }), null, 2));
    } else if (command === "run" && flag("--job") >= 0) await runJob(target, rest[flag("--job") + 1], signing, releaseBuild);
    else if (command === "run") console.log(JSON.stringify(await runBuild(target, { signing, releaseBuild, bundle: flag("--aab") >= 0, upload: flag("--no-upload") < 0, log: (line) => console.error(`space-app-studio-build: ${line}`) }), null, 2));
    else if (command === "pepk") console.log(JSON.stringify(await exportForPlay(target, { pepk: rest[0], encryptionKey: rest[1], out: rest[2] }), null, 2));
    else throw new Error("Usage: space-app-studio-build.mjs start <app dir> [--release] [--release-build] | status [jobId] [--wait <s>] | run <app dir> [--release] [--release-build] [--no-upload [--aab]] | pepk <app id> <pepk.jar> <encryption_public_key.pem> <out.zip>");
  })().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
