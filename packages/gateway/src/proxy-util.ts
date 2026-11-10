import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";

/** Helpers shared by the provider proxies. */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** Insertion-ordered map that forgets its oldest entry past `limit`. */
export class BoundedMap<V> {
  private map = new Map<string, V>();
  constructor(private readonly limit: number) {}
  get(key: string) { return this.map.get(key); }
  set(key: string, value: V) {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value!);
  }
}

/** Reads at most `limit` bytes (64 KB, an error body, by default). */
export async function readBounded(response: Response, limit = MAX_ERROR_BODY_BYTES): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel().catch(() => undefined); break; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function hashKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** NGW_MODE=nous keys sticky bindings by (tenant, session), so two tenants with the same session id never share one; "" otherwise. */
export const stickyScope = (request: Pick<FastifyRequest, "ngwTenantId">) => request.ngwTenantId ? `${request.ngwTenantId}:` : "";

export function header(request: Pick<FastifyRequest, "headers">, name: string): string | null {
  const value = request.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first?.trim() || null;
}

/**
 * The caller's x-request-id as the request log's id, so a Space request and its gateway row share one id; null (the
 * gateway makes its own) unless it is 1-120 visible ASCII characters, the request_id column's limit (OBS-006).
 */
export function clientRequestId(request: Pick<FastifyRequest, "headers">): string | null {
  const value = header(request, "x-request-id");
  return value && /^[\x21-\x7e]{1,120}$/.test(value) ? value : null;
}
