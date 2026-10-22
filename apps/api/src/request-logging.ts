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

