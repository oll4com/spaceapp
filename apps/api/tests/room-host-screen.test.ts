import { describe, expect, it, vi } from "vitest";
import { readRoomHostScreen } from "../src/room-host-screen.js";
import { projectRoomTerminalScreen, roomTerminalMode, roomTerminalState, restoreRoomTerminalGeometry, roomComposerEmpty } from "../src/room-terminal-screen.js";
import { CliTerminalManager } from "../src/cli-terminal.js";
import { getApiConfig } from "../src/config.js";
import { dashboardScreenState } from "../src/agents-dashboard.js";
import { InMemorySpaceStore } from "@space/runtime";

const identity = { cliSessionId: "cli_session:proof", paneId: "pane:proof", roomId: "room:proof", runtimeId: "cli:opencode", codexThreadId: null, modelId: null, reasoningEffort: null };
describe("Room Agent host screen observer", () => {
  it("reads a resumed OpenCode host after its observer disconnects, without an API-managed transport", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Unmanaged OpenCode", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "OpenCode", mode: "TERMINAL", terminalRuntimeId: "cli:opencode" });
    const session = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:opencode", providerId: "opencode", agentId: "opencode", status: "RUNNING" });
    store.updatePaneCliTerminalGeometry(session.sessionId, { generationId: "current-host", cols: 61, rows: 74 });
    // No DB transcript and no manager attach. The independent host still owns
    // the complete composer and its real revision.
    let generationId = "current-host";
    const host = {
      attach: vi.fn(async () => ({ attachmentId: "observer", session: { generationId, nextOutputSequence: 123 }, replay: [{
        data: "\x1b[70;3H┃\x1b[71;3H┃  Build · Model\x1b[72;3H╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\x1b[73;4H/etc  15.6K (1%)  ctrl+p commands"
      }] })),
      detach: vi.fn(async () => true), input: vi.fn(), resize: vi.fn(), terminate: vi.fn()
    };
    const manager = new CliTerminalManager({ store, config: getApiConfig({}), hostClient: host as never,
      discoverRuntimes: vi.fn() });
    const observation = await manager.observeRoomScreen(session.sessionId);
    expect(observation.revision).toBe(123);
    expect(roomTerminalMode("cli:opencode", observation.text, ["build"])).toBe("build");
    expect(host.attach.mock.calls[0]).toEqual([{ identity: expect.objectContaining({ cliSessionId: session.sessionId, roomId: room.id, paneId: pane.id }), afterSequence: -1 }]);
    generationId = "different-host";
    expect(await manager.observeRoomScreen(session.sessionId)).toEqual({ text: "", revision: 0 });
    expect(host.detach).toHaveBeenCalledTimes(2);
    expect(host.input).not.toHaveBeenCalled();
    expect(host.resize).not.toHaveBeenCalled();
    expect(host.terminate).not.toHaveBeenCalled();
  });
  it("reads Hermes from its host once the DB tail holds only its status-bar timer, and falls back to that tail", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Hermes", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Leo", mode: "TERMINAL", terminalRuntimeId: "cli:hermes" });
    const session = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:hermes", providerId: "hermes", agentId: "hermes", status: "RUNNING" });
    // Observed 2026-10-17 (pane Leo): Hermes rewrites only the changed part of its status bar every second.
    const frame = "\x1b[2J\x1b[27;2H ┊  Provider said: HTTP 429\x1b[29;2H─ ready │ big pickle │ 5m 16s │ ✓ 5m 4s │ voice off\x1b[30;2H❯ ";
    const ticks = Array.from({ length: 250 }, (_, i) => `\x1b[29;23H${5 + Math.floor(i / 60)}m ${i % 60}s │ ✓ 5m 5s │ voice of`);
    for (const content of [frame, ...ticks]) store.appendPaneCliTranscriptChunkAtNextSequence({ sessionId: session.sessionId, paneId: pane.id, roomId: room.id, stream: "stdout", content });
    const host = {
      attach: vi.fn(async () => ({ attachmentId: "observer", session: { generationId: "hermes-host", nextOutputSequence: 251 },
        replay: [frame, ...ticks].map((data) => ({ data })) })),
      detach: vi.fn(async () => true), input: vi.fn(), resize: vi.fn(), terminate: vi.fn()
    };
    const manager = new CliTerminalManager({ store, config: getApiConfig({}), hostClient: host as never, discoverRuntimes: vi.fn() });
    // Without confirmed geometry the DB tail stays the source: deltas alone are not a state.
    expect(roomTerminalState((await manager.observeRoomScreen(session.sessionId)).text)).toBe("UNKNOWN");
    expect(host.attach).not.toHaveBeenCalled();
    store.updatePaneCliTerminalGeometry(session.sessionId, { generationId: "hermes-host", cols: 99, rows: 30 });
    const observation = await manager.observeRoomScreen(session.sessionId);
    expect(roomTerminalState(observation.text)).toBe("IDLE");
    expect(observation.text).toContain("─ ready │ big pickle");
    host.attach.mockRejectedValueOnce(new Error("host unavailable"));
    expect(roomTerminalState((await manager.observeRoomScreen(session.sessionId)).text)).toBe("UNKNOWN");
    expect(host.input).not.toHaveBeenCalled();
    expect(host.resize).not.toHaveBeenCalled();
  });
  it("reads Codex from its host where its native turn tracking is off (public installs), and the DB tail where it is on", async () => {
    // Recorded 2026-10-18 (Codex 0.145.0, 1.1.6 lab): about 40 writes a second while working, each rewriting only the
    // spinner, one shimmer letter and the seconds digit, so within ~6 s the 256-chunk tail no longer holds
    // "(… esc to interrupt)" and the dashboard reads the running turn as idle.
    const frame = "\x1b[2J\x1b[40;1H• Working (0s • esc to interrupt)\x1b[42;1H› Run /review on my current changes\x1b[44;3Hgpt-5.6-sol default · /workspaces/room";
    const ticks = Array.from({ length: 300 }, (_, i) =>
      `\x1b[?2026h\x1b[40;34H\x1b[K\x1b[40;1H\x1b[1m•\x1b[40;${3 + (i % 7)}H${"Working"[i % 7]}\x1b[0m\x1b[40;12H\x1b[2m${Math.floor(i / 40) % 10}\x1b[0m\x1b[?2026l`);
    const setup = (env: Record<string, string>) => {
      const store = new InMemorySpaceStore();
      const room = store.createRoom({ name: "Codex", initialPaneCount: 0 });
      const pane = store.createPane({ roomId: room.id, title: "Andy", mode: "TERMINAL", terminalRuntimeId: "cli:codex" });
      const session = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex", status: "RUNNING" });
      for (const content of [frame, ...ticks]) store.appendPaneCliTranscriptChunkAtNextSequence({ sessionId: session.sessionId, paneId: pane.id, roomId: room.id, stream: "stdout", content });
      store.updatePaneCliTerminalGeometry(session.sessionId, { generationId: "codex-host", cols: 120, rows: 45 });
      const host = {
        attach: vi.fn(async () => ({ attachmentId: "observer", session: { generationId: "codex-host", nextOutputSequence: 301 },
          replay: [frame, ...ticks].map((data) => ({ data })) })),
        detach: vi.fn(async () => true), input: vi.fn(), resize: vi.fn(), terminate: vi.fn()
      };
      return { session, host, manager: new CliTerminalManager({ store, config: getApiConfig(env), hostClient: host as never, discoverRuntimes: vi.fn() }) };
    };
    const tail = await projectRoomTerminalScreen([frame, ...ticks].slice(-256), 120, 45);
    expect(dashboardScreenState(tail).state).not.toBe("RUNNING");
    const publicInstall = setup({});
    expect(dashboardScreenState((await publicInstall.manager.observeRoomScreen(publicInstall.session.sessionId)).text).state).toBe("RUNNING");
    expect(publicInstall.host.attach).toHaveBeenCalledTimes(1);
    expect(publicInstall.host.input).not.toHaveBeenCalled();
    const stable = setup({ SPACE_ENABLE_CODEX_TURNS: "true" });
    await stable.manager.observeRoomScreen(stable.session.sessionId);
    expect(stable.host.attach).not.toHaveBeenCalled();
  });

  it("reads a detached Qoder from its host, not the DB tail that stopped at its spinner", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Qoder", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Cody", mode: "TERMINAL", terminalRuntimeId: "cli:qoder" });
    const session = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:qoder", providerId: "qoder", agentId: "qoder", status: "RUNNING" });
    store.updatePaneCliTerminalGeometry(session.sessionId, { generationId: "qoder-host", cols: 100, rows: 30 });
    // Observed 2026-10-17 (pane Cody): the browser detached mid-turn, so the DB kept this frame for 2.5 h.
    const spinner = "\x1b[2J\x1b[1;2H⠦ Generating... (esc to cancel, 14s)          ? for shortcuts\x1b[4;2H*   Type your message or @path/to/file";
    store.appendPaneCliTranscriptChunkAtNextSequence({ sessionId: session.sessionId, paneId: pane.id, roomId: room.id, stream: "stdout", content: spinner });
    const done = "\x1b[2J\x1b[1;2H▪ PASS: MCP dispatcher\x1b[3;2HShift+Tab to Accept Edits\x1b[5;2H>   Type your message or @path/to/file\x1b[7;2HClaude Opus 5.5 (API credits) (space-gateway-claude) Model · Extra High · ctx 3% · /etc";
    const host = {
      attach: vi.fn(async () => ({ attachmentId: "observer", session: { generationId: "qoder-host", nextOutputSequence: 2 }, replay: [{ data: spinner }, { data: done }] })),
      detach: vi.fn(async () => true), input: vi.fn(), resize: vi.fn(), terminate: vi.fn()
    };
    const manager = new CliTerminalManager({ store, config: getApiConfig({}), hostClient: host as never, discoverRuntimes: vi.fn() });
    expect(roomTerminalState(await projectRoomTerminalScreen([spinner]))).toBe("RUNNING");
    const observation = await manager.observeRoomScreen(session.sessionId);
    expect(roomTerminalState(observation.text)).toBe("IDLE");
    expect(observation.text).toContain("Claude Opus 5.5 (API credits) (space-gateway-claude) Model");
    expect(host.input).not.toHaveBeenCalled();
    expect(host.resize).not.toHaveBeenCalled();
  });
  it("reads a detached Claude Code from its host, plain and undimmed, not the DB tail frozen at its spinner", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Claude", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Space", mode: "TERMINAL", terminalRuntimeId: "cli:claude" });
    const session = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "anthropic", agentId: "claude", status: "RUNNING" });
    store.updatePaneCliTerminalGeometry(session.sessionId, { generationId: "claude-host", cols: 100, rows: 30 });
    // Observed 2026-10-21 00:13 UTC: the last browser detached mid-turn and the DB kept this frame for 33 minutes.
    const spinner = "\x1b[2J\x1b[1;2H✶ Fiddle-faddling… ↓ 805 tokens";
    store.appendPaneCliTranscriptChunkAtNextSequence({ sessionId: session.sessionId, paneId: pane.id, roomId: room.id, stream: "stdout", content: spinner });
    // Finished: an empty composer holding Claude's faint prompt suggestion (SGR 2).
    const done = "\x1b[2J\x1b[1;2H✻ Cooked for 3s\x1b[3;1H────────\x1b[4;1H❯ \x1b[2mTry running the tests\x1b[22m\x1b[5;1H────────";
    const host = {
      attach: vi.fn(async () => ({ attachmentId: "observer", session: { generationId: "claude-host", nextOutputSequence: 2 }, replay: [{ data: spinner }, { data: done }] })),
      detach: vi.fn(async () => true), input: vi.fn(), resize: vi.fn(), terminate: vi.fn()
    };
    const manager = new CliTerminalManager({ store, config: getApiConfig({}), hostClient: host as never, discoverRuntimes: vi.fn() });
    expect(roomTerminalState(await projectRoomTerminalScreen([spinner]))).toBe("UNKNOWN");
    expect(roomTerminalState((await manager.observeRoomScreen(session.sessionId)).text)).toBe("IDLE");
    expect(roomComposerEmpty(await manager.observeRoomScreenUndimmed(session.sessionId))).toBe(true);
    expect(host.input).not.toHaveBeenCalled();
    expect(host.resize).not.toHaveBeenCalled();
    // One live read per pane and view serves the next callers for ~2 s.
    await manager.observeRoomScreen(session.sessionId);
    await manager.observeRoomScreenUndimmed(session.sessionId);
    expect(host.attach).toHaveBeenCalledTimes(2);
  });

  it("leaves a detached Claude Code the DB tail when its host does not answer within 1.5 s", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Claude", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Slow host", mode: "TERMINAL", terminalRuntimeId: "cli:claude" });
    const session = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "anthropic", agentId: "claude", status: "RUNNING" });
    store.updatePaneCliTerminalGeometry(session.sessionId, { generationId: "claude-host", cols: 100, rows: 30 });
    store.appendPaneCliTranscriptChunkAtNextSequence({ sessionId: session.sessionId, paneId: pane.id, roomId: room.id, stream: "stdout", content: "\x1b[2J\x1b[1;1H❯ " });
    const host = { attach: vi.fn(() => new Promise(() => {})), detach: vi.fn(async () => true), input: vi.fn(), resize: vi.fn(), terminate: vi.fn() };
    const manager = new CliTerminalManager({ store, config: getApiConfig({}), hostClient: host as never, discoverRuntimes: vi.fn() });
    const started = Date.now();
    expect(roomTerminalState((await manager.observeRoomScreen(session.sessionId)).text)).toBe("IDLE");
    expect(Date.now() - started).toBeLessThan(3_000);
  });
  it("restores confirmed tall-pane dimensions after API restart and rejects another host generation", async () => {
    const persisted = { generationId: "host-generation", cols: 61, rows: 74 };
    const geometry = restoreRoomTerminalGeometry("host-generation", true, persisted, { cols: 100, rows: 30 })!;
    const composer = "\x1b[2J\x1b[70;3H┃\x1b[71;3H┃  Build   Muse Spark 1.2 Free OpenCode Zen\x1b[72;3H╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\x1b[73;4H/etc     15.6K (1%)  ctrl+p commands";
    expect(roomTerminalMode("cli:opencode", await projectRoomTerminalScreen([composer]), ["build", "plan"])).toBeNull();
    const screen = await projectRoomTerminalScreen([composer], geometry.cols, geometry.rows);
    expect(roomTerminalMode("cli:opencode", screen, ["build", "plan"])).toBe("build");
    expect(restoreRoomTerminalGeometry("replacement", true, persisted)).toBeNull();
    expect(restoreRoomTerminalGeometry("host-generation", true, null, { cols: 61, rows: 74 })).toBeNull();
    expect(restoreRoomTerminalGeometry("replacement", false, persisted)).toEqual({ cols: 100, rows: 30 });
    expect(roomTerminalMode("cli:opencode", "Build   historical output\ntab agents", ["build"])).toBeNull();
  });
  it("retains the unchanged composer after more than 200 animation chunks, without modifying the live pane", async () => {
    const composer = "\x1b[2J\x1b[26;3H┃\x1b[27;3H┃  Build · Muse Spark 1.2 Free OpenCode Zen\x1b[28;3H╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\x1b[29;4H/etc\x1b[29;72H15.9K (2%)  ctrl+p commands";
    const chunks = [composer, ...Array.from({ length: 300 }, (_, i) => `\x1b[10;6HThought · ${i}ms`)];
    const host = {
      attach: vi.fn(async () => ({ attachmentId: "observer", session: {} as never,
        replay: chunks.map((data, sequence) => ({ type: "output" as const, stream: "stdout" as const, generationId: "generation", sequence, data })) })),
      detach: vi.fn(async () => true), input: vi.fn(), resize: vi.fn(), terminate: vi.fn()
    };
    expect(roomTerminalMode("cli:opencode", await projectRoomTerminalScreen(chunks.slice(-200)), ["build", "plan"])).toBeNull();
    const screen = await readRoomHostScreen(host, identity, 100, 30);
    expect(roomTerminalMode("cli:opencode", screen, ["build", "plan"])).toBe("build");
    expect(host.attach).toHaveBeenCalledExactlyOnceWith({ identity, afterSequence: -1 });
    expect(host.detach).toHaveBeenCalledExactlyOnceWith(identity, "observer");
    expect(host.input).not.toHaveBeenCalled();
    expect(host.resize).not.toHaveBeenCalled();
    expect(host.terminate).not.toHaveBeenCalled();
  });
  it("propagates missing host replay without spawning or detaching another attachment", async () => {
    const host = { attach: vi.fn(async () => { throw Error("CLI_HOST_REPLAY_GAP"); }), detach: vi.fn() };
    await expect(readRoomHostScreen(host, identity, 100, 30)).rejects.toThrow("CLI_HOST_REPLAY_GAP");
    expect(host.detach).not.toHaveBeenCalled();
    expect(host.attach.mock.calls[0]).toEqual([{ identity, afterSequence: -1 }]);
  });
  it("preserves the composer and ANSI state across more than 1 MiB of animation deltas", async () => {
    const composer = "\x1b[?1049h\x1b[2J\x1b[26;3H┃\x1b[27;3H┃  Plan · Muse Spark 1.2 Free OpenCode Zen\x1b[28;3H╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\x1b[29;4H/etc\x1b[29;72H15.9K (2%)  ctrl+p commands";
    const deltas = "\x1b[10;6HThought · 1234ms".repeat(50_000);
    expect(Buffer.byteLength(deltas)).toBeGreaterThan(1_048_576);
    const screen = await projectRoomTerminalScreen([composer, deltas]);
    expect(roomTerminalMode("cli:opencode", screen, ["build", "plan"])).toBe("plan");
  });
  it("rejects oversized replay instead of guessing from a truncated ANSI stream", async () => {
    await expect(projectRoomTerminalScreen(["x".repeat(8 * 1024 * 1024 + 1)])).rejects.toThrow("projection limit");
  });
});

describe("Room screen projection without faint text", () => {
  it("blanks faint cells such as a composer suggestion and keeps normal text", async () => {
    // Claude Code draws its prompt suggestion faint (SGR 2) in an otherwise empty composer.
    const chunks = ["Normal \x1b[2mfaint\x1b[22m kept\r\n❯ \x1b[2mrun the tests\x1b[22m\r\n❯ typed draft"];
    expect(await projectRoomTerminalScreen(chunks, 40, 5)).toContain("❯ run the tests");
    const undimmed = (await projectRoomTerminalScreen(chunks, 40, 5, true, true)).split("\n");
    expect(undimmed.slice(0, 3)).toEqual(["Normal       kept", "❯", "❯ typed draft"]);
  });
});
