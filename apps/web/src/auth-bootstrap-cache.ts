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
