import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminOperationRun, MaintenanceAutopilotRun } from "@space/contracts";
import { InMemorySpaceStore, SpaceConflictError } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { CliMaintenanceError } from "../src/cli-maintenance.js";
import { getApiConfig } from "../src/config.js";
import {
  MaintenanceAutopilot,
  createCliMaintenanceAutopilotSteps,
  createMemoryReliefStep,
  createStorageCleanupStep,
  nextScheduledRun,
  summarizeUpdateAll,
  type MaintenanceAutopilotSteps
} from "../src/maintenance-autopilot.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function stateFile() {
  const directory = await mkdtemp(join(tmpdir(), "maintenance-autopilot-"));
  directories.push(directory);
  return join(directory, "state.json");
}

function doneSteps(order: string[] = []): MaintenanceAutopilotSteps {
  const step = (id: string) => vi.fn(async () => {
    order.push(id);
    return { status: "DONE" as const, summary: `${id} done.` };
  });
  return { cleanup: step("cleanup"), memory: step("memory"), check: step("check"), update: step("update") };
}

describe("nextScheduledRun", () => {
  it("returns the next local hour in UTC, DST and half-hour time zones", () => {
    expect(nextScheduledRun(new Date("2026-10-11T05:00:00Z"), 4, "UTC").toISOString()).toBe("2026-10-12T04:00:00.000Z");
    expect(nextScheduledRun(new Date("2026-10-11T03:59:00Z"), 4, "UTC").toISOString()).toBe("2026-10-11T04:00:00.000Z");
    // Athens is UTC+3 until the end of October.
    expect(nextScheduledRun(new Date("2026-10-11T12:00:00Z"), 4, "Europe/Athens").toISOString()).toBe("2026-10-12T01:00:00.000Z");
    expect(nextScheduledRun(new Date("2026-10-11T12:00:00Z"), 4, "Asia/Kolkata").toISOString()).toBe("2026-10-11T22:30:00.000Z");
  });
});

describe("MaintenanceAutopilot", () => {
  it("runs the safe steps in order, persists the result and hides the actor", async () => {
    const file = await stateFile();
    const order: string[] = [];
    const finished = vi.fn(async () => undefined);
    const autopilot = new MaintenanceAutopilot({ steps: doneSteps(order), stateFile: file, defaultTimeZone: "UTC", onRunFinished: finished });
    const run = await autopilot.start("MANUAL", "user:admin");
    expect(run.status).toBe("RUNNING");
    await expect(autopilot.start("MANUAL", "user:admin")).rejects.toBeInstanceOf(SpaceConflictError);
    await autopilot.idle();
    expect(order).toEqual(["cleanup", "memory", "check", "update"]);
    const status = await autopilot.status();
    expect(status.currentRun).toBeNull();
    expect(status.lastRun).toMatchObject({ id: run.id, status: "SUCCEEDED", trigger: "MANUAL" });
    expect(status.lastRun?.steps.map((step) => step.status)).toEqual(["DONE", "DONE", "DONE", "DONE"]);
    expect(JSON.stringify(status)).not.toContain("user:admin");
    expect(finished).toHaveBeenCalledWith(expect.objectContaining({ id: run.id, status: "SUCCEEDED" }), "user:admin");
    const persisted = JSON.parse(await readFile(file, "utf8"));
    expect(persisted.lastRun.id).toBe(run.id);
    expect(persisted.currentRun).toBeNull();
  });

  it("keeps going after a failed step and reports a partial run", async () => {
    const steps = doneSteps();
    steps.memory = vi.fn(async () => { throw new Error("cache helper unavailable"); });
    steps.update = vi.fn(async () => ({ status: "SKIPPED" as const, summary: "Nothing to update." }));
    const autopilot = new MaintenanceAutopilot({ steps, stateFile: null });
    await autopilot.start("MANUAL", "user:admin");
    await autopilot.idle();
    const { lastRun } = await autopilot.status();
    expect(lastRun?.status).toBe("PARTIAL");
    expect(lastRun?.steps.find((step) => step.id === "memory")).toMatchObject({ status: "FAILED", summary: "cache helper unavailable" });
    expect(steps.check).toHaveBeenCalled();
  });

  it("reports a failed run when every step that ran failed", async () => {
    const fail = vi.fn(async () => ({ status: "FAILED" as const, summary: "Broken." }));
    const skip = vi.fn(async () => ({ status: "SKIPPED" as const, summary: "Skipped." }));
    const autopilot = new MaintenanceAutopilot({ steps: { cleanup: fail, memory: fail, check: fail, update: skip }, stateFile: null });
    await autopilot.start("MANUAL", "user:admin");
    await autopilot.idle();
    expect((await autopilot.status()).lastRun?.status).toBe("FAILED");
  });

  it("closes a run that was interrupted by a restart", async () => {
    const file = await stateFile();
    const interrupted: MaintenanceAutopilotRun = {
      id: "maintenance_interrupted",
      trigger: "SCHEDULED",
      status: "RUNNING",
      summary: "Maintenance is running.",
      steps: [
        { id: "cleanup", status: "DONE", summary: "Done.", startedAt: "2026-10-11T01:00:00.000Z", finishedAt: "2026-10-11T01:00:05.000Z" },
        { id: "memory", status: "RUNNING", summary: "Running…", startedAt: "2026-10-11T01:00:05.000Z", finishedAt: null },
        { id: "check", status: "PENDING", summary: "Waiting.", startedAt: null, finishedAt: null },
        { id: "update", status: "PENDING", summary: "Waiting.", startedAt: null, finishedAt: null }
      ],
      startedAt: "2026-10-11T01:00:00.000Z",
      finishedAt: null
    };
    await writeFile(file, JSON.stringify({ version: 1, schedule: { enabled: true, hour: 3, timeZone: "UTC", nextRunAt: null, actorUserId: "user:admin" }, currentRun: interrupted, currentActorId: "user:admin", lastRun: null }));
    const autopilot = new MaintenanceAutopilot({ steps: doneSteps(), stateFile: file, now: () => new Date("2026-10-11T09:00:00Z") });
    const status = await autopilot.status();
    expect(status.currentRun).toBeNull();
    expect(status.schedule).toEqual({ enabled: true, hour: 3, timeZone: "UTC", nextRunAt: null });
    expect(status.lastRun?.status).toBe("FAILED");
    expect(status.lastRun?.steps.map((step) => step.status)).toEqual(["DONE", "FAILED", "SKIPPED", "SKIPPED"]);
  });

  it("runs nightly at the chosen hour with the admin who enabled it, and skips a long-missed night", async () => {
    let now = new Date("2026-10-11T12:00:00Z");
    const steps = doneSteps();
    const finished = vi.fn(async () => undefined);
    const autopilot = new MaintenanceAutopilot({ steps, stateFile: null, now: () => now, onRunFinished: finished });
    const schedule = await autopilot.updateSchedule({ enabled: true, hour: 4, timeZone: "UTC" }, "user:admin");
    expect(schedule).toEqual({ enabled: true, hour: 4, timeZone: "UTC", nextRunAt: "2026-10-12T04:00:00.000Z" });

    await autopilot.tick();
    expect(steps.cleanup).not.toHaveBeenCalled();

    now = new Date("2026-10-12T04:00:30Z");
    await autopilot.tick();
    await autopilot.idle();
    expect(steps.update).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledWith(expect.objectContaining({ trigger: "SCHEDULED" }), "user:admin");
    expect((await autopilot.status()).schedule.nextRunAt).toBe("2026-10-13T04:00:00.000Z");

    now = new Date("2026-10-13T09:30:00Z");
    await autopilot.tick();
    await autopilot.idle();
    expect(steps.update).toHaveBeenCalledTimes(1);
    expect((await autopilot.status()).schedule.nextRunAt).toBe("2026-10-14T04:00:00.000Z");

    await autopilot.updateSchedule({ enabled: false }, "user:admin");
    now = new Date("2026-10-14T04:00:10Z");
    await autopilot.tick();
    expect(steps.update).toHaveBeenCalledTimes(1);
    expect((await autopilot.status()).schedule).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it("rejects an unknown time zone", async () => {
    const autopilot = new MaintenanceAutopilot({ steps: doneSteps(), stateFile: null });
    await expect(autopilot.updateSchedule({ enabled: true, timeZone: "Mars/Olympus" }, "user:admin")).rejects.toThrow(/time zone/);
  });
});

function operationRun(overrides: Partial<AdminOperationRun>): AdminOperationRun {
  return {
    id: "admin_run:plan01",
    operationType: "CLI_MAINTENANCE_PLAN",
    status: "QUEUED",
    actorUserId: "user:admin",
    summary: "Queued.",
    result: {},
    createdAt: "2026-10-11T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    updatedAt: "2026-10-11T00:00:00.000Z",
    ...overrides
  };
}

const updateAction = {
  id: "cli:codex" as const,
  label: "Codex",
  kind: "UPDATE" as const,
  reasons: ["Update available"],
  installedVersion: "1.0.0",
  targetVersion: "1.1.0",
  fingerprint: "fingerprint"
};

describe("CLI maintenance autopilot steps", () => {
  it("checks, waits for the plan and applies every recommendation with the guarded runner", async () => {
    const plan = { planId: "admin_run:plan01", scope: "enabled", actions: [updateAction], checkedAt: "2026-10-11T00:01:00.000Z" };
    const manager = {
      createPlan: vi.fn(async () => operationRun({})),
      applyPlan: vi.fn(async () => operationRun({ id: "admin_run:apply01", operationType: "CLI_MAINTENANCE_APPLY" })),
      get: vi.fn(async (id: string) => id === "admin_run:plan01"
        ? operationRun({ status: "SUCCEEDED", result: { plan, runtimes: [{}, {}] } })
        : operationRun({ id, operationType: "CLI_MAINTENANCE_APPLY", status: "SUCCEEDED" }))
    };
    const steps = createCliMaintenanceAutopilotSteps({ manager: manager as never, sleep: async () => undefined });
    const context = { actorId: "user:admin", trigger: "MANUAL" as const, plan: null };
    await expect(steps.check(context)).resolves.toEqual({ status: "DONE", summary: "1 fix found: Codex." });
    expect(manager.createPlan).toHaveBeenCalledWith({ scope: "enabled" }, "user:admin");
    await expect(steps.update(context)).resolves.toEqual({ status: "DONE", summary: "Updated and verified: Codex." });
    expect(manager.applyPlan).toHaveBeenCalledWith("admin_run:plan01", expect.objectContaining({
      selectedActionIds: ["cli:codex"],
      confirmation: "APPLY MAINTENANCE"
    }), "user:admin");
  });

  it("reports healthy tools, disabled updates and busy runners without failing", async () => {
    const healthy = { planId: "admin_run:plan01", scope: "enabled", actions: [], checkedAt: "2026-10-11T00:01:00.000Z" };
    const manager = {
      createPlan: vi.fn(async () => operationRun({ status: "SUCCEEDED", result: { plan: healthy, runtimes: [{}, {}, {}] } })),
      applyPlan: vi.fn(async () => { throw new CliMaintenanceError("CLI_MAINTENANCE_REPAIR_DISABLED", "Disabled.", 503); }),
      get: vi.fn()
    };
    const steps = createCliMaintenanceAutopilotSteps({ manager: manager as never, sleep: async () => undefined });
    const context = { actorId: "user:admin", trigger: "MANUAL" as const, plan: null as never };
    await expect(steps.check(context)).resolves.toEqual({ status: "DONE", summary: "3 tools checked. Everything is healthy and up to date." });
    await expect(steps.update(context)).resolves.toEqual({ status: "DONE", summary: "Nothing to update." });
    await expect(steps.update({ ...context, plan: { planId: "admin_run:plan01", actions: [updateAction] } }))
      .resolves.toMatchObject({ status: "SKIPPED" });
    manager.createPlan.mockRejectedValueOnce(new CliMaintenanceError("CLI_MAINTENANCE_IN_PROGRESS", "Busy.", 409));
    await expect(steps.check({ actorId: "user:admin", trigger: "MANUAL", plan: null })).resolves.toMatchObject({ status: "SKIPPED" });
    await expect(steps.update({ actorId: "user:admin", trigger: "MANUAL", plan: null })).resolves.toMatchObject({ status: "SKIPPED" });
  });

  it("stops waiting after the timeout and leaves the runner going", async () => {
    let clock = 0;
    const manager = {
      createPlan: vi.fn(async () => operationRun({ status: "RUNNING" })),
      applyPlan: vi.fn(),
      get: vi.fn(async () => operationRun({ status: "RUNNING" }))
    };
    const steps = createCliMaintenanceAutopilotSteps({
      manager: manager as never,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      checkTimeoutMs: 10_000
    });
    await expect(steps.check({ actorId: "user:admin", trigger: "MANUAL", plan: null })).rejects.toThrow(/continues in the background/);
  });
});

function updateAllRuntime(key: string, displayName: string, overrides: Record<string, unknown> = {}) {
  return {
    runtimeId: `cli:${key}` as const,
    displayName,
    installedVersion: "1.0.0",
    availableVersion: "1.1.0",
    status: "PASS" as const,
    code: "UPDATED",
    summary: `${displayName} updated.`,
    checks: [],
    customPreserved: true,
    customReinstalled: true,
    ...overrides
  };
}

function detectionEntry(key: string, overrides: Record<string, unknown> = {}) {
  return { key, cliType: `cli:${key}`, displayName: key, managed: true, updateKind: "npm", enabled: true, hasCustom: false, custom: [], installedVersion: "1.0.0", availableVersion: "1.0.0", updateAvailable: false, ...overrides };
}

describe("custom-aware update step", () => {
  const repairAction = { ...updateAction, id: "cli:claude" as const, label: "Claude Code CLI", kind: "REPAIR" as const };
  const geminiAction = { ...updateAction, id: "cli:gemini" as const, label: "Gemini CLI" };

  it("sends repairs through the reviewed plan and every pending update through the custom-aware engine with re-apply on", async () => {
    const manager = {
      createPlan: vi.fn(),
      applyPlan: vi.fn(async () => operationRun({ id: "admin_run:apply01", operationType: "CLI_MAINTENANCE_APPLY", status: "SUCCEEDED" })),
      get: vi.fn()
    };
    const updateAll = {
      detect: vi.fn(async () => ({
        schemaVersion: "space.cli-update-all.detection.v1" as const,
        detectedAt: "2026-10-12T00:00:00.000Z",
        cliTypes: [
          detectionEntry("gemini", { updateAvailable: true, availableVersion: "1.3.3", installedVersion: "1.3.1" }),
          detectionEntry("qwen", { updateAvailable: true, installedVersion: "0.23.2-space.1", availableVersion: "0.24.0-space.1", hasCustom: true }),
          detectionEntry("claude", { updateAvailable: true }),
          detectionEntry("cursor", { updateAvailable: true, installedVersion: null }),
          detectionEntry("hermes", { managed: false, updateAvailable: true })
        ]
      })),
      updateAll: vi.fn(async () => ({
        mode: "UPDATE_ALL" as const,
        overallStatus: "PASS" as const,
        scope: ["gemini", "qwen"],
        reinstall: true,
        runtimes: [
          updateAllRuntime("gemini", "Gemini CLI", { installedVersion: "1.3.1", availableVersion: "1.3.3", customPreserved: true }),
          updateAllRuntime("qwen", "Qwen Code CLI", { installedVersion: "0.23.2-space.1", availableVersion: "0.24.0-space.1" })
        ],
        customSummary: [{ key: "gemini", hasCustom: true, custom: [] }, { key: "qwen", hasCustom: true, custom: [] }],
        startedAt: null,
        finishedAt: "2026-10-12T00:05:00.000Z"
      }))
    };
    const audited = vi.fn(async () => undefined);
    const steps = createCliMaintenanceAutopilotSteps({ manager: manager as never, updateAll: updateAll as never, onUpdateAll: audited, sleep: async () => undefined });
    const outcome = await steps.update({ actorId: "user:admin", trigger: "SCHEDULED", plan: { planId: "admin_run:plan01", actions: [repairAction, geminiAction] } });
    expect(manager.applyPlan).toHaveBeenCalledWith("admin_run:plan01", expect.objectContaining({ selectedActionIds: ["cli:claude"] }), "user:admin");
    // Claude is repaired through the plan, never twice; unmanaged and uninstalled types are not touched.
    expect(updateAll.updateAll).toHaveBeenCalledWith({ keys: ["gemini", "qwen"], reinstall: true });
    expect(audited).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      status: "DONE",
      summary: "Repaired: Claude Code CLI. Updated Gemini CLI 1.3.1 → 1.3.3, Qwen Code CLI 0.23.2-space.1 → 0.24.0-space.1. Custom code verified and Space settings re-applied for 2 CLIs."
    });
  });

  it("reports nothing to do, rolled-back failures and custom-code problems honestly", async () => {
    const manager = { createPlan: vi.fn(), applyPlan: vi.fn(), get: vi.fn() };
    const detection = { schemaVersion: "space.cli-update-all.detection.v1" as const, detectedAt: "2026-10-12T00:00:00.000Z", cliTypes: [detectionEntry("codex")] };
    const updateAll = { detect: vi.fn(async () => detection), updateAll: vi.fn() };
    const steps = createCliMaintenanceAutopilotSteps({ manager: manager as never, updateAll: updateAll as never });
    const context = { actorId: "user:admin", trigger: "MANUAL" as const, plan: { planId: "admin_run:plan01", actions: [] } };
    await expect(steps.update(context)).resolves.toEqual({ status: "DONE", summary: "Every CLI is up to date. Nothing to update." });
    expect(updateAll.updateAll).not.toHaveBeenCalled();

    expect(summarizeUpdateAll({
      mode: "UPDATE_ALL", overallStatus: "FAIL", scope: ["deepseek", "autohand"], reinstall: true, startedAt: null, finishedAt: "2026-10-12T00:05:00.000Z",
      customSummary: [{ key: "autohand", hasCustom: true, custom: [] }],
      runtimes: [
        updateAllRuntime("deepseek", "DeepSeek CLI", { status: "FAIL", code: "UPDATE_FAILED_ROLLED_BACK", customPreserved: false }),
        updateAllRuntime("autohand", "Autohand Code CLI", { status: "FAIL", code: "CUSTOM_PRESERVATION_FAILED" })
      ]
    })).toEqual({
      status: "FAILED",
      summary: "DeepSeek CLI not updated; the previous version was kept (UPDATE_FAILED_ROLLED_BACK). Custom code needs attention for Autohand Code CLI: a tracked custom procedure changed or could not be re-applied. Open Update all CLIs for details."
    });
  });
});

describe("maintenance run redaction", () => {
  it("keeps every runtime row of an eleven-CLI result readable", async () => {
    const store = new InMemorySpaceStore();
    const { CliMaintenanceManager } = await import("../src/cli-maintenance.js");
    const manager = new CliMaintenanceManager({ store, dispatcher: { dispatch: async () => undefined } });
    const keys = ["codex", "claude", "gemini", "opencode", "autohand", "qwen", "kimi", "grok", "deepseek", "cursor", "copilot"];
    const checks = Array.from({ length: 8 }, (_, index) => ({ name: `check ${index}`, status: "PASS", code: "CHECK_PASSED", summary: "A long enough check summary to use the shared redaction budget quickly.", durationMs: 12 }));
    const run = await store.createAdminOperationRun({ operationType: "CLI_MAINTENANCE_PLAN", actorUserId: "user:admin", summary: "Checked." , result: {
      scope: "enabled",
      plan: { planId: "admin_run:plan01", scope: "enabled", checkedAt: "2026-10-12T00:00:00.000Z", actions: [] },
      space: { status: "PASS", code: "SPACE_HEALTHY", summary: "Space is healthy.", checks },
      runtimes: keys.map((key) => ({ runtimeId: `cli:${key}`, displayName: `${key} CLI`, installedVersion: "1.0.0", availableVersion: "1.0.0", status: "PASS", code: "HEALTHY", summary: "Healthy and current.", checks }))
    } });
    const redacted = await manager.get(run.id);
    const runtimes = redacted.result.runtimes as Array<Record<string, unknown>>;
    expect(runtimes).toHaveLength(11);
    expect(runtimes.every((runtime) => runtime && typeof runtime.displayName === "string" && runtime.summary === "Healthy and current.")).toBe(true);
    expect(runtimes.every((runtime) => !("checks" in runtime))).toBe(true);
    expect((redacted.result.plan as { planId: string }).planId).toBe("admin_run:plan01");
  });
});

const cleanupResult = {
  status: "COMPLETED" as const,
  previewId: "11111111-1111-4111-8111-111111111111",
  cleaned: {
    opencode: { sessions: 2, newSessionSessions: 0, emptySessions: 2, mappingFiles: 0 },
    opencodeTmp: { entries: 0, bytes: 0 },
    codex: { threads: 1, indexEntries: 1, rolloutFiles: 1, shellSnapshots: 0 },
    codexOrphans: { rolloutFiles: 0, bytes: 0 },
    codexPaneHomes: { dirs: 0, bytes: 0 },
    cliStores: []
  },
  totalBytes: 3 * 1024 * 1024,
  failures: [],
  completedAt: "2026-10-11T00:00:00.000Z"
};

describe("storage and memory steps", () => {
  it("previews and cleans only when there is something to remove", async () => {
    const service = {
      preview: vi.fn(async () => ({ status: "READY", previewId: cleanupResult.previewId })),
      execute: vi.fn(async () => cleanupResult)
    };
    const audit = vi.fn(async () => undefined);
    const step = createStorageCleanupStep({
      anyCliEnabled: async () => true,
      withExclusive: (operation) => operation(),
      protectedThreadIds: async () => ["thread-open"],
      codexEnabled: async () => true,
      service: service as never,
      audit
    });
    const context = { actorId: "user:admin", trigger: "MANUAL" as const, plan: null };
    await expect(step(context)).resolves.toEqual({ status: "DONE", summary: "3 empty sessions removed · 3.0 MB freed." });
    expect(service.execute).toHaveBeenCalledWith(expect.objectContaining({ protectedThreadIds: ["thread-open"], previewId: cleanupResult.previewId }));
    expect(audit).toHaveBeenCalledTimes(1);

    service.preview.mockResolvedValueOnce({ status: "NOOP", previewId: cleanupResult.previewId });
    await expect(step(context)).resolves.toEqual({ status: "DONE", summary: "Already clean. Nothing to remove." });
    expect(service.execute).toHaveBeenCalledTimes(1);
  });

  it("releases page cache only under pressure and never takes the lock twice", async () => {
    let locked = false;
    const reclaim = vi.fn(async () => ({ status: "CLEARED", reclaimedBytes: 512 * 1024 * 1024, message: null }));
    const memory = (isUnderPressure: boolean) => ({
      memory: { totalBytes: 100, usedBytes: 90, availableBytes: 10, usagePercent: isUnderPressure ? 91.2 : 40, pageCacheBytes: 0, reclaimableBytes: 1024 * 1024 * 1024 },
      swap: { totalBytes: 0, usedBytes: 0, usagePercent: 0 },
      pressure: { isUnderPressure, availablePercent: 9, canDropPageCache: true },
      topProcesses: [],
      topCpuProcesses: [],
      sampledAt: "2026-10-11T00:00:00.000Z"
    });
    let pressure = false;
    const step = createMemoryReliefStep({
      acquire: () => { if (locked) return false; locked = true; return true; },
      release: () => { locked = false; },
      readMemory: async () => memory(pressure) as never,
      reclaimPageCache: reclaim,
      minimumReclaimBytes: 256 * 1024 * 1024,
      audit: async () => undefined
    });
    const context = { actorId: "user:admin", trigger: "SCHEDULED" as const, plan: null };
    await expect(step(context)).resolves.toEqual({ status: "DONE", summary: "Memory is healthy (40% used)." });
    expect(reclaim).not.toHaveBeenCalled();
    pressure = true;
    await expect(step(context)).resolves.toEqual({ status: "DONE", summary: "Released 512.0 MB of cache (was 91% used)." });
    expect(locked).toBe(false);
    locked = true;
    await expect(step(context)).resolves.toMatchObject({ status: "SKIPPED" });
  });

  it("stops leftover CLIs of closed panes first and reports partial stops", async () => {
    const audit = vi.fn(async () => undefined);
    const stop = vi.fn(async () => ({ status: "COMPLETED", killedSessionIds: ["cli_session:left1", "cli_session:left2"], estimatedReclaimedBytes: 2 * 1024 * 1024 }));
    const healthy = {
      memory: { totalBytes: 100, usedBytes: 40, availableBytes: 60, usagePercent: 40, pageCacheBytes: 0, reclaimableBytes: 0 },
      swap: { totalBytes: 0, usedBytes: 0, usagePercent: 0 },
      pressure: { isUnderPressure: false, availablePercent: 60, canDropPageCache: false },
      topProcesses: [],
      topCpuProcesses: [],
      sampledAt: "2026-10-11T00:00:00.000Z"
    };
    const reclaim = vi.fn();
    const step = createMemoryReliefStep({
      acquire: () => true,
      release: () => undefined,
      readMemory: async () => healthy as never,
      stopClosedPaneClis: stop,
      reclaimPageCache: reclaim,
      minimumReclaimBytes: 256 * 1024 * 1024,
      audit
    });
    const context = { actorId: "user:admin", trigger: "SCHEDULED" as const, plan: null };
    await expect(step(context)).resolves.toEqual({
      status: "DONE",
      summary: "Stopped 2 leftover CLIs of closed panes (2.0 MB). Memory is healthy (40% used)."
    });
    expect(audit).toHaveBeenCalledWith({ status: "SKIPPED_LOW_PRESSURE", reclaimedBytes: 0, stoppedCliCount: 2 }, "user:admin");
    expect(reclaim).not.toHaveBeenCalled();
    stop.mockResolvedValueOnce({ status: "PARTIAL", killedSessionIds: [], estimatedReclaimedBytes: 0 });
    await expect(step(context)).resolves.toEqual({
      status: "WARNING",
      summary: "Memory is healthy (40% used). Some leftover CLIs could not be stopped."
    });
  });
});

describe("maintenance autopilot routes", () => {
  const sessionSecret = "maintenance-autopilot-secret";
  function headers(role: "OPERATOR" | "ADMIN") {
    const session = signSession({ id: `user:${role.toLowerCase()}`, email: `${role.toLowerCase()}@space.local`, role }, sessionSecret);
    return { cookie: `space_session=${session}`, "x-space-csrf-token": createCsrfToken(session, sessionSecret)! };
  }

  it("lets only ADMIN read, run and schedule maintenance", async () => {
    const steps = doneSteps();
    const autopilot = new MaintenanceAutopilot({ steps, stateFile: null, defaultTimeZone: "UTC" });
    const app = await createApp({
      store: new InMemorySpaceStore(),
      config: getApiConfig({}),
      auth: { sessionSecret, devLogin: false, secureCookies: false },
      maintenanceAutopilot: autopilot
    });
    try {
      expect((await app.inject({ method: "GET", url: "/api/admin/maintenance-autopilot", headers: headers("OPERATOR") })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/api/admin/maintenance-autopilot/runs", headers: headers("OPERATOR"), payload: {} })).statusCode).toBe(403);

      const status = await app.inject({ method: "GET", url: "/api/admin/maintenance-autopilot", headers: headers("ADMIN") });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({ schedule: { enabled: false, hour: 4, timeZone: "UTC" }, currentRun: null, lastRun: null });

      const started = await app.inject({ method: "POST", url: "/api/admin/maintenance-autopilot/runs", headers: headers("ADMIN"), payload: {} });
      expect(started.statusCode).toBe(202);
      const startedBody = started.json();
      expect((startedBody.currentRun ?? startedBody.lastRun).steps).toHaveLength(4);
      await autopilot.idle();
      expect(steps.update).toHaveBeenCalledWith(expect.objectContaining({ actorId: "user:admin", trigger: "MANUAL" }));

      const scheduled = await app.inject({
        method: "PUT",
        url: "/api/admin/maintenance-autopilot/schedule",
        headers: headers("ADMIN"),
        payload: { enabled: true, hour: 3, timeZone: "Europe/Athens" }
      });
      expect(scheduled.statusCode).toBe(200);
      expect(scheduled.json().schedule).toMatchObject({ enabled: true, hour: 3, timeZone: "Europe/Athens" });
      expect(scheduled.json().lastRun.status).toBe("SUCCEEDED");

      const invalid = await app.inject({
        method: "PUT",
        url: "/api/admin/maintenance-autopilot/schedule",
        headers: headers("ADMIN"),
        payload: { enabled: true, timeZone: "Mars/Olympus" }
      });
      expect(invalid.statusCode).toBe(422);
    } finally {
      await app.close();
    }
  }, 60_000);
});
