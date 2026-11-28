import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { InMemorySpaceStore } from "@space/runtime";
import type { PgClientLike } from "@space/db";
import { createApp } from "../src/app.js";
import { createCsrfToken, csrfHeaderName, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import type { AccountLifecycle } from "../src/computer/accounts.js";
import { ANTHROPIC_API_URL, createAiKeySeal, createTenantAiKeys } from "../src/computer/ai-key.js";
import { cellsGatewayUpstream } from "../src/computer/cell-turn.js";

// K5 connect AI (plan clipboard:ZGz1LnD51ELH step 7, Nous decision 27387eef (2)): the tenant's own key, checked, sealed, routed.
const sessionSecret = "ai-key-test-secret";
const KEY = `sk-ant-api03-${"a".repeat(40)}wxyz`;
const apps: FastifyInstance[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

/** The three tenants columns of migration 0422, per tenant. */
function fakePool() {
  const rows = new Map<string, { ai_key_sealed: string | null; ai_key_hint: string | null; ai_key_checked_at: Date | null }>();
  const pool = {
    async query(sql: string, params: unknown[]) {
      const id = params[0] as string;
      if (sql.startsWith("SELECT")) return { rows: rows.has(id) ? [rows.get(id)] : [] };
      rows.set(id, params.length > 1 ? { ai_key_sealed: params[1] as string, ai_key_hint: params[2] as string, ai_key_checked_at: new Date(0) }
        : { ai_key_sealed: null, ai_key_hint: null, ai_key_checked_at: null });
      return { rows: [] };
    }
  } as unknown as PgClientLike;
  return { pool, rows };
}

function fakeAnthropic(status: number | "down") {
  const seen: Array<{ url: string; key: string | null }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    seen.push({ url, key: new Headers(init.headers).get("x-api-key") });
    if (status === "down") throw new Error("ECONNREFUSED");
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

describe("tenant AI key (K5)", () => {
  it("seals per tenant: the right tenant opens it, another tenant or a tampered seal does not", () => {
    const seal = createAiKeySeal("m".repeat(40));
    const sealed = seal.seal("tenant:a", KEY);
    expect(sealed).not.toContain(KEY);
    expect(seal.open("tenant:a", sealed)).toBe(KEY);
    expect(() => seal.open("tenant:b", sealed)).toThrow();
    expect(() => createAiKeySeal("m".repeat(40) + "x").open("tenant:a", sealed)).toThrow();
    expect(() => seal.open("tenant:a", sealed.replace(/\.[^.]+$/, ".AAAAAAAAAAAAAAAAAAAAAA"))).toThrow();
    expect(() => createAiKeySeal("short")).toThrow();
  });

  it("keeps a key only after Anthropic accepts it, and gives it to the cell turns' upstream", async () => {
    const { pool, rows } = fakePool();
    const seal = createAiKeySeal("m".repeat(40));
    const refused = createTenantAiKeys({ pool, seal, fetch: fakeAnthropic(401).fetcher });
    await expect(refused.connect("tenant:a", "not-a-key")).rejects.toMatchObject({ code: "AI_KEY_SHAPE" });
    await expect(refused.connect("tenant:a", KEY)).rejects.toMatchObject({ code: "AI_KEY_REFUSED" });
    await expect(createTenantAiKeys({ pool, seal, fetch: fakeAnthropic("down").fetcher }).connect("tenant:a", KEY)).rejects.toMatchObject({ code: "AI_KEY_CHECK_FAILED" });
    await expect(createTenantAiKeys({ pool, seal, fetch: fakeAnthropic(529).fetcher }).connect("tenant:a", KEY)).rejects.toMatchObject({ code: "AI_KEY_CHECK_FAILED" });
    expect(rows.size).toBe(0);
    const anthropic = fakeAnthropic(200);
    const keys = createTenantAiKeys({ pool, seal, fetch: anthropic.fetcher });
    await keys.connect("tenant:a", ` ${KEY}\n`);
    expect(anthropic.seen).toEqual([{ url: `${ANTHROPIC_API_URL}/v1/models?limit=1`, key: KEY }]);
    expect(rows.get("tenant:a")!.ai_key_sealed).not.toContain(KEY);
    expect(await keys.status("tenant:a")).toMatchObject({ connected: true, hint: "wxyz" });
    expect(await keys.upstream("tenant:a")).toEqual({ baseUrl: ANTHROPIC_API_URL, apiKey: KEY });
    expect(await keys.upstream("tenant:b")).toBeNull();
    await keys.disconnect("tenant:a");
    expect(await keys.status("tenant:a")).toMatchObject({ connected: false, hint: null });
    expect(await keys.upstream("tenant:a")).toBeNull();
  });

  it("gives the gateway key only to the internal tenants listed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nous-ai-key-"));
    await writeFile(join(dir, "key"), "gw-key\n");
    const env = { SPACE_CELLS_MODEL_URL: "https://ngw.example", SPACE_CELLS_MODEL_KEY_FILE: join(dir, "key"), SPACE_CELLS_GATEWAY_TENANTS: "tenant:staff, tenant:ops" };
    const upstream = cellsGatewayUpstream(env);
    expect(await upstream("tenant:ops", "user:o")).toEqual({ baseUrl: "https://ngw.example", apiKey: "gw-key", headers: { "x-nous-task": "reason" } });
    expect(await upstream("tenant:invited", "user:i")).toBeNull();
    expect(await cellsGatewayUpstream({ ...env, SPACE_CELLS_GATEWAY_TENANTS: "" })("tenant:ops", "user:o")).toBeNull();
  });

  it("routes: the account's owner connects, reads and removes its key; a team member cannot; nothing echoes the key", async () => {
    const { pool } = fakePool();
    const aiKeys = createTenantAiKeys({ pool, seal: createAiKeySeal("m".repeat(40)), fetch: fakeAnthropic(200).fetcher });
    const app = async (kind: string) => {
      const store = new InMemorySpaceStore();
      store.getUserTenantId = async () => "tenant:alice";
      const lifecycle = { account: async (tenantId: string) => ({ tenantId, kind, region: "eu", status: "ACTIVE", deleteAfter: null }) } as unknown as AccountLifecycle;
      const built = await createApp({ store, config: { ...getApiConfig({}), headless: true }, auth: { sessionSecret, devLogin: false, secureCookies: false },
        accountLifecycle: lifecycle, accountAiKeys: aiKeys });
      apps.push(built);
      return built;
    };
    const session = signSession({ id: "user:alice", email: "alice@example.test", role: "USER" }, sessionSecret);
    const headers = { cookie: `space_session=${session}`, [csrfHeaderName]: createCsrfToken(session, sessionSecret)! };
    const personal = await app("PERSONAL");
    expect((await personal.inject({ method: "PUT", url: "/api/account/ai", payload: { apiKey: KEY } })).statusCode).toBe(401);
    expect((await personal.inject({ method: "PUT", url: "/api/account/ai", headers, payload: { apiKey: "nope" } })).json()).toMatchObject({ error: { code: "AI_KEY_SHAPE" } });
    const put = await personal.inject({ method: "PUT", url: "/api/account/ai", headers, payload: { apiKey: KEY } });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain(KEY);
    expect(put.json()).toMatchObject({ provider: "anthropic", connected: true, hint: "wxyz" });
    expect((await personal.inject({ method: "GET", url: "/api/account/ai", headers })).json()).toMatchObject({ connected: true });
    const team = await app("TEAM");
    expect((await team.inject({ method: "DELETE", url: "/api/account/ai", headers })).statusCode).toBe(403);
    expect((await personal.inject({ method: "DELETE", url: "/api/account/ai", headers })).json()).toMatchObject({ connected: false });
  });
});
