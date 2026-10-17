import assert from "node:assert/strict";
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { acquireLifecycleLock, releaseLifecycleLock, withLifecycleAdmission,
  resetAfterObservedExit } from "../dev-stack-lifecycle.mjs";
import { waitGroupsGone } from "../dev-stack-process.mjs";

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "space-lifecycle-"));
  const repo = join(base, "checkout");
  mkdirSync(repo);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, repo };
}

function linkOrSkip(t, target, path, directory = false) {
  try { symlinkSync(target, path, directory ? (process.platform === "win32" ? "junction" : "dir") : "file"); }
  catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip("Host does not permit the symlink fixture.");
      return false;
    }
    throw error;
  }
  return true;
}

test("acquires and releases one fixed canonical-root lease outside resettable state", (t) => {
  const { repo } = fixture(t);
  const lease = acquireLifecycleLock(repo);
  assert.equal(lease.repoRoot, realpathSync(repo));
  assert.equal(lease.path, join(realpathSync(repo), ".dev-stack-control.lock"));
  assert.equal(lease.ownerPath, join(lease.path, "owner.json"));
  assert.match(lease.token, /^[a-f0-9]{64}$/u);
  const owner = JSON.parse(readFileSync(lease.ownerPath, "utf8"));
  assert.deepEqual(owner, { schema: lease.schema, repoRoot: lease.repoRoot, token: lease.token });
  assert.deepEqual(releaseLifecycleLock(lease), { released: true, repoRoot: lease.repoRoot, path: lease.path });
  assert.equal(existsSync(lease.path), false);
});

test("exclusive acquisition cannot adopt even a valid lock and does not change its token", (t) => {
  const { repo } = fixture(t);
  const first = acquireLifecycleLock(repo);
  const before = readFileSync(first.ownerPath);
  assert.throws(() => acquireLifecycleLock(repo), { code: "DEV_STACK_LIFECYCLE_LOCKED" });
  assert.deepEqual(readFileSync(first.ownerPath), before);
  releaseLifecycleLock(first);
  const next = acquireLifecycleLock(repo);
  assert.notEqual(next.token, first.token);
  releaseLifecycleLock(next);
});

test("deleting .dev-stack cannot release the separate lifecycle lock", (t) => {
  const { repo } = fixture(t);
  const lease = acquireLifecycleLock(repo);
  const state = join(repo, ".dev-stack");
  mkdirSync(state);
  writeFileSync(join(state, "owned.txt"), "fixture");
  rmSync(state, { recursive: true });
  assert.throws(() => acquireLifecycleLock(repo), { code: "DEV_STACK_LIFECYCLE_LOCKED" });
  assert.equal(existsSync(lease.ownerPath), true);
  releaseLifecycleLock(lease);
});

test("empty or apparently stale unknown locks are never automatically recovered", (t) => {
  const { repo } = fixture(t);
  const lock = join(repo, ".dev-stack-control.lock");
  mkdirSync(lock, { mode: 0o700 });
  assert.throws(() => acquireLifecycleLock(repo), { code: "DEV_STACK_LIFECYCLE_LOCKED" });
  const owner = join(lock, "owner.json");
  writeFileSync(owner, '{"pid":99999999,"createdAt":"1970-01-01"}', { mode: 0o600 });
  assert.throws(() => acquireLifecycleLock(repo), { code: "DEV_STACK_LIFECYCLE_LOCKED" });
  assert.equal(readFileSync(owner, "utf8"), '{"pid":99999999,"createdAt":"1970-01-01"}');
});

test("an existing ordinary file at the lock path is left untouched", (t) => {
  const { repo } = fixture(t);
  const path = join(repo, ".dev-stack-control.lock");
  writeFileSync(path, "unrelated user file");
  assert.throws(() => acquireLifecycleLock(repo), { code: "DEV_STACK_LIFECYCLE_LOCKED" });
  assert.equal(readFileSync(path, "utf8"), "unrelated user file");
});

test("a mismatched lease token cannot release the actual owner", (t) => {
  const { repo } = fixture(t);
  const lease = acquireLifecycleLock(repo);
  const altered = { ...lease, token: "0".repeat(64) === lease.token ? "1".repeat(64) : "0".repeat(64) };
  assert.throws(() => releaseLifecycleLock(altered), { code: "DEV_STACK_LIFECYCLE_FOREIGN" });
  assert.equal(existsSync(lease.ownerPath), true);
  releaseLifecycleLock(lease);
});

test("a replaced persisted token or foreign root refuses release without deleting anything", (t) => {
  const { base, repo } = fixture(t);
  const lease = acquireLifecycleLock(repo);
  const other = join(base, "other");
  mkdirSync(other);
  const owner = JSON.parse(readFileSync(lease.ownerPath, "utf8"));
  for (const changed of [{ ...owner, token: "f".repeat(64) === owner.token ? "e".repeat(64) : "f".repeat(64) },
    { ...owner, repoRoot: realpathSync(other) }]) {
    writeFileSync(lease.ownerPath, JSON.stringify(changed));
    assert.throws(() => releaseLifecycleLock(lease), { code: "DEV_STACK_LIFECYCLE_FOREIGN" });
    assert.equal(existsSync(lease.ownerPath), true);
  }
});

test("foreign checkout paths cannot be substituted into an acquired lease", (t) => {
  const { base, repo } = fixture(t);
  const lease = acquireLifecycleLock(repo);
  const other = join(base, "other");
  mkdirSync(other);
  assert.throws(() => releaseLifecycleLock({ ...lease, repoRoot: realpathSync(other) }), {
    code: "DEV_STACK_LIFECYCLE_FOREIGN",
  });
  assert.equal(existsSync(lease.ownerPath), true);
  releaseLifecycleLock(lease);
});

test("a missing owner file or missing lock is not a successful release", (t) => {
  const { repo } = fixture(t);
  const lease = acquireLifecycleLock(repo);
  unlinkSync(lease.ownerPath);
  assert.throws(() => releaseLifecycleLock(lease), { code: "DEV_STACK_LIFECYCLE_MISSING" });
  assert.equal(existsSync(lease.path), true);
  rmSync(lease.path, { recursive: true });
  assert.throws(() => releaseLifecycleLock(lease), { code: "DEV_STACK_LIFECYCLE_MISSING" });
});

test("an owner file replaced with identical bytes is not the original lease file", (t) => {
  const { base, repo } = fixture(t);
  const lease = acquireLifecycleLock(repo);
  const raw = readFileSync(lease.ownerPath);
  renameSync(lease.ownerPath, join(base, "retained-owner.json"));
  writeFileSync(lease.ownerPath, raw, { mode: 0o600 });
  assert.throws(() => releaseLifecycleLock(lease), { code: "DEV_STACK_LIFECYCLE_CHANGED" });
  assert.deepEqual(readFileSync(lease.ownerPath), raw);
});

test("a replacement directory with the same token cannot be released by an old lease", (t) => {
  const { base, repo } = fixture(t);
  const lease = acquireLifecycleLock(repo);
  const raw = readFileSync(lease.ownerPath);
  renameSync(lease.path, join(base, "retained-lock"));
  mkdirSync(lease.path, { mode: 0o700 });
  writeFileSync(lease.ownerPath, raw, { mode: 0o600 });
  assert.throws(() => releaseLifecycleLock(lease), { code: "DEV_STACK_LIFECYCLE_CHANGED" });
  assert.deepEqual(readFileSync(lease.ownerPath), raw);
});

test("unexpected lock contents refuse release before unlinking the owner", (t) => {
  const { repo } = fixture(t);
  const lease = acquireLifecycleLock(repo);
  const sentinel = join(lease.path, "keep.txt");
  writeFileSync(sentinel, "keep");
  assert.throws(() => releaseLifecycleLock(lease), { code: "DEV_STACK_LIFECYCLE_UNSAFE" });
  assert.equal(existsSync(lease.ownerPath), true);
  assert.equal(readFileSync(sentinel, "utf8"), "keep");
});

test("malformed owner JSON refuses release without deleting the owner record", (t) => {
  const { repo } = fixture(t);
  const lease = acquireLifecycleLock(repo);
  writeFileSync(lease.ownerPath, "malformed");
  assert.throws(() => releaseLifecycleLock(lease), { code: "DEV_STACK_LIFECYCLE_OWNER" });
  assert.equal(readFileSync(lease.ownerPath, "utf8"), "malformed");
});

test("hard-linked owner records cannot be released", (t) => {
  const { base, repo } = fixture(t);
  const lease = acquireLifecycleLock(repo);
  const outside = join(base, "linked-owner.json");
  linkSync(lease.ownerPath, outside);
  assert.throws(() => releaseLifecycleLock(lease), { code: "DEV_STACK_LIFECYCLE_UNSAFE" });
  assert.equal(existsSync(lease.ownerPath), true);
  assert.equal(existsSync(outside), true);
});

test("symlink owner record is neither followed nor deleted", (t) => {
  const { base, repo } = fixture(t);
  const lease = acquireLifecycleLock(repo);
  const outside = join(base, "actual-owner.json");
  renameSync(lease.ownerPath, outside);
  if (!linkOrSkip(t, outside, lease.ownerPath)) return;
  assert.throws(() => releaseLifecycleLock(lease), { code: "DEV_STACK_LIFECYCLE_UNSAFE" });
  assert.equal(lstatSync(lease.ownerPath).isSymbolicLink(), true);
  assert.equal(existsSync(outside), true);
});

test("symlink lock directory is not followed, adopted or released", (t) => {
  const { base, repo } = fixture(t);
  const lease = acquireLifecycleLock(repo);
  const outside = join(base, "actual-lock");
  renameSync(lease.path, outside);
  if (!linkOrSkip(t, outside, lease.path, true)) return;
  assert.throws(() => acquireLifecycleLock(repo), { code: "DEV_STACK_LIFECYCLE_LOCKED" });
  assert.throws(() => releaseLifecycleLock(lease), { code: "DEV_STACK_LIFECYCLE_UNSAFE" });
  assert.equal(existsSync(join(outside, "owner.json")), true);
});

test("a canonical checkout alias resolves to the same exclusive lock", (t) => {
  const { base, repo } = fixture(t);
  const alias = join(base, "checkout-alias");
  if (!linkOrSkip(t, repo, alias, true)) return;
  const lease = acquireLifecycleLock(alias);
  assert.equal(lease.repoRoot, realpathSync(repo));
  assert.throws(() => acquireLifecycleLock(repo), { code: "DEV_STACK_LIFECYCLE_LOCKED" });
  releaseLifecycleLock(lease);
});

test("invalid lease objects cannot select arbitrary removal paths", (t) => {
  const { repo } = fixture(t);
  const lease = acquireLifecycleLock(repo);
  for (const invalid of [null, {}, { ...lease, token: "short" }, { ...lease, extra: true }]) {
    assert.throws(() => releaseLifecycleLock(invalid), { code: "DEV_STACK_LIFECYCLE_LEASE" });
    assert.equal(existsSync(lease.ownerPath), true);
  }
  assert.throws(() => releaseLifecycleLock({ ...lease, path: repo }), { code: "DEV_STACK_LIFECYCLE_FOREIGN" });
  releaseLifecycleLock(lease);
  assert.throws(() => releaseLifecycleLock(lease), { code: "DEV_STACK_LIFECYCLE_MISSING" });
});

test("private POSIX permissions are generated and required before release", {
  skip: process.platform === "win32" ? "POSIX mode checks are not Windows ACL enforcement." : false,
}, (t) => {
  const { repo } = fixture(t);
  const lease = acquireLifecycleLock(repo);
  assert.equal(lstatSync(lease.path).mode & 0o777, 0o700);
  assert.equal(lstatSync(lease.ownerPath).mode & 0o777, 0o600);
  chmodSync(lease.path, 0o755);
  assert.throws(() => releaseLifecycleLock(lease), { code: "DEV_STACK_LIFECYCLE_PERMISSIONS" });
  chmodSync(lease.path, 0o700);
  chmodSync(lease.ownerPath, 0o644);
  assert.throws(() => releaseLifecycleLock(lease), { code: "DEV_STACK_LIFECYCLE_PERMISSIONS" });
  assert.equal(existsSync(lease.ownerPath), true);
});

test("cancellation handler exists before acquisition and exact acquired lease is still released", async () => {
  const events = new EventEmitter(), lease = Object.freeze({ ownedFixture: true });
  let released = 0, externalSignals = 0;
  const external = () => { externalSignals++; };
  events.on("SIGTERM", external);
  await assert.rejects(withLifecycleAdmission("unused-injected-root", () => assert.fail("cancelled before work"), {
    events,
    acquire: () => {
      assert.equal(events.listenerCount("SIGTERM"), 2);
      assert.equal(events.listenerCount("SIGINT"), 1);
      events.emit("SIGTERM"); return lease;
    },
    release: actual => { assert.equal(actual, lease); released++; },
  }), { code: "DEV_STACK_OPERATION_CANCELLED" });
  assert.equal(released, 1); assert.equal(externalSignals, 1);
  assert.equal(events.listenerCount("SIGTERM"), 1); assert.equal(events.listenerCount("SIGINT"), 0);
  assert.equal(events.listeners("SIGTERM")[0], external);
});

test("pre-up cancellation releases only admission and preserves incomplete fixture runtime", async t => {
  const { repo } = fixture(t), events = new EventEmitter();
  const runtime = join(repo, ".dev-stack"); mkdirSync(runtime);
  const receipt = join(runtime, "runtime.json"), running = join(runtime, "running.lock");
  writeFileSync(receipt, "synthetic runtime preserved"); mkdirSync(running);
  let newUp = false;
  await assert.rejects(withLifecycleAdmission(repo, async ({ checkCancelled }) => {
    events.emit("SIGINT");
    await Promise.resolve(); checkCancelled(); newUp = true;
  }, { events }), { code: "DEV_STACK_OPERATION_CANCELLED" });
  assert.equal(newUp, false);
  assert.equal(existsSync(join(repo, ".dev-stack-control.lock")), false);
  assert.equal(readFileSync(receipt, "utf8"), "synthetic runtime preserved");
  assert.equal(existsSync(running), true);
  assert.equal(events.listenerCount("SIGINT"), 0);
});

test("cancellation during a group wait stops at its checkpoint and cannot certify disappearance", async t => {
  const { repo } = fixture(t), events = new EventEmitter();
  let now = 0, probes = 0;
  await assert.rejects(withLifecycleAdmission(repo, async ({ signal }) => {
    await waitGroupsGone([], { signal, clock: () => now,
      pause: async milliseconds => { now += milliseconds; events.emit("SIGTERM"); },
      assertGone: () => { probes++; throw new Error("Managed process group remains; cleanup is incomplete."); }
    });
    assert.fail("cancelled wait cannot return success");
  }, { events }), { code: "DEV_STACK_OPERATION_CANCELLED" });
  assert.equal(probes, 1); assert.equal(now, 250);
  assert.equal(existsSync(join(repo, ".dev-stack-control.lock")), false);
});

test("cancellation plus replaced lease retains both errors and never deletes the foreign owner", async t => {
  const { repo } = fixture(t), events = new EventEmitter();
  const lock = join(repo, ".dev-stack-control.lock"), ownerPath = join(lock, "owner.json");
  let retainedBytes;
  await assert.rejects(withLifecycleAdmission(repo, async ({ checkCancelled }) => {
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    owner.token = owner.token === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
    writeFileSync(ownerPath, JSON.stringify(owner)); retainedBytes = readFileSync(ownerPath);
    events.emit("SIGTERM"); checkCancelled();
  }, { events }), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.equal(error.errors[0].code, "DEV_STACK_OPERATION_CANCELLED");
    assert.equal(error.errors[1].code, "DEV_STACK_LIFECYCLE_FOREIGN");
    return true;
  });
  assert.equal(existsSync(lock), true);
  assert.deepEqual(readFileSync(ownerPath), retainedBytes);
});

test("primary and release errors retain identity; a failed release is never retried", async () => {
  const events = new EventEmitter(), primary = new Error("original operation failure"), releaseFailure = new Error("original release failure");
  let releases = 0;
  await assert.rejects(withLifecycleAdmission("injected", async () => { throw primary; }, {
    events, acquire: () => ({}), release: () => { releases++; throw releaseFailure; }
  }), error => error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === releaseFailure);
  assert.equal(releases, 1);
  releases = 0;
  await assert.rejects(withLifecycleAdmission("injected", async ({ releaseAdmission }) => releaseAdmission(), {
    events, acquire: () => ({}), release: () => { releases++; throw releaseFailure; }
  }), error => error === releaseFailure);
  assert.equal(releases, 1);
});

test("up handoff keeps coverage until its own handlers exist and normal shutdown is not cancellation", async () => {
  const events = new EventEmitter(); let stopped = 0, releases = 0;
  const upStop = () => { stopped++; };
  const result = await withLifecycleAdmission("injected", async ({ releaseAdmission, handoffToUp }) => {
    releaseAdmission();
    assert.equal(events.listenerCount("SIGTERM"), 1);
    events.once("SIGTERM", upStop); events.once("SIGINT", upStop);
    assert.equal(events.listenerCount("SIGTERM"), 2);
    handoffToUp();
    assert.equal(events.listenerCount("SIGTERM"), 1);
    events.emit("SIGTERM");
    events.off("SIGINT", upStop);
    return "up closed cleanly";
  }, { events, acquire: () => ({}), release: () => { releases++; } });
  assert.equal(result, "up closed cleanly"); assert.equal(stopped, 1); assert.equal(releases, 1);
  assert.equal(events.listenerCount("SIGTERM"), 0); assert.equal(events.listenerCount("SIGINT"), 0);
});

test("already cancelled up handoff cannot launch services or consume cancellation as success", async () => {
  const events = new EventEmitter(); let launched = false, upStopping = false;
  const upStop = () => { upStopping = true; };
  await assert.rejects(withLifecycleAdmission("injected", async ({ handoffToUp }) => {
    events.once("SIGTERM", upStop); events.once("SIGINT", upStop);
    try {
      events.emit("SIGTERM");
      assert.equal(events.listenerCount("SIGINT"), 2);
      assert.throws(handoffToUp, { code: "DEV_STACK_OPERATION_CANCELLED" });
      assert.equal(events.listenerCount("SIGINT"), 2);
      handoffToUp(); launched = true;
    } finally { events.off("SIGTERM", upStop); events.off("SIGINT", upStop); }
  }, { events, acquire: () => ({}), release: () => {} }), { code: "DEV_STACK_OPERATION_CANCELLED" });
  assert.equal(launched, false); assert.equal(upStopping, true);
  assert.equal(events.listenerCount("SIGTERM"), 0); assert.equal(events.listenerCount("SIGINT"), 0);
});

test("acquisition failure restores only scope-owned handlers and never fabricates a lease", async () => {
  const events = new EventEmitter(), failure = new Error("original lock refusal");
  let releases = 0;
  await assert.rejects(withLifecycleAdmission("injected", () => assert.fail(), {
    events, acquire: () => { throw failure; }, release: () => { releases++; }
  }), error => error === failure);
  assert.equal(releases, 0); assert.equal(events.listenerCount("SIGTERM"), 0); assert.equal(events.listenerCount("SIGINT"), 0);
});

test("CI reset is forbidden before an observed exit and does not make signalled exit clean", () => {
  for (const absent of [undefined, null, {}, { code: null, signal: null }]) {
    assert.throws(() => resetAfterObservedExit(absent, () => assert.fail("no concurrent reset")), { code: "DEV_STACK_SUPERVISOR_EXIT_UNOBSERVED" });
  }
  let resets = 0;
  for (const exit of [{ code: 0, signal: null }, { code: 1, signal: null }, { code: null, signal: "SIGTERM" }]) {
    assert.equal(resetAfterObservedExit(exit, () => ++resets), resets);
  }
  assert.equal(resets, 3);
});

test("operation cancellation remains covered through exact lease release and handlers are then removed", async () => {
  const events = new EventEmitter(); let releases = 0;
  await assert.rejects(withLifecycleAdmission("injected", async () => "completed work", {
    events, acquire: () => ({}), release: () => {
      assert.equal(events.listenerCount("SIGTERM"), 1);
      assert.equal(events.listenerCount("SIGINT"), 1);
      events.emit("SIGTERM"); releases++;
    }
  }), { code: "DEV_STACK_OPERATION_CANCELLED" });
  assert.equal(releases, 1); assert.equal(events.listenerCount("SIGTERM"), 0); assert.equal(events.listenerCount("SIGINT"), 0);
});
