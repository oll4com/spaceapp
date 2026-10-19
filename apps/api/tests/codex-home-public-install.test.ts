import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";

const execFileAsync = promisify(execFile);

// A public install runs Codex in its CLI container (CODEX_HOME /var/lib/spaceapp-cli/providers/codex, named to the API by
// SPACE_CODEX_HOME in its compose file); stable and dev leave SPACE_CODEX_HOME unset (1.1.7, task:xY6KPcDLwGL9).
describe("Codex home of the install the pane runs in", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it("keeps stable's Codex home when SPACE_CODEX_HOME is unset", async () => {
    vi.stubEnv("SPACE_CODEX_HOME", "");
    vi.resetModules();
    expect((await import("../src/cli-parity.js")).codexDirectParityCodexHome).toBe("/var/lib/spaceapp-user/.codex");
  });

  it("finds a public install's running Codex turn in the Codex home SPACE_CODEX_HOME names", async () => {
    const home = await mkdtemp(join(tmpdir(), "space-codex-home-"));
    try {
      const threadId = "019f4434-0000-7000-8000-0000000117c7";
      const rollout = join(home, "sessions/2026/10/18", `rollout-2026-10-18T00-00-05-${threadId}.jsonl`);
      await mkdir(dirname(rollout), { recursive: true });
      await writeFile(rollout, [
        { type: "session_meta", payload: { id: threadId, cwd: "/workspaces/room" } },
        { type: "turn_context", payload: { turn_id: "turn-1", model: "gpt-5.6-sol" } },
        { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }
      ].map((line) => JSON.stringify(line)).join("\n") + "\n");
      await execFileAsync("sqlite3", [join(home, "state_5.sqlite"),
        `CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL); INSERT INTO threads VALUES ('${threadId}', '${rollout}');`]);
      vi.stubEnv("SPACE_CODEX_HOME", home);
      vi.resetModules();
      const { codexDirectParityCodexHome } = await import("../src/cli-parity.js");
      const { CliTerminalManager } = await import("../src/cli-terminal.js");
      const { getApiConfig } = await import("../src/config.js");
      expect(codexDirectParityCodexHome).toBe(home);
      const store = new InMemorySpaceStore();
      const room = store.createRoom({ name: "Public install", initialPaneCount: 0 });
      const pane = store.createPane({ roomId: room.id, title: "Andy", mode: "TERMINAL", terminalRuntimeId: "cli:codex" });
      const session = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex",
        codexThreadId: threadId, status: "RUNNING", isActive: true });
      const manager = new CliTerminalManager({ store, config: getApiConfig({}), discoverRuntimes: vi.fn() });
      expect(await manager.getCurrentTurnActivity(session.sessionId)).toEqual({ status: "RUNNING", turnId: "turn-1" });
      await writeFile(rollout, `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } })}\n`, { flag: "a" });
      expect(await manager.getCurrentTurnActivity(session.sessionId)).toEqual({ status: "COMPLETED", turnId: "turn-1" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("binds and reads a pane's thread through sessions/ alone: no state database, no auth.json", async () => {
    // The 1.1.7 public compose mounts only providers/codex/sessions into the API container, read-only.
    const home = await mkdtemp(join(tmpdir(), "space-codex-sessions-"));
    try {
      vi.stubEnv("SPACE_CODEX_HOME", home);
      vi.resetModules();
      const { CliTerminalManager } = await import("../src/cli-terminal.js");
      const { getApiConfig } = await import("../src/config.js");
      const { findCodexThreadInSessions } = await import("../src/codex-sessions.js");
      const store = new InMemorySpaceStore();
      const room = store.createRoom({ name: "Public install", initialPaneCount: 0 });
      const pane = store.createPane({ roomId: room.id, title: "Andy", mode: "TERMINAL", terminalRuntimeId: "cli:codex" });
      const session = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex",
        cwd: "/workspaces/room-a", status: "RUNNING", isActive: true });
      const startMs = Date.parse(session.startedAt);
      const day = join(home, "sessions", new Date(startMs).toISOString().slice(0, 10).replaceAll("-", "/"));
      await mkdir(day, { recursive: true });
      const rollout = async (threadId: string, cwd: string, offsetMs: number, turn: boolean) => {
        const at = new Date(startMs + offsetMs).toISOString();
        await writeFile(join(day, `rollout-${at.slice(0, 19).replaceAll(":", "-")}-${threadId}.jsonl`), [
          { timestamp: at, type: "session_meta", payload: { id: threadId, timestamp: at, cwd } },
          ...(turn ? [{ type: "turn_context", payload: { turn_id: "turn-3" } }, { type: "event_msg", payload: { type: "task_started", turn_id: "turn-3" } }] : [])
        ].map((line) => JSON.stringify(line)).join("\n") + "\n");
      };
      await rollout("019f4434-0000-7000-8000-0000000000a1", "/workspaces/room-a", -60_000, false);
      await rollout("019f4434-0000-7000-8000-0000000000b2", "/workspaces/room-b", 3_000, false);
      await rollout("019f4434-0000-7000-8000-0000000000c3", "/workspaces/room-a", 5_000, true);
      const manager = new CliTerminalManager({ store, config: getApiConfig({}), discoverRuntimes: vi.fn() });
      expect(await manager.getCurrentTurnActivity(session.sessionId)).toEqual({ status: "RUNNING", turnId: "turn-3" });
      expect((await store.getPaneCliSession(session.sessionId))?.codexThreadId).toBe("019f4434-0000-7000-8000-0000000000c3");
      // Two candidate threads in the same folder after the start: none is bound.
      await rollout("019f4434-0000-7000-8000-0000000000d4", "/workspaces/room-a", 9_000, false);
      expect(await findCodexThreadInSessions({ codexHome: home, cwd: "/workspaces/room-a", sinceMs: startMs })).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
