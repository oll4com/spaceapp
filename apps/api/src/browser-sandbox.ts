import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childProcessEnv } from "./child-process-env.js";

/**
 * Chromium's own sandbox, used whenever this host can run it (INT5-C-F3, design
 * ~/agent-workspace/active/20261102-int5-c-f3/design.md, option A). Once per process and Chrome path, one headless
 * Chrome starts WITHOUT --no-sandbox: Chromium on Linux refuses to start when it cannot build its sandbox ("No usable
 * sandbox!", or a fatal namespace error), so a clean exit with the page's marker proves it runs sandboxed. Only when that
 * check fails do Space's Chromes keep today's --no-sandbox, and the reason is named in the Browser Host's health.
 */
export interface ChromeSandboxState {
  state: "CHECKING" | "SANDBOXED" | "NO_SANDBOX";
  reason: string;
  checkedAt: string | null;
}

export type ChromeSandboxProbe = (chromePath: string) => Promise<{ ok: boolean; detail: string }>;

const MARKER = "space-chrome-sandbox-ok";
const PROBE_TIMEOUT_MS = 30_000;

/** One headless Chrome without --no-sandbox, its own throwaway profile and home; never a network page. */
export const probeChromeSandbox: ChromeSandboxProbe = async (chromePath) => {
  const dir = await mkdtemp(join(tmpdir(), "space-chrome-sandbox-"));
  try {
    return await new Promise((resolve) => {
      const child = spawn(chromePath, [
        "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
        "--disable-background-networking", "--disable-component-update", "--disable-crash-reporter", "--disable-dev-shm-usage",
        `--user-data-dir=${join(dir, "profile")}`, "--dump-dom", `data:text/html,<p>${MARKER}</p>`
      ], { env: { ...childProcessEnv(), HOME: dir }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4_000); });
      const timer = setTimeout(() => child.kill("SIGKILL"), PROBE_TIMEOUT_MS);
      child.on("error", (error) => { clearTimeout(timer); resolve({ ok: false, detail: error.message }); });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (code === 0 && stdout.includes(MARKER)) return resolve({ ok: true, detail: "" });
        const cause = /No usable sandbox[^\n.]*|FATAL[^\n]*/.exec(stderr)?.[0]?.trim();
        resolve({ ok: false, detail: cause ?? (signal ? `stopped by ${signal}` : `exit ${code}`) });
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
};

/** The sandbox decision for one Chrome path: `args()` is [] when the check passed, ["--no-sandbox"] otherwise. */
export function createChromeSandboxCheck(chromePath: string, probe: ChromeSandboxProbe = probeChromeSandbox) {
  let current: ChromeSandboxState = { state: "CHECKING", reason: "Checking Chrome's sandbox.", checkedAt: null };
  let pending: Promise<string[]> | null = null;
  const args = (): Promise<string[]> => pending ??= probe(chromePath)
    .catch((error: unknown) => ({ ok: false, detail: error instanceof Error ? error.message : String(error) }))
    .then(({ ok, detail }) => {
      const checkedAt = new Date().toISOString();
      // The one line an operator greps for: under Docker's default AppArmor and seccomp this is the expected outcome.
      if (!ok) console.warn(`Chrome sandbox unavailable (${detail}); browsers run with --no-sandbox. A host-root AppArmor profile or an explicit opt-in to apparmor=unconfined enables it (INT5-C-F3).`);
      current = ok
        ? { state: "SANDBOXED", reason: "Chrome runs with its own sandbox.", checkedAt }
        : { state: "NO_SANDBOX", reason: `Chrome's sandbox is unavailable on this host (${detail}); browsers run with --no-sandbox.`, checkedAt };
      return ok ? [] : ["--no-sandbox"];
    });
  return { args, state: (): ChromeSandboxState => current };
}

const checks = new Map<string, ReturnType<typeof createChromeSandboxCheck>>();

/** The process-wide check for a Chrome path (the Browser Host's sessions and the API's evidence captures share it). */
export function chromeSandboxCheck(chromePath: string): ReturnType<typeof createChromeSandboxCheck> {
  let check = checks.get(chromePath);
  if (!check) checks.set(chromePath, check = createChromeSandboxCheck(chromePath));
  return check;
}
