import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { z } from "zod";
import { vaultCanonicalJson } from "./vault.js";
import { vaultBase64url } from "./vault-crypto.js";

// The mobile channel's wire contracts (plan clipboard:kTV3y2lwO-99 phase 1b, ADR-013, design §2, §3.3, §6.2, §7): the pairing QR, the
// frames inside Noise, the per-scope route allowlist and the signing inputs a phone's decide key signs. Pure; the API and the app share it.

const b64u = (length: number) => z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((length * 4) / 3)}}$`));
const utf8 = (text: string) => new TextEncoder().encode(text);
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const mobileScopeSchema = z.enum(["read", "act", "decide", "admin"]);
export type MobileScope = z.infer<typeof mobileScopeSchema>;

// ---- The pairing QR (design §2.1): plain text the app scans with its own camera, never a deep link. ----

export const MOBILE_PAIR_PREFIX = "SPACEAPP-PAIR:1:";
const PRIVATE_HOST = /^(?:localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|\[(?:::1|f[cd][0-9a-f]{0,2}:[0-9a-f:]*)\])$/i;
/** `https:` anywhere; `http:` only on private and loopback addresses (lab installs). An origin only: no path, query or credentials. */
export const mobileOriginSchema = z.string().max(200).refine((value) => {
  try {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && PRIVATE_HOST.test(url.hostname));
  } catch { return false; }
}, "An https origin, or http on a private address");

export const mobilePairQrSchema = z.object({
  v: z.literal(1),
  o: b64u(8),
  u: z.array(mobileOriginSchema).max(4),
  r: b64u(32).nullable(),
  k: b64u(32),
  i: b64u(32),
  c: b64u(16),
  n: z.string().trim().min(1).max(40),
  x: z.number().int().positive()
}).strict().refine((qr) => qr.u.length > 0 || qr.r !== null, "A direct origin or a relay rendezvous id");
export type MobilePairQr = z.infer<typeof mobilePairQrSchema>;

export function encodeMobilePairQr(qr: MobilePairQr): string {
  return MOBILE_PAIR_PREFIX + vaultBase64url.encode(utf8(JSON.stringify(mobilePairQrSchema.parse(qr))));
}

/** The app's reading of a scanned QR; `now` in epoch seconds. Throws on anything but a valid, unexpired offer. */
export function decodeMobilePairQr(text: string, now: number): MobilePairQr {
  if (!text.startsWith(MOBILE_PAIR_PREFIX)) throw new Error("Not a SpaceApp pairing code.");
  const qr = mobilePairQrSchema.parse(JSON.parse(new TextDecoder().decode(vaultBase64url.decode(text.slice(MOBILE_PAIR_PREFIX.length)))));
  if (qr.x <= now) throw new Error("This pairing code has expired; show a new one.");
  return qr;
}

// ---- Handshake payloads (design §2.2, §3.1). ----

/** The handshake's prologue binds the mode, the offer and the relay rendezvous id, so a relay cannot move a handshake (design §2.2, §3.1). */
export function mobileHandshakePrologue(mode: "pair" | "ik", offerId: Uint8Array | null, rid: Uint8Array | null): Uint8Array {
  if ((mode === "pair") !== (offerId?.length === 8) || (rid && rid.length !== 32)) throw new Error("A pairing prologue takes an 8-byte offer id, a rid is 32 bytes.");
  const out = new Uint8Array(17 + 1 + (mode === "pair" ? 8 : 0) + 32);
  out.set(utf8("spaceapp-mobile/1"));
  out[17] = mode === "pair" ? 1 : 2;
  if (offerId) out.set(offerId, 18);
  if (rid) out.set(rid, mode === "pair" ? 26 : 18);
  return out;
}

/** Space Link (ADR-014): a SpaceApp whose Nous manages this one pairs as a device of this app, and reaches only LINK_ROUTE_SCOPES. */
export const LINK_APP = "spaceapp-link";
const deviceNameSchema = z.string().trim().min(1).max(80);
/** A Play Integrity token as the app gets it: a compact JWE (five base64url parts). */
const integrityTokenSchema = z.string().regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*){4}$/).max(12_000);
export const mobilePairRequestSchema = z.object({
  deviceName: deviceNameSchema,
  app: z.enum(["nous", "spaceapp", "spaceapp-link"]),
  appVersion: z.string().min(1).max(40),
  platform: z.enum(["android", "ios", "server"]),
  decidePubSpki: z.string().regex(/^[A-Za-z0-9_-]{80,200}$/).optional(),
  /** The decide key's Android Key Attestation chain, leaf first, DER as base64url (review P2-6). */
  decideAttestation: z.array(z.string().regex(/^[A-Za-z0-9_-]{100,8000}$/)).min(2).max(8).optional(),
  /** A Play Integrity token whose requestHash is mobileIntegrityRequestHash("pair", the handshake hash) (MASVS L2 RESILIENCE-1/2/4). */
  integrityToken: integrityTokenSchema.optional(),
  wantScopes: z.array(mobileScopeSchema.exclude(["admin"])).min(1).max(3)
}).strict().refine((request) => request.app !== LINK_APP || !request.wantScopes.includes("decide"), "A SpaceApp link never asks for decide.");
export const mobilePairedSchema = z.object({
  deviceId: z.string().min(1).max(80),
  scopes: z.array(mobileScopeSchema),
  /** Held until the owner allows the device in the web (review P1-5). */
  pending: z.array(mobileScopeSchema).optional(),
  rid: b64u(32).nullable(),
  expiresAt: z.string().datetime(),
  instanceLabel: z.string().max(40)
}).strict();
export const mobileHelloSchema = z.object({
  deviceId: z.string().min(1).max(80),
  appVersion: z.string().min(1).max(40),
  ts: z.number().int().positive(),
  nonce: b64u(16)
}).strict();
export const mobileWelcomeSchema = z.object({
  sessionId: z.string().min(1).max(80),
  scopes: z.array(mobileScopeSchema),
  serverTime: z.number().int().positive(),
  rotation: z.string().max(2000).optional(),
  limits: z.object({ maxFrame: z.literal(65_535), maxInFlight: z.number().int().positive() }).strict()
}).strict();

// ---- Frames (design §3.3): one WebSocket message carries one Noise transport message. ----

/** A Noise transport message is at most 65,535 bytes, 16 of them the tag. */
export const MOBILE_FRAME_MAX_PLAINTEXT = 65_519;
export const MOBILE_FRAME_TYPES = { req: 1, res: 2, chunk: 3, evt: 4, ctl: 5 } as const;
export type MobileFrameType = keyof typeof MOBILE_FRAME_TYPES;
const methodSchema = z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]);
const frameHeaderSchemas = {
  req: z.object({ id: z.number().int().nonnegative().max(0xffff_ffff), m: methodSchema, p: z.string().min(5).max(2048),
    // x-space-client: where the operator writes from (nous-client.ts); it only describes, the device session's app claim decides.
    h: z.object({ "content-type": z.string().max(200).optional(), accept: z.string().max(200).optional(), range: z.string().max(100).optional(),
      "x-space-client": z.string().max(300).optional(),
      // A linked SpaceApp's id for one act, audited under the same trace on both sides (Space Link Λ4); lnk: never names this side's own req: ids.
      "x-space-link-request": z.string().regex(/^lnk:[A-Za-z0-9_-]{16,64}$/).optional() }).strict().optional(),
    more: z.literal(true).optional(), sig: z.string().regex(/^[A-Za-z0-9_-]{64,200}$/).optional(),
    // A signed answer's Play Integrity token, requestHash mobileIntegrityRequestHash("decide", its signing input).
    int: integrityTokenSchema.optional() }).strict(),
  res: z.object({ id: z.number().int().nonnegative(), s: z.number().int().min(100).max(599),
    h: z.object({ "content-type": z.string().max(200).optional(), "content-length": z.string().max(20).optional(), "content-range": z.string().max(100).optional() }).strict().optional(),
    more: z.literal(true).optional() }).strict(),
  chunk: z.object({ id: z.number().int().nonnegative(), seq: z.number().int().positive(), more: z.boolean() }).strict(),
  evt: z.object({ type: z.string().min(1).max(80), ids: z.record(z.string(), z.unknown()).optional() }).strict(),
  ctl: z.object({ op: z.enum(["ping", "pong", "rekey", "sub", "unsub", "cancel", "push-handle", "busy", "scopes", "paired", "bye"]) }).loose()
};
export type MobileFrame = { type: MobileFrameType; header: Record<string, unknown>; body: Uint8Array };

export function encodeMobileFrame(frame: MobileFrame): Uint8Array {
  const header = utf8(JSON.stringify(frameHeaderSchemas[frame.type].parse(frame.header)));
  const out = new Uint8Array(5 + header.length + frame.body.length);
  if (out.length > MOBILE_FRAME_MAX_PLAINTEXT) throw new Error("Frame too large; send the body in chunks.");
  out[0] = MOBILE_FRAME_TYPES[frame.type];
  new DataView(out.buffer).setUint32(1, header.length, false);
  out.set(header, 5);
  out.set(frame.body, 5 + header.length);
  return out;
}

export function decodeMobileFrame(plaintext: Uint8Array): MobileFrame {
  if (plaintext.length < 5 || plaintext.length > MOBILE_FRAME_MAX_PLAINTEXT) throw new Error("Bad frame.");
  const type = (Object.keys(MOBILE_FRAME_TYPES) as MobileFrameType[]).find((name) => MOBILE_FRAME_TYPES[name] === plaintext[0]);
  const headerLength = new DataView(plaintext.buffer, plaintext.byteOffset).getUint32(1, false);
  if (!type || 5 + headerLength > plaintext.length) throw new Error("Bad frame.");
  const header = frameHeaderSchemas[type].parse(JSON.parse(new TextDecoder().decode(plaintext.subarray(5, 5 + headerLength)))) as Record<string, unknown>;
  return { type, header, body: plaintext.slice(5 + headerLength) };
}

/** A `req` or `res` and its body as frames: the first with `more: true` when the body continues in `chunk` frames of the same id. */
export function mobileFrames(type: "req" | "res", header: Record<string, unknown> & { id: number }, body: Uint8Array): MobileFrame[] {
  const room = (head: Record<string, unknown>) => MOBILE_FRAME_MAX_PLAINTEXT - 5 - utf8(JSON.stringify(head)).length;
  const firstRoom = room({ ...header, more: true });
  if (body.length <= room(header)) return [{ type, header, body }];
  const frames: MobileFrame[] = [{ type, header: { ...header, more: true }, body: body.slice(0, firstRoom) }];
  for (let at = firstRoom, seq = 1; at < body.length; seq++) {
    const size = room({ id: header.id, seq, more: false });
    frames.push({ type: "chunk", header: { id: header.id, seq, more: at + size < body.length }, body: body.slice(at, at + size) });
    at += size;
  }
  return frames;
}

// ---- What a phone may reach (design §6.2): the router's matched pattern, exactly. A route not listed is refused. ----

export type MobileBodyRule = "settingsEnabledAndTabs" | "awayNoGrant" | "noAlways" | "linkInspect" | "linkExecute";
export type MobileRouteRule = {
  scope: Exclude<MobileScope, "admin">;
  /** The route's own person check passes for a phone (review P0-1); everywhere else a phone is not the operator in person. */
  person?: true;
  /** Exact query values the request must carry (checked on the parsed query, review P2-3). */
  query?: Record<string, string>;
  body?: MobileBodyRule;
  /** The channel loads the artifact: Agent Files, or one a Nous message, decision or share names (review P1-4). */
  artifactById?: true;
  /** A needs-you answer: a risky ask needs `decide` and the ask signature (review P1-2). */
  askRisk?: true;
  /** A decision answer: RELEASE, DESTRUCTIVE and EXTERNAL need the decide signature (design §7). */
  decisionSignature?: true;
  /** A goal's delete: the decide signature over the goal's text (C9, internal MASVS review), a class-A delete. */
  goalSignature?: true;
  /** An ADMIN operation (Nous settings' ops, nous_msg:7f3a38f5): an ADMIN user and the decide signature over mobileAdminOpSigningInput. */
  adminSignature?: true;
};
const read: MobileRouteRule = { scope: "read" };
const act: MobileRouteRule = { scope: "act" };
const actPerson: MobileRouteRule = { scope: "act", person: true };
const artifact: MobileRouteRule = { scope: "read", artifactById: true };
export const MOBILE_ROUTE_SCOPES: Readonly<Record<string, MobileRouteRule>> = {
  "GET /api/auth/me": read,
  "GET /api/nous": read, "GET /api/nous/messages": read, "GET /api/nous/messages/operator-index": read, "GET /api/nous/attachments/:id": read,
  "GET /api/nous/decisions": read, "GET /api/nous/decisions/:id/files": read, "GET /api/nous/overview": read, "GET /api/nous/progress": read,
  "GET /api/nous/goals": read, "GET /api/nous/goals/:id/history": read, "GET /api/nous/pane-board": read, "GET /api/nous/requests": read, "GET /api/nous/shared-files": read,
  // The Startup programs page (plan clipboard:17yLAnH5ZpyF): the Nous app reads it as the dock does.
  "GET /api/nous/programs": read,
  // The Score view (plan clipboard:1NF6u6gcCwtj): the Nous app shows it as the dock does.
  "GET /api/nous/score": read, "GET /api/nous/score/history": read,
  // Token usage by process and provider, and the saved signatures and signature requests (operator 6/11, nous_msg:781819c5): the Nous app's views.
  "GET /api/nous/token-usage": read,
  "GET /api/signatures": read, "GET /api/signatures/:id/image": read, "GET /api/signature-requests": read,
  "POST /api/signatures": actPerson, "PATCH /api/signatures/:id": actPerson, "DELETE /api/signatures/:id": actPerson,
  "POST /api/signature-requests/:id/sign": actPerson, "POST /api/signature-requests/:id/cancel": act,
  "GET /api/tasks/runs": read,
  // Space Link's Remote mark in the Nous app (ADR-014 Λ9): read who manages this SpaceApp, and take management back (it only narrows).
  "GET /api/instance-links/status": read, "POST /api/instance-links/status/take-back": actPerson,
  "GET /api/notifications": read, "GET /api/notifications/pending": read, "GET /api/notifications/:id": read,
  "GET /api/clipboard-items": { scope: "read", query: { source: "PLAN" } },
  "GET /api/artifacts": { scope: "read", query: { collection: "AGENT_FILES" } },
  "GET /api/artifacts/:id/preview": artifact, "GET /api/artifacts/:id/file": artifact, "GET /api/artifacts/:id/metadata": artifact,
  // Agent Files upload from the Nous app (operator 13/11 nous_msg:0093b06f): pick the room, then send the file in pieces under the channel's body limit.
  "GET /api/rooms": read, "POST /api/rooms/:id/agent-files/chunks": act,
  "GET /api/admin/codex-usage-accounts": read, "GET /api/admin/claude-usage-accounts": read, "GET /api/admin/antigravity-usage-accounts": read,
  "GET /api/admin/api-provider-accounts": read, "GET /api/admin/deploy-queue/tickets/:id": read,
  "POST /api/nous/messages": actPerson, "DELETE /api/nous/messages": act, "POST /api/nous/stop": act, "POST /api/nous/attachments": act,
  "DELETE /api/nous/attachments/:id": act,
  "POST /api/notifications/:id/answer": { scope: "act", person: true, body: "noAlways", askRisk: true },
  "POST /api/notifications/:id/read": act, "POST /api/notifications/:id/ack": act, "POST /api/notifications/read-all": act,
  "POST /api/nous/pane-board/:paneId/answer": { scope: "act", person: true, body: "noAlways" }, "POST /api/nous/pane-board/refresh": act,
  "POST /api/nous/decisions/:id/feedback": act,
  // Teleport (operator 13/11 nous_msg:6d87d2a6): Go now finds the card's page, and the phone drives that pane browser by touch as the operator.
  "POST /api/notifications/:id/place": act, "GET /api/panes/:id/browser/pages": read,
  "POST /api/panes/:id/browser/teleport": actPerson, "GET /api/panes/:id/browser/teleport/frame": read,
  "POST /api/panes/:id/browser/teleport/input": actPerson, "POST /api/panes/:id/browser/teleport/upload": actPerson,
  "POST /api/panes/:id/browser/control/acquire": actPerson, "POST /api/panes/:id/browser/control/heartbeat": actPerson,
  "POST /api/panes/:id/browser/control/release": actPerson,
  "POST /api/nous/goals": actPerson, "PATCH /api/nous/goals/:id": actPerson, "POST /api/nous/goals/reorder": actPerson,
  "DELETE /api/nous/shared-files/:shareId": act,
  "PATCH /api/nous/settings": { scope: "act", person: true, body: "settingsEnabledAndTabs" },
  "POST /api/nous/away": { scope: "act", person: true, body: "awayNoGrant" },
  "POST /api/nous/decisions/:id/answer": { scope: "decide", person: true, body: "noAlways", decisionSignature: true },
  "DELETE /api/nous/goals/:id": { scope: "decide", person: true, goalSignature: true },
  // Nous Settings Operations (operator nous_msg:5249d11d, 7f3a38f5): ADMIN, audited, guarded host operations. From the Nous app each POST
  // needs decide and the signature over the exact call (adminSignature), promote too: the same bar as a signed RELEASE decision (P0-1).
  "GET /api/admin/server-ops": read, "POST /api/admin/server-ops/clean-disk": { scope: "decide", adminSignature: true },
  "POST /api/admin/server-ops/deploy-remotes": { scope: "decide", adminSignature: true },
  "POST /api/admin/server-ops/clean-worktrees": { scope: "decide", adminSignature: true },
  "POST /api/admin/server-ops/restart": { scope: "decide", adminSignature: true },
  "POST /api/admin/releases/promote": { scope: "decide", person: true, adminSignature: true }
};

// ---- What a SpaceApp link may reach (ADR-014): another SpaceApp's Nous reads this one and runs Space Control here, nothing more. No
// Vault, auth, settings, admin, mobile, Nous messages or releases; this instance's own gates stay its own. Screens (CONTENT,
// TERMINAL_RENDER, screenshots) stay off. ----

/** Inspect sections a link reads: state and capacity, never screen text, the clipboard, files, audit, settings or the VPN. */
export const LINK_INSPECT_SECTIONS: readonly string[] = ["STATE", "MODELS", "QUOTA", "RUNTIMES", "ROOMS", "SYSTEM_HEALTH", "TASKS", "SKILLS", "PLUGINS", "MODULES"];
/** Space Control actions a link runs: rooms, panes, their models, layout, and these resource operations. */
export const LINK_EXECUTE_KINDS: readonly string[] = ["room", "pane", "configure", "layout", "resource"];
export const LINK_RESOURCE_OPERATIONS: readonly string[] = ["panes.open", "panes.move", "panes.split", "panes.update", "rooms.reorder", "links.list",
  "skills.list", "skills.read", "tasks.list", "tasks.get", "tasks.create", "tasks.update", "models.list", "ops.status"];
export const LINK_ROUTE_SCOPES: Readonly<Record<string, MobileRouteRule>> = {
  "GET /api/auth/me": read, "GET /api/rooms": read,
  "GET /api/control/v1/capabilities": read, "GET /api/control/v1/layout/:roomId": read, "GET /api/control/v1/pane-types": read,
  "POST /api/control/v1/inspect": { scope: "read", body: "linkInspect" },
  "GET /api/nous/overview": read, "GET /api/nous/load": read, "GET /api/nous/score": read, "GET /api/nous/pane-board": read, "GET /api/nous/progress": read,
  "POST /api/control/v1/commands": { scope: "act", body: "linkExecute" }, "POST /api/control/v1/operations": act
};

/**
 * The phone's reach on one request: the matched route pattern and the parsed query. Null means 403 MOBILE_SCOPE_DENIED. A query
 * value repeated or given as an array never matches (review P2-3).
 */
export function mobileRouteAllows(scopes: readonly string[], method: string, routePattern: string | undefined, query: Record<string, unknown> = {}, app?: string): MobileRouteRule | null {
  if (!routePattern) return null;
  const table = app === LINK_APP ? LINK_ROUTE_SCOPES : MOBILE_ROUTE_SCOPES;
  const rule = Object.hasOwn(table, `${method.toUpperCase()} ${routePattern}`) ? table[`${method.toUpperCase()} ${routePattern}`]! : null;
  if (!rule || !scopes.includes(rule.scope)) return null;
  return Object.entries(rule.query ?? {}).every(([key, value]) => query[key] === value) ? rule : null;
}

/** The body rule's problem, or null. The channel checks the object it re-serializes and injects, never the client's bytes. */
export function mobileBodyProblem(rule: MobileBodyRule, body: unknown): string | null {
  const object = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  if (!object) return "A JSON object is required.";
  // dockTabs only shows or hides the dock's tabs (operator nous_msg:5b21060a: the Nous app's Settings › Tabs); the route's schema checks its values.
  if (rule === "settingsEnabledAndTabs") return Object.keys(object).every((key) => key === "enabled" || key === "dockTabs") ? null : "From a phone, Nous's settings take only enabled and dockTabs.";
  if (rule === "awayNoGrant") return "grant" in object ? "A grant widens what Nous may do; set it on a computer." : null;
  if (rule === "linkInspect") return object.section === undefined || LINK_INSPECT_SECTIONS.includes(object.section as string) ? null : `A SpaceApp link reads only ${LINK_INSPECT_SECTIONS.join(", ")}.`;
  if (rule === "linkExecute") {
    const actions = Array.isArray(object.actions) ? object.actions as Array<Record<string, unknown> | null> : null;
    if (!actions) return "actions is required.";
    // This SpaceApp's own operator approves its destructive actions: a remote Nous never claims that approval.
    const approval = (action: Record<string, unknown>) => "confirm" in action || "approvalReason" in action || (typeof action.input === "object" && action.input !== null && ("confirm" in action.input || "confirmed" in action.input));
    if ("userExplicitlyAuthorized" in object || actions.some((action) => action && typeof action === "object" && approval(action))) return "A SpaceApp link cannot approve for this SpaceApp's operator; they approve here.";
    // A missing kind is a pane action (sanitizeControlExecute) or refused by the schema.
    const refused = actions.find((action) => !action || typeof action !== "object" || (action.kind !== undefined && !LINK_EXECUTE_KINDS.includes(action.kind as string))
      || (action.kind === "resource" && !LINK_RESOURCE_OPERATIONS.includes(action.operation as string)) || "captureScreenshot" in action || action.operation === "visual_audit" || action.action === "visual_audit");
    return refused === undefined ? null : "A SpaceApp link runs rooms, panes, their models, layout and tasks only, without screenshots; the rest is set on this SpaceApp.";
  }
  return "always" in object ? "Always answers are set on a computer." : null;
}

// ---- What the phone's decide key signs (design §7), and the instance's rotation statement (design §1). ----

const sha256Hex = (text: string) => hex(sha256(utf8(text)));

/** SHA-256 of a decision's canonical content, written by the server when it is created or edited. */
export function mobileDecisionContentHash(decision: { id: string; category: string; title: string; body: string; recommendation?: string | null; action?: unknown; refs?: { fileHashes?: unknown } | null }): string {
  return sha256Hex(vaultCanonicalJson({ id: decision.id, category: decision.category, title: decision.title, body: decision.body,
    recommendation: decision.recommendation ?? null, action: decision.action ?? null, fileHashes: decision.refs?.fileHashes ?? null }));
}

/** SHA-256 of a needs-you ask's canonical content (review P1-2). */
export function mobileAskContentHash(ask: { id: string; question: string; options?: readonly string[]; recommended?: string | null; body?: string | null }): string {
  return sha256Hex(vaultCanonicalJson({ id: ask.id, question: ask.question, options: ask.options ?? [], recommended: ask.recommended ?? null, body: ask.body ?? null }));
}

/** SHA-256 of a goal's canonical content: the phone signs it, with the answer "delete", to delete the goal (C9). */
export function mobileGoalContentHash(goal: { id: string; text: string }): string {
  return sha256Hex(vaultCanonicalJson({ id: goal.id, text: goal.text }));
}

/** The bytes a phone signs to answer a decision ("decide"), a risky needs-you ask ("ask") or to delete a goal ("goal-delete", answer "delete"). */
export function mobileAnswerSigningInput(kind: "decide" | "ask" | "goal-delete", id: string, contentHash: string, answer: unknown): Uint8Array {
  return utf8(`spaceapp-${kind}-v1\n${id}\n${contentHash}\n${sha256Hex(vaultCanonicalJson(answer))}`);
}

/**
 * The bytes a phone signs to run an ADMIN operation (promote, deploy, clean, restart from the Nous app's Settings): the method, the path it
 * sends (no query) and its exact body, null for none. shortcut: no server nonce, so the channel could run the same op and body again
 * with one signature; bind it to a per-run token if an op ever needs that.
 */
export function mobileAdminOpSigningInput(method: string, path: string, body: unknown): Uint8Array {
  return utf8(`spaceapp-admin-op-v1\n${method.toUpperCase()} ${path}\n${sha256Hex(vaultCanonicalJson(body ?? null))}`);
}

export const mobileRotationStatementSchema = z.object({
  v: z.literal(1), oldFp: z.string().regex(/^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){5}$/), newIS: b64u(32), newII: b64u(32), at: z.string().datetime()
}).strict();
export type MobileRotationStatement = z.infer<typeof mobileRotationStatementSchema>;
const rotationBytes = (statement: MobileRotationStatement) => utf8(`spaceapp-rotate-v1\n${vaultCanonicalJson(mobileRotationStatementSchema.parse(statement))}`);

/** The old identity key's signature over a routine rotation; the app checks it with the identity key it pinned. */
export function signMobileRotation(statement: MobileRotationStatement, oldIdentityPrivate: Uint8Array): string {
  return vaultBase64url.encode(ed25519.sign(rotationBytes(statement), oldIdentityPrivate));
}

// ---- The SpaceApp relay (design §5, oll4-cloud's relay): the instance's identity key signs its listen and each accept. ----

const concat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0)); let at = 0; for (const part of parts) { out.set(part, at); at += part.length; } return out; };
/** Ed25519(II, "spaceapp-relay-listen-v1" ‖ nonce ‖ each rid's 32 bytes, in the order of their sorted base64url text). */
export function mobileRelayListenSig(identityPrivate: Uint8Array, nonce: Uint8Array, rids: string[]): string {
  return vaultBase64url.encode(ed25519.sign(concat(utf8("spaceapp-relay-listen-v1"), nonce, ...[...rids].sort().map((rid) => vaultBase64url.decode(rid))), identityPrivate));
}
/** Ed25519(II, "spaceapp-relay-accept-v1" ‖ the session id's text). */
export function mobileRelayAcceptSig(identityPrivate: Uint8Array, sid: string): string {
  return vaultBase64url.encode(ed25519.sign(concat(utf8("spaceapp-relay-accept-v1"), utf8(sid)), identityPrivate));
}

export function verifyMobileRotation(statement: MobileRotationStatement, signature: string, pinnedIdentityPublic: Uint8Array): boolean {
  try { return ed25519.verify(vaultBase64url.decode(signature), rotationBytes(statement), pinnedIdentityPublic); }
  catch { return false; }
}

// ---- MASVS L2 core gaps (plan clipboard:kTV3y2lwO-99 step 7, audit ~/agent-workspace/active/20261031-nous-pro/masvs-l2.md). ----

/**
 * CODE-2: the oldest Nous app SpaceApp serves; an older one gets 426 APP_UPDATE_REQUIRED on the API and close code 4426 on the channel.
 * 0.2.22 is the first Nous app that shows the update screen (plan step 18, before the first Play build 1.0.0 / 10000).
 * shortcut: a fixed floor, raise it in a reviewed commit with each security release.
 */
export const NOUS_APP_MIN_VERSION = "0.2.22";
export const MOBILE_UPDATE_REQUIRED_CLOSE = 4426;
/** The Nous app's versionCode for "X.Y.Z": MAJOR * 10000 + MINOR * 100 + PATCH (its scripts/bump-version.mjs); null for anything else. */
export function mobileAppVersionCode(version: string): number | null {
  const match = /^(\d{1,4})\.(\d{1,2})\.(\d{1,2})$/.exec(version.trim());
  return match ? Number(match[1]) * 10_000 + Number(match[2]) * 100 + Number(match[3]) : null;
}
export type MobileUpdateRequired = { code: "APP_UPDATE_REQUIRED"; minVersion: string; minVersionCode: number };
/** What a Nous app of `version` must update to, or null. A version that is no X.Y.Z reads as below the floor; other apps have none. */
export function mobileAppUpdateRequired(app: string | null | undefined, version: string): MobileUpdateRequired | null {
  if (app !== "nous") return null;
  const minVersionCode = mobileAppVersionCode(NOUS_APP_MIN_VERSION)!, code = mobileAppVersionCode(version);
  return code !== null && code >= minVersionCode ? null : { code: "APP_UPDATE_REQUIRED", minVersion: NOUS_APP_MIN_VERSION, minVersionCode };
}

/**
 * RESILIENCE-1/2/4: the requestHash a Play Integrity standard request carries, binding the verdict to one pairing (the Noise handshake
 * hash, which also binds the key attestation) or one signed answer (its mobileAnswerSigningInput bytes). Base64url SHA-256, 43 characters.
 */
export function mobileIntegrityRequestHash(purpose: "pair" | "decide", data: Uint8Array): string {
  const label = utf8(`spaceapp-integrity-v1\n${purpose}\n`), bytes = new Uint8Array(label.length + data.length);
  bytes.set(label); bytes.set(data, label.length);
  return vaultBase64url.encode(sha256(bytes));
}
