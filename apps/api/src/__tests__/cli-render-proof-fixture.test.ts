import { describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import type { AgentRuntime } from "@space/contracts";
import type { CliHostIdentity } from "@space/cli-host";
import type { WebSocket } from "ws";
import { CliTerminalManager, type CliHostGateway } from "../cli-terminal.js";
import type { SpaceApiConfig } from "../config.js";
import {
  cliRenderProofDescription,
  createCliRenderProofFixture,
  isCliRenderProofSession,
  startCliRenderProofFixture
} from "../cli-render-proof-fixture.js";

function fixtureHost() {
  const running = new Map<string, CliHostIdentity>();
  const attach = vi.fn(async ({ identity, spawn }: Parameters<CliHostGateway["attach"]>[0]) => {
    if (spawn) {
      expect(spawn.command).toBe(process.execPath);
      expect(spawn.args.slice(0, 2)).toEqual(["--input-type=module", "-e"]);
      running.set(identity.cliSessionId, identity);
    }
    expect(running.has(identity.cliSessionId)).toBe(true);
    return {
      attachmentId: `attachment:${identity.cliSessionId}`,
      replay: [],
      session: {
        ...identity,
        generationId: "generation:test",
        pid: 123,
        status: "RUNNING" as const,
        statusReason: null,
        exitCode: null,
        signal: null,
        nextOutputSequence: 0,
        attachmentCount: 1,
        startedAt: new Date().toISOString(),
        detachedAt: null,
        endedAt: null
      }
    };
  });
  const input = vi.fn(async (_identity: CliHostIdentity, _attachmentId: string, _data: string) => ({ accepted: true, acceptedAtMs: Date.now() }));
  const inspect = vi.fn(async (identity: CliHostIdentity) => running.has(identity.cliSessionId)
    ? { ...identity, status: "RUNNING" as const } as Awaited<ReturnType<CliHostGateway["inspect"]>>
    : null);
  const host = {
    attach,
    input,
    inspect,
    detach: vi.fn(async () => true),
    terminate: vi.fn(async () => true),
    resize: vi.fn(async () => undefined),
    health: vi.fn(async () => { throw new Error("Unexpected host health request"); }),
    close: vi.fn(async () => undefined)
  } as CliHostGateway & { attach: typeof attach; input: typeof input };
  return { host, attach, input, inspect };
}

describe("synthetic CLI render fixture", () => {
  it("persists RUNNING for all three runtimes before browser attachment and starts only the fixed process", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "CLI render proof", description: cliRenderProofDescription, kind: "AGENT_PROOF", initialPaneCount: 0 });
    const { host, attach, input } = fixtureHost();
    const runtimes = ["cli:codex", "cli:gemini", "cli:opencode"] as const;
    const panes = runtimes.map(runtimeId => store.createPane({ roomId: room.id, title: runtimeId, mode: "TERMINAL", terminalRuntimeId: runtimeId, cwd: "/tmp" }));
    const sessions = [];
    for (const pane of panes) {
      const session = await createCliRenderProofFixture(store, pane, "trace:test", "/unused", host);
      sessions.push(session);
      expect(session.status).toBe("RUNNING");
      expect((await store.getActivePaneCliSession(pane.id))?.status).toBe("RUNNING");
      expect(await isCliRenderProofSession(store, session)).toBe(true);
    }
    expect(attach).toHaveBeenCalledTimes(3);
    expect(attach.mock.calls.every(([call]) => call.spawn?.command === process.execPath)).toBe(true);
    await startCliRenderProofFixture(store, room.id, "/unused", host);
    expect(input).toHaveBeenCalledTimes(3);
    expect(input.mock.calls.every(([, , value]) => value === "SPACE_RENDER_START\n")).toBe(true);
    expect(sessions.map(session => session.runtimeId)).toEqual(runtimes);
  });

  it("rejects a stale IDLE fixture before sending any stream input", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "CLI render proof", description: cliRenderProofDescription, kind: "AGENT_PROOF", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Codex", mode: "TERMINAL", terminalRuntimeId: "cli:codex", cwd: "/tmp" });
    const { host, input } = fixtureHost();
    const session = await createCliRenderProofFixture(store, pane, "trace:test", "/unused", host);
    store.updatePaneCliSession(session.sessionId, { status: "IDLE" });
    await expect(startCliRenderProofFixture(store, room.id, "/unused", host)).rejects.toThrow("session unavailable");
    expect(input).not.toHaveBeenCalled();
  });

  it("never launches a provider CLI when the synthetic host process has disappeared", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "CLI render proof", description: cliRenderProofDescription, kind: "AGENT_PROOF", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Codex", mode: "TERMINAL", terminalRuntimeId: "cli:codex", cwd: "/tmp" });
    const { host, attach, inspect } = fixtureHost();
    const session = await createCliRenderProofFixture(store, pane, "trace:test", "/unused", host);
    attach.mockClear();
    inspect.mockResolvedValue(null);
    const runtime: AgentRuntime = {
      id: "cli:codex", providerId: "codex", providerName: "Codex", agentId: "codex", agentName: "Codex",
      displayName: "Codex", capabilities: ["CLI"], adapterStatus: "ENABLED", authMode: "NONE",
      authState: "READY", authReason: "Ready", canStartLogin: false, status: "ENABLED", statusReason: "",
      commandName: "codex", detectedCommandPath: "/usr/bin/codex", defaultModelId: null,
      supportedReasoningEfforts: [], checkedAt: new Date().toISOString()
    };
    const manager = new CliTerminalManager({
      store, hostClient: host, adminHostClient: host,
      config: { cliHostSocketPath: "/unused", cliAdminHostSocketPath: "/unused" } as SpaceApiConfig,
      discoverRuntimes: async () => ({ data: [runtime], checkedAt: new Date().toISOString() })
    });
    const ticket = manager.issueTicket(pane.id, session.sessionId, 10_000);
    const openConnection = Reflect.get(manager, "openConnection") as (socket: WebSocket, input: object) => Promise<unknown>;
    await expect(openConnection.call(manager, {} as WebSocket, {
      paneId: pane.id, pane, sessionId: session.sessionId, token: ticket.token,
      userId: "user:test", requestId: "req:test", connectionOrder: 1
    })).rejects.toThrow("existing-only attachment");
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(attach).not.toHaveBeenCalled();
    await manager.closeAll();
  });
});
