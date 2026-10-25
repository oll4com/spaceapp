import Fastify from "fastify";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dotWorkspacePath } from "@space/contracts";
import { createDotComputerService, readDotWorkspace, registerDotComputerRoutes, type DotComputerDeps } from "../src/dot-computer.js";

const dotId = `dot:${"c".repeat(32)}`;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function run(id: string, sessionId: string, clientRequestId: string | null) {
  return { runId: id, sessionId, roomId: "room:1", roomName: "Room", paneId: `pane:${sessionId}`, title: "Write report", status: "RUNNING" as const,
    clientRequestId, startedAt: "2026-10-10T10:00:00.000Z" };
}
function fixture(root: string, options: { browsersEnabled?: boolean; otherWinner?: string } = {}) {
  const events: string[] = [];
  let created = 0;
  let ownPane: string | null = null;
  const dots = {
    get: vi.fn(async (owner: string, id: string) => owner === "user:1" && id === dotId
      ? { dotId, name: "Luna", workLimits: { maxConcurrentTasks: 2, dailyBudgetUsd: null } } : null),
    listActiveRuns: vi.fn(async () => [run("run:1", "s1", null), run("run:2", "s2", "goal-abc"), run("run:3", "s3", "proactive-abc")]),
    listDotBrowserPanes: vi.fn(async () => ownPane ? [{ roomId: "room:1", roomName: "Room", paneId: ownPane }] : []),
    dotBrowserPane: vi.fn(async () => ownPane),
    recordDotBrowserPane: vi.fn(async (_owner: string, _dot: string, _room: string, paneId: string) => { ownPane ??= options.otherWinner ?? paneId; return ownPane; })
  };
  const goals = { list: vi.fn(async (_owner: string, _dot: string, sessionId?: string) => [
    { goalId: "dot_goal:active01", objective: "Ship", status: "ACTIVE", sessionId: "s2", usage: { steps: 2 }, budget: { maxSteps: 20 } },
    { goalId: "dot_goal:done0001", objective: "Old", status: "COMPLETED", sessionId: "s1", usage: { steps: 5 }, budget: { maxSteps: 5 } }
  ].filter((goal) => !sessionId || goal.sessionId === sessionId)) };
  const deps: DotComputerDeps = {
    dots: dots as never, goals: goals as never, workspaceRoot: root,
    pauseGoal: vi.fn(async (_owner, _dot, goalId) => { events.push(`pause:${goalId}`); return true; }),
    interrupt: vi.fn(async (value) => { events.push(`interrupt:${value.runId}`); return value.sessionId !== "s3"; }),
    browserState: vi.fn(async (paneId: string) => ({ active: true, currentUrl: "https://example.com/", title: "Example",
      sessionId: `browser_session:${paneId.slice(5)}`, ready: paneId === "pane:browser" })),
    ...(options.browsersEnabled === false ? {} : {
      createBrowserPane: vi.fn(async () => { events.push("create"); await new Promise((resolve) => setTimeout(resolve, 5)); return created++ ? `pane:browser${created}` : "pane:browser"; }),
      openBrowser: vi.fn(async (paneId: string, url: string | null) => ({ sessionId: "browser_session:1", active: true, currentUrl: url, title: null, paneId })),
      closePane: vi.fn(async (paneId: string) => { events.push(`close:${paneId}`); })
    }),
    audit: vi.fn(async () => undefined)
  };
  return { service: createDotComputerService(deps), deps, dots, goals, events };
}

describe("Dot computer", () => {
  it("lists the private workspace newest first and reports a missing one", async () => {
    const root = await mkdtemp(join(tmpdir(), "dot-computer-")); roots.push(root);
    expect(await readDotWorkspace(join(root, "missing"))).toEqual({ path: join(root, "missing"), exists: false, entries: [], totalEntries: 0, sortedAll: true });
    await writeFile(join(root, "old.txt"), "old");
    await utimes(join(root, "old.txt"), new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    await writeFile(join(root, "new.md"), "newer text");
    await mkdir(join(root, "drafts"));
    const listed = await readDotWorkspace(root, 2);
    expect(listed).toMatchObject({ exists: true, totalEntries: 3, sortedAll: true });
    expect(listed.entries).toHaveLength(2);
    expect(listed.entries.map((entry) => entry.name)).not.toContain("old.txt");
    expect(listed.entries.find((entry) => entry.name === "new.md")).toMatchObject({ kind: "file", bytes: 10 });
    expect(listed.entries.find((entry) => entry.name === "drafts")).toMatchObject({ kind: "directory", bytes: null });
  });

  it("shows live work by kind, open goals, browsers and the task limit for the owner only", async () => {
    const root = await mkdtemp(join(tmpdir(), "dot-computer-")); roots.push(root);
    const { service } = fixture(root);
    await mkdir(dotWorkspacePath(dotId, root), { recursive: true });
    await writeFile(join(dotWorkspacePath(dotId, root), "report.md"), "# Report");
    const computer = await service.read("user:1", dotId);
    expect(computer.workspace).toMatchObject({ path: dotWorkspacePath(dotId, root), exists: true, entries: [{ name: "report.md" }] });
    expect(computer.runs.map((value) => value.kind)).toEqual(["CHAT", "GOAL", "SCHEDULE"]);
    expect(computer.goals).toEqual([{ goalId: "dot_goal:active01", objective: "Ship", status: "ACTIVE", steps: 2, maxSteps: 20 }]);
    expect(computer.limits).toEqual({ maxConcurrentTasks: 2, activeTasks: 3 });
    expect(computer.browsers).toEqual([]);
    await expect(service.read("user:2", dotId)).rejects.toMatchObject({ status: 404 });
  });
  it("names each browser's open session and whether it runs, so the card's picture never starts a browser", async () => {
    const root = await mkdtemp(join(tmpdir(), "dot-computer-")); roots.push(root);
    const { service, dots, deps } = fixture(root);
    await dots.recordDotBrowserPane("user:1", dotId, "room:1", "pane:browser");
    expect((await service.read("user:1", dotId)).browsers).toEqual([{ roomId: "room:1", roomName: "Room", paneId: "pane:browser", active: true,
      currentUrl: "https://example.com/", title: "Example", sessionId: "browser_session:browser", ready: true }]);
    vi.mocked(deps.browserState).mockResolvedValueOnce({ active: true, currentUrl: null, title: null, sessionId: "browser_session:browser", ready: false });
    expect((await service.read("user:1", dotId)).browsers[0]).toMatchObject({ sessionId: "browser_session:browser", ready: false });
    // A stopped browser has no session to show; a state without a session is never ready.
    vi.mocked(deps.browserState).mockResolvedValueOnce({ active: false, currentUrl: null, title: null, sessionId: "browser_session:old", ready: true });
    expect((await service.read("user:1", dotId)).browsers[0]).toMatchObject({ active: false, sessionId: null, ready: false });
    vi.mocked(deps.browserState).mockResolvedValueOnce({ active: true, currentUrl: null, title: null, ready: true });
    expect((await service.read("user:1", dotId)).browsers[0]).toMatchObject({ sessionId: null, ready: false });
  });

  it("pauses active goals before interrupting runs, optionally for one conversation", async () => {
    const root = await mkdtemp(join(tmpdir(), "dot-computer-")); roots.push(root);
    const all = fixture(root);
    expect(await all.service.stop("user:1", dotId, {}, null)).toEqual({ dotId, interruptedRuns: 2, pausedGoals: 1 });
    expect(all.events).toEqual(["pause:dot_goal:active01", "interrupt:run:1", "interrupt:run:2", "interrupt:run:3"]);
    const one = fixture(root);
    expect(await one.service.stop("user:1", dotId, { sessionId: "s1" }, null)).toEqual({ dotId, interruptedRuns: 1, pausedGoals: 0 });
    expect(one.events).toEqual(["interrupt:run:1"]);
    await expect(one.service.stop("user:2", dotId, {}, null)).rejects.toMatchObject({ status: 404 });
  });

  it("opens the Dot's own browser once per room and reuses it", async () => {
    const root = await mkdtemp(join(tmpdir(), "dot-computer-")); roots.push(root);
    const { service, deps, dots, events } = fixture(root);
    const session = { sessionId: "s1", dotId, roomId: "room:1" };
    expect(await service.browser(session, "user:1", { url: "https://example.com/" })).toMatchObject({ status: "COMPLETED",
      result: { paneId: "pane:browser", created: true, currentUrl: "https://example.com/" } });
    expect(await service.browser(session, "user:1", {})).toMatchObject({ status: "COMPLETED", result: { paneId: "pane:browser", created: false } });
    expect(events.filter((event) => event === "create")).toHaveLength(1);
    expect(dots.recordDotBrowserPane).toHaveBeenCalledWith("user:1", dotId, "room:1", "pane:browser");
    expect(deps.openBrowser).toHaveBeenLastCalledWith("pane:browser", null, { agentSessionId: "s1", roomId: "room:1" });
    expect(await service.browser(session, "user:1", { url: "file:///etc/passwd" })).toMatchObject({ status: "BLOCKED" });
    expect(await service.browser(session, "user:1", { url: "https://example.com/", extra: true })).toMatchObject({ status: "BLOCKED" });
    // Concurrent calls in one process create one pane.
    const racing = fixture(root);
    const both = await Promise.all([racing.service.browser(session, "user:1", {}), racing.service.browser(session, "user:1", {})]);
    expect(both.map((value) => (value as { result: { paneId: string } }).result.paneId)).toEqual(["pane:browser", "pane:browser"]);
    expect(racing.events.filter((event) => event === "create")).toHaveLength(1);
    // Another process won the race: use its pane and close ours.
    const lost = fixture(root, { otherWinner: "pane:winner" });
    expect(await lost.service.browser(session, "user:1", {})).toMatchObject({ status: "COMPLETED", result: { paneId: "pane:winner", created: false } });
    expect(lost.events).toContain("close:pane:browser");
    const disabled = fixture(root, { browsersEnabled: false });
    expect(await disabled.service.browser(session, "user:1", {})).toMatchObject({ status: "BLOCKED", statusReason: expect.stringMatching(/disabled/) });
  });
});

describe("Dot computer routes", () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
  it("serve interactive owners only", async () => {
    const root = await mkdtemp(join(tmpdir(), "dot-computer-")); roots.push(root);
    const { service } = fixture(root);
    let user: Record<string, unknown> | null = { id: "user:1", role: "USER" };
    const server = Fastify(); apps.push(server);
    server.addHook("preHandler", async (request) => { request.user = user as never; });
    registerDotComputerRoutes(server, service, { routeOptions: {}, authenticatedOwner: async (request) => request.user!.id });
    const read = await server.inject({ method: "GET", url: `/api/dots/${encodeURIComponent(dotId)}/computer` });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ dotId, limits: { maxConcurrentTasks: 2 } });
    expect((await server.inject({ method: "POST", url: `/api/dots/${encodeURIComponent(dotId)}/computer/stop`, payload: { sessionId: "s1" } })).json())
      .toEqual({ dotId, interruptedRuns: 1, pausedGoals: 0 });
    expect((await server.inject({ method: "POST", url: `/api/dots/${encodeURIComponent(dotId)}/computer/stop`, payload: { everything: true } })).statusCode).toBe(400);
    user = { id: "user:1", role: "USER", automationScope: "x" };
    expect((await server.inject({ method: "GET", url: `/api/dots/${encodeURIComponent(dotId)}/computer` })).statusCode).toBe(403);
    user = null;
    expect((await server.inject({ method: "GET", url: `/api/dots/${encodeURIComponent(dotId)}/computer` })).statusCode).toBe(401);
  });
});
