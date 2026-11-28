import type { FastifyBaseLogger, FastifyReply, FastifyRequest, HookHandlerDoneFunction } from "fastify";
import { TENANT_LOCAL, withTenant } from "@space/db";
import type { AuthUser } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import { sendApiError } from "./http-errors.js";

const ACCESS_CACHE_TTL_MS = 60_000;

/**
 * What a signed-in user may do now, as the store says, cached for a minute: the database role replaces the role in
 * the long-lived token, and a disabled account gets no session at all (also after SPACE_MULTI_USER_ENABLED is turned off).
 */
export function createSessionAccess(options: { store: Pick<SpaceStore, "getControlActor" | "isUserDisabled">; durableUsers?: boolean }) {
  const { store, durableUsers = false } = options;
  const roleCache = new Map<string, { role: AuthUser["role"]; cachedAt: number }>();
  const disabledCache = new Map<string, { disabled: boolean; cachedAt: number }>();
  const fresh = (entry: { cachedAt: number } | undefined, now: number) => entry !== undefined && now - entry.cachedAt < ACCESS_CACHE_TTL_MS;
  return {
    roleCache,
    /** The session user with its confirmed role, or null when the account is disabled. */
    async resolve(sessionUser: AuthUser, log: FastifyBaseLogger, now = Date.now()): Promise<AuthUser | null> {
      const cached = roleCache.get(sessionUser.id);
      if (cached && fresh(cached, now)) {
        sessionUser.role = cached.role;
      } else if (store.getControlActor) {
        try {
          // Durable rows (EXT-C-F9): by id, else by the signed e-mail the way upsertUser owns rows (the broker's user:operator-diagnostics
          // has no row of its own; demoting it would let its next upsertUser write USER onto the operator's row); no row at all (a deleted
          // account): USER. The memory store loses its rows on restart while cookies live on, so there a missing row keeps the token's role.
          const dbActor = await store.getControlActor(sessionUser.id, durableUsers ? sessionUser.email : undefined);
          if (dbActor || durableUsers) {
            const role = dbActor?.role ?? "USER";
            roleCache.set(sessionUser.id, { role, cachedAt: now });
            sessionUser.role = role;
          }
        } catch (error) {
          // Never trust the role embedded in a long-lived token when the store
          // cannot confirm it: reuse the last confirmed role, otherwise USER.
          sessionUser.role = cached?.role ?? "USER";
          log.warn({ err: error, userId: sessionUser.id, appliedRole: sessionUser.role }, "User role lookup failed; applying least-privilege role.");
        }
      }
      if (!store.isUserDisabled) return sessionUser;
      const known = disabledCache.get(sessionUser.id);
      if (!fresh(known, now)) {
        try {
          disabledCache.set(sessionUser.id, { disabled: await store.isUserDisabled(sessionUser.id), cachedAt: now });
        } catch (error) {
          // Disabling also revoked the user's tokens, so the last known state is a safe fallback.
          log.warn({ err: error, userId: sessionUser.id }, "Disabled-account lookup failed; using the last known state.");
        }
      }
      return disabledCache.get(sessionUser.id)?.disabled ? null : sessionUser;
    },
    /**
     * A broker session acts as user:operator. With no SPACE_OPERATOR_EMAIL (public-host) the broker signs its fallback space@space.local, the dev
     * login's row, and upsertUser owns by e-mail: pane plans went to user:dev-operator (12/11). The operator's own row names the e-mail then.
     */
    async actAsOperator(sessionUser: AuthUser, operatorEmail: string | undefined): Promise<void> {
      sessionUser.id = "user:operator";
      if (!operatorEmail) sessionUser.email = (await store.getControlActor?.("user:operator"))?.email ?? sessionUser.email;
    },
    /** Drops what is cached for a user whose access changed. */
    forget(userId: string): void {
      roleCache.delete(userId);
      disabledCache.delete(userId);
    }
  };
}

// K1 M6 (plan clipboard:ZGz1LnD51ELH step 17, packages/db/src/tenant-context.ts): with SPACE_TENANCY_ENABLED=1 a signed-in
// request (session, phone channel, CLI control token) runs in its user's users.tenant_id, so row-level security shows only that
// tenant's rows. A preHandler after the auth preHandler, because the CLI control token sets request.user there.
export function requestTenantHook(store: Pick<SpaceStore, "getUserTenantId">) {
  const tenants = new Map<string, string>(); // a user's tenant is set once (M0, K2 sign-up) and never moves
  return (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => {
    const userId = request.user?.id;
    if (!userId) return done();
    const known = tenants.get(userId);
    if (known) return withTenant(known, done);
    // The in-memory store has no row-level security (design §2.5): one tenant.
    Promise.resolve(store.getUserTenantId ? store.getUserTenantId(userId) : TENANT_LOCAL).then((tenant) => {
      // Fail closed: a user without a row would otherwise act as the owner, who sees every tenant.
      if (!tenant) return void sendApiError(reply, 403, "TENANT_UNKNOWN", "This account belongs to no tenant.");
      tenants.set(userId, tenant);
      withTenant(tenant, done);
    }, (error: Error) => done(error));
  };
}
