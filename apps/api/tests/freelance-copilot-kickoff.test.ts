import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { Pane, PaneCliSession } from "@space/contracts";
import { InMemoryFreelanceCopilotRepository } from "@space/db";
import { InMemorySpaceStore, SpaceEventBus } from "@space/runtime";
import { registerFreelanceCopilot } from "../src/freelance-copilot/wiring.js";

describe("freelance copilot kickoff", () => {
  it("starts the pane's CLI when it is not running and types the kickoff once the composer is ready", async () => {
    const app = Fastify();
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Freelance", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Freelance Copilot", mode: "FREELANCE_COPILOT", terminalRuntimeId: "cli:claude" });
    const started = { sessionId: "cli_session:started1", status: "RUNNING" } as PaneCliSession;
    const terminal = {
      ensurePaneControlReady: vi.fn(async () => started),
      runSerializedTerminalMutation: vi.fn(async (_id: string, task: () => Promise<unknown>) => task()),
      sendInput: vi.fn(async () => ({ turnMarker: null, markerAtMs: 0 }))
    };
    const service = registerFreelanceCopilot(app, {
      store, eventBus: new SpaceEventBus(), databaseUrl: null, repository: new InMemoryFreelanceCopilotRepository(),
      crypto: { seal: (value: string) => value, open: (value: string) => value }, mailboxes: { open: vi.fn() },
      terminal: terminal as never, notifications: { raise: vi.fn(), resolve: vi.fn() } as never, roomOwner: async () => "user:operator", scheduler: false,
      routeOptions: {}, log: { warn: vi.fn() }, parseBody: (schema, body) => schema.parse(body), parseQuery: (schema, query) => schema.parse(query),
      authenticatedOwner: async () => "user:operator", assertPaneAccess: async () => undefined, audit: async () => undefined
    });
    await app.ready();
    try {
      await service.createBrief("user:operator", pane as Pane, { text: "Register on Contra" });
      const response = await app.inject({ method: "POST", url: `/api/panes/${encodeURIComponent(pane.id)}/freelance-copilot/run/start` });
      expect(response.json()).toMatchObject({ status: "RUNNING", kickoffSent: true });
      expect(terminal.ensurePaneControlReady).toHaveBeenCalledWith(expect.objectContaining({ id: pane.id }), expect.stringMatching(/^freelance-copilot:flrun:/));
      const [kickoff] = terminal.sendInput.mock.calls;
      expect(kickoff?.[0]).toBe("cli_session:started1");
      expect(String(kickoff?.[1])).toContain("space_freelance_next");
      expect(kickoff?.[5]).toBe(true);
    } finally {
      await app.close();
    }
  });
});
