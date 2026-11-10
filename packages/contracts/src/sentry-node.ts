/** Node-only adapter; browser clients import the separate, SDK-free /sentry policy. */
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import * as Sentry from "@sentry/node";
import { initSpaceSentry, sentryDsnFor, sentryEnvironmentFor, type SpaceSentryService } from "./sentry.js";

export interface SentryTrace { trace_id: string; span_id: string }
let enabled = false;

export function createSentryTrace(traceparent?: unknown): SentryTrace {
  const match = typeof traceparent === "string" ? /^00-([a-f0-9]{32})-([a-f0-9]{16})-[a-f0-9]{2}$/.exec(traceparent) : null;
  return {
    trace_id: match && !/^0+$/.test(match[1]!) && !/^0+$/.test(match[2]!) ? match[1]! : randomBytes(16).toString("hex"),
    span_id: randomBytes(8).toString("hex")
  };
}

export function sentryBuildRelease(): string | undefined {
  try { return (JSON.parse(readFileSync(new URL("./sentry-release.json", import.meta.url), "utf8")) as { release?: string }).release; }
  catch { return undefined; }
}

export function initNodeSentry(service: Exclude<SpaceSentryService, "web">, env: NodeJS.ProcessEnv = process.env, dist?: string): boolean {
  if (enabled) return true;
  enabled = initSpaceSentry((options) => Sentry.init({
    ...options,
    enableOpenTelemetrySetup: false, enableRuntimeChannelInjection: false,
    // API and the desktop main process keep running on their own guards. Other processes retain Node's fatal rejection policy.
    integrations: [Sentry.onUncaughtExceptionIntegration({ exitEvenIfOtherHandlersAreRegistered: false }),
      Sentry.onUnhandledRejectionIntegration({ mode: service === "api" || service === "desktop" ? "none" : "strict" })]
  }), {
    service, dsn: sentryDsnFor(service.replaceAll("-", "_").toUpperCase(), env),
    release: env.SENTRY_RELEASE || sentryBuildRelease(), environment: sentryEnvironmentFor(env), dist
  });
  return enabled;
}

/** An explicit per-error trace avoids shared-scope contamination between concurrent requests. */
export function captureSentryException(error: unknown, trace?: SentryTrace): void {
  if (!enabled) return;
  try { Sentry.captureException(error, trace ? { contexts: { trace: { ...trace } } } : undefined); }
  catch { /* Reporting must not change the application outcome. */ }
}

/** An Electron process that ended abnormally: its kind and fixed reason only (no minidump: process memory can hold page text). */
export function captureSentryProcessGone(kind: "RenderProcessGone" | "ChildProcessGone", reason: string): void {
  if (!enabled) return;
  const error = new Error(kind);
  error.name = kind;
  try { Sentry.captureException(error, { level: "fatal", tags: { reason } }); }
  catch { /* Reporting must not change the application outcome. */ }
}

export async function flushSentry(): Promise<void> {
  if (enabled) await Sentry.flush(2_000).catch(() => false); // Shutdown grace period, not a data cap.
}
