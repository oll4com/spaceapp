// Credential-shaped text inside free-form error messages and stacks (an upstream error that echoes a key or a URL with a
// password). Named fields are handled by the API's apiLogRedaction; this covers the text itself (1.1.7 review, Codex #9).
// Shared with the worker's free-text log lines (OBS-011).
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
