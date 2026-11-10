import { SpaceNotFoundError } from "@space/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const { captured, rec } = vi.hoisted(() => {
  const captured = { order: [] as string[], args: {} as Record<string, unknown[]>, stores: [] as Array<{ kind: string; root: string }> };
  const rec = (name: string, result?: unknown) => (...args: unknown[]) => { captured.order.push(name); captured.args[name] = args; return result; };
  return { captured, rec };
});
vi.mock("../src/room-routes.js", async (orig) => ({ ...await orig<object>(), registerRoomListRoutes: rec("list"), registerRoomManagementRoutes: rec("manage") }));
vi.mock("../src/room-shares.js", async (orig) => ({ ...await orig<object>(), registerRoomShareRoutes: rec("shares") }));
vi.mock("../src/proof-room-routes.js", async (orig) => ({ ...await orig<object>(), registerProofRoomRoutes: rec("proofRooms") }));
vi.mock("../src/cli-render-ai-proof.js", async (orig) => ({ ...await orig<object>(), createCliRenderAiController: rec("renderAi", { close: rec("renderAiClose") }) }));
vi.mock("../src/agents-dashboard-proof.js", async (orig) => ({ ...await orig<object>(),
  createDashboardCliProofController: rec("dashboardProof", { close: rec("dashboardProofClose") }) }));
vi.mock("../src/youtube-accounts.js", async (orig) => ({ ...await orig<object>(),
  YouTubeAccountStore: class { constructor(readonly root: string) { captured.stores.push({ kind: "accounts", root }); } } }));
vi.mock("../src/youtube-playback-state.js", async (orig) => ({ ...await orig<object>(),
  YouTubePlaybackStore: class { constructor(readonly root: string) { captured.stores.push({ kind: "playback", root }); } } }));

const { registerRoomRoutes } = await import("../src/room-routes-wiring.js");

afterEach(() => { Object.assign(captured, { order: [], args: {}, stores: [] }); });

function wire() {
  const hooks: Array<() => Promise<unknown>> = [];
  const audits: unknown[] = [];
  const noted: unknown[] = [];
  const rooms: Record<string, { id: string; ownerUserId: string | null }> = {
    "room:owned1": { id: "room:owned1", ownerUserId: "user:alice1" }, "room:shared": { id: "room:shared", ownerUserId: "user:bobbby" },
    "room:noowner": { id: "room:noowner", ownerUserId: null }
  };
  const app = { addHook: (name: string, hook: () => Promise<unknown>) => { captured.order.push(`hook:${name}`); hooks.push(hook); } };
  const deps = {
    config: { browserEvidenceArtifactRoot: "/var/space/evidence", agentPaneEnabled: true },
    store: { getRoom: async (roomId: string) => rooms[roomId]!, upsertUser: async (user: { id: string }) => ({ id: `${user.id}:stored` }),
      recordAuditEvent: async (event: unknown) => { audits.push(event); } },
    options: { options: true }, eventBus: { bus: true }, activityLogService: "activity", browserSessionManager: "browsers", cliRuntimeRegistryCache: "registry",
    cliRuntimeVisibility: "visibility", codexCliModeDefaultsService: "codex-defaults", readDashboardAgents: "dashboard-agents", visibleCliRuntimeIds: "visible-ids",
    cliTerminalManager: { observeRoomScreen: async (sessionId: string) => ({ text: `screen:${sessionId}` }),
      closeUserRoomSockets: async (...args: unknown[]) => { noted.push(["closeSockets", ...args]); } },
    roomShares: { shareOf: async (roomId: string, userId: string) => roomId === "room:shared" && userId === "user:alice1" ? { role: "VIEW" } : null, sharedRooms: "shared-rooms" },
    roomPaneController: { interrupt: async (...args: unknown[]) => { noted.push(["interrupt", ...args]); } },
    inspectRoomCli: "inspect", controlQuota: "quota", controlSend: "send", defaultRouteRateLimitOptions: { config: { rateLimit: 1 } }
  };
  const result = registerRoomRoutes(app as never, deps as never);
  return { result, deps, hooks, audits, noted };
}
const arg = (name: string, index = 1) => captured.args[name]![index] as Record<string, never>;
const call = <T = unknown>(value: unknown, ...args: unknown[]) => (value as (...args: unknown[]) => T)(...args);

describe("room routes wiring (ARCH-001 step 79)", () => {
  it("registers in app.ts's order and returns the access check and the account stores", () => {
    const { result } = wire();
    expect(captured.order).toEqual(["list", "shares", "renderAi", "hook:onClose", "dashboardProof", "hook:onClose", "proofRooms", "manage", "hook:onClose"]);
    expect(captured.stores).toEqual([{ kind: "playback", root: "/var/space/youtube-playback" }, { kind: "accounts", root: "/var/space/youtube-accounts" },
      { kind: "accounts", root: "/var/space/browser-accounts" }]);
    expect(result.youtubePlaybackStore).toMatchObject({ root: "/var/space/youtube-playback" });
    expect(result.youtubeAccountStore).toMatchObject({ root: "/var/space/youtube-accounts" });
    expect(result.browserAccountStore).toMatchObject({ root: "/var/space/browser-accounts" });
    expect(arg("manage")).toMatchObject({ assertRoomAccess: result.assertRoomAccess, youtubePlaybackStore: result.youtubePlaybackStore,
      youtubeAccountStore: result.youtubeAccountStore, browserAccountStore: result.browserAccountStore, browserSessionManager: "browsers" });
  });

  it("lets a USER into owned or shared rooms only and every other role into any room", async () => {
    const { result } = wire();
    const alice = { id: "user:alice1", role: "USER" };
    await expect(result.assertRoomAccess("room:owned1", alice as never)).resolves.toMatchObject({ id: "room:owned1" });
    await expect(result.assertRoomAccess("room:shared", alice as never)).resolves.toMatchObject({ id: "room:shared" });
    await expect(result.assertRoomAccess("room:shared", { id: "user:carol1", role: "USER" } as never)).rejects.toBeInstanceOf(SpaceNotFoundError);
    await expect(result.assertRoomAccess("room:noowner", alice as never)).rejects.toThrow("Room room:noowner was not found.");
    await expect(result.assertRoomAccess("room:noowner", { id: "user:admin1", role: "ADMIN" } as never)).resolves.toMatchObject({ id: "room:noowner" });
    await expect(result.assertRoomAccess("room:shared", null)).resolves.toMatchObject({ id: "room:shared" });
  });

  it("passes the room list and share routes their dependencies", async () => {
    const { result, deps, audits, noted } = wire();
    expect(arg("list")).toMatchObject({ activityLogService: "activity", cliRuntimeVisibility: "visibility", readDashboardAgents: "dashboard-agents",
      visibleCliRuntimeIds: "visible-ids", routeOptions: deps.defaultRouteRateLimitOptions, assertRoomAccess: result.assertRoomAccess, agentPaneEnabled: true,
      sharedRooms: "shared-rooms" });
    expect(arg("shares").access).toBe(deps.roomShares);
    await call(arg("shares").recordAudit, { user: { id: "user:alice1" }, requestIdForSpace: "trace:share1" }, { action: "room.share", targetType: "room", targetId: "room:owned1" });
    expect(audits).toEqual([expect.objectContaining({ actorUserId: "user:alice1:stored", traceId: "trace:share1", action: "room.share", targetId: "room:owned1" })]);
    expect(call(arg("shares").closeUserRoomSockets, "user:alice1", "room:owned1")).toBeUndefined();
    expect(noted).toEqual([["closeSockets", "user:alice1", "room:owned1"]]);
  });

  it("builds the proof controllers, closes them on shutdown and hands them to the proof room routes", async () => {
    const { deps, hooks, noted } = wire();
    expect(arg("renderAi", 0)).toMatchObject({ store: deps.store, root: "/var/space/evidence", inspect: "inspect", quota: "quota", send: "send" });
    await call(arg("renderAi", 0).interrupt, { id: "pane:render1" });
    expect(arg("dashboardProof", 0)).toMatchObject({ store: deps.store, send: "send" });
    await expect(call(arg("dashboardProof", 0).screen, "cli_session:abc123")).resolves.toBe("screen:cli_session:abc123");
    await call(arg("dashboardProof", 0).interrupt, { id: "pane:dash001" }, "trace:dash01");
    expect(noted).toEqual([["interrupt", { id: "pane:render1" }, "cli-render-expired"], ["interrupt", { id: "pane:dash001" }, "trace:dash01"]]);
    expect(arg("proofRooms")).toMatchObject({ options: deps.options, config: deps.config, eventBus: deps.eventBus, codexCliModeDefaultsService: "codex-defaults",
      cliRuntimeRegistryCache: "registry", cliTerminalManager: deps.cliTerminalManager, routeOptions: deps.defaultRouteRateLimitOptions });
    expect(arg("proofRooms").cliRenderAi).toMatchObject({ close: expect.any(Function) });
    expect(arg("manage").cliRenderAi).toBe(arg("proofRooms").cliRenderAi);
    captured.order.length = 0;
    for (const hook of hooks) await hook();
    expect(captured.order).toEqual(["renderAiClose", "dashboardProofClose"]);
  });
});
