#!/usr/bin/env node
// Destructive source probes are restricted to an opted-in disposable Linux CI checkout.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const arg = process.argv.indexOf("--repo");
const root = arg >= 0 && process.argv[arg + 1] ? resolve(process.argv[arg + 1]) : null;
const receipts = [];

function checkRunner() {
  assert(root, "Pass --repo with the disposable checkout path.");
  assert.equal(process.env.GITHUB_ACTIONS, "true", "This mutation probe is restricted to an ephemeral GitHub Actions runner.");
  assert.equal(process.env.RUNNER_OS, "Linux");
  assert.equal(process.env.SPACE_DEV_ACCEPTANCE_MUTATIONS, "1", "Explicit mutation opt-in is required.");
  assert(process.env.RUNNER_TEMP, "RUNNER_TEMP is required.");
  assert.notEqual(process.getuid?.(), 0, "Do not disable the browser sandbox to run this probe as root.");
}

async function until(label, action, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await action();
    if (result) return result;
    await pause(200);
  }
  throw new Error(`${label} did not reach its asserted condition within ${timeoutMs}ms.`);
}

async function json(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000), cache: "no-store" });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
}

function ready(body) {
  return body?.ok === true && ["database", "worker", "cliHost"].every((key) => body.dependencies?.[key] === "RUNNING");
}

export function replaceOnce(text, anchor, replacement) {
  assert.equal(text.split(anchor).length, 2, "Source anchor must occur exactly once; inspect candidate drift.");
  return text.replace(anchor, replacement);
}

async function replaceFile(path, bytes, mode) {
  const temporary = `${path}.dev-stack-probe-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function restoreSourceEdit(receipt) {
  const { path, backup, originalHash, editedHash, mode } = receipt;
  const info = await lstat(path);
  assert(info.isFile() && !info.isSymbolicLink(), "Refusing to restore a replaced non-regular source file.");
  const backupInfo = await lstat(backup);
  assert(backupInfo.isFile() && !backupInfo.isSymbolicLink(), "Source backup must remain a regular file.");
  const original = await readFile(backup);
  assert.equal(hash(original), originalHash, "Source backup checksum changed; refusing restoration.");
  const currentHash = hash(await readFile(path));
  assert(currentHash === editedHash || currentHash === originalHash, `Concurrent modification of ${path}; original backup retained at ${backup}.`);
  await replaceFile(path, original, mode);
  assert.equal(hash(await readFile(path)), originalHash, "Original source bytes were not restored.");
  if (receipt.receiptFile) await rm(receipt.receiptFile);
  await rm(backup);
}

export async function editSource(relativePath, transform, backupRoot, checkoutRoot = root, receiptRoot = null) {
  const path = resolve(checkoutRoot, relativePath);
  const rel = relative(resolve(checkoutRoot), path);
  assert(rel && rel !== ".." && !rel.startsWith(`..${sep}`), "Source probe must stay inside its checkout.");
  const info = await lstat(path);
  assert(info.isFile() && !info.isSymbolicLink(), "Probe source must be a regular tracked file.");
  const original = await readFile(path);
  const edited = Buffer.from(transform(original.toString("utf8")));
  assert(!original.equals(edited), "Source probe must actually change bytes.");
  const backup = join(backupRoot, relativePath.replaceAll("/", "__"));
  await writeFile(backup, original, { flag: "wx", mode: 0o600 });
  assert((await readFile(path)).equals(original), "Source changed while preparing its backup.");
  const receipt = { path, backup, originalHash: hash(original), editedHash: hash(edited), mode: info.mode & 0o777 };
  // Persist before changing source so the workflow's always-cleanup can recover
  // even if timeout/SIGTERM prevents this process's finally blocks from running.
  if (receiptRoot) {
    await mkdir(receiptRoot, { recursive: true, mode: 0o700 });
    receipt.receiptFile = join(receiptRoot, `${relativePath.replaceAll("/", "__")}.json`);
    await writeFile(receipt.receiptFile, JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
  }
  await replaceFile(path, edited, receipt.mode);
  let restored = false;
  return {
    ...receipt,
    async restore() {
      if (restored) return;
      await restoreSourceEdit(receipt);
      restored = true;
    }
  };
}

export class PipeCdp {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Set();
    this.closed = false;
    let buffered = Buffer.alloc(0);
    child.stdio[4].on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (let boundary; (boundary = buffered.indexOf(0)) >= 0;) {
        const raw = buffered.subarray(0, boundary);
        buffered = buffered.subarray(boundary + 1);
        if (!raw.length) continue;
        const message = JSON.parse(raw.toString("utf8"));
        if (message.id) {
          const entry = this.pending.get(message.id);
          if (!entry) continue;
          clearTimeout(entry.timer);
          this.pending.delete(message.id);
          if (message.error) entry.reject(new Error(`CDP ${entry.method} failed (code ${message.error.code}).`));
          else entry.resolve(message.result);
        } else for (const handler of this.handlers) handler(message);
      }
    });
    const fail = () => {
      this.closed = true;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("The isolated browser closed before completing a CDP command."));
      }
      this.pending.clear();
    };
    child.once("error", fail);
    child.once("exit", fail);
    child.stdio[3].on("error", fail);
  }
  call(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error("The isolated browser is already closed."));
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out.`));
      }, 15_000);
      this.pending.set(id, { resolve: resolvePromise, reject, timer, method });
      this.child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });
  }
  async evaluate(expression, sessionId) {
    const response = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    assert(!response.exceptionDetails, "Browser evaluation failed; inspect the candidate without dumping authenticated page content.");
    return response.result?.value;
  }
}

async function findChrome() {
  const candidates = process.env.CHROME_BIN ? [process.env.CHROME_BIN] : ["/usr/bin/google-chrome", "/usr/bin/chromium"];
  for (const path of candidates) {
    try { await access(path, constants.X_OK); return path; } catch {}
  }
  throw new Error("No existing Chrome binary found. Browser-visible HMR is unverified; do not replace this with a server-only PASS.");
}

async function proveHmr(web, backupRoot, evidenceRoot, receiptRoot) {
  const chrome = await findChrome();
  const profile = await mkdtemp(join(tmpdir(), "spaceapp-dev-hmr-"));
  const child = spawn(chrome, ["--headless=new", "--remote-debugging-pipe", `--user-data-dir=${profile}`, "--window-size=1280,900", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-extensions", "--disable-default-apps", "--disable-dev-shm-usage", "about:blank"], {
    // No inherited vault/provider credentials. Chromium keeps its normal sandbox.
    env: { ...Object.fromEntries(["PATH", "LANG", "LC_ALL", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].filter((key) => process.env[key]).map((key) => [key, process.env[key]])), HOME: profile, XDG_CONFIG_HOME: join(profile, "config"), XDG_CACHE_HOME: join(profile, "cache") },
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"]
  });
  let diagnostic = "";
  child.stderr.on("data", bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-4000); });
  const cdp = new PipeCdp(child);
  let edit;
  let session;
  let navigationCount = 0;
  const hmrFrames = [];
  try {
    const version = await cdp.call("Browser.getVersion");
    const target = await cdp.call("Target.createTarget", { url: "about:blank" });
    session = (await cdp.call("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
    cdp.handlers.add((message) => {
      if (message.sessionId !== session) return;
      if (message.method === "Page.frameNavigated" && !message.params?.frame?.parentId) navigationCount++;
      if (message.method !== "Network.webSocketFrameReceived") return;
      try {
        const payload = JSON.parse(message.params.response.payloadData);
        if (["update", "full-reload", "error"].includes(payload.type)) hmrFrames.push({ type: payload.type, paths: (payload.updates || []).map((entry) => entry.path) });
      } catch {}
    });
    await cdp.call("Page.enable", {}, session);
    await cdp.call("Runtime.enable", {}, session);
    await cdp.call("Network.enable", {}, session);
    // The anonymous page is allowed to load only this isolated stack.
    await cdp.call("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, session);
    const allowed = new Set([web, new URL(web).origin]);
    cdp.handlers.add((message) => {
      if (message.sessionId !== session || message.method !== "Fetch.requestPaused") return;
      const { requestId, request } = message.params;
      const permitted = request.url.startsWith("data:") || request.url.startsWith("blob:") || allowed.has(new URL(request.url).origin);
      void cdp.call(permitted ? "Fetch.continueRequest" : "Fetch.failRequest", permitted ? { requestId } : { requestId, errorReason: "BlockedByClient" }, session).catch(() => {});
    });
    await cdp.call("Page.navigate", { url: web }, session);
    const view = () => cdp.evaluate(`(() => {
      const brand = document.querySelector('.login-brand');
      const field = document.querySelector('#operator-email');
      const box = brand?.getBoundingClientRect();
      return { label: brand?.innerText || '', email: field?.value || '', nonce: window.__devStackHmrNonce,
        timeOrigin: performance.timeOrigin, visible: !!box && box.width > 0 && box.height > 0 && getComputedStyle(brand).visibility !== 'hidden' };
    })()`, session);
    await until("Real login screen", async () => { const state = await view(); return state.visible && state.label.includes("Sign in to Space") && state; });
    const nonce = randomUUID();
    const email = `hmr-state-${nonce}@example.invalid`;
    await cdp.evaluate(`window.__devStackHmrNonce = ${JSON.stringify(nonce)}; document.querySelector('#operator-email').focus();`, session);
    await cdp.call("Input.insertText", { text: email }, session);
    const before = await view();
    assert.equal(before.email, email);
    const baselineNavigations = navigationCount;
    const frameStart = hmrFrames.length;
    const screenshot = async (name) => {
      const clip = await cdp.evaluate(`(() => { const b=document.querySelector('.login-brand').getBoundingClientRect(); return {x:b.x,y:b.y,width:b.width,height:b.height,scale:1}; })()`, session);
      const result = await cdp.call("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: false }, session);
      await writeFile(join(evidenceRoot, name), Buffer.from(result.data, "base64"), { mode: 0o600 });
    };
    await screenshot("hmr-before.png");
    const marker = `hmr-${randomUUID()}`;
    edit = await editSource("apps/web/src/features/auth/LoginScreen.tsx", (text) => replaceOnce(text, '"Sign in to Space"', JSON.stringify(`Sign in to Space ${marker}`)), backupRoot, root, receiptRoot);
    await until("Browser DOM hot update", async () => { const state = await view(); return state.visible && state.label.includes(marker) && state; });
    const assertSamePage = async () => {
      const state = await view();
      assert.equal(state.nonce, nonce, "A full page reload cannot satisfy HMR.");
      assert.equal(state.timeOrigin, before.timeOrigin);
      assert.equal(navigationCount, baselineNavigations);
      assert.equal(state.email, email, "React Refresh must preserve controlled input state.");
    };
    await assertSamePage();
    const changedFrames = hmrFrames.slice(frameStart);
    assert(changedFrames.some((frame) => frame.type === "update" && frame.paths.some((path) => /\/LoginScreen\.(tsx|js)(\?|$)/.test(path))), "No matching real Vite-client update frame was observed.");
    assert(!changedFrames.some((frame) => ["error", "full-reload"].includes(frame.type)), "Vite error/full reload is not HMR success.");
    await screenshot("hmr-after.png");
    await edit.restore();
    await until("Browser reverse hot update", async () => { const state = await view(); return state.visible && state.label.includes("Sign in to Space") && !state.label.includes(marker); });
    await assertSamePage();
    await screenshot("hmr-restored.png");
    receipts.push({ probe: "real-browser-vite-hmr", browser: version.product, sameDocument: true, inputStateRetained: true, reverseUpdateObserved: true, sourceRestoredHash: edit.originalHash });
    console.log("[dev-stack-change-probes] PASS real browser DOM HMR, same document and state, reverse HMR, original bytes restored");
  } catch (error) {
    throw new Error(`${error.message}${diagnostic ? ` Browser diagnostic: ${diagnostic.trim()}` : ""}`);
  } finally {
    try { await edit?.restore(); }
    finally {
      await cdp.call("Browser.close").catch(() => {});
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await until("Isolated browser exit", () => child.exitCode !== null || child.signalCode !== null, 10_000);
      await rm(profile, { recursive: true, force: true });
    }
  }
}

async function main() {
  checkRunner();
  const evidenceRoot = resolve(process.env.SPACE_DEV_EVIDENCE_DIR || join(process.env.RUNNER_TEMP, "dev-stack-acceptance-evidence"));
  const backupRoot = await mkdtemp(join(process.env.RUNNER_TEMP, "dev-stack-source-backup-"));
  const receiptRoot = join(process.env.RUNNER_TEMP, "dev-stack-source-edit-receipts");
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  const git = async (...args) => (await exec("git", args, { cwd: root })).stdout.trim();
  const sha = await git("rev-parse", "HEAD");
  const baselineStatus = await git("status", "--porcelain=v1");
  await git("diff", "--exit-code", "--", "apps/api/src/health-routes.ts", "apps/web/src/features/auth/LoginScreen.tsx");
  const lib = await import(pathToFileURL(join(root, "deploy/docker/dev-stack-lib.mjs")).href);
  const safety = await import(pathToFileURL(join(root, "deploy/docker/dev-stack-safety.mjs")).href);
  safety.assertSafeDevStackOverrides();
  const config = await lib.resolveConfig(process.env, root);
  const persistedConfig = JSON.parse(await readFile(config.configFile, "utf8"));
  for (const key of ["root", "stateRoot", "project", "ports"]) assert.deepEqual(persistedConfig[key], config[key], `Running config ${key} differs from this checkout's selected configuration.`);
  const ownership = await safety.readStateOwnership(config);
  const api = `http://127.0.0.1:${config.ports.api}`;
  const web = `http://127.0.0.1:${config.ports.web}`;
  const groups = async () => (await safety.readProcessRecords(config, ownership)).filter((entry) => ["api", "web", "worker", "cli-host"].includes(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
  const supervisor = await safety.ownedSupervisorPid(config);
  assert(supervisor, "A verified source-stack supervisor must already be running.");
  const baselineGroups = await groups();
  assert.equal(baselineGroups.length, 4);
  const initial = await until("Initial complete readiness", async () => { const body = await json(`${api}/readyz`); return ready(body) && body; });
  const marker = `api-watch-${randomUUID()}`;
  const expectedPackageProbe = process.env.SPACE_DEV_EXPECTED_PACKAGE_PROBE || null;
  if (expectedPackageProbe) assert(/^dev_stack_rebuild_[A-Za-z0-9_]+$/.test(expectedPackageProbe), "Unexpected package-probe marker format.");
  let edit;
  let observedStart;
  let passed = false;
  try {
    try {
      edit = await editSource("apps/api/src/health-routes.ts", (text) => {
        const updated = replaceOnce(text,
          'async () => ({ ok: true, service: "space-api" })',
          `async () => ({ ok: true, service: "space-api", devStackWatchProbe: ${JSON.stringify(marker)}, devStackWatchPid: process.pid${expectedPackageProbe ? ", devStackPackageProbe: __devStackRebuildProbe" : ""} })`);
        return expectedPackageProbe ? 'import { __devStackRebuildProbe } from "@space/contracts";\n' + updated : updated;
      }, backupRoot, root, receiptRoot);
      await until("API source watch marker", async () => {
        const [health, body] = await Promise.all([json(`${api}/healthz`), json(`${api}/readyz`)]);
        if (health?.devStackWatchProbe === marker && (!expectedPackageProbe || health.devStackPackageProbe === expectedPackageProbe) && Number.isInteger(health.devStackWatchPid) && health.devStackWatchPid > 1 && ready(body) && body.apiStartedAt !== initial.apiStartedAt) {
          observedStart = body.apiStartedAt;
          return true;
        }
        return false;
      });
      assert.equal(await safety.ownedSupervisorPid(config), supervisor);
      assert.deepEqual(await groups(), baselineGroups, "API watch must not restart the source-stack group leaders.");
    } finally { await edit?.restore(); }
    await until("API restoration watch", async () => {
      const [health, body] = await Promise.all([json(`${api}/healthz`), json(`${api}/readyz`)]);
      return health?.ok === true && !Object.hasOwn(health, "devStackWatchProbe") && ready(body) && body.apiStartedAt !== observedStart;
    });
    assert.equal(await safety.ownedSupervisorPid(config), supervisor);
    assert.deepEqual(await groups(), baselineGroups);
    receipts.push({ probe: "api-source-watch", markerObserved: true, restartObserved: true, reverseRestartObserved: true, sourceRestoredHash: edit.originalHash });
    if (expectedPackageProbe) receipts.push({ probe: "shared-package-runtime-import", importedMarkerObservedOverHttp: true });
    console.log("[dev-stack-change-probes] PASS API source watch restart and restoration, same stack supervisor and service leaders");
    await proveHmr(web, backupRoot, evidenceRoot, receiptRoot);
    assert.equal(await git("rev-parse", "HEAD"), sha);
    assert.equal(await git("status", "--porcelain=v1"), baselineStatus, "Probe must leave candidate status exactly as found.");
    passed = true;
  } finally {
    await writeFile(join(evidenceRoot, "hotreload-receipt.json"), JSON.stringify({ candidateSha: sha, passed, receipts }, null, 2) + "\n", { mode: 0o600 });
    // A nonempty backup directory is intentionally retained for safe manual recovery.
    await rmdir(backupRoot).catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`[dev-stack-change-probes] FAIL ${error.message}`); process.exitCode = 1; });
}
