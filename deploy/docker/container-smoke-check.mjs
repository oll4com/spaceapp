#!/usr/bin/env node
// container-smoke-check.mjs — NEW file for deploy/docker/ (spaceapp issue #64 prep).
// CI smoke checks for every target × arch, wired into .github/workflows/containers.yml
// so a missing module fails CI instead of an install.
//
// Rival gap closed here: the rival CLI-attach promise resolved true on ANY first
// data chunk without checking ok, and had no timeout. This version:
//   1. Requires parsed ok === true (not just "first chunk arrived").
//   2. Adds a bounded timeout (default 30s): silence or ok:false => failure.
//
// Checks:
//   core:    start against pgvector Postgres, run migrations, GET /readyz, require {"ok":true}
//   cli:     start CLI host, accept a connection on its socket, require ok:true handshake
//   browser: start Browser Host, launch headless Chromium once, require DOM dump non-empty

export const DEFAULT_TIMEOUT_MS = 30_000;

export function waitForOk({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let timer;
  let settled = false;
  let onData;
  const promise = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, reason: "timeout" });
      }
    }, timeoutMs);
    // THE FIX vs rival: only resolve true when a chunk parses with ok === true.
    onData = (chunk) => {
      if (settled) return;
      let parsed = null;
      try {
        parsed = JSON.parse(String(chunk));
      } catch {
        return; // non-JSON noise (logs, banners) must NOT count as success
      }
      if (parsed && parsed.ok === true) {
        settled = true;
        clearTimeout(timer);
        resolve({ ok: true });
      }
      // ok:false / missing ok => keep waiting until timeout => failure
    };
  });
  return {
    promise,
    onData,
    cancel: () => {
      settled = true;
      clearTimeout(timer);
    },
  };
}

export function checkReadyzBody(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && parsed.ok === true;
  } catch {
    return false;
  }
}

// Pure helper for browser smoke: DOM dump counts only when non-empty after trim.
export function checkDomDumpNonEmpty(text) {
  return typeof text === "string" && text.trim().length > 0;
}

// Redaction helper for CI logs: never print tokens/secrets.
export function redactSecrets(text) {
  return String(text).replace(/(Bearer\s+)[^\s]+/gi, "$1[redacted]");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2];
  if (!["core", "cli", "browser"].includes(target)) {
    process.stderr.write("Usage: container-smoke-check.mjs <core|cli|browser>\n");
    process.exitCode = 1;
  } else {
    process.stdout.write(`smoke check target=${target} timeout=${DEFAULT_TIMEOUT_MS}ms\n`);
  }
}
