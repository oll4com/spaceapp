import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  opencodeNativeSessionMappingPath,
  readOpenCodeNativeSessionId,
  readOpenCodeNativeSessionIdFromProcessTree
} from "../src/opencode-native-session.js";

const roots: string[] = [];

async function writeMapping(stateRoot: string, spaceSessionId: string, mapping: unknown) {
  const path = opencodeNativeSessionMappingPath(spaceSessionId, stateRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(mapping)}\n`, "utf8");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("OpenCode native session mapping", () => {
  it("returns the exact native OpenCode task for one Space CLI session", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "space-opencode-native-"));
    roots.push(stateRoot);
    await writeMapping(stateRoot, "cli_session:one", {
      version: 1,
      spaceSessionId: "cli_session:one",
      nativeSessionId: "ses_exactTaskOne123",
      updatedAt: "2026-08-01T15:00:00.000Z"
    });

    await expect(readOpenCodeNativeSessionId("cli_session:one", stateRoot)).resolves.toBe("ses_exactTaskOne123");
  });

  it("fails closed for missing, cross-session, or malformed native references", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "space-opencode-native-invalid-"));
    roots.push(stateRoot);
    await writeMapping(stateRoot, "cli_session:one", {
      version: 1,
      spaceSessionId: "cli_session:other",
      nativeSessionId: "ses_wrongOwner"
    });
    await writeMapping(stateRoot, "cli_session:two", {
      version: 1,
      spaceSessionId: "cli_session:two",
      nativeSessionId: "../../not-a-session"
    });

    await expect(readOpenCodeNativeSessionId("cli_session:one", stateRoot)).resolves.toBeNull();
    await expect(readOpenCodeNativeSessionId("cli_session:two", stateRoot)).resolves.toBeNull();
    await expect(readOpenCodeNativeSessionId("cli_session:missing", stateRoot)).resolves.toBeNull();
  });

  it("recovers one exact native OpenCode task from a legacy live process tree", async () => {
    const procRoot = await mkdtemp(join(tmpdir(), "space-opencode-proc-"));
    roots.push(procRoot);
    await mkdir(join(procRoot, "4101", "task", "4101"), { recursive: true });
    await mkdir(join(procRoot, "4102", "task", "4102"), { recursive: true });
    await writeFile(join(procRoot, "4101", "cmdline"), Buffer.from("sudo\0-n\0launcher\0"));
    await writeFile(join(procRoot, "4101", "task", "4101", "children"), "4102\n");
    await writeFile(
      join(procRoot, "4102", "cmdline"),
      Buffer.from("/var/lib/spaceapp-user/bin/opencode\0attach\0http://127.0.0.1:4100\0--session\0ses_exactLegacyTask123\0")
    );
    await writeFile(join(procRoot, "4102", "task", "4102", "children"), "");

    await expect(readOpenCodeNativeSessionIdFromProcessTree(4101, procRoot)).resolves.toBe("ses_exactLegacyTask123");
  });

  it("recovers the native task of an OpenCode 2 TUI, which connects with --server", async () => {
    const procRoot = await mkdtemp(join(tmpdir(), "space-opencode-proc-v2-"));
    roots.push(procRoot);
    await mkdir(join(procRoot, "4301", "task", "4301"), { recursive: true });
    // Command line recorded from OpenCode 2.0.31.
    await writeFile(join(procRoot, "4301", "cmdline"),
      Buffer.from("/opt/spaceapp/var/cli-versions/opencode/current/node_modules/.bin/opencode\0--server\0http://127.0.0.1:47047\0--session\0ses_v2Task123\0/etc\0"));
    await writeFile(join(procRoot, "4301", "task", "4301", "children"), "");

    await expect(readOpenCodeNativeSessionIdFromProcessTree(4301, procRoot)).resolves.toBe("ses_v2Task123");
  });

  it("fails closed when a process tree contains multiple native OpenCode tasks", async () => {
    const procRoot = await mkdtemp(join(tmpdir(), "space-opencode-proc-ambiguous-"));
    roots.push(procRoot);
    await mkdir(join(procRoot, "4201", "task", "4201"), { recursive: true });
    await mkdir(join(procRoot, "4202", "task", "4202"), { recursive: true });
    await mkdir(join(procRoot, "4203", "task", "4203"), { recursive: true });
    await writeFile(join(procRoot, "4201", "cmdline"), Buffer.from("sudo\0-n\0launcher\0"));
    await writeFile(join(procRoot, "4201", "task", "4201", "children"), "4202 4203\n");
    for (const [pid, nativeSessionId] of [["4202", "ses_firstTask123"], ["4203", "ses_secondTask456"]]) {
      await writeFile(
        join(procRoot, pid, "cmdline"),
        Buffer.from(`/var/lib/spaceapp-user/bin/opencode\0attach\0http://127.0.0.1:4200\0--session\0${nativeSessionId}\0`)
      );
      await writeFile(join(procRoot, pid, "task", pid, "children"), "");
    }

    await expect(readOpenCodeNativeSessionIdFromProcessTree(4201, procRoot)).resolves.toBeNull();
  });
});
