import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabled: true,
  connect: vi.fn(), create: vi.fn(), run: vi.fn(),
  tracing: vi.fn(), close: vi.fn(), reload: vi.fn(), stop: vi.fn(),
  options: { interceptors: { activity: [] }, sinks: { tracing: {} } }
}));

vi.mock("@temporalio/worker", () => ({ NativeConnection: { connect: mocks.connect }, Worker: { create: mocks.create } }));
vi.mock("../src/worker-tracing.js", () => ({ createWorkerTracing: mocks.tracing }));
vi.mock("../src/deployed-code-reload.js", () => ({ reloadWhenServicesCommitChanges: mocks.reload }));
vi.mock("../src/memory-maintenance-activities.js", () => ({ maintain: vi.fn() }));
vi.mock("../src/memory-mutation-activity.js", () => ({ executePersistedMemoryChangeSet: vi.fn() }));
vi.mock("../src/memory-maintenance-config.js", () => ({
  MEMORY_MAINTENANCE_TASK_QUEUE: "maintenance", memoryMaintenanceEnabled: () => mocks.enabled,
  memoryMaintenanceWorkerOptions: { maxConcurrentActivityTaskExecutions: 2 }
}));
vi.mock("../src/memory-mutation-config.js", () => ({
  MEMORY_MUTATION_TASK_QUEUE: "mutation", memoryMutationsEnabled: () => mocks.enabled,
  memoryMutationWorkerOptions: { maxConcurrentActivityTaskExecutions: 2 }
}));

const exitCode = process.exitCode;
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.enabled = true;
  mocks.connect.mockResolvedValue({});
  mocks.create.mockResolvedValue({ run: mocks.run });
  mocks.run.mockResolvedValue(undefined);
  mocks.close.mockResolvedValue(undefined);
  mocks.tracing.mockReturnValue({ workerOptions: mocks.options, close: mocks.close });
  mocks.reload.mockReturnValue(mocks.stop);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.exitCode = exitCode;
  vi.restoreAllMocks();
});

for (const kind of ["maintenance", "mutation"] as const) {
  const load = () => kind === "maintenance"
    ? import("../src/memory-maintenance-worker.js")
    : import("../src/memory-mutation-worker.js");
  describe(`${kind} worker tracing and deploy reload wiring`, () => {
    it("registers complete tracing, watches the created worker, and cleans both on exit", async () => {
      await load();
      expect(mocks.create).toHaveBeenCalledTimes(1);
      const options = mocks.create.mock.calls[0][0];
      expect(options.interceptors).toBe(mocks.options.interceptors);
      expect(options.sinks).toBe(mocks.options.sinks);
      expect(mocks.tracing).toHaveBeenCalledWith(`space-memory-${kind}-worker`);
      expect(mocks.reload).toHaveBeenCalledWith(await mocks.create.mock.results[0].value, expect.any(Object));
      expect(mocks.run).toHaveBeenCalledTimes(1);
      expect(mocks.stop).toHaveBeenCalledTimes(1);
      expect(mocks.close).toHaveBeenCalledTimes(1);
      expect(mocks.reload.mock.invocationCallOrder[0]).toBeLessThan(mocks.run.mock.invocationCallOrder[0]);
      expect(mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(mocks.close.mock.invocationCallOrder[0]);
    });

    it("stops the watcher and closes tracing when run rejects", async () => {
      const failure = new Error("synthetic worker failure");
      mocks.run.mockRejectedValue(failure);
      if (kind === "mutation") await expect(load()).rejects.toThrow(failure);
      else { await load(); expect(process.exitCode).toBe(1); }
      expect(mocks.stop).toHaveBeenCalledTimes(1);
      expect(mocks.close).toHaveBeenCalledTimes(1);
    });

    it("closes tracing without starting a watcher when worker creation fails", async () => {
      const failure = new Error("synthetic create failure");
      mocks.create.mockRejectedValue(failure);
      if (kind === "mutation") await expect(load()).rejects.toThrow(failure);
      else { await load(); expect(process.exitCode).toBe(1); }
      expect(mocks.reload).not.toHaveBeenCalled();
      expect(mocks.stop).not.toHaveBeenCalled();
      expect(mocks.close).toHaveBeenCalledTimes(1);
    });

    it("does not connect or initialize tracing while disabled", async () => {
      mocks.enabled = false;
      await load();
      expect(mocks.connect).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.tracing).not.toHaveBeenCalled();
      expect(mocks.reload).not.toHaveBeenCalled();
    });
  });
}
