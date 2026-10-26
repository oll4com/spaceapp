import type { FastifyRequest, FastifyServerOptions } from "fastify";
import { requestIpForLog } from "./request-helpers.js";

// Keep URL logging policy independent of app bootstrap and credentials.
const sensitiveRequestQueryNames = new Set([
  "apikey",
  "q",
  "query",
  "search",
  "prompt",
  "text",
  "transcript",
  "auth",
  "authorization",
  "credential",
  "csrf",
  "code",
  "key",
  "password",
  "secret",
  "state",
  "ticket",
  "token"
]);

function isSensitiveRequestQueryName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[-_]/g, "");
  return (
    sensitiveRequestQueryNames.has(normalized) ||
    normalized.endsWith("key") ||
    normalized.endsWith("password") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("ticket") ||
    normalized.endsWith("token")
  );
}

export function redactRequestUrlForLog(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl, "http://space.local");
    const redactedSearchParams = new URLSearchParams();
    for (const [name, value] of parsed.searchParams.entries()) {
      redactedSearchParams.append(name, isSensitiveRequestQueryName(name) ? "[REDACTED]" : value);
    }
    const query = redactedSearchParams.toString();
    return `${parsed.pathname}${query ? `?${query}` : ""}`;
  } catch {
    return "[INVALID_REQUEST_URL]";
  }
}

/**
 * Structured-log redaction applied by the API logger. Request headers are never
 * serialized, but handlers sometimes log objects (request bodies, upstream
 * errors) that can carry credentials one or two levels deep.
 */
export const apiLogRedaction = {
  paths: [
    "req.headers.authorization",
    "req.headers.cookie",
    'req.headers["x-space-csrf-token"]',
    'req.headers["x-space-internal-token"]',
    'req.headers["x-space-control-token"]',
    'req.headers["x-space-cli-browser-token"]',
    'req.headers["x-space-cli-agent-files-token"]',
    "password",
    "token",
    "apiKey",
    "secret",
    "*.password",
    "*.passwordHash",
    "*.token",
    "*.accessToken",
    "*.refreshToken",
    "*.idToken",
    "*.apiKey",
    "*.secret",
    "*.clientSecret",
    "*.sessionSecret",
    "*.authorization",
    "*.cookie",
    "*.headers.authorization",
    "*.headers.cookie",
    '*.headers["x-space-internal-token"]',
    '*.headers["x-space-control-token"]',
    '*.headers["x-space-cli-browser-token"]',
    '*.headers["x-space-cli-agent-files-token"]',
    "*.*.headers.authorization",
    "*.*.headers.cookie",
    "*.*.password",
    "*.*.token",
    "*.*.apiKey",
    "*.*.secret"
  ],
  censor: "[REDACTED]"
};

// Credential-shaped text inside free-form error messages and stacks (an upstream error that echoes a key or a URL with a
// password). Named fields are handled by apiLogRedaction; this covers the text itself (1.1.7 review, Codex #9).
const secretTextPatterns: Array<[RegExp, string]> = [
  [/\b(?:sk|pk|rk|sess|ghp|gho|ghs|github_pat|xox[abp])[-_][A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/g, "$1 [REDACTED]"],
  // Assignments only (token=…, "password": "…"), so prose like "token expired" stays readable.
  [/\b(access_token|refresh_token|token|apikey|api_key|api-key|password|passwd|secret|client_secret)(["']?\s*[=:]\s*["']?)[^\s",;'&]{4,}/gi, "$1$2[REDACTED]"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@"]
];
export function redactSecretText(text: string): string {
  return secretTextPatterns.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}

/**
 * The API logger's error serializer: only the error's type, name, code and status, and its message and stack with
 * credential-shaped text removed. Other enumerable properties (request options, headers, bodies an HTTP client attaches)
 * never reach the log.
 */
export function serializeErrorForLog(error: unknown, depth = 0): unknown {
  if (!error || typeof error !== "object") return typeof error === "string" ? redactSecretText(error) : error;
  const source = error as { name?: unknown; code?: unknown; statusCode?: unknown; status?: unknown; message?: unknown; stack?: unknown; cause?: unknown };
  const text = (value: unknown) => (typeof value === "string" ? redactSecretText(value) : undefined);
  const scalar = (value: unknown) => (typeof value === "string" || typeof value === "number" ? value : undefined);
  return {
    type: (error as object).constructor?.name ?? "Object",
    name: text(source.name),
    code: scalar(source.code),
    statusCode: scalar(source.statusCode ?? source.status),
    message: text(source.message),
    stack: text(source.stack),
    ...(source.cause !== undefined && depth < 2 ? { cause: serializeErrorForLog(source.cause, depth + 1) } : {})
  };
}

/** The API logger's options: level, redaction, the allowlisted error serializer and the request line. */
export function apiLoggerOptions(stream?: { write(message: string): void }): Exclude<FastifyServerOptions["logger"], boolean | undefined> {
  return {
    level: process.env.LOG_LEVEL ?? "info",
    redact: apiLogRedaction,
    ...(stream ? { stream } : {}),
    serializers: {
      err: serializeErrorForLog as (error: unknown) => { type: string; message: string; stack: string; [key: string]: unknown },
      error: serializeErrorForLog,
      req(request: FastifyRequest & { socket?: { remoteAddress?: string; remotePort?: number } }) {
        const socket = request.raw?.socket ?? request.socket;
        return {
          method: request.method,
          url: redactRequestUrlForLog(request.url),
          host: request.headers.host,
          remoteAddress: requestIpForLog(request) ?? socket?.remoteAddress,
          remotePort: socket?.remotePort
        };
      }
    }
  };
}
