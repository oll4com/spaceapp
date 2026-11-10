import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readDroidNativeSessionId } from "../src/droid-native-session.js";
import { NativeTaskTitles } from "../src/task-title-native.js";
import type { PaneCliSession } from "@space/contracts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const identity = { paneId: "pane:proof01", sessionId: "cli_session:proof01", rootPid: 3000 };
const env = `SPACE_PANE_ID=${identity.paneId}\0SPACE_CLI_SESSION_ID=${identity.sessionId}\0`;
const id = "85de09e6-3d1f-4e13-9173-142a9e9a36cf";
const otherId = "01a19df2-d673-7422-be29-b4704630e1eb";

async function fixture(options: { flags?: string; fileId?: string; environ?: string; foreignExecutable?: boolean; extraWriter?: boolean; symlinkFile?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "droid-native-session-"));
  roots.push(root);
  const procRoot = join(root, "proc"), sessions = join(root, "sessions"), binary = join(root, "droid");
  await mkdir(join(sessions, "-etc"), { recursive: true });
  await writeFile(binary, "");
  const statText = (pid: number) => `${pid} (droid cli) S ${Array(18).fill("0").join(" ")} 1234 0\n`;
  const nativeFile = join(sessions, "-etc", (options.fileId ?? id) + ".jsonl");
  // Deliberately invalid JSON: the reader must use only paths/stat, never parse conversation contents.
  await writeFile(nativeFile, "private conversation; not JSON");
  if (options.symlinkFile) {
    await rm(nativeFile);
    const elsewhere = join(root, "elsewhere");
    await writeFile(elsewhere, "private");
    await symlink(elsewhere, nativeFile);
  }
  await writeFile(join(sessions, "-etc", otherId + ".jsonl"), "a newer, unrelated session");
  for (const pid of [3000, 3300]) {
    const base = join(procRoot, String(pid));
    await mkdir(join(base, "task", String(pid)), { recursive: true });
    await mkdir(join(base, "fd"), { recursive: true });
    await mkdir(join(base, "fdinfo"), { recursive: true });
    await writeFile(join(base, "stat"), statText(pid));
    await writeFile(join(base, "task", String(pid), "children"), pid === 3000 ? "3300 " : "");
    await writeFile(join(base, "environ"), options.environ ?? env);
  }
  const base = join(procRoot, "3300");
  await symlink(options.foreignExecutable ? "/usr/bin/cat" : binary, join(base, "exe"));
  await symlink(nativeFile, join(base, "fd", "3"));
  await writeFile(join(base, "fdinfo", "3"), `flags:\t${options.flags ?? "0102001"}\n`);
  if (options.extraWriter) {
    await symlink(join(sessions, "-etc", otherId + ".jsonl"), join(base, "fd", "4"));
    await writeFile(join(base, "fdinfo", "4"), "flags:\t0102001\n");
  }
  return { procRoot, sessions, executables: [binary] };
}

it("binds only the writable native file held by the pane's Droid, ignoring a newer session in the same folder", async () => {
  expect(await readDroidNativeSessionId(identity, await fixture())).toBe(id);
  expect(await readDroidNativeSessionId(identity, await fixture({ flags: "0100002" }))).toBe(id);
});

it("fails closed for a foreign pane/session/root, another executable or no writable descriptor", async () => {
  const paths = await fixture();
  expect(await readDroidNativeSessionId({ ...identity, paneId: "pane:other" }, paths)).toBeNull();
  expect(await readDroidNativeSessionId({ ...identity, sessionId: "cli_session:other" }, paths)).toBeNull();
  expect(await readDroidNativeSessionId({ ...identity, rootPid: 1 }, paths)).toBeNull();
  expect(await readDroidNativeSessionId(identity, await fixture({ foreignExecutable: true }))).toBeNull();
  expect(await readDroidNativeSessionId(identity, await fixture({ environ: "" }))).toBeNull();
  expect(await readDroidNativeSessionId(identity, await fixture({ flags: "0100000" }))).toBeNull();
  await rm(join(paths.procRoot, "3300", "fd", "3"));
  expect(await readDroidNativeSessionId(identity, paths)).toBeNull();
});

it("rejects ambiguous writable sessions, invalid ids, symlinked native state and a process that has exited", async () => {
  expect(await readDroidNativeSessionId(identity, await fixture({ extraWriter: true }))).toBeNull();
  expect(await readDroidNativeSessionId(identity, await fixture({ fileId: id.toUpperCase() }))).toBeNull();
  expect(await readDroidNativeSessionId(identity, await fixture({ symlinkFile: true }))).toBeNull();
  const paths = await fixture();
  await rm(join(paths.procRoot, "3300", "stat"));
  expect(await readDroidNativeSessionId(identity, paths)).toBeNull();
});

it("passes the pane identity and host root PID through task-title capture without changing native titles", async () => {
  const paths = await fixture();
  const titles = new NativeTaskTitles(async () => identity.rootPid, undefined, undefined, undefined, undefined,
    async (session, rootPid) => readDroidNativeSessionId({ ...session, rootPid }, paths));
  const session = { ...identity, runtimeId: "cli:droid" } as unknown as PaneCliSession;
  expect(await titles.metadata(session)).toEqual({ nativeId: id });
  expect(await titles.metadata(session, { nativeId: id, title: "Do not write", manual: true })).toBeNull();
});
