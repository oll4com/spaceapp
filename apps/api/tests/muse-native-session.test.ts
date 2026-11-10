import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readMuseNativeSessionId } from "../src/muse-native-session.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const identity = { paneId: "pane:Zmdph7umufyB", sessionId: "cli_session:T8YgG1wEsZLJ", rootPid: 3000 };
const identityEnviron = `HOME=/var/lib/spaceapp-user\0SPACE_PANE_ID=${identity.paneId}\0SPACE_CLI_SESSION_ID=${identity.sessionId}\0`;
const id = "01a19df2-d673-7422-be29-b4704630e1eb";

async function fixture(options: { lockIn?: "muse" | "launcher" | "none"; lockPath?: (dataDir: string) => string; environ?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "muse-native-session-"));
  roots.push(root);
  const procRoot = join(root, "proc"), dataDir = join(root, "muse");
  const sessionDir = join(dataDir, "sessions", "2026", "11", "02", id);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, ".session.lock"), "pid=3300\nhost=codex-dev\n");
  const lock = options.lockPath?.(dataDir) ?? join(sessionDir, ".session.lock");
  const proc = async (pid: number, children: number[], environ?: string, fds: string[] = []) => {
    await mkdir(join(procRoot, String(pid), "task", String(pid)), { recursive: true });
    await mkdir(join(procRoot, String(pid), "fd"), { recursive: true });
    await writeFile(join(procRoot, String(pid), "task", String(pid), "children"), children.map(child => `${child} `).join(""));
    if (environ !== undefined) await writeFile(join(procRoot, String(pid), "environ"), environ);
    for (const [index, target] of fds.entries()) await symlink(target, join(procRoot, String(pid), "fd", String(index + 3)));
  };
  const lockIn = options.lockIn ?? "muse";
  const environ = options.environ ?? identityEnviron;
  // Pane host root (sudo) -> the muse launcher script -> muse-bin, which holds its session's lock (and a log beside it).
  await proc(3000, [3200]);
  await proc(3200, [3300], environ, lockIn === "launcher" ? [lock] : ["/dev/pts/95"]);
  await proc(3300, [], environ, lockIn === "muse" ? ["/dev/null", join(sessionDir, "cli-1.log"), lock] : []);
  return { procRoot, dataDir };
}

it("reads the id of the session whose lock this pane's live Muse holds, the one `muse resume <id>` reopens", async () => {
  expect(await readMuseNativeSessionId(identity, await fixture())).toBe(id);
  expect(await readMuseNativeSessionId(identity, await fixture({ lockIn: "launcher" }))).toBe(id);
});

it("fails closed for another pane, no lock, a lock outside Muse's sessions folder or an id the sudoers would refuse", async () => {
  const paths = await fixture();
  expect(await readMuseNativeSessionId({ ...identity, paneId: "pane:OtherPane123" }, paths)).toBeNull();
  expect(await readMuseNativeSessionId({ ...identity, rootPid: 1 }, paths)).toBeNull();
  expect(await readMuseNativeSessionId(identity, await fixture({ lockIn: "none" }))).toBeNull();
  expect(await readMuseNativeSessionId(identity, await fixture({ environ: "HOME=/var/lib/spaceapp-user\0" }))).toBeNull();
  expect(await readMuseNativeSessionId(identity, await fixture({ lockPath: () => `/tmp/sessions/2026/11/02/${id}/.session.lock` }))).toBeNull();
  expect(await readMuseNativeSessionId(identity, await fixture({ lockPath: dataDir => join(dataDir, "sessions", "2026", "11", "02", id.toUpperCase(), ".session.lock") }))).toBeNull();
  expect(await readMuseNativeSessionId(identity, await fixture({ lockPath: dataDir => join(dataDir, "sessions", "2026", "11", "02", id, "session.jsonl") }))).toBeNull();
});
