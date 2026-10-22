import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reloadWhenServicesCommitChanges, STALE_CODE_EXIT_CODE } from "../src/deployed-code-reload.js";

function fakeWorker(numInFlightActivities = 0) {
  const status = { runState: "RUNNING", numInFlightActivities };
  return { status, worker: { getStatus: vi.fn(() => status as never), shutdown: vi.fn() } };
}

describe("memory workers reload when the deploy changes their code", () => {
  afterEach(() => {
    vi.useRealTimers();
    process.exitCode = undefined;
  });

  it("shuts down idle with a failure exit code once the services commit changes, never mid-activity", () => {
    vi.useFakeTimers();
    const file = join(mkdtempSync(join(tmpdir(), "space-reload-")), "services-commit");
    writeFileSync(file, "aaaa\n");
    const { status, worker } = fakeWorker(1);
    reloadWhenServicesCommitChanges(worker, { file, intervalMs: 1_000 });

    vi.advanceTimersByTime(3_000);
    expect(worker.shutdown).not.toHaveBeenCalled();

    writeFileSync(file, "bbbb\n");
    vi.advanceTimersByTime(1_000);
    expect(worker.shutdown).not.toHaveBeenCalled();

    status.numInFlightActivities = 0;
    vi.advanceTimersByTime(1_000);
    expect(worker.shutdown).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(STALE_CODE_EXIT_CODE);
    vi.advanceTimersByTime(5_000);
    expect(worker.shutdown).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a recorded services commit", () => {
    vi.useFakeTimers();
    const { worker } = fakeWorker();
    reloadWhenServicesCommitChanges(worker, { file: join(tmpdir(), "space-reload-missing", "services-commit"), intervalMs: 1_000 });
    vi.advanceTimersByTime(5_000);
    expect(worker.getStatus).not.toHaveBeenCalled();
    expect(worker.shutdown).not.toHaveBeenCalled();
  });
});
