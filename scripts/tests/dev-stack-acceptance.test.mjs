import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  acceptanceOwner, assertOwner, assertReadiness, assertSourceStorage, assertSession, assertStarterRoom,
  createTerminalObservation, readinessFailureDiagnostic, runAcceptance, selectStarterPane, sourceStartupTimeoutMs, terminalUrl,
} from "../dev-stack-acceptance.mjs";

const project = `space-dev-${"a".repeat(24)}`;
const ownerState = { project, secrets: { sessionSecret: "b".repeat(64) } };
const email = acceptanceOwner(ownerState).email;
const expected = { paneId: "pane:open-code", roomId: "room:getting-started", cwd: "/tmp/source/.dev-stack/workspaces" };
const sessionId = "cli:acceptance";
const ready = () => ({ status: 200, body: { ok: true, dependencies: {
  store: "postgres", runtimeStore: "postgres", database: "RUNNING", worker: "RUNNING", cliHost: "RUNNING",
  temporal: "disabled",
} } });
const auth = () => ({ status: 200, body: {
  isAuthenticated: true, isSetupRequired: false, user: { id: "user:owner", email, role: "ADMIN" },
} });
const session = () => ({ status: 200, body: {
  session: { sessionId, ...expected, runtimeId: "cli:opencode", purpose: "NORMAL", isActive: true,
    status: "IDLE", statusReason: "CLI session allocated; waiting for terminal transport attach.",
    endedAt: null, exitCode: null },
  runtime: { id: "cli:opencode", capabilities: ["CLI"], detectedCommandPath: "/tmp/source/.dev-stack/bin/opencode" },
  transcript: [], websocket: { paneId: expected.paneId, sessionId, token: "t".repeat(43),
    expiresAt: "2030-01-01T00:00:00.000Z" },
} });
const hello = () => ({ type: "ready", paneId: expected.paneId, sessionId, runtimeId: "cli:opencode",
  protocolVersion: 2, clientMode: "INTERACTIVE", controlState: "CONTROLLER", leaseId: "lease:ours",
  heartbeatIntervalMs: 5000 });
function observer(options) { return createTerminalObservation({ ...expected, sessionId }, options); }
function send(target, value) { target.observe(JSON.stringify(value)); }
function complete(target) {
  send(target, hello());
  send(target, { type: "control_state", controlState: "CONTROLLER", leaseId: "lease:ours" });
  send(target, { type: "status", status: "RUNNING", statusReason: "CLI session attached." });
  send(target, { type: "output", stream: "stdout", data: "\u001b[32mOpenCode terminal\u001b[0m\r\n" });
  send(target, { type: "pong" });
}

test("only initial Darwin startup has a twenty-minute cold-start allowance", () => {
  assert.equal(sourceStartupTimeoutMs("darwin", true), 20 * 60_000);
  for (const [platform, initial] of [["linux", true], ["linux", false], ["darwin", false]]) {
    assert.equal(sourceStartupTimeoutMs(platform, initial), 15 * 60_000);
  }
  assert.equal(sourceStartupTimeoutMs("darwin"), 15 * 60_000);
  assert.equal(sourceStartupTimeoutMs("linux"), 15 * 60_000);
});

test("source startup budget rejects unknown platforms and nonboolean selectors", () => {
  for (const platform of ["win32", "", null, undefined, {}, ["darwin"]]) {
    assert.throws(() => sourceStartupTimeoutMs(platform, true), /STARTUP_BUDGET/u);
  }
  for (const initial of ["true", 1, null, {}, []]) {
    assert.throws(() => sourceStartupTimeoutMs("darwin", initial), /STARTUP_BUDGET/u);
  }
});

test("CI applies the cold-start selector only to initial readiness, not rebuild", () => {
  const source = readFileSync(new URL("../dev-stack-ci.mjs", import.meta.url), "utf8");
  assert.match(source, /async function waitReady\(label, requireCurrentSupervisor = false, timeoutMs = sourceStartupTimeoutMs\(process\.platform\)\)/u);
  assert.match(source, /await waitReady\("strict source startup", true, sourceStartupTimeoutMs\(process\.platform, true\)\)/u);
  assert.match(source, /await waitReady\("new rebuilt source supervisor", true\)/u);
  assert.equal((source.match(/sourceStartupTimeoutMs\(process\.platform, true\)/gu) ?? []).length, 1);
});

test("readiness requires the actual postgres, workflow pollers and host shape", () => {
  assert.equal(assertReadiness(ready()), true);
});
test("HTTP 200 with ok=false never passes readiness", () => {
  const value = ready(); value.body.ok = false;
  assert.throws(() => assertReadiness(value), /NOT_READY/u);
});

function failedReadiness(response) {
  let captured;
  assert.throws(() => assertReadiness(response), error => {
    assert.equal(error.code, "DEV_STACK_ACCEPTANCE_NOT_READY");
    captured = error;
    return true;
  });
  return captured;
}

test("readiness failure preserves all producer decision enums from that exact response", () => {
  const value = ready();
  value.status = 503; value.body.ok = false;
  Object.assign(value.body.dependencies, {
    worker: "NO_POLLERS", cliAdminHost: "disabled", browserHost: "CAPACITY_MISMATCH",
  });
  const error = failedReadiness(value);
  assert.deepEqual(readinessFailureDiagnostic(error), {
    schema: "spaceapp.dev-stack-readiness-failure.v1", httpStatus: 503, ok: false,
    dependencies: { store: "postgres", runtimeStore: "postgres", database: "RUNNING",
      worker: "NO_POLLERS", cliHost: "RUNNING", cliAdminHost: "disabled", browserHost: "CAPACITY_MISMATCH" },
  });
  assert.equal(error.message, "DEV_STACK_ACCEPTANCE_NOT_READY");
  assert.equal(Object.hasOwn(error, "body"), false);
  assert.equal(Object.hasOwn(error, "readiness"), false);
});

test("readiness snapshot cannot be replaced by later response mutation or another probe", () => {
  const value = ready(); value.status = 503; value.body.dependencies.worker = "ERROR";
  const error = failedReadiness(value);
  const snapshot = readinessFailureDiagnostic(error);
  value.status = 200; value.body.dependencies.worker = "RUNNING";
  assert.equal(assertReadiness(value), true);
  const later = ready(); later.status = 503; later.body.dependencies.worker = "NO_POLLERS";
  const laterError = failedReadiness(later);
  assert.equal(readinessFailureDiagnostic(error), snapshot);
  assert.equal(snapshot.httpStatus, 503);
  assert.equal(snapshot.dependencies.worker, "ERROR");
  assert.equal(readinessFailureDiagnostic(laterError).dependencies.worker, "NO_POLLERS");
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.dependencies));
  assert.throws(() => { snapshot.dependencies.worker = "synthetic-private-marker"; }, TypeError);
});

test("readiness diagnostics never echo unknown strings, raw bodies, headers or identities", () => {
  const secret = "synthetic-private-marker";
  const value = { status: 503, headers: { Cookie: secret }, body: {
    ok: false, apiStartedAt: secret, credentials: secret, dependencies: {
      store: secret, runtimeStore: secret, database: secret, worker: secret,
      cliHost: secret, cliAdminHost: secret, browserHost: secret,
      appDiagnostics: { captureId: secret }, browserHostBuildCommit: secret,
      browserHostCaptureMetrics: { secret }, pollerIdentities: [secret], statusReason: secret,
    },
  } };
  const snapshot = readinessFailureDiagnostic(failedReadiness(value));
  assert.ok(Object.values(snapshot.dependencies).every(x => x === "UNRECOGNIZED"));
  const encoded = JSON.stringify(snapshot);
  assert.equal(encoded.includes(secret), false);
  assert.equal(encoded.includes("Cookie"), false);
  assert.equal(encoded.includes("appDiagnostics"), false);
  assert.ok(Buffer.byteLength(encoded) < 1024);
});

test("readiness projection handles malformed fixed fields without coercion or text echo", () => {
  for (const status of [NaN, Infinity, -1, 99, 600, "503", { toString() { assert.fail("No coercion"); } }]) {
    const snapshot = readinessFailureDiagnostic(failedReadiness({ status, body: null }));
    assert.equal(snapshot.httpStatus, null);
    assert.equal(snapshot.ok, null);
    assert.ok(Object.values(snapshot.dependencies).every(x => x === "UNRECOGNIZED"));
  }
  for (const body of [undefined, null, [], "synthetic-private-marker", { ok: "false", dependencies: null }]) {
    const snapshot = readinessFailureDiagnostic(failedReadiness({ status: 503, body }));
    assert.equal(snapshot.httpStatus, 503); assert.equal(snapshot.ok, null);
    assert.equal(JSON.stringify(snapshot).includes("synthetic-private"), false);
  }
});

test("diagnostic boundary ignores inherited fields, accessors and hostile dependency descriptors", () => {
  let reads = 0;
  const dependencies = Object.create({ store: "postgres" });
  Object.defineProperty(dependencies, "worker", { get() { reads++; throw Error("synthetic-private"); } });
  const body = { dependencies };
  Object.defineProperty(body, "ok", { get() { reads++; throw Error("synthetic-private"); } });
  const snapshot = readinessFailureDiagnostic(failedReadiness({ status: 503, body }));
  assert.equal(reads, 0); assert.equal(snapshot.ok, null);
  assert.equal(snapshot.dependencies.store, "UNRECOGNIZED");
  assert.equal(snapshot.dependencies.worker, "UNRECOGNIZED");
  const hostile = new Proxy({}, { getOwnPropertyDescriptor() { throw Error("synthetic-private"); } });
  const safe = readinessFailureDiagnostic(failedReadiness({ status: 503, body: { dependencies: hostile } }));
  assert.equal(JSON.stringify(safe).includes("synthetic-private"), false);
});

test("foreign errors and forged readiness properties cannot cross the diagnostic boundary", () => {
  let reads = 0;
  const fake = new Error("synthetic-private");
  Object.defineProperty(fake, "readiness", { get() { reads++; throw Error("synthetic-private"); } });
  fake.code = "DEV_STACK_ACCEPTANCE_NOT_READY";
  for (const error of [null, undefined, 1, "synthetic-private", fake, {}, () => {}, new Proxy({}, {
    get() { reads++; throw Error("synthetic-private"); },
  })]) assert.equal(readinessFailureDiagnostic(error), null);
  assert.equal(reads, 0);
});

test("CI serializes only locally captured readiness without weakening or retrying the final assertion", () => {
  const source = readFileSync(new URL("../dev-stack-ci.mjs", import.meta.url), "utf8");
  assert.match(source, /readiness: readinessFailureDiagnostic\(primaryFailure\)/u);
  const acceptance = readFileSync(new URL("../dev-stack-acceptance.mjs", import.meta.url), "utf8");
  assert.equal((acceptance.match(/assertReadiness\(await request\("\/readyz\?strict=1"\)\)/gu) ?? []).length, 2);
  assert.match(acceptance, /assertSession\(active, expected, \{ requireRunning: true \}\);\s*assertReadiness\(await request\("\/readyz\?strict=1"\)\)/u);
});

const storageRoot = join(process.cwd(), "synthetic-checkout");
const admin = () => ({ status: 200, body: { status: "ok", capabilities: [], storageWarning: "" } });
const storage = (repoRoot = storageRoot) => ({ status: 200, body: { id: "space-storage", status: "BLOCKED", statusReason: "Same device",
  root: { path: "/", deviceId: "root-device", usedPercent: 25 },
  app: { path: repoRoot, deviceId: "root-device", availableBytes: 30 * 1024 ** 3 },
  dedicatedAppVolume: false, minimumRecommendedFreeBytes: 20 * 1024 ** 3 } });

test("source storage accepts same-device BLOCKED rather than inventing production readiness", () => {
  assert.equal(assertSourceStorage(admin(), storage(), storageRoot), "BLOCKED");
});

test("source storage retains dedicated-volume low-space and root-pressure policy", () => {
  const value = storage(); value.body.app.deviceId = "app-device"; value.body.dedicatedAppVolume = true;
  value.body.app.availableBytes = 1024; value.body.status = "BLOCKED";
  assert.equal(assertSourceStorage(admin(), value, storageRoot), "BLOCKED");
  value.body.app.availableBytes = 30 * 1024 ** 3; value.body.root.usedPercent = 85; value.body.status = "WARN";
  assert.equal(assertSourceStorage(admin(), value, storageRoot), "WARN");
  value.body.root.usedPercent = 25; value.body.status = "VERIFIED";
  assert.equal(assertSourceStorage(admin(), value, storageRoot), "VERIFIED");
});

test("source admin rejects a real HTTP failure and malformed success bodies", () => {
  for (const response of [{ status: 500, body: null }, { status: 200, body: {} },
    { status: 200, body: { ...admin().body, storageWarning: "unexpected" } }]) {
    assert.throws(() => assertSourceStorage(response, storage(), storageRoot), /ADMIN_ENDPOINT/u);
  }
});

test("source storage rejects foreign paths, false dedicated flags, missing metadata and changed thresholds", () => {
  for (const alter of [
    value => { value.status = 500; }, value => { value.body.app.path = "/opt/spaceapp"; },
    value => { value.body.dedicatedAppVolume = true; }, value => { value.body.minimumRecommendedFreeBytes = 0; },
    value => { value.body.app.availableBytes = -1; }, value => { value.body.root.usedPercent = NaN; },
  ]) {
    const value = storage(); alter(value);
    assert.throws(() => assertSourceStorage(admin(), value, storageRoot), /STORAGE_IDENTITY/u);
  }
});

test("source storage rejects fake VERIFIED on the root device and exposes no response text in failure", () => {
  const value = storage(); value.body.status = "VERIFIED"; value.body.statusReason = "synthetic-private-text";
  assert.throws(() => assertSourceStorage(admin(), value, storageRoot), error => {
    assert.equal(error.code, "DEV_STACK_ACCEPTANCE_STORAGE_POLICY");
    assert.equal(error.message.includes("synthetic-private"), false); return true;
  });
});
test("strict health status failure is rejected even if body claims success", () => {
  const value = ready(); value.status = 503;
  assert.throws(() => assertReadiness(value), /NOT_READY/u);
});
for (const [key, bad] of [["store", "memory"], ["runtimeStore", "memory"], ["database", "in-memory"],
  ["worker", "NO_POLLERS"], ["worker", "disabled"], ["cliHost", "UNAVAILABLE"], ["cliHost", "disabled"]]) {
  test(`readiness rejects ${key}=${bad}`, () => {
    const value = ready(); value.body.dependencies[key] = bad;
    assert.throws(() => assertReadiness(value), /NOT_READY/u);
  });
}
test("a services-shaped fixture does not replace actual dependencies", () => {
  const value = ready(); value.body.services = value.body.dependencies; delete value.body.dependencies;
  assert.throws(() => assertReadiness(value), /NOT_READY/u);
});
test("synthetic owner credentials are strong, deterministic and checkout-specific", () => {
  const first = acceptanceOwner(ownerState);
  assert.deepEqual(first, acceptanceOwner(ownerState));
  assert.match(first.email, /^acceptance\+[a-f0-9]{24}@spaceapp\.invalid$/u);
  assert.ok(first.password.length >= 50);
  assert.match(first.password, /[A-Z]/u); assert.match(first.password, /[a-z]/u);
  assert.match(first.password, /[0-9]/u); assert.match(first.password, /[^a-zA-Z0-9]/u);
  assert.notEqual(first.password, acceptanceOwner({ ...ownerState, secrets: { sessionSecret: "c".repeat(64) } }).password);
  assert.notEqual(first.password, acceptanceOwner({ ...ownerState, project: `space-dev-${"d".repeat(24)}` }).password);
});
test("synthetic credentials refuse missing or malformed checkout secrets", () => {
  assert.throws(() => acceptanceOwner({ project }), /INVALID_OWNER_STATE/u);
  assert.throws(() => acceptanceOwner({ ...ownerState, project: "stable" }), /INVALID_OWNER_STATE/u);
});
test("owner assertion accepts actual owner and rejects proof or dev user lookalikes", () => {
  assert.equal(assertOwner(auth(), email), "user:owner");
  for (const user of [{ id: "user:dev" }, { role: "OPERATOR" }, { email: "other@spaceapp.invalid" },
    { proofScope: "READ_ONLY" }, { automationScope: "APP_DIAGNOSTICS" }]) {
    const value = auth(); Object.assign(value.body.user, user);
    assert.throws(() => assertOwner(value, email), /OWNER_AUTH/u);
  }
});
test("starter room is the original owner's Getting Started workspace", () => {
  const value = { status: 200, body: { room: { id: expected.roomId, name: "Getting Started", kind: "WORKSPACE",
    archivedAt: null, ownerUserId: "user:owner" }, onboarding: { starterRoomId: expected.roomId } } };
  assert.equal(assertStarterRoom(value, expected.roomId), expected.roomId);
  assert.throws(() => assertStarterRoom(value, "room:foreign"), /STARTER_ROOM/u);
  value.body.room.kind = "AGENT_PROOF";
  assert.throws(() => assertStarterRoom(value), /STARTER_ROOM/u);
});
test("select only one open original OpenCode terminal, not a generated substitute", () => {
  const pane = { id: expected.paneId, roomId: expected.roomId, title: "OpenCode CLI", mode: "TERMINAL",
    terminalRuntimeId: "cli:opencode", isClosed: false };
  const value = { status: 200, body: { data: [pane] } };
  assert.equal(selectStarterPane(value, expected.roomId).id, expected.paneId);
  value.body.data.push({ ...pane, id: "pane:duplicate" });
  assert.throws(() => selectStarterPane(value, expected.roomId), /STARTER_PANE/u);
  value.body.data = [{ ...pane, terminalRuntimeId: "cli:codex" }];
  assert.throws(() => selectStarterPane(value, expected.roomId), /STARTER_PANE/u);
});
test("allocated IDLE is valid before attach but not evidence of RUNNING", () => {
  assert.equal(assertSession(session(), expected).sessionId, sessionId);
  assert.throws(() => assertSession(session(), expected, { requireRunning: true }), /CLI_SESSION/u);
  const value = session(); value.body.session.status = "RUNNING";
  assert.equal(assertSession(value, { ...expected, sessionId }, { requireRunning: true }).sessionId, sessionId);
});
test("ERROR with reason containing 'session' is not a positive status", () => {
  const value = session(); value.body.session.status = "ERROR";
  value.body.session.statusReason = "CLI session could not start.";
  assert.throws(() => assertSession(value, expected), /CLI_SESSION/u);
});
for (const patch of [{ cwd: "/etc" }, { purpose: "LOGIN" }, { isActive: false }, { runtimeId: "cli:codex" },
  { status: "EXITED" }, { status: "INTERRUPTING" }, { paneId: "pane:other" }, { exitCode: 1 }]) {
  test(`session rejects nonmatching state ${JSON.stringify(patch)}`, () => {
    const value = session(); Object.assign(value.body.session, patch);
    assert.throws(() => assertSession(value, expected), /CLI_SESSION/u);
  });
}
test("session rejects a missing native command and synthetic transcript output", () => {
  const value = session(); value.body.runtime.detectedCommandPath = null;
  assert.throws(() => assertSession(value, expected), /CLI_SESSION/u);
  const another = session(); another.body.transcript = [{ stream: "system", data: "session allocated" }];
  assert.throws(() => assertSession(another, expected), /CLI_SESSION/u);
});

test("session diagnostics identify a failed predicate without echoing response values", () => {
  const value = session(); value.body.session.cwd = "/etc/private-canary-not-for-logs";
  assert.throws(() => assertSession(value, expected), error => {
    assert.equal(error.code, "DEV_STACK_ACCEPTANCE_CLI_SESSION_CWD");
    assert.equal(error.message, "DEV_STACK_ACCEPTANCE_CLI_SESSION_CWD");
    assert.equal(error.message.includes("private-canary"), false);
    return true;
  });
  assert.throws(() => assertSession({ status: 503, body: null }, expected),
    /CLI_SESSION_HTTP_STATUS/u);
});
test("WS ticket must bind the pane/session and cannot be a proof ticket", () => {
  for (const patch of [{ paneId: "pane:other" }, { sessionId: "session:other" }, { token: "short" },
    { expiresAt: "not a date" }, { proofScope: "READ_ONLY" }]) {
    const value = session(); Object.assign(value.body.websocket, patch);
    assert.throws(() => assertSession(value, expected), /CLI_TICKET/u);
  }
});
test("WS v2 query has unique UUID identities, real ticket and bounded dimensions", () => {
  const { url, identity } = terminalUrl("http://127.0.0.1:5910", session().body);
  assert.equal(url.protocol, "ws:"); assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/api/panes/pane%3Aopen-code/cli/terminal");
  assert.equal(url.searchParams.get("token"), session().body.websocket.token);
  assert.equal(url.searchParams.get("sessionId"), sessionId);
  assert.equal(url.searchParams.get("protocolVersion"), "2");
  assert.equal(url.searchParams.get("clientMode"), "INTERACTIVE");
  assert.equal(url.searchParams.get("initialCols"), "100");
  assert.equal(url.searchParams.get("initialRows"), "30");
  assert.equal(new Set(Object.values(identity)).size, 4);
  for (const value of Object.values(identity)) assert.match(value, /^[0-9a-f-]{36}$/u);
  assert.throws(() => terminalUrl("http://example.org:5910", session().body), /NONLOCAL_ORIGIN/u);
});
test("PTY evidence requires ready, RUNNING, pong and actual printable output", () => {
  const value = observer(); complete(value);
  const result = value.snapshot();
  assert.equal(result.complete, true); assert.equal(result.openCodeBrandingObserved, true);
  assert.equal(result.outputFrames, 1); assert.ok(result.outputBytes > result.printableCharacters);
  assert.equal(Object.hasOwn(result, "output"), false);
});
test("ready/status messages alone do not fabricate terminal bytes", () => {
  const value = observer(); send(value, hello());
  send(value, { type: "status", status: "RUNNING", statusReason: "session attached" });
  send(value, { type: "pong" });
  assert.equal(value.snapshot().complete, false);
  send(value, { type: "output", stream: "stdout", data: "\u001b[2J\r\n" });
  assert.equal(value.snapshot().complete, false);
});
test("branding is an optional observation, not a full TUI assertion", () => {
  const value = observer(); send(value, hello());
  send(value, { type: "output", stream: "stdout", data: "Welcome to the terminal" });
  send(value, { type: "status", status: "RUNNING" }); send(value, { type: "pong" });
  assert.equal(value.snapshot().complete, true);
  assert.equal(value.snapshot().openCodeBrandingObserved, false);
});
for (const message of [{ type: "status", status: "ERROR", statusReason: "session failed" },
  { type: "status", status: "EXITED", exitCode: 0 }, { type: "status", status: "INTERRUPTING" },
  { type: "error", code: "CLI_SESSION_FAILED", message: "secret must not appear in error" },
  { type: "session_replaced", sessionId: "session:other" },
  { type: "control_state", controlState: "HELD_BY_OTHER", leaseId: "lease:other" },
  { type: "control_revoked", leaseId: "lease:ours", reason: "TAKEN_OVER" }]) {
  test(`terminal rejects ${message.type}/${message.status ?? message.controlState ?? "failure"} even after initial success`, () => {
    const value = observer(); complete(value);
    assert.throws(() => send(value, message), error => {
      assert.match(error.message, /^DEV_STACK_ACCEPTANCE_/u);
      assert.ok(!error.message.includes("secret")); return true;
    });
    assert.throws(() => value.snapshot(), /^Error: DEV_STACK_ACCEPTANCE_/u);
  });
}
test("rejected terminal events retain only closed diagnostic labels and never weaken rejection", () => {
  const cases = [
    [{ type: "error", code: "CLI_TERMINAL_ATTACH_FAILED" }, "ERROR_ATTACH_FAILED"],
    [{ type: "error", code: "CLI_SESSION_CLOSED" }, "ERROR_SESSION_CLOSED"],
    [{ type: "error", code: "BAD_MESSAGE" }, "ERROR_BAD_MESSAGE"],
    [{ type: "error", code: "CODEX_EMPTY_ASSISTANT_MESSAGE" }, "ERROR_EMPTY_ASSISTANT"],
    [{ type: "error", code: "PRIVATE_SYNTHETIC_SECRET" }, "ERROR_OTHER"],
    [{ type: "error", code: "constructor" }, "ERROR_OTHER"],
    [{ type: "error", code: "__proto__" }, "ERROR_OTHER"],
    [{ type: "session_replaced" }, "SESSION_REPLACED"],
    [{ type: "control_denied" }, "CONTROL_DENIED"],
    [{ type: "control_revoked" }, "CONTROL_REVOKED"],
    [{ type: "PRIVATE_SYNTHETIC_SECRET" }, "UNKNOWN"],
    [{ type: "constructor" }, "UNKNOWN"],
    [{ type: "__proto__" }, "UNKNOWN"],
  ];
  for (const [message, label] of cases) {
    const value = observer();
    complete(value);
    const expectedCode = `DEV_STACK_ACCEPTANCE_TERMINAL_EVENT_${label}`;
    assert.throws(() => send(value, { ...message, message: "PRIVATE_SYNTHETIC_SECRET" }), error => {
      assert.equal(error.code, expectedCode);
      assert.equal(error.message, expectedCode);
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE_SYNTHETIC_SECRET/u);
      return true;
    });
    assert.throws(() => value.snapshot(), error => error.code === expectedCode);
  }
});

test("mismatched session, observer or v1 cannot pass as controlled WS v2", () => {
  for (const patch of [{ sessionId: "other" }, { paneId: "other" }, { runtimeId: "cli:codex" },
    { protocolVersion: 1 }, { clientMode: "OBSERVER" }, { controlState: "AVAILABLE" }, { leaseId: null }]) {
    assert.throws(() => send(observer(), { ...hello(), ...patch }), /TERMINAL_READY/u);
  }
});
test("transport bounds reject oversized output, floods and malformed frames", () => {
  const value = observer({ maxOutputBytes: 4 }); send(value, hello());
  assert.throws(() => send(value, { type: "output", stream: "stdout", data: "12345" }), /TERMINAL_OUTPUT_LIMIT/u);
  const flood = observer({ maxMessages: 1 }); send(flood, hello());
  assert.throws(() => send(flood, { type: "pong" }), /TERMINAL_MESSAGE_LIMIT/u);
  assert.throws(() => observer().observe("not JSON"), /TERMINAL_JSON/u);
  assert.throws(() => observer().observe(Buffer.from("{}"), true), /TERMINAL_MESSAGE_LIMIT/u);
});
test("known source proof fixture bytes are never live terminal evidence", () => {
  const value = observer(); send(value, hello());
  assert.throws(() => send(value, { type: "output", stream: "stdout", data: "SPACE_WARM_READY" }),
    /TERMINAL_SYNTHETIC_OUTPUT/u);
});

// Stubbed fetch checks orchestration failures without opening sockets, importing
// ws, reading secrets from disk, or running any real stack/provider operation.
function syntheticState() {
  return { ...ownerState, repoRoot: process.cwd(), stateDir: join(process.cwd(), ".dev-stack"),
    ports: { api: 5910, web: 5911, postgres: 55432, temporal: 57233 },
    secrets: { ...ownerState.secrets, setupToken: "c".repeat(64) } };
}
function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
async function withFetchStub(stub, operation) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await operation(); }
  finally { globalThis.fetch = original; }
}
test("invalid state or stable ports fail before any fetch", async () => {
  await withFetchStub(() => { assert.fail("No transport is allowed for invalid state"); }, async () => {
    const state = syntheticState(); state.ports.api = 4910;
    await assert.rejects(runAcceptance({ state }), /INVALID_PORTS/u);
    await assert.rejects(runAcceptance({ state: { ...state, repoRoot: undefined } }), /INVALID_STATE/u);
  });
});
test("an already claimed foreign owner is not reclaimed or reset", async () => {
  const paths = [];
  await withFetchStub(async url => {
    paths.push(url.pathname);
    if (url.pathname === "/readyz") return jsonResponse(ready().body);
    if (url.pathname === "/api/setup/status") return jsonResponse({ setupRequired: false, expiresAt: null });
    if (url.pathname === "/api/auth/login") return jsonResponse({ error: { code: "INVALID_CREDENTIALS" } }, 401);
    assert.fail("Unexpected operation after owner conflict");
  }, async () => {
    await assert.rejects(runAcceptance({ state: syntheticState() }), /OWNER_AUTH/u);
  });
  assert.deepEqual(paths, ["/readyz", "/api/setup/status", "/api/auth/login"]);
});
test("fresh setup claim is attempted only once and payload errors are not echoed", async () => {
  let claims = 0;
  await withFetchStub(async (url, options) => {
    if (url.pathname === "/readyz") return jsonResponse(ready().body);
    if (url.pathname === "/api/setup/status") return jsonResponse({ setupRequired: true, expiresAt: null });
    if (url.pathname === "/api/setup/claim") {
      claims++;
      const body = JSON.parse(options.body);
      assert.equal(body.email, email);
      assert.ok(body.password.length >= 50);
      assert.equal(body.token, syntheticState().secrets.setupToken);
      return jsonResponse({ error: { message: "private-data-never-logged" } }, 409);
    }
    assert.fail("Claim failures must not cause login, reset or another claim");
  }, async () => {
    await assert.rejects(runAcceptance({ state: syntheticState() }), error => {
      assert.equal(error.message, "DEV_STACK_ACCEPTANCE_OWNER_AUTH"); return true;
    });
  });
  assert.equal(claims, 1);
});
test("successful JSON auth without a real session cookie does not pass", async () => {
  await withFetchStub(async url => {
    if (url.pathname === "/readyz") return jsonResponse(ready().body);
    if (url.pathname === "/api/setup/status") return jsonResponse({ setupRequired: false, expiresAt: null });
    if (url.pathname === "/api/auth/login") return jsonResponse(auth().body);
    assert.fail("Missing session cookie must stop before authenticated mutations");
  }, async () => {
    await assert.rejects(runAcceptance({ state: syntheticState() }), /SESSION_COOKIE/u);
  });
});
test("a web proxy reaching a different owner is rejected before WS attachment", async () => {
  const mutations = [];
  await withFetchStub(async (url, options) => {
    if (url.pathname === "/readyz") return jsonResponse(ready().body);
    if (url.pathname === "/api/setup/status") return jsonResponse({ setupRequired: false, expiresAt: null });
    if (url.pathname === "/api/auth/login") return jsonResponse(auth().body, 200,
      { "set-cookie": "space_session_dev=synthetic-cookie; HttpOnly; Path=/; SameSite=Lax" });
    if (url.pathname === "/api/auth/me") {
      assert.equal(options.headers.Cookie, "space_session_dev=synthetic-cookie");
      const body = auth().body;
      if (url.port === "5911") body.user.email = "foreign@spaceapp.invalid";
      return jsonResponse(body);
    }
    if (url.pathname === "/api/auth/csrf") return jsonResponse({ headerName: "x-space-csrf-token", csrfToken: "s".repeat(32) });
    if (url.pathname === "/api/admin") return jsonResponse(admin().body);
    if (url.pathname === "/api/admin/storage") return jsonResponse(storage(syntheticState().repoRoot).body);
    if (options.method === "POST") {
      mutations.push(url.pathname);
      assert.equal(options.headers["x-space-csrf-token"], "s".repeat(32));
    }
    if (url.pathname === "/api/setup/starter-room") return jsonResponse({ room: {
      id: expected.roomId, name: "Getting Started", kind: "WORKSPACE", archivedAt: null, ownerUserId: "user:owner",
    }, onboarding: { starterRoomId: expected.roomId } });
    if (url.pathname === "/api/panes") return jsonResponse({ data: [{ id: expected.paneId, roomId: expected.roomId,
      mode: "TERMINAL", terminalRuntimeId: "cli:opencode", title: "OpenCode CLI", isClosed: false }] });
    if (url.pathname.endsWith("/cli/session")) {
      const body = session().body;
      const workspaceRoot = join(syntheticState().stateDir, "workspaces");
      body.session.cwd = join(workspaceRoot, "acceptance");
      assert.equal(JSON.parse(options.body).cwd, body.session.cwd);
      // Root equality invokes the API's legacy /etc alias. The real request
      // must name a concrete isolated child, not merely accept any returned cwd.
      assert.notEqual(JSON.parse(options.body).cwd, workspaceRoot);
      assert.equal(JSON.parse(options.body).includeTranscript, false);
      return jsonResponse(body);
    }
    if (url.pathname === "/") return new Response('<div id="root"></div><script type="module" src="/src/main.tsx"></script>');
    assert.fail("Unexpected route in synthetic orchestration test");
  }, async () => {
    await assert.rejects(runAcceptance({ state: syntheticState() }), /OWNER_AUTH/u);
  });
  assert.deepEqual(mutations, ["/api/setup/starter-room", `/api/panes/${encodeURIComponent(expected.paneId)}/cli/session`]);
});

for (const failure of ["admin500", "foreign-storage-root"]) {
  test(`source acceptance refuses ${failure} before starter mutations or terminal allocation`, async () => {
    await withFetchStub(async url => {
      if (url.pathname === "/readyz") return jsonResponse(ready().body);
      if (url.pathname === "/api/setup/status") return jsonResponse({ setupRequired: false, expiresAt: null });
      if (url.pathname === "/api/auth/login") return jsonResponse(auth().body, 200,
        { "set-cookie": "space_session_dev=synthetic-cookie; HttpOnly; Path=/; SameSite=Lax" });
      if (url.pathname === "/api/auth/me") return jsonResponse(auth().body);
      if (url.pathname === "/api/auth/csrf") return jsonResponse({ headerName: "x-space-csrf-token", csrfToken: "s".repeat(32) });
      if (url.pathname === "/api/admin") return jsonResponse(admin().body, failure === "admin500" ? 500 : 200);
      if (url.pathname === "/api/admin/storage") return jsonResponse(storage("/foreign-checkout").body);
      assert.fail("Storage failure must stop before starter mutations/terminal attachment");
    }, async () => {
      await assert.rejects(runAcceptance({ state: syntheticState() }),
        failure === "admin500" ? /ADMIN_ENDPOINT/u : /STORAGE_IDENTITY/u);
    });
  });
}
