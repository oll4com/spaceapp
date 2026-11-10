import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readAutohandNativeSessionId } from "../src/autohand-native-session.js";

const volatileStat = vi.hoisted(() => ({ path: "", reads: 0 }));
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, readFile: async (...args: Parameters<typeof fs.readFile>) => {
    const value = await fs.readFile(...args);
    if (args[0] !== volatileStat.path || typeof value !== "string") return value;
    const end = value.lastIndexOf(")") + 1;
    const fields = value.slice(end).trim().split(/\s+/);
    fields[11] = String(++volatileStat.reads); // utime changes, starttime stays the same.
    return value.slice(0, end) + " " + fields.join(" ");
  } };
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const input = { paneId: "pane:Zmdph7umufyB", sessionId: "cli_session:T8YgG1wEsZLJ", rootPid: 3000 };
const id = "01a19df2-d673-4422-be29-b4704630e1eb-1793700000000";
const newerId = "01a19df2-d673-4422-be29-b4704630e1eb-1793700000001";
const now = 1793700001000;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "autohand-native-session-"));
  roots.push(root);
  const procRoot = join(root, "proc"), home = join(root, "autohand"), cwd = join(root, "project");
  await mkdir(join(home, "active-agents"), { recursive: true });
  await mkdir(cwd);
  await mkdir(procRoot);
  await writeFile(join(procRoot, "uptime"), "100.00 10.00");
  const proc = async (pid: number, children: number[], sessionId = input.sessionId, ticks = 1000) => {
    const base = join(procRoot, String(pid));
    await mkdir(join(base, "task", String(pid)), { recursive: true });
    await writeFile(join(base, "task", String(pid), "children"), children.join(" "));
    await writeFile(join(base, "environ"), `SPACE_PANE_ID=${input.paneId}\0SPACE_CLI_SESSION_ID=${sessionId}\0`);
    await writeFile(join(base, "stat"), `${pid} (autohand cli) S ${Array(18).fill("0").join(" ")} ${ticks}`);
    await symlink(cwd, join(base, "cwd"));
  };
  const record = async (nativeId = id, overrides: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) => {
    await mkdir(join(home, "sessions", nativeId), { recursive: true });
    await writeFile(join(home, "sessions", nativeId, "metadata.json"), JSON.stringify({ sessionId: nativeId, projectPath: cwd, ...metadata }), { mode: 0o600 });
    await writeFile(join(home, "active-agents", `${nativeId}.json`), JSON.stringify({ version: 1, pid: 3300, sessionId: nativeId,
      workspaceRoot: cwd, updatedAt: new Date(now - 1000).toISOString(), ...overrides }), { mode: 0o600 });
  };
  await proc(3000, [3300]);
  await proc(3300, []);
  await proc(3400, [], "cli_session:AnotherPane1");
  await record();
  // A newer session in the same workspace must never beat the pane's identity.
  await record(newerId, { pid: 3400, updatedAt: new Date(now).toISOString() });
  return { procRoot, home, now, clockTicks: 100, record, proc, cwd };
}

it("binds pane A's process heartbeat even when B is newer in the same workspace", async () => {
  expect(await readAutohandNativeSessionId(input, await fixture())).toBe(id);
});
it("rejects other pane/session/process identities and missing or stale native records", async () => {
  const paths = await fixture();
  expect(await readAutohandNativeSessionId({ ...input, paneId: "pane:OtherPane123" }, paths)).toBeNull();
  expect(await readAutohandNativeSessionId({ ...input, sessionId: "cli_session:OtherPane123" }, paths)).toBeNull();
  expect(await readAutohandNativeSessionId({ ...input, rootPid: 1 }, paths)).toBeNull();
  await paths.record(id, { updatedAt: new Date(now - 15001).toISOString() });
  expect(await readAutohandNativeSessionId(input, paths)).toBeNull();
  await paths.record(id, {}, { sessionId: newerId });
  expect(await readAutohandNativeSessionId(input, paths)).toBeNull();
});
it("rejects a heartbeat predating a reused PID, and ambiguous current native identities", async () => {
  const paths = await fixture();
  await paths.record(id, { updatedAt: new Date(now - 2000).toISOString() });
  const stat = `${3300} (autohand cli) S ${Array(18).fill("0").join(" ")} 9900`;
  await writeFile(join(paths.procRoot, "3300/stat"), stat);
  expect(await readAutohandNativeSessionId(input, paths)).toBeNull();
  await paths.record(id, { updatedAt: new Date(now).toISOString() });
  await paths.record(newerId, { updatedAt: new Date(now).toISOString() });
  expect(await readAutohandNativeSessionId(input, paths)).toBeNull();
});
it("rejects symlink records, missing native history, and mismatched workspaces", async () => {
  const paths = await fixture();
  await paths.record(id, { workspaceRoot: "/different" });
  expect(await readAutohandNativeSessionId(input, paths)).toBeNull();
  await paths.record();
  await rm(join(paths.home, "sessions", id), { recursive: true });
  expect(await readAutohandNativeSessionId(input, paths)).toBeNull();
  await paths.record();
  const record = join(paths.home, "active-agents", `${id}.json`);
  await rm(record);
  await symlink(join(paths.home, "active-agents", `${newerId}.json`), record);
  expect(await readAutohandNativeSessionId(input, paths)).toBeNull();
});

it("compares immutable process starttime while live CPU counters change", async () => {
  const paths = await fixture();
  volatileStat.path = join(paths.procRoot, "3300/stat");
  volatileStat.reads = 0;
  try {
    expect(await readAutohandNativeSessionId(input, paths)).toBe(id);
    expect(volatileStat.reads).toBeGreaterThanOrEqual(2);
  } finally { volatileStat.path = ""; }
});
