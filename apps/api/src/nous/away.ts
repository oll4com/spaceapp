import { randomUUID } from "node:crypto";
import { z } from "zod";
import { nousAwayGrantSchema, type NotificationRaiseInput, type NousAway, type NousAwayGrant, type NousDecisionAction, type NousDecisionCategory } from "@space/contracts";
import type { NousAwayEndReason, NousAwayLogEntry, NousAwayRepository, NousAwaySession } from "@space/db";
import { SpaceConflictError } from "@space/runtime";
import type { NotificationService } from "../notifications/service.js";
import { classifyNousOutgoing } from "./guardrails.js";

/**
 * Nous Away mode (operator request 2026-10-17, plan clipboard:B7eTUHTJYg3X): while the operator is away Nous keeps working by
 * a set procedure. The operator starts it with their own chat message (the tool space_nous_away, never from an inbox turn) or
 * with the Settings switch; their next chat message, the until time or the switch ends it. Meanwhile inbox and heartbeat
 * replies go to the away log instead of the chat, Nous's own alerts are held for one summary at the end (URGENT ones still go
 * out), and the grant lets Nous decide the granted categories itself. On return Nous briefs from the log.
 */

export const NOUS_AWAY_LOG_LIMIT = 200;
export const NOUS_AWAY_GRANTS: readonly NousAwayGrant[] = nousAwayGrantSchema.options;
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const oneLine = (text: string, max: number) => clip(text.replace(/\s+/g, " ").trim(), max);

/** The one promote the grant approves: dev to stable, run only when live:verify:dev passes first in the same command. */
const VERIFIED_PROMOTE = /npm\s+run\s+live:verify:dev\s*&&[^\n;|]*space-queue\s+promote\b/i;

/**
 * Whether the away grant decides this decision for the operator. Only a promote counts, and only when it is the decision's whole
 * risk: anything else the guardrails flag (a hotfix, queue control, a publish, a push, a delete) keeps it for the operator.
 */
export function awayGrantCovers(grant: readonly string[], decision: { category: NousDecisionCategory; action: NousDecisionAction | null }): NousAwayGrant | null {
  const action = decision.action;
  if (!grant.includes("PROMOTE") || decision.category !== "RELEASE" || action?.type !== "PANE_TEXT" || action.mode !== "PROMPT") return null;
  const verdict = classifyNousOutgoing(action.text);
  return verdict?.reasons.length === 1 && verdict.reasons[0] === "promoting dev to stable" && VERIFIED_PROMOTE.test(action.text) ? "PROMOTE" : null;
}

/** space_nous_away's arguments. FULL is the operator's "full control": every grant category. */
export const nousAwayArgsSchema = z.object({
  op: z.enum(["start", "status", "end"]),
  until: z.string().datetime({ offset: true }).optional().describe("When the operator is back, if they said so (ISO time with offset)."),
  reason: z.string().trim().min(1).max(500).optional().describe("Why, in the operator's words, e.g. \"going to sleep\"."),
  mandate: z.string().trim().min(1).max(2_000).optional().describe("What they asked you to keep doing while they are away."),
  grant: z.array(z.union([nousAwayGrantSchema, z.literal("FULL")])).max(3).optional()
    .describe("What the operator's message lets you decide alone: PROMOTE (dev to stable after live:verify:dev), TEST_PANES (restart or close their test panes), FULL (both). Only what they granted.")
});
export type NousAwayArgs = z.infer<typeof nousAwayArgsSchema>;

/** The operator's chat message this turn answers, and whether a person (not a proof or automation session) sent it. */
export interface NousAwayTurn { reason: string; operatorMessage: { id: string; content: string; person: boolean } | null }

export interface NousAwayDeps {
  repository: NousAwayRepository;
  notifications: Pick<NotificationService, "raise">;
  /** Keeps the log as a clipboard agent note when Away ends. */
  saveNote(owner: string, title: string, text: string): Promise<unknown>;
  now?: () => number;
  log?: { warn(details: Record<string, unknown>, message: string): void };
}

export function createNousAway(deps: NousAwayDeps) {
  const now = deps.now ?? Date.now;
  const warn = (details: Record<string, unknown>, message: string) => deps.log?.warn(details, message);
  const at = () => new Date(now()).toISOString();

  async function finish(session: NousAwaySession, reason: NousAwayEndReason): Promise<{ session: NousAwaySession; log: NousAwayLogEntry[] } | null> {
    const ended = await deps.repository.end(session.ownerUserId, session.id, reason, at());
    if (!ended) return null;
    const log = await deps.repository.listLog(session.id, NOUS_AWAY_LOG_LIMIT);
    const held = log.filter((entry) => entry.source === "HELD_ALERT");
    if (held.length) {
      await deps.notifications.raise({ ownerUserId: ended.ownerUserId, roomId: null, paneId: null, source: "NOUS", kind: "AWAY_SUMMARY", severity: "ATTENTION",
        title: `While you were away: ${held.length} alert${held.length === 1 ? "" : "s"} waited for you`,
        body: clip(held.map((entry) => `- ${entry.what}`).join("\n"), 2_000), link: { surface: "nous" }, dedupeKey: `nous:away:${ended.id}`, payload: {}, telegram: null })
        .catch((error) => warn({ err: error }, "Nous away summary failed."));
    }
    const day = new Date(ended.startedAt).toISOString().slice(0, 10);
    await deps.saveNote(ended.ownerUserId, `Nous: away log ${day}`, renderAwayLog(ended, log)).catch((error) => warn({ err: error }, "Nous away log note failed."));
    return { session: ended, log };
  }

  /** The owner's open session; one past its until time ends here. */
  async function current(owner: string): Promise<NousAwaySession | null> {
    const session = await deps.repository.open(owner);
    if (session?.until && Date.parse(session.until) <= now()) { await finish(session, "UNTIL"); return null; }
    return session;
  }

  /** Logs a held alert; false while the operator is here (the alert goes out). */
  async function holdAlert(owner: string, title: string): Promise<boolean> {
    const session = await current(owner).catch(() => null);
    if (!session) return false;
    await deps.repository.log(session.id, { at: at(), source: "HELD_ALERT", what: oneLine(title, 500), result: "" }).catch((error) => warn({ err: error }, "Nous away log failed."));
    return true;
  }

  async function start(owner: string, input: { until?: string | null; reason: string; mandate: string; grant: NousAwayGrant[]; operatorMessageId: string | null; operatorQuote: string | null }) {
    if (input.until && Date.parse(input.until) <= now()) throw new SpaceConflictError("The until time has already passed.");
    const session = await deps.repository.start({ id: `nous_away:${randomUUID().replace(/-/g, "").slice(0, 20)}`, ownerUserId: owner, startedAt: at(),
      until: input.until ?? null, reason: clip(input.reason, 500), mandate: clip(input.mandate, 2_000), grant: [...new Set(input.grant)],
      operatorMessageId: input.operatorMessageId, operatorQuote: input.operatorQuote ? clip(input.operatorQuote, 1_000) : null });
    if (!session) throw new SpaceConflictError("Away mode is already on.");
    return session;
  }

  async function end(owner: string, reason: NousAwayEndReason) {
    const session = await current(owner);
    return session ? finish(session, reason) : null;
  }

  async function view(owner: string): Promise<NousAway | null> {
    const session = await current(owner).catch(() => null);
    if (!session) return null;
    return { id: session.id, startedAt: session.startedAt, until: session.until, reason: session.reason, mandate: session.mandate,
      grant: session.grant.filter((category): category is NousAwayGrant => nousAwayGrantSchema.safeParse(category).success) };
  }

  return {
    current, start, end, view,

    /** The Settings switch (a person, checked by the route): starts or ends Away, or changes the open session's grant. */
    async fromSettings(owner: string, input: { away: boolean; grant?: NousAwayGrant[] | undefined; until?: string | undefined }): Promise<NousAway | null> {
      if (!input.away) { await end(owner, "SWITCH"); return null; }
      const open = await current(owner);
      if (!open) await start(owner, { until: input.until ?? null, reason: "Away switch in Settings", mandate: "Keep every plan and pane moving by the usual procedure.",
        grant: input.grant ?? [], operatorMessageId: null, operatorQuote: null });
      else if (input.grant) await deps.repository.setGrant(owner, open.id, [...new Set(input.grant)]);
      return view(owner);
    },

    /** One line of the away log; nothing while the operator is here. */
    async log(owner: string, source: string, what: string, result = ""): Promise<boolean> {
      const session = await current(owner);
      if (!session) return false;
      await deps.repository.log(session.id, { at: at(), source, what: oneLine(what, 500), result: clip(result.trim(), 4_000) });
      return true;
    },

    /** Nous's own ATTENTION alerts wait while Away (logged for the summary); URGENT ones and everything else go out as usual. */
    async raise(input: NotificationRaiseInput, options: Omit<Parameters<NotificationService["raise"]>[1] & object, "held"> = {}) {
      const held = input.source === "NOUS" && input.severity === "ATTENTION" && await holdAlert(input.ownerUserId, input.title);
      return deps.notifications.raise(input, { ...options, ...(held ? { held: true } : {}) });
    },

    /** Ends every session past its until time (the instance's minute tick). */
    async tick(): Promise<number> {
      let ended = 0;
      for (const session of await deps.repository.listOpen()) {
        if (session.until && Date.parse(session.until) <= now() && await finish(session, "UNTIL")) ended += 1;
      }
      return ended;
    },

    listLog: (session: NousAwaySession) => deps.repository.listLog(session.id, NOUS_AWAY_LOG_LIMIT),

    /** space_nous_away, after the tool checked that the operator's own message started this turn (start and end). */
    async run(owner: string, args: NousAwayArgs, turn: NousAwayTurn): Promise<string> {
      if (args.op === "status") {
        const session = await current(owner);
        return session ? `${renderAwayContext(session)}\nLogged so far: ${(await deps.repository.listLog(session.id, NOUS_AWAY_LOG_LIMIT)).length} lines.` : "The operator is here: Away mode is off.";
      }
      if (args.op === "end") {
        const ended = await end(owner, "NOUS");
        return ended ? `Away mode ended; its log (${ended.log.length} lines) is kept as the clipboard note "Nous: away log ${ended.session.startedAt.slice(0, 10)}".` : "Away mode was not on.";
      }
      const grant = (args.grant ?? []).filter((category): category is NousAwayGrant => nousAwayGrantSchema.safeParse(category).success);
      const session = await start(owner, { until: args.until ?? null, reason: args.reason ?? "The operator is away.",
        mandate: args.mandate ?? "Keep every plan and pane moving by the usual procedure.", grant,
        operatorMessageId: turn.operatorMessage?.id ?? null, operatorQuote: turn.operatorMessage ? oneLine(turn.operatorMessage.content, 300) : null });
      return `Away mode is on (${session.id}). ${renderAwayContext(session)}\nTheir next chat message ends it, and you brief them from the away log.`;
    }
  };
}

export type NousAwayControl = ReturnType<typeof createNousAway>;

/** The turn context while Away: the mandate, what the grant covers, and the quiet rules. */
export function renderAwayContext(session: NousAwaySession): string {
  const grant = session.grant.length ? session.grant.join(", ") : "none";
  return [
    `# Away mode (since ${session.startedAt.slice(0, 16)} UTC${session.until ? `, until ${session.until.slice(0, 16)} UTC` : ""}, grant ${session.id})`,
    `The operator is away: ${session.reason}. Their mandate: ${session.mandate}`,
    session.operatorQuote ? `Their words: "${session.operatorQuote}"` : "",
    "Keep the plans and panes moving by the usual procedure. Inbox and heartbeat replies go to the away log, not the chat; your alerts are held for one summary when they return. Raise an alert urgent only for a security incident or a risk of data loss.",
    `Grant: ${grant}.`
      + (session.grant.includes("PROMOTE") ? " PROMOTE: ask the RELEASE decision with action PANE_TEXT (mode PROMPT) whose text is exactly \"npm run live:verify:dev && space-queue promote --wait\" in a pane whose worktree is merged into dev; the grant approves it and the server runs it." : "")
      + (session.grant.includes("TEST_PANES") ? " TEST_PANES: you may restart or close the operator's own test panes (OPERATOR_TEST)." : ""),
    "Never under any grant (ask them as decisions; they wait for the return): npm or GitHub publishing, payments, deleting data, rooms or branches, sends to third parties, Warm code, pane-host or browser-host restarts."
  ].filter(Boolean).join("\n");
}

/** The away log as text: the return turn's briefing source and the clipboard note. */
export function renderAwayLog(session: NousAwaySession, log: NousAwayLogEntry[]): string {
  const lines = log.map((entry) => `- ${entry.at.slice(11, 16)} UTC ${entry.source}: ${entry.what}${entry.result ? ` → ${oneLine(entry.result, 600)}` : ""}`);
  return [`Away ${session.startedAt.slice(0, 16)} UTC → ${(session.endedAt ?? new Date().toISOString()).slice(0, 16)} UTC (${session.endReason ?? "open"}): ${session.reason}`,
    `Mandate: ${session.mandate}`, `Grant: ${session.grant.join(", ") || "none"}`, "", ...(lines.length ? lines : ["- Nothing was logged."])].join("\n");
}
