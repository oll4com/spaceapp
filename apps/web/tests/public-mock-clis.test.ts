import { describe, expect, it } from "vitest";
import { DemoStore } from "../src/demo/DemoStore.js";
import { createCurrentMockFixture } from "../src/demo/mock-fixture.js";
import { createDemoRuntime } from "../src/demo/demo-runtime.js";
import { CLI_MOCK_DEFINITIONS, getCliMockTranscript, handleCliMockInput } from "../src/demo/mock-cli-transcripts.js";
import { CLI_PANE_TYPES } from "@space/contracts";
import { createTerminalBootstrapBarrier } from "../src/features/terminal-pane/index.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

describe("public mock all CLI panes & timezone", () => {
  it("has distinct mock transcripts for all 16 CLI pane types plus root", () => {
    expect(CLI_PANE_TYPES).toHaveLength(16);
    const transcriptSet = new Set<string>();

    for (const cli of CLI_PANE_TYPES) {
      expect(CLI_MOCK_DEFINITIONS[cli.id]).toBeDefined();
      const def = CLI_MOCK_DEFINITIONS[cli.id]!;
      expect(def.displayName).toBe(cli.displayName);
      expect(def.transcript.length).toBeGreaterThan(100);
      expect(transcriptSet.has(def.transcript)).toBe(false);
      transcriptSet.add(def.transcript);
    }

    expect(CLI_MOCK_DEFINITIONS["cli:root"]).toBeDefined();
    expect(transcriptSet.has(CLI_MOCK_DEFINITIONS["cli:root"]!.transcript)).toBe(false);
    transcriptSet.add(CLI_MOCK_DEFINITIONS["cli:root"]!.transcript);
    expect(transcriptSet.size).toBe(17);
  });

  it("creates and serves active sessions for all 16 CLIs through createRoomPanes", async () => {
    const { runtime } = createDemoRuntime({ fixture: createCurrentMockFixture() });
    const rooms = (await runtime.api.rooms()).data;
    const targetRoomId = rooms[2]!.id; // Empty Operations room

    for (const cli of CLI_PANE_TYPES) {
      const created = await runtime.api.createRoomPanes(targetRoomId, {
        panes: [{ mode: "TERMINAL", terminalRuntimeId: cli.id }]
      });
      const newPane = created.data[0]!;
      expect(newPane.terminalRuntimeId).toBe(cli.id);

      const session = await runtime.api.activeCliSession(newPane.id);
      expect(session).not.toBeNull();
      expect(session!.session.runtimeId).toBe(cli.id);
      expect(session!.runtime.displayName).toBe(cli.displayName);
      expect(session!.transcript[0]!.content).toBe(getCliMockTranscript(cli.id));

      const socket = runtime.terminal.connect(runtime.api.cliTerminalWebSocketUrl(session!.websocket!));
      const ready = await new Promise<any>((resolve) =>
        socket.addEventListener("message", (e) => {
          const data = JSON.parse(e.data);
          if (data.type === "ready") resolve(data);
        })
      );
      expect(ready).toMatchObject({
        paneId: newPane.id,
        sessionId: session!.session.sessionId,
        runtimeId: cli.id
      });
      socket.close();
    }
  });

  it("handles interactive terminal socket input gracefully per CLI", () => {
    for (const cli of CLI_PANE_TYPES) {
      const clearOutput = handleCliMockInput(cli.id, "clear");
      expect(clearOutput).toContain("\x1b[2J");

      const diffOutput = handleCliMockInput(cli.id, "git diff");
      expect(diffOutput.length).toBeGreaterThan(20);

      const testOutput = handleCliMockInput(cli.id, "npm test");
      expect(testOutput.length).toBeGreaterThan(20);

      const helpOutput = handleCliMockInput(cli.id, "help");
      expect(helpOutput.length).toBeGreaterThan(20);

      const customOutput = handleCliMockInput(cli.id, "my custom task");
      expect(customOutput).toContain("my custom task");
    }
  });

  it("defaults to UTC timezone in mock fixture settings", () => {
    const fixture = createCurrentMockFixture();
    expect(fixture.auth.settings?.dateTime.timeZone).toBe("UTC");
  });

  it("creates all 16 CLIs in a single batch and resolves terminal bootstrap barrier immediately", async () => {
    const { runtime } = createDemoRuntime({ fixture: createCurrentMockFixture() });
    installSpaceRuntime(runtime);
    const rooms = (await runtime.api.rooms()).data;
    const targetRoomId = rooms[2]!.id; // Empty room

    const batch = await runtime.api.createRoomPanes(targetRoomId, {
      panes: CLI_PANE_TYPES.map((cli) => ({ mode: "TERMINAL", terminalRuntimeId: cli.id }))
    });
    expect(batch.data).toHaveLength(16);

    const paneIds = batch.data.map((p) => p.id);
    const barrier = createTerminalBootstrapBarrier(paneIds);

    // In demo mode, bootstrap barrier must be immediately released with zero delay
    for (const paneId of paneIds) {
      const participant = barrier.join(paneId);
      await participant.arrive();
      await barrier.waitForTerminalSetupTask(paneId);
    }
  });
});
