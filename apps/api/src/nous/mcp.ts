import { setTimeout as delay } from "node:timers/promises";
import { createHmac, timingSafeEqual } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { NousAttachments } from "./attachments.js";
import type { NousService } from "./service.js";
import type { NousToolDefinition } from "./tools.js";

/**
 * Nous's tools over HTTP MCP for its headless Claude Code turn. The CLI reaches the API with the turn's token (an HMAC
 * over owner, turn and expiry, never a session), and a token works only while its turn runs. Bridge route: the API
 * skips session authentication for /api/cli/nous/, so this route verifies the token itself.
 */
export const cliNousPathPrefix = "/api/cli/nous/";
export const NOUS_MCP_PATH = "/api/cli/nous/mcp";

interface NousTokenClaims { owner: string; turnId: string; expiresAt: number }
const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64url");
const sign = (secret: string, payload: string) => createHmac("sha256", secret).update(`nous-mcp:${payload}`).digest("base64url");

export function signNousToken(secret: string, claims: NousTokenClaims): string {
  const payload = b64(JSON.stringify({ o: claims.owner, t: claims.turnId, e: claims.expiresAt }));
  return `nous.${payload}.${sign(secret, payload)}`;
}

export function verifyNousToken(secret: string, token: string | undefined, now = Date.now()): NousTokenClaims | null {
  const match = /^nous\.([A-Za-z0-9_-]{10,600})\.([A-Za-z0-9_-]{43})$/.exec(token ?? "");
  if (!match) return null;
  const expected = Buffer.from(sign(secret, match[1]!));
  const given = Buffer.from(match[2]!);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8")) as { o?: unknown; t?: unknown; e?: unknown };
    if (typeof claims.o !== "string" || typeof claims.t !== "string" || typeof claims.e !== "number" || claims.e < now) return null;
    return { owner: claims.o, turnId: claims.t, expiresAt: claims.e };
  } catch {
    return null;
  }
}

const rpcSchema = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]).optional(), method: z.string().max(100), params: z.unknown().optional() });
const callSchema = z.object({ name: z.string().max(100), arguments: z.record(z.string(), z.unknown()).optional(), _meta: z.record(z.string(), z.unknown()).optional() });

export function registerNousMcpRoute(app: FastifyInstance, deps: {
  secret: string; service: Pick<NousService, "turnRunning" | "callTool">; tools: NousToolDefinition[]; routeOptions: Record<string, unknown>;
  /** The operator's attached files: their tools answer with image blocks, which Nous's own tools cannot. */
  attachments?: Pick<NousAttachments, "tools" | "handles" | "callTool">;
}): void {
  // Claude Code may open a server-to-client stream first; this server only answers requests.
  app.get(NOUS_MCP_PATH, deps.routeOptions, async (_request, reply) => reply.code(405).header("allow", "POST").send());
  app.post(NOUS_MCP_PATH, deps.routeOptions, async (request, reply) => {
    const bearer = /^Bearer (.+)$/.exec(String(request.headers.authorization ?? ""))?.[1];
    const claims = verifyNousToken(deps.secret, bearer);
    if (!claims) return reply.code(401).send({ error: "A Nous turn token is required." });
    if (!deps.service.turnRunning(claims.owner, claims.turnId)) return reply.code(403).send({ error: "This Nous turn is over." });
    const parsed = rpcSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request." } });
    const { id, method, params } = parsed.data;
    if (method.startsWith("notifications/")) return reply.code(202).send();
    const answer = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    if (method === "initialize") {
      return answer({ protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "space-nous", version: "1.0.0" } });
    }
    if (method === "ping") return answer({});
    if (method === "tools/list") return answer({ tools: [...deps.tools, ...(deps.attachments?.tools ?? [])] });
    if (method === "tools/call") {
      const call = callSchema.safeParse(params);
      if (!call.success) return { jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid tool call." } };
      if (deps.attachments?.handles(call.data.name)) {
        const result = await deps.attachments.callTool(claims.owner, call.data.name, call.data.arguments ?? {});
        return answer({ content: [{ type: "text", text: result.text }, ...result.images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }))], isError: !result.ok });
      }
      const callId = typeof call.data._meta?.["claudecode/toolUseId"] === "string" ? String(call.data._meta["claudecode/toolUseId"]).slice(0, 80) : `${Date.now()}`;
      const outcome = await deps.service.callTool(claims.owner, claims.turnId, call.data.name, call.data.arguments ?? {}, callId);
      return answer({ content: [{ type: "text", text: outcome.result || outcome.display }], isError: !outcome.ok });
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
  });
}

/** POSTs one request to the worker's Unix socket (where CLI processes run) and returns its JSON; aborting closes it. */
/**
 * A deploy restarts the worker (stable 2026-10-17: a turn failed with ENOENT on its socket): a call that could not connect
 * waits for it, at most `tries` times. Nothing reached the worker, so nothing runs twice.
 */
export async function postToWorkerWhenUp<T>(socketPath: string, path: string, body: unknown, signal: AbortSignal, waitMs = 10_000, tries = 6): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await postToWorker<T>(socketPath, path, body, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= tries || signal.aborted || (code !== "ENOENT" && code !== "ECONNREFUSED")) throw error;
      await delay(waitMs, undefined, { signal });
    }
  }
}

export function postToWorker<T>(socketPath: string, path: string, body: unknown, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(new Error("The turn was stopped.")); return; }
    const data = JSON.stringify(body);
    const onAbort = () => { call.destroy(new Error("The turn was stopped.")); };
    const call = httpRequest({ socketPath, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { text += chunk; });
      response.on("end", () => {
        signal.removeEventListener("abort", onAbort);
        let payload: Record<string, unknown> = {};
        try { payload = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
        if (response.statusCode === 200) resolve(payload as T);
        else reject(new Error(typeof payload.error === "string" ? payload.error : `The worker answered HTTP ${response.statusCode ?? 0}.`));
      });
    });
    signal.addEventListener("abort", onAbort, { once: true });
    call.on("error", (error) => { signal.removeEventListener("abort", onAbort); reject(error); });
    call.end(data);
  });
}
