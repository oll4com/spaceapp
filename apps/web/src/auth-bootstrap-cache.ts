import type { AuthMe } from "@space/contracts";

let cachedAuthBootstrap: AuthMe | null = null;

export function cacheAuthBootstrap(auth: AuthMe): void {
  cachedAuthBootstrap = auth;
}

export function consumeAuthBootstrap(): AuthMe | null {
  const auth = cachedAuthBootstrap;
  cachedAuthBootstrap = null;
  return auth;
}

export function clearAuthBootstrapCache(): void {
  cachedAuthBootstrap = null;
}

let signedInUser: string | null = null;

/** Every auth answer (me, login, setup claim) names the signed-in user; state kept per user on this device reads it (nous-ui-state.ts). */
export function noteSignedInUser<T>(payload: T): T {
  const auth = payload as { user?: { id?: unknown } | null } | null;
  if (auth && "user" in auth) signedInUser = typeof auth.user?.id === "string" ? auth.user.id : null;
  return payload;
}

export const signedInUserId = (): string | null => signedInUser;
