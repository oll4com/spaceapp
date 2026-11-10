/** Shared by Node and React. SDKs stay at the application edge, outside contracts. */
export type SpaceSentryService = "api" | "worker" | "gateway" | "browser-host" | "cli-host" | "web" | "desktop";
export interface SpaceSentryConfig {
  dsn?: string;
  release?: string;
  environment?: string;
  service: SpaceSentryService;
  /** Desktop app version (x.y.z); the release stays the build SHA. */
  dist?: string;
}

type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields => value !== null && typeof value === "object" ? value as Fields : {};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
// The desktop reports a crashed Electron process as one of these types, with only its fixed reason as a tag.
const errorTypes = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "AggregateError",
  "RenderProcessGone", "ChildProcessGone"]);
const processGoneReasons = new Set(["abnormal-exit", "killed", "crashed", "oom", "launch-failed", "integrity-failure", "memory-eviction"]);
const distPattern = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const levels = new Set(["fatal", "error", "warning", "info", "debug"]);
const categories = new Set(["http", "fetch", "xhr", "navigation", "ui.click"]);
const methods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/** Keep code locations, never origins, credentials, queries, fragments or local home paths. */
function codeLocation(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const path = value.split(/[?#]/, 1)[0] ?? "";
  // Only Space build/source locations and Node's own frames are useful for symbolication.
  const match = path.match(/(?:^|\/)((?:apps|packages)\/[a-z-]+\/(?:src|dist)\/[A-Za-z0-9_./-]+\.[cm]?[jt]sx?|assets\/[A-Za-z0-9_-]+\.js)$/);
  if (match && !match[1]?.split("/").includes("..")) return `app:///${match[1]}`;
  // A packaged desktop runs from <install>/resources/app.asar/dist/...: keep only the part inside the archive.
  const asar = path.match(/\/app\.asar\/(dist\/(?:main|shared)\/[A-Za-z0-9_./-]+\.js)$/);
  if (asar && !asar[1]?.split("/").includes("..")) return `app:///apps/desktop/${asar[1]}`;
  return /^node:[a-z_]+(?:\/[a-z_]+)*$/.test(path) ? path : undefined;
}

function stacktrace(value: unknown): Fields | undefined {
  const frames = fields(value).frames;
  if (!Array.isArray(frames)) return undefined;
  return { frames: frames.map((raw) => {
    const frame = fields(raw);
    const filename = codeLocation(frame.filename);
    return {
      ...(filename ? { filename } : {}),
      ...(finite(frame.lineno) ? { lineno: frame.lineno } : {}),
      ...(finite(frame.colno) ? { colno: frame.colno } : {}),
      ...(typeof frame.in_app === "boolean" ? { in_app: frame.in_app } : {})
    };
  }) };
}

/** Allowlist instead of redacting patterns: unknown fields and all free text are private.
 * This also removes secrets whose value/format is unknown (Vault, mail, prompts, console).
 * Do not pass originalEvent, request, user, source context, locals or attachment hints through.
 */
export function scrubSentryEvent<T extends object>(event: T): T {
  const input = fields(event);
  const values = fields(input.exception).values;
  const images = fields(input.debug_meta).images;
  const debugImages = Array.isArray(images) ? images.flatMap((raw) => {
    const image = fields(raw);
    const code_file = codeLocation(image.code_file);
    return code_file && typeof image.debug_id === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(image.debug_id)
      ? [{ type: "sourcemap", code_file, debug_id: image.debug_id }] : [];
  }) : [];
  const trace = fields(fields(input.contexts).trace);
  const reason = fields(input.tags).reason;
  const validTrace = typeof trace.trace_id === "string" && /^[a-f0-9]{32}$/.test(trace.trace_id) && !/^0+$/.test(trace.trace_id)
    && typeof trace.span_id === "string" && /^[a-f0-9]{16}$/.test(trace.span_id) && !/^0+$/.test(trace.span_id);
  return {
    ...(debugImages.length ? { debug_meta: { images: debugImages } } : {}),
    ...(validTrace ? { contexts: { trace: { trace_id: trace.trace_id, span_id: trace.span_id } } } : {}),
    ...(typeof input.event_id === "string" && /^[a-f0-9]{32}$/i.test(input.event_id) ? { event_id: input.event_id } : {}),
    ...(finite(input.timestamp) ? { timestamp: input.timestamp } : {}),
    ...(typeof input.dist === "string" && distPattern.test(input.dist) ? { dist: input.dist } : {}),
    ...(typeof reason === "string" && processGoneReasons.has(reason) ? { tags: { reason } } : {}),
    ...(typeof input.level === "string" && levels.has(input.level) ? { level: input.level } : {}),
    ...(input.platform === "node" || input.platform === "javascript" ? { platform: input.platform } : {}),
    ...(Array.isArray(values) ? { exception: { values: values.map((raw) => {
      const error = fields(raw);
      const stack = stacktrace(error.stacktrace);
      const mechanism = fields(error.mechanism);
      return {
        type: typeof error.type === "string" && errorTypes.has(error.type) ? error.type : "Error",
        value: "[Filtered]",
        ...(stack ? { stacktrace: stack } : {}),
        ...(typeof mechanism.handled === "boolean" ? { mechanism: { type: "generic", handled: mechanism.handled } } : {})
      };
    }) } } : { message: "[Filtered]" }),
    ...(Array.isArray(input.breadcrumbs) ? { breadcrumbs: input.breadcrumbs.flatMap((raw) => {
      const crumb = scrubSentryBreadcrumb(fields(raw));
      return crumb ? [crumb] : [];
    }) } : {})
  } as T;
}

export function scrubSentryBreadcrumb<T extends object>(breadcrumb: T): T | null {
  const input = fields(breadcrumb);
  if (typeof input.category !== "string" || !categories.has(input.category)) return null;
  const data = fields(input.data);
  return {
    category: input.category,
    ...(finite(input.timestamp) ? { timestamp: input.timestamp } : {}),
    data: {
      ...(typeof data.method === "string" && methods.has(data.method) ? { method: data.method } : {}),
      ...(finite(data.status_code) ? { status_code: data.status_code } : {})
    }
  } as T;
}

export function sentryDsnConfigured(dsn: string | undefined): boolean {
  if (!dsn?.trim()) return false;
  try {
    const url = new URL(dsn);
    return ["https:", "http:"].includes(url.protocol) && Boolean(url.hostname && url.username)
      && !url.password && !url.search && !url.hash && /\/\d+$/.test(url.pathname);
  } catch { return false; }
}

type Env = Record<string, string | undefined>;
/**
 * The DSN a process or app reports to, by its variable suffix (API, WORKER, WEB, DESKTOP, ANDROID, NOUS_ANDROID...). Space's own instances:
 * SENTRY_DSN_<SUFFIX>. A public install (SPACE_PUBLIC_DISTRIBUTION=true) sends nothing unless its owner chose, through run-spaceapp like the
 * telemetry answer, SPACE_ERROR_REPORTS=own (their own Sentry: SENTRY_DSN_<SUFFIX>, else SENTRY_DSN) or =share (SpaceApp's public DSNs that
 * the image carries as SPACEAPP_SENTRY_DSN_<SUFFIX>; anonymous: the same allowlist, environment "public").
 */
export function sentryDsnFor(suffix: string, env: Env): string | undefined {
  const own = env[`SENTRY_DSN_${suffix}`];
  if (env.SPACE_PUBLIC_DISTRIBUTION !== "true") return own;
  const mode = env.SPACE_ERROR_REPORTS?.trim().toLowerCase();
  if (mode === "own") return own?.trim() ? own : env.SENTRY_DSN;
  return mode === "share" ? env[`SPACEAPP_SENTRY_DSN_${suffix}`] : undefined;
}
export const sentryEnvironmentFor = (env: Env): "dev" | "public" | "stable" =>
  env.SPACE_PUBLIC_DISTRIBUTION === "true" ? "public" : env.SPACE_INSTANCE === "dev" ? "dev" : "stable";

export function spaceSentryOptions(config: SpaceSentryConfig) {
  if (!sentryDsnConfigured(config.dsn)) return undefined;
  const release = config.release && /^[a-f0-9]{40}$/i.test(config.release) ? config.release : undefined;
  const environment = config.environment === "dev" || config.environment === "public" ? config.environment : "stable";
  return {
    dsn: config.dsn!.trim(), release, environment,
    ...(config.dist && distPattern.test(config.dist) ? { dist: config.dist } : {}),
    defaultIntegrations: false as const,
    sendDefaultPii: false, sendClientReports: false, autoSessionTracking: false,
    enableLogs: false, tracesSampleRate: 0, traceLifecycle: "static" as const,
    beforeSend<T extends object>(event: T, hint?: { attachments?: unknown[] }): T {
      if (hint) hint.attachments = [];
      const scrubbed = scrubSentryEvent(event) as T & { tags?: Record<string, string> };
      return { ...scrubbed, release, environment, tags: { ...scrubbed.tags, service: config.service } };
    },
    beforeBreadcrumb: scrubSentryBreadcrumb,
    beforeSendTransaction: () => null
  };
}

/** No DSN means no SDK initialization, hooks, timers or traffic. */
export function initSpaceSentry(
  initialize: (options: NonNullable<ReturnType<typeof spaceSentryOptions>>) => unknown,
  config: SpaceSentryConfig
): boolean {
  const options = spaceSentryOptions(config);
  if (!options) return false;
  initialize(options);
  return true;
}
