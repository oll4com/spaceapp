import test from "node:test";
import assert from "node:assert/strict";
import { waitUntil, assertComposeMatches, runObservedStep } from "../dev-stack.mjs";
import { composeConfig } from "../dev-stack-config.mjs";
import { resolve, join } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

for (const [script, stage] of [["scripts/fix-build-permissions.mjs", "root-build"],
  ["apps/web/scripts/fix-dist-permissions.mjs", "web-dist"]]) {
  test(`permission-stage progress observes only a copied synthetic ${stage} tree`, {
    skip: process.platform === "win32" && stage === "root-build"
      ? "The unchanged original root normalizer uses POSIX URL pathname resolution; execute in Linux/macOS CI."
      : false,
  }, () => {
    const fixture = mkdtempSync(join(tmpdir(), "dev-stack-progress-"));
    try {
      const copied = join(fixture, script), asset = join(fixture, "apps/web/dist/nested/synthetic.txt");
      mkdirSync(resolve(copied, ".."), { recursive: true });
      mkdirSync(resolve(asset, ".."), { recursive: true });
      writeFileSync(copied, readFileSync(new URL(`../../${script}`, import.meta.url)));
      writeFileSync(asset, "synthetic-bytes-must-remain-identical");
      const stdout = execFileSync(process.execPath, [copied], { cwd: fixture, encoding: "utf8", timeout: 10_000, maxBuffer: 65536 });
      const records = stdout.trim().split("\n").map(line => JSON.parse(line));
      assert.equal(records.length, 2);
      assert.deepEqual(records[0], { schema: "spaceapp.build-permissions-step.v1", stage, event: "START" });
      assert.equal(records[1].schema, records[0].schema);
      assert.equal(records[1].stage, stage);
      assert.equal(records[1].event, "DONE");
      assert.equal(records[1].fileAttempts, 1);
      assert.ok(records[1].directoryAttempts >= 2);
      assert.ok(Number.isSafeInteger(records[1].elapsedMs) && records[1].elapsedMs >= 0);
      assert.equal(stdout.includes(fixture), false);
      assert.equal(readFileSync(asset, "utf8"), "synthetic-bytes-must-remain-identical");
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
}

test("bounded readiness wait checks the predicate rather than trusting elapsed wall-clock labels", async () => {
  let checked = 0;
  await waitUntil(() => ++checked === 3, { timeoutMs: 1000, intervalMs: 1, label: "synthetic predicate" });
  assert.equal(checked, 3);
});

test("negative readiness is a failure, not a successful timeout", async () => {
  await assert.rejects(waitUntil(() => false, { timeoutMs: 5, intervalMs: 1, label: "missing worker" }), /Timed out waiting for missing worker/);
});

test("predicate failures propagate rather than being counted as readiness", async () => {
  await assert.rejects(waitUntil(() => { throw new Error("worker exited"); }), /worker exited/);
});

test("source-step observations retain the result and record monotonic duration with fixed labels", async () => {
  const events = [], times = [100, 112.6], result = { synthetic: true };
  assert.equal(await runObservedStep("build source and workspace packages", async () => result,
    { clock: () => times.shift(), emit: value => events.push(value) }), result);
  assert.deepEqual(events, [
    { schema: "spaceapp.dev-stack-step.v1", step: "build source and workspace packages", event: "START", elapsedMs: 0 },
    { schema: "spaceapp.dev-stack-step.v1", step: "build source and workspace packages", event: "END", elapsedMs: 13 },
  ]);
});

test("source-step failure preserves the original error without serializing its private message", async () => {
  const events = [], times = [50, 55], failure = new Error("synthetic-private-environment-value");
  await assert.rejects(runObservedStep("database migrations", async () => { throw failure; },
    { clock: () => times.shift(), emit: value => events.push(value) }), error => error === failure);
  assert.equal(events.length, 2);
  assert.deepEqual(events[1], { schema: "spaceapp.dev-stack-step.v1", step: "database migrations", event: "FAIL", elapsedMs: 5 });
  assert.equal(JSON.stringify(events).includes(failure.message), false);
});

test("source-step observation rejects arbitrary labels before executing work", async () => {
  let called = false;
  await assert.rejects(runObservedStep("unexpected-private-command", async () => { called = true; }), /Invalid source-step/);
  assert.equal(called, false);
});

test("cleanup-stage diagnostics are additive and retain the original aggregate failure", () => {
  const source = readFileSync(new URL("../dev-stack.mjs", import.meta.url), "utf8");
  assert.match(source, /cleanupErrors\.push\(error\); \/\/ Preserve the original failure/);
  assert.ok(source.includes('recordCleanupFailure("SIGNAL_CHILD_GROUP", failure.error'));
  for (const stage of ["WAIT_CHILD_GROUPS", "DOCKER_SHUTDOWN"]) {
    assert.ok(source.includes(`recordCleanupFailure("${stage}", error`));
  }
  assert.match(source, /throw new AggregateError\(cleanupErrors,/);
  assert.match(source, /timeoutMs: 10_000, label: "child shutdown"/);
  assert.match(source, /cleanupFailureRecord\(\{ stage, error,/);
});

test("CLI identity refusal emits only its local safe record while keeping the fixed error and exit", () => {
  const source = readFileSync(new URL("../dev-stack.mjs", import.meta.url), "utf8");
  const processSource = readFileSync(new URL("../dev-stack-process.mjs", import.meta.url), "utf8");
  assert.ok(source.includes('processIdentity(runtime.supervisor.pid, "SUPERVISOR_SHUTDOWN_WAIT")'));
  assert.ok(processSource.includes('inspect = pid => processIdentity(pid, "SUPERVISOR_SIGNAL")'));
  const entry = source.slice(source.indexOf("  main().catch(error => {"));
  const getter = entry.indexOf("processIdentityFailureDiagnostic(error)");
  const diagnostic = entry.indexOf("if (diagnostic) console.error(JSON.stringify(diagnostic));");
  const originalMessage = entry.indexOf("console.error(`dev-stack failed: ${error.message}`);");
  assert.ok(getter >= 0 && diagnostic > getter && originalMessage > diagnostic);
  assert.ok(entry.includes("process.exitCode = 1;"));
  assert.ok(!entry.includes("error.cause") && !entry.includes("error.diagnostic"));
});

test("source shutdown shares one signal coordinator, strict group wait and scoped up handoff", () => {
  const source = readFileSync(new URL("../dev-stack.mjs", import.meta.url), "utf8");
  assert.match(source, /const shutdown = createShutdownSignals\(\)/);
  assert.equal((source.match(/shutdown\.signalAll\(receipts\)/gu) ?? []).length, 2);
  assert.match(source, /Object\.freeze\(\{ name, \.\.\.record \}\)/);
  assert.match(source, /await waitGroupsGone\(receipts, \{ timeoutMs: 10_000, label: "child shutdown" \}\)/);
  const stopping = source.slice(source.indexOf("async function stopState"), source.indexOf("async function up"));
  const signalChildren = stopping.indexOf("shutdown.signalAll(runtime.children);");
  const verifyChildren = stopping.indexOf("await verifyShutdownGroups(runtime.children, shutdown,");
  assert.ok(signalChildren >= 0 && verifyChildren > signalChildren);
  assert.ok(!stopping.slice(signalChildren, verifyChildren).includes("throw"));
  assert.ok(verifyChildren < stopping.indexOf("dockerOutput(state,"));
  assert.match(stopping, /verifyShutdownGroups\(runtime\.children, shutdown, \{ timeoutMs: 10_000, label: "owned child process groups to exit", signal \}\)/);
  assert.match(source, /withLifecycleAdmission\(repoRoot,/);
  const ownHandlers = source.indexOf('process.once("SIGINT", stop)');
  const handoff = source.indexOf("handoffSignals();");
  assert.ok(ownHandlers >= 0 && handoff > ownHandlers);
  assert.ok(handoff < source.indexOf("privateWrite(location.compose"));
  assert.match(source, /await stopState\(state, false, \{ signal \}\);\s+checkCancelled\(\);\s+return await up\(state, releaseAdmission, handoffToUp\)/);
  const finalization = source.slice(source.indexOf("assertDockerGone(state, reset);"), source.indexOf("if (reset) removeState"));
  assert.ok(!finalization.includes("throwIfAborted"));
});

test("CI observes old/current supervisor exits without accepting a signalled or unobserved exit", () => {
  const source = readFileSync(new URL("../dev-stack-ci.mjs", import.meta.url), "utf8");
  assert.match(source, /supervisorExitRecord\(old\.exit\), event: "REBUILD_OLD_EXIT", observed: true/);
  assert.match(source, /if \(old\.exit\.code !== 0\) throw new Error/);
  assert.match(source, /supervisorExitRecord\(supervisor\.exit\)/);
  assert.match(source, /event: "FINAL_CURRENT_EXIT", observed: supervisor\.exit !== undefined/);
  assert.match(source, /cleanupVerified: cleanupFailures\.length === 0/);
  assert.match(source, /resetAfterObservedExit\(supervisor\.exit, reset\)/);
});

test("cleanup rejects a compose swap naming a foreign volume, service or image", () => {
  const repoRoot = resolve("synthetic-repo");
  const state = { repoRoot, stateDir: join(repoRoot, ".dev-stack"), project: `space-dev-${"1".repeat(24)}`,
    ports: { api: 5910, web: 5911, postgres: 55432, temporal: 57233 } };
  const images = { postgres: `test/pg@sha256:${"a".repeat(64)}`, temporal: `test/temporal@sha256:${"b".repeat(64)}` };
  const expected = composeConfig(state, images);
  assert.doesNotThrow(() => assertComposeMatches(JSON.stringify(expected), state, images));
  for (const alter of [
    value => { value.volumes.postgres.name = "foreign-production-database"; },
    value => { value.services.foreign = { image: images.postgres }; },
    value => { value.services.postgres.image = `other/pg@sha256:${"c".repeat(64)}`; }
  ]) {
    const changed = structuredClone(expected); alter(changed);
    assert.throws(() => assertComposeMatches(JSON.stringify(changed), state, images), /differs/);
  }
  assert.throws(() => assertComposeMatches("not JSON", state, images), /valid JSON/);
});
