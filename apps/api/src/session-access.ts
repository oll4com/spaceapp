import type { FastifyBaseLogger } from "fastify";
import type { AuthUser } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";

const ACCESS_CACHE_TTL_MS = 60_000;

/**
 * What a signed-in user may do now, as the store says, cached for a minute: the database role replaces the role in
 * the long-lived token, and a disabled account gets no session at all (also after SPACE_MULTI_USER_ENABLED is turned off).
 */
export function createSessionAccess(options: { store: Pick<SpaceStore, "getControlActor" | "isUserDisabled"> }) {
  const { store } = options;
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
          const dbActor = await store.getControlActor(sessionUser.id);
          if (dbActor) {
            roleCache.set(sessionUser.id, { role: dbActor.role, cachedAt: now });
            sessionUser.role = dbActor.role;
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
    /** Drops what is cached for a user whose access changed. */
    forget(userId: string): void {
      roleCache.delete(userId);
      disabledCache.delete(userId);
    }
  };
}
