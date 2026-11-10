import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type Deps = Record<string, (...args: never[]) => Promise<unknown>>;
const captured = vi.hoisted(() => ({ live: undefined as unknown, evals: undefined as unknown, liveRoutes: [] as unknown[], evalRoutes: [] as unknown[] }));
vi.mock("../src/dot-live.js", () => ({
  createDotLiveService: (deps: unknown) => { captured.live = deps; return { kind: "live" }; },
  registerDotLiveRoutes: (_app: unknown, service: unknown) => { captured.liveRoutes.push(service); }
}));
vi.mock("../src/dot-evals.js", () => ({
  createDotEvalService: (deps: unknown) => { captured.evals = deps; return { kind: "evals" }; },
  registerDotEvalRoutes: (_app: unknown, service: unknown, options: unknown) => { captured.evalRoutes.push({ service, options }); }
}));

const { registerDotLiveAndEvals } = await import("../src/dot-live-evals-wiring.js");

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; captured.liveRoutes = []; captured.evalRoutes = []; });

function wire(overrides: Record<string, unknown> = {}) {
  const hooks: string[] = [];
  const app = { addHook: (name: string) => { hooks.push(name); } };
  const published: unknown[] = [];
  const control = vi.fn(async () => ({ action: "CANCEL" }));
  const decide = vi.fn(async (_o: string, _d: string, id: string) => ({ payload: id === "inv:schedule" ? { kind: "schedule", scheduleId: "sched:1" } : {} }));
  const result = registerDotLiveAndEvals(app as never, {
    store: {
      createPanes: async () => [{ id: "pane:new", roomId: "room:1" }],
      listEvents: async () => [{ type: "PANE_CREATED", paneId: "pane:new" }, { type: "PANE_CREATED", paneId: "pane:old" }],
      createArtifact: async () => { throw new Error("db down"); },
      getRoom: async (id: string) => (id === "room:mine" ? { ownerUserId: "user:1" } : Promise.reject(new Error("missing")))
    } as never,
    config: { databaseUrl: undefined, browserEvidenceArtifactRoot: root },
    options: { dotEvalsRepository: { isRunningSession: vi.fn() } as never },
    eventBus: { publish: (event: unknown) => { published.push(event); } },
    defaultRouteRateLimitOptions: {},
    dotsAuthenticatedOwner: async () => "user:1",
    dotsRepository: {
      listPendingApprovals: async () => [{ invocationId: "inv:schedule", toolId: "schedule.create", approvalSummary: null }, { invocationId: "inv:mail", toolId: "mail.send", approvalSummary: "Send it" }],
      decideToolApproval: decide,
      get: async (_owner: string, dotId: string) => (dotId === "dot:mine" ? { id: dotId } : null)
    } as never,
    dotGoalsRepository: {} as never,
    channelsRepository: { threadForSession: async (_s: string, provider: string) => (provider === "TEAMS" ? { id: "t" } : null) } as never,
    dotGoalService: {} as never,
    dotDelegationService: {} as never,
    dotScheduleService: { control } as never,
    connectorService: { status: async () => ({ accounts: [{ capabilities: ["MAIL_READ", "CALENDAR"] }] }) } as never,
    dotChannelService: { available: async () => ["channel:slack"] } as never,
    cliRuntimeVisibility: { assertEnabled: async () => undefined },
    roomPaneCommands: { resolve: async () => [{ mode: "CHAT" }] } as never,
    spaceAgentAdapter: { createOrRestoreSession: async () => ({ binding: { sessionId: "s:1" }, dotId: "dot:other" }) } as never,
    spaceControl: { watches: async () => ({}) } as never,
    controlUser: async () => ({ id: "user:1" }) as never,
    ...overrides
  });
  return { result, hooks, published, control, decide, live: captured.live as Deps, evals: captured.evals as Deps };
}

describe("Dot Live and evaluations wiring", () => {
  it("registers both route sets as unavailable without Dots storage and creates no evaluation store", () => {
    captured.live = undefined; captured.evals = undefined;
    const { result, hooks } = wire({ dotsRepository: null, options: {} });
    expect(result.dotEvalsRepository).toBeNull();
    expect(captured.live).toBeUndefined();
    expect(captured.liveRoutes).toEqual([null]);
    expect(captured.evalRoutes).toMatchObject([{ service: null }]);
    expect(hooks).toEqual([]);
  });

  it("opens a Chat pane publishing only its own PANE_CREATED, refuses a session of another Dot, and reads approvals, channels and watches", async () => {
    const { live, published, hooks, result } = wire();
    expect(hooks).toEqual([]); // an injected evaluation store is the caller's to close
    expect(result.dotEvalsRepository).not.toBeNull();
    expect(await live.openPane({ roomId: "room:1", title: "Hand-off" } as never)).toMatchObject({ id: "pane:new" });
    expect(published).toEqual([{ type: "PANE_CREATED", paneId: "pane:new" }]);
    await expect(live.startSession({ pane: {}, owner: "user:1", dotId: "dot:1" } as never)).rejects.toThrow("The Dot's conversation could not start.");
    expect(await live.pendingApprovals("user:1" as never, "dot:1" as never, "s:1" as never)).toEqual([{ summary: "schedule.create" }, { summary: "Send it" }]);
    expect(await live.isChannelSession("s:1" as never)).toBe(true);
    expect(await live.watch("user:1" as never, "room:1" as never, "pane:1" as never)).toBeNull();
  });

  it("offers the owner's connector and channel capabilities, declines pending tools cancelling their schedules, and checks Dot and room ownership", async () => {
    const { evals, control, decide } = wire();
    expect([...(await evals.available("user:1" as never) as Set<string>)]).toEqual(["connector:mail-read", "connector:calendar", "channel:slack"]);
    await evals.declinePending("user:1" as never, "dot:1" as never, "s:1" as never);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(control).toHaveBeenCalledWith("user:1", "dot:1", "sched:1", { action: "CANCEL" });
    const { options } = captured.evalRoutes[0] as { options: Deps };
    expect(await options.ownsDot("user:1" as never, "dot:mine" as never)).toBe(true);
    expect(await options.ownsDot("user:1" as never, "dot:theirs" as never)).toBe(false);
    expect(await options.ownsRoom("user:1" as never, "room:mine" as never)).toBe(true);
    expect(await options.ownsRoom("user:1" as never, "room:gone" as never)).toBe(false);
  });

  it("removes an uploaded evaluation fixture when its artifact cannot be recorded", async () => {
    root = await mkdtemp(join(tmpdir(), "dot-evals-"));
    const { evals } = wire({ config: { databaseUrl: undefined, browserEvidenceArtifactRoot: root } });
    await expect(evals.uploadFixture({ roomId: "room:1", owner: "user:1", name: "case.csv", data: Buffer.from("a,b") } as never)).rejects.toThrow("db down");
    const left = await readdir(root, { recursive: true, withFileTypes: true });
    expect(left.filter((entry) => entry.isFile())).toEqual([]);
  });
});
