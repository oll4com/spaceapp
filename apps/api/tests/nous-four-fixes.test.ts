import { describe, expect, it, vi } from "vitest";
import { createNousProviderCatalog } from "../src/nous/providers.js";
import { createNousTools, isClosedPane, sendWorkKeys, type NousToolDeps } from "../src/nous/tools.js";
import type { Pane, Room } from "@space/contracts";

const room: Room = {
  id: "room:dev",
  name: "Dev",
  ownerUserId: "user:operator",
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z"
} as Room;

const context = {
  owner: "user:operator",
  turnId: "turn:123",
  traceId: "trace:123",
  action: "space_send_to_pane",
  toolCalls: 0
};

describe("Four SpaceApp fixes", () => {
  describe("Fix 1: Settings AI models catalog exposes Neon and cooling route models", () => {
    it("exposes gemini-4-neon and gemini-4-neon-high even if snapshot file is missing or empty", async () => {
      const readFileImpl = vi.fn(async () => { throw new Error("ENOENT"); });
      const catalog = createNousProviderCatalog({
        listAccounts: async () => ({
          data: [{ provider: "ANTIGRAVITY", status: "ACTIVE", planType: "subscription" }]
        }),
        readFileImpl
      });

      const list = await catalog.list();
      const gemini = list.find((p) => p.id === "gemini");
      expect(gemini).toBeDefined();
      const modelIds = gemini?.models.map((m) => m.id) ?? [];
      expect(modelIds).toContain("gemini-4-neon");
      expect(modelIds).toContain("gemini-4-neon-high");
    });

    it("exposes gemini-4-neon and gemini-4-neon-high from updated snapshot catalog", async () => {
      const readFileImpl = vi.fn(async () => JSON.stringify({
        models: "gemini-4-neon\tGemini 4 Neon\ngemini-4-neon-high\tGemini 4 Neon (High)\ngemini-3.8-flash-high\tGemini Flash High\n"
      }));
      const catalog = createNousProviderCatalog({
        listAccounts: async () => ({
          data: [{ provider: "ANTIGRAVITY", status: "ACTIVE", planType: "subscription" }]
        }),
        readFileImpl
      });

      const list = await catalog.list();
      const gemini = list.find((p) => p.id === "gemini");
      expect(gemini).toBeDefined();
      const modelIds = gemini?.models.map((m) => m.id) ?? [];
      expect(modelIds).toContain("gemini-4-neon");
      expect(modelIds).toContain("gemini-4-neon-high");
      expect(modelIds).toContain("gemini-3.8-flash-high");
    });

    it("spaceOption exposes all models across configured routes without hiding cooling routes", async () => {
      const catalog = createNousProviderCatalog({
        listAccounts: async () => ({
          data: [
            { provider: "CLAUDE", status: "ACTIVE", planType: "subscription" },
            { provider: "ANTIGRAVITY", status: "ACTIVE", planType: "subscription" }
          ]
        }),
        modelLoaders: {
          claude: async () => [{ id: "claude-opus-5-5", label: "Opus 5.5", efforts: ["high"] }],
          gemini: async () => [{ id: "gemini-4-neon-high", label: "Gemini Neon High", efforts: ["none"] }]
        }
      });

      const list = await catalog.list();
      const space = list.find((p) => p.id === "space");
      expect(space).toBeDefined();
      const spaceModelIds = space?.models.map((m) => m.id) ?? [];
      expect(spaceModelIds.some((id) => id.includes("claude-opus-5-5"))).toBe(true);
      expect(spaceModelIds.some((id) => id.includes("gemini-4-neon-high"))).toBe(true);
      const claude = list.find((p) => p.id === "claude");
      expect(claude?.models.map((m) => m.id)).toContain("claude-opus-5-5");
    });
  });

  describe("Fix 2: Save to memory guard refuses unless target pane is finished and ready to close", () => {
    const makeTools = (overrides: Partial<NousToolDeps> = {}) => {
      const deps: NousToolDeps = {
        rooms: async () => [room],
        listPanes: async () => [],
        allowances: async () => ({ promote: false, warm: false }),
        inspectPane: async () => ({ state: "IDLE", sessionId: "sess:1" } as never),
        roomTool: vi.fn(async () => ({ ok: true, result: "sent" })) as never,
        ...overrides
      };
      return createNousTools(deps);
    };

    const targetPane: Pane = {
      id: "pane:cli1",
      roomId: "room:dev",
      title: "Worker",
      mode: "TERMINAL",
      terminalRuntimeId: "cli:claude",
      isClosed: false,
      createdAt: new Date(Date.now() - 3600_000).toISOString(),
      updatedAt: new Date(Date.now() - 3600_000).toISOString()
    } as Pane;

    it("refuses save to memory when target pane CLI turn is RUNNING", async () => {
      const tools = makeTools({
        listPanes: async () => [targetPane],
        inspectPane: async () => ({ state: "RUNNING", sessionId: "sess:1" } as never)
      });

      const res = await tools.execute("space_send_to_pane", {
        room: "room:dev",
        panes: ["Worker"],
        text: "save to memory"
      }, context as never);

      expect(res.ok).toBe(false);
      expect(res.refused).toBe(true);
      expect(res.display).toMatch(/still works|still work/i);
    });

    it("refuses save to memory when target pane has unfinished work report", async () => {
      const tools = makeTools({
        listPanes: async () => [targetPane],
        inspectPane: async () => ({ state: "IDLE", sessionId: "sess:1" } as never),
        paneLastWorkReport: async () => ({
          status: "PROGRESS",
          summary: "Working on task step 2",
          at: new Date().toISOString()
        } as never)
      });

      const res = await tools.execute("space_send_to_pane", {
        room: "room:dev",
        panes: ["Worker"],
        text: "save to memory"
      }, context as never);

      expect(res.ok).toBe(false);
      expect(res.refused).toBe(true);
      expect(res.display).toMatch(/open work/i);
    });

    it("refuses save to memory when target pane last reported STARTED or BLOCKED", async () => {
      const tools = makeTools({
        listPanes: async () => [targetPane],
        inspectPane: async () => ({ state: "IDLE", sessionId: "sess:1" } as never),
        paneLastReport: async () => ({
          status: "BLOCKED",
          summary: "Awaiting API credentials",
          body: null,
          at: new Date().toISOString()
        } as never)
      });

      const res = await tools.execute("space_send_to_pane", {
        room: "room:dev",
        panes: ["Worker"],
        text: "save to memory"
      }, context as never);

      expect(res.ok).toBe(false);
      expect(res.refused).toBe(true);
      expect(res.display).toMatch(/unfinished work/i);
    });

    it("refuses save to memory when closeouts indicate pane is not ready to close", async () => {
      const tools = makeTools({
        listPanes: async () => [targetPane],
        inspectPane: async () => ({ state: "IDLE", sessionId: "sess:1" } as never),
        closeouts: {
          roomCloseouts: async () => [{
            pane: targetPane,
            state: "idle",
            since: new Date().toISOString(),
            idleMinutes: 2,
            save: "save not asked",
            closable: false,
            skip: "pending-deliverables"
          }]
        }
      });

      const res = await tools.execute("space_send_to_pane", {
        room: "room:dev",
        panes: ["Worker"],
        text: "save to memory"
      }, context as never);

      expect(res.ok).toBe(false);
      expect(res.refused).toBe(true);
      expect(res.display).toMatch(/not ready to close/i);
    });

    it.each([["board-check", true], ["fresh", true], ["keep-open", false]])("27/11: save to memory with closeout skip %s passes: %s", async (skip, passes) => {
      const roomTool = vi.fn(async () => ({ ok: true, result: "sent" }));
      const tools = makeTools({
        listPanes: async () => [targetPane],
        inspectPane: async () => ({ state: "IDLE", sessionId: "sess:1" } as never),
        closeouts: { roomCloseouts: async () => [{ pane: targetPane, state: "done", since: new Date().toISOString(), idleMinutes: 40, save: "save not asked", closable: false, skip }] },
        roomTool: roomTool as never
      });
      const res = await tools.execute("space_send_to_pane", { room: "room:dev", panes: ["Worker"], text: "save to memory" }, context as never);
      expect(res.ok).toBe(passes);
      if (!passes) expect(res.result).toMatch(/kept open \(keep-open\)/);
      expect(roomTool.mock.calls.length > 0).toBe(passes);
    });

    it("allows save to memory when target pane is finished and ready to close", async () => {
      const roomTool = vi.fn(async () => ({ ok: true, result: "sent" }));
      const tools = makeTools({
        listPanes: async () => [targetPane],
        inspectPane: async () => ({ state: "IDLE", sessionId: "sess:1" } as never),
        paneLastWorkReport: async () => ({
          status: "DONE",
          summary: "Task complete",
          at: new Date().toISOString()
        } as never),
        paneLastReport: async () => ({
          status: "DONE",
          summary: "Task complete",
          body: null,
          at: new Date().toISOString()
        } as never),
        closeouts: {
          roomCloseouts: async () => [{
            pane: targetPane,
            state: "done",
            since: new Date().toISOString(),
            idleMinutes: 5,
            save: "save not asked",
            closable: false,
            skip: null
          }]
        },
        roomTool: roomTool as never
      });

      const res = await tools.execute("space_send_to_pane", {
        room: "room:dev",
        panes: ["Worker"],
        text: "save to memory"
      }, context as never);

      expect(res.ok).toBe(true);
      expect(roomTool).toHaveBeenCalled();
    });
  });

  describe("Fix 3: Pane-name resolution open panes win over closed panes", () => {
    it("isClosedPane recognizes isClosed and is_closed flags", () => {
      expect(isClosedPane({ isClosed: true } as Pane)).toBe(true);
      expect(isClosedPane({ is_closed: true } as unknown as Pane)).toBe(true);
      expect(isClosedPane({ isClosed: false } as Pane)).toBe(false);
      expect(isClosedPane({ is_closed: false } as unknown as Pane)).toBe(false);
      expect(isClosedPane({} as Pane)).toBe(false);
    });

    it("resolves pane name to the open pane when room contains an older closed pane with the same name", async () => {
      const olderClosedPane: Pane = {
        id: "pane:old_closed",
        roomId: "room:dev",
        paneName: "Worker",
        title: "Worker",
        mode: "TERMINAL",
        terminalRuntimeId: "cli:claude",
        isClosed: true,
        createdAt: "2026-11-01T00:00:00Z"
      } as Pane;

      const newerOpenPane: Pane = {
        id: "pane:new_open",
        roomId: "room:dev",
        paneName: "Worker",
        title: "Worker",
        mode: "TERMINAL",
        terminalRuntimeId: "cli:claude",
        isClosed: false,
        createdAt: "2026-11-02T00:00:00Z"
      } as Pane;

      const roomTool = vi.fn(async () => ({ ok: true, result: "sent" }));
      const tools = createNousTools({
        rooms: async () => [room],
        listPanes: async () => [olderClosedPane, newerOpenPane],
        allowances: async () => ({ promote: false, warm: false }),
        inspectPane: async () => ({ state: "IDLE", sessionId: "sess:new" } as never),
        roomTool: roomTool as never
      });

      const res = await tools.execute("space_send_to_pane", {
        room: "room:dev",
        panes: ["Worker"],
        text: "echo hello"
      }, context as never);

      expect(res.ok).toBe(true);
      expect(roomTool).toHaveBeenCalledWith(
        "send_to_pane",
        expect.objectContaining({
          panes: ["pane:new_open"],
          text: "echo hello"
        }),
        expect.anything()
      );
    });
  });

  describe("Fix 4: Exclude generic Space utility paths from duplicate-work path matching", () => {
    it("does not match scripts/space-progress.mjs, space-queue, or space-worktree as work keys", () => {
      const text1 = "Run node scripts/space-progress.mjs done --ticket 42 and update apps/api/src/service.ts";
      const keys1 = sendWorkKeys(text1);
      expect(keys1).toContain("apps/api/src/service.ts");
      expect(keys1).not.toContain("scripts/space-progress.mjs");

      const text2 = "Submit via /opt/spaceapp/bin/space-queue and check scripts/space-progress.mjs";
      const keys2 = sendWorkKeys(text2);
      expect(keys2).not.toContain("scripts/space-progress.mjs");
      expect(keys2.some((k) => k.includes("space-progress"))).toBe(false);
      expect(keys2.some((k) => k.includes("space-queue"))).toBe(false);

      const text3 = "Use scripts/space-worktree.mjs to create branch and fix packages/shared/index.ts";
      const keys3 = sendWorkKeys(text3);
      expect(keys3).toContain("packages/shared/index.ts");
      expect(keys3).not.toContain("scripts/space-worktree.mjs");
    });
  });
});
