import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import {
    createCodexAppServerSocketControlService,
    type CodexAppServerSocketControlService,
    type CodexManagedStartedTurn,
    type CodexNativeThread,
} from "../../../packages/codex-app-server/src/index.js";
import { PlanExecutionController } from "../src/plan-execution-controller.js";

type ClosedStatus = "completed" | "interrupted" | "failed";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.restoreAllMocks();
});

async function fixture() {
    const store = new InMemorySpaceStore();
    const stages = [{ id: "one", order: 1, title: "First", modelId: "model-a", reasoningEffort: "high",
        instructions: "Work", completionCriteria: ["Verified"] }];
    const plan = store.upsertClipboardItem({ ownerUserId: "user:owner", source: "PLAN", text: "Plan", minimumModel: "model-a", steps: stages });
    const execution = await store.planExecutions.create({ ownerUserId: "user:owner", planId: plan.id, paneId: "pane", sessionId: "session",
        threadId: "thread", cwd: "/project", requestId: "request", snapshot: { text: plan.text, title: null, stages } });
    const thread: CodexNativeThread = { id: "thread", cwd: "/project", modelId: "model-a", reasoningEffort: "high",
        status: "idle", activeFlags: [], turns: [] };
    const dir = await mkdtemp(join(tmpdir(), "s2-order-"));
    const socketPath = join(dir, "s.sock");
    const server = createServer();
    const sockets = new WebSocketServer({ server });
    let nativeSocket: WebSocket;
    let starts = 0;
    let authorized = true;
    let handle: CodexManagedStartedTurn;
    sockets.on("connection", socket => {
        nativeSocket = socket;
        socket.on("message", raw => {
            const message = JSON.parse(raw.toString());
            if (message.method === "initialize") socket.send(JSON.stringify({ id: message.id, result: {} }));
            if (message.method === "turn/start") {
                starts++;
                thread.status = "active";
                thread.turns.push({ id: "native-turn", status: "inProgress", clientUserMessageIds: [message.params.clientUserMessageId],
                    userMessageCount: 1, itemsComplete: true, resultText: null });
                socket.send(JSON.stringify({ method: "turn/started", params: { threadId: "thread", turn: { id: "native-turn", status: "inProgress" } } }));
                socket.send(JSON.stringify({ id: message.id, result: { turn: { id: "native-turn", status: "inProgress" } } }));
            }
        });
    });
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    const native = createCodexAppServerSocketControlService({ socketPath, timeoutMs: 500 });
    const control: CodexAppServerSocketControlService = {
        listModels: async () => [{ id: "model-a", displayName: "A", isDefault: false, defaultReasoningEffort: "high", supportedReasoningEfforts: ["high"] }],
        readThread: async () => structuredClone(thread),
        readThreadSettings: async () => ({ ...thread, isTurnActive: thread.status === "active" }),
        updateThreadSettings: async input => { await input.beforeSend?.(); },
        startTurn: async () => { throw Error("Legacy start must not be used"); },
        interruptTurn: async () => { throw Error("No interruption is required"); },
        startManagedTurn: async input => { handle = await native.startManagedTurn!(input); return handle; },
    };
    const controllers: PlanExecutionController[] = [];
    const createController = () => {
        const controller = new PlanExecutionController({ repository: store.planExecutions,
            resolve: async () => { if (!authorized) throw Error("Role revoked"); return control; }, publish: async () => {},
            closedTurnObservationTimeoutMs: 100 });
        controllers.push(controller);
        return controller;
    };
    const controller = createController();
    cleanups.push(async () => {
        for (const controller of controllers) await controller.close();
        for (const socket of sockets.clients) socket.terminate();
        await new Promise<void>(resolve => sockets.close(() => resolve()));
        await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(dir, { recursive: true, force: true });
    });
    return {
        store, plan, execution, controller, createController,
        read: () => store.planExecutions.get("user:owner", execution.id),
        starts: () => starts,
        evidence: () => handle.observation.read(),
        revoke: () => { authorized = false; },
        closeHistory: (status: ClosedStatus) => {
            thread.status = "idle";
            Object.assign(thread.turns[0]!, { status, resultText: JSON.stringify({ outcome: "COMPLETED", summary: "Done",
                evidence: [{ criterion: "Verified", result: "Scoped check passed" }] }) });
        },
        notifyClosed: async (status: ClosedStatus) => {
            nativeSocket.send(JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "native-turn", status } } }));
            await expect.poll(() => handle.observation.read().status).toBe("VERIFIED");
        },
        invalidate: async () => {
            nativeSocket.terminate();
            await expect.poll(() => handle.observation.read().status).toBe("INVALID");
        },
    };
}

it.each(["completed", "interrupted", "failed"] as const)("retains healthy observation when %s history precedes its notification", async status => {
    const f = await fixture();
    await f.controller.tick();
    const commandId = (await f.read())!.pendingCommand!.id;
    f.closeHistory(status);
    expect(f.evidence().status).toBe("OBSERVING");
    await f.controller.tick();
    const waiting = (await f.read())!;
    expect(waiting.status).toBe("RUNNING");
    expect(waiting.pendingCommand).toMatchObject({ id: commandId, type: "START", turnId: "native-turn" });
    expect(waiting.attempts[0]?.actualSelection).toBeNull();
    expect(waiting.completedStageIds).toEqual([]);
    expect(f.evidence().status).toBe("OBSERVING");
    await f.notifyClosed(status);
    await f.controller.tick();
    const closed = (await f.read())!;
    expect(closed.status).toBe(status === "completed" ? "COMPLETED" : status === "interrupted" ? "PAUSED" : "BLOCKED");
    expect(closed.pendingCommand).toBeNull();
    expect(closed.attempts[0]).toMatchObject({ turnId: "native-turn", status: status === "completed" ? "COMPLETED" : status === "interrupted" ? "INTERRUPTED" : "FAILED",
        actualSelection: { source: "NATIVE_ACCEPTED_TURN_CONFIGURATION", commandId, turnId: "native-turn", providerTelemetry: false } });
    expect(closed.completedStageIds).toEqual(status === "completed" ? ["one"] : []);
    await f.controller.tick();
    expect(f.starts()).toBe(1);
});

it.each(["invalid", "missing"])("never credits closed history with %s observation continuity", async continuity => {
    const f = await fixture();
    await f.controller.tick();
    f.closeHistory("completed");
    await f.controller.tick();
    expect((await f.read())!.status).toBe("RUNNING");
    let controller = f.controller;
    if (continuity === "invalid") await f.invalidate();
    else { await controller.close(); controller = f.createController(); }
    await controller.tick();
    expect((await f.read())!.status).toBe("BLOCKED");
    expect((await f.read())!.completedStageIds).toEqual([]);
    expect((await f.read())!.attempts[0]?.actualSelection).toBeNull();
    expect(f.starts()).toBe(1);
});

it.each(["completed", "interrupted", "failed"] as const)("bounds missing %s notification only after closed history, never active work", async status => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = await fixture();
    await f.controller.tick();
    now += 24 * 60 * 60 * 1000;
    await f.controller.tick();
    expect((await f.read())!.status).toBe("RUNNING");
    expect(f.evidence().status).toBe("OBSERVING");
    f.closeHistory(status);
    await f.controller.tick();
    expect((await f.read())!.status).toBe("RUNNING");
    now += 99;
    await f.controller.tick();
    expect((await f.read())!.status).toBe("RUNNING");
    now += 1;
    await f.controller.tick();
    const blocked = (await f.read())!;
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.statusReason).toContain("notification");
    expect(blocked.pendingCommand?.type).toBe("START");
    expect(blocked.attempts[0]?.actualSelection).toBeNull();
    expect(blocked.completedStageIds).toEqual([]);
    expect(f.evidence().status).toBe("INVALID");
    expect(f.starts()).toBe(1);
});

it("rechecks authorization during deferred closed-turn reconciliation", async () => {
    const f = await fixture();
    await f.controller.tick();
    f.closeHistory("completed");
    await f.controller.tick();
    expect((await f.read())!.status).toBe("RUNNING");
    f.revoke();
    await f.notifyClosed("completed");
    await f.controller.tick();
    expect((await f.read())!.status).toBe("BLOCKED");
    expect((await f.read())!.completedStageIds).toEqual([]);
    expect(f.starts()).toBe(1);
});

it("does not credit a completed notification until matching closed history is visible", async () => {
    const f = await fixture();
    await f.controller.tick();
    await f.notifyClosed("completed");
    await f.controller.tick();
    const active = (await f.read())!;
    expect(active.status).toBe("RUNNING");
    expect(active.completedStageIds).toEqual([]);
    expect(active.attempts[0]?.actualSelection?.turnId).toBe("native-turn");
    f.closeHistory("completed");
    await f.controller.tick();
    expect((await f.read())!.status).toBe("COMPLETED");
    expect(f.starts()).toBe(1);
});
