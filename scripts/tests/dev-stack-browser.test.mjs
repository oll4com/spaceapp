import assert from "node:assert/strict";
import { basename, dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import { assertChromeTempPath, assertUiObservation, browserArtifactRootAllowed, browserDirectoryLease, browserFailureDetails,
  browserUrlAllowed, createSetupOverviewObservation, createStartupDiagnostics, inspectPng, mutateBadgeSource,
  removeOwnedBrowserDirectory } from "../dev-stack-browser.mjs";

const state = { ports: { api: 5910, web: 5911 } };
const observation = () => ({ paneCount: 1, badgeVisible: true, roomObserved: true, sampledTerminalPointsUnoccluded: true,
  status: "attached", loading: "false", hasError: "false", hasSession: "true", hasWebsocket: "true",
  width: 800, height: 600, screenWidth: 800, screenHeight: 600, canvasCount: 1, rowCount: 0 });

test("URL guard permits only the owned application HTTP/WS ports and nonnetwork documents", () => {
  for (const url of ["http://127.0.0.1:5910/api/auth/login", "http://127.0.0.1:5911/", "ws://127.0.0.1:5911/",
    "ws://127.0.0.1:5910/api/panes/synthetic/cli/terminal?token=synthetic", "about:blank",
    "data:image/png;base64,synthetic", "blob:http://127.0.0.1:5911/synthetic"]) assert.equal(browserUrlAllowed(url, state), true, url);
  assert.equal(browserUrlAllowed("http://127.0.0.1:80/", { ports: { api: 80, web: 5911 } }), true);
});

test("URL guard rejects external destinations, credentials, wrong ports and privileged schemes", () => {
  for (const url of ["https://example.com/", "ws://example.com/", "wss://127.0.0.1:5911/", "https://127.0.0.1:5910/",
    "http://127.0.0.1:4910/", "http://127.0.0.2:5911/", "http://localhost:5911/", "http://127.0.0.1:5912/",
    "http://127.0.0.1.evil.test:5911/", "http://user:password@127.0.0.1:5911/", "file:///etc/passwd",
    "javascript:alert(1)", "blob:https://example.com/id", "not a url", undefined]) assert.equal(browserUrlAllowed(url, state), false);
});

test("artifact root permits a fresh direct child, never a root or a nested uncontrolled path", () => {
  const owned = resolve("synthetic-checkout", ".dev-stack");
  const temporary = resolve("synthetic-runner-temp");
  assert.equal(browserArtifactRootAllowed(join(owned, "browser-proof"), owned), true);
  assert.equal(browserArtifactRootAllowed(join(temporary, "spaceapp-dev-stack-browser-123"), owned, temporary, "true"), true);
  for (const [candidate, ci] of [[owned, "true"], [temporary, "true"],
    [join(temporary, "arbitrary"), "true"], [join(temporary, "spaceapp-dev-stack-browser-123"), "false"],
    [join(temporary, "nested", "spaceapp-dev-stack-browser-123"), "true"], ["relative", "true"]]) {
    assert.equal(browserArtifactRootAllowed(candidate, owned, temporary, ci), false);
  }
});

test("real UI guard expects attached source status with visible rendered xterm geometry", () => {
  assert.equal(assertUiObservation(observation()), true);
  assert.equal(assertUiObservation({ ...observation(), canvasCount: 0, rowCount: 30 }), true);
});

test("HTTP/session RUNNING labels, missing render and error flags cannot become browser PASS", () => {
  for (const change of [{ status: "RUNNING" }, { status: "connecting" }, { hasError: "true" }, { loading: "true" },
    { paneCount: 0 }, { paneCount: 2 }, { badgeVisible: false }, { roomObserved: false },
    { hasSession: "false" }, { hasWebsocket: "false" }, { sampledTerminalPointsUnoccluded: false },
    { sampledTerminalPointsUnoccluded: undefined }, { width: 0 }, { height: 0 },
    { screenWidth: 0 }, { canvasCount: 0, rowCount: 0 }]) {
    assert.throws(() => assertUiObservation({ ...observation(), ...change }), /DEV_STACK_BROWSER_UI_TERMINAL/u);
  }
});

test("setup discovery awaits the original response and body completion, not terminal geometry", () => {
  const value = createSetupOverviewObservation(state);
  assert.equal(value.completedRequest(), null);
  value.observe("Network.loadingFinished", { requestId: "unrelated" });
  value.observe("Network.requestWillBeSent", { requestId: "original", request: {
    method: "GET", url: "http://127.0.0.1:5911/api/setup/overview" } });
  assert.equal(value.completedRequest(), null);
  value.observe("Network.responseReceived", { requestId: "original", response: { status: 200 } });
  assert.equal(value.completedRequest(), null);
  value.observe("Network.loadingFinished", { requestId: "original" });
  assert.equal(value.completedRequest(), "original");
});

test("foreign ports, POSTs and unrelated routes cannot satisfy setup discovery", () => {
  const value = createSetupOverviewObservation(state);
  for (const [method, url] of [["POST", "http://127.0.0.1:5911/api/setup/overview"],
    ["GET", "http://127.0.0.1:4910/api/setup/overview"], ["GET", "https://external.invalid/api/setup/overview"],
    ["GET", "http://127.0.0.1:5911/api/setup/finish"]]) {
    value.observe("Network.requestWillBeSent", { requestId: "not-original", request: { method, url } });
    value.observe("Network.responseReceived", { requestId: "not-original", response: { status: 200 } });
    value.observe("Network.loadingFinished", { requestId: "not-original" });
  }
  assert.equal(value.completedRequest(), null);
});

test("setup discovery failure cannot be replaced by a later successful request", () => {
  for (const failure of ["Network.loadingFailed", "HTTP_FAILURE"]) {
    const value = createSetupOverviewObservation(state);
    for (const id of ["first", "later"]) value.observe("Network.requestWillBeSent", { requestId: id,
      request: { method: "GET", url: "http://127.0.0.1:5911/api/setup/overview" } });
    value.observe(failure === "HTTP_FAILURE" ? "Network.responseReceived" : failure,
      { requestId: "first", response: { status: 500 }, errorText: "PRIVATE_SYNTHETIC_SECRET" });
    value.observe("Network.responseReceived", { requestId: "later", response: { status: 200 } });
    value.observe("Network.loadingFinished", { requestId: "later" });
    assert.throws(() => value.completedRequest(), error => {
      assert.equal(error.message, "DEV_STACK_BROWSER_SETUP_DISCOVERY_FAILED");
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE_SYNTHETIC_SECRET/u);
      return true;
    });
  }
});

test("HMR mutation changes the one original literal and preserves every other byte", () => {
  const original = Buffer.from("// UTF8:\u00b7\r\n<span className=\"space-instance-badge-label\">DEV</span>\r\n");
  const nonce = "11111111-2222-3333-4444-555555555555";
  const changed = mutateBadgeSource(original, nonce);
  assert.equal(changed.toString("utf8"), original.toString("utf8").replace(">DEV<", `>DEV HMR-${nonce}<`));
  assert.ok(original.equals(Buffer.from("// UTF8:\u00b7\r\n<span className=\"space-instance-badge-label\">DEV</span>\r\n")));
});

test("HMR fails closed on unknown source, duplicate literals or unsafe marker", () => {
  const nonce = "11111111-2222-3333-4444-555555555555";
  for (const source of ["no literal", ">DEV<>DEV<"]) assert.throws(() => mutateBadgeSource(Buffer.from(source), nonce), /HMR_LITERAL/u);
  assert.throws(() => mutateBadgeSource(Buffer.from(">DEV<"), "<script>"), /HMR_INPUT/u);
});

function syntheticPng(width = 1440, height = 1000, length = 5000) {
  const value = Buffer.alloc(length);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(value);
  value.write("IHDR", 12, "ascii");
  value.writeUInt32BE(width, 16); value.writeUInt32BE(height, 20);
  return value;
}

test("PNG guard reports dimensions/hash only, not a fabricated visual interpretation", () => {
  const value = inspectPng(syntheticPng());
  assert.equal(value.width, 1440); assert.equal(value.height, 1000); assert.equal(value.byteSize, 5000);
  assert.match(value.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(value.uiVerified, undefined);
});

test("empty, undersized, wrong-signature or excessively sized screenshots fail", () => {
  for (const value of [Buffer.alloc(0), Buffer.alloc(5000), syntheticPng(10, 10), syntheticPng(5000, 1000), syntheticPng(1440, 1000, 4000)]) {
    assert.throws(() => inspectPng(value), /DEV_STACK_BROWSER_SCREENSHOT/u);
  }
});

test("Chromium socket temporary path reserves portable Unix-socket space", () => {
  const short = process.platform === "win32" ? "C:\\t\\bt-ABCDEF" : "/run/bt-ABCDEF";
  assert.equal(assertChromeTempPath(short), true);
  assert.throws(() => assertChromeTempPath(join(short, "a".repeat(100))), /CHROME_TEMP_PATH/u);
  assert.throws(() => assertChromeTempPath("relative"), /CHROME_TEMP_PATH/u);
});

test("startup diagnostics identify fixed error classes, including split chunks, without raw output", () => {
  const diagnostics = createStartupDiagnostics(256);
  diagnostics.consume("PRIVATE_SYNTHETIC_CREDENTIAL Socket path too ");
  diagnostics.consume("long: /private/path\nprocess_singleton_posix.cc\n");
  diagnostics.consume("chrome_crashpad_handler requires --database\nNo usable sandbox\n");
  diagnostics.consume("x".repeat(1000));
  const value = diagnostics.snapshot();
  assert.equal(value.socketPathTooLong, true);
  assert.equal(value.processSingletonFailure, true);
  assert.equal(value.crashpadFailure, true);
  assert.equal(value.sandboxFailure, true);
  assert.equal(value.stderrTruncated, true);
  assert.equal(value.stderrBytesInspected, 256);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE|private|CREDENTIAL|database|usable/u);
});

test("cleanup errors cannot replace the recorded primary error", () => {
  const primary = "DEV_STACK_BROWSER_CHROME_EXITED";
  const cleanup = ["DEV_STACK_BROWSER_PROFILE_CLEANUP", "DEV_STACK_BROWSER_TEMP_CLEANUP"];
  assert.deepEqual(browserFailureDetails(primary, cleanup), { code: primary, primaryCode: primary, cleanupCodes: cleanup });
  assert.deepEqual(browserFailureDetails(null, cleanup), { code: cleanup[0], primaryCode: null, cleanupCodes: cleanup });
  assert.deepEqual(browserFailureDetails(null), { code: null, primaryCode: null, cleanupCodes: [] });
  assert.throws(() => browserFailureDetails("raw private diagnostic"), /FAILURE_INPUT/u);
});

function cleanupFixture(role = "profile") {
  const parent = resolve("synthetic-browser-parent");
  const root = join(parent, role === "profile" ? "browser-profile-ABC123" : "bt-ABC123");
  const nodes = new Map();
  const children = new Map();
  const unlinked = [];
  const removed = [];
  let inode = 10;
  function add(path, kind, extra = {}) {
    const value = { dev: 1, ino: ++inode, uid: 42, mode: kind === "directory" ? 0o700 : 0o600,
      nlink: 1, isDirectory: () => kind === "directory", isFile: () => kind === "file",
      isSymbolicLink: () => kind === "link", isSocket: () => kind === "socket", ...extra };
    nodes.set(path, value);
    if (kind === "directory") children.set(path, []);
    if (path !== root) children.get(path.slice(0, path.lastIndexOf(sep))).push(path.slice(path.lastIndexOf(sep) + 1));
    return value;
  }
  const identity = { ...add(root, "directory"), role };
  add(join(root, "Default"), "directory");
  add(join(root, "Default", "Preferences"), "file");
  // The fake tree has no target nodes, so resolving a target would fail.
  add(join(root, "SingletonLock"), "link");
  add(join(root, "SingletonSocket"), "link");
  const operations = {
    uid: 42,
    stat(path) {
      if (!nodes.has(path)) throw Object.assign(new Error("missing synthetic node"), { code: "ENOENT" });
      return nodes.get(path);
    },
    list(path) { return children.get(path) ?? []; },
    unlink(path) { unlinked.push(path); nodes.delete(path); },
    remove(path, options) {
      removed.push({ path, options });
      for (const key of [...nodes.keys()]) if (key === path || key.startsWith(`${path}${sep}`)) nodes.delete(key);
    },
  };
  return { root, parent, identity, nodes, operations, add, unlinked, removed };
}

test("owned profile cleanup unlinks broken/external Singleton links without following targets", () => {
  const fixture = cleanupFixture();
  assert.equal(removeOwnedBrowserDirectory(fixture.root, fixture.identity, fixture.parent, fixture.operations), true);
  assert.deepEqual(fixture.unlinked, [join(fixture.root, "SingletonLock"), join(fixture.root, "SingletonSocket")]);
  assert.deepEqual(fixture.removed, [{ path: fixture.root, options: { recursive: true } }]);
});

test("profile identity, uid, permissions and root scope are checked before unlink", () => {
  for (const alter of [value => { value.identity.ino++; }, value => { value.identity.uid = 99; },
    value => { value.nodes.get(value.root).mode = 0o755; }, value => { value.parent = resolve("foreign-parent"); }]) {
    const fixture = cleanupFixture(); alter(fixture);
    assert.throws(() => removeOwnedBrowserDirectory(fixture.root, fixture.identity, fixture.parent, fixture.operations), /PROFILE_CLEANUP/u);
    assert.deepEqual(fixture.unlinked, []); assert.deepEqual(fixture.removed, []);
  }
});

test("hard-linked files, foreign descendants or unexpected sockets reject the entire preflight", () => {
  for (const alter of [value => { value.nodes.get(join(value.root, "Default", "Preferences")).nlink = 2; },
    value => { value.nodes.get(join(value.root, "Default", "Preferences")).uid = 99; },
    value => { value.add(join(value.root, "foreign.sock"), "socket"); },
    value => { value.nodes.get(join(value.root, "SingletonLock")).nlink = 2; }]) {
    const fixture = cleanupFixture(); alter(fixture);
    assert.throws(() => removeOwnedBrowserDirectory(fixture.root, fixture.identity, fixture.parent, fixture.operations), /PROFILE_CLEANUP/u);
    assert.deepEqual(fixture.unlinked, []); assert.deepEqual(fixture.removed, []);
  }
});

test("a replaced root detected after preflight is not unlinked or removed", () => {
  const fixture = cleanupFixture();
  const read = fixture.operations.stat;
  let reads = 0;
  fixture.operations.stat = path => {
    const value = read(path);
    return path === fixture.root && ++reads >= 3 ? { ...value, ino: 999 } : value;
  };
  assert.throws(() => removeOwnedBrowserDirectory(fixture.root, fixture.identity, fixture.parent, fixture.operations), /PROFILE_CLEANUP/u);
  assert.deepEqual(fixture.unlinked, []); assert.deepEqual(fixture.removed, []);
});

function acquisitionFixture(fail = () => false) {
  const stateDir = resolve("synthetic-checkout", ".dev-stack");
  const tempParent = process.platform === "win32" ? "C:\\btr" : "/btr";
  const artifactDir = join(tempParent, "spaceapp-dev-stack-browser-123");
  const nodes = new Map();
  const mutations = [];
  const writes = [];
  let inode = 100;
  function add(path) {
    const value = { dev: 1, ino: ++inode, uid: 42, mode: 0o700, nlink: 1,
      isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, isSocket: () => false };
    nodes.set(path, value); return value;
  }
  add(stateDir); add(tempParent);
  function trip(operation, path) {
    if (fail(operation, path)) throw Object.assign(new Error("injected filesystem failure"), { code: "EACCES" });
  }
  const cleanupOperations = {
    uid: 42,
    stat(path) {
      trip("stat", path);
      if (!nodes.has(path)) throw Object.assign(new Error("missing synthetic node"), { code: "ENOENT" });
      return nodes.get(path);
    },
    list(path) { return [...nodes.keys()].filter(value => value !== path && dirname(value) === path).map(value => basename(value)); },
    unlink() { throw new Error("unexpected synthetic link"); },
    remove(path) {
      mutations.push(["remove", path]);
      for (const value of [...nodes.keys()]) if (value === path || value.startsWith(`${path}${sep}`)) nodes.delete(value);
    },
  };
  const operations = {
    uid: 42,
    stat: cleanupOperations.stat,
    realpath: path => path,
    mkdir(path) {
      trip("mkdir", path);
      if (nodes.has(path)) throw Object.assign(new Error("existing synthetic directory"), { code: "EEXIST" });
      add(path); mutations.push(["mkdir", path]);
    },
    mkdtemp(prefix) {
      trip("mkdtemp", prefix);
      const path = `${prefix}ABC123`;
      if (nodes.has(path)) throw Object.assign(new Error("existing synthetic directory"), { code: "EEXIST" });
      add(path); mutations.push(["mkdtemp", path]); return path;
    },
    chmod(path, mode) { trip("chmod", path); nodes.get(path).mode = mode; mutations.push(["chmod", path]); },
    removeOwned: (root, identity, parent) => removeOwnedBrowserDirectory(root, identity, parent, cleanupOperations),
    write(path, text, options) { trip("write", path); writes.push({ path, value: JSON.parse(text), options }); },
  };
  return { stateDir, tempParent, artifactDir, nodes, mutations, writes, operations, add };
}

// The same acquisition ledger as runBrowserProof, with no filesystem, Chrome,
// app, provider, network or process activity. This is not a browser/UI PASS.
function exerciseAcquisition(fixture) {
  const lease = browserDirectoryLease(fixture, fixture.operations);
  let stage = "START";
  let primaryCode;
  let cleanup;
  let receiptWritten = false;
  try {
    lease.acquire(value => { stage = value; });
    throw Object.assign(new Error("synthetic pre-Chrome stop"), { code: "DEV_STACK_BROWSER_TEST_STOP" });
  } catch (error) {
    primaryCode = error.code.startsWith("DEV_STACK_BROWSER_") ? error.code : `DEV_STACK_BROWSER_${stage}_FAILED`;
  } finally {
    cleanup = lease.cleanup(true, true);
    if (lease.artifact.identity) {
      lease.writeReceipt({ passed: false, stage, ...browserFailureDetails(primaryCode, cleanup.cleanupCodes) });
      receiptWritten = true;
    }
  }
  return { lease, stage, primaryCode, cleanup, receiptWritten };
}

test("root and Unix-socket path rejection occurs before any directory acquisition", () => {
  for (const alter of [fixture => {
    fixture.tempParent = join(fixture.tempParent, "x".repeat(100)); fixture.add(fixture.tempParent);
    fixture.artifactDir = join(fixture.tempParent, "spaceapp-dev-stack-browser-123");
  },
    fixture => { fixture.operations.realpath = () => resolve("different-root"); }]) {
    const fixture = acquisitionFixture(); alter(fixture);
    assert.throws(() => browserDirectoryLease(fixture, fixture.operations), /DIRECTORY_ROOT|CHROME_TEMP_PATH/u);
    assert.deepEqual(fixture.mutations, []); assert.deepEqual(fixture.writes, []);
  }
});

test("pre-Chrome chmod/home failures release every captured directory and write a failure receipt", () => {
  for (const [operation, match, expectedStage] of [
    ["chmod", name => name.startsWith("spaceapp-dev-stack-browser-"), "ARTIFACT_PRIVATE"],
    ["chmod", name => name.startsWith("browser-profile-"), "PROFILE_PRIVATE"],
    ["chmod", name => name.startsWith("bt-"), "CHROME_TEMP_PRIVATE"],
    ["mkdir", name => name === "cache", "PROFILE_HOME"],
  ]) {
    const fixture = acquisitionFixture((op, path) => op === operation && match(basename(path)));
    const result = exerciseAcquisition(fixture);
    assert.equal(result.stage, expectedStage);
    assert.equal(result.primaryCode, `DEV_STACK_BROWSER_${expectedStage}_FAILED`);
    assert.equal(result.cleanup.profileRemoved, true);
    assert.equal(result.cleanup.temporaryRemoved, true);
    assert.deepEqual(result.cleanup.cleanupCodes, []);
    assert.equal(result.receiptWritten, true);
    assert.equal(fixture.writes[0].value.passed, false);
    assert.equal(fixture.writes[0].value.primaryCode, result.primaryCode);
    assert.equal(fixture.writes[0].options.flag, "wx");
    assert.equal([...fixture.nodes.keys()].some(path => /browser-profile-|[\\/]bt-/u.test(path)), false);
  }
});

test("mkdtemp failure after profile capture still releases the profile and preserves its primary error", () => {
  const fixture = acquisitionFixture((operation, path) => operation === "mkdtemp" && basename(path) === "bt-");
  const result = exerciseAcquisition(fixture);
  assert.equal(result.stage, "CHROME_TEMP_CREATE");
  assert.equal(result.primaryCode, "DEV_STACK_BROWSER_CHROME_TEMP_CREATE_FAILED");
  assert.equal(result.cleanup.profileRemoved, true);
  assert.equal(result.cleanup.temporaryRemoved, true);
  assert.deepEqual(result.cleanup.cleanupCodes, []);
  assert.equal(result.receiptWritten, true);
});

test("uncaptured profile/temp inode refuses removal and reports the exact ownership gap", () => {
  for (const [name, expectedStage, expectedCode] of [
    ["browser-profile-ABC123", "PROFILE_IDENTITY", "DEV_STACK_BROWSER_PROFILE_IDENTITY_UNOBSERVED"],
    ["bt-ABC123", "CHROME_TEMP_IDENTITY", "DEV_STACK_BROWSER_TEMP_IDENTITY_UNOBSERVED"],
  ]) {
    const fixture = acquisitionFixture((operation, path) => operation === "stat" && basename(path) === name);
    const result = exerciseAcquisition(fixture);
    assert.equal(result.stage, expectedStage);
    assert.deepEqual(result.cleanup.cleanupCodes, [expectedCode]);
    assert.equal(result.receiptWritten, true);
    assert.equal(fixture.mutations.some(([operation, path]) => operation === "remove" && basename(path) === name), false);
    assert.equal([...fixture.nodes.keys()].some(path => basename(path) === name), true);
  }
});

test("fresh artifact identity must be observed before receipt writing; existing paths are never adopted", () => {
  const unobserved = acquisitionFixture((operation, path) => operation === "stat" && basename(path).startsWith("spaceapp-dev-stack-browser-"));
  const failed = exerciseAcquisition(unobserved);
  assert.equal(failed.stage, "ARTIFACT_IDENTITY");
  assert.equal(failed.receiptWritten, false);
  assert.deepEqual(failed.cleanup.cleanupCodes, ["DEV_STACK_BROWSER_ARTIFACT_IDENTITY_UNOBSERVED"]);
  assert.deepEqual(unobserved.writes, []);
  assert.equal(unobserved.mutations.some(([operation]) => operation === "remove"), false);

  const existing = acquisitionFixture();
  const original = existing.add(existing.artifactDir);
  const refused = exerciseAcquisition(existing);
  assert.equal(refused.stage, "ARTIFACT_CREATE");
  assert.equal(refused.receiptWritten, false);
  assert.equal(refused.lease.artifact.path, null);
  assert.equal(refused.lease.artifact.identity, null);
  assert.equal(existing.nodes.get(existing.artifactDir), original);
  assert.deepEqual(existing.mutations, []); assert.deepEqual(existing.writes, []);
});

test("captured directories remain intact until browser group and proxy are positively gone", () => {
  const fixture = acquisitionFixture();
  const lease = browserDirectoryLease(fixture, fixture.operations);
  lease.acquire();
  for (const flags of [[false, true], [true, false], [false, false]]) {
    const value = lease.cleanup(...flags);
    assert.equal(value.profileRemoved, false); assert.equal(value.temporaryRemoved, false);
    assert.equal(fixture.mutations.some(([operation]) => operation === "remove"), false);
  }
  const released = lease.cleanup(true, true);
  assert.equal(released.profileRemoved, true); assert.equal(released.temporaryRemoved, true);
});

test("replacement of the receipt directory cannot redirect an otherwise owned write", () => {
  const fixture = acquisitionFixture();
  const lease = browserDirectoryLease(fixture, fixture.operations);
  lease.acquire();
  fixture.nodes.get(fixture.artifactDir).ino++;
  assert.throws(() => lease.writeReceipt({ passed: false }), /DIRECTORY_IDENTITY/u);
  assert.deepEqual(fixture.writes, []);
  lease.cleanup(true, true);
});
