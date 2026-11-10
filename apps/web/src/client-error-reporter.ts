import { captureWebError } from "./sentry-bootstrap.js";
// Always-on, bounded reporting of uncaught browser errors to the API (plan 2.6).
// Only the error name and same-origin bundle locations leave the browser: no
// message, no stack text, no query strings, nothing the user typed or saw.
// The message goes only to the desktop app's own log on this computer (`local`), which redacts it.

export interface ClientErrorReport {
  kind: "error" | "rejection";
  name: string;
  locations: Array<{ file: string; line: number; column?: number }>;
  repeats: number;
}

/** Distinct errors reported per page load; repeats of one error are counted, not resent. */
export const CLIENT_ERROR_REPORT_LIMIT = 10;
const LOCATION_LIMIT = 5;
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_.$]{0,63}$/;
const SAFE_PATH = /^\/[A-Za-z0-9/_.@-]{0,159}$/;

function safeName(value: unknown): string {
  return typeof value === "string" && SAFE_NAME.test(value) ? value : "Error";
}

/** Same-origin script paths only; anything else (extensions, other hosts) becomes "/external". */
function safePath(url: string, origin: string): string {
  try {
    const parsed = new URL(url, origin);
    if (parsed.origin !== origin) return "/external";
    return SAFE_PATH.test(parsed.pathname) ? parsed.pathname : "/other";
  } catch {
    return "/other";
  }
}

export function clientErrorReport(
  kind: ClientErrorReport["kind"],
  error: unknown,
  origin: string,
  where?: { filename?: string; line?: number; column?: number }
): ClientErrorReport {
  const locations: ClientErrorReport["locations"] = [];
  const seen = new Set<string>();
  const add = (url: string, line: number, column?: number) => {
    if (!Number.isInteger(line) || line < 1 || locations.length >= LOCATION_LIMIT) return;
    const file = safePath(url, origin);
    const key = `${file}:${line}:${column ?? 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    locations.push({ file, line, ...(Number.isInteger(column) && column! > 0 ? { column } : {}) });
  };
  if (where?.filename && where.line) add(where.filename, where.line, where.column);
  const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : "";
  for (const row of stack.split("\n").slice(0, 20)) {
    const match = row.match(/(?:\(|@|\s|^)((?:https?:\/\/|\/)[^)\s]+):(\d+):(\d+)\)?$/);
    if (match) add(match[1]!, Number(match[2]), Number(match[3]));
  }
  const name = error instanceof Error ? error.name : kind === "rejection" ? "UnhandledRejection" : "Error";
  return { kind, name: safeName(name), locations, repeats: 1 };
}

function fingerprint(report: ClientErrorReport): string {
  const top = report.locations[0];
  return `${report.kind}|${report.name}|${top ? `${top.file}:${top.line}:${top.column ?? 0}` : "-"}`;
}

/**
 * Listens for uncaught errors and unhandled rejections and sends each distinct
 * one once per page load, at most CLIENT_ERROR_REPORT_LIMIT. Sending failures
 * are ignored so reporting can never cause more errors. Returns an uninstaller.
 */
export function clientErrorMessage(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    return typeof message === "string" ? message.slice(0, 2000) : "";
  } catch { return ""; }
}

export function installClientErrorReporter(options: {
  send: (report: ClientErrorReport) => Promise<unknown>;
  local?: (report: ClientErrorReport, message: string) => void;
  target?: Pick<Window, "addEventListener" | "removeEventListener">;
  origin?: string;
}): () => void {
  const target = options.target ?? window;
  const origin = options.origin ?? window.location.origin;
  const reported = new Map<string, ClientErrorReport>();
  const report = (next: ClientErrorReport, error: unknown) => {
    const key = fingerprint(next);
    const known = reported.get(key);
    if (known) {
      known.repeats += 1;
      return;
    }
    if (reported.size >= CLIENT_ERROR_REPORT_LIMIT) return;
    reported.set(key, next);
    captureWebError(error);
    try { options.local?.({ ...next }, clientErrorMessage(error)); } catch { /* Diagnostics must not break reporting. */ }
    void options.send({ ...next }).catch(() => undefined);
  };
  const onError = (event: Event) => {
    // Resource load failures (img/script tags) are not ErrorEvents and carry no stack.
    if (typeof ErrorEvent === "undefined" || !(event instanceof ErrorEvent)) return;
    report(clientErrorReport("error", event.error, origin, { filename: event.filename, line: event.lineno, column: event.colno }), event.error ?? event.message);
  };
  const onRejection = (event: Event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    report(clientErrorReport("rejection", reason, origin), reason);
  };
  const onSurfaceError = (event: Event) => {
    const error: unknown = (event as CustomEvent<unknown>).detail;
    report(clientErrorReport("error", error, origin), error);
  };
  target.addEventListener("space:surface-error", onSurfaceError);
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("space:surface-error", onSurfaceError);
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
