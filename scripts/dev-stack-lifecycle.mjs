/**
 * A synchronous checkout-local lifecycle lease, outside resettable .dev-stack.
 * Existing or incomplete locks always require explicit operator investigation.
 * This coordinates cooperating local commands, not hostile filesystem writers.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync,
  readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";

const SCHEMA = "spaceapp.dev-stack-lifecycle.v1";
const LOCK_NAME = ".dev-stack-control.lock";
const OWNER_NAME = "owner.json";
const MAX_OWNER_BYTES = 4096;

function requireCondition(condition, code, message) {
  if (!condition) {
    const error = new Error(`${code}: ${message}`);
    error.code = code;
    throw error;
  }
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function pathsFor(repoRoot) {
  requireCondition(typeof repoRoot === "string" && repoRoot.length > 0,
    "DEV_STACK_LIFECYCLE_ROOT", "Expected a checkout directory.");
  const root = realpathSync(repoRoot);
  requireCondition(lstatSync(root).isDirectory(), "DEV_STACK_LIFECYCLE_ROOT",
    "The canonical checkout root must be a directory.");
  const path = join(root, LOCK_NAME);
  return { repoRoot: root, path, ownerPath: join(path, OWNER_NAME) };
}

function privateEntry(path, directory) {
  let info;
  try { info = lstatSync(path, { bigint: true }); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    requireCondition(false, "DEV_STACK_LIFECYCLE_MISSING",
      "The lease directory or owner file is missing; no automatic lock recovery.");
  }
  requireCondition(!info.isSymbolicLink() && (directory ? info.isDirectory() : info.isFile()),
    "DEV_STACK_LIFECYCLE_UNSAFE", "The lease directory and owner file must not be links or unexpected types.");
  requireCondition(directory || info.nlink === 1n, "DEV_STACK_LIFECYCLE_UNSAFE",
    "The owner file must not have additional hard links.");
  if (process.platform !== "win32") {
    requireCondition((info.mode & 0o777n) === (directory ? 0o700n : 0o600n),
      "DEV_STACK_LIFECYCLE_PERMISSIONS", "The lease requires a 0700 directory and 0600 owner file.");
    if (typeof process.getuid === "function") {
      requireCondition(info.uid === BigInt(process.getuid()), "DEV_STACK_LIFECYCLE_FOREIGN",
        "The lease must belong to the current user.");
    }
  }
  return info;
}

function identity(info) {
  return { dev: info.dev.toString(), ino: info.ino.toString() };
}

function matchesIdentity(expected, actual) {
  return exactKeys(expected, ["dev", "ino"])
    && expected.dev === actual.dev.toString() && expected.ino === actual.ino.toString();
}

function readOwner(path) {
  const before = privateEntry(path, false);
  requireCondition(before.size <= BigInt(MAX_OWNER_BYTES), "DEV_STACK_LIFECYCLE_OWNER",
    "The owner record is oversized.");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd, { bigint: true });
    requireCondition(matchesIdentity(identity(before), opened), "DEV_STACK_LIFECYCLE_CHANGED",
      "The owner file changed while being opened.");
    const buffer = Buffer.alloc(MAX_OWNER_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(fd, { bigint: true });
    requireCondition(length <= MAX_OWNER_BYTES && BigInt(length) === opened.size
      && after.size === opened.size && after.mtimeNs === opened.mtimeNs && after.ctimeNs === opened.ctimeNs,
    "DEV_STACK_LIFECYCLE_CHANGED", "The owner file changed while being read.");
    let owner;
    try { owner = JSON.parse(buffer.subarray(0, length).toString("utf8")); }
    catch { requireCondition(false, "DEV_STACK_LIFECYCLE_OWNER", "The owner record is not valid JSON."); }
    return { owner, info: opened };
  } finally { closeSync(fd); }
}

/** Exclusive acquisition; no timestamp, PID or apparent staleness permits reuse. */
export function acquireLifecycleLock(repoRoot) {
  const paths = pathsFor(repoRoot);
  try { mkdirSync(paths.path, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    requireCondition(false, "DEV_STACK_LIFECYCLE_LOCKED",
      "A lifecycle lock already exists. Do not remove or recover it automatically; inspect the owning operation.");
  }
  // An interrupted initialization intentionally remains an unrecovered lock.
  const directory = privateEntry(paths.path, true);
  const token = randomBytes(32).toString("hex");
  const owner = { schema: SCHEMA, repoRoot: paths.repoRoot, token };
  const fd = openSync(paths.ownerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8"); }
  finally { closeSync(fd); }
  const stored = readOwner(paths.ownerPath);
  requireCondition(stored.owner.schema === SCHEMA && stored.owner.repoRoot === paths.repoRoot
    && stored.owner.token === token, "DEV_STACK_LIFECYCLE_CHANGED", "The new lease owner changed.");
  return {
    ...paths, schema: SCHEMA, token,
    directoryIdentity: identity(directory), ownerIdentity: identity(stored.info),
  };
}

/** Release only the exact acquired lease; never recursively delete a lock path. */
export function releaseLifecycleLock(lease) {
  requireCondition(exactKeys(lease,
    ["repoRoot", "path", "ownerPath", "schema", "token", "directoryIdentity", "ownerIdentity"])
    && lease.schema === SCHEMA && typeof lease.token === "string" && /^[a-f0-9]{64}$/u.test(lease.token),
  "DEV_STACK_LIFECYCLE_LEASE", "Expected an exact acquired lifecycle lease.");
  const paths = pathsFor(lease.repoRoot);
  requireCondition(paths.repoRoot === lease.repoRoot && paths.path === lease.path
    && paths.ownerPath === lease.ownerPath, "DEV_STACK_LIFECYCLE_FOREIGN",
  "The lease is not bound to this canonical checkout's fixed lock path.");
  const directory = privateEntry(paths.path, true);
  requireCondition(matchesIdentity(lease.directoryIdentity, directory), "DEV_STACK_LIFECYCLE_CHANGED",
    "The lifecycle lock directory was replaced; no deletion performed.");
  const { owner, info } = readOwner(paths.ownerPath);
  requireCondition(matchesIdentity(lease.ownerIdentity, info), "DEV_STACK_LIFECYCLE_CHANGED",
    "The lifecycle owner file was replaced; no deletion performed.");
  requireCondition(exactKeys(owner, ["schema", "repoRoot", "token"])
    && owner.schema === SCHEMA && owner.repoRoot === paths.repoRoot && owner.token === lease.token,
  "DEV_STACK_LIFECYCLE_FOREIGN", "The lifecycle owner or token does not match this lease; no deletion performed.");
  const names = readdirSync(paths.path);
  requireCondition(names.length === 1 && names[0] === OWNER_NAME, "DEV_STACK_LIFECYCLE_UNSAFE",
    "Unexpected lock contents; no deletion performed.");
  requireCondition(matchesIdentity(lease.directoryIdentity, privateEntry(paths.path, true))
    && matchesIdentity(lease.ownerIdentity, privateEntry(paths.ownerPath, false)),
  "DEV_STACK_LIFECYCLE_CHANGED", "The lifecycle lease changed before release.");
  unlinkSync(paths.ownerPath);
  rmdirSync(paths.path);
  return { released: true, repoRoot: paths.repoRoot, path: paths.path };
}

function cancellationScope(events) {
  const controller = new AbortController();
  const cancel = () => {
    if (!controller.signal.aborted) {
      const error = new Error("Lifecycle operation interrupted; inspect retained runtime state before explicit recovery.");
      error.code = "DEV_STACK_OPERATION_CANCELLED";
      controller.abort(error);
    }
  };
  events.on("SIGTERM", cancel);
  try { events.on("SIGINT", cancel); }
  catch (error) { events.off("SIGTERM", cancel); throw error; }
  let disposed = false;
  return {
    signal: controller.signal,
    check: () => controller.signal.throwIfAborted(),
    dispose() {
      if (disposed) return;
      events.off("SIGTERM", cancel); events.off("SIGINT", cancel); disposed = true;
    },
  };
}

/** Cancellation covers acquisition/teardown until up explicitly owns its signal handlers. */
export async function withLifecycleAdmission(repoRoot, work, { acquire = acquireLifecycleLock,
  release = releaseLifecycleLock, events = process } = {}) {
  let scope, lease, hasLease = false, releaseAttempted = false, releaseError;
  let handedOff = false, hadPrimary = false, primary, result;
  const releaseAdmission = () => {
    if (!hasLease) throw new Error("No acquired lifecycle admission is available.");
    if (releaseAttempted) { if (releaseError) throw releaseError; return; }
    releaseAttempted = true;
    try { release(lease); }
    catch (error) { releaseError = error; throw error; }
  };
  try {
    // Install before acquisition; a signal callback marks cancellation, never throws out of the event loop.
    scope = cancellationScope(events);
    scope.check();
    lease = acquire(repoRoot); hasLease = true;
    scope.check();
    result = await work({ signal: scope.signal, checkCancelled: scope.check, releaseAdmission,
      handoffToUp() {
        // up calls this only after its own SIGTERM/SIGINT handlers are installed.
        scope.check(); scope.dispose(); handedOff = true;
      } });
    if (!handedOff) scope.check();
  } catch (error) { hadPrimary = true; primary = error; }
  const cleanupErrors = [];
  if (hasLease) {
    try { releaseAdmission(); }
    catch (error) { if (!hadPrimary || error !== primary) cleanupErrors.push(error); }
  }
  // Retain coverage through exact release's synchronous owner/lock finalization.
  if (!handedOff) {
    try { scope?.check(); }
    catch (error) {
      if (!hadPrimary) { hadPrimary = true; primary = error; }
      else if (error !== primary) cleanupErrors.push(error);
    }
  }
  try { scope?.dispose(); } catch (error) { cleanupErrors.push(error); }
  if (hadPrimary && cleanupErrors.length) {
    throw new AggregateError([primary, ...cleanupErrors], "Lifecycle operation and exact-owner release both failed; original failures retained.");
  }
  if (hadPrimary) throw primary;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Lifecycle admission cleanup failed.");
  return result;
}

/** Never launch a concurrent reset while the current proof supervisor may still own its lease. */
export function resetAfterObservedExit(exit, reset) {
  const observed = exit !== null && typeof exit === "object"
    && ((Number.isSafeInteger(exit.code) && exit.code >= 0 && exit.code <= 255 && exit.signal === null)
      || (exit.code === null && typeof exit.signal === "string" && /^SIG[A-Z0-9]{1,24}$/u.test(exit.signal)));
  if (!observed) {
    const error = new Error("Current supervisor exit is unobserved; concurrent reset was not attempted.");
    error.code = "DEV_STACK_SUPERVISOR_EXIT_UNOBSERVED";
    throw error;
  }
  return reset();
}
