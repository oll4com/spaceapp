import { afterEach, describe, expect, it, vi } from "vitest";
import { cookieName, signSession } from "../src/auth.js";

type OnEvent = (event: Record<string, unknown>) => void;
type RouteDeps = {
  inspect?: unknown;
  log?: unknown;
  kickoff(pane: unknown, run: unknown, discover: boolean): Promise<void>;
  authenticatedOwner(request: unknown): Promise<string>;
  assertPaneAccess(request: unknown, pane: unknown): Promise<void>;
};
const captured = vi.hoisted(() => ({ service: undefined as Record<string, unknown> | undefined, routes: [] as RouteDeps[], triage: [] as { enabled: boolean }[], prompts: [] as unknown[][], clears: [] as unknown[][] }));
vi.mock("../src/job-apply/service.js", () => ({
  createJobApplyService: (options: Record<string, unknown>) => { captured.service = options; return { kind: "service", triageMailForAllOwners: vi.fn() }; },
  jobApplyNeedsYouAsk: () => ({ ask: { question: "q" } })
}));
vi.mock("../src/job-apply/routes.js", () => ({ registerJobApplyRoutes: (_app: unknown, _service: unknown, deps: RouteDeps) => { captured.routes.push(deps); } }));
vi.mock("../src/job-apply/mail-triage-timer.js", () => ({ scheduleJobApplyMailTriage: (_app: unknown, input: { enabled: boolean }) => { captured.triage.push(input); } }));
vi.mock("../src/cli-prompt-submit.js", () => ({ submitCliPrompt: async (...args: unknown[]) => { captured.prompts.push(args); }, clearIdleClaudeSession: async (...args: unknown[]) => { captured.clears.push(args); return true; } }));

const { registerJobApply } = await import("../src/job-apply-wiring.js");

const SECRET = "s".repeat(32);
const jobPane = (settings: Record<string, unknown> = { notifications: { inApp: true, telegram: true } }) =>
  ({ id: "pane:job00001", roomId: "room:aaaa0001", mode: "JOB_APPLY", title: "Jobs", jobApplyMetadata: { version: 1, settings } });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => { captured.service = undefined; captured.routes = []; captured.triage = []; captured.prompts = []; captured.clears = []; });

function wire(input: { pane?: unknown; modules?: string[]; triageJob?: boolean; raised?: Record<string, unknown>; telegramFails?: boolean; publishFails?: boolean; session?: unknown; browser?: unknown; options?: Record<string, unknown> } = {}) {
  const hooks: string[] = [];
  const warns: unknown[][] = [];
  const app = { addHook: (name: string) => { hooks.push(name); }, log: { warn: (...args: unknown[]) => { warns.push(args); } } };
  const published: Record<string, unknown>[] = [];
  const getPane = vi.fn(async () => input.pane === undefined ? jobPane() : input.pane);
  const raise = vi.fn(async (_n: unknown) => ({ payload: input.raised ?? {} }));
  const resolve = vi.fn(async () => undefined);
  const notify = vi.fn(async () => { if (input.telegramFails) throw new Error("telegram down"); return true; });
  const mutations: string[] = [];
  const result = registerJobApply(app as never, {
    store: {
      getPane,
      getActivePaneCliSession: async () => input.session ?? null,
      getActivePaneBrowserSession: async () => input.browser ?? null,
      upsertUser: async (user: { id: string }) => ({ id: `${user.id}:stored` })
    } as never,
    config: { databaseUrl: undefined, browserEvidenceArtifactRoot: "/tmp/x", jobApplyRoot: "/tmp/y",
      instanceJobs: { "job-apply-mail-triage": input.triageJob ?? false } as never, optionalModules: new Set(input.modules ?? ["job-copilot"]) as never },
    options: input.options ?? {},
    auth: { sessionSecret: SECRET },
    eventBus: { publish: (event: Record<string, unknown>) => { if (input.publishFails) throw new Error("bus down"); published.push(event); } } as never,
    defaultRouteRateLimitOptions: {},
    connectorCrypto: {} as never,
    connectorServiceRef: { current: null },
    notificationService: { raise, resolve, list: vi.fn() } as never,
    roomOwner: async (roomId: string) => (roomId === "room:aaaa0001" ? "user:owner01" : null),
    telegramIntegrationManager: { notify },
    roomPaneController: { inspect: vi.fn() } as never,
    cliTerminalManager: { runSerializedTerminalMutation: async (id: string, run: () => Promise<void>) => { mutations.push(id); await run(); } } as never,
    assertRoomAccess: async () => undefined
  });
  const onEvent = captured.service?.onEvent as OnEvent | undefined;
  return { result, hooks, warns, published, getPane, raise, resolve, notify, mutations, onEvent, routes: captured.routes, triage: captured.triage };
}

const event = (type: string, payload: Record<string, unknown> = {}, paneId: string | null = "pane:job00001") =>
  ({ id: `jobev:${type.toLowerCase()}`, paneId, type, message: `${type} happened`, payload, createdAt: "2026-11-01T00:00:00.000Z" });

describe("Job Copilot wiring", () => {
  it("uses the in-memory repository without a database, disposes it, and wires routes and triage only as configured", () => {
    const on = wire({ triageJob: true });
    expect(on.result.jobApplyRepository.constructor.name).toBe("InMemoryJobApplyRepository");
    expect(on.hooks).toEqual(["onClose"]);
    expect(on.triage).toEqual([expect.objectContaining({ enabled: true })]);
    expect(on.routes[0]).toMatchObject({ inspect: expect.any(Function), log: expect.anything() });

    captured.routes = []; captured.triage = [];
    const noJob = wire({ triageJob: false });
    expect(noJob.triage[0]?.enabled).toBe(false);
    expect(noJob.routes[0]?.inspect).toBeUndefined();

    captured.routes = []; captured.triage = [];
    const off = wire({ modules: [], triageJob: true });
    expect(off.routes).toEqual([]);
    expect(off.triage[0]?.enabled).toBe(false);

    captured.triage = [];
    expect(wire({ triageJob: true, options: { jobApplyMailTriage: false } }).triage[0]?.enabled).toBe(false);
  });

  it("keeps an injected service and creates none", () => {
    const service = { triageMailForAllOwners: vi.fn() };
    const { result } = wire({ options: { jobApplyService: service } });
    expect(result.jobApplyService).toBe(service);
    expect(captured.service).toBeUndefined();
  });

  it("drops events without a pane or a room and looks a pane's room up once", async () => {
    const none = wire({ pane: null });
    none.onEvent!(event("RUN_FINISHED", {}, null));
    none.onEvent!(event("RUN_FINISHED"));
    await flush();
    expect(none.published).toEqual([]);
    expect(none.raise).not.toHaveBeenCalled();

    const known = wire();
    known.onEvent!(event("NOTE"));
    await flush();
    known.onEvent!(event("NOTE"));
    await flush();
    expect(known.published).toHaveLength(2);
    expect(known.published[0]).toMatchObject({ roomId: "room:aaaa0001", type: "JOB_APPLY_UPDATED", traceId: "job-apply:jobev:note" });
    expect(known.getPane).toHaveBeenCalledTimes(1);
    expect(known.raise).not.toHaveBeenCalled();
  });

  it("resolves the needs-you card of an answered question, a decided review and a resolved handoff", async () => {
    const { onEvent, resolve, raise } = wire();
    onEvent!(event("ANSWERED", { questionId: "jobq:1" }));
    onEvent!(event("REVIEW_DECIDED", { reviewId: "jobrev:1" }));
    onEvent!(event("HANDOFF_RESOLVED"));
    await flush(); await flush();
    expect(resolve.mock.calls).toEqual([["user:owner01", "job-apply:question:jobq:1"], ["user:owner01", "job-apply:review:jobrev:1"], ["user:owner01", "job-apply:handoff:pane:job00001"]]);
    expect(raise).not.toHaveBeenCalled();
  });

  it("raises nothing for a parked question, another pane mode or both channels off", async () => {
    const parked = wire();
    parked.onEvent!(event("QUESTION", {}));
    const other = wire({ pane: { ...jobPane(), mode: "TERMINAL" } });
    other.onEvent!(event("RUN_FINISHED"));
    const off = wire({ pane: jobPane({ notifications: { inApp: false, telegram: false } }) });
    off.onEvent!(event("RUN_STOPPED"));
    await flush(); await flush();
    expect(parked.raise).not.toHaveBeenCalled();
    expect(other.raise).not.toHaveBeenCalled();
    expect(off.raise).not.toHaveBeenCalled();
  });

  it("raises an action-needed mail as needs-you and a finished run as INFO with no dedupe key", async () => {
    const { onEvent, raise, notify } = wire();
    onEvent!(event("MAIL", { category: "ACTION_NEEDED" }));
    onEvent!(event("RUN_FINISHED"));
    onEvent!(event("MAIL", { category: "OTHER" }));
    await flush(); await flush();
    expect(raise.mock.calls.map(([n]) => n)).toEqual([
      expect.objectContaining({ kind: "MAIL", severity: "ATTENTION", title: "Jobs needs you", dedupeKey: "job-apply:MAIL:jobev:mail", payload: { eventId: "jobev:mail", ask: { question: "q" } }, telegram: false }),
      expect.objectContaining({ kind: "RUN_FINISHED", severity: "INFO", title: "Jobs: run finished", dedupeKey: null, link: { roomId: "room:aaaa0001", paneId: "pane:job00001", target: "job-apply-event:jobev:run_finished" } })
    ]);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("a question's card body is the question alone, not \"Needs you: <question>\" under its own heading (operator 1/11 23:09 BKK)", async () => {
    const { onEvent, raise, notify } = wire();
    onEvent!({ ...event("QUESTION", { questionId: "jobq:3", question: "Notice period?" }), message: "Needs you: Notice period?" });
    await flush(); await flush();
    expect(raise.mock.calls[0]?.[0]).toMatchObject({ kind: "QUESTION", body: "Notice period?" });
    expect(notify).toHaveBeenCalledWith("Job Copilot (Jobs): Needs you: Notice period?");
  });

  it("sends no Telegram line for a card held for Nous or the night, and logs a failed one", async () => {
    const held = wire({ raised: { heldForNous: { until: "x" } } });
    held.onEvent!(event("HANDOFF_REQUESTED"));
    const night = wire({ raised: { heldUntil: "2026-11-02T02:00:00.000Z" } });
    night.onEvent!(event("REVIEW_REQUESTED", { reviewId: "jobrev:2" }));
    const failing = wire({ telegramFails: true });
    failing.onEvent!(event("QUESTION", { questionId: "jobq:2" }));
    await flush(); await flush();
    expect(held.raise.mock.calls[0]?.[0]).toMatchObject({ dedupeKey: "job-apply:handoff:pane:job00001", link: { target: "browser" } });
    expect(held.notify).not.toHaveBeenCalled();
    expect(night.notify).not.toHaveBeenCalled();
    expect(failing.notify).toHaveBeenCalledWith("Job Copilot (Jobs): QUESTION happened");
    expect(failing.warns).toEqual([[expect.objectContaining({ paneId: "pane:job00001" }), "Job Copilot Telegram notification failed"]]);
  });

  it("a sign-in the agent logs is a focus card: Go now on the site's tab, one question, the steps as the body (operator nous_msg:4b36b80e)", async () => {
    const { onEvent, raise } = wire({ browser: { currentUrl: "https://jobs.example.org/", pages: [
      { pageId: "page:jobs0001", url: "https://jobs.example.org/" }, { pageId: "page:acme0001", url: "https://careers.acme.com/login" }] } });
    onEvent!({ ...event("HANDOFF_REQUESTED"), message: "Workday sign-in on careers.acme.com needs you: 1) Open the tab 2) Sign in with Google" });
    await flush(); await flush();
    expect(raise.mock.calls[0]?.[0]).toMatchObject({ kind: "HANDOFF_REQUESTED", link: { paneId: "pane:job00001", target: "tab:page:acme0001" },
      body: "Workday sign-in on careers.acme.com needs you:\n1) Open the tab\n2) Sign in with Google",
      payload: { eventId: "jobev:handoff_requested", ask: { question: "Take over the browser on careers.acme.com", options: ["Go now"] } } });
  });

  it("logs a listener failure instead of throwing", async () => {
    const { onEvent, warns } = wire({ publishFails: true });
    expect(() => onEvent!(event("NOTE"))).not.toThrow();
    await flush();
    expect(warns).toEqual([[expect.objectContaining({ err: expect.any(Error) }), "Job Copilot event listener failed"]]);
  });

  it("types the run's kickoff only into a running CLI session", async () => {
    const run = { id: "jobrun:1" };
    await expect(wire().routes[0]!.kickoff(jobPane(), run, false)).rejects.toThrow(/Open the copilot's terminal first/);
    captured.routes = [];
    const exited = wire({ session: { sessionId: "cli:1", purpose: "NORMAL", isActive: true, status: "EXITED" } });
    await expect(exited.routes[0]!.kickoff(jobPane(), run, false)).rejects.toThrow(/no running CLI session/);
    captured.routes = [];
    const live = wire({ session: { sessionId: "cli:2", purpose: "NORMAL", isActive: true, status: "RUNNING" } });
    await live.routes[0]!.kickoff(jobPane(), run, true);
    expect(live.mutations).toEqual(["cli:2"]);
    expect(captured.prompts[0]).toEqual([expect.anything(), "cli:2", expect.stringContaining("first find new postings"), "job-apply:jobrun:1", expect.stringMatching(/^job-apply:jobrun:1:kickoff:/)]);
    expect(captured.prompts[0]![2]).toContain("Job Copilot run jobrun:1 started");
    // Plan clipboard:qH5emwVaV6yO step 4: a run with no application in progress starts a fresh session; one resuming an application keeps it.
    expect(captured.clears).toHaveLength(1);
    await live.routes[0]!.kickoff(jobPane(), { ...run, currentApplicationId: "jobapp:1" }, false);
    expect(captured.clears).toHaveLength(1);
    // Daily Nous errors F: a re-kick of the same run (the other prompt, 13/11 19:10) types under a new input key, never the first one's.
    expect(captured.prompts[1]![4]).not.toBe(captured.prompts[0]![4]);
  });

  it("answers 401 without a valid session and the stored user id with one", async () => {
    const { routes } = wire();
    const user = { id: "user:owner01", email: "o@example.com", role: "ADMIN" as const };
    await expect(routes[0]!.authenticatedOwner({ user: null, cookies: {} })).rejects.toMatchObject({ statusCode: 401 });
    await expect(routes[0]!.authenticatedOwner({ user, cookies: { [cookieName]: "forged.token" } })).rejects.toThrow("Sign in to use Job Copilot.");
    await expect(routes[0]!.authenticatedOwner({ user, cookies: { [cookieName]: signSession(user, SECRET) } })).resolves.toBe("user:owner01:stored");
  });
});
