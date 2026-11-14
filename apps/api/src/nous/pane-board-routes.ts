import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  NEEDS_YOU_GO_NOW, needsYouAnswerKind, needsYouAsk, nousAnswerIntent, needsYouTimingNow, notificationAnswerInputSchema, notificationIdSchema, nousCopilotSchema, nousPaneBoardAnswerInputSchema, nousPaneBoardRefreshInputSchema,
  type NotificationAnswerResult, type NotificationStatus, type NousCopilot, type NousDecisionAction, type NousMessage, type NousPaneBoardAnswerResult, type Pane, type Room,
  type NousClientContext, type SpaceNotification
} from "@space/contracts";
import type { NewNousLedgerRow } from "@space/db";
import { redactMemoryText, SpaceConflictError, SpaceNotFoundError } from "@space/runtime";
import { grantsFromOperatorLine, noteOperatorPromoteLine } from "../queue-operator-grants.js";
import { requestNousClient } from "../request-helpers.js";
import { paneLabel } from "./digest.js";
import type { PaneBoardService } from "./pane-board.js";
import { cardTextMatched, cardWordsConfirm } from "./predictions.js";
import type { NousToolOutcome } from "./tools.js";

export interface PaneBoardRouteDeps {
  routeOptions: Record<string, unknown>;
  owner(request: FastifyRequest): Promise<string>;
  assertPerson(request: FastifyRequest): void;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
  board: PaneBoardService;
  /** One of the owner's open panes with its room; null when it is not theirs or gone. */
  pane(owner: string, paneId: string): Promise<{ room: Room; pane: Pane } | null>;
  /** Nous's space_answer_pane path: critical prompts come back refused. */
  answerPrompt(owner: string, room: Room, pane: Pane, answer: string): Promise<NousToolOutcome>;
  /** The copilot's own answer path (Nous's space_copilot_answer), as the operator. */
  answerCopilot(owner: string, input: { copilot: NousCopilot; questionId: string; paneId: string; answer: string }): Promise<string>;
  /** The operator's message to Nous; it starts a Nous turn. */
  send(owner: string, content: string, options: { person: boolean; refs?: { roomId: string; paneId: string }; client?: NousClientContext; mobile?: { device: string; scopes: string[] } }): Promise<NousMessage>;
  /** Needs you as questions (plan clipboard:5AQvaoSR-IZa): the record, and its forward-only status with the answer kept in its payload. */
  notifications: {
    get(owner: string, id: string): Promise<SpaceNotification | null>;
    setStatus(owner: string, id: string, status: Exclude<NotificationStatus, "OPEN">, payload?: Record<string, unknown>): Promise<SpaceNotification | null>;
    /** R13-6: an answer that failed is kept on the waiting record. */
    addPayload?(owner: string, id: string, payload: Record<string, unknown>): Promise<SpaceNotification | null>;
  };
  /** R13-6: one line in Nous's inbox (deduplicated by key). */
  inbox?(owner: string, key: string, line: string): Promise<void>;
  /** Clears a plan's wait on the operator (Approve on its Needs you card); false when it did not wait on them. */
  unblockPlan?(owner: string, planId: string): Promise<boolean>;
  /** What the plan a card asks for waits on the operator for (`PlanNeedsYou.waitOf`): kept with the answer, so that wait is not asked again. */
  planWait?(owner: string, record: SpaceNotification): Promise<string | null>;
  /** Nous's space_send_to_pane path: the pane's next prompt (after its turn, held until it is at a prompt; critical text comes back refused). */
  sendToPane(owner: string, room: Room, pane: Pane, text: string): Promise<NousToolOutcome>;
  /** A copilot's review, rule or campaign decided as the operator: the server code an approved Nous COPILOT decision runs. */
  decideCopilot(owner: string, action: Extract<NousDecisionAction, { type: "COPILOT" }>): Promise<string>;
  /** Stores a kind in the operator's Always-approve list (Settings shows it and "Ask me again" removes it); the kinds stored. */
  rememberAlways(owner: string, kind: { key: string; label: string }): Promise<void>;
  alwaysKinds(owner: string): Promise<string[]>;
  /** R16-3: the owner's quiet hours now (hands wait for the morning then). */
  quiet?(owner: string): Promise<boolean>;
  /** Goal 7365014c-e: one decision-ledger row per operator answer. */
  ledger?(owner: string, row: Omit<NewNousLedgerRow, "ownerUserId">): Promise<void>;
  /** Mail Copilot's Send to AI for one thread; null when Mail Copilot is not here. */
  requestMailFix?(owner: string, pane: Pane, input: { account: string; threadId: string; note: string }): Promise<void>;
  /** R20-9: a brief to a Marketing or Freelance Copilot pane (a redraft of its review with the operator's note). */
  briefCopilot?(owner: string, pane: Pane, text: string): Promise<string>;
}

const notificationParams = z.object({ id: notificationIdSchema }).strict();

const paneParams = z.object({ paneId: z.string().min(1).max(200) }).strict();
/** The Mail Copilot flag's "the operator did it" option (mail-copilot/notify.ts). */
const MAIL_HANDLED = "I handled it";

/**
 * The pane board (plan clipboard:Y9cgKVHFaHrr): the board, its Refresh, and one reply per pane. A reply answers a waiting CLI
 * prompt through Nous's own path (a critical prompt goes to Nous instead), a copilot question through the copilot's answer, and
 * anything else reaches Nous as the operator's message about that pane.
 */
export function registerNousPaneBoardRoutes(app: FastifyInstance, deps: PaneBoardRouteDeps) {
  const { routeOptions, parseBody, parseQuery } = deps;

  app.get("/api/nous/pane-board", routeOptions, async (request) => ({ board: await deps.board.board(await deps.owner(request)) }));

  app.post("/api/nous/pane-board/refresh", routeOptions, async (request, reply) => {
    const owner = await deps.owner(request);
    // A refresh spends a model call: a person at the dock only, never an agent's session.
    deps.assertPerson(request);
    const input = parseBody(nousPaneBoardRefreshInputSchema, request.body ?? {});
    if (input.paneId && !(await deps.pane(owner, input.paneId))) throw new SpaceNotFoundError("That pane is not open in one of your rooms.");
    // The run takes up to a few minutes; new lines reach the board through NOUS_PANE_BOARD_UPDATED.
    void deps.board.tick(owner, { force: input.paneId ? new Set([input.paneId]) : "ALL" }).catch((error: unknown) => request.log.warn({ err: error }, "Pane board refresh failed."));
    return reply.code(202).send({ started: true });
  });

  app.post("/api/nous/pane-board/:paneId/answer", routeOptions, async (request): Promise<NousPaneBoardAnswerResult> => {
    const owner = await deps.owner(request);
    const { paneId } = parseQuery(paneParams, request.params);
    const input = parseBody(nousPaneBoardAnswerInputSchema, request.body);
    const found = await deps.pane(owner, paneId);
    if (!found) throw new SpaceNotFoundError("That pane is not open in one of your rooms.");
    const { room, pane } = found;
    const refs = { roomId: room.id, paneId: pane.id };
    const label = `[${room.name} · ${paneLabel(pane)}]`;
    let person = true;
    try { deps.assertPerson(request); } catch { person = false; }
    // The operator's own reply asking this pane to promote holds its promote grant, however the reply is routed (2026-10-21).
    if (person && grantsFromOperatorLine(request)) noteOperatorPromoteLine(pane.id, input.text, "pane-board");
    // From a phone Space types into no pane and answers no copilot (security review P1-1): Nous takes the operator's answer.
    const mobile = request.mobileDevice ? { device: request.mobileDevice.id, scopes: request.mobileDevice.scopes } : undefined;
    if (mobile && (input.target.kind === "PROMPT" || input.target.kind === "COPILOT_QUESTION")) {
      await deps.send(owner, `${label} My answer from my phone to this pane's ${input.target.kind === "PROMPT" ? "prompt" : "copilot question"}: ${input.text}`,
        { person, refs, client: requestNousClient(request), mobile });
      return { routed: "NOUS", display: `Sent to Nous: from a phone, Space types nothing into ${paneLabel(pane)}.` };
    }
    if (input.target.kind === "PROMPT") {
      deps.assertPerson(request);
      const outcome = await deps.answerPrompt(owner, room, pane, input.text);
      if (outcome.ok) return { routed: "PROMPT", display: outcome.display };
      if (!outcome.refused) throw new SpaceConflictError(outcome.result || outcome.display);
      // A critical prompt (a release, a delete, a send to third parties) is never typed from here: Nous takes the operator's answer.
      await deps.send(owner, `${label} My answer to this pane's prompt: ${input.text}\n(Space did not type it: ${outcome.result})`, { person: true, refs, client: requestNousClient(request) });
      return { routed: "NOUS", display: `Sent to Nous: ${paneLabel(pane)}'s prompt needs its check first.` };
    }
    if (input.target.kind === "COPILOT_QUESTION") {
      deps.assertPerson(request);
      const copilot = nousCopilotSchema.parse(input.target.copilot);
      return { routed: "COPILOT_QUESTION", display: await deps.answerCopilot(owner, { copilot, questionId: input.target.questionId, paneId: pane.id, answer: input.text }) };
    }
    await deps.send(owner, `${label} ${input.text}`, { person, refs, ...(person ? { client: requestNousClient(request) } : {}), ...(mobile ? { mobile } : {}) });
    return { routed: "NOUS", display: `Sent to Nous about ${paneLabel(pane)}.` };
  });

  /**
   * Needs you as questions (operator request 2026-10-27, plan clipboard:5AQvaoSR-IZa): the operator answers a needs-you record from its card,
   * like a Nous decision, without visiting the pane. The record's ask names where the answer goes; a person's session only.
   */
  app.post("/api/notifications/:id/answer", routeOptions, async (request): Promise<NotificationAnswerResult> => {
    const owner = await deps.owner(request);
    deps.assertPerson(request);
    const { id } = parseQuery(notificationParams, request.params);
    const input = parseBody(notificationAnswerInputSchema, request.body);
    const record = await deps.notifications.get(owner, id);
    if (!record) throw new SpaceNotFoundError("That notification does not exist.");
    const kind = input.always ? needsYouAnswerKind(record) : null;
    if (input.always && (!kind || input.option !== needsYouAsk(record).recommended || input.text)) throw new SpaceConflictError("Only the recommended option, with no note, can be your answer every time.");
    const result = await answerNeedsYou(owner, record, input, undefined, requestNousClient(request),
      request.mobileDevice ? { device: request.mobileDevice.id, scopes: request.mobileDevice.scopes } : undefined);
    if (kind) await deps.rememberAlways(owner, kind);
    return result;
  });

  /**
   * The answer's route: an operator's answer (person), or Space's on their "Always answer like this" (`by` ALWAYS) or their standing
   * hands-timing rule (`by` TIMING, R16-3); Space's answers are never a message as the person.
   */
  async function answerNeedsYou(owner: string, record: SpaceNotification, input: { option?: string; text?: string }, by?: "ALWAYS" | "TIMING" | "HANDLED", client?: NousClientContext,
    mobile?: { device: string; scopes: string[] }): Promise<NotificationAnswerResult> {
    if (record.status === "ACKED" || record.status === "RESOLVED") throw new SpaceConflictError("This no longer waits for an answer.");
    const ask = needsYouAsk(record);
    if (input.option && !(ask.options ?? []).includes(input.option)) throw new SpaceConflictError("That is not one of this question's answers.");
    const answer = [input.option, input.text].filter(Boolean).join(": ");
    const found = record.paneId ? await deps.pane(owner, record.paneId) : null;
    const refs = found ? { roomId: found.room.id, paneId: found.pane.id } : undefined;
    const toNous = async (why = "") => {
      // A plan's card with no pane (plan-needs-you.ts) names its plan, like the web's plan reply.
      const where = found ? `[${found.room.name} · ${paneLabel(found.pane)}] ` : typeof record.payload.planId === "string" ? `[Plan ${record.title} · ${record.payload.planId}] ` : "";
      await deps.send(owner, `${where}${by === "TIMING" ? "Space answered by the operator's standing rule (hands now, one by one)"
        : by ? `Space answered by the operator's "Always answer like this"` : "My answer"} to "${ask.question}": ${answer}${why}`,
        { person: !by, ...(refs ? { refs } : {}), ...(client && !by ? { client } : {}), ...(mobile ? { mobile } : {}) });
      return `Sent to Nous${found ? ` about ${paneLabel(found.pane)}` : ""}.`;
    };
    // R13-6 (11:22 BKK: Approve answered INTERNAL_ERROR and the card looked answered): a failed route keeps the card waiting with the
    // reason, tells Nous once, and answers 409 with the copilot's own words (redacted).
    const attempt = async <T>(run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch (error) {
        const text = redactMemoryText(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
        await deps.notifications.addPayload?.(owner, record.id, { answerError: { at: new Date().toISOString(), text } }).catch(() => null);
        await deps.inbox?.(owner, `needs-you-answer-failed:${record.id}`, `The operator's answer "${answer}" to "${ask.question}"${found ? ` (${found.room.name} · ${paneLabel(found.pane)})` : ""}`
          + ` did not go through: ${text}. The card stays open in Needs you; fix the cause or answer it in the pane.`).catch(() => undefined);
        throw new SpaceConflictError(`Not done: ${text} The card stays open: try again, or answer in the pane.`);
      }
    };
    // R27-3: a one-time code goes into the pane's prompt and nowhere else: not the record, the ledger, Nous's conversation or an inbox line.
    if (ask.code) {
      const code = input.text?.trim();
      if (!code || input.option) throw new SpaceConflictError("Type the code itself: it goes into the pane's prompt.");
      if (mobile) throw new SpaceConflictError("Type the code at a computer: from a phone Space types into no pane, and a code goes nowhere else.");
      // A browser handoff's code goes to the CLI that asked for it (`codePane`), not the browser pane the card is about.
      const at = typeof record.payload.codePane === "string" ? await deps.pane(owner, record.payload.codePane) : found;
      if (!at) throw new SpaceConflictError("That pane is closed: there is nobody to type the code for.");
      const sent = await deps.sendToPane(owner, at.room, at.pane, `Operator's one-time code for your needs-you (${ask.question}): ${code}`)
        .catch((error: unknown): NousToolOutcome => ({ ok: false, display: "Not typed", result: error instanceof Error ? error.message : String(error) }));
      if (!sent.ok) {
        const why = redactMemoryText((sent.result || sent.display).split(code).join("[the code]")).replace(/\s+/g, " ").trim();
        await deps.inbox?.(owner, `needs-you-answer-failed:${record.id}`, `The operator's one-time code for "${ask.question}" (${at.room.name} · ${paneLabel(at.pane)}) did not `
          + `reach the pane: ${why}. The code is not kept; the card stays open for them to type it again.`).catch(() => undefined);
        throw new SpaceConflictError(`Not typed: ${why} The code is not kept: try again, or type it in the pane.`);
      }
      const notification = await deps.notifications.setStatus(owner, record.id, "ACKED", { answer: { text: "(a one-time code, typed into the pane; not kept)", at: new Date().toISOString(), routed: "PANE" } });
      return { routed: "PANE", display: `Typed into ${paneLabel(at.pane)}; the code is kept nowhere.`, notification };
    }
    const ledger = (stored: string, match: boolean | null) => deps.ledger?.(owner, { source: `NEEDS_YOU:${record.source}`,
      kind: (record.payload.baseRate ? null : needsYouAnswerKind(record)?.key) ?? `${record.source}:${record.kind}`, title: ask.question,
      predicted: ask.recommended ?? null, answer: stored, match, ref: record.id }).catch(() => undefined);
    // R27-2: "Go now" on a Nous hands card takes the operator to the pane: the card stays (READ) for the visit, scored once, no turn for Nous.
    // R37-2: an agent's card too (answer PANE): nothing is typed into the pane, which waits for the operator there.
    if (input.option === NEEDS_YOU_GO_NOW && !input.text && !by && !mobile && (ask.answer.kind === "NOUS" || ask.answer.kind === "PANE")) {
      const again = (record.payload.answer as { text?: unknown } | undefined)?.text === NEEDS_YOU_GO_NOW;
      const went = { answer: { text: NEEDS_YOU_GO_NOW, at: new Date().toISOString(), routed: ask.answer.kind } };
      // A READ record keeps its status (the store moves only forward): the answer joins its payload.
      const notification = record.status === "OPEN" ? await deps.notifications.setStatus(owner, record.id, "READ", went)
        : await deps.notifications.addPayload?.(owner, record.id, went) ?? record;
      if (!again) await ledger(NEEDS_YOU_GO_NOW, ask.recommended ? ask.recommended === NEEDS_YOU_GO_NOW : null);
      return { routed: ask.answer.kind, display: `Going to ${found ? paneLabel(found.pane) : "the pane"}: the card stays until its work is done.`, notification };
    }
    const planCard = !found && record.payload.derived === true && Boolean(record.dedupeKey?.startsWith("nous:plan:"));
    // Operator 14/11 00:41 BKK (nous_msg:f8a4d2df): every answer closes the card; the wait it answered is kept so Space does not ask it again.
    const wait = await deps.planWait?.(owner, record).catch(() => null) ?? null;
    let cleared = false;
    const target = ask.answer;
    let routed = target.kind;
    let display: string;
    if (mobile && (target.kind === "PANE" || target.kind === "COPILOT_QUESTION")) {
      // From a phone Space types into no pane and answers no copilot (security review P1-1): Nous takes the operator's answer.
      routed = "NOUS";
      display = await attempt(() => toNous("\n(From the operator's phone: Space typed nothing into the pane.)"));
    } else if (target.kind === "PANE") {
      if (!found) throw new SpaceConflictError("That pane is closed: there is nobody to answer there.");
      const outcome = await attempt(async () => {
        const sent = await deps.sendToPane(owner, found.room, found.pane, by === "TIMING"
          ? `Operator's standing answer to your needs-you (${ask.question}): now, one by one; request the handoff.` : `Operator's answer to your needs-you (${ask.question}): ${answer}`);
        if (!sent.ok && !sent.refused) throw new Error(sent.result || sent.display);
        return sent;
      });
      if (outcome.ok) display = `Sent to ${paneLabel(found.pane)}: it gets your answer as its next prompt.`;
      else { routed = "NOUS"; display = await attempt(() => toNous(`\n(Space did not type it: ${outcome.result})`)); }
    } else if (target.kind === "COPILOT_QUESTION") {
      if (!target.copilot || !target.questionId) throw new SpaceConflictError("This question does not say which copilot asked it.");
      const copilot = nousCopilotSchema.parse(target.copilot);
      display = await attempt(() => deps.answerCopilot(owner, { copilot, questionId: target.questionId!, paneId: record.paneId ?? "", answer }));
    } else if (target.kind === "COPILOT_DECISION") {
      if (!target.copilot || !target.item || !target.itemId) throw new SpaceConflictError("This request does not say what to decide.");
      if (input.option !== "Approve" && input.option !== "Decline") throw new SpaceConflictError("Pick Approve or Decline (a note may go with it).");
      const copilot = nousCopilotSchema.parse(target.copilot);
      // Each copilot's own word for no: campaigns are cancelled, held Security and Monitoring changes declined, the rest rejected.
      const no = target.item === "CAMPAIGN" ? "cancel" : copilot === "SECURITY" || copilot === "MONITORING" ? "decline" : "reject";
      const item = target.item, itemId = target.itemId;
      // R20-9 (operator P1 30/10 21:15 BKK: "Approve: <another reply>" on Mail review mailrev:AJYxemplyr0e sent the old draft unchanged): an
      // Approve whose note runs past a few words on a Mail, Marketing or Freelance review is a redraft: nothing is sent, the review is rejected
      // with the note, and the note goes back to the copilot (Mail: Send to AI on its thread; Marketing, Freelance: a brief), which drafts anew.
      const redraft = input.option === "Approve" && item === "REVIEW" && ["MAIL", "MARKETING", "FREELANCE"].includes(copilot)
        && (input.text?.trim().split(/\s+/).length ?? 0) > 3;
      if (redraft) {
        const thread = /^thread:([^:]+):(.+)$/.exec(record.link?.target ?? "");
        if (!found || (copilot === "MAIL" ? !deps.requestMailFix || !thread : !deps.briefCopilot)) throw new SpaceConflictError("A note longer than a few words asks for a new draft, and this copilot cannot take one here: open its pane.");
        const note = `The operator did not approve review ${itemId} as it is; draft it again following their note (the old draft was not sent): ${input.text!.trim()}`;
        display = await attempt(async () => {
          await deps.decideCopilot(owner, { type: "COPILOT", copilot, item, itemId, paneId: record.paneId, decision: "reject", note: `Redraft requested: ${input.text!.trim()}` });
          if (copilot === "MAIL") await deps.requestMailFix!(owner, found.pane, { account: thread![1]!, threadId: thread![2]!, note });
          else await deps.briefCopilot!(owner, found.pane, note);
          return "Not sent: your note went back to the copilot, which drafts a new version for you to review.";
        });
      } else {
        display = await attempt(() => deps.decideCopilot(owner, { type: "COPILOT", copilot, item, itemId, paneId: record.paneId,
          decision: input.option === "Approve" ? "approve" : no, ...(input.text ? { note: input.text } : {}) }));
      }
    } else if (target.kind === "MAIL_FIX" && input.text && !input.option) {
      if (!deps.requestMailFix || !found || !target.account || !target.threadId) throw new SpaceConflictError("Mail Copilot cannot take this mail here: open its pane.");
      const fix = { account: target.account, threadId: target.threadId, note: input.text };
      await attempt(() => deps.requestMailFix!(owner, found.pane, fix));
      display = "Sent to Mail Copilot: it works on this mail with your note.";
    } else if (by === "HANDLED" && deps.inbox) {
      // Goal ee5a573e (γ), 5/11: the operator's past "I handled it" were about those mails; a new flag is Nous's to act on, never closed unread.
      routed = "NOUS";
      await deps.inbox(owner, `mail-handled:${record.id}`, `Mail Copilot flagged a mail${found ? ` (${found.room.name} · ${paneLabel(found.pane)}, pane ${found.pane.id})` : ""}`
        + ` on ${target.account ?? "an unknown account"}, thread ${target.threadId ?? "unknown"}: ${record.body.split("\n\nRecommended \"")[0]!.replace(/\s+/g, " ").trim()}. No card went to the operator`
        + ` (his "I handled it" answers were about earlier mails). Act on it yourself (tell the Mail Copilot pane what to do with the thread, a pane, a reply,`
        + ` a program update); bring it to the operator only if it needs his hands, money or taste.`);
      display = "Sent to Nous: it acts on this mail.";
    } else if (target.kind === "MAIL_FIX" || target.kind === "ACK") {
      routed = "ACK";
      display = `Noted: ${answer}.`;
    } else if (planCard && input.option === "Not now") {
      routed = "ACK";
      display = "Not now: it leaves Needs you and comes back only when the plan's wait changes.";
    } else if ((input.option === "Approve" || (planCard && input.option === "Done")) && !found && record.dedupeKey?.startsWith("nous:plan:") && typeof record.payload.planId === "string" && deps.unblockPlan) {
      // Operator 13/11 14:41 BKK: Approve on a plan's card (Done on Space's own) unblocks the plan; Nous gets the answer and runs what it was for.
      const planId = record.payload.planId;
      display = await attempt(async () => {
        cleared = await deps.unblockPlan!(owner, planId);
        await toNous(cleared ? "\n(Space cleared the plan's wait on the operator.)" : "");
        const said = input.option === "Done" ? "Done" : "Approved";
        return cleared ? `${said}: the plan no longer waits on you, and Nous carries on.` : `${said}: sent to Nous.`;
      });
    } else {
      display = await attempt(() => toNous());
    }
    // R21-pred-1: words confirming the affirmative recommended option are that option, kept with the words.
    const confirmed = !input.option && cardWordsConfirm(ask.recommended, input.text, nousAnswerIntent(input.text ?? ""), Array.isArray(ask.options) ? ask.options : []);
    const stored = confirmed ? `${ask.recommended}: ${input.text!.trim()}` : answer;
    // A cleared wait was done, not answered: if it is set again, it is asked again.
    const answered = { answer: { text: stored, at: new Date().toISOString(), routed, ...(by ? { by } : {}) }, ...(deps.planWait ? { answeredWait: cleared ? null : wait } : {}) };
    const notification = await deps.notifications.setStatus(owner, record.id, "ACKED", answered);
    // Goal 7365014c-e: the operator's own answers go to the decision ledger (an "Always answer like this" is not one).
    // R16-9: a base-rate recommendation keeps the card's kind as its plain source and kind, so the next base rate counts this answer too.
    if (!by) await ledger(stored, ask.recommended ? cardTextMatched(ask, stored) : null);
    return { routed, display, notification };
  }

  return {
    /** A new needs-you card of a kind the operator chose "Always answer like this" for: answered with its recommended option, or null. */
    async autoAnswer(record: SpaceNotification): Promise<NotificationAnswerResult | null> {
      // R16-3: by day an ask about WHEN to hand over is answered «now»; in quiet hours the morning batch holds it.
      const now = needsYouTimingNow(record);
      if (now && !record.payload.heldUntil && !(deps.quiet ? await deps.quiet(record.ownerUserId).catch(() => true) : false)) {
        return answerNeedsYou(record.ownerUserId, record, { option: now }, "TIMING");
      }
      // 2/11 rule 4: a Mail Copilot flag whose base rate (the operator's own answers, 2 or more) is "I handled it" raises no card; Nous gets it to act on (5/11).
      const baseRate = record.payload.baseRate as { option?: unknown; answers?: unknown } | undefined;
      if (record.source === "MAIL_COPILOT" && record.kind === "NEEDS_USER" && baseRate?.option === MAIL_HANDLED && Number(baseRate.answers) >= 2
        && needsYouAsk(record).recommended === MAIL_HANDLED) {
        return answerNeedsYou(record.ownerUserId, record, { option: MAIL_HANDLED }, "HANDLED");
      }
      const kind = needsYouAnswerKind(record);
      if (!kind || !(await deps.alwaysKinds(record.ownerUserId)).includes(kind.key)) return null;
      return answerNeedsYou(record.ownerUserId, record, { option: needsYouAsk(record).recommended! }, "ALWAYS");
    }
  };
}
