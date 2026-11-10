/**
 * Public browser configuration only. The build auth token is never read or returned here. The DSN and environment follow the same
 * choice as sentryDsnFor/sentryEnvironmentFor in @space/contracts/sentry (this server imports no workspace package).
 */
export function webSentryConfig(env, release) {
  const publicInstall = env.SPACE_PUBLIC_DISTRIBUTION === "true", mode = env.SPACE_ERROR_REPORTS?.trim().toLowerCase();
  const dsn = (!publicInstall ? env.SENTRY_DSN_WEB : mode === "own" ? env.SENTRY_DSN_WEB?.trim() || env.SENTRY_DSN : mode === "share" ? env.SPACEAPP_SENTRY_DSN_WEB : undefined)?.trim();
  if (!dsn) return undefined;
  try {
    const url = new URL(dsn);
    if (!["https:", "http:"].includes(url.protocol) || !url.username || url.password || url.search || url.hash || !/\/\d+$/.test(url.pathname)) return undefined;
    return { dsn, release: /^[a-f0-9]{40}$/i.test(release ?? "") ? release : undefined, environment: publicInstall ? "public" : env.SPACE_INSTANCE === "dev" ? "dev" : "stable" };
  } catch { return undefined; }
}
