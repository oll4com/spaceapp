/** Real, opt-in Chrome/UI and React-HMR proof; no model or provider input. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { acceptanceOwner } from "./dev-stack-acceptance.mjs";
import { assertGroupsGone, processIdentity, sameProcess, signalOwnedGroup } from "./dev-stack-process.mjs";
import { readState } from "./dev-stack-state.mjs";

const PREFIX = "DEV_STACK_BROWSER_";
const MAX_MESSAGE = 12 * 1024 * 1024;
const BADGE = ".space-instance-badge-label";
const PANE = '.terminal-pane[aria-label="CLI pane OpenCode CLI"]';
const hash = value => createHash("sha256").update(value).digest("hex");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fault = code => Object.assign(new Error(`${PREFIX}${code}`), { code: `${PREFIX}${code}` });
function demand(condition, code) { if (!condition) throw fault(code); }
function inside(root, path) {
  const suffix = relative(root, path);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

/** Only the two explicitly owned IPv4 loopback application ports are network destinations. */
export function browserUrlAllowed(raw, state) {
  try {
    if (raw === "about:blank") return true;
    const url = new URL(raw);
    if (url.protocol === "data:") return true;
    if (url.protocol === "blob:") return browserUrlAllowed(url.pathname, state);
    const port = url.port ? Number(url.port) : 80;
    return ["http:", "ws:"].includes(url.protocol) && url.hostname === "127.0.0.1"
      && !url.username && !url.password && [state.ports.api, state.ports.web].includes(port);
  } catch { return false; }
}

/** A unique direct child of state, or of the existing CI runner-temp root. */
export function browserArtifactRootAllowed(path, stateDir, runnerTemp, ci) {
  if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path) return false;
  if (dirname(path) === stateDir && inside(stateDir, path)) return true;
  return ci === "true" && typeof runnerTemp === "string" && isAbsolute(runnerTemp)
    && dirname(path) === normalize(runnerTemp) && /^spaceapp-dev-stack-browser-[A-Za-z0-9_-]+$/u.test(basename(path));
}

/** The original UI connection label is 'attached', not the API's 'RUNNING'. */
export function assertUiObservation(value) {
  demand(value?.paneCount === 1 && value.badgeVisible === true && value.roomObserved === true
    && value.sampledTerminalPointsUnoccluded === true
    && value.status === "attached" && value.loading === "false" && value.hasError === "false"
    && value.hasSession === "true" && value.hasWebsocket === "true"
    && value.width >= 200 && value.height >= 100 && value.screenWidth >= 100 && value.screenHeight >= 50
    && (value.canvasCount > 0 || value.rowCount > 0), "UI_TERMINAL");
  return true;
}

/** Observe the original app's async onboarding discovery; never retain bodies/headers. */
export function createSetupOverviewObservation(state) {
  const requests = new Map();
  let first;
  return {
    observe(method, params) {
      const id = params?.requestId;
      if (method === "Network.requestWillBeSent" && params.request?.method === "GET"
        && browserUrlAllowed(params.request.url, state)
        && new URL(params.request.url).pathname === "/api/setup/overview") {
        demand(typeof id === "string" && id.length > 0 && id.length <= 256
          && requests.size < 16 && !requests.has(id), "SETUP_DISCOVERY_BOUND");
        requests.set(id, { status: null, finished: false, failed: false });
        first ??= id;
      }
      const record = requests.get(id);
      if (!record) return;
      if (method === "Network.responseReceived") record.status = params.response?.status;
      if (method === "Network.loadingFinished") record.finished = true;
      if (method === "Network.loadingFailed") record.failed = true;
    },
    completedRequest() {
      const record = requests.get(first);
      if (!record) return null;
      demand(!record.failed && (record.status === null || record.status === 200), "SETUP_DISCOVERY_FAILED");
      return record.finished && record.status === 200 ? first : null;
    },
  };
}

/** Byte-preserving temporary mutation of one known original component literal. */
export function mutateBadgeSource(original, nonce) {
  demand(Buffer.isBuffer(original) && /^[a-f0-9-]{36}$/u.test(nonce), "HMR_INPUT");
  const needle = Buffer.from(">DEV<");
  const position = original.indexOf(needle);
  demand(position !== -1 && original.indexOf(needle, position + needle.length) === -1, "HMR_LITERAL");
  return Buffer.concat([original.subarray(0, position), Buffer.from(`>DEV HMR-${nonce}<`),
    original.subarray(position + needle.length)]);
}

/** A real screenshot still requires visual review; dimensions alone are not UI acceptance. */
export function inspectPng(buffer) {
  demand(Buffer.isBuffer(buffer) && buffer.length >= 4096 && buffer.length <= 8 * 1024 * 1024
    && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && buffer.toString("ascii", 12, 16) === "IHDR", "SCREENSHOT");
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  demand(width >= 800 && width <= 4096 && height >= 600 && height <= 4096, "SCREENSHOT_SIZE");
  return { sha256: hash(buffer), byteSize: buffer.length, width, height };
}

/** Conservative allowance for Chromium's temporary singleton subdirectory/socket. */
export function assertChromeTempPath(path) {
  demand(typeof path === "string" && isAbsolute(path) && normalize(path) === path
    && Buffer.byteLength(path) <= 48, "CHROME_TEMP_PATH");
  // Chromium appends its own unique directory and SingletonSocket. Keep ample
  // space below Linux sun_path[108], including its terminating NUL.
  demand(Buffer.byteLength(`${path}/.org.chromium.Chromium.XXXXXX/SingletonSocket`) < 100, "CHROME_TEMP_PATH");
  return true;
}

/** Recognition flags only: never retain or return raw Chrome startup stderr. */
export function createStartupDiagnostics(limit = 65536) {
  demand(Number.isInteger(limit) && limit >= 256 && limit <= 65536, "DIAGNOSTIC_LIMIT");
  const flags = { socketPathTooLong: false, processSingletonFailure: false, crashpadFailure: false,
    sandboxFailure: false, stderrTruncated: false, stderrBytesInspected: 0 };
  let tail = "";
  return {
    consume(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const count = Math.min(buffer.length, limit - flags.stderrBytesInspected);
      if (count < buffer.length) flags.stderrTruncated = true;
      if (count <= 0) return;
      flags.stderrBytesInspected += count;
      const text = tail + buffer.subarray(0, count).toString("utf8");
      flags.socketPathTooLong ||= /socket path too long|ENAMETOOLONG/iu.test(text);
      flags.processSingletonFailure ||= /process_singleton|Failed to create (?:socket directory|symlinks)|SingletonLock/iu.test(text);
      flags.crashpadFailure ||= /crashpad[^\n]*(?:error|failed|requires)|chrome_crashpad_handler[^\n]*(?:database|required)/iu.test(text);
      flags.sandboxFailure ||= /No usable sandbox|Running as root without --no-sandbox|Failed to move to new namespace|zygote_host_impl_linux/iu.test(text);
      tail = text.slice(-256);
    },
    snapshot() { return { ...flags }; },
  };
}

/** Primary observation is immutable even when cleanup independently fails. */
export function browserFailureDetails(primaryCode, cleanupCodes = []) {
  const valid = code => typeof code === "string" && /^DEV_STACK_BROWSER_[A-Z0-9_]+$/u.test(code);
  demand((primaryCode === null || valid(primaryCode)) && Array.isArray(cleanupCodes)
    && cleanupCodes.every(valid), "FAILURE_INPUT");
  return { code: primaryCode ?? cleanupCodes[0] ?? null, primaryCode, cleanupCodes: [...cleanupCodes] };
}

/**
 * Remove only a captured, private browser-owned direct child. The full tree is
 * preflighted before mutation. Symlink targets (including broken Singletons)
 * are never read, resolved or traversed: only the links themselves are unlinked.
 * Call ONLY after the positively owned Chrome group and proxy are gone. This is
 * a cooperating-local-checkout guard, not protection against hostile writers.
 */
export function removeOwnedBrowserDirectory(root, expected, parent, operations = {}) {
  const stat = operations.stat ?? lstatSync;
  const list = operations.list ?? readdirSync;
  const unlink = operations.unlink ?? unlinkSync;
  const remove = operations.remove ?? rmSync;
  const uid = operations.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  const allowedName = expected?.role === "profile" ? /^browser-profile-[A-Za-z0-9]+$/u : /^bt-[A-Za-z0-9]+$/u;
  demand(isAbsolute(root) && dirname(root) === parent && inside(parent, root)
    && allowedName.test(basename(root)) && ["profile", "temp"].includes(expected?.role), "PROFILE_CLEANUP");
  const identities = new Map();
  const links = [];
  function same(before, after) {
    return before.dev === after.dev && before.ino === after.ino && before.uid === after.uid
      && before.isDirectory() === after.isDirectory() && before.isSymbolicLink() === after.isSymbolicLink()
      && before.isFile() === after.isFile() && before.isSocket() === after.isSocket();
  }
  function checkRoot() {
    const info = stat(root);
    demand(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o700
      && info.dev === expected.dev && info.ino === expected.ino && info.uid === expected.uid
      && (uid === undefined || info.uid === uid), "PROFILE_CLEANUP");
  }
  checkRoot();
  function visit(path) {
    demand(identities.size < 50000 && (path === root || inside(root, path)), "PROFILE_CLEANUP");
    const info = stat(path);
    demand(info.uid === expected.uid, "PROFILE_CLEANUP");
    identities.set(path, info);
    if (info.isSymbolicLink()) {
      demand(info.nlink === 1, "PROFILE_CLEANUP");
      links.push(path);
    } else if (info.isDirectory()) {
      for (const name of list(path)) visit(join(path, name));
    } else if (info.isSocket()) {
      demand(expected.role === "temp" && basename(path) === "SingletonSocket" && info.nlink === 1, "PROFILE_CLEANUP");
    } else demand(info.isFile() && info.nlink === 1, "PROFILE_CLEANUP");
  }
  visit(root);
  function checkPath(path) {
    checkRoot();
    for (let directory = dirname(path); directory !== parent; directory = dirname(directory)) {
      const current = stat(directory);
      demand(current.isDirectory() && !current.isSymbolicLink()
        && same(identities.get(directory), current), "PROFILE_CLEANUP");
    }
    demand(same(identities.get(path), stat(path)), "PROFILE_CLEANUP");
  }
  // Preflight completes before the first unlink; a rejected hard link cannot
  // cause a partially removed tree. unlink never operates on a link's target.
  for (const path of links) { checkPath(path); unlink(path); }
  for (const [path, info] of identities) {
    if (!info.isSymbolicLink()) {
      if (path === root) checkRoot();
      else checkPath(path);
      demand(!info.isFile() || stat(path).nlink === 1, "PROFILE_CLEANUP");
    }
  }
  remove(root, { recursive: true });
  try { stat(root); }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
  throw fault("PROFILE_CLEANUP");
}

/**
 * Acquisition ledger shared by the real proof and injected filesystem tests.
 * Construction is read-only; acquire MUST run inside the caller's try/finally.
 * A successful creation is recorded before its first lstat. Without a captured
 * inode/UID, neither removal nor receipt writing is authorized.
 */
export function browserDirectoryLease({ stateDir, artifactDir, tempParent }, operations = {}) {
  const stat = operations.stat ?? lstatSync;
  const realpath = operations.realpath ?? realpathSync;
  const mkdir = operations.mkdir ?? mkdirSync;
  const mkdtemp = operations.mkdtemp ?? mkdtempSync;
  const chmod = operations.chmod ?? chmodSync;
  const write = operations.write ?? writeFileSync;
  const remove = operations.removeOwned ?? removeOwnedBrowserDirectory;
  const uid = operations.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  const parents = new Map();
  for (const parent of new Set([stateDir, dirname(artifactDir), tempParent])) {
    demand(typeof parent === "string" && isAbsolute(parent) && normalize(parent) === parent
      && realpath(parent) === parent, "DIRECTORY_ROOT");
    const info = stat(parent);
    demand(info.isDirectory() && !info.isSymbolicLink()
      && Number.isSafeInteger(info.dev) && Number.isSafeInteger(info.ino) && info.ino > 0
      && Number.isSafeInteger(info.uid), "DIRECTORY_ROOT");
    parents.set(parent, { dev: info.dev, ino: info.ino, uid: info.uid });
  }
  demand(browserArtifactRootAllowed(artifactDir, stateDir, tempParent, "true"), "ARTIFACT_ROOT");
  assertChromeTempPath(`${join(tempParent, "bt-")}XXXXXX`);
  const artifact = { path: null, identity: null };
  const profile = { path: null, identity: null };
  const temporary = { path: null, identity: null };
  function sameParent(parent) {
    const expected = parents.get(parent);
    const info = stat(parent);
    demand(expected && info.isDirectory() && !info.isSymbolicLink()
      && info.dev === expected.dev && info.ino === expected.ino && info.uid === expected.uid, "DIRECTORY_ROOT_CHANGED");
  }
  function capture(slot, role) {
    const info = stat(slot.path);
    demand(info.isDirectory() && !info.isSymbolicLink()
      && Number.isSafeInteger(info.dev) && Number.isSafeInteger(info.ino) && info.ino > 0
      && Number.isSafeInteger(info.uid) && (uid === undefined || info.uid === uid), "DIRECTORY_IDENTITY");
    slot.identity = { dev: info.dev, ino: info.ino, uid: info.uid, role };
  }
  function assertOwned(slot) {
    demand(slot.path && slot.identity, "DIRECTORY_IDENTITY");
    sameParent(dirname(slot.path));
    const info = stat(slot.path);
    demand(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o700
      && info.dev === slot.identity.dev && info.ino === slot.identity.ino && info.uid === slot.identity.uid
      && (uid === undefined || info.uid === uid), "DIRECTORY_IDENTITY");
  }
  return {
    artifact, profile, temporary,
    acquire(setStage = () => {}) {
      setStage("ARTIFACT_CREATE");
      sameParent(dirname(artifactDir));
      mkdir(artifactDir, { mode: 0o700 }); // EEXIST never adopts the existing directory.
      artifact.path = artifactDir;
      setStage("ARTIFACT_IDENTITY");
      capture(artifact, "artifact");
      setStage("ARTIFACT_PRIVATE");
      chmod(artifact.path, 0o700);
      assertOwned(artifact);
      setStage("PROFILE_CREATE");
      sameParent(stateDir);
      profile.path = mkdtemp(join(stateDir, "browser-profile-"));
      setStage("PROFILE_IDENTITY");
      capture(profile, "profile");
      setStage("PROFILE_PRIVATE");
      chmod(profile.path, 0o700);
      assertOwned(profile);
      setStage("CHROME_TEMP_CREATE");
      sameParent(tempParent);
      temporary.path = mkdtemp(join(tempParent, "bt-"));
      setStage("CHROME_TEMP_IDENTITY");
      capture(temporary, "temp");
      setStage("CHROME_TEMP_PRIVATE");
      chmod(temporary.path, 0o700);
      assertOwned(temporary);
      setStage("PROFILE_HOME");
      for (const directory of ["home", "home/config", "home/data", "home/cache"]) {
        assertOwned(profile);
        mkdir(join(profile.path, directory), { recursive: true, mode: 0o700 });
      }
    },
    cleanup(browserGone, proxyClosed) {
      const codes = [];
      if (artifact.path && !artifact.identity) codes.push(`${PREFIX}ARTIFACT_IDENTITY_UNOBSERVED`);
      function release(slot, parent, role) {
        if (!slot.path) return true; // No successful creation to remove.
        if (!slot.identity) { codes.push(`${PREFIX}${role}_IDENTITY_UNOBSERVED`); return false; }
        if (!browserGone || !proxyClosed) return false;
        try {
          assertOwned(slot);
          return remove(slot.path, slot.identity, parent) === true;
        } catch { codes.push(`${PREFIX}${role}_CLEANUP`); return false; }
      }
      return { profileRemoved: release(profile, stateDir, "PROFILE"),
        temporaryRemoved: release(temporary, tempParent, "TEMP"), cleanupCodes: codes };
    },
    writeReceipt(receipt) {
      assertOwned(artifact);
      write(join(artifact.path, "browser-proof.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    },
  };
}

class Cdp {
  constructor(socket, remaining) {
    this.socket = socket;
    this.remaining = remaining;
    this.pending = new Map();
    this.listeners = new Set();
    this.nextId = 0;
    this.failure = null;
    this.messages = 0;
    socket.addEventListener("message", event => {
      try {
        demand(typeof event.data === "string" && Buffer.byteLength(event.data) <= MAX_MESSAGE
          && ++this.messages <= 100000, "CDP_LIMIT");
        const message = JSON.parse(event.data);
        if (message.id) {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          if (message.error) pending.reject(fault(pending.method === "Runtime.evaluate"
            && message.error.code === -32000 ? "CDP_CONTEXT" : "CDP_COMMAND"));
          else pending.resolve(message.result ?? {});
        } else {
          for (const listener of this.listeners) {
            Promise.resolve(listener(message)).catch(() => { this.failure ??= fault("CDP_EVENT"); });
          }
        }
      } catch { this.failure ??= fault("CDP_MESSAGE"); }
    });
    socket.addEventListener("error", () => { this.failure ??= fault("CDP_SOCKET"); });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer); pending.reject(fault("CDP_CLOSED"));
      }
      this.pending.clear();
    });
  }
  static async connect(endpoint, remaining) {
    const socket = new WebSocket(endpoint);
    const client = new Cdp(socket, remaining);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(fault("CDP_OPEN")); }, Math.min(10000, remaining()));
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(fault("CDP_OPEN")); }, { once: true });
    });
    return client;
  }
  send(method, params = {}, sessionId) {
    demand(!this.failure && this.socket.readyState === WebSocket.OPEN, "CDP_UNAVAILABLE");
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(fault("CDP_TIMEOUT")); },
        Math.min(15000, this.remaining()));
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(fault("CDP_SEND")); }
    });
  }
  close() { this.socket.close(); }
}

async function denyProxy() {
  let denied = 0;
  const sockets = new Set();
  const server = createServer((_request, response) => {
    denied++;
    response.writeHead(403, { Connection: "close", "Content-Length": "0" });
    response.end();
  });
  server.on("connect", (_request, socket) => { denied++; socket.destroy(); });
  server.on("upgrade", (_request, socket) => { denied++; socket.destroy(); });
  server.on("connection", socket => {
    sockets.add(socket); socket.setTimeout(5000, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", () => reject(fault("PROXY_LISTEN")));
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port, denied: () => denied,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(fault("PROXY_CLEANUP")), 5000);
        server.close(error => { clearTimeout(timer); error ? reject(fault("PROXY_CLEANUP")) : resolve(); });
      });
      demand(!server.listening && sockets.size === 0, "PROXY_CLEANUP");
    },
  };
}

function chromeExecutable() {
  const explicit = process.env.SPACE_DEV_BROWSER_PATH;
  demand(explicit === undefined || (isAbsolute(explicit) && !explicit.includes("\0")), "CHROME_PATH");
  for (const candidate of explicit ? [explicit] : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    try {
      const path = realpathSync(candidate);
      demand(lstatSync(path).isFile(), "CHROME_PATH");
      accessSync(path, constants.X_OK);
      return path;
    } catch { /* Only existing executable binaries; never install or download one. */ }
  }
  throw fault("CHROME_MISSING");
}

function browserEnvironment(profile, temporary) {
  const environment = {};
  for (const key of ["LANG", "LC_ALL", "LC_CTYPE", "TZ"]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return { ...environment, PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
    HOME: join(profile, "home"), TMPDIR: temporary,
    XDG_CONFIG_HOME: join(profile, "home", "config"), XDG_DATA_HOME: join(profile, "home", "data"),
    XDG_CACHE_HOME: join(profile, "home", "cache") };
}

/** Caller must own an already-running source stack with its synthetic owner claimed. */
export async function runBrowserProof({ state, artifactDir, timeoutMs = 180000 }) {
  demand(process.platform !== "win32", "UNIX_REQUIRED");
  demand(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 600000, "TIMEOUT_INPUT");
  const current = readState(state.repoRoot);
  demand(current.project === state.project && current.stateDir === state.stateDir
    && ["api", "web", "postgres", "temporal"].every(key => current.ports[key] === state.ports[key])
    && current.secrets.sessionSecret === state.secrets.sessionSecret, "STATE_CHANGED");
  demand(browserArtifactRootAllowed(artifactDir, state.stateDir, process.env.RUNNER_TEMP, process.env.CI), "ARTIFACT_ROOT");
  const tempParent = process.env.CI === "true" && process.env.RUNNER_TEMP
    ? normalize(process.env.RUNNER_TEMP) : state.stateDir;
  // All root/path/executable validation precedes the first filesystem acquisition.
  const directories = browserDirectoryLease({ stateDir: state.stateDir, artifactDir, tempParent });
  const executable = chromeExecutable();
  let profile;
  let temporary;
  const started = performance.now();
  const remaining = () => { const value = Math.ceil(timeoutMs - performance.now() + started); demand(value > 0, "TIMEOUT"); return value; };
  let stage = "START";
  let proxy;
  let chrome;
  let record;
  let client;
  let sessionId;
  let exited = false;
  let startFailed = false;
  let failure;
  const cleanupCodes = [];
  const startupDiagnostics = createStartupDiagnostics();
  let result;
  let original;
  let changed;
  let sourceInfo;
  let mutated = false;
  const badgeFile = join(state.repoRoot, "apps", "web", "src", "features", "instance-badge", "InstanceBadge.tsx");
  const source = { before: null, changed: null, restored: null };
  const screenshots = [];
  const selectors = [];
  const network = { allowedRequests: 0, blockedRequests: 0, webSocketCreated: 0,
    terminalWebSocketUpgrades: 0, javascriptExceptions: 0 };
  const terminalRequests = new Set();
  const setupOverview = createSetupOverviewObservation(state);
  async function until(predicate, label) {
    for (;;) {
      remaining();
      demand(!exited && !startFailed, "CHROME_EXITED");
      if (client?.failure) throw client.failure;
      try { if (await predicate()) return; }
      catch (error) {
        // A navigation can destroy the previous blank page's execution context.
        // No other CDP/guard failure is treated as a successful wait.
        if (error.code !== `${PREFIX}CDP_CONTEXT`) throw error;
      }
      await pause(Math.min(100, remaining()));
      stage = label;
    }
  }
  async function evaluate(expression) {
    const response = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    demand(!response.exceptionDetails, "UI_EVALUATION");
    return response.result?.value;
  }
  async function selector(selector, label) {
    const value = await evaluate(`(() => { const nodes=document.querySelectorAll(${JSON.stringify(selector)}); const el=nodes[0];
      const r=el?.getBoundingClientRect(); const s=el&&getComputedStyle(el);
      return {count:nodes.length,visible:!!r&&r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none',
        x:r?r.x+r.width/2:0,y:r?r.y+r.height/2:0,width:r?.width||0,height:r?.height||0}; })()`);
    demand(value && Number.isFinite(value.width), "SELECTOR_SNAPSHOT");
    const index = selectors.findIndex(item => item.label === label);
    const snapshot = { label, selector, ...value };
    if (index !== -1) selectors[index] = snapshot;
    else if (selectors.length < 16) selectors.push(snapshot);
    return value;
  }
  async function input(selectorName, value, label) {
    const observed = await selector(selectorName, label);
    demand(observed.count === 1 && observed.visible, "UI_INPUT_MISSING");
    await evaluate(`document.querySelector(${JSON.stringify(selectorName)}).focus()`);
    await client.send("Input.insertText", { text: value }, sessionId);
  }
  async function observeUi() {
    return evaluate(`(() => { const panes=document.querySelectorAll(${JSON.stringify(PANE)}); const p=panes[0];
      const x=p?.querySelector('.terminal-xterm'); const screen=x?.querySelector('.xterm-screen');
      const r=x?.getBoundingClientRect(); const s=screen?.getBoundingClientRect();
      const points=s&&[[.5,.5],[.25,.25],[.75,.25],[.25,.75],[.75,.75]];
      const unoccluded=!!x&&!!s&&points.every(([dx,dy])=>{
        const hit=document.elementFromPoint(s.x+s.width*dx,s.y+s.height*dy); return !!hit&&x.contains(hit); });
      const badge=document.querySelector(${JSON.stringify(BADGE)}); const br=badge?.getBoundingClientRect();
      return {paneCount:panes.length,badgeVisible:!!br&&br.width>0&&br.height>0,
        sampledTerminalPointsUnoccluded:unoccluded,
        badge:badge?.textContent||'',roomObserved:document.body.innerText.includes('Getting Started'),
        status:p?.getAttribute('data-terminal-status'),loading:p?.getAttribute('data-terminal-loading'),
        hasError:p?.getAttribute('data-terminal-has-error'),hasSession:p?.getAttribute('data-terminal-has-session'),
        hasWebsocket:p?.getAttribute('data-terminal-has-websocket'),width:r?.width||0,height:r?.height||0,
        screenWidth:s?.width||0,screenHeight:s?.height||0,canvasCount:x?.querySelectorAll('canvas').length||0,
        rowCount:x?.querySelectorAll('.xterm-rows > div').length||0,
        brandingObserved:/\\bopencode\\b/i.test((x?.textContent||'').slice(0,131072)),
        timeOrigin:performance.timeOrigin}; })()`);
  }
  async function screenshot(filename) {
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
    const response = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
    demand(typeof response.data === "string" && response.data.length <= 12 * 1024 * 1024, "SCREENSHOT");
    const buffer = Buffer.from(response.data, "base64");
    const details = inspectPng(buffer);
    writeFileSync(join(artifactDir, filename), buffer, { flag: "wx", mode: 0o600 });
    screenshots.push({ filename, ...details });
  }
  function restoreSource() {
    if (!mutated) return;
    const info = lstatSync(badgeFile);
    demand(info.isFile() && !info.isSymbolicLink() && info.nlink === 1
      && info.dev === sourceInfo.dev && info.ino === sourceInfo.ino, "HMR_SOURCE_CHANGED");
    const now = readFileSync(badgeFile);
    demand(now.equals(changed) || now.equals(original), "HMR_SOURCE_CHANGED");
    if (!now.equals(original)) writeFileSync(badgeFile, original);
    demand(readFileSync(badgeFile).equals(original), "HMR_RESTORE");
    source.restored = hash(original);
    mutated = false;
  }
  try {
    directories.acquire(label => { stage = label; });
    profile = directories.profile.path;
    temporary = directories.temporary.path;
    stage = "PROXY";
    proxy = await denyProxy();
    stage = "CHROME_START";
    chrome = spawn(executable, ["--headless=new", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
      `--user-data-dir=${profile}`, `--proxy-server=http://127.0.0.1:${proxy.port}`,
      `--proxy-bypass-list=<-loopback>;127.0.0.1:${state.ports.api};127.0.0.1:${state.ports.web}`,
      "--window-size=1440,1000", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
      "--disable-component-update", "--disable-crash-reporter", "--disable-crashpad", "--disable-default-apps",
      "--disable-dev-shm-usage", "--disable-extensions", "--disable-sync", "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--no-sandbox", "about:blank"],
    { cwd: profile, env: browserEnvironment(profile, temporary), detached: true, stdio: ["ignore", "ignore", "pipe"] });
    chrome.stderr.on("data", chunk => startupDiagnostics.consume(chunk));
    chrome.once("exit", () => { exited = true; });
    chrome.once("error", () => { startFailed = true; });
    if (chrome.pid) record = processIdentity(chrome.pid);
    demand(record && sameProcess(record, record), "CHROME_IDENTITY");
    let endpoint;
    await until(() => {
      const file = join(profile, "DevToolsActivePort");
      if (!existsSync(file)) return false;
      const info = lstatSync(file);
      demand(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 1024, "CDP_ENDPOINT");
      const lines = readFileSync(file, "utf8").trim().split(/\r?\n/u);
      demand(lines.length === 2 && /^[0-9]+$/u.test(lines[0]) && Number(lines[0]) > 0 && Number(lines[0]) <= 65535
        && /^\/devtools\/browser\/[a-f0-9-]+$/u.test(lines[1]), "CDP_ENDPOINT");
      endpoint = `ws://127.0.0.1:${lines[0]}${lines[1]}`;
      return true;
    }, "CDP_ENDPOINT");
    stage = "CDP_CONNECT";
    client = await Cdp.connect(endpoint, remaining);
    const created = await client.send("Target.createTarget", { url: "about:blank" });
    const attached = await client.send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
    sessionId = attached.sessionId;
    demand(typeof sessionId === "string" && sessionId.length > 0, "CDP_TARGET");
    client.listeners.add(async message => {
      if (message.sessionId !== sessionId) return;
      const params = message.params ?? {};
      setupOverview.observe(message.method, params);
      if (message.method === "Fetch.requestPaused") {
        const allowed = browserUrlAllowed(params.request?.url, state);
        allowed ? network.allowedRequests++ : network.blockedRequests++;
        await client.send(allowed ? "Fetch.continueRequest" : "Fetch.failRequest",
          allowed ? { requestId: params.requestId } : { requestId: params.requestId, errorReason: "BlockedByClient" }, sessionId);
      }
      if (message.method === "Network.webSocketCreated") {
        demand(browserUrlAllowed(params.url, state), "WEBSOCKET_DESTINATION");
        network.webSocketCreated++;
        if (/^\/api\/panes\/[^/]+\/cli\/terminal$/u.test(new URL(params.url).pathname)) terminalRequests.add(params.requestId);
      }
      if (message.method === "Network.webSocketHandshakeResponseReceived"
        && terminalRequests.has(params.requestId) && params.response?.status === 101) network.terminalWebSocketUpgrades++;
      if (message.method === "Runtime.exceptionThrown") network.javascriptExceptions++;
    });
    stage = "NETWORK_GUARD";
    await client.send("Page.enable", {}, sessionId);
    await client.send("Runtime.enable", {}, sessionId);
    await client.send("Network.enable", {}, sessionId);
    await client.send("Network.setBypassServiceWorker", { bypass: true }, sessionId);
    await client.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId);
    await client.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
    stage = "NAVIGATE_LOGIN";
    const navigation = await client.send("Page.navigate", { url: `http://127.0.0.1:${state.ports.web}/` }, sessionId);
    demand(!navigation.errorText, "NAVIGATION");
    await until(async () => (await selector("#operator-email", "login-ready")).visible, "LOGIN_READY");
    stage = "UI_LOGIN";
    const owner = acceptanceOwner(state);
    await input("#operator-email", owner.email, "email-before-input");
    await input("#operator-password", owner.password, "password-before-input");
    const submit = await selector(".login-panel button[type=submit]", "login-before-submit");
    demand(submit.count === 1 && submit.visible, "LOGIN_SUBMIT");
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }, sessionId);
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, sessionId);
    stage = "UI_SETUP_DISCOVERY";
    let overviewRequest;
    await until(() => { overviewRequest = setupOverview.completedRequest(); return !!overviewRequest; }, "UI_SETUP_DISCOVERY");
    const overviewResponse = await client.send("Network.getResponseBody", { requestId: overviewRequest }, sessionId);
    demand(overviewResponse.base64Encoded === false && typeof overviewResponse.body === "string"
      && Buffer.byteLength(overviewResponse.body) <= 256 * 1024, "SETUP_DISCOVERY_BODY");
    let setupWasIncomplete;
    try {
      const overview = JSON.parse(overviewResponse.body);
      demand(typeof overview?.isComplete === "boolean", "SETUP_DISCOVERY_BODY");
      setupWasIncomplete = !overview.isComplete;
    } catch { throw fault("SETUP_DISCOVERY_BODY"); }
    // Let the original fetch/JSON continuation and React commit apply. If it
    // reports incomplete onboarding, acceptance additionally requires seeing
    // its original backdrop at least once, then dismissing it through the UI.
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
    stage = "UI_TERMINAL";
    let before;
    let roomClicked = false;
    let setupDialogDismissedLocally = false;
    let setupBackdropObserved = false;
    await until(async () => {
      const backdrop = await selector(".setup-connections-backdrop", "setup-backdrop");
      if (backdrop.visible) {
        setupBackdropObserved = true;
        // The original first-run dialog may lazy-load after login. Close only
        // through its visible original button; never finish onboarding, call
        // its persistence API, remove DOM or hide an obstructing overlay.
        if (!setupDialogDismissedLocally) {
          const closeSelector = '.setup-connections-dialog button[aria-label="Close Setup & connections"]';
          const close = await selector(closeSelector, "setup-close-before-click");
          if (close.visible) {
            demand(close.count === 1, "SETUP_DIALOG_CLOSE");
            const hit = await evaluate(`(() => { const b=document.querySelector(${JSON.stringify(closeSelector)});
              const r=b?.getBoundingClientRect(); const p=r&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
              return !!b&&!!p&&b.contains(p); })()`);
            if (hit) {
              setupDialogDismissedLocally = true;
              await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: close.x, y: close.y, button: "left", clickCount: 1 }, sessionId);
              await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: close.x, y: close.y, button: "left", clickCount: 1 }, sessionId);
            }
          }
        }
        return false; // The backdrop must actually disappear before acceptance.
      }
      if (setupWasIncomplete && (!setupBackdropObserved || !setupDialogDismissedLocally)) return false;
      before = await observeUi();
      try { assertUiObservation(before); return network.terminalWebSocketUpgrades > 0; }
      catch {
        if (!roomClicked && before.paneCount === 0) {
          const room = await selector('[aria-label="Open Getting Started"]', "room-before-click");
          if (room.count === 1 && room.visible) {
            roomClicked = true;
            await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: room.x, y: room.y, button: "left", clickCount: 1 }, sessionId);
            await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: room.x, y: room.y, button: "left", clickCount: 1 }, sessionId);
          }
        }
        return false;
      }
    }, "UI_TERMINAL");
    demand(before.badge === "DEV", "INITIAL_BADGE");
    await screenshot("opencode-ui-before.png");
    stage = "HMR_MUTATE";
    sourceInfo = lstatSync(badgeFile);
    demand(sourceInfo.isFile() && !sourceInfo.isSymbolicLink() && sourceInfo.nlink === 1
      && sourceInfo.size <= 65536, "HMR_SOURCE");
    original = readFileSync(badgeFile);
    const nonce = randomUUID();
    changed = mutateBadgeSource(original, nonce);
    source.before = hash(original); source.changed = hash(changed);
    mutated = true;
    writeFileSync(badgeFile, changed);
    stage = "HMR_OBSERVE";
    await until(async () => {
      const observation = await observeUi();
      demand(observation.timeOrigin === before.timeOrigin, "HMR_DOCUMENT_RELOADED");
      return observation.badge === `DEV HMR-${nonce}`;
    }, "HMR_OBSERVE");
    await screenshot("opencode-ui-hmr.png");
    stage = "HMR_RESTORE";
    restoreSource();
    let restored;
    await until(async () => {
      restored = await observeUi();
      demand(restored.timeOrigin === before.timeOrigin, "HMR_DOCUMENT_RELOADED");
      if (restored.badge !== "DEV") return false;
      try { return assertUiObservation(restored); } catch { return false; }
    }, "HMR_RESTORE_OBSERVE");
    await screenshot("opencode-ui-restored.png");
    result = {
      schema: "spaceapp.dev-stack-browser.v1", passed: true, project: state.project,
      browserUiVerified: true, browserLoginVerified: true, browserOwnerSetupVerified: false,
      setupDialogDismissedLocally, setupOverviewOriginalRequestCompleted: true,
      setupOverviewWasIncomplete: setupWasIncomplete, terminalVisibilitySamplePoints: 5,
      terminalAttached: true, terminalRendered: true, terminalWebSocketUpgradeVerified: true,
      openCodeBrandingObserved: restored.brandingObserved, fullOpenCodeTuiReviewed: false,
      webReactHmrVerified: true, hmrSourceRestored: true, sameDocumentPreserved: true,
      providerCompletionVerified: false, terminalInputSent: false, completeIssueAcceptance: false,
      screenshots, selectorSnapshots: selectors, sourceSha256: source,
      network: { ...network, loopbackApplicationPortsOnly: true, fetchInterceptionEnabledBeforeNavigation: true,
        webSocketDestinationGuard: true, denyAllProxyWithoutDirectFallback: true },
      limitations: ["Screenshots require human visual review; DOM geometry is not full OpenCode TUI acceptance.",
        "Visibility is sampled at five interior terminal points; it is not exhaustive visual or full-TUI certification.",
        "Synthetic owner was claimed earlier; this browser proof verifies ordinary login, not owner setup UI.",
        "No terminal command, model task, provider completion, API watch or package rebuild is performed here.",
        "Network protection combines target CDP interception with browser proxy rules; it is not an OS network sandbox."],
    };
  } catch (error) {
    failure = error?.code?.startsWith(PREFIX) ? error : fault(`${stage}_FAILED`);
  } finally {
    try { restoreSource(); } catch { cleanupCodes.push(`${PREFIX}HMR_RESTORE`); }
    let browserGone = !chrome;
    let proxyClosed = !proxy;
    if (chrome) {
      try {
        if (record && sameProcess(record, processIdentity(record.pid))) {
          if (client) {
            try { await Promise.race([client.send("Browser.close").catch(() => {}), pause(1000)]); }
            catch { /* Broken CDP must not skip positively-owned process teardown. */ }
          }
          const graceful = performance.now() + 2000;
          while (!exited && performance.now() < graceful) await pause(50);
          if (!exited) signalOwnedGroup(record);
          const until = performance.now() + 5000;
          while (!exited && performance.now() < until) await pause(50);
          if (!exited) signalOwnedGroup(record, "SIGKILL");
        } else if (!record) {
          chrome.kill("SIGTERM");
          cleanupCodes.push(`${PREFIX}CHROME_IDENTITY`);
        }
        const deadline = performance.now() + 10000;
        for (;;) {
          try { demand(record, "CHROME_IDENTITY"); assertGroupsGone([record]); browserGone = true; break; }
          catch { if (performance.now() >= deadline) throw fault("CHROME_CLEANUP"); await pause(50); }
        }
      } catch { cleanupCodes.push(`${PREFIX}CHROME_CLEANUP`); }
    }
    try { client?.close(); } catch { cleanupCodes.push(`${PREFIX}CDP_CLEANUP`); }
    try { await proxy?.close(); proxyClosed = true; } catch { cleanupCodes.push(`${PREFIX}PROXY_CLEANUP`); }
    const released = directories.cleanup(browserGone, proxyClosed);
    const { profileRemoved, temporaryRemoved } = released;
    cleanupCodes.push(...released.cleanupCodes);
    const details = browserFailureDetails(failure?.code ?? null, cleanupCodes);
    if (details.code && !failure) failure = Object.assign(new Error(details.code), { code: details.code });
    if (failure) { failure.primaryCode = details.primaryCode; failure.cleanupCodes = [...cleanupCodes]; }
    if (result) {
      result.elapsedMs = Math.round(performance.now() - started);
      result.network.proxyDeniedRequests = proxy?.denied() ?? 0;
      result.cleanup = { browserGroupGone: browserGone, proxyClosed, privateProfileRemoved: profileRemoved,
        privateTemporaryRemoved: temporaryRemoved };
      result.startupDiagnostics = startupDiagnostics.snapshot();
      result.chromeTemporaryPathBytes = directories.temporary.path ? Buffer.byteLength(directories.temporary.path) : null;
    }
    // Only bounded aggregates and screenshots are persisted, never DOM, response bodies,
    // cookies, request headers, credential values or raw CDP/console/network messages.
    const receipt = failure ? { schema: "spaceapp.dev-stack-browser.v1", passed: false,
      stage, ...details, sourceRestored: !mutated,
      cleanupVerified: cleanupCodes.length === 0 && browserGone && proxyClosed && profileRemoved && temporaryRemoved,
      startupDiagnostics: startupDiagnostics.snapshot(),
      chromeTemporaryPathBytes: directories.temporary.path ? Buffer.byteLength(directories.temporary.path) : null } : result;
    let receiptWritten = false;
    if (directories.artifact.identity) {
      try { directories.writeReceipt(receipt); receiptWritten = true; }
      catch { failure ??= fault("RECEIPT_WRITE"); cleanupCodes.push(`${PREFIX}RECEIPT_WRITE`); }
    }
    if (failure) {
      failure.primaryCode = details.primaryCode;
      failure.cleanupCodes = [...cleanupCodes];
      failure.receiptWritten = receiptWritten;
    }
  }
  if (failure) throw failure;
  return result;
}
