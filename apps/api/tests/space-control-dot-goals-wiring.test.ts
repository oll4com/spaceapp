import { SpaceConflictError } from "@space/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cookieName, signSession } from "../src/auth.js";

const { captured, rec } = vi.hoisted(() => {
  const captured = { order: [] as string[], args: {} as Record<string, unknown[]> };
  const rec = (name: string, result?: unknown) => (...args: unknown[]) => { captured.order.push(name); captured.args[name] = args; return result; };
  return { captured, rec };
});
vi.mock("../src/space-control-routes.js", async (orig) => ({ ...await orig<object>(), registerSpaceControlRoutes: rec("controlRoutes", { call: "control-call" }) }));
vi.mock("../src/dot-goals.js", async (orig) => ({ ...await orig<object>(), createDotGoalService: rec("goalService", { service: "goals" }),
  createDotGoalWorkflowCoordinator: rec("workflow", "temporal-workflow"), registerDotGoalRoutes: rec("goalRoutes") }));
vi.mock("@space/db", async (orig) => ({ ...await orig<object>(), PostgresDotGoalsRepository: {
  fromConnectionString: (url: string) => { captured.order.push("goalsRepository"); captured.args.goalsRepository = [url];
    return { url, dispose: async () => { captured.order.push("goalsDispose"); } }; } } }));
vi.mock("../src/pane-guards.js", async (orig) => ({ ...await orig<object>(), getPaneById: async (_store: unknown, paneId: string) => ({ id: paneId, roomId: "room:goals01" }) }));

const { registerSpaceControlAndDotGoalRoutes } = await import("../src/space-control-dot-goals-wiring.js");

afterEach(() => { Object.assign(captured, { order: [], args: {} }); });

const secret = "s".repeat(32);
const owner = { id: "user:owner01", email: "owner@space.local", role: "ADMIN" as const };
const request = (user: unknown, cookie?: string) => ({ user, cookies: cookie ? { [cookieName]: cookie } : {} }) as never;

function wire(input: { dots?: boolean; workflow?: unknown; databaseUrl?: string | null; gateway?: boolean; submission?: boolean } = {}) {
  const hooks: Array<() => Promise<unknown>> = [];
  const audits: unknown[] = [];
  const sent: unknown[] = [];
  const dots = { get: async (ownerId: string, dotId: string) => ownerId === "user:owner01" && dotId === "dot:busy001" ? { workLimits: { maxConcurrentTasks: 2 } }
      : ownerId === "user:owner01" && dotId === "dot:free001" ? { workLimits: { maxConcurrentTasks: 3 } } : null,
    countActiveDotRuns: async () => 2 };
  const controlRooms = new WeakMap<object, string>();
  const app = { addHook: (name: string, hook: () => Promise<unknown>) => { captured.order.push(`hook:${name}`); hooks.push(hook); } };
  const deps = {
    config: { databaseUrl: input.databaseUrl === undefined ? "postgres://space/goals" : input.databaseUrl, enableCodexTurns: true, temporalAddress: "temporal:7233",
      temporalNamespace: "space", temporalTaskQueue: "space-goals", dotToolGatewayEnabled: input.gateway ?? true },
    store: { getRoom: async (roomId: string) => ({ id: roomId, ownerUserId: roomId === "room:noowner" ? null : "user:owner01" }),
      upsertUser: async (user: { id: string }) => ({ id: `${user.id}:stored` }), recordAuditEvent: async (event: unknown) => { audits.push(event); },
      getSpaceAgentSubmission: async (paneId: string, requestKey: string) => requestKey === "known-key" ? { runId: `run:${paneId}`, status: "RUNNING", extra: true } : null },
    auth: { sessionSecret: secret }, options: input.workflow === undefined ? {} : { dotGoalWorkflow: input.workflow }, spaceControl: { control: true },
    controlCliRooms: controlRooms, controlUser: async (id: string) => ({ id, role: "ADMIN" }), dotsRepository: input.dots === false ? null : dots,
    spaceAgentAdapter: {
      sendMessage: async (message: unknown) => { sent.push(message); return input.submission === false
        ? { session: { statusReason: input.gateway === false ? null : "Dot is busy." }, submission: null }
        : { session: {}, submission: { runId: "run:step0001" } }; },
      interrupt: async (message: unknown) => { sent.push(["interrupt", message]); }
    },
    defaultRouteRateLimitOptions: { config: { rateLimit: 1 } }
  };
  const result = registerSpaceControlAndDotGoalRoutes(app as never, deps as never);
  return { result, deps, hooks, audits, sent, controlRooms };
}
const arg = (name: string, index = 1) => captured.args[name]![index] as Record<string, never>;
const service = () => arg("goalService", 0) as unknown as Record<string, (...args: never[]) => Promise<unknown> | boolean>;

describe("Space Control and Dot Goals wiring (ARCH-001 step 80)", () => {
  it("registers in app.ts's order and returns the control routes, the Goal repository, service and capacity check", async () => {
    const { result, deps, hooks, controlRooms } = wire();
    expect(captured.order).toEqual(["controlRoutes", "goalsRepository", "hook:onClose", "workflow", "goalService", "goalRoutes"]);
    expect(result.spaceControlRoutes).toEqual({ call: "control-call" });
    expect(result.dotGoalsRepository).toMatchObject({ url: "postgres://space/goals" });
    expect(result.dotGoalService).toEqual({ service: "goals" });
    expect(captured.args.controlRoutes![1]).toBe(deps.spaceControl);
    const controlOptions = arg("controlRoutes", 2) as unknown as { cliRoom: (request: object) => string | null; resolveActor: unknown };
    const cliRequest = {};
    controlRooms.set(cliRequest, "room:cli0001");
    expect(controlOptions.cliRoom(cliRequest)).toBe("room:cli0001");
    expect(controlOptions.cliRoom({})).toBeNull();
    expect(controlOptions.resolveActor).toBe(deps.controlUser);
    expect(captured.args.goalRoutes!.slice(1, 3)).toEqual([{ service: "goals" }, { goals: result.dotGoalsRepository }]);
    expect(service().atCapacity).toBe(result.dotAtCapacity);
    captured.order.length = 0;
    for (const hook of hooks) await hook();
    expect(captured.order).toEqual(["goalsDispose"]);
  });

  it("has no Goal repository or service without Dots or a database, and never reports a Dot at capacity", async () => {
    for (const input of [{ dots: false }, { databaseUrl: null }]) {
      captured.order.length = 0;
      const { result } = wire(input);
      expect(captured.order).toEqual(["controlRoutes", "goalRoutes"]);
      expect(result.dotGoalsRepository).toBeNull();
      expect(result.dotGoalService).toBeNull();
      expect(captured.args.goalRoutes!.slice(1, 3)).toEqual([null, null]);
    }
    const { result } = wire({ dots: false });
    await expect(result.dotAtCapacity({ sessionId: "session:aaaa1111", dotId: "dot:busy001", roomId: "room:goals01" })).resolves.toBe(false);
  });

  it("counts a Dot's active runs against its concurrent-task limit in the room owner's Dots", async () => {
    const { result } = wire();
    const at = (dotId: string, roomId = "room:goals01") => result.dotAtCapacity({ sessionId: "session:aaaa1111", dotId, roomId });
    await expect(at("dot:busy001")).resolves.toBe(true);
    await expect(at("dot:free001")).resolves.toBe(false);
    await expect(at("dot:missing")).resolves.toBe(false);
    await expect(at("dot:busy001", "room:noowner")).resolves.toBe(false);
  });

  it("takes the workflow from the options, else a Temporal coordinator from the config", () => {
    wire({ workflow: "injected-workflow" });
    expect(service().workflow).toBe("injected-workflow");
    expect(captured.order).not.toContain("workflow");
    wire();
    expect(arg("workflow", 0)).toEqual({ enabled: true, address: "temporal:7233", namespace: "space", taskQueue: "space-goals" });
    expect(service().workflow).toBe("temporal-workflow");
  });

  it("sends Goal steps as Chat turns, interrupts and reads submissions through the Space Agent", async () => {
    const { sent } = wire();
    const step = { paneId: "pane:goal0001", sessionId: "session:aaaa1111", ownerUserId: "user:owner01", content: "Next step", requestKey: "goal-key01" };
    await expect(service().sendStep(step as never)).resolves.toEqual({ runId: "run:step0001" });
    expect(sent[0]).toMatchObject({ pane: { id: "pane:goal0001" }, sessionId: "session:aaaa1111", content: "Next step", operatorUserId: "user:owner01",
      clientRequestId: "goal-key01", traceId: expect.stringMatching(/^trace/) });
    await service().interrupt("pane:goal0001" as never, "paused" as never);
    expect(sent[1]).toEqual(["interrupt", { pane: { id: "pane:goal0001", roomId: "room:goals01" }, reason: "paused" }]);
    await expect(service().submission("pane:goal0001" as never, "known-key" as never)).resolves.toEqual({ runId: "run:pane:goal0001", status: "RUNNING" });
    await expect(service().submission("pane:goal0001" as never, "other-key" as never)).resolves.toBeNull();
    wire({ submission: false });
    await expect(service().sendStep(step as never)).rejects.toThrow(new SpaceConflictError("Dot is busy."));
    wire({ submission: false, gateway: false });
    await expect(service().sendStep(step as never)).rejects.toThrow("The Goal step could not start.");
  });

  it("offers Goal tools only through the Codex gateway outside ask-for-approval, and audits only requests", async () => {
    const { audits } = wire();
    const supports = (session: object) => service().supportsGoalTools(session as never);
    expect(supports({ selectedProviderId: null, permissionMode: "full_access" })).toBe(true);
    expect(supports({ selectedProviderId: "codex", permissionMode: null })).toBe(true);
    expect(supports({ selectedProviderId: "claude", permissionMode: null })).toBe(false);
    expect(supports({ selectedProviderId: "codex", permissionMode: "ask_for_approval" })).toBe(false);
    await service().audit(null as never, "dot.goal.step" as never, "room:goals01" as never, {} as never);
    expect(audits).toEqual([]);
    await service().audit({ user: owner, requestIdForSpace: "trace:goal01" } as never, "dot.goal.create" as never, "room:goals01" as never, { goalId: "g1" } as never);
    expect(audits).toEqual([expect.objectContaining({ actorUserId: "user:owner01:stored", action: "dot.goal.create", targetType: "room", targetId: "room:goals01",
      metadata: { goalId: "g1" } })]);
    wire({ gateway: false });
    expect(supports({ selectedProviderId: "codex", permissionMode: null })).toBe(false);
  });

  it("Dot Goal routes need a signed session and use the stored owner id", async () => {
    wire();
    const options = arg("goalRoutes", 3) as unknown as { routeOptions: unknown; authenticatedOwner: (request: unknown) => Promise<string> };
    expect(options.routeOptions).toEqual({ config: { rateLimit: 1 } });
    const cookie = signSession(owner, secret);
    await expect(options.authenticatedOwner(request(owner, cookie))).resolves.toBe("user:owner01:stored");
    await expect(options.authenticatedOwner(request(owner))).rejects.toMatchObject({ code: "UNAUTHENTICATED", statusCode: 401, message: "Sign in to use Dots." });
    await expect(options.authenticatedOwner(request(owner, "forged"))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(options.authenticatedOwner(request(undefined, cookie))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});
