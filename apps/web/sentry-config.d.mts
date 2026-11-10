/** Types of sentry-config.mjs (the web server imports no workspace package and has no build). */
export function webSentryConfig(env: Record<string, string | undefined>, release: string | undefined):
  { dsn: string; release?: string; environment: "dev" | "public" | "stable" } | undefined;
