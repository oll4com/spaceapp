import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  nousCopilotSchema, nousPaneBoardAnswerInputSchema, nousPaneBoardRefreshInputSchema,
  type NousCopilot, type NousMessage, type NousPaneBoardAnswerResult, type Pane, type Room
} from "@space/contracts";
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
  send(owner: string, content: string, options: { person: boolean; refs: { roomId: string; paneId: string } }): Promise<NousMessage>;
}

const paneParams = z.object({ paneId: z.string().min(1).max(200) }).strict();

/**
 * The pane board (plan clipboard:Y9cgKVHFaHrr): the board, its Refresh, and one reply per pane. A reply answers a waiting CLI
 * prompt through Nous's own path (a critical prompt goes to Nous instead), a copilot question through the copilot's answer, and
 * anything else reaches Nous as the operator's message about that pane.
 */
export function registerNousPaneBoardRoutes(app: FastifyInstance, deps: PaneBoardRouteDeps): void {
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
}
