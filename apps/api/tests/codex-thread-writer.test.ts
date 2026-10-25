import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCodexWriterThreads } from "../src/codex-thread-writer.js";

describe("native Codex writer ownership", () => {
  it("finds an actual resumed writer and rejects unlocked files and other session supervisors", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-writer-test-"));
    const id = "01a0c6e6-0ce0-7030-9b80-ab326b9605c6";
    const locks = join(root, "thread-writer-locks");
    const runtime = join(root, "space-app-servers", "pane_test--cli_session_test");
    await mkdir(locks, { recursive: true }); await mkdir(runtime, { recursive: true });
    await writeFile(join(locks, "01a0c6e6-0000-7030-9b80-ab326b9605c6.lock"), "");
    const child = spawn("python3", ["-u", "-c", "import fcntl,sys; f=open(sys.argv[1],'w'); fcntl.flock(f,fcntl.LOCK_EX); print('ready'); sys.stdin.read()", join(locks, id + ".lock")]);
    try {
      await once(child.stdout!, "data");
      const lookup = { codexHome: root, paneId: "pane:test", sessionId: "cli_session:test" };
      await writeFile(join(runtime, "app-server.pid"), String(child.pid));
      expect(await findCodexWriterThreads(lookup)).toEqual([id]);
      await writeFile(join(runtime, "app-server.pid"), "999999999");
      expect(await findCodexWriterThreads(lookup)).toEqual([]);
      await writeFile(join(runtime, "app-server.pid"), "../invalid");
      expect(await findCodexWriterThreads(lookup)).toEqual([]);
      child.stdin!.end(); await once(child, "exit");
      await writeFile(join(runtime, "app-server.pid"), String(process.pid));
      expect(await findCodexWriterThreads(lookup)).toEqual([]);
    } finally { if (child.exitCode === null) child.kill(); await rm(root, { recursive: true, force: true }); }
  });
});
