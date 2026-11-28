import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { PgClientLike } from "@space/db";
import type { CellModelUpstream } from "./cell-driver.js";

// K5 "connect AI" (plan clipboard:ZGz1LnD51ELH step 7, Nous decision 27387eef (2)): the tenant's own Anthropic key, checked with a real
// call before it is kept, sealed on its tenants row (migration 0422), and put on its cell turns' model calls by the cells host's relay
// (cell-relay.ts), never inside the cell.
// shortcut: the seal key is one hub file (SPACE_CELLS_AI_KEY_SEAL_FILE) standing in for a KMS; wrap per-tenant data keys with a KMS before P2.

export const ANTHROPIC_API_URL = "https://api.anthropic.com";
const KEY_SHAPE = /^sk-ant-[A-Za-z0-9_-]{20,400}$/;
/** The key check's wait for Anthropic; a slower answer is reported as unreachable and the user tries again. */
const KEY_CHECK_MS = 15_000;

export class AiKeyError extends Error {
  constructor(readonly code: "AI_KEY_SHAPE" | "AI_KEY_REFUSED" | "AI_KEY_CHECK_FAILED", message: string) { super(message); }
}

/** AES-256-GCM under a purpose-bound key; the tenant id is the AAD, so a sealed key copied to another tenant's row does not open. */
export function createAiKeySeal(master: string) {
  if (master.length < 32) throw new Error("The AI key seal needs at least 32 characters of secret.");
  const key = Buffer.from(hkdfSync("sha256", master, "", "nous-computer:ai-key:v1", 32));
  return {
    seal(tenantId: string, apiKey: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(Buffer.from(tenantId));
      const body = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
      return ["v1", iv, body, cipher.getAuthTag()].map((part) => (typeof part === "string" ? part : part.toString("base64url"))).join(".");
    },
    open(tenantId: string, sealed: string): string {
      const [version, iv, body, tag] = sealed.split(".");
      if (version !== "v1" || !iv || !body || !tag) throw new Error("Unknown AI key seal.");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"), { authTagLength: 16 }).setAAD(Buffer.from(tenantId));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
    }
  };
}

export type TenantAiKeys = ReturnType<typeof createTenantAiKeys>;

export function createTenantAiKeys(options: { pool: PgClientLike; seal: ReturnType<typeof createAiKeySeal>; fetch?: typeof fetch }) {
  const { pool, seal } = options;
  const fetcher = options.fetch ?? fetch;
  return {
    async status(tenantId: string) {
      const { rows } = await pool.query<{ ai_key_hint: string | null; ai_key_checked_at: Date | null }>(
        "SELECT ai_key_hint, ai_key_checked_at FROM tenants WHERE id = $1", [tenantId]);
      const row = rows[0];
      return { provider: "anthropic" as const, connected: Boolean(row?.ai_key_hint), hint: row?.ai_key_hint ?? null, checkedAt: row?.ai_key_checked_at?.toISOString() ?? null };
    },
    /** Keeps the key only after Anthropic accepts it (a models list costs no tokens). */
    async connect(tenantId: string, apiKey: string) {
      const key = apiKey.trim();
      if (!KEY_SHAPE.test(key)) throw new AiKeyError("AI_KEY_SHAPE", "This is not an Anthropic API key (it starts with sk-ant-).");
      const answer = await fetcher(`${ANTHROPIC_API_URL}/v1/models?limit=1`, {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(KEY_CHECK_MS)
      }).catch(() => null);
      if (answer?.status === 401 || answer?.status === 403) throw new AiKeyError("AI_KEY_REFUSED", "Anthropic refused this key.");
      if (!answer?.ok) throw new AiKeyError("AI_KEY_CHECK_FAILED", "Anthropic could not be reached to check the key; try again.");
      await pool.query("UPDATE tenants SET ai_key_sealed = $2, ai_key_hint = $3, ai_key_checked_at = now() WHERE id = $1",
        [tenantId, seal.seal(tenantId, key), key.slice(-4)]);
    },
    async disconnect(tenantId: string) {
      await pool.query("UPDATE tenants SET ai_key_sealed = NULL, ai_key_hint = NULL, ai_key_checked_at = NULL WHERE id = $1", [tenantId]);
    },
    /** The cell turns' upstream with the tenant's own key; null when it has none. */
    async upstream(tenantId: string): Promise<CellModelUpstream | null> {
      const { rows } = await pool.query<{ ai_key_sealed: string | null }>("SELECT ai_key_sealed FROM tenants WHERE id = $1", [tenantId]);
      const sealed = rows[0]?.ai_key_sealed;
      return sealed ? { baseUrl: ANTHROPIC_API_URL, apiKey: seal.open(tenantId, sealed) } : null;
    }
  };
}
