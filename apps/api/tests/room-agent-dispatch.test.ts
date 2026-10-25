import { describe, expect, it, vi } from "vitest";
import { PANE_CATALOG_VERSION, CLI_PANE_TYPES, agentRuntimeRegistrySchema } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { createRoomAgentService } from "../src/room-agent.js";
import { createRoomPaneCommands } from "../src/room-pane-commands.js";
import { createRoomQuickActions } from "../src/room-quick-actions.js";
import { createRoomRoutedActions } from "../src/room-routed-actions.js";
const actor = { holderType: "OPERATOR", holderId: "user:operator" } as const;
function fixture() {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Agent Proof direct dispatch", kind: "AGENT_PROOF", initialPaneCount: 0 });
  const enqueue = vi.fn(async () => ({ workflowId: "workflow:proof", runId: null }));
  const navigate = vi.fn(async () => {});
  const publish = vi.fn(async () => {});
  const now = new Date().toISOString();
  const registry = agentRuntimeRegistrySchema.parse({ checkedAt: now, data: CLI_PANE_TYPES.map(type => ({
    id: type.id, providerId: type.typeId, providerName: type.shortLabel, agentId: type.typeId, agentName: type.shortLabel,
    displayName: type.displayName, capabilities: ["CLI"], adapterStatus: "ENABLED", authMode: "MANAGED", authState: "READY",
    authReason: "Fixture", status: "ENABLED", statusReason: "Fixture", canStartLogin: false, commandName: type.typeId, checkedAt: now
  })) });
  const panes = createRoomPaneCommands({ store, discover: async () => registry, enabledRuntimeIds: async () => CLI_PANE_TYPES.map(type => type.id), harnessAvailable: async () => true });
  const quick = createRoomQuickActions({ store, assertRuntimeEnabled: async () => {}, navigate, publish });
  const executeRoutedCommand = createRoomRoutedActions({ panes, quick, publish });
  const serviceOptions = { store, workflow: { enqueue, stop: async () => {} },
    missionStopper: { pauseMission: async () => {}, resumeMission: async () => {}, stopMission: async () => {} },
    roomPlanInventoryProvider: { inspect: async () => ({ totalPanes: store.listPanes(room.id).length, plannedPanes: 0,
      pendingPlans: 0, readyPlans: 0, pausedPlans: 0, runningPlans: 0, checkedAt: now, plans: [] }) }, executeRoutedCommand, executeQuickCommand: quick };
  return { store, room, enqueue, navigate, panes, serviceOptions, service: createRoomAgentService(serviceOptions) };
}
describe("Room Agent direct dispatch", () => {
  it("claims a complete pane phrase once, opens one batch without a model and validates the original payload on retry", async () => {
    const c = fixture();
    const content = "Άνοιξε 2 codex panes";
    const results = await Promise.all([1, 2].map(() => c.service.send(c.room.id, content, "direct:open", "trace:open", actor)));
    expect(results.map(result => result.directCommand?.status).sort()).toEqual(["COMPLETED", "REPLAYED"]);
    expect(c.store.listPanes(c.room.id)).toHaveLength(2);
    expect(c.enqueue).not.toHaveBeenCalled();
    expect(c.store.getRoomAgentRequest(c.room.id, "direct:open")).toMatchObject({ directAction: { type: "OPEN_PANES", counts: { codex: 2 } }, requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await c.service.send(c.room.id, content, "direct:open", "trace:retry", actor);
    expect(c.store.listPanes(c.room.id)).toHaveLength(2);
    await expect(c.service.send(c.room.id, "open 1 codex pane", "direct:open", "trace:changed", actor)).rejects.toThrow("different actor or payload");
    await expect(c.service.send(c.room.id, content, "direct:open", "trace:changed", { ...actor, holderId: "user:other" })).rejects.toThrow("different actor or payload");
  });
  it("does not block independent playback while a search is still running", async () => {
    const c = fixture();
    let finishSearch!: () => void;
    c.navigate.mockImplementationOnce(() => new Promise<void>(resolve => { finishSearch = resolve; }));
    const search = c.service.send(c.room.id, "search on browser: books", "direct:search", "trace:search", actor);
    await vi.waitFor(() => expect(c.navigate).toHaveBeenCalledOnce());
    const music = await c.service.send(c.room.id, "pause music", "direct:pause", "trace:pause", actor);
    expect(music.directCommand).toMatchObject({ status: "CLIENT_PENDING", music: { action: "PAUSE" } });
    const ack = await c.service.acknowledgeCommand(c.room.id, "direct:pause", true);
    expect(ack.messages.some(message => message.content === "Playback control applied.")).toBe(true);
    expect((await c.service.send(c.room.id, "pause music", "direct:pause", "trace:retry", actor)).directCommand?.music).toBeUndefined();
    finishSearch(); await search;
  });
  it("recovers an accepted batch after a lost transcript write without repeating the panes", async () => {
    const c = fixture();
    const command = { requestId: "direct:recover", catalogVersion: PANE_CATALOG_VERSION, action: { type: "OPEN_PANES", counts: { codex: 2, gemini: 3, browser: 1 } } } as const;
    const first = await c.service.executeCommand(c.room.id, command, "trace:first", actor);
    const request = c.store.getRoomAgentRequest(c.room.id, "direct:recover")!;
    c.store.updateSpaceAgentMessage(request.responseMessageId, { status: "RUNNING", content: "Executing your command…" });
    const recovered = await createRoomAgentService(c.serviceOptions).executeCommand(c.room.id, command, "trace:recover", actor);
    expect(first.directCommand?.status).toBe("COMPLETED");
    expect(recovered.directCommand?.status).toBe("COMPLETED");
    expect(c.store.listPanes(c.room.id)).toHaveLength(6);
  });
});

describe("typed room commands", () => {
  it("claims SEARCH before navigation across independent services and rejects changed actions and actors", async () => {
    const c = fixture();
    const other = createRoomAgentService(c.serviceOptions);
    let finish!: () => void;
    c.navigate.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const command = { requestId: "typed:search", catalogVersion: PANE_CATALOG_VERSION,
      action: { type: "SEARCH", query: "books", engine: "GOOGLE" } } as const;
    const first = c.service.executeCommand(c.room.id, command, "trace:search", actor);
    await vi.waitFor(() => expect(c.navigate).toHaveBeenCalledOnce());
    const replay = await other.executeCommand(c.room.id, command, "trace:retry", actor);
    expect(replay.directCommand?.status).toBe("REPLAYED");
    expect(c.navigate).toHaveBeenCalledOnce();
    await expect(other.executeCommand(c.room.id, { ...command, action: { type: "PLAYBACK", action: "NEXT", target: "AUTO" } }, "trace:changed", actor)).rejects.toThrow("different actor or payload");
    await expect(other.executeCommand(c.room.id, command, "trace:actor", { ...actor, holderId: "other" })).rejects.toThrow("different actor or payload");
    finish(); await first;
    expect(c.enqueue).not.toHaveBeenCalled();
  });
  it("delivers NEXT once, accepts only its actor's ack, and preserves terminal acknowledgment", async () => {
    const c = fixture();
    const command = { requestId: "typed:next", catalogVersion: PANE_CATALOG_VERSION,
      action: { type: "PLAYBACK", action: "NEXT", target: "AUTO" } } as const;
    const results = await Promise.all([c.service, createRoomAgentService(c.serviceOptions)].map(service =>
      service.executeCommand(c.room.id, command, "trace:next", actor)));
    expect(results.filter(result => result.directCommand?.music)).toHaveLength(1);
    await expect(c.service.acknowledgeCommand(c.room.id, command.requestId, true, { ...actor, holderId: "other" })).rejects.toThrow("command actor");
    await c.service.acknowledgeCommand(c.room.id, command.requestId, true, actor);
    const ack = await c.service.acknowledgeCommand(c.room.id, command.requestId, false, actor);
    const request = c.store.getRoomAgentRequest(c.room.id, command.requestId)!;
    expect(ack.messages.find(message => message.id === request.responseMessageId)?.status).toBe("COMPLETED");
    expect((await createRoomAgentService(c.serviceOptions).executeCommand(c.room.id, command, "trace:retry", actor)).directCommand?.music).toBeUndefined();
  });
  it("retains failed SEARCH without navigating on retry and canonicalizes reordered pane counts", async () => {
    const c = fixture();
    c.navigate.mockRejectedValueOnce(new Error("Navigation unavailable"));
    const command = { requestId: "typed:failed", catalogVersion: PANE_CATALOG_VERSION,
      action: { type: "SEARCH", query: "books", engine: "GOOGLE" } } as const;
    await expect(c.service.executeCommand(c.room.id, command, "trace:first", actor)).rejects.toThrow("Navigation unavailable");
    await expect(createRoomAgentService(c.serviceOptions).executeCommand(c.room.id, command, "trace:retry", actor)).rejects.toThrow("Navigation unavailable");
    expect(c.navigate).toHaveBeenCalledOnce();
    const open = { ...command, requestId: "typed:open", action: { type: "OPEN_PANES", counts: { codex: 1, browser: 1 } } } as const;
    await c.service.executeCommand(c.room.id, open, "trace:open", actor);
    await c.service.executeCommand(c.room.id, { ...open, action: { type: "OPEN_PANES", counts: { browser: 1, codex: 1 } } }, "trace:retry", actor);
    expect(c.store.listPanes(c.room.id)).toHaveLength(3);
  });
});

it("uses only the application's selected room browser and rejects a retargeted retry", async () => {
  const c = fixture();
  const browsers = c.store.createPanes([1, 2].map(() => ({ roomId: c.room.id, title: "Browser", mode: "BROWSER" })));
  await c.service.send(c.room.id, "search on browser: books", "selected:browser", "trace:first", actor, browsers[1]!.id);
  expect(c.navigate.mock.calls[0]?.[0].id).toBe(browsers[1]!.id);
  const restarted = createRoomAgentService(c.serviceOptions);
  await restarted.send(c.room.id, "search on browser: books", "selected:browser", "trace:retry", actor, browsers[1]!.id);
  await expect(restarted.send(c.room.id, "search on browser: books", "selected:browser", "trace:retarget", actor, browsers[0]!.id)).rejects.toThrow("different browser target");
  expect(c.navigate).toHaveBeenCalledOnce();
  const missing = await c.service.send(c.room.id, "search on browser: books", "selected:missing", "trace:missing", actor, "pane:other-room");
  expect(missing.directCommand?.status).toBe("FAILED");
  const ambiguous = await c.service.send(c.room.id, "search on browser: books", "selected:ambiguous", "trace:ambiguous", actor);
  expect(ambiguous.directCommand?.status).toBe("FAILED");
  expect(c.navigate).toHaveBeenCalledOnce();
});
