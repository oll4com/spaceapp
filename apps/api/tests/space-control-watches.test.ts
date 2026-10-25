import { describe, it, expect, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { InMemoryControlRepository } from "@space/db";
import { controlExecuteSchema, controlToolSchemas, type ControlWatch } from "@space/contracts";
import { createSpaceControl } from "../src/space-control.js";

const actor = { id: "operator:one", role: "ADMIN" as const };
const nonAdminActor = { id: "user:regular", role: "USER" as const };

function fixture() {
  const store = new InMemorySpaceStore();
  const repository = new InMemoryControlRepository();
  const room = store.createRoom({ name: "Watch test room", initialPaneCount: 0, kind: "AGENT_PROOF" });
  const panes = store.createPanes([
    { roomId: room.id, title: "Worker Pane", mode: "TERMINAL" as const, terminalRuntimeId: "cli:gemini" },
    { roomId: room.id, title: "Secondary Pane", mode: "TERMINAL" as const, terminalRuntimeId: "cli:codex" }
  ]);

  let taskSequence = 123;
  let paneState: "RUNNING" | "IDLE" | "ERROR" | "EXITED" = "RUNNING";
  let paneText = "Working on task...";
  let taskStatus: "RUNNING" | "COMPLETED" | "FAILED" | "INTERRUPTED" = "RUNNING";

  const observation = (pane: any) => ({
    paneId: pane.id,
    title: pane.title,
    runtimeId: pane.terminalRuntimeId,
    sessionId: `session:${pane.id}`,
    state: paneState,
    nativeTaskRef: `task:${pane.id}:123`,
    modelId: "gemini-2.5-flash",
    nativeMode: "default",
    checkedAt: new Date().toISOString(),
    tasks: [
      {
        taskId: `task:${pane.id}:${taskSequence}`,
        title: pane.title,
        status: taskStatus,
        timing: { startedAt: new Date().toISOString(), completedAt: null, durationMs: null, source: "OBSERVED" as const, observedAt: new Date().toISOString() },
        modelsUsed: [{ providerId: null, modelId: "gemini-2.5-flash", reasoningEffort: null, turnId: null, startedAt: null, completedAt: null, source: "OBSERVED" as const }]
      }
    ],
    text: paneText
  });

  const controller = {
    catalog: vi.fn(async () => ({ types: [], unavailable: [] })),
    inspect: vi.fn(async (p: any) => observation(p)),
    configure: vi.fn(async () => ({})),
    command: vi.fn(async () => ({})),
    start: vi.fn(async () => ({})),
    resume: vi.fn(async () => ({})),
    interrupt: vi.fn(async () => ({}))
  };

  const sentPrompts: Array<{ paneId: string; text: string; traceId: string }> = [];
  const send = vi.fn(async (pane: any, text: string, traceId: string) => {
    sentPrompts.push({ paneId: pane.id, text, traceId });
    taskSequence++;
    return { submitted: true, traceId, turnId: `task:${pane.id}:${taskSequence}` };
  });

  const options = {
    store,
    repository,
    controller,
    phase: 2 as const,
    send,
    publish: vi.fn(async () => {}),
    resolveActor: vi.fn(async (id: string) => (id === actor.id ? actor : nonAdminActor))
  };

  const service = createSpaceControl(options);

  return {
    store,
    repository,
    controller,
    send,
    sentPrompts,
    options,
    service,
    room,
    panes,
    setPaneState: (s: typeof paneState) => { paneState = s; },
    setPaneText: (t: string) => { paneText = t; },
    setTaskStatus: (ts: typeof taskStatus) => { taskStatus = ts; }
  };
}

describe("Space Control Watches - Agent Task Monitoring & Re-engagement", () => {
  it("successfully registers, advances on native completion, runs verification, and delivers verified status", async () => {
    const c = fixture();

    // 1. Register watch while pane is RUNNING
    const registered = await c.service.watches(actor, c.room.id, "register", {
      paneId: c.panes[0]!.id,
      timeoutMs: 60000,
      maxRetries: 1,
      verificationPrompt: "Run verification checks"
    });
    expect(registered.status).toBe("RUNNING");
    expect(registered.paneId).toBe(c.panes[0]!.id);
    expect(registered.auditTrail.length).toBeGreaterThanOrEqual(1);

    // 2. Pane is still RUNNING -> tick() maintains RUNNING
    await c.service.tick();
    let status = await c.service.watches(actor, c.room.id, "status", { id: registered.id });
    expect(status.status).toBe("RUNNING");

    // 3. Pane completes primary task
    c.setPaneState("IDLE");
    c.setTaskStatus("COMPLETED");
    c.setPaneText("Finished task implementation cleanly.");

    // Advance tick -> triggers verification
    await c.service.tick();
    status = await c.service.watches(actor, c.room.id, "status", { id: registered.id });
    expect(status.status).toBe("VERIFYING");
    expect(c.sentPrompts).toHaveLength(1);
    expect(c.sentPrompts[0]!.text).toBe("Run verification checks");

    // 4. Verification completes cleanly
    c.setPaneText("Verification tests passed: 10/10 green.");
    await c.service.tick();
    status = await c.service.watches(actor, c.room.id, "status", { id: registered.id });
    expect(status.status).toBe("VERIFIED");
    expect(status.voiceDelivery.queued).toBe(true);

    // 5. Delivery to live assistant via pendingWatches & acknowledgment
    const pending = await c.service.pendingWatches(actor, c.room.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(registered.id);

    // Acknowledge delivery
    const ack = await c.service.watches(actor, c.room.id, "ack", { id: registered.id });
    expect(ack.voiceDelivery.acknowledged).toBe(true);

    const pendingAfterAck = await c.service.pendingWatches(actor, c.room.id);
    expect(pendingAfterAck).toHaveLength(0);
  });

  it("handles failure with bounded retry ceiling: 1 remediation attempt before transitioning to FAILED", async () => {
    const c = fixture();

    // Register with maxRetries: 1 and remediationPrompt
    const registered = await c.service.watches(actor, c.room.id, "register", {
      paneId: c.panes[0]!.id,
      timeoutMs: 60000,
      maxRetries: 1,
      remediationPrompt: "Fix the syntax error and re-run tests"
    });

    // Task finishes with failure
    c.setPaneState("IDLE");
    c.setTaskStatus("FAILED");
    c.setPaneText("Error: Process exited with error code 1");

    // First failure triggers remediation retry 1
    await c.service.tick();
    let status = await c.service.watches(actor, c.room.id, "status", { id: registered.id });
    expect(status.status).toBe("RUNNING");
    expect(status.retriesCount).toBe(1);
    expect(c.sentPrompts).toHaveLength(1);
    expect(c.sentPrompts[0]!.text).toBe("Fix the syntax error and re-run tests");

    // Second failure exceeds maxRetries (1) -> settles as FAILED (no false success)
    c.setPaneText("Fatal error: Unresolvable dependency collision");
    await c.service.tick();
    status = await c.service.watches(actor, c.room.id, "status", { id: registered.id });
    expect(status.status).toBe("FAILED");
    expect(status.retriesCount).toBe(1);
    expect(c.sentPrompts).toHaveLength(1); // No further prompts sent! Retry ceiling respected.
    expect(status.voiceDelivery.queued).toBe(true);
  });

  it("handles operator cancellation and pane closure", async () => {
    const c = fixture();

    const registered = await c.service.watches(actor, c.room.id, "register", {
      paneId: c.panes[0]!.id
    });
    expect(registered.status).toBe("RUNNING");

    // Cancel explicitly
    const cancelled = await c.service.watches(actor, c.room.id, "cancel", { id: registered.id });
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.reason).toBe("Watch cancelled by operator.");

    // Second watch: test pane close cancellation
    const watch2 = await c.service.watches(actor, c.room.id, "register", {
      paneId: c.panes[1]!.id
    });
    c.store.updatePane(c.panes[1]!.id, { isClosed: true, status: "CLOSED" });
    await c.service.tick();
    const status2 = await c.service.watches(actor, c.room.id, "status", { id: watch2.id });
    expect(status2.status).toBe("CANCELLED");
    expect(status2.reason).toBe("Target pane was closed.");
  });

  it("rejects a fabricated task identity", async () => {
    const c = fixture();
    await expect(c.service.watches(actor, c.room.id, "register", {
      paneId: c.panes[0]!.id, targetTaskRef: "target-task-999"
    })).rejects.toThrow("not observed");
  });

  it("does not confuse an idle pane with completed work", async () => {
    const c = fixture();
    const w = await c.service.watches(actor, c.room.id, "register", { paneId: c.panes[0]!.id });
    c.setPaneState("IDLE");
    await c.service.tick();
    expect((await c.service.watches(actor, c.room.id, "status", { id: w.id })).status).toBe("RUNNING");
  });

  it("observes a task that completed before registration and deduplicates active watches", async () => {
    const c = fixture();
    c.setPaneState("IDLE"); c.setTaskStatus("COMPLETED");
    const w = await c.service.watches(actor, c.room.id, "register", { paneId: c.panes[0]!.id });
    const same = await c.service.watches(actor, c.room.id, "register", { paneId: c.panes[0]!.id });
    expect(same.id).toBe(w.id);
    await c.service.tick();
    expect((await c.service.watches(actor, c.room.id, "status", { id: w.id })).status).toBe("VERIFIED");
  });

  it("survives restart recovery without replaying already-settled actions", async () => {
    const c = fixture();

    const registered = await c.service.watches(actor, c.room.id, "register", {
      paneId: c.panes[0]!.id,
      verificationPrompt: "Verify"
    });

    // Simulate restart by creating new service instance sharing same repository and store
    const restarted = createSpaceControl(c.options);
    const status = await restarted.watches(actor, c.room.id, "status", { id: registered.id });
    expect(status.id).toBe(registered.id);
    expect(status.status).toBe("RUNNING");

    // Complete on restarted instance
    c.setPaneState("IDLE");
    c.setTaskStatus("COMPLETED");
    c.setPaneText("Verified clean.");
    await restarted.tick();
    const verifying = await restarted.watches(actor, c.room.id, "status", { id: registered.id });
    expect(verifying.status).toBe("VERIFYING");
  });

  it("enforces strict authorization boundaries (non-admin or foreign room rejected)", async () => {
    const c = fixture();

    // Foreign room
    const foreignRoom = c.store.createRoom({ name: "Foreign room" });
    await expect(
      c.service.watches(actor, foreignRoom.id, "register", { paneId: c.panes[0]!.id })
    ).rejects.toThrow("Pane belongs to another room.");

    // Execution via space_execute with kind 'watch'
    const execResult = await c.service.execute(
      actor,
      controlExecuteSchema.parse({
        roomId: c.room.id,
        requestId: "watch_exec_1",
        actions: [
          {
            kind: "watch",
            operation: "register",
            paneId: c.panes[0]!.id,
            timeoutMs: 30000
          }
        ]
      })
    );
    expect(execResult.status).toBe("COMPLETED");
    expect(execResult.results[0]!.status).toBe("COMPLETED");
  });

  it("times out cleanly when task exceeds timeoutMs", async () => {
    const c = fixture();

    const registered = await c.service.watches(actor, c.room.id, "register", {
      paneId: c.panes[0]!.id,
      timeoutMs: 1000 // 1 second timeout
    });

    // Manually backdate createdAt to test timeout
    const record = (await c.repository.get("watch", actor.id, registered.id))!;
    await c.repository.write(
      {
        ...record,
        value: {
          ...registered,
          createdAt: new Date(Date.now() - 5000).toISOString()
        }
      },
      record.version
    );

    await c.service.tick();
    const status = await c.service.watches(actor, c.room.id, "status", { id: registered.id });
    expect(status.status).toBe("FAILED");
    expect(status.taskState).toBe("TIMED_OUT");
    expect(status.voiceDelivery.queued).toBe(true);
  });

  it("populates full paneDetails upon task completion for live audio delivery", async () => {
    const c = fixture();
    const registered = await c.service.watches(actor, c.room.id, "register", {
      paneId: c.panes[0]!.id,
      timeoutMs: 60000
    });

    c.setPaneState("IDLE");
    c.setTaskStatus("COMPLETED");
    c.setPaneText("Build finished successfully with 0 errors.\nServer listening on port 4910.");

    await c.service.tick();
    const status = await c.service.watches(actor, c.room.id, "status", { id: registered.id });
    expect(status.status).toBe("VERIFIED");
    expect(status.voiceDelivery.queued).toBe(true);
    expect(status.paneDetails).toBeDefined();
    expect(status.paneDetails?.paneId).toBe(c.panes[0]!.id);
    expect(status.paneDetails?.title).toBe(c.panes[0]!.title);
    expect(status.paneDetails?.runtimeId).toBe("cli:gemini");
    expect(status.paneDetails?.modelId).toBe("gemini-2.5-flash");
    expect(status.paneDetails?.status).toBe("VERIFIED");
    expect(status.paneDetails?.lastOutput).toContain("Build finished successfully");
    expect(status.paneDetails?.durationMs).toBeGreaterThanOrEqual(1);
  });

  it("automatically registers an MCP watch when prompt is dispatched to a pane", async () => {
    const c = fixture();
    c.setPaneState("IDLE");

    const execResult = await c.service.execute(actor, {
      roomId: c.room.id,
      requestId: "prompt_test_req_1",
      actions: [
        {
          kind: "pane",
          operation: "prompt",
          target: { paneIds: [c.panes[0]!.id], state: "ALL" },
          text: "echo Hello from live prompt",
          when: "NOW"
        }
      ]
    });

    expect(execResult.status).toBe("COMPLETED");
    expect(execResult.results[0]!.status).toBe("COMPLETED");
    expect(execResult.results[0]!.evidence?.result).toHaveProperty("watchId");

    // Verify auto-registered watch exists and is in RUNNING status
    const watches = await c.service.watches(actor, c.room.id, "list", {});
    const promptWatch = watches.find((w: any) => w.paneId === c.panes[0]!.id);
    expect(promptWatch).toBeDefined();
    expect(promptWatch.status).toBe("RUNNING");
    expect(promptWatch.taskState).toBe("RUNNING");

    // When the prompt finishes executing:
    c.setPaneState("IDLE");
    c.setTaskStatus("COMPLETED");
    c.setPaneText("Hello from live prompt\nTask complete.");

    await c.service.tick();

    const completedWatch = await c.service.watches(actor, c.room.id, "status", { id: promptWatch.id });
    expect(completedWatch.status).toBe("VERIFIED");
    expect(completedWatch.voiceDelivery.queued).toBe(true);
    expect(completedWatch.paneDetails).toBeDefined();
    expect(completedWatch.paneDetails?.lastOutput).toContain("Hello from live prompt");
  });
});
