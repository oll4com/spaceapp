import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, sep } from "node:path";
import { performance } from "node:perf_hooks";

const digest = value => createHash("sha256").update(value).digest("hex");

const identityFailures = new WeakMap();
const observationContexts = new Set(["UNSPECIFIED", "SUPERVISOR_SIGNAL", "SUPERVISOR_SHUTDOWN_WAIT"]);

/** Same failed input, fixed scalar structure only; never retain a PID or ps text. */
function darwinIdentityFailure(pid, output, stage, context, match = null) {
  const error = new Error("Cannot establish process creation identity.");
  const bounded = typeof output === "string" && output.length <= 65_536;
  const row = bounded ? output.trim() : null;
  const group = match ? Number(match[2]) : null;
  identityFailures.set(error, Object.freeze({
    schema: "spaceapp.dev-stack-process-observation-failure.v1",
    context: observationContexts.has(context) ? context : "UNSPECIFIED",
    stage,
    pidValid: Number.isSafeInteger(pid) && pid > 1,
    outputKind: typeof output === "string" ? "STRING" : (output === null ? "NULL" : "OTHER"),
    codeUnits: typeof output === "string" ? Math.min(output.length, 65_537) : null,
    trimmedLineClass: row === null ? "UNOBSERVED" : (row === "" ? "EMPTY" : (/[\r\n]/u.test(row) ? "MULTIPLE" : "ONE")),
    rowMatched: stage === "ROW" ? match !== null : null,
    leadingColumnsShape: row === null ? null : /^[A-Za-z][A-Za-z<>+\-]*\s+[1-9][0-9]*\s+/u.test(row),
    groupFieldClass: match === null ? "UNOBSERVED" : (Number.isSafeInteger(group) && group > 1 ? "SAFE_PRIVATE_GROUP" : "NOT_SAFE_PRIVATE_GROUP"),
    stateMarkerClass: match === null ? "UNOBSERVED" : (match[1].startsWith("Z") ? "Z_PREFIX" : "NON_Z_PREFIX"),
    birthWidth24: match === null ? null : true,
    commandPresent: match === null ? null : true,
  }));
  return error;
}

/** No property/cause/aggregate traversal and no global mutable last observation. */
export function processIdentityFailureDiagnostic(error) {
  return identityFailures.get(error) ?? null;
}

/** Parse lsof's explicit p/f/n fields; NUL protects spaces and newlines. */
export function parseCwdRecords(output, stateDir) {
  if (typeof output !== "string" || !isAbsolute(stateDir) || output.length > 8 * 1024 * 1024) {
    throw new Error("Invalid cwd observation.");
  }
  let pid;
  let cwdDescriptor = false;
  const found = new Set();
  for (const raw of output.split("\0")) {
    const field = raw.replace(/^\n/u, ""); // lsof's process/file-set separator.
    if (!field || field === "\n") continue;
    if (field.startsWith("p")) {
      if (!/^p[1-9][0-9]*$/u.test(field)) throw new Error("Invalid cwd process field.");
      pid = Number(field.slice(1));
      if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid cwd PID.");
      cwdDescriptor = false;
    } else if (field === "fcwd") {
      if (!pid) throw new Error("Unbound cwd descriptor.");
      cwdDescriptor = true;
    } else if (field.startsWith("n")) {
      if (!pid || !cwdDescriptor) throw new Error("Unbound cwd file field.");
      const cwd = field.slice(1);
      if (cwd === stateDir || cwd.startsWith(`${stateDir}${sep}`)) found.add(pid);
    } else throw new Error("Unexpected cwd observation field.");
  }
  return [...found];
}

/** Darwin has no /proc: inspect own-user cwd descriptors without a tree scan. */
export function darwinStateCwdProcesses(stateDir, { execute = spawnSync, uid = process.getuid?.() } = {}) {
  if (!Number.isSafeInteger(uid) || uid < 0 || !isAbsolute(stateDir)) throw new Error("Invalid cwd scan identity.");
  let observed;
  try {
    // Explicit f handles old lsof releases that always emitted it and new ones
    // that omit it unless selected. Reject even successful partial-error output.
    observed = execute("lsof", ["-nP", "-a", "-u", String(uid), "-d", "cwd", "-F0pfn"], {
      encoding: "utf8", timeout: 15_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"]
    });
  } catch {
    throw new Error("Darwin cwd observation failed; cleanup is not certified.");
  }
  if (observed?.error || observed?.stderr?.length || ![0, 1].includes(observed?.status)
    || typeof observed?.stdout !== "string" || (observed.status === 1 && observed.stdout.length)) {
    throw new Error("Darwin cwd observation failed; cleanup is not certified.");
  }
  return parseCwdRecords(observed.stdout, stateDir);
}

/** A zombie has no live identity; its displayed command can already be <defunct>. */
export function parseDarwinProcessIdentity(pid, output, observationContext = "UNSPECIFIED") {
  if (!Number.isSafeInteger(pid) || pid <= 1 || typeof output !== "string" || output.length > 65_536) {
    throw darwinIdentityFailure(pid, output, "INPUT", observationContext);
  }
  const match = /^([A-Za-z][A-Za-z<>+\-]*)\s+([1-9][0-9]*)\s+(.{24})\s+([^\r\n]+)$/u.exec(output.trim());
  const pgid = match ? Number(match[2]) : NaN;
  if (!match || !Number.isSafeInteger(pgid) || pgid <= 1) {
    throw darwinIdentityFailure(pid, output, "ROW", observationContext, match);
  }
  if (match[1].startsWith("Z")) return null;
  return { pid, pgid, startId: `${match[3]}:${digest(match[4])}` };
}

/** Local process ownership, not authorization against a hostile same-user writer. */
export function processIdentity(pid, observationContext = "UNSPECIFIED") {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid managed process PID.");
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      if (fields[0] === "Z") return null;
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return { pid, pgid: Number(fields[2]), startId: `${boot}:${fields[19]}` };
    }
    if (process.platform === "darwin") {
      const output = execFileSync("ps", ["-p", String(pid), "-o", "stat=", "-o", "pgid=", "-o", "lstart=", "-o", "command="], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 3000
      });
      return parseDarwinProcessIdentity(pid, output, observationContext);
    }
    throw new Error("The dev stack uses Unix process groups; run Windows inside WSL2.");
  } catch (error) {
    if (error.code === "ENOENT" || (process.platform === "darwin" && error.status === 1)) return null;
    throw error;
  }
}

export function sameProcess(record, observed) {
  return Boolean(record && observed && Number.isSafeInteger(record.pid) && record.pid > 1 &&
    record.pid === observed.pid && record.pgid === record.pid && observed.pgid === record.pgid &&
    typeof record.startId === "string" && record.startId.length > 0 && record.startId === observed.startId);
}

/** Supervisor shares its caller's group: signal only its positively identified PID. */
export function signalOwnedProcess(record, signal = "SIGTERM", { inspect = pid => processIdentity(pid, "SUPERVISOR_SIGNAL"), kill = process.kill } = {}) {
  if (!["SIGTERM", "SIGKILL"].includes(signal)) throw new Error("Unsupported teardown signal.");
  const current = inspect(record?.pid);
  if (!current) return false;
  if (!Number.isSafeInteger(record.pid) || record.pid <= 1 || record.pid !== current.pid ||
      record.pgid !== current.pgid || !record.startId || record.startId !== current.startId) {
    throw new Error("Supervisor creation identity changed; refusing to signal it.");
  }
  try { kill(record.pid, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
  return true;
}

/** Never signal a numeric PID/PGID based solely on a persisted PID file. */
export function signalOwnedGroup(record, signal = "SIGTERM", { inspect = processIdentity, kill = process.kill } = {}) {
  if (!["SIGTERM", "SIGKILL"].includes(signal)) throw new Error("Unsupported teardown signal.");
  const current = inspect(record?.pid);
  if (!current) return false;
  if (!sameProcess(record, current)) throw new Error("Managed process identity changed; refusing to signal it.");
  try { kill(-record.pgid, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
  return true;
}

/** A dead group leader does not prove its descendants are gone. Never hide remnants. */
export function assertGroupsGone(records, { kill = process.kill } = {}) {
  for (const record of records) {
    if (!Number.isSafeInteger(record?.pgid) || record.pgid <= 1 || record.pgid !== record.pid) {
      throw new Error("Invalid managed process group.");
    }
    try { kill(-record.pgid, 0); }
    catch (error) { if (error.code === "ESRCH") continue; throw error; }
    throw new Error("Managed process group remains; cleanup is incomplete.");
  }
}

/** One action per immutable launch receipt; a delivered signal is never exit proof. */
export function createShutdownSignals({ signalGroup = signalOwnedGroup } = {}) {
  const attempts = new Map();
  return {
    signalAll(records) {
      for (const record of records) {
        if (attempts.has(record)) continue;
        const attempt = { record };
        attempts.set(record, attempt); // Mark before the call, including a reentrant signal callback.
        try { attempt.result = signalGroup(record); }
        catch (error) { attempt.error = error; }
      }
    },
    failures() { return [...attempts.values()].filter(attempt => Object.hasOwn(attempt, "error")); },
  };
}

/** EPERM is an inconclusive probe, never absence. Recheck within the original deadline. */
export async function waitGroupsGone(records, { timeoutMs = 10_000, intervalMs = 250,
  label = "child shutdown", clock = () => performance.now(),
  pause = milliseconds => new Promise(done => setTimeout(done, milliseconds)),
  assertGone = assertGroupsGone, signal } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000
    || !Number.isFinite(intervalMs) || intervalMs <= 0
    || !["child shutdown", "owned child process groups to exit"].includes(label)) {
    throw new Error("Invalid owned group wait.");
  }
  const deadline = clock() + timeoutMs;
  let lastError, firstPermissionError;
  while (true) {
    signal?.throwIfAborted();
    if (lastError && clock() >= deadline) {
      if (lastError.code === "EPERM") throw firstPermissionError;
      throw new Error(`Timed out waiting for ${label}.`);
    }
    try { assertGone(records); return; }
    catch (error) {
      if (error?.code !== "EPERM" && error?.message !== "Managed process group remains; cleanup is incomplete.") throw error;
      if (error.code === "EPERM") firstPermissionError ??= error;
      lastError = error;
    }
    const remaining = deadline - clock();
    if (!Number.isFinite(remaining)) throw new Error("Invalid owned group wait clock.");
    if (remaining <= 0) {
      if (lastError.code === "EPERM") throw firstPermissionError;
      throw new Error(`Timed out waiting for ${label}.`);
    }
    await pause(Math.min(intervalMs, remaining));
  }
}

/** A failed signal never skips the independent all-groups observation or permits state cleanup. */
export async function verifyShutdownGroups(records, shutdown, options = {}) {
  const failures = shutdown.failures().map(failure => failure.error);
  try { await waitGroupsGone(records, options); }
  catch (error) {
    if (!failures.length) throw error; // Keep a lone group/cancellation failure's identity and code.
    failures.push(error);
  }
  if (failures.length) {
    throw new AggregateError(failures, "Owned child shutdown failed; runtime ownership retained.");
  }
}
