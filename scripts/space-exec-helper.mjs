#!/usr/bin/env node
// Runs the API's buffered commands (apps/api/src/safe-child-process.ts): a fork copies the caller's page tables, which
// blocked the API's event loop 77-170 ms per command at ~1 GB (speed audit 14/11); this process stays small.
// In: { id, file, args, options, groupTimeoutMs }. Out: { id, error, stdout, stderr, timedOut }; error is execFile's
// (code: the exit status, or the errno name when the command did not start).
import { execFile, spawn } from "node:child_process";

// execFile takes no `detached`: a command whose timeout must take its whole process group (git and its hooks) is
// spawned as the group's leader and buffered here, without a size limit.
function runGroup({ id, file, args, options, groupTimeoutMs }) {
  const child = spawn(file, args, { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let failed = null;
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }, groupTimeoutMs);
  child.on("error", (error) => { failed = { message: error.message, code: error.code ?? "UNKNOWN" }; });
  child.on("close", (code) => {
    clearTimeout(timer);
    process.send({ id, error: failed ?? (code ? { message: `Command failed: ${file}`, code } : null), stdout, stderr, timedOut });
  });
}

process.on("message", (call) => {
  const { id, file, args, options } = call;
  const fail = (error, stdout = "", stderr = "") =>
    process.send({ id, error: error && { ...error, message: error.message }, stdout, stderr, timedOut: false });
  try {
    if (call.groupTimeoutMs) runGroup(call);
    // `input` (not an execFile option) is written to the command's stdin; without it stdin stays open, as execFile leaves it.
    else if (typeof options.input === "string") execFile(file, args, options, fail).stdin?.on("error", () => undefined).end(options.input);
    else execFile(file, args, options, fail);
  } catch (error) {
    fail(error); // invalid arguments throw instead of calling back
  }
});
// The API is gone: nothing reads the answers.
process.on("disconnect", () => process.exit(0));
