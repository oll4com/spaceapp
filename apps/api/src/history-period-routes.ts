import type { FastifyInstance, FastifyRequest } from "fastify";
import { historyPeriodDays, historySince } from "@space/contracts";

/**
 * Every history follows the owner's History period (operator 1/11 03:37 BKK «Χρονικό διάστημα ιστορικών … μέγιστο 3 μήνες --- θα ισχύει
 * για κάθε ιστορικό», plan clipboard:8riKjb1krKyL; the setting is history.periodDays, history-period.ts). The routes below answer only
 * rows inside it; what still waits (an open card, decision, brief, question, request, run or change) shows whatever its age. Nothing
 * is deleted here, and token usage keeps every row: its range pickers stop at the period in the web.
 */
type Row = Record<string, unknown>;
type HistoryList = string | { list: string; at?: string; history?: (row: Row) => boolean };

/** Statuses of an item that still waits for someone (every list's waiting states share these names). */
const WAITING = new Set(["OPEN", "READ", "PENDING", "TAKEN", "QUEUED", "IN_PROGRESS", "NEEDS_APPROVAL", "PLANNING", "NEEDS_INPUT",
  "AWAITING_APPROVAL", "RUNNING", "ESCALATED", "ASKED", "APPROVED"]);
const TIME_KEYS = ["createdAt", "at", "timestamp", "startedAt", "requestedAt", "occurredAt"];

/** Route → the arrays of its answer that are history. A row with no readable time is kept. */
export const HISTORY_ROUTES: Record<string, HistoryList[]> = {
  "/api/nous/messages": ["messages"],
  "/api/nous/messages/operator-index": ["messages"],
  "/api/nous/decisions": ["decisions"],
  "/api/nous/goals/:id/events": ["events"],
  "/api/notifications": ["notifications"],
  "/api/council/runs": ["runs"],
  "/api/rooms/:id/room-agent": ["messages", "events"],
  "/api/rooms/:id/room-agent/events": ["events"],
  "/api/live/history": ["items"],
  "/api/voice/realtime/history/:roomId": ["items"],
  "/api/voice/realtime/history/search": ["results"],
  "/api/mail-copilot/actions": ["actions"],
  "/api/mail-copilot/threads/:threadId/labels": ["history"],
  "/api/mail-copilot/events": ["events"],
  "/api/panes/:id/mail-copilot/fix-requests": ["requests"],
  "/api/marketing-copilot/events": ["events"],
  "/api/freelance-copilot/events": ["events"],
  "/api/job-apply/events": ["events"],
  "/api/panes/:id/design/requests": ["requests"],
  "/api/panes/:id/design/events": ["events"],
  "/api/panes/:id/video/requests": ["requests"],
  "/api/panes/:id/video/events": ["events"],
  "/api/panes/:id/app-studio/state": ["events"],
  "/api/panes/:id/security-copilot/state": ["actions", "events"],
  "/api/panes/:id/monitoring-copilot/state": ["actions", "events"],
  "/api/space-vault/audit": ["entries"],
  "/api/admin/streaming/bot/activity": ["data"],
  // Copies and pastes are the clipboard's history; notes and plans are records. Finished tasks by when they were last used.
  "/api/clipboard-items": [{ list: "data", at: "lastUsedAt", history: (row) => row.source === "COPY" || row.source === "PASTE" }],
  "/api/task-items": [{ list: "data", at: "lastUsedAt" }]
};

/** Routes whose own query takes the lower bound, so the store pages and counts inside the period. */
export const HISTORY_FLOORS: Record<string, { key: string; as: "iso" | "day" | "days" }> = {
  "/api/nous/requests": { key: "since", as: "iso" },
  "/api/admin/gateway/logs": { key: "from", as: "iso" },
  "/api/admin/gateway/logs/facets": { key: "from", as: "iso" },
  "/api/admin/gateway/logs/export.csv": { key: "from", as: "iso" },
  "/api/admin/gateway/reports": { key: "from", as: "day" },
  "/api/admin/gateway/anthropic-billing": { key: "days", as: "days" }
};

const timeOf = (row: Row, at?: string) => Date.parse(String(row[at ?? TIME_KEYS.find((key) => typeof row[key] === "string") ?? ""]));

/** Filters one answer's history lists; `cut` says older rows left, so nothing older is left to page to. */
export function withinHistory(payload: Row, lists: HistoryList[], since: string): { payload: Row; cut: boolean } {
  const floor = Date.parse(since);
  const out: Row = { ...payload };
  let cut = false;
  for (const entry of lists) {
    const { list, at, history } = typeof entry === "string" ? { list: entry } : entry;
    const rows = out[list];
    if (!Array.isArray(rows)) continue;
    const kept = rows.filter((row: Row) => !(history ? history(row) : !WAITING.has(String(row.status))) || !(timeOf(row, at) < floor));
    cut ||= kept.length < rows.length;
    out[list] = kept;
  }
  if (cut) {
    if (out.hasMore === true) out.hasMore = false;
    if ("nextCursor" in out) out.nextCursor = null;
    if ("nextBeforeSeq" in out) out.nextBeforeSeq = null;
  }
  return { payload: out, cut };
}

export function registerHistoryPeriod(app: FastifyInstance, settings: (request: FastifyRequest) => Promise<{ history?: unknown }>): void {
  app.addHook("preHandler", async (request) => {
    const floor = HISTORY_FLOORS[request.routeOptions.url ?? ""];
    if (!floor || !request.user) return;
    const saved = await settings(request);
    const query = (request.query ?? {}) as Row;
    const given = query[floor.key];
    if (floor.as === "days") {
      if (given !== undefined && Number(given) > historyPeriodDays(saved)) query.days = String(historyPeriodDays(saved));
      return;
    }
    const since = floor.as === "day" ? historySince(saved).slice(0, 10) : historySince(saved);
    if (typeof given !== "string" || (floor.as === "day" ? given < since : !(Date.parse(given) >= Date.parse(since)))) query[floor.key] = since;
  });
  app.addHook("preSerialization", async (request: FastifyRequest, _reply, payload: unknown) => {
    const lists = HISTORY_ROUTES[request.routeOptions.url ?? ""];
    if (!lists || !request.user || !payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
    return withinHistory(payload as Row, lists, historySince(await settings(request))).payload;
  });
}
