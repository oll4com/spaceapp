import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  needsYouAnswerKind, needsYouAsk, notificationAnswerInputSchema, notificationIdSchema, nousCopilotSchema, nousPaneBoardAnswerInputSchema, nousPaneBoardRefreshInputSchema,
  type NotificationAnswerResult, type NotificationStatus, type NousCopilot, type NousDecisionAction, type NousMessage, type NousPaneBoardAnswerResult, type Pane, type Room,
  type SpaceNotification
} from "@space/contracts";
import type { NewNousLedgerRow } from "@space/db";
import { SpaceConflictError, SpaceNotFoundError } from "@space/runtime";
import { isOperatorPerson, noteOperatorPromoteLine } from "../queue-operator-grants.js";
import { paneLabel } from "./digest.js";
import type { PaneBoardService } from "./pane-board.js";
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
  send(owner: string, content: string, options: { person: boolean; refs?: { roomId: string; paneId: string } }): Promise<NousMessage>;
  /** Needs you as questions (plan clipboard:5AQvaoSR-IZa): the record, and its forward-only status with the answer kept in its payload. */
  notifications: {
    get(owner: string, id: string): Promise<SpaceNotification | null>;
    setStatus(owner: string, id: string, status: Exclude<NotificationStatus, "OPEN">, payload?: Record<string, unknown>): Promise<SpaceNotification | null>;
  };
  /** Nous's space_send_to_pane path: the pane's next prompt (after its turn, held until it is at a prompt; critical text comes back refused). */
  sendToPane(owner: string, room: Room, pane: Pane, text: string): Promise<NousToolOutcome>;
  /** A copilot's review, rule or campaign decided as the operator: the server code an approved Nous COPILOT decision runs. */
  decideCopilot(owner: string, action: Extract<NousDecisionAction, { type: "COPILOT" }>): Promise<string>;
  /** Stores a kind in the operator's Always-approve list (Settings shows it and "Ask me again" removes it); the kinds stored. */
  rememberAlways(owner: string, kind: { key: string; label: string }): Promise<void>;
  alwaysKinds(owner: string): Promise<string[]>;
  /** Goal 7365014c-e: one decision-ledger row per operator answer. */
  ledger?(owner: string, row: Omit<NewNousLedgerRow, "ownerUserId">): Promise<void>;
  /** Mail Copilot's Send to AI for one thread; null when Mail Copilot is not here. */
  requestMailFix?(owner: string, pane: Pane, input: { account: string; threadId: string; note: string }): Promise<void>;
}

const notificationParams = z.object({ id: notificationIdSchema }).strict();

const paneParams = z.object({ paneId: z.string().min(1).max(200) }).strict();

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
    if (person && isOperatorPerson(request.user)) noteOperatorPromoteLine(pane.id, input.text, "pane-board");
    if (input.target.kind === "PROMPT") {
      deps.assertPerson(request);
      const outcome = await deps.answerPrompt(owner, room, pane, input.text);
      if (outcome.ok) return { routed: "PROMPT", display: outcome.display };
      if (!outcome.refused) throw new SpaceConflictError(outcome.result || outcome.display);
      // A critical prompt (a release, a delete, a send to third parties) is never typed from here: Nous takes the operator's answer.
      await deps.send(owner, `${label} My answer to this pane's prompt: ${input.text}\n(Space did not type it: ${outcome.result.slice(0, 400)})`, { person: true, refs });
      return { routed: "NOUS", display: `Sent to Nous: ${paneLabel(pane)}'s prompt needs its check first.` };
    }
    if (input.target.kind === "COPILOT_QUESTION") {
      deps.assertPerson(request);
      const copilot = nousCopilotSchema.parse(input.target.copilot);
      return { routed: "COPILOT_QUESTION", display: await deps.answerCopilot(owner, { copilot, questionId: input.target.questionId, paneId: pane.id, answer: input.text }) };
    }
    await deps.send(owner, `${label} ${input.text}`, { person, refs });
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
    const result = await answerNeedsYou(owner, record, input);
    if (kind) await deps.rememberAlways(owner, kind);
    return result;
  });

  /** The answer's route: an operator's answer (person), or Space's on their "Always answer like this" (`always`, never a message as the person). */
  async function answerNeedsYou(owner: string, record: SpaceNotification, input: { option?: string; text?: string }, always = false): Promise<NotificationAnswerResult> {
    if (record.status === "ACKED" || record.status === "RESOLVED") throw new SpaceConflictError("This no longer waits for an answer.");
    const ask = needsYouAsk(record);
    if (input.option && !(ask.options ?? []).includes(input.option)) throw new SpaceConflictError("That is not one of this question's answers.");
    const answer = [input.option, input.text].filter(Boolean).join(": ");
    const found = record.paneId ? await deps.pane(owner, record.paneId) : null;
    const refs = found ? { roomId: found.room.id, paneId: found.pane.id } : undefined;
    const toNous = async (why = "") => {
      await deps.send(owner, `${found ? `[${found.room.name} · ${paneLabel(found.pane)}] ` : ""}${always ? `Space answered by the operator's "Always answer like this"` : "My answer"} to "${ask.question}": ${answer}${why}`,
        { person: !always, ...(refs ? { refs } : {}) });
      return `Sent to Nous${found ? ` about ${paneLabel(found.pane)}` : ""}.`;
    };
    const target = ask.answer;
    let routed = target.kind;
    let display: string;
    if (target.kind === "PANE") {
      if (!found) throw new SpaceConflictError("That pane is closed: there is nobody to answer there.");
      const outcome = await deps.sendToPane(owner, found.room, found.pane, `Operator's answer to your needs-you (${ask.question}): ${answer}`);
      if (outcome.ok) display = `Sent to ${paneLabel(found.pane)}: it gets your answer as its next prompt.`;
      else if (outcome.refused) { routed = "NOUS"; display = await toNous(`\n(Space did not type it: ${outcome.result.slice(0, 400)})`); }
      else throw new SpaceConflictError(outcome.result || outcome.display);
    } else if (target.kind === "COPILOT_QUESTION") {
      if (!target.copilot || !target.questionId) throw new SpaceConflictError("This question does not say which copilot asked it.");
      display = await deps.answerCopilot(owner, { copilot: nousCopilotSchema.parse(target.copilot), questionId: target.questionId, paneId: record.paneId ?? "", answer });
    } else if (target.kind === "COPILOT_DECISION") {
      if (!target.copilot || !target.item || !target.itemId) throw new SpaceConflictError("This request does not say what to decide.");
      if (input.option !== "Approve" && input.option !== "Decline") throw new SpaceConflictError("Pick Approve or Decline (a note may go with it).");
      const copilot = nousCopilotSchema.parse(target.copilot);
      // Each copilot's own word for no: campaigns are cancelled, held Security and Monitoring changes declined, the rest rejected.
      const no = target.item === "CAMPAIGN" ? "cancel" : copilot === "SECURITY" || copilot === "MONITORING" ? "decline" : "reject";
      display = await deps.decideCopilot(owner, { type: "COPILOT", copilot, item: target.item, itemId: target.itemId, paneId: record.paneId,
        decision: input.option === "Approve" ? "approve" : no, ...(input.text ? { note: input.text } : {}) });
    } else if (target.kind === "MAIL_FIX" && input.text && !input.option) {
      if (!deps.requestMailFix || !found || !target.account || !target.threadId) throw new SpaceConflictError("Mail Copilot cannot take this mail here: open its pane.");
      await deps.requestMailFix(owner, found.pane, { account: target.account, threadId: target.threadId, note: input.text });
      display = "Sent to Mail Copilot: it works on this mail with your note.";
    } else if (target.kind === "MAIL_FIX" || target.kind === "ACK") {
      routed = "ACK";
      display = `Noted: ${answer}.`;
    } else {
      display = await toNous();
    }
    const notification = await deps.notifications.setStatus(owner, record.id, "ACKED", { answer: { text: answer, at: new Date().toISOString(), routed, ...(always ? { by: "ALWAYS" } : {}) } });
    // Goal 7365014c-e: the operator's own answers go to the decision ledger (an "Always answer like this" is not one).
    if (!always) await deps.ledger?.(owner, { source: `NEEDS_YOU:${record.source}`, kind: needsYouAnswerKind(record)?.key ?? `${record.source}:${record.kind}`, title: ask.question,
      predicted: ask.recommended ?? null, answer, match: ask.recommended ? input.option === ask.recommended : null, ref: record.id }).catch(() => undefined);
    return { routed, display, notification };
  }

  return {
    /** A new needs-you card of a kind the operator chose "Always answer like this" for: answered with its recommended option, or null. */
    async autoAnswer(record: SpaceNotification): Promise<NotificationAnswerResult | null> {
      const kind = needsYouAnswerKind(record);
      if (!kind || !(await deps.alwaysKinds(record.ownerUserId)).includes(kind.key)) return null;
      return answerNeedsYou(record.ownerUserId, record, { option: needsYouAsk(record).recommended! }, true);
    }
  };
}
