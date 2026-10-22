import { createHmac, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { CliBridgeClaims } from "./mail-copilot/agent-routes.js";
import { withoutNegatedRelease } from "./nous/guardrails.js";

/**
 * Grants for the merge queue's operator-only commands (hardening plan clipboard:sFj1wGEY473i step 5): `space-queue
 * promote`, `approve <ticket>` and setting `default-target` run only with one (scripts/space-queue-operator-grant.mjs
 * verifies it with the same key). The API signs one for the operator's own Settings → Releases actions, and for a pane
 * the server itself tells to run the command on the operator's authorization: an approved Nous decision, the "May
 * promote dev to stable" allowance, an Away PROMOTE grant. That pane fetches its grant once, within 30 minutes.
 */
export const queueOperatorGrantPath = "/api/cli/queue-operator-grant";
const keyLabel = "space-queue-operator-grant/v1";
const GRANT_TTL_SECONDS = 300;
const PENDING_MS = 30 * 60_000;

let signingSecret: string | null = null;
const pending = new Map<string, { op: string; by: string; until: number }>();

export function configureQueueOperatorGrants(sessionSecret: string): void { signingSecret = sessionSecret; }

/** The operator-only queue command a text asks for: `promote` or `approve:<ticket>`; null for anything else. */
export function queueOperatorOp(raw: string): string | null {
  const text = withoutNegatedRelease(raw);
  const approve = /space-queue\s+approve\s+(q-\d{8}-\d{6}-[0-9a-f]{4})\b/i.exec(text);
  if (approve) return `approve:${approve[1]}`;
  return /space-queue\s+promote\b/i.test(text) ? "promote" : null;
}

/** Signs a five-minute grant for exactly `op`; `by` names the authorization (kept in the queue's audit log). */
export function signQueueOperatorGrant(op: string, by: string, nowMs = Date.now()): string {
  if (!signingSecret || signingSecret.length < 16) throw new Error("Queue operator grants are not configured.");
  const key = createHmac("sha256", signingSecret).update(keyLabel).digest();
  const body = Buffer.from(JSON.stringify({ op, by, exp: Math.floor(nowMs / 1000) + GRANT_TTL_SECONDS, nonce: randomUUID() })).toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

/**
 * The server is about to have this pane run `text` on the operator's authorization: hold the grant it asks for. `only`
 * limits it to one operation (a pane's own screen never earns more than the promote the operator's allowance covers).
 */
export function allowPaneQueueCommand(paneId: string, text: string, by: string, options: { only?: "promote"; nowMs?: number } = {}): string | null {
  const op = queueOperatorOp(text);
  if (!op || (options.only && op !== options.only)) return null;
  pending.set(paneId, { op, by, until: (options.nowMs ?? Date.now()) + PENDING_MS });
  return op;
}

/** This pane's held grant for `op`, once. */
export function takePaneQueueGrant(paneId: string, op: string, nowMs = Date.now()): string | null {
  const held = pending.get(paneId);
  if (!held || held.op !== op || held.until < nowMs) return null;
  pending.delete(paneId);
  return signQueueOperatorGrant(op, held.by, nowMs);
}

export function registerQueueOperatorGrantRoute(app: FastifyInstance, deps: {
  routeOptions: Record<string, unknown>;
  requireBridge(request: FastifyRequest, reply: FastifyReply): Promise<{ claims: CliBridgeClaims } | null>;
}): void {
  app.post(queueOperatorGrantPath, deps.routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return reply;
    const op = (request.body as { op?: unknown } | undefined)?.op;
    if (typeof op !== "string" || !/^(?:promote|approve:q-\d{8}-\d{6}-[0-9a-f]{4}|default-target:(?:dev|stable))$/.test(op)) {
      return reply.code(400).send({ error: { code: "INVALID_OP", message: "op is promote, approve:<ticket> or default-target:<dev|stable>." } });
    }
    const grant = takePaneQueueGrant(bridge.claims.paneId, op);
    if (!grant) return reply.code(403).send({ error: { code: "NO_OPERATOR_GRANT", message: "The operator has not authorized this pane to run that command." } });
    return { grant };
  });
}
