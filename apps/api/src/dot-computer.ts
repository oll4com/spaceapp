import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import {
  DOT_SCHEDULE_REQUEST_PREFIX,
  dotComputerSchema,
  dotComputerStopInputSchema,
  dotIdSchema,
  dotWorkspacePath,
  isDotProactiveRequest,
  type DotComputer,
  type DotComputerStopResult,
  type DotWorkspaceEntry
} from "@space/contracts";
import type { DotActiveRun, DotGoalsRepository, DotsRepository } from "@space/db";

/**
 * Space Dots Stage 4: the Computer view.
 *
 * Shows a Dot's private workspace, its live work across the owner's rooms, its
 * open Goals and its own Browser panes, and stops that work: active Goals are
 * paused first so no next step starts, then running turns are interrupted.
 * A Dot's own Browser pane has an isolated profile and is opened only when the
 * Dot asks for a browser.
 */
export class DotComputerError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 503, readonly code: string, message: string) { super(message); }
}
export interface DotBrowserState {
  active: boolean; currentUrl: string | null; title: string | null;
  /** The open session and whether its browser runs (the card's picture never starts one). */
  sessionId?: string | null; ready?: boolean;
}
export interface DotComputerDeps {
  dots: DotsRepository;
  goals: Pick<DotGoalsRepository, "list"> | null;
  workspaceRoot: string;
  pauseGoal(owner: string, dotId: string, goalId: string, request: FastifyRequest | null): Promise<boolean>;
  /** Interrupts the run only while it is still the pane's active conversation; true when interrupted. */
  interrupt(run: DotActiveRun, reason: string): Promise<boolean>;
  browserState(paneId: string): Promise<DotBrowserState>;
  /** Creates the Dot's Browser pane in a room, without the owner's Google sign-in, and returns its id. */
  createBrowserPane?(input: { owner: string; dotId: string; dotName: string; roomId: string }): Promise<string>;
  /** Starts the pane's browser when it is not running and opens the URL; refuses a pane outside the room. */
  openBrowser?(paneId: string, url: string | null, holder: { agentSessionId: string; roomId: string }): Promise<DotBrowserState & { sessionId: string }>;
  /** Closes a pane this service created but lost to a concurrent caller. */
  closePane?(paneId: string): Promise<void>;
  audit(request: FastifyRequest | null, action: string, roomId: string, metadata: Record<string, unknown>): Promise<void>;
}
function runKind(run: DotActiveRun): "CHAT" | "GOAL" | "SCHEDULE" {
  const key = run.clientRequestId ?? "";
  return key.startsWith("goal-") ? "GOAL"
    : key.startsWith(DOT_SCHEDULE_REQUEST_PREFIX) || isDotProactiveRequest(key) ? "SCHEDULE" : "CHAT";
}

const DOT_WORKSPACE_SCAN_LIMIT = 5000;
export async function readDotWorkspace(path: string, limit = 40): Promise<DotComputer["workspace"]> {
  let names: string[];
  try { names = await readdir(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, exists: false, entries: [], totalEntries: 0, sortedAll: true };
    throw error;
  }
  const entries: DotWorkspaceEntry[] = [];
  // Bounded: a workspace with many thousands of files still answers quickly.
  for (const name of names.slice(0, DOT_WORKSPACE_SCAN_LIMIT)) {
    try {
      const info = await lstat(join(path, name));
      entries.push({ name: name.slice(0, 255), kind: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
        bytes: info.isFile() ? info.size : null, modifiedAt: info.mtime.toISOString() });
    } catch { /* removed while listing */ }
  }
  entries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name));
  return { path, exists: true, entries: entries.slice(0, limit), totalEntries: names.length, sortedAll: names.length <= DOT_WORKSPACE_SCAN_LIMIT };
}

export function createDotComputerService(deps: DotComputerDeps) {
  // One browser decision at a time per Dot and room in this process; the database settles races across processes.
  const locks = new Map<string, Promise<unknown>>();
  async function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const next = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
    locks.set(key, next);
    try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); }
  }
  async function owned(owner: string, dotId: string) {
    const dot = await deps.dots.get(owner, dotId);
    if (!dot) throw new DotComputerError(404, "DOT_NOT_FOUND", "Dot was not found.");
    return dot;
  }
  async function read(owner: string, dotId: string): Promise<DotComputer> {
    const dot = await owned(owner, dotId);
    const [workspace, runs, goals, browsers] = await Promise.all([
      readDotWorkspace(dotWorkspacePath(dotId, deps.workspaceRoot)),
      deps.dots.listActiveRuns(owner, dotId, 20),
      deps.goals ? deps.goals.list(owner, dotId) : Promise.resolve([]),
      deps.dots.listDotBrowserPanes(owner, dotId)
    ]);
    const browserStates = await Promise.all(browsers.map(async (browser) => ({ ...browser,
      ...await deps.browserState(browser.paneId).catch((): DotBrowserState => ({ active: false, currentUrl: null, title: null })) })));
    return dotComputerSchema.parse({
      dotId, workspace,
      runs: runs.map((run) => ({ sessionId: run.sessionId, runId: run.runId, roomId: run.roomId, roomName: run.roomName?.slice(0, 200) ?? null,
        paneId: run.paneId, title: run.title?.slice(0, 300) ?? null, status: run.status, kind: runKind(run), startedAt: run.startedAt })),
      goals: goals.filter((goal) => goal.status === "ACTIVE" || goal.status === "PAUSED" || goal.status === "BLOCKED").slice(0, 20)
        .map((goal) => ({ goalId: goal.goalId, objective: goal.objective, status: goal.status, steps: goal.usage.steps, maxSteps: goal.budget.maxSteps })),
      browsers: browserStates.map((browser) => ({ roomId: browser.roomId, roomName: browser.roomName?.slice(0, 200) ?? null, paneId: browser.paneId,
        active: browser.active, currentUrl: browser.currentUrl?.slice(0, 2000) ?? null, title: browser.title?.slice(0, 500) ?? null,
        sessionId: browser.active ? browser.sessionId ?? null : null, ready: Boolean(browser.active && browser.sessionId && browser.ready) })),
      limits: { maxConcurrentTasks: dot.workLimits.maxConcurrentTasks, activeTasks: runs.length }
    });
  }
  async function stop(owner: string, dotId: string, raw: unknown, request: FastifyRequest | null): Promise<DotComputerStopResult> {
    const { sessionId } = dotComputerStopInputSchema.parse(raw);
    await owned(owner, dotId);
    // Pause Goals first so their workflow does not start the next step after the interrupt.
    let pausedGoals = 0;
    for (const goal of deps.goals ? await deps.goals.list(owner, dotId, sessionId) : []) {
      if (goal.status === "ACTIVE" && await deps.pauseGoal(owner, dotId, goal.goalId, request).catch(() => false)) pausedGoals += 1;
    }
    let interruptedRuns = 0;
    const runs = (await deps.dots.listActiveRuns(owner, dotId, 20)).filter((run) => !sessionId || run.sessionId === sessionId);
    for (const run of runs) {
      if (await deps.interrupt(run, "Stopped from the Dot's Computer view.").catch(() => false)) interruptedRuns += 1;
    }
    const roomIds = [...new Set(runs.map((run) => run.roomId))];
    for (const roomId of roomIds) await deps.audit(request, "dot.computer.stop", roomId, { dotId, sessionId: sessionId ?? null, interruptedRuns, pausedGoals });
    return { dotId, interruptedRuns, pausedGoals };
  }
  /** `computer.browser` for the Dot gateway: opens or reuses the Dot's own Browser pane in this room. */
  async function browser(session: { sessionId: string; dotId: string; roomId: string }, owner: string, args: Record<string, unknown>) {
    const input = z.object({ url: z.string().trim().url().max(2000).refine((url) => /^https?:\/\//i.test(url), "Use an http or https URL.").optional() })
      .strict().safeParse(args);
    if (!input.success) return { status: "BLOCKED" as const, statusReason: "computer.browser accepts only an optional http(s) url." };
    if (!deps.createBrowserPane || !deps.openBrowser) return { status: "BLOCKED" as const, statusReason: "Managed browser sessions are disabled." };
    const dot = await deps.dots.get(owner, session.dotId);
    if (!dot) return { status: "BLOCKED" as const, statusReason: "Dot was not found." };
    const { paneId, created } = await serialized(`${session.dotId}:${session.roomId}`, async () => {
      const existing = await deps.dots.dotBrowserPane(session.dotId, session.roomId);
      if (existing) return { paneId: existing, created: false };
      const fresh = await deps.createBrowserPane!({ owner, dotId: session.dotId, dotName: dot.name, roomId: session.roomId });
      const winner = await deps.dots.recordDotBrowserPane(owner, session.dotId, session.roomId, fresh);
      if (winner !== fresh) {
        // Another API instance recorded its pane first; keep one browser per Dot and room.
        await deps.closePane?.(fresh).catch(() => undefined);
        return { paneId: winner, created: false };
      }
      await deps.audit(null, "dot.computer.browser.created", session.roomId, { dotId: session.dotId, sessionId: session.sessionId, paneId: fresh });
      return { paneId: fresh, created: true };
    });
    const state = await deps.openBrowser(paneId, input.data.url ?? null, { agentSessionId: session.sessionId, roomId: session.roomId });
    return { status: "COMPLETED" as const, result: { paneId, created, browserSessionId: state.sessionId, currentUrl: state.currentUrl, title: state.title,
      next: `Use browser.* tools with targetPaneId "${paneId}". This browser has its own profile and is not signed in to the user's accounts.` } };
  }
  return { read, stop, browser };
}
export type DotComputerService = ReturnType<typeof createDotComputerService>;

export function registerDotComputerRoutes(app: FastifyInstance, service: DotComputerService | null, options: {
  routeOptions: RouteShorthandOptions;
  authenticatedOwner: (request: FastifyRequest) => Promise<string>;
}) {
  const params = z.object({ dotId: dotIdSchema }).strict();
  const user = (action: (request: FastifyRequest, owner: string, service: DotComputerService) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Sign in to use Dots." } });
      if (request.user.automationScope || request.user.proofScope === "READ_ONLY") {
        return reply.code(403).send({ error: { code: "DOTS_SCOPE_FORBIDDEN", message: "An interactive user session is required." } });
      }
      if (!service) return reply.code(503).send({ error: { code: "DOT_COMPUTER_UNAVAILABLE", message: "The Dot's computer is unavailable." } });
      try { return await action(request, await options.authenticatedOwner(request), service); }
      catch (error) {
        if (error instanceof DotComputerError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
        if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: "DOT_COMPUTER_INVALID", message: "Computer request is invalid." } });
        throw error;
      }
    };
  app.get("/api/dots/:dotId/computer", options.routeOptions, user(async (request, owner, service) => {
    const { dotId } = params.parse(request.params);
    return service.read(owner, dotId);
  }));
  app.post("/api/dots/:dotId/computer/stop", options.routeOptions, user(async (request, owner, service) => {
    const { dotId } = params.parse(request.params);
    return service.stop(owner, dotId, request.body ?? {}, request);
  }));
}
