// Intentionally no SDK or policy imports here. Unconfigured installs load neither.
export interface WebSentryConfig { dsn: string; release?: string; environment: "stable" | "dev" | "public" }
export interface WebSentryReporter { capture(error: unknown): void }
declare global { interface Window { __SPACE_SENTRY__?: WebSentryConfig } }
let pending: Promise<WebSentryReporter | undefined> | undefined;

export function startWebSentry(config: WebSentryConfig | undefined, load: () => Promise<Pick<typeof import("./sentry-web.js"), "initializeWebSentry">> = () => import("./sentry-web.js")): void {
  if (!config?.dsn?.trim() || pending) return;
  pending = load().then((module) => module.initializeWebSentry(config)).catch(() => undefined);
}

export function captureWebError(error: unknown): void {
  // The existing client reporter owns deduplication and the API report, even while the SDK loads.
  void pending?.then((reporter) => reporter?.capture(error)).catch(() => undefined);
}
