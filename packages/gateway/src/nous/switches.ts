import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { AdminAudit, AdminCaller } from "./admin.js";

/**
 * Kill switches of the Nous Gateway (plan clipboard:_0qBSFCftZuD step 4, K5-switches; install plan §3.6). A row per (switch, scope) in
 * `ngw_switches`; every replica reads them with a 5 s cache that a `NOTIFY ngw_switch_changed` drops at once. Only a person turns one,
 * on the admin listener; a global one (scope `*`) waits for a second person's approval. Every request and change is audited.
 * Freeze user, disable key and pause account are the key and account states; the commercial API fallback is the existing setting.
 */
export const SWITCH_CHANGED = "ngw_switch_changed";
export const SWITCHES = {
  provider_off: /^(CLAUDE|CODEX|GEMINI)(:[a-z0-9-]{2,16}:(paid|trial))?$/, // a provider everywhere, or in one pool
  model_off: /^[a-z0-9][a-z0-9.-]{1,79}$/,
  user_traffic_only: /^\*$/, // BACKGROUND refused everywhere
  all_included_ai_off: /^\*$/,
  signups_brake: /^\*$/ // read by the control plane (K4)
} as const;
export type SwitchName = keyof typeof SWITCHES;
export const isGlobal = (scope: string) => scope === "*";

export interface SwitchState {
  allIncludedAiOff: boolean;
  userTrafficOnly: boolean;
  /** The provider is off everywhere or in this pool. */
  providerOff(provider: string, pool: string): boolean;
  modelOff(model: string): boolean;
}

export function switchState(rows: readonly { name: string; scope: string; value: boolean }[]): SwitchState {
  const on = new Set(rows.filter((row) => row.value).map((row) => `${row.name}|${row.scope}`));
  return {
    allIncludedAiOff: on.has("all_included_ai_off|*"),
    userTrafficOnly: on.has("user_traffic_only|*"),
    providerOff: (provider, pool) => on.has(`provider_off|${provider}`) || on.has(`provider_off|${provider}:${pool}`),
    modelOff: (model) => on.has(`model_off|${model}`)
  };
}

/** Per replica: the switches, cached for `ttlMs` and dropped by NOTIFY. shortcut: a lost LISTEN connection is not re-opened; the TTL bounds it. */
export async function createSwitchReader(db: pg.Pool, ttlMs = 5_000) {
  let cache: { at: number; state: SwitchState } | null = null;
  const listener = await db.connect();
  listener.on("notification", () => { cache = null; });
  await listener.query(`LISTEN ${SWITCH_CHANGED}`);
  return {
    async state(): Promise<SwitchState> {
      if (!cache || Date.now() - cache.at >= ttlMs) cache = { at: Date.now(), state: switchState((await db.query("SELECT name, scope, value FROM ngw_switches")).rows) };
      return cache.state;
    },
    async close() {
      await listener.query(`UNLISTEN ${SWITCH_CHANGED}`).catch(() => {});
      listener.release();
    }
  };
}
export type SwitchReader = Awaited<ReturnType<typeof createSwitchReader>>;

async function applySwitch(db: pg.Pool, change: { name: string; scope: string; value: boolean; reason: string; setBy: string }) {
  await db.query(`INSERT INTO ngw_switches (name, scope, value, set_by, set_at, reason) VALUES ($1, $2, $3, $4, now(), $5)
    ON CONFLICT (name, scope) DO UPDATE SET value = EXCLUDED.value, set_by = EXCLUDED.set_by, set_at = now(), reason = EXCLUDED.reason`,
  [change.name, change.scope, change.value, change.setBy, change.reason]);
  await db.query("SELECT pg_notify($1, $2)", [SWITCH_CHANGED, `${change.name}|${change.scope}`]);
}

const changeBody = z.object({ scope: z.string().min(1).max(100), value: z.boolean(), reason: z.string().trim().min(1).max(500) }).strict();

export function registerSwitchRoutes(app: FastifyInstance, deps: { db: pg.Pool; caller(request: FastifyRequest): AdminCaller; audit: AdminAudit;
  personOnly(request: FastifyRequest, reply: FastifyReply): Promise<unknown> }) {
  const { db, caller, audit } = deps;
  app.get("/switches", async () => ({
    switches: (await db.query("SELECT name, scope, value, set_by, set_at, reason FROM ngw_switches ORDER BY name, scope")).rows,
    pending: (await db.query("SELECT id, name, scope, value, reason, requested_by, requested_at FROM ngw_switch_requests WHERE approved_at IS NULL ORDER BY requested_at")).rows
  }));
  app.put("/switches/:name", { preHandler: deps.personOnly }, async (request, reply) => {
    const name = (request.params as { name: string }).name as SwitchName;
    if (!Object.hasOwn(SWITCHES, name)) return reply.code(404).send({ error: { code: "unknown_switch", message: `No switch '${name}'.` } });
    const body = changeBody.safeParse(request.body ?? {});
    if (!body.success || !SWITCHES[name].test(body.data.scope)) return reply.code(400).send({ error: { code: "invalid_request", message: "scope, value and reason are required; the scope must fit the switch." } });
    const actor = caller(request).actor;
    if (isGlobal(body.data.scope)) {
      // A global switch waits for a second person.
      const id = `ngwsw:${randomUUID()}`;
      await db.query("INSERT INTO ngw_switch_requests (id, name, scope, value, reason, requested_by) VALUES ($1, $2, $3, $4, $5, $6)",
        [id, name, body.data.scope, body.data.value, body.data.reason, actor]);
      await audit("*", actor, "switch.request", { id, name, ...body.data });
      return reply.code(202).send({ pending: id, needs: "a second person's approval" });
    }
    await applySwitch(db, { name, ...body.data, setBy: actor });
    await audit("*", actor, "switch.set", { name, ...body.data });
    return { ok: true };
  });
  app.post("/switches/requests/:id/approve", { preHandler: deps.personOnly }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const actor = caller(request).actor;
    const row = (await db.query(`UPDATE ngw_switch_requests SET approved_by = $2, approved_at = now() WHERE id = $1 AND approved_at IS NULL AND requested_by <> $2
      RETURNING name, scope, value, reason, requested_by`, [id, actor])).rows[0];
    if (!row) return reply.code(409).send({ error: { code: "not_approvable", message: "No open request with this id that another person made." } });
    await applySwitch(db, { name: row.name, scope: row.scope, value: row.value, reason: row.reason, setBy: `${row.requested_by}+${actor}` });
    await audit("*", actor, "switch.set", { id, name: row.name, scope: row.scope, value: row.value, requestedBy: row.requested_by });
    return { ok: true };
  });
}
