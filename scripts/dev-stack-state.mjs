/**
 * Synchronous, checkout-local development credentials and ownership checks.
 * There are no configurable state paths and no process signalling here. Callers
 * must stop their stack before reset. This is a trusted-local-checkout guard,
 * not a lock or a defence against a hostile concurrent filesystem writer.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync,
  readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

const SCHEMA = "spaceapp.dev-stack-state.v1";
const PORT_KEYS = ["api", "web", "postgres", "temporal"];
const SECRET_FILES = {
  postgresPassword: "postgres-password",
  sessionSecret: "session-secret",
  setupToken: "setup-token",
};

function refuse(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function requireCondition(condition, code, message) {
  if (!condition) refuse(code, message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function validatePorts(ports) {
  requireCondition(exactKeys(ports, PORT_KEYS), "DEV_STACK_INVALID_PORTS",
    "Expected exactly api, web, postgres and temporal ports.");
  const values = PORT_KEYS.map((key) => ports[key]);
  requireCondition(values.every((value) => Number.isInteger(value) && value >= 1 && value <= 65535)
    && new Set(values).size === values.length, "DEV_STACK_INVALID_PORTS",
  "Ports must be distinct integers between 1 and 65535.");
  return Object.fromEntries(PORT_KEYS.map((key) => [key, ports[key]]));
}

function pathsFor(repoRoot) {
  requireCondition(typeof repoRoot === "string" && repoRoot.length > 0,
    "DEV_STACK_INVALID_ROOT", "Expected a checkout directory.");
  const root = realpathSync(repoRoot);
  requireCondition(lstatSync(root).isDirectory(), "DEV_STACK_INVALID_ROOT",
    "The canonical checkout root must be a directory.");
  const stateDir = join(root, ".dev-stack");
  const secretsDir = join(stateDir, "secrets");
  return {
    repoRoot: root, stateDir, secretsDir, markerPath: join(stateDir, "owner.json"),
    secretPaths: Object.fromEntries(Object.entries(SECRET_FILES)
      .map(([key, name]) => [key, join(secretsDir, name)])),
  };
}

function optionalStat(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function sameIdentity(before, after) {
  return before.dev === after.dev && before.ino === after.ino
    && (before.mode & constants.S_IFMT) === (after.mode & constants.S_IFMT);
}

function privateEntry(path, directory) {
  const info = lstatSync(path);
  requireCondition(!info.isSymbolicLink()
    && (directory ? info.isDirectory() : info.isFile()), "DEV_STACK_UNSAFE_PATH",
  "State, ownership marker and credentials must not be links or unexpected file types.");
  if (process.platform !== "win32") {
    requireCondition((info.mode & 0o777) === (directory ? 0o700 : 0o600),
      "DEV_STACK_UNSAFE_PERMISSIONS", "State directories require 0700 and credential files 0600.");
    if (typeof process.getuid === "function") {
      requireCondition(info.uid === process.getuid(), "DEV_STACK_FOREIGN_OWNER",
        "State must belong to the current user.");
    }
  }
  requireCondition(directory || info.nlink === 1, "DEV_STACK_UNSAFE_PATH",
    "Ownership markers and credentials must not have additional hard links.");
  return info;
}

function readPrivateFile(path, limit) {
  const before = privateEntry(path, false);
  requireCondition(before.size <= limit, "DEV_STACK_INVALID_STATE", "State file is too large.");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    requireCondition(sameIdentity(before, opened), "DEV_STACK_STATE_CHANGED",
      "State changed while being opened; retry only after investigating.");
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(fd);
    requireCondition(length <= limit && length === opened.size && after.size === opened.size
      && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs,
    "DEV_STACK_STATE_CHANGED", "State changed while being read.");
    return buffer.subarray(0, length).toString("utf8");
  } finally { closeSync(fd); }
}

function createPrivateFile(path, text) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeFileSync(fd, text, "utf8"); }
  finally { closeSync(fd); }
}

/** Read a validated existing state. Missing/foreign/partial state is never adopted. */
export function readState(repoRoot) {
  const paths = pathsFor(repoRoot);
  requireCondition(optionalStat(paths.stateDir) !== null, "DEV_STACK_STATE_MISSING",
    "No checkout state exists; initialize the stack first.");
  privateEntry(paths.stateDir, true);
  requireCondition(optionalStat(paths.markerPath) !== null, "DEV_STACK_OWNER_MISSING",
    "Existing .dev-stack has no owner marker; inspect it manually, do not adopt or reset it.");
  let marker;
  try { marker = JSON.parse(readPrivateFile(paths.markerPath, 4096)); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    refuse("DEV_STACK_INVALID_STATE", "Ownership marker is not valid JSON.");
  }
  requireCondition(exactKeys(marker, ["schema", "repoRoot", "project", "ports"])
    && marker.schema === SCHEMA && typeof marker.project === "string"
    && /^space-dev-[a-f0-9]{24}$/u.test(marker.project), "DEV_STACK_INVALID_STATE",
  "Ownership marker schema or project identity is invalid.");
  requireCondition(marker.repoRoot === paths.repoRoot, "DEV_STACK_FOREIGN_STATE",
    "This .dev-stack belongs to another canonical checkout; it cannot be adopted or reset.");
  const ports = validatePorts(marker.ports);
  privateEntry(paths.secretsDir, true);
  const secrets = {};
  for (const [key, path] of Object.entries(paths.secretPaths)) {
    const raw = readPrivateFile(path, 128);
    requireCondition(/^[a-f0-9]{64}\n$/u.test(raw), "DEV_STACK_INVALID_SECRET",
      "A generated credential is missing or malformed; do not reuse this state.");
    secrets[key] = raw.slice(0, -1);
  }
  return { ...paths, schema: SCHEMA, project: marker.project, ports, secrets };
}

/** Initialize only an absent .dev-stack; existing credentials are never rotated. */
export function initState(repoRoot, ports) {
  const requestedPorts = validatePorts(ports);
  const paths = pathsFor(repoRoot);
  if (optionalStat(paths.stateDir) !== null) {
    const existing = readState(paths.repoRoot);
    requireCondition(PORT_KEYS.every((key) => existing.ports[key] === requestedPorts[key]),
      "DEV_STACK_PORTS_MISMATCH", "Requested ports differ from this checkout's saved ports. "
        + "Use the saved ports, or stop the stack and explicitly reset before changing them.");
    return existing;
  }
  // mkdir is exclusive. A competing initializer or partial/foreign state is not overwritten.
  mkdirSync(paths.stateDir, { mode: 0o700 });
  privateEntry(paths.stateDir, true);
  mkdirSync(paths.secretsDir, { mode: 0o700 });
  for (const path of Object.values(paths.secretPaths)) {
    createPrivateFile(path, `${randomBytes(32).toString("hex")}\n`);
  }
  createPrivateFile(paths.markerPath, `${JSON.stringify({
    schema: SCHEMA, repoRoot: paths.repoRoot,
    project: `space-dev-${randomBytes(12).toString("hex")}`, ports: requestedPorts,
  }, null, 2)}\n`);
  return readState(paths.repoRoot);
}

function strictlyInside(root, target) {
  const suffix = relative(root, target);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`)
    && !isAbsolute(suffix);
}

function removalEntries(stateDir) {
  const entries = [];
  function visit(path) {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      let target;
      try { target = realpathSync(path); }
      catch { refuse("DEV_STACK_UNSAFE_DESCENDANT", "Broken or cyclic state link; inspect before reset."); }
      requireCondition(strictlyInside(stateDir, target), "DEV_STACK_UNSAFE_DESCENDANT",
        "A state descendant links outside .dev-stack; reset refused without deleting anything.");
    } else if (info.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name));
    } else {
      requireCondition(info.isFile(), "DEV_STACK_UNSAFE_DESCENDANT",
        "Unexpected special file inside .dev-stack; inspect before reset.");
    }
    entries.push({ path, info });
  }
  visit(stateDir);
  return entries;
}

/**
 * Remove exactly this validated checkout's state, never a supplied arbitrary path.
 * Dependency symlinks resolving strictly inside state are unlinked, not traversed.
 * External/broken links refuse the entire preflight before any removal. Processes
 * and concurrent writers are the caller's responsibility; this never signals PIDs.
 */
export function removeState(repoRoot) {
  const state = readState(repoRoot);
  const entries = removalEntries(state.stateDir);
  // Revalidate the critical marker and credentials after the tree preflight.
  const current = readState(state.repoRoot);
  requireCondition(current.project === state.project, "DEV_STACK_STATE_CHANGED",
    "State ownership changed before reset.");
  const directories = new Map(entries.filter(({ info }) => info.isDirectory() && !info.isSymbolicLink())
    .map((entry) => [entry.path, entry.info]));
  for (const entry of entries) {
    // Never operate through a directory replaced with a symlink during reset.
    let directory = entry.info.isDirectory() && !entry.info.isSymbolicLink() ? entry.path : dirname(entry.path);
    for (;;) {
      const now = lstatSync(directory);
      requireCondition(now.isDirectory() && !now.isSymbolicLink() && sameIdentity(directories.get(directory), now),
        "DEV_STACK_STATE_CHANGED", "A state directory changed during reset.");
      if (directory === state.stateDir) break;
      directory = dirname(directory);
    }
    const now = lstatSync(entry.path);
    requireCondition(sameIdentity(entry.info, now), "DEV_STACK_STATE_CHANGED",
      "A state entry changed during reset.");
    if (now.isDirectory() && !now.isSymbolicLink()) rmdirSync(entry.path);
    else unlinkSync(entry.path);
  }
  return { removed: true, repoRoot: state.repoRoot, stateDir: state.stateDir, project: state.project };
}
