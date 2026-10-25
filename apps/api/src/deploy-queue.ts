import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  deployQueueReportSchema, deployQueueTicketStatusSchema,
  type DeployQueueBatch, type DeployQueueReport, type DeployQueueSubmitter, type DeployQueueTicket
} from "@space/contracts";

export const defaultDeployQueueRoot = "/opt/spaceapp/var/merge-queue";
const ACTIVE = new Set(["AWAITING_APPROVAL", "QUEUED", "INTEGRATING", "VERIFYING", "DEPLOYING"]);
const HEARTBEAT_STALE_MS = 90_000;
const MAX_TICKET_FILES = 500;

type JsonRecord = Record<string, unknown>;

/** Resolves a submitter's pane and room names; null when they no longer exist. */
export interface DeployQueueNameLookup {
  paneTitle(paneId: string): Promise<string | null>;
  roomName(roomId: string): Promise<string | null>;
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 50).map((item) => item.slice(0, 300)) : [];
}

async function readJson(path: string): Promise<JsonRecord | null> {
  try { return record(JSON.parse(await readFile(path, "utf8"))); } catch { return null; }
}

/** The time the ticket entered its current status: the first entry of the last run of entries with that status. */
function statusSince(history: JsonRecord[], status: string): string | null {
  let since: string | null = null;
  for (let index = history.length - 1; index >= 0 && history[index]!.status === status; index -= 1) {
    since = text(history[index]!.at, 40) || since;
  }
  return since;
}

/** Batch ids are `b-YYYYMMDD-HHMMSS-xxxx` in UTC, written when the batch starts integrating. */
export function batchStartedAt(batchId: string): string | null {
  const match = /^b-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(batchId);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

function submitter(raw: JsonRecord): DeployQueueSubmitter | null {
  const value = record(raw.submitter);
  if (!value) return null;
  const field = (name: string, max: number) => text(value[name], max) || null;
  const result = {
    runtimeId: field("runtimeId", 80), cliSessionId: field("cliSessionId", 120),
    paneId: field("paneId", 120), roomId: field("roomId", 120), paneTitle: null, roomName: null
  };
  return result.runtimeId || result.paneId || result.cliSessionId ? result : null;
}

/** Only operator-facing fields: no logs, worktree paths or resolver output leave the queue directory. */
function toTicket(raw: JsonRecord): DeployQueueTicket | null {
  const status = deployQueueTicketStatusSchema.safeParse(raw.status);
  const id = text(raw.id, 80);
  if (!status.success || !id) return null;
  const history = Array.isArray(raw.history) ? raw.history.map(record).filter(Boolean) as JsonRecord[] : [];
  const result = record(raw.result);
  const autoResolved = record(raw.autoResolved);
  const remotes = result?.remotes === "ok" || result?.remotes === "failed" ? result.remotes : null;
  const updatedAt = text(raw.updatedAt, 40) || text(raw.submittedAt, 40);
  return {
    id,
    status: status.data,
    branch: text(raw.branch, 200),
    summary: text(raw.summary, 240),
    sha: text(raw.sha, 40),
    submittedAt: text(raw.submittedAt, 40),
    updatedAt,
    note: text(history.at(-1)?.note, 1000) || null,
    deployedCommit: text(result?.commit, 40) || null,
    conflictFiles: status.data === "CONFLICT" ? stringList(result?.files) : [],
    autoResolvedFiles: stringList(autoResolved?.files),
    remotes,
    statusSince: statusSince(history, status.data) ?? (updatedAt || null),
    submitter: submitter(raw)
  };
}

function toBatch(raw: JsonRecord | null, tickets: Map<string, DeployQueueTicket>): DeployQueueBatch | null {
  if (!raw) return null;
  const batchId = text(raw.batchId, 80);
  const phase = text(raw.phase, 20);
  const ticketIds = stringList(raw.tickets).slice(0, 20);
  // Every ticket of a batch changes status together; the earliest change is when this phase began.
  const phaseTimes = ticketIds.map((id) => tickets.get(id)).filter((ticket) => ticket?.status === phase)
    .map((ticket) => ticket!.statusSince).filter((at): at is string => Boolean(at)).sort();
  return {
    batchId, phase, ticketIds,
    batchStartedAt: batchStartedAt(batchId) ?? (text(raw.startedAt, 40) || null),
    phaseStartedAt: phaseTimes[0] ?? (text(raw.startedAt, 40) || null),
    candidate: text(raw.candidate, 40) || null
  };
}

/** Fills in pane and room names once per id; a failed lookup leaves the name empty. */
async function nameSubmitters(tickets: DeployQueueTicket[], names: DeployQueueNameLookup): Promise<void> {
  const panes = new Map<string, Promise<string | null>>();
  const rooms = new Map<string, Promise<string | null>>();
  const once = (cache: Map<string, Promise<string | null>>, id: string, load: (id: string) => Promise<string | null>) => {
    if (!cache.has(id)) cache.set(id, load(id).then((value) => value?.slice(0, 120) || null, () => null));
    return cache.get(id)!;
  };
  await Promise.all(tickets.map(async (ticket) => {
    const who = ticket.submitter;
    if (!who) return;
    const [paneTitle, roomName] = await Promise.all([
      who.paneId ? once(panes, who.paneId, (id) => names.paneTitle(id)) : null,
      who.roomId ? once(rooms, who.roomId, (id) => names.roomName(id)) : null
    ]);
    ticket.submitter = { ...who, paneTitle, roomName };
  }));
}

export async function readDeployQueue(root = defaultDeployQueueRoot, now = Date.now(), names?: DeployQueueNameLookup): Promise<DeployQueueReport> {
  const state = await readJson(join(root, "state.json"));
  let fileNames: string[];
  try {
    fileNames = (await readdir(join(root, "tickets"))).filter((name) => name.endsWith(".json")).sort().slice(-MAX_TICKET_FILES);
  } catch {
    return deployQueueReportSchema.parse({
      available: false, daemonRunning: false, heartbeatAt: null, paused: null, current: null, next: null, active: [], recent: []
    });
  }
  const tickets = (await Promise.all(fileNames.map((name) => readJson(join(root, "tickets", name)))))
    .map((raw) => (raw ? toTicket(raw) : null))
    .filter((ticket): ticket is DeployQueueTicket => ticket !== null);
  const heartbeatAt = text(state?.heartbeatAt, 40) || null;
  const heartbeatMs = heartbeatAt ? Date.parse(heartbeatAt) : Number.NaN;
  const paused = record(state?.paused);
  const current = record(state?.current);
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const active = tickets.filter((ticket) => ACTIVE.has(ticket.status)).sort((a, b) => a.submittedAt.localeCompare(b.submittedAt)).slice(0, 200);
  const recent = tickets.filter((ticket) => !ACTIVE.has(ticket.status)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30);
  if (names) await nameSubmitters([...active, ...recent], names);
  return deployQueueReportSchema.parse({
    available: true,
    // The daemon writes a heartbeat every poll; a busy batch keeps state.current set.
    daemonRunning: Number.isFinite(heartbeatMs) && (now - heartbeatMs < HEARTBEAT_STALE_MS || current !== null),
    heartbeatAt,
    paused: paused ? { reason: text(paused.reason, 500), at: text(paused.at, 40) } : null,
    current: toBatch(current, byId),
    next: toBatch(record(state?.next), byId),
    active,
    recent
  });
}
