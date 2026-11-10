import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createAdminGuard } from "./codex-sign-in.js";

/**
 * The panes that work on an open operator request (operator rule 31/10: his requests never wait), as Space's API reports them:
 * their requests carry `x-space-project: pane:<id>` and are never held by the pace cap (plan clipboard:DotwYXVD2N3n). A list the API
 * stops sending lapses after `ttlMs`, so a stopped API never exempts a pane for good.
 */
/** Nous's pace cap emergency (operator 6/11 11:31 BKK, 7/11 19:24 BKK): these panes, or all background work, until `until`; nothing it covers is held. */
export interface PaceCapEmergencyWindow { all: boolean; paneIds: readonly string[]; until: number }

export interface PriorityPanes {
  /** A project (`pane:<id>`, or null for an untagged request) the pace cap never holds now. */
  has(project: string | null): boolean;
  set(paneIds: readonly string[], emergency?: PaceCapEmergencyWindow | null): void;
  list(): string[];
  emergency(): PaceCapEmergencyWindow | null;
}

export const PRIORITY_PANES_TTL_MS = 5 * 60_000;

export function createPriorityPanes(options: { now?: () => number; ttlMs?: number } = {}): PriorityPanes {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? PRIORITY_PANES_TTL_MS;
  let panes = new Set<string>();
  let until = 0;
  let urgent: { all: boolean; panes: Set<string>; until: number } | null = null;
  // The emergency ends at its own time, and with the list when the API stops sending (`ttlMs`).
  const open = () => (urgent && now() < until && now() < urgent.until ? urgent : null);
  return {
    has(project) {
      const emergency = open();
      if (emergency && (emergency.all || (project !== null && emergency.panes.has(project)))) return true;
      return project !== null && now() < until && panes.has(project);
    },
    set(paneIds, emergency) {
      panes = new Set(paneIds);
      urgent = emergency ? { all: emergency.all, panes: new Set(emergency.paneIds), until: emergency.until } : null;
      until = now() + ttlMs;
    },
    list: () => (now() < until ? [...panes] : []),
    emergency: () => { const emergency = open(); return emergency ? { all: emergency.all, paneIds: [...emergency.panes], until: emergency.until } : null; }
  };
}

const paneId = z.string().regex(/^pane:[A-Za-z0-9_-]{1,64}$/);
const priorityPanesRequestSchema = z.object({
  paneIds: z.array(paneId).max(500),
  emergency: z.object({ all: z.boolean(), paneIds: z.array(paneId).max(500), until: z.string().datetime() }).strict().nullable().optional()
}).strict();

/** POST /__space-gateway/admin/priority-panes: the Space API's whole current list (it replaces the last one). */
export function registerPriorityPanesRoute(app: FastifyInstance, options: { priorityPanes: PriorityPanes; internalToken: string | null }) {
  const guard = createAdminGuard(options.internalToken);
  app.post("/__space-gateway/admin/priority-panes", async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    const parsed = priorityPanesRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(422).send({ error: { code: "invalid_priority_panes", message: "paneIds takes up to 500 pane ids (pane:...); emergency is {all, paneIds, until} or null." } });
    }
    const emergency = parsed.data.emergency;
    options.priorityPanes.set(parsed.data.paneIds, emergency ? { all: emergency.all, paneIds: emergency.paneIds, until: Date.parse(emergency.until) } : null);
    const open = options.priorityPanes.emergency();
    return { paneIds: options.priorityPanes.list(), ttlMs: PRIORITY_PANES_TTL_MS, emergency: open ? { ...open, until: new Date(open.until).toISOString() } : null };
  });
}
