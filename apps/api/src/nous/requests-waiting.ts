import { durationText } from "./digest.js";
import { openRequestsOf, type NousOpenRequest } from "./request-done.js";
import type { NousTurnItem } from "./turn-items.js";

/**
 * "Operator requests waiting" (operator 31/10 10:38 BKK «Αργείς περιμένω τόσα πράγματα»): every operator request (any age since 31/10) Nous
 * reported PENDING and nothing closed yet, with the pane doing it and that pane's state. The open requests are request-done.ts's
 * `request-done:open:` notes (Bruno/Bob, 31/10); this only renders them. Operator 31/10 10:47 BKK «Πάντα θα παίρνει νεο agent δεν θα
 * περιμένει ποτέ αλλο agent το πολύ 3 λεπτά!!»: a request whose text waits 3 minutes behind its busy pane goes to a new pane.
 */
export type WaitingRequest = Pick<NousOpenRequest, "key" | "messageId" | "summary" | "pane" | "openedAt">;
export interface WaitingPane { label: string; status: string; since: string | null }
/** The oldest text waiting for a pane, and the after-turn schedule holding it when Space Control does. */
export interface QueuedText { at: string; scheduleId?: string }
export interface RequestWaits { words(messageId: string): string | null; pane(paneId: string): WaitingPane | null; queued(paneId: string): QueuedText | null }

/** The longest an operator request (or its next step) waits behind a busy pane before Nous opens a new pane for it. */
export const NOUS_OPERATOR_WAIT_MS = 180_000;

/** Every open request, oldest first (until 31/10 only those of the last 48 hours: an older one still open fell out of sight). */
export function waitingRequestsOf(notes: Array<{ key: string; text: string }>, _now: number): WaitingRequest[] {
  return openRequestsOf(notes).sort((left, right) => left.openedAt.localeCompare(right.openedAt));
}

/** Texts waiting for each pane: Nous's held queue (nous_held) and Space Control's after-turn prompts still SCHEDULED; the oldest per pane. */
export function queuedTexts(records: Array<{ kind: string; actorId: string; key: string; value: unknown }>, owner: string): Map<string, QueuedText> {
  const queued = new Map<string, QueuedText>();
  const keep = (paneId: string, text: QueuedText) => { if (!queued.has(paneId) || text.at < queued.get(paneId)!.at) queued.set(paneId, text); };
  for (const record of records.filter((entry) => entry.actorId === owner)) {
    const value = record.value as { status?: string; items?: Array<{ heldAt?: string }>; id?: string; condition?: string; createdAt?: string;
      command?: { actions?: Array<{ kind?: string; operation?: string; target?: { paneIds?: string[] } }> } };
    if (record.kind === "nous_held" && value.status === "HELD" && value.items?.[0]?.heldAt) keep(record.key, { at: value.items[0].heldAt });
    if (record.kind !== "schedule" || value.status !== "SCHEDULED" || value.condition !== "AFTER_TURN" || !value.createdAt) continue;
    for (const action of value.command?.actions ?? []) {
      if (action.kind === "pane" && action.operation === "prompt") for (const paneId of action.target?.paneIds ?? []) keep(paneId, { at: value.createdAt, ...(value.id ? { scheduleId: value.id } : {}) });
    }
  }
  return queued;
}

/** A text for the request's pane has waited 3 minutes while that pane works on (or waits at) something else. */
export function waitsBehindBusyPane(pane: WaitingPane | null, queued: QueuedText | null, now: number): boolean {
  return Boolean(pane && queued && (pane.status === "working" || pane.status === "waiting") && now - Date.parse(queued.at) >= NOUS_OPERATOR_WAIT_MS);
}

// A quote beside the message id, every request listed; space_open_requests reads each one whole.
const wordsOf = (request: WaitingRequest, waits: RequestWaits) => quote((request.messageId && waits.words(request.messageId)) || request.summary);
/** The operator's words as a one-line quote of 160 characters; a longer one ends with "…" (space_open_requests reads it whole). */
export const quote = (words: string) => { const line = words.replace(/\s+/g, " ").trim(); return line.length > 160 ? `${line.slice(0, 159)}…` : line; };

/** The urgent inbox line for a request waiting behind a busy pane. */
export function requestWaitLine(request: WaitingRequest, waits: RequestWaits): string {
  const pane = waits.pane(request.pane!)!;
  const queued = waits.queued(request.pane!)!;
  return `Operator request ${request.messageId ? `[${request.messageId}] ` : ""}«${wordsOf(request, waits)}» has waited 3+ min behind ${pane.label} (${pane.status}`
    + `${pane.since ? ` since ${pane.since.slice(11, 16)} UTC` : ""}; its text waits since ${queued.at.slice(11, 16)} UTC): open a new pane for it now (space_open_panes) and send it there with alsoTo: true`
    + `${queued.scheduleId ? `, then cancel the text queued for ${pane.label} (space_execute {"kind":"watch","operation":"cancel","id":"${queued.scheduleId}"})` : ""}`
    + ". Never wait for a busy agent more than 3 minutes (operator 31/10).";
}

/** `notDone`: the Requests tab's Not done count (requests.ts), which space_open_requests lists as notDone. */
export function renderRequestsWaiting(requests: WaitingRequest[], waits: RequestWaits, now: number, notDone = 0): string {
  if (!requests.length && !notDone) return "";
  const line = (request: WaitingRequest) => {
    const head = `- ${request.messageId ? `[${request.messageId}] ` : ""}«${wordsOf(request, waits)}» · ${durationText(now - Date.parse(request.openedAt))} ago`;
    if (!request.pane) return `${head} · no pane named`;
    const pane = waits.pane(request.pane);
    if (!pane) return `${head} · ${request.pane} is closed or gone`;
    const queued = waits.queued(request.pane);
    return `${head} · ${pane.label} ${pane.status}${pane.since ? ` since ${pane.since.slice(11, 16)} UTC` : ""}`
      + `${waitsBehindBusyPane(pane, queued, now) ? " · waits 3+ min behind a busy pane: open a new pane for it now" : ""}`;
  };
  return ["## Operator requests waiting (reported PENDING and still open, oldest first: move each one on now; never let one wait for a busy pane more than 3 minutes)",
    ...requests.map(line), ...(notDone ? [`Not done in the Requests tab: ${notDone} (space_open_requests notDone)`] : [])].join("\n");
}

/**
 * Each minute: ONE urgent inbox line (soonMs, not the inbox batch) per request whose queued text has waited 3 minutes behind a busy pane.
 * shortcut: remembered in memory, so an API restart may bring one more line for a request still waiting; persist it if that shows.
 */
export function createRequestWaitAlerts(deps: {
  waits(owner: string): Promise<(RequestWaits & { requests: WaitingRequest[]; now: number }) | null>;
  notice(owner: string, key: string, line: string, items: NousTurnItem[]): Promise<void>;
}) {
  const alerted = new Set<string>();
  return async (owner: string): Promise<void> => {
    const waits = await deps.waits(owner);
    for (const request of waits?.requests.filter((entry) => entry.pane) ?? []) {
      const queued = waits!.queued(request.pane!);
      const key = `${request.key}|${queued?.at}`;
      if (alerted.has(key) || !waitsBehindBusyPane(waits!.pane(request.pane!), queued, waits!.now)) continue;
      alerted.add(key);
      // Hold A (plan clipboard:ZWJJdBgHm64Z): the turn that carries this line moves the request before it may answer NOTHING_NEW.
      const line = requestWaitLine(request, waits!);
      await deps.notice(owner, `request-waits:${request.key}`, line, [{ key: `request:${request.key}`, kind: "REQUEST", line, requestKey: request.key, pane: request.pane!,
        paneName: waits!.pane(request.pane!)!.label, ...(request.messageId ? { messageId: request.messageId } : {}) }]);
    }
  };
}
