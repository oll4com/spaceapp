import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readKimiNativeSessionId } from "../src/kimi-native-session.js";
import { NativeTaskTitles } from "../src/task-title-native.js";
import type { PaneCliSession } from "@space/contracts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const identity = { paneId: "pane:Zmdph7umufyB", sessionId: "cli_session:T8YgG1wEsZLJ", rootPid: 3000 };
const identityEnviron = `HOME=/var/lib/spaceapp-user\0SPACE_PANE_ID=${identity.paneId}\0SPACE_CLI_SESSION_ID=${identity.sessionId}\0`;
const id = "session_9b24fa18-f4c4-4068-99fd-579eab078d10";
const other = "session_24b96a02-f0a1-441e-9695-cce6cf77df04";

async function fixture(options: { environ?: string; leases?: Array<{ id: string; pid: number; host?: string; profile?: string }> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "kimi-native-session-"));
  roots.push(root);
  const procRoot = join(root, "proc"), homeDir = join(root, "space-kimi");
  const proc = async (pid: number, children: number[], environ?: string) => {
    await mkdir(join(procRoot, String(pid), "task", String(pid)), { recursive: true });
    await writeFile(join(procRoot, String(pid), "task", String(pid), "children"), children.map(child => `${child} `).join(""));
    if (environ !== undefined) await writeFile(join(procRoot, String(pid), "environ"), environ);
  };
  // Pane host root (sudo) -> the kimi wrapper -> kimi-code, which leases its session while a turn runs (shape read live 2026-11-03).
  await proc(3000, [3200]);
  await proc(3200, [3300], options.environ ?? identityEnviron);
  await proc(3300, [], options.environ ?? identityEnviron);
  for (const lease of options.leases ?? [{ id, pid: 3300 }, { id: other, pid: 4400 }]) {
    const dir = join(homeDir, ...(lease.profile ? ["profiles", lease.profile] : []), "locks", "sessions");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${lease.id}.lock`), JSON.stringify({ version: 1, token: "3300:x", pid: lease.pid,
      hostname: lease.host ?? "codex-dev", startedAt: 1793666995284, clientIdentity: "kimi_code_cli" }));
  }
  return { procRoot, homeDir, host: "codex-dev" };
}

it("reads the session this pane's live Kimi leased for its turn, the one `kimi --session <id>` reopens", async () => {
  expect(await readKimiNativeSessionId(identity, await fixture())).toBe(id);
  expect(await readKimiNativeSessionId(identity, await fixture({ leases: [{ id, pid: 3300, profile: "work" }] }))).toBe(id);
});

it("fails closed between turns, for another pane, another host, two leases or an id the sudoers would refuse", async () => {
  const paths = await fixture();
  expect(await readKimiNativeSessionId({ ...identity, paneId: "pane:OtherPane123" }, paths)).toBeNull();
  expect(await readKimiNativeSessionId({ ...identity, rootPid: 1 }, paths)).toBeNull();
  expect(await readKimiNativeSessionId(identity, await fixture({ leases: [] }))).toBeNull();
  expect(await readKimiNativeSessionId(identity, await fixture({ environ: "HOME=/var/lib/spaceapp-user\0" }))).toBeNull();
  expect(await readKimiNativeSessionId(identity, await fixture({ leases: [{ id, pid: 3300, host: "elsewhere" }] }))).toBeNull();
  expect(await readKimiNativeSessionId(identity, await fixture({ leases: [{ id, pid: 3300 }, { id: other, pid: 3200 }] }))).toBeNull();
  expect(await readKimiNativeSessionId(identity, await fixture({ leases: [{ id: id.toUpperCase(), pid: 3300 }] }))).toBeNull();
  expect(await readKimiNativeSessionId(identity, await fixture({ leases: [{ id, pid: 3300, profile: "../x" }] }))).toBeNull();
});

it("records the leased Kimi session as the task's native reference and never writes a title", async () => {
  const none = async () => null;
  const titles = new NativeTaskTitles(async () => 3000, none, none, async (session, rootPid) =>
    session.paneId === identity.paneId && rootPid === 3000 ? id : null);
  const session = { runtimeId: "cli:kimi", paneId: identity.paneId, sessionId: identity.sessionId } as PaneCliSession;
  expect(await titles.metadata(session)).toEqual({ nativeId: id });
  expect(await titles.metadata(session, { nativeId: id, title: "x", manual: true })).toBeNull();
  expect(await new NativeTaskTitles(async () => null).metadata(session)).toBeNull();
});
