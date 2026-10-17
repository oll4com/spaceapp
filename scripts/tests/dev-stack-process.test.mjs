import test from "node:test";
import assert from "node:assert/strict";
import { sameProcess, signalOwnedGroup, signalOwnedProcess, processIdentity, assertGroupsGone,
  createShutdownSignals, waitGroupsGone, verifyShutdownGroups } from "../dev-stack-process.mjs";
import { parseCwdRecords, darwinStateCwdProcesses } from "../dev-stack-process.mjs";
import { parseDarwinProcessIdentity, processIdentityFailureDiagnostic } from "../dev-stack-process.mjs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";

const original = { pid: 23001, pgid: 23001, startId: "boot:12345" };

const darwinBirth = "Fri Oct 16 21:42:00 2026";
const darwinCommand = "/opt/node/bin/node scripts/dev-stack.mjs";
const commandDigest = value => createHash("sha256").update(value).digest("hex");

function captureIdentityRefusal(pid, output, context) {
  let caught;
  try { parseDarwinProcessIdentity(pid, output, context); }
  catch (error) { caught = error; }
  assert.ok(caught instanceof Error);
  assert.equal(caught.message, "Cannot establish process creation identity.");
  return { error: caught, diagnostic: processIdentityFailureDiagnostic(caught) };
}

test("Darwin refusal records the same input branch and fixed structure, not guessed fields", () => {
  const input = captureIdentityRefusal(1, "", "SUPERVISOR_SIGNAL").diagnostic;
  assert.equal(input.stage, "INPUT"); assert.equal(input.pidValid, false);
  assert.equal(input.rowMatched, null); assert.equal(input.context, "SUPERVISOR_SIGNAL");
  const empty = captureIdentityRefusal(23001, " \n", "SUPERVISOR_SHUTDOWN_WAIT").diagnostic;
  assert.equal(empty.stage, "ROW"); assert.equal(empty.trimmedLineClass, "EMPTY");
  assert.equal(empty.codeUnits, 2); assert.equal(empty.rowMatched, false);
  assert.equal(empty.groupFieldClass, "UNOBSERVED"); assert.equal(empty.birthWidth24, null);
  assert.equal(empty.context, "SUPERVISOR_SHUTDOWN_WAIT");
  const badGroup = captureIdentityRefusal(23001, `S 1 ${darwinBirth} private-command`).diagnostic;
  assert.equal(badGroup.rowMatched, true); assert.equal(badGroup.groupFieldClass, "NOT_SAFE_PRIVATE_GROUP");
  assert.equal(badGroup.stateMarkerClass, "NON_Z_PREFIX");
  const multiple = captureIdentityRefusal(23001, `S 23001 ${darwinBirth} first\nsecond`).diagnostic;
  assert.equal(multiple.trimmedLineClass, "MULTIPLE"); assert.equal(multiple.rowMatched, false);
  assert.equal(multiple.commandPresent, null);
});

test("Darwin diagnostic never coerces nonstrings or over-budget input and never echoes unknown text", () => {
  const privateText = "SECRET-cookie-token-user-path-date-command";
  const hostile = { toString: () => assert.fail("do not coerce input"),
    get length() { assert.fail("do not read object length"); } };
  const nonstring = captureIdentityRefusal(23001, hostile, privateText).diagnostic;
  assert.equal(nonstring.stage, "INPUT"); assert.equal(nonstring.outputKind, "OTHER");
  assert.equal(nonstring.codeUnits, null); assert.equal(nonstring.trimmedLineClass, "UNOBSERVED");
  assert.equal(nonstring.context, "UNSPECIFIED");
  const long = captureIdentityRefusal(23001, "x".repeat(65_537)).diagnostic;
  assert.equal(long.codeUnits, 65_537); assert.equal(long.stage, "INPUT");
  assert.equal(long.leadingColumnsShape, null); assert.equal(long.trimmedLineClass, "UNOBSERVED");
  for (const diagnostic of [nonstring, long, captureIdentityRefusal(23001, privateText).diagnostic]) {
    assert.equal(JSON.stringify(diagnostic).includes(privateText), false);
    assert.ok(Object.values(diagnostic).every(value => value === null || ["string", "number", "boolean"].includes(typeof value)));
  }
});

test("Darwin diagnostic belongs only to its exact locally thrown error and remains frozen", () => {
  const first = captureIdentityRefusal(23001, "", "SUPERVISOR_SIGNAL");
  const before = JSON.stringify(first.diagnostic);
  captureIdentityRefusal(23001, "changed later", "SUPERVISOR_SHUTDOWN_WAIT");
  assert.equal(processIdentityFailureDiagnostic(first.error), first.diagnostic);
  assert.equal(JSON.stringify(first.diagnostic), before); assert.equal(Object.isFrozen(first.diagnostic), true);
  assert.throws(() => { first.diagnostic.context = "changed"; }, TypeError);
  assert.equal(processIdentityFailureDiagnostic(new Error(first.error.message)), null);
  assert.equal(processIdentityFailureDiagnostic({ diagnostic: first.diagnostic }), null);
  assert.equal(processIdentityFailureDiagnostic(new Proxy({}, { get: () => assert.fail("no property access") })), null);
  for (const value of [null, undefined, 0, "private-text"]) assert.equal(processIdentityFailureDiagnostic(value), null);
});

test("Darwin structural diagnostics do not authorize a signal or alter matching live identities", () => {
  const failure = captureIdentityRefusal(23001, "");
  let signals = 0;
  assert.throws(() => signalOwnedProcess(original, "SIGTERM", {
    inspect: () => { throw failure.error; }, kill: () => signals++,
  }), error => error === failure.error);
  assert.equal(signals, 0);
  const live = parseDarwinProcessIdentity(23001, `Ss+ 23001 ${darwinBirth} ${darwinCommand}`, "SUPERVISOR_SIGNAL");
  assert.deepEqual(live, { pid: 23001, pgid: 23001, startId: `${darwinBirth}:${commandDigest(darwinCommand)}` });
  assert.equal(parseDarwinProcessIdentity(23001, `Z 23001 ${darwinBirth} <defunct>`, "SUPERVISOR_SHUTDOWN_WAIT"), null);
});

test("Darwin live parsing retains the original birth and command fingerprint", () => {
  const observed = parseDarwinProcessIdentity(23001, `  Ss+ 23001 ${darwinBirth} ${darwinCommand}\n`);
  assert.deepEqual(observed, { pid: 23001, pgid: 23001,
    startId: `${darwinBirth}:${commandDigest(darwinCommand)}` });
  assert.equal(sameProcess(observed, { ...observed }), true);
});

test("Darwin zombies are not misreported as reused live identities after command replacement", () => {
  const live = parseDarwinProcessIdentity(23001, `S 23001 ${darwinBirth} ${darwinCommand}`);
  // Modelled ps output, not a claim that the historical runner captured this row.
  const legacyZombieFingerprint = `${darwinBirth}:${commandDigest("<defunct>")}`;
  assert.notEqual(legacyZombieFingerprint, live.startId);
  for (const state of ["Z", "Z+", "Zs"]) {
    assert.equal(parseDarwinProcessIdentity(23001, `${state} 23001 ${darwinBirth} <defunct>`), null);
  }
});

test("Darwin live birth, command and process-group changes still refuse signalling", () => {
  const receipt = parseDarwinProcessIdentity(23001, `S 23001 ${darwinBirth} ${darwinCommand}`);
  for (const row of [`S 23001 Fri Oct 16 21:42:01 2026 ${darwinCommand}`,
    `S 23001 ${darwinBirth} foreign-command`, `S 23002 ${darwinBirth} ${darwinCommand}`]) {
    const observed = parseDarwinProcessIdentity(23001, row);
    assert.equal(sameProcess(receipt, observed), false);
    assert.throws(() => signalOwnedProcess(receipt, "SIGTERM", {
      inspect: () => observed, kill: () => assert.fail("never signal a changed live identity")
    }), /creation identity changed/u);
  }
});

test("Darwin zombie leader is never signalled and does not certify descendant-group absence", () => {
  const receipt = parseDarwinProcessIdentity(23001, `S 23001 ${darwinBirth} ${darwinCommand}`);
  const inspect = () => parseDarwinProcessIdentity(23001, `Z 23001 ${darwinBirth} <defunct>`);
  assert.equal(signalOwnedProcess(receipt, "SIGKILL", { inspect,
    kill: () => assert.fail("never signal a zombie leader") }), false);
  assert.equal(signalOwnedGroup(receipt, "SIGTERM", { inspect,
    kill: () => assert.fail("never infer group ownership from dead leader") }), false);
  assert.throws(() => assertGroupsGone([receipt], { kill: () => {} }), /remains/u);
});

test("Darwin malformed, missing and oversized observations fail closed", () => {
  for (const row of ["", `23001 ${darwinBirth} ${darwinCommand}`, `S 1 ${darwinBirth} ${darwinCommand}`,
    `S 23001 short-date ${darwinCommand}`, `S 23001 ${darwinBirth} first\nsecond`, "x".repeat(65_537)]) {
    assert.throws(() => parseDarwinProcessIdentity(23001, row), /creation identity/u);
  }
  for (const pid of [0, 1, "23001", 2.5]) {
    assert.throws(() => parseDarwinProcessIdentity(pid, `Z 23001 ${darwinBirth} <defunct>`), /creation identity/u);
  }
});

test("NUL cwd records bind each path to its PID and exclude sibling prefixes", () => {
  const state = resolve("isolated state");
  const output = `p23001\0\nfcwd\0n${state}\0\np23002\0\nfcwd\0n${join(state, "child with spaces")}\0\np23003\0\nfcwd\0n${state}-foreign\0\n`;
  assert.deepEqual(parseCwdRecords(output, state), [23001, 23002]);
  assert.deepEqual(parseCwdRecords("", state), []);
  assert.throws(() => parseCwdRecords(`n${state}\0`, state), /Unbound/u);
  assert.throws(() => parseCwdRecords(`pnot-a-pid\0`, state), /Invalid/u);
  assert.throws(() => parseCwdRecords(`p23001\0cunexpected\0`, state), /Unexpected/u);
});

test("Darwin cwd scanner requests only the selected user's cwd, not recursive paths", () => {
  const state = resolve("isolated-state");
  assert.deepEqual(darwinStateCwdProcesses(state, { uid: 501, execute: (command, args) => {
    assert.equal(command, "lsof");
    assert.deepEqual(args, ["-nP", "-a", "-u", "501", "-d", "cwd", "-F0pfn"]);
    return { status: 0, stdout: `p23001\0\nfcwd\0n${state}\0\n`, stderr: "" };
  } }), [23001]);
});

test("Darwin cwd no-match is distinct from failed or denied observation", () => {
  const state = resolve("isolated-state");
  assert.deepEqual(darwinStateCwdProcesses(state, { uid: 501, execute: () => ({ status: 1, stdout: "", stderr: "" }) }), []);
  for (const observation of [{ error: { code: "ENOENT" } }, { status: 1, stderr: "permission denied", stdout: "" },
    { status: 2, stdout: "", stderr: "" }, { status: 0, stdout: "", stderr: "partial permission failure" }]) {
    assert.throws(() => darwinStateCwdProcesses(state, { uid: 501, execute: () => observation }), /not certified/u);
  }
  assert.throws(() => darwinStateCwdProcesses(state, { uid: -1, execute: () => assert.fail() }), /identity/u);
});

test("ownership requires creation identity and a dedicated process group", () => {
  assert.equal(sameProcess(original, { ...original }), true);
  for (const changed of [null, { ...original, startId: "boot:54321" }, { ...original, pgid: 10 }, { ...original, pid: 9 }]) {
    assert.equal(sameProcess(original, changed), false);
  }
  assert.equal(sameProcess({ ...original, pgid: 9 }, { ...original, pgid: 9 }), false);
});

test("PID reuse refuses every signal, including escalation", () => {
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    let calls = 0;
    assert.throws(() => signalOwnedGroup(original, signal, {
      inspect: () => ({ ...original, startId: "other-creation" }), kill: () => calls++
    }), /identity changed/);
    assert.equal(calls, 0);
  }
});

test("only an observed matching private group receives a supported signal", () => {
  const calls = [];
  assert.equal(signalOwnedGroup(original, "SIGTERM", { inspect: () => original, kill: (...args) => calls.push(args) }), true);
  assert.deepEqual(calls, [[-23001, "SIGTERM"]]);
  assert.equal(signalOwnedGroup(original, "SIGKILL", { inspect: () => null, kill: () => assert.fail() }), false);
  assert.throws(() => signalOwnedGroup(original, "SIGINT", { inspect: () => original, kill: () => assert.fail() }), /Unsupported/);
});

test("invalid persisted PIDs are rejected before OS inspection", () => {
  for (const value of [undefined, null, 0, 1, -23, 2.5, "23"]) assert.throws(() => processIdentity(value), /Invalid/);
});

test("a dead leader or permission error must not disguise a remaining group", () => {
  assert.throws(() => assertGroupsGone([original], { kill: () => {} }), /remains/);
  assert.doesNotThrow(() => assertGroupsGone([original], { kill: () => { throw Object.assign(new Error(), { code: "ESRCH" }); } }));
  assert.throws(() => assertGroupsGone([original], { kill: () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); } }), /denied/);
  assert.throws(() => assertGroupsGone([{ ...original, pgid: 1 }], { kill: () => assert.fail() }), /Invalid/);
});

test("supervisor teardown signals only its own birth-checked PID, not the caller's shared group", () => {
  const supervisor = { pid: 23001, pgid: 22000, startId: "boot:12345" };
  const calls = [];
  signalOwnedProcess(supervisor, "SIGTERM", { inspect: () => supervisor, kill: (...args) => calls.push(args) });
  assert.deepEqual(calls, [[23001, "SIGTERM"]]);
  assert.throws(() => signalOwnedProcess(supervisor, "SIGKILL", {
    inspect: () => ({ ...supervisor, startId: "other-birth" }), kill: () => assert.fail()
  }), /creation identity changed/);
});

test("shutdown signals once before a post-signal identity transition, without certifying group absence", () => {
  const receipt = Object.freeze({ ...original });
  let observation = { ...original }, signals = 0, inspections = 0;
  const shutdown = createShutdownSignals({ signalGroup: record => signalOwnedGroup(record, "SIGTERM", {
    inspect: () => { inspections++; return observation; }, kill: () => { signals++; }
  }) });
  shutdown.signalAll([receipt]);
  observation = { ...original, startId: "same-pid-command-changed-after-signal" };
  shutdown.signalAll([receipt]);
  shutdown.signalAll([receipt]);
  assert.equal(signals, 1); assert.equal(inspections, 1);
  assert.deepEqual(shutdown.failures(), []);
  assert.throws(() => assertGroupsGone([receipt], { kill: () => {} }), /remains/);
});

test("a first shutdown mismatch or probe failure is retained, never hidden by a later pass", () => {
  const mismatch = new Error("original mismatch"), denied = Object.assign(new Error("original denied"), { code: "EPERM" });
  for (const failure of [mismatch, denied]) {
    const receipt = Object.freeze({ ...original });
    let calls = 0;
    const shutdown = createShutdownSignals({ signalGroup: () => { calls++; throw failure; } });
    shutdown.signalAll([receipt]); shutdown.signalAll([receipt]);
    assert.equal(calls, 1);
    assert.equal(shutdown.failures()[0].error, failure);
    assert.equal(shutdown.failures()[0].record, receipt);
  }
  let kills = 0;
  const receipt = Object.freeze({ ...original });
  const guarded = createShutdownSignals({ signalGroup: record => signalOwnedGroup(record, "SIGTERM", {
    inspect: () => ({ ...original, startId: "foreign-creation" }), kill: () => { kills++; }
  }) });
  guarded.signalAll([receipt]); guarded.signalAll([receipt]);
  assert.equal(kills, 0);
  assert.match(guarded.failures()[0].error.message, /identity changed/);
});

test("an absent leader still requires group disappearance and a new receipt is not cached", () => {
  let calls = 0;
  const receipt = Object.freeze({ ...original });
  const shutdown = createShutdownSignals({ signalGroup: () => { calls++; return false; } });
  shutdown.signalAll([receipt]); shutdown.signalAll([receipt]);
  assert.equal(calls, 1);
  assert.throws(() => assertGroupsGone([receipt], { kill: () => {} }), /remains/);
  shutdown.signalAll([Object.freeze({ ...receipt, startId: "different-launch" })]);
  assert.equal(calls, 2);
});

test("a reentrant shutdown callback cannot repeat the same in-flight signal", () => {
  const receipt = Object.freeze({ ...original });
  let calls = 0, shutdown;
  shutdown = createShutdownSignals({ signalGroup: () => { calls++; shutdown.signalAll([receipt]); return true; } });
  shutdown.signalAll([receipt]); assert.equal(calls, 1); assert.deepEqual(shutdown.failures(), []);
});

function virtualGroupWait() {
  let now = 0;
  const sleeps = [];
  return { sleeps, clock: () => now, pause: async milliseconds => { sleeps.push(milliseconds); now += milliseconds; } };
}

test("EPERM is retried only until a fresh full pass observes ESRCH for every group", async () => {
  const second = { ...original, pid: 23002, pgid: 23002 };
  const timing = virtualGroupWait(), observations = [];
  let passes = 0;
  await waitGroupsGone([original, second], { ...timing,
    assertGone: records => {
      passes++;
      assertGroupsGone(records, { kill: (pgid, signal) => {
        observations.push([passes, pgid, signal]);
        if (passes === 1 && pgid === -second.pgid) throw Object.assign(new Error("probe denied"), { code: "EPERM" });
        throw Object.assign(new Error("absent"), { code: "ESRCH" });
      } });
    }
  });
  assert.equal(passes, 2);
  assert.deepEqual(timing.sleeps, [250]);
  assert.deepEqual(observations, [[1, -23001, 0], [1, -23002, 0], [2, -23001, 0], [2, -23002, 0]]);
});

test("persistent EPERM retains the original error at the same ten-second deadline", async () => {
  const timing = virtualGroupWait();
  const denied = Object.assign(new Error("original denied probe"), { code: "EPERM" });
  const laterDenied = Object.assign(new Error("later denied probe"), { code: "EPERM" });
  let probes = 0;
  await assert.rejects(waitGroupsGone([original], { ...timing,
    assertGone: () => { probes++; throw probes === 1 ? denied : laterDenied; } }), error => error === denied);
  assert.equal(timing.clock(), 10_000);
  assert.equal(timing.sleeps.length, 40);
  assert.equal(probes, 40);
});

test("an earlier permission error does not replace a terminal observed-remaining timeout", async () => {
  const timing = virtualGroupWait();
  const denied = Object.assign(new Error("first denied probe"), { code: "EPERM" });
  let probes = 0;
  await assert.rejects(waitGroupsGone([original], { ...timing, timeoutMs: 500,
    assertGone: records => {
      if (++probes === 1) throw denied;
      assertGroupsGone(records, { kill: () => {} });
    } }), error => error !== denied && error.message === "Timed out waiting for child shutdown.");
  assert.equal(timing.clock(), 500);
  assert.equal(probes, 2);
});

test("a failed signal still observes every group and forbids subsequent cleanup despite ESRCH", async () => {
  const records = [Object.freeze({ ...original }), Object.freeze({ ...original, pid: 23002, pgid: 23002 })];
  const firstSignalError = new Error("original guarded signal failure");
  const shutdown = createShutdownSignals({ signalGroup: record => { if (record === records[0]) throw firstSignalError; } });
  shutdown.signalAll(records);
  const observed = [];
  let cleanupStarted = false;
  await assert.rejects((async () => {
    await verifyShutdownGroups(records, shutdown, { assertGone: values => assertGroupsGone(values, {
      kill: (pgid, signal) => {
        observed.push([pgid, signal]);
        throw Object.assign(new Error("absent"), { code: "ESRCH" });
      }
    }) });
    cleanupStarted = true;
  })(), error => error instanceof AggregateError && error.errors.length === 1 && error.errors[0] === firstSignalError);
  assert.deepEqual(observed, [[-23001, 0], [-23002, 0]]);
  assert.equal(cleanupStarted, false);
});

test("failed signalling and terminal group permission retain both original errors", async () => {
  const timing = virtualGroupWait();
  const signalError = new Error("original signal failure");
  const firstDenied = Object.assign(new Error("first group probe denied"), { code: "EPERM" });
  const laterDenied = Object.assign(new Error("later group probe denied"), { code: "EPERM" });
  const shutdown = createShutdownSignals({ signalGroup: () => { throw signalError; } });
  shutdown.signalAll([original]);
  let probes = 0;
  await assert.rejects(verifyShutdownGroups([original], shutdown, { ...timing, timeoutMs: 500,
    assertGone: () => { throw ++probes === 1 ? firstDenied : laterDenied; } }), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [signalError, firstDenied]);
    return true;
  });
  assert.equal(probes, 2);
  assert.equal(timing.clock(), 500);
});

test("a lone group error or cancellation keeps its exact identity and code", async () => {
  const shutdown = createShutdownSignals({ signalGroup: () => {} });
  shutdown.signalAll([original]);
  const groupError = Object.assign(new Error("original group observation failure"), { code: "EIO" });
  await assert.rejects(verifyShutdownGroups([original], shutdown, {
    assertGone: () => { throw groupError; }
  }), error => error === groupError && error.code === "EIO");
  const controller = new AbortController();
  const cancellation = Object.assign(new Error("original lifecycle interruption"), { code: "DEV_STACK_OPERATION_CANCELLED" });
  controller.abort(cancellation);
  await assert.rejects(verifyShutdownGroups([original], shutdown, {
    signal: controller.signal, assertGone: () => assert.fail("cancelled verification must not probe")
  }), error => error === cancellation && error.code === "DEV_STACK_OPERATION_CANCELLED");
});

test("persistent groups still time out, sleep is clamped, and unknown probe failures propagate", async () => {
  const timing = virtualGroupWait();
  await assert.rejects(waitGroupsGone([original], { ...timing, timeoutMs: 510,
    assertGone: records => assertGroupsGone(records, { kill: () => {} }) }), /Timed out waiting for child shutdown/);
  assert.deepEqual(timing.sleeps, [250, 250, 10]);
  for (const failure of [Object.assign(new Error("unknown"), { code: "EIO" }), new Error("Invalid managed process group.")]) {
    const immediate = virtualGroupWait();
    await assert.rejects(waitGroupsGone([original], { ...immediate, assertGone: () => { throw failure; } }), error => error === failure);
    assert.deepEqual(immediate.sleeps, []);
  }
  await assert.rejects(waitGroupsGone([original], { timeoutMs: 10_001 }), /Invalid owned group wait/);
});

test("group wait observes cancellation without probing or turning it into absence", async () => {
  const controller = new AbortController(), interruption = new Error("owned fixture interruption");
  controller.abort(interruption);
  await assert.rejects(waitGroupsGone([original], { signal: controller.signal,
    assertGone: () => assert.fail("no probe after cancellation") }), error => error === interruption);
});
