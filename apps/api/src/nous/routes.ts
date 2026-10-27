import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { nousAwayInputSchema, nousDecisionAnswerInputSchema, nousDecisionFeedbackInputSchema, nousDecisionIdSchema, nousSendInputSchema, nousSettingsInputSchema } from "@space/contracts";
import type { NousAwayControl } from "./away.js";
import type { NousAttachments } from "./attachments.js";
import type { NousScorecard } from "./progress.js";
import { operatorMessagesToAnswer, type NousService } from "./service.js";

export interface NousRouteDependencies {
  routeOptions: Record<string, unknown>;
  /** The signed-in ADMIN or OPERATOR's user id. */
  owner(request: FastifyRequest): Promise<string>;
  /** A person at the dock, never a proof or automation session: only they answer Nous's critical decisions. */
  assertPerson(request: FastifyRequest): void;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
  /** Nous's scorecard against its 2026-10-17 baseline (read only). */
  progress(owner: string): Promise<NousScorecard>;
  /** Files the operator sends with a message (plan clipboard:hQg9iKGYDqx7); without it messages carry text only. */
  attachments?: NousAttachments;
  /** Away mode's Settings switch (plan clipboard:B7eTUHTJYg3X). */
  away?: Pick<NousAwayControl, "fromSettings">;
  /** "Show everything" (operator request 2026-10-21): the texts a decision sends, read whole from the files it names. */
  decisionFiles(owner: string, id: string): Promise<Array<{ ref: string; text: string | null; total: number | null; truncated: boolean; error?: string }>>;
  /** Where Nous works on its own, only a person turns an allowance (May promote, May approve Warm) on. */
  assertAllowanceChange(request: FastifyRequest, owner: string, input: z.infer<typeof nousSettingsInputSchema>): Promise<void>;
  /** The installed Vault broker's commit, hash and the diff stat of its sources to stable's HEAD (vault/broker-report.ts). */
  vaultBrokerReport?(): Promise<string>;
}

const decisionParams = z.object({ id: nousDecisionIdSchema }).strict();
const vaultBrokerReinstallSchema = z.object({ reason: z.string().trim().min(1).max(1_000) }).strict();

/** The Nous dock: state, conversation, settings, decisions and the overview. */
export function registerNousRoutes(app: FastifyInstance, service: NousService, deps: NousRouteDependencies): void {
  const { routeOptions, parseBody, parseQuery } = deps;

  app.get("/api/nous", routeOptions, async (request) => ({ state: await service.state(await deps.owner(request)) }));

  // Read only: what Nous's turns ran on and cost (space-admin-action nous-turn-costs; the model study, 2026-10-21).
  app.get("/api/nous/turn-costs", routeOptions, async (request) => {
    const { days } = parseQuery(z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }).strict(), request.query);
    return { costs: await service.turnCosts(await deps.owner(request), days) };
  });

  app.get("/api/nous/messages", routeOptions, async (request) => {
    const owner = await deps.owner(request);
    const messages = await service.messages(owner);
    const operatorIds = messages.filter((message) => message.kind === "OPERATOR").map((message) => message.id);
    // `waiting`: the operator's messages still in Nous's queue (no answer yet); the dock marks them queued or being answered.
    return { messages, waiting: operatorMessagesToAnswer(messages).map((message) => message.id), attachments: deps.attachments ? await deps.attachments.forMessages(owner, operatorIds) : {} };
  });

  app.post("/api/nous/messages", routeOptions, async (request, reply) => {
    const owner = await deps.owner(request);
    const input = parseBody(nousSendInputSchema, request.body);
    const ids = input.attachmentIds ?? [];
    if (ids.length && !deps.attachments) return reply.code(422).send({ error: { code: "ATTACHMENTS_UNAVAILABLE", message: "Files cannot be sent to Nous here." } });
    // The files' block rides on the operator's message, so every turn that sees the message sees its files.
    const prepared = ids.length ? await deps.attachments!.prepare(owner, ids) : null;
    // Only a person at the dock (never a proof or automation session) can start Away from the chat.
    let person = true;
    try { deps.assertPerson(request); } catch { person = false; }
    const message = await service.send(owner, [input.content, prepared?.block].filter(Boolean).join("\n\n"), { person });
    if (prepared) await deps.attachments!.link(owner, message.id, prepared.attachments.map((attachment) => attachment.id));
    return reply.code(202).send({ message, attachments: prepared?.attachments ?? [] });
  });

  app.delete("/api/nous/messages", routeOptions, async (request) => {
    const owner = await deps.owner(request);
    const cleared = await service.clear(owner);
    await deps.attachments?.clear(owner);
    return { cleared };
  });

  app.post("/api/nous/stop", routeOptions, async (request) => ({ stopped: service.stop(await deps.owner(request)) }));

  app.patch("/api/nous/settings", routeOptions, async (request) => {
    const owner = await deps.owner(request);
    const input = parseBody(nousSettingsInputSchema, request.body);
    await deps.assertAllowanceChange(request, owner, input);
    return { settings: await service.saveSettings(owner, input) };
  });

  app.post("/api/nous/away", routeOptions, async (request, reply) => {
    const owner = await deps.owner(request);
    deps.assertPerson(request);
    if (!deps.away) return reply.code(422).send({ error: { code: "NOUS_AWAY_UNAVAILABLE", message: "Away mode is not available here." } });
    return { away: await deps.away.fromSettings(owner, parseBody(nousAwayInputSchema, request.body)) };
  });

  app.get("/api/nous/overview", routeOptions, async (request) => ({ overview: await service.overview(await deps.owner(request)) }));

  app.get("/api/nous/progress", routeOptions, async (request) => ({ progress: await deps.progress(await deps.owner(request)) }));

  app.get("/api/nous/decisions", routeOptions, async (request) => ({ decisions: await service.decisions(await deps.owner(request)) }));

  // An agent asks for the Vault broker's reinstall (space-admin-action vault-broker-reinstall); only the operator's yes runs it.
  app.post("/api/nous/decisions/vault-broker-reinstall", routeOptions, async (request) => {
    const { reason } = parseBody(vaultBrokerReinstallSchema, request.body);
    // The operator approves a build of stable's code nobody reviewed as a broker diff: the card shows what the reinstall would change.
    const report = deps.vaultBrokerReport ? await deps.vaultBrokerReport().catch((error: Error) => `**Installed broker:** could not be read (${error.message}).`) : null;
    return { decision: await service.ask({ ownerUserId: await deps.owner(request), category: "RELEASE", title: "Reinstall the Vault broker from stable's code",
      body: "Space builds the broker from stable's committed code (refused if /opt/spaceapp has local changes), installs it as root, keeps the old one "
        + "as broker.mjs.previous and restarts space-vault-broker.service; if it does not come back, the old one is restored. Unlock the Vault once afterwards."
        + (report ? `\n\n${report}` : ""),
      options: [], recommendation: reason, refs: {}, action: { type: "VAULT_BROKER_REINSTALL" } }) };
  });

  app.get("/api/nous/decisions/:id/files", routeOptions, async (request) => {
    const owner = await deps.owner(request);
    const { id } = parseQuery(decisionParams, request.params);
    return { files: await deps.decisionFiles(owner, id) };
  });

  app.post("/api/nous/decisions/:id/answer", routeOptions, async (request) => {
    const owner = await deps.owner(request);
    deps.assertPerson(request);
    const { id } = parseQuery(decisionParams, request.params);
    return { decision: await service.answer(owner, id, parseBody(nousDecisionAnswerInputSchema, request.body)) };
  });

  app.post("/api/nous/decisions/:id/feedback", routeOptions, async (request) => {
    const owner = await deps.owner(request);
    deps.assertPerson(request);
    const { id } = parseQuery(decisionParams, request.params);
    return { decision: await service.feedback(owner, id, parseBody(nousDecisionFeedbackInputSchema, request.body).couldHaveDecided) };
  });
}
