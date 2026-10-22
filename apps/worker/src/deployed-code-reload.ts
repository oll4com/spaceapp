import { readFileSync } from "node:fs";
import type { Worker } from "@temporalio/worker";

/** The deploy writes the commit it restarted the services on here (scripts/space-deploy-commit.sh), relative to /opt/spaceapp. */
export const SERVICES_COMMIT_FILE = "var/deploy/services-commit";
/** EX_TEMPFAIL: a failure exit, so the units' Restart=on-failure starts the worker again on the new code. */
export const STALE_CODE_EXIT_CODE = 75;

function readCommit(file: string): string | null {
  try {
    return readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * The merge queue keeps the memory workers running across deploys, and Node keeps every module it already loaded, so a
 * later lazy import of a newer build met the old @space/contracts and daily maintenance failed from 2026-10-13 on
 * (plan clipboard:yAtbVyHE5s4T). When the deploy records a new services commit, the worker waits until no activity
 * runs, shuts down and exits with a failure code so systemd restarts it on the deployed code.
 */
export function reloadWhenServicesCommitChanges(
  worker: Pick<Worker, "getStatus" | "shutdown">,
  options: { file?: string; intervalMs?: number; log?: (message: string) => void } = {}
): () => void {
  const file = options.file ?? SERVICES_COMMIT_FILE;
  const started = readCommit(file);
  if (!started) return () => undefined;
  const timer = setInterval(() => {
    const current = readCommit(file);
    if (!current || current === started) return;
    const status = worker.getStatus();
    if (status.runState !== "RUNNING" || status.numInFlightActivities > 0) return;
    clearInterval(timer);
    options.log?.(`Deployed services commit changed (${started.slice(0, 10)} -> ${current.slice(0, 10)}); restarting on the new code.`);
    process.exitCode = STALE_CODE_EXIT_CODE;
    worker.shutdown();
  }, options.intervalMs ?? 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
