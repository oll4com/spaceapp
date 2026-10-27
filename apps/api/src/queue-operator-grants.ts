import type {} from "./request-context.js";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { CliBridgeClaims } from "./mail-copilot/agent-routes.js";
import { withoutNegatedRelease } from "./nous/guardrails.js";

/**
 * Grants for the merge queue's operator-only commands (hardening plan clipboard:sFj1wGEY473i step 5): `space-queue
 * promote`, `approve <ticket>` and setting `default-target` run only with one (scripts/space-queue-operator-grant.mjs
 * verifies it with the same key). The API signs one for the operator's own Settings → Releases actions, and for a pane
 * the server itself tells to run the command on the operator's authorization: an approved Nous decision, the "May
 * promote dev to stable" allowance, an Away PROMOTE grant, or the operator typing "promote" into the pane themselves
 * (operator request 2026-10-21). That pane fetches its grant once, within 30 minutes. Held grants and promote lines survive
 * API restarts in a state file (a promote's own stable deploy restarts the API; 2026-10-21 lost the operator's grant that way).
 */
export const queueOperatorGrantPath = "/api/cli/queue-operator-grant";
const keyLabel = "space-queue-operator-grant/v1";
const GRANT_TTL_SECONDS = 300;
const PENDING_MS = 30 * 60_000;

let signingSecret: string | null = null;
let stateFile: string | null = null;
type Held = { op: string; by: string; until: number };
const pending = new Map<string, Held>();

/** A person in the operator's own session; never an agent's broker, proof or automation session (hardening plan step 5). */
export const isOperatorPerson = (user: FastifyRequest["user"]): boolean =>
  user?.role === "ADMIN" && !user.automationScope && !user.brokerScope && !user.proofScope;

/** `file` keeps held grants across restarts (null: memory only, tests). */
export function configureQueueOperatorGrants(sessionSecret: string, file: string | null = null): void {
  signingSecret = sessionSecret;
  stateFile = file;
  loadState();
}

// Each held grant in the file carries a MAC, so a written-in entry holds nothing.
const heldMac = (paneId: string, held: Held) => createHmac("sha256", createHmac("sha256", signingSecret!).update(`${keyLabel}/held`).digest())
  .update(JSON.stringify([paneId, held.op, held.by, held.until])).digest("base64url");

function loadState(): void {
  if (!stateFile || !signingSecret) return;
  try {
    const saved = JSON.parse(readFileSync(stateFile, "utf8")) as { pending: [string, Held & { mac?: string }][]; lines: [string, PromoteLine][] };
    for (const [paneId, { mac, ...held }] of saved.pending) if (mac === heldMac(paneId, held)) pending.set(paneId, held);
    for (const [paneId, line] of saved.lines) {
      if (typeof line.at === "number" && (line.usedAt === null || typeof line.usedAt === "number")) promoteLines.set(paneId, line);
    }
  } catch { /* no file yet, or unreadable: nothing held */ }
}

function saveState(nowMs: number): void {
  if (!stateFile || !signingSecret) return;
  const held = [...pending].filter(([, entry]) => entry.until >= nowMs).map(([paneId, entry]) => [paneId, { ...entry, mac: heldMac(paneId, entry) }]);
  try {
    writeFileSync(`${stateFile}.${process.pid}.tmp`, `${JSON.stringify({ pending: held, lines: [...promoteLines] })}\n`, { mode: 0o600 });
    renameSync(`${stateFile}.${process.pid}.tmp`, stateFile);
  } catch (error) {
    process.stderr.write(`queue-operator-grants: held grants were not saved (${(error as Error).message}); they last until the API restarts.\n`);
  }
}

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
  const nowMs = options.nowMs ?? Date.now();
  pending.set(paneId, { op, by, until: nowMs + PENDING_MS });
  saveState(nowMs);
  return op;
}

const typedLines = new Map<string, string>();
const PROMOTE_WORD = /\bpromote\b|προ[ωώ]θ/i;
// shortcut: a negation anywhere in the line withholds the grant; the pane's agent still reads what the operator meant.
const NEGATION = /\b(no|not|never|don['’]?t|wait)\b|(?:^|[\s,.!;:?"'«»()])(μη|μην|όχι|οχι|δεν|ποτέ|ποτε|περίμενε|περιμενε)(?=[\s,.!;:?"'«»()]|$)/i;
// Escape sequences (bracketed paste markers, arrows) and command flags are not words of the sentence: the Promote
// shortcut's own text ends "(space-queue promote --wait)", and "--wait" withheld every grant it asked for (2026-10-21).
const TERMINAL_CONTROL = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]|[\x00-\x08\x0b-\x1f\x7f]/g;
const COMMAND_FLAG = /(^|\s)--[a-z][\w-]*/gi;

/** Whether a line asks to promote: null when it does not; else the negation word that withholds the grant, or null. */
export function promoteLineVerdict(raw: string): { negation: string | null } | null {
  const line = raw.replace(TERMINAL_CONTROL, "");
  if (!PROMOTE_WORD.test(line)) return null;
  const negation = NEGATION.exec(line.replace(COMMAND_FLAG, "$1"));
  return { negation: negation ? negation[1] ?? negation[2]! : null };
}

/** Where the operator in person submitted a line: terminal keys, the pane's local draft, or the Nous pane board reply. */
export type OperatorLineSource = "pane-prompt" | "local-composer" | "pane-board";
// The last promote line per pane, so a refusal names why (the line itself is never kept).
type PromoteLine = { at: number; negation: string | null; usedAt: number | null };
const promoteLines = new Map<string, PromoteLine>();

/**
 * A line the operator in person submitted to a pane (the caller checks `isOperatorPerson`): one that asks to promote with
 * no negation holds the promote grant for that pane, so the pane may run `space-queue promote` once within 30 minutes.
 */
export function noteOperatorPromoteLine(paneId: string, line: string, source: OperatorLineSource, nowMs = Date.now()): void {
  const verdict = promoteLineVerdict(line);
  if (!verdict) return;
  promoteLines.delete(paneId);
  promoteLines.set(paneId, { at: nowMs, negation: verdict.negation, usedAt: null });
  if (promoteLines.size > 1000) promoteLines.delete(promoteLines.keys().next().value!);
  if (!verdict.negation) pending.set(paneId, { op: "promote", by: `operator:${source}`, until: nowMs + PENDING_MS });
  saveState(nowMs);
}

/** Keystrokes the operator types into a pane from their own browser (the caller checks `isOperatorPerson`): each submitted line. */
export function noteOperatorPaneInput(paneId: string, data: string, nowMs = Date.now()): void {
  let line = typedLines.get(paneId) ?? "";
  for (const ch of data) {
    if (ch === "\r") {
      noteOperatorPromoteLine(paneId, line, "pane-prompt", nowMs);
      line = "";
    } else if (ch === "\x7f" || ch === "\b") line = line.slice(0, -1);
    else if (ch === "\x03" || ch === "\x15") line = "";
    else line = (line + ch).slice(-2000);
  }
  typedLines.set(paneId, line);
}

/** This pane's held grant for `op`, once. */
export function takePaneQueueGrant(paneId: string, op: string, nowMs = Date.now()): string | null {
  const held = pending.get(paneId);
  if (!held || held.op !== op || held.until < nowMs) return null;
  pending.delete(paneId);
  const line = promoteLines.get(paneId);
  if (held.by.startsWith("operator:") && line) line.usedAt = nowMs;
  saveState(nowMs);
  return signQueueOperatorGrant(op, held.by, nowMs);
}

const utcClock = (ms: number) => new Date(ms).toISOString().slice(11, 16);

/** Why this pane holds no grant for `op`, as exactly as the server knows it. */
export function paneQueueGrantRefusal(paneId: string, op: string, nowMs = Date.now()): string {
  const held = pending.get(paneId);
  if (held && held.until >= nowMs && held.op !== op) return `this pane holds a grant for ${held.op}, not ${op}`;
  if (op !== "promote") return "no approved Nous decision or Settings → Releases action authorized this pane for it";
  const line = promoteLines.get(paneId);
  if (!line) return "no line you typed or sent into this pane from your own browser asked to promote";
  const when = `your line at ${utcClock(line.at)} UTC`;
  if (line.negation) return `${when} had the word "${line.negation}"`;
  if (line.usedAt !== null) return `${when} was already used by the promote at ${utcClock(line.usedAt)} UTC (one promote per line)`;
  if (line.at + PENDING_MS < nowMs) return `${when} is older than 30 minutes`;
  return `${when} asked to promote, but another grant replaced it`;
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
    if (!grant) {
      const reason = paneQueueGrantRefusal(bridge.claims.paneId, op);
      request.log.info({ event: "queue_operator_grant.refused", paneId: bridge.claims.paneId, op, reason }, "No operator grant for the pane.");
      return reply.code(403).send({ error: { code: "NO_OPERATOR_GRANT", message: `No operator grant for this pane: ${reason}.`, reason } });
    }
    return { grant };
  });
}
