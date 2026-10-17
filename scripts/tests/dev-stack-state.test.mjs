import assert from "node:assert/strict";
import {
  chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { initState, readState, removeState } from "../dev-stack-state.mjs";

const PORTS = { api: 4100, web: 5173, postgres: 5434, temporal: 7234 };

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "space-dev-state-"));
  const repo = join(base, "checkout");
  mkdirSync(repo);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, repo };
}

function linkOrSkip(t, target, path, directory = false) {
  try { symlinkSync(target, path, directory ? (process.platform === "win32" ? "junction" : "dir") : "file"); }
  catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip("Host does not permit this symlink fixture.");
      return false;
    }
    throw error;
  }
  return true;
}

test("initializes canonical checkout ownership, saved ports and independent strong secrets", (t) => {
  const { repo } = fixture(t);
  const state = initState(repo, PORTS);
  assert.equal(state.repoRoot, realpathSync(repo));
  assert.equal(state.stateDir, join(realpathSync(repo), ".dev-stack"));
  assert.match(state.project, /^space-dev-[a-f0-9]{24}$/u);
  assert.deepEqual(state.ports, PORTS);
  assert.equal(new Set(Object.values(state.secrets)).size, 3);
  for (const [key, value] of Object.entries(state.secrets)) {
    assert.match(value, /^[a-f0-9]{64}$/u);
    assert.equal(readFileSync(state.secretPaths[key], "utf8"), `${value}\n`);
  }
  assert.deepEqual(readState(repo), state);
});

test("initialization is idempotent and never rotates existing credentials", (t) => {
  const { repo } = fixture(t);
  const first = initState(repo, PORTS);
  const before = readFileSync(first.markerPath);
  assert.deepEqual(initState(repo, { ...PORTS }), first);
  assert.deepEqual(readFileSync(first.markerPath), before);
  assert.throws(() => initState(repo, { ...PORTS, api: 4200 }), { code: "DEV_STACK_PORTS_MISMATCH" });
  assert.deepEqual(readState(repo), first);
});

test("different checkouts receive different project identities and secrets", (t) => {
  const { base, repo } = fixture(t);
  const secondRepo = join(base, "other");
  mkdirSync(secondRepo);
  const first = initState(repo, PORTS);
  const second = initState(secondRepo, PORTS);
  assert.notEqual(first.project, second.project);
  for (const key of Object.keys(first.secrets)) assert.notEqual(first.secrets[key], second.secrets[key]);
});

test("refuses malformed and duplicate ports before creating state", (t) => {
  const { repo } = fixture(t);
  const invalid = [null, [], {}, { ...PORTS, extra: 5000 }, { ...PORTS, api: "4100" },
    { ...PORTS, api: 0 }, { ...PORTS, api: -1 }, { ...PORTS, api: 65536 },
    { ...PORTS, api: 1.5 }, { ...PORTS, api: NaN }, { ...PORTS, api: Infinity },
    { ...PORTS, api: PORTS.web }];
  for (const ports of invalid) {
    assert.throws(() => initState(repo, ports), { code: "DEV_STACK_INVALID_PORTS" });
    assert.equal(existsSync(join(repo, ".dev-stack")), false);
  }
  assert.equal(initState(repo, { api: 1, web: 65535, postgres: 2, temporal: 3 }).ports.web, 65535);
});

test("missing state is not treated as a successful reset", (t) => {
  const { repo } = fixture(t);
  assert.throws(() => readState(repo), { code: "DEV_STACK_STATE_MISSING" });
  assert.throws(() => removeState(repo), { code: "DEV_STACK_STATE_MISSING" });
  assert.equal(existsSync(join(repo, ".dev-stack")), false);
});

test("existing unmarked state is neither adopted nor removed", (t) => {
  const { repo } = fixture(t);
  const dir = join(repo, ".dev-stack");
  mkdirSync(dir, { mode: 0o700 });
  const sentinel = join(dir, "keep.txt");
  writeFileSync(sentinel, "user data");
  for (const action of [() => initState(repo, PORTS), () => readState(repo), () => removeState(repo)]) {
    assert.throws(action, { code: "DEV_STACK_OWNER_MISSING" });
    assert.equal(readFileSync(sentinel, "utf8"), "user data");
  }
});

test("a foreign canonical-root marker refuses read, initialization and reset", (t) => {
  const { base, repo } = fixture(t);
  const other = join(base, "other");
  mkdirSync(other);
  const state = initState(repo, PORTS);
  const marker = JSON.parse(readFileSync(state.markerPath, "utf8"));
  marker.repoRoot = realpathSync(other);
  writeFileSync(state.markerPath, JSON.stringify(marker));
  for (const action of [() => readState(repo), () => initState(repo, PORTS), () => removeState(repo)]) {
    assert.throws(action, { code: "DEV_STACK_FOREIGN_STATE" });
    assert.equal(existsSync(state.secretPaths.setupToken), true);
  }
});

test("malformed ownership and corrupted saved ports refuse reset", (t) => {
  const { repo } = fixture(t);
  const state = initState(repo, PORTS);
  const marker = JSON.parse(readFileSync(state.markerPath, "utf8"));
  for (const value of ["not JSON", JSON.stringify({ ...marker, schema: "foreign" }),
    JSON.stringify({ ...marker, project: "../../elsewhere" })]) {
    writeFileSync(state.markerPath, value);
    assert.throws(() => removeState(repo), { code: "DEV_STACK_INVALID_STATE" });
  }
  writeFileSync(state.markerPath, JSON.stringify({ ...marker, ports: { ...PORTS, api: PORTS.web } }));
  assert.throws(() => readState(repo), { code: "DEV_STACK_INVALID_PORTS" });
  assert.equal(existsSync(state.secretPaths.setupToken), true);
});

test("empty or malformed credentials are never silently regenerated", (t) => {
  const { repo } = fixture(t);
  const state = initState(repo, PORTS);
  writeFileSync(state.secretPaths.sessionSecret, "");
  assert.throws(() => initState(repo, PORTS), { code: "DEV_STACK_INVALID_SECRET" });
  assert.throws(() => removeState(repo), { code: "DEV_STACK_INVALID_SECRET" });
  assert.equal(readFileSync(state.secretPaths.sessionSecret, "utf8"), "");
});

test("missing credentials and ownership marker are not recreated or deleted by reset", (t) => {
  const { repo } = fixture(t);
  const state = initState(repo, PORTS);
  unlinkSync(state.secretPaths.setupToken);
  assert.throws(() => readState(repo), { code: "ENOENT" });
  assert.throws(() => initState(repo, PORTS), { code: "ENOENT" });
  assert.throws(() => removeState(repo), { code: "ENOENT" });
  assert.equal(existsSync(state.secretPaths.postgresPassword), true);
  unlinkSync(state.markerPath);
  assert.throws(() => removeState(repo), { code: "DEV_STACK_OWNER_MISSING" });
  assert.equal(existsSync(state.stateDir), true);
});

test("hard-linked credentials cannot be adopted or removed", (t) => {
  const { base, repo } = fixture(t);
  const state = initState(repo, PORTS);
  const additionalLink = join(base, "linked-token");
  linkSync(state.secretPaths.setupToken, additionalLink);
  assert.throws(() => readState(repo), { code: "DEV_STACK_UNSAFE_PATH" });
  assert.throws(() => removeState(repo), { code: "DEV_STACK_UNSAFE_PATH" });
  assert.equal(readFileSync(additionalLink, "utf8"), `${state.secrets.setupToken}\n`);
});

test("symlink state root is not followed or reset", (t) => {
  const { base, repo } = fixture(t);
  const outside = join(base, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "keep");
  if (!linkOrSkip(t, outside, join(repo, ".dev-stack"), true)) return;
  for (const action of [() => readState(repo), () => initState(repo, PORTS), () => removeState(repo)]) {
    assert.throws(action, { code: "DEV_STACK_UNSAFE_PATH" });
    assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep");
  }
});

for (const kind of ["marker", "secret", "secrets-directory"]) {
  test(`rejects a symlink ${kind} without deleting its target`, (t) => {
    const { base, repo } = fixture(t);
    const state = initState(repo, PORTS);
    const target = kind === "marker" ? state.markerPath
      : kind === "secret" ? state.secretPaths.setupToken : state.secretsDir;
    const outside = join(base, "outside");
    if (kind === "secrets-directory") {
      mkdirSync(outside);
      for (const path of Object.values(state.secretPaths)) {
        copyFileSync(path, join(outside, path.slice(dirname(path).length + 1)));
      }
      rmSync(target, { recursive: true });
    } else {
      copyFileSync(target, outside);
      unlinkSync(target);
    }
    if (!linkOrSkip(t, outside, target, kind === "secrets-directory")) return;
    assert.throws(() => readState(repo), { code: "DEV_STACK_UNSAFE_PATH" });
    assert.throws(() => removeState(repo), { code: "DEV_STACK_UNSAFE_PATH" });
    assert.equal(existsSync(outside), true);
  });
}

test("reset validates all descendants before deleting anything and rejects external links", (t) => {
  const { base, repo } = fixture(t);
  const state = initState(repo, PORTS);
  const outside = join(base, "outside");
  mkdirSync(outside);
  const sentinel = join(outside, "keep.txt");
  writeFileSync(sentinel, "keep");
  writeFileSync(join(state.stateDir, "first.txt"), "must remain on refusal");
  if (!linkOrSkip(t, outside, join(state.stateDir, "external"), true)) return;
  assert.throws(() => removeState(repo), { code: "DEV_STACK_UNSAFE_DESCENDANT" });
  assert.equal(readFileSync(sentinel, "utf8"), "keep");
  assert.equal(readFileSync(join(state.stateDir, "first.txt"), "utf8"), "must remain on refusal");
  assert.equal(existsSync(state.markerPath), true);
});

test("reset supports an internal dependency symlink, removes only state and rotates next initialization", (t) => {
  const { repo } = fixture(t);
  const state = initState(repo, PORTS);
  const vendor = join(state.stateDir, "vendor");
  mkdirSync(join(vendor, "package"), { recursive: true });
  writeFileSync(join(vendor, "package", "cli.mjs"), "export {};\n");
  if (!linkOrSkip(t, join(vendor, "package"), join(vendor, "bin"), true)) return;
  const unrelated = join(repo, "keep.txt");
  writeFileSync(unrelated, "repository data");
  assert.deepEqual(removeState(repo), {
    removed: true, repoRoot: state.repoRoot, stateDir: state.stateDir, project: state.project,
  });
  assert.equal(existsSync(state.stateDir), false);
  assert.equal(readFileSync(unrelated, "utf8"), "repository data");
  const next = initState(repo, PORTS);
  assert.notEqual(next.project, state.project);
  assert.notEqual(next.secrets.setupToken, state.secrets.setupToken);
});

test("reset unlinks internal npm-style file symlinks without following them", (t) => {
  const { repo } = fixture(t);
  const state = initState(repo, PORTS);
  const vendor = join(state.stateDir, "vendor", "node_modules");
  mkdirSync(join(vendor, ".bin"), { recursive: true });
  mkdirSync(join(vendor, "cli"));
  const script = join(vendor, "cli", "index.mjs");
  writeFileSync(script, "export {};\n");
  if (!linkOrSkip(t, script, join(vendor, ".bin", "cli"))) return;
  assert.equal(removeState(repo).removed, true);
  assert.equal(existsSync(state.stateDir), false);
});

test("broken dependency links refuse reset without partially deleting state", (t) => {
  const { repo } = fixture(t);
  const state = initState(repo, PORTS);
  if (!linkOrSkip(t, join(state.stateDir, "absent"), join(state.stateDir, "broken"))) return;
  assert.throws(() => removeState(repo), { code: "DEV_STACK_UNSAFE_DESCENDANT" });
  assert.equal(existsSync(state.markerPath), true);
  assert.equal(existsSync(state.secretPaths.postgresPassword), true);
});

test("generated directories and credential files have private POSIX permissions", {
  skip: process.platform === "win32" ? "POSIX permission enforcement is not a Windows ACL guarantee." : false,
}, (t) => {
  const { repo } = fixture(t);
  const state = initState(repo, PORTS);
  for (const path of [state.stateDir, state.secretsDir]) assert.equal(lstatSync(path).mode & 0o777, 0o700);
  for (const path of [state.markerPath, ...Object.values(state.secretPaths)]) {
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
  }
  chmodSync(state.secretPaths.setupToken, 0o644);
  assert.throws(() => readState(repo), { code: "DEV_STACK_UNSAFE_PERMISSIONS" });
  assert.throws(() => removeState(repo), { code: "DEV_STACK_UNSAFE_PERMISSIONS" });
});
