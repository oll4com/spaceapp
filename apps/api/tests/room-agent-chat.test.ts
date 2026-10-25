import { afterEach, describe, expect, it, vi } from "vitest";
import { PANE_CATALOG_VERSION, type ControlOperation, type Event } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createRoomAgentService } from "../src/room-agent.js";
import {
  buildRoomAgentChatMessages, ChatCompletionSseParser, createRoomAgentChat, roomAgentTimeline,
  type ChatStreamChunk, type RoomAgentChatBody, type RoomAgentChatModel
} from "../src/room-agent-chat.js";
import { createRoomAgentTools, type RoomAgentToolDeps } from "../src/room-agent-tools.js";
import type { AdvancedMissionModelSelection } from "../src/room-agent-model-resolver.js";

type Step = ChatStreamChunk[] | ((body: RoomAgentChatBody, signal: AbortSignal) => ChatStreamChunk[] | Promise<ChatStreamChunk[]>);

function scriptedModel(steps: Step[], supportsTools = true) {
  const bodies: RoomAgentChatBody[] = [];
  const model: RoomAgentChatModel & { bodies: RoomAgentChatBody[] } = {
    supportsTools,
    bodies,
    async *stream(body, signal) {
      bodies.push(structuredClone(body));
      const step = steps.shift() ?? [{ content: "Done." }];
      const chunks = typeof step === "function" ? await step(body, signal) : step;
      for (const chunk of chunks) yield chunk;
    }
  };
  return model;
}

function toolCall(name: string, args: Record<string, unknown>, id = `call_${name}`): ChatStreamChunk[] {
  return [{ toolCalls: [{ index: 0, id, name, arguments: JSON.stringify(args) }] }, { finishReason: "tool_calls" }];
}

/** A step that writes some text and then waits until the turn is stopped. */
function blockingStep(text: string, release?: Promise<void>): Step {
  return async (_body, signal) => {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      void release?.then(resolve);
    });
    return [{ content: text }];
  };
}

const selection = (tier: AdvancedMissionModelSelection["tier"]): AdvancedMissionModelSelection => tier === "CODEX"
  ? { providerId: null, modelId: "gpt-5.6-sol", reasoningEffort: "high", providerName: null, modelName: "GPT-5.6 Sol", tier }
  : { providerId: "cli:opencode", modelId: "opencode/big-pickle", reasoningEffort: null, providerName: "OpenCode", modelName: "Big Pickle", tier };

function completedOperation(command: { roomId: string; requestId: string }, detail: string): ControlOperation {
  const at = new Date().toISOString();
  return { id: `operation:${command.requestId}`, actorId: "user:operator", roomId: command.roomId, requestId: command.requestId, payloadHash: "hash",
    status: "COMPLETED", createdAt: at, updatedAt: at, results: [{ index: 0, status: "COMPLETED", detail, evidence: {} }], cancelRequested: false, nextIndex: 1 };
}

const actor = { holderType: "OPERATOR", holderId: "user:operator" } as const;

function fixture(options: { steps?: Step[]; tier?: AdvancedMissionModelSelection["tier"]; textModel?: RoomAgentChatModel; tools?: Partial<RoomAgentToolDeps>; chatAllowed?: (roomId: string) => Promise<boolean> } = {}) {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Room Agent chat", initialPaneCount: 2 });
  const [andy, bob] = store.listPanes(room.id);
  const published: Event[] = [];
  const model = scriptedModel(options.steps ?? []);
  const toolDeps: RoomAgentToolDeps = {
    listPanes: async (roomId) => store.listPanes(roomId, true),
    describeRoom: async () => "Room activity: 2 open panes.",
    inspectPane: vi.fn(async (pane) => ({ paneId: pane.id, title: pane.title, runtimeId: null, sessionId: null, state: "IDLE" as const, nativeTaskRef: null,
      modelId: null, nativeMode: null, checkedAt: new Date().toISOString(), tasks: [], text: "ready" })),
    interruptPane: vi.fn(async () => ({ interrupted: true })),
    answerCli: vi.fn(async () => ({})),
    controlExecute: vi.fn(async (_actorId, command) => completedOperation(command, "Done.")),
    controlCall: vi.fn(async () => ({ ok: true })),
    openPanes: vi.fn(async () => ["Cody"]),
    search: vi.fn(async () => "Opened Google search."),
    ...options.tools
  };
  const chat = createRoomAgentChat({
    store, publish: (event) => published.push(event), tools: createRoomAgentTools(toolDeps),
    describeRoom: async () => "Room activity: 2 open panes.",
    snapshot: async (roomId) => service.snapshot(roomId),
    paneTypes: async () => ["codex", "claude", "browser"],
    modelSelection: async () => selection(options.tier ?? "CODEX"),
    model, ...(options.textModel ? { textModel: options.textModel } : {}),
    limits: { retryDelayMs: 1, saveMs: 1, textFrameMs: 1 }
  });
  const enqueue = vi.fn(async () => ({ workflowId: "wf", runId: null }));
  const service = createRoomAgentService({ store, workflow: { enqueue, stop: async () => {} },
    missionStopper: { pauseMission: async () => {}, resumeMission: async () => {}, stopMission: async () => {} },
    roomPlanInventoryProvider: { inspect: async () => ({ totalPanes: 2, plannedPanes: 0, pendingPlans: 0, readyPlans: 0, pausedPlans: 0,
      runningPlans: 0, checkedAt: new Date().toISOString(), plans: [] }) },
    modelSelection: async () => selection(options.tier ?? "CODEX"), chat, ...(options.chatAllowed ? { chatAllowed: options.chatAllowed } : {}) });
  const settle = () => vi.waitFor(() => expect(chat.isRunning(room.id)).toBe(false), { timeout: 5_000 });
  const send = async (content: string, clientRequestId: string) => {
    const session = await service.send(room.id, content, clientRequestId, `trace:${clientRequestId}`, actor);
    await settle();
    return { session, after: await service.load(room.id) };
  };
  return { store, room, andy: andy!, bob: bob!, chat, service, model, toolDeps, published, enqueue, send, settle };
}

describe("Room Agent conversation", () => {
  it("answers with streamed text, records one durable event and never starts a mission", async () => {
    const c = fixture({ steps: [[{ content: "Βλέπω " }, { content: "δύο panes." }, { finishReason: "stop" }]] });
    const frames: unknown[] = [];
    c.chat.subscribe(c.room.id, (frame) => frames.push(frame));
    const started = await c.service.send(c.room.id, "τι βλέπεις στο δωμάτιο;", "chat:text", "trace:text", actor);
    expect(started).toMatchObject({ status: "RUNNING", statusReason: "Answering…", capabilities: { canStop: true } });
    expect(started.activeTurn).toMatchObject({ requestId: "chat:text" });
    expect(started.messages.at(-1)).toMatchObject({ role: "assistant", kind: "CHAT", status: "RUNNING" });
    await c.settle();
    const after = await c.service.load(c.room.id);
    expect(after).toMatchObject({ status: "IDLE", activeTurn: null });
    expect(after.messages.map((message) => [message.role, message.content, message.status])).toEqual([
      ["user", "τι βλέπεις στο δωμάτιο;", "COMPLETED"], ["assistant", "Βλέπω δύο panes.", "COMPLETED"]]);
    expect(frames[0]).toMatchObject({ phase: "text", requestId: "chat:text", text: expect.stringMatching(/^Βλέπω/) });
    expect(frames.at(-1)).toMatchObject({ phase: "done", messageId: started.activeTurn!.messageId, text: "Βλέπω δύο panes." });
    expect(c.published.map((event) => [event.type, event.payload.kind])).toEqual([["ROOM_AGENT_UPDATED", "TURN_DONE"]]);
    expect(c.enqueue).not.toHaveBeenCalled();
    expect(c.store.listRoomAgentMissions(c.room.id)).toHaveLength(0);
    const body = c.model.bodies[0]!;
    expect(body).toMatchObject({ model: "gpt-5.6-sol", reasoning_effort: "medium", tool_choice: "auto" });
    expect(body.messages[0]!.content).toContain("You are the Room Agent");
    expect(body.messages[0]!.content).toContain("Room activity: 2 open panes.");
    expect(body.messages[0]!.content).toContain("Pane types you can open: codex, claude, browser.");
    expect(body.messages.at(-1)).toEqual({ role: "user", content: "τι βλέπεις στο δωμάτιο;" });
    expect((body.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name)).toEqual(expect.arrayContaining([
      "room_status", "read_pane", "send_to_pane", "answer_pane_prompt", "open_panes", "close_pane", "space_control", "confirm_action"]));
  });

  it("refuses the conversation in a room whose model runs would bill someone else (MU-002), before any model call", async () => {
    const allowed = vi.fn(async () => false);
    const c = fixture({ steps: [[{ content: "never" }, { finishReason: "stop" }]], chatAllowed: allowed });
    await expect(c.service.send(c.room.id, "τι βλέπεις;", "chat:refused", "trace:refused", actor)).rejects.toMatchObject({ errorCode: "ROOM_AGENT_CHAT_UNAVAILABLE" });
    expect(allowed).toHaveBeenCalledWith(c.room.id);
    expect(c.model.bodies).toHaveLength(0);
    expect(c.chat.isRunning(c.room.id)).toBe(false);
  });

  it("runs tools in a loop and shows each tool before the turn's answer", async () => {
    const c = fixture({ steps: [
      [{ content: "Κοιτάζω τον Bob." }, ...toolCall("read_pane", { pane: "Bob" })],
      (body) => {
        const result = body.messages.at(-1)!;
        expect(result).toMatchObject({ role: "tool", tool_call_id: "call_read_pane" });
        expect(result.content).toContain("Screen (newest");
        return [{ content: "Ο Bob είναι έτοιμος." }];
      }
    ] });
    c.store.updatePane(c.bob.id, { paneName: "Bob" });
    const { after } = await c.send("τι κάνει ο Bob;", "chat:tool");
    expect(c.toolDeps.inspectPane).toHaveBeenCalledWith(expect.objectContaining({ id: c.bob.id }));
    expect(after.messages.map((message) => [message.kind, message.content])).toEqual([
      ["CHAT", "τι κάνει ο Bob;"], ["TOOL", "Read Bob's screen"], ["CHAT", "Κοιτάζω τον Bob.\n\nΟ Bob είναι έτοιμος."]]);
    expect(after.messages[1]!.meta).toMatchObject({ name: "read_pane", status: "DONE" });
    expect(c.model.bodies[1]!.messages.at(-2)).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_read_pane", function: { name: "read_pane" } }] });
  });

  it("asks before closing, runs the action only after the operator's yes, and refuses a confirmation in the same turn", async () => {
    let token = "";
    const c = fixture({ steps: [
      toolCall("close_pane", { panes: ["Bob"] }),
      (body) => {
        token = JSON.parse(String(body.messages.at(-1)!.content)).token;
        return toolCall("confirm_action", { token }, "call_self_confirm");
      },
      (body) => {
        expect(String(body.messages.at(-1)!.content)).toContain("has not answered yet");
        return [{ content: "Να κλείσω τον Bob;" }];
      },
      (body) => {
        expect(body.messages[0]!.content).toContain(`token ${token}: Close Bob`);
        return toolCall("confirm_action", { token });
      },
      [{ content: "Έκλεισα τον Bob." }]
    ] });
    c.store.updatePane(c.bob.id, { paneName: "Bob" });
    const first = await c.send("κλείσε τον Bob", "chat:close");
    expect(c.toolDeps.controlExecute).not.toHaveBeenCalled();
    const confirmation = first.after.messages.find((message) => message.kind === "CONFIRMATION")!;
    expect(confirmation).toMatchObject({ content: "Close Bob", meta: { token, status: "PENDING" } });
    expect(first.after.messages.filter((message) => message.kind === "TOOL").map((message) => message.meta?.status)).toEqual(["NEEDS_CONFIRMATION", "REFUSED"]);

    const second = await c.send("ναι, κλείσ' τον", "chat:yes-typed");
    expect(c.toolDeps.controlExecute).toHaveBeenCalledOnce();
    expect(vi.mocked(c.toolDeps.controlExecute).mock.calls[0]![1]).toMatchObject({ userExplicitlyAuthorized: true,
      actions: [{ kind: "pane", operation: "close", target: { paneIds: [c.bob.id] } }] });
    expect(second.after.messages.find((message) => message.id === confirmation.id)?.meta).toMatchObject({ status: "CONFIRMED", result: "Closed Bob" });
    expect(second.after.messages.at(-1)).toMatchObject({ content: "Έκλεισα τον Bob.", status: "COMPLETED" });
    expect(c.chat.pendingConfirmations(c.room.id)).toEqual([]);
  });

  it("runs the action on the server when the operator presses Yes, and the model only reports it", async () => {
    const c = fixture({ steps: [
      toolCall("close_pane", { panes: ["Bob"] }), [{ content: "Να κλείσω τον Bob;" }],
      (body) => {
        expect(body.messages.at(-2)).toMatchObject({ role: "assistant", tool_calls: [{ function: { name: "confirm_action" } }] });
        expect(String(body.messages.at(-1)!.content)).toContain("operationId");
        return [{ content: "Έκλεισα τον Bob." }];
      }
    ] });
    c.store.updatePane(c.bob.id, { paneName: "Bob" });
    await c.send("κλείσε τον Bob", "chat:close-button");
    const [pending] = c.chat.pendingConfirmations(c.room.id);
    const { after } = await c.send(`Yes, go ahead (confirm ${pending!.token})`, "chat:yes-button");
    expect(c.toolDeps.controlExecute).toHaveBeenCalledOnce();
    expect(after.messages.find((message) => message.kind === "CONFIRMATION")?.meta).toMatchObject({ status: "CONFIRMED" });
    expect(after.messages.at(-1)).toMatchObject({ content: "Έκλεισα τον Bob.", status: "COMPLETED" });
    expect(c.model.bodies).toHaveLength(3);
  });

  it("drops an unanswered confirmation after the next message and expires old ones", async () => {
    const c = fixture({ steps: [
      toolCall("restart_pane", { panes: ["Andy"] }), [{ content: "Να κάνω restart τον Andy;" }],
      [{ content: "Εντάξει, δεν κάνω τίποτα." }],
      toolCall("confirm_action", { token: "missing-token" }), [{ content: "Δεν υπάρχει κάτι να επιβεβαιώσω." }]
    ] });
    c.store.updatePane(c.andy.id, { paneName: "Andy" });
    await c.send("κάνε restart τον Andy", "chat:restart");
    expect(c.chat.pendingConfirmations(c.room.id)).toHaveLength(1);
    const declined = await c.send("όχι", "chat:no-thanks");
    expect(declined.after.messages.find((message) => message.kind === "CONFIRMATION")?.meta).toMatchObject({ status: "DECLINED" });
    expect(c.chat.pendingConfirmations(c.room.id)).toEqual([]);
    const unknown = await c.send("confirm missing-token", "chat:unknown");
    expect(unknown.after.messages.filter((message) => message.kind === "TOOL").at(-1)).toMatchObject({ content: "Nothing to confirm", meta: { status: "REFUSED" } });
    expect(c.toolDeps.controlExecute).not.toHaveBeenCalled();
  });

  it("never leaves a tool spinning: Stop during a tool and a restart both end its row", async () => {
    const c = fixture({ steps: [toolCall("read_pane", { pane: "Bob" })], tools: {
      inspectPane: vi.fn(() => new Promise<never>(() => {}))
    } });
    c.store.updatePane(c.bob.id, { paneName: "Bob" });
    await c.service.send(c.room.id, "τι κάνει ο Bob;", "chat:stop-tool", "trace:stop-tool", actor);
    await vi.waitFor(() => expect(c.toolDeps.inspectPane).toHaveBeenCalled());
    const stopped = await c.service.stop(c.room.id, "Stopped from the Room Agent.", "trace:stop");
    expect(stopped.messages.find((message) => message.kind === "TOOL")).toMatchObject({ content: "Reading Bob's screen (stopped)", meta: { status: "FAILED" } });
    expect(stopped.messages.at(-1)).toMatchObject({ status: "INTERRUPTED" });
    const at = new Date().toISOString();
    const rows = [
      { messageId: "a1", sessionId: "s", runId: null, role: "assistant" as const, content: "x", status: "INTERRUPTED" as const, createdAt: at, updatedAt: at },
      { messageId: "t1", sessionId: "s", runId: null, role: "tool" as const, status: "RUNNING" as const, createdAt: at, updatedAt: at,
        content: JSON.stringify({ v: 1, type: "TOOL", turn: "a1", callId: "c", name: "read_pane", arguments: {}, label: "Reading Bob's screen", display: null, status: "RUNNING", result: null }) }
    ];
    expect(roomAgentTimeline(rows)[0]).toMatchObject({ kind: "TOOL", content: "Reading Bob's screen (stopped)", meta: { status: "FAILED" } });
  });

  it("shows a pending confirmation as expired after ten minutes", () => {
    const at = new Date(Date.now() - 11 * 60_000).toISOString();
    const row = { messageId: "agent_msg:confirm", sessionId: "s", runId: null, role: "system" as const, status: "COMPLETED" as const, createdAt: at, updatedAt: at,
      content: JSON.stringify({ v: 1, type: "CONFIRMATION", turn: "agent_msg:a", token: "t1", action: "Close Bob", status: "PENDING", result: null, expiresAt: new Date(Date.now() - 60_000).toISOString() }) };
    expect(roomAgentTimeline([row])[0]).toMatchObject({ kind: "CONFIRMATION", meta: { status: "EXPIRED" } });
  });

  it("refuses a second message while answering, and Stop ends the answer as interrupted", async () => {
    const c = fixture();
    c.model.stream = async function* (body, signal) {
      c.model.bodies.push(body);
      yield { content: "Ξεκινάω μια μεγάλη απάντηση" };
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    };
    await c.service.send(c.room.id, "γράψε μια μεγάλη αναφορά", "chat:long", "trace:long", actor);
    await vi.waitFor(() => expect(c.model.bodies).toHaveLength(1));
    await expect(c.service.send(c.room.id, "και κάτι άλλο", "chat:second", "trace:second", actor)).rejects.toThrow("The Room Agent is still answering. Wait for the reply or press Stop.");
    const replay = await c.service.send(c.room.id, "γράψε μια μεγάλη αναφορά", "chat:long", "trace:retry", actor);
    expect(replay.directCommand).toMatchObject({ status: "REPLAYED" });
    const stopped = await c.service.stop(c.room.id, "Stopped from the Room Agent.", "trace:stop");
    expect(stopped.status).toBe("IDLE");
    expect(stopped.messages.at(-1)).toMatchObject({ status: "INTERRUPTED", content: "Ξεκινάω μια μεγάλη απάντηση\n\n(stopped)" });
    expect(stopped.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual(["γράψε μια μεγάλη αναφορά"]);
  });

  it("replays the same request id without a second turn", async () => {
    const c = fixture({ steps: [[{ content: "Γεια." }]] });
    await c.send("γεια", "chat:replay");
    const replay = await c.service.send(c.room.id, "γεια", "chat:replay", "trace:replay", actor);
    expect(replay.directCommand?.status).toBe("REPLAYED");
    expect(c.model.bodies).toHaveLength(1);
    await expect(c.service.send(c.room.id, "κάτι άλλο", "chat:replay", "trace:changed", actor)).rejects.toThrow("different actor or payload");
  });

  it("retries an overloaded model before any text and explains a model that stays unavailable", async () => {
    const c = fixture({ steps: [[{ error: "Our servers are currently overloaded." }], [{ content: "Εντάξει." }]] });
    const ok = await c.send("γεια", "chat:retry");
    expect(ok.after.messages.at(-1)).toMatchObject({ content: "Εντάξει.", status: "COMPLETED" });
    const down = fixture({ steps: [[{ error: "upstream secret body" }], [{ error: "x" }], [{ error: "y" }]] });
    const failed = await down.send("γεια", "chat:down");
    expect(failed.after.messages.at(-1)).toMatchObject({ status: "FAILED", content: "I could not reach the model right now. Please try again in a moment." });
    expect(failed.after.messages.at(-1)!.content).not.toContain("secret");
  });

  it("answers text-only on the OpenCode tier and falls back to the room snapshot", async () => {
    const text = scriptedModel([[]], false);
    const c = fixture({ tier: "OPENCODE", textModel: text });
    const { after } = await c.send("τι βλέπεις;", "chat:opencode");
    expect(text.bodies[0]).toMatchObject({ model: "opencode/big-pickle" });
    expect(text.bodies[0]!.tools).toBeUndefined();
    expect(after.messages.at(-1)!.content).toMatch(/^Βλέπω 2 ανοιχτά panes/);
    expect(c.model.bodies).toHaveLength(0);
  });

  it("sends @mentions straight to the panes without a model", async () => {
    const c = fixture();
    const executeRoutedCommand = vi.fn(async () => ({ summary: "Completed 1 controls." }));
    const service = createRoomAgentService({ store: c.store, workflow: { enqueue: c.enqueue, stop: async () => {} },
      missionStopper: { pauseMission: async () => {}, resumeMission: async () => {}, stopMission: async () => {} },
      roomPlanInventoryProvider: { inspect: async () => ({ totalPanes: 2, plannedPanes: 0, pendingPlans: 0, readyPlans: 0, pausedPlans: 0,
        runningPlans: 0, checkedAt: new Date().toISOString(), plans: [] }) }, chat: c.chat, executeRoutedCommand });
    const result = await service.send(c.room.id, "@Andy γράψε ένα haiku", "chat:mention", "trace:mention", actor);
    expect(result.directCommand?.status).toBe("COMPLETED");
    expect(executeRoutedCommand).toHaveBeenCalledWith(c.room.id, { type: "CONTROL", actions: [{ kind: "pane", operation: "prompt",
      target: { paneNames: ["Andy"], state: "OPEN" }, text: "γράψε ένα haiku", when: "AFTER_TURN" }] }, "chat:mention", "trace:mention", actor);
    expect(c.model.bodies).toHaveLength(0);
    expect(c.chat.isRunning(c.room.id)).toBe(false);
  });

  it("refuses every request of a USER account (MU-008) before any executor or model; the operator's requests are unchanged", async () => {
    const c = fixture({ steps: [[{ content: "never" }, { finishReason: "stop" }]] });
    c.store.upsertUser({ id: "user:member", email: "member@space.test", role: "USER" });
    const member = { holderType: "OPERATOR", holderId: "user:member" } as const;
    const executeRoutedCommand = vi.fn(async () => ({ summary: "Completed 1 controls." }));
    const service = createRoomAgentService({ store: c.store, workflow: { enqueue: c.enqueue, stop: async () => {} },
      missionStopper: { pauseMission: async () => {}, resumeMission: async () => {}, stopMission: async () => {} },
      roomPlanInventoryProvider: { inspect: async () => ({ totalPanes: 2, plannedPanes: 0, pendingPlans: 0, readyPlans: 0, pausedPlans: 0,
        runningPlans: 0, checkedAt: new Date().toISOString(), plans: [] }) }, chat: c.chat, executeRoutedCommand });
    for (const [content, requestId] of [["@Andy γράψε ένα haiku", "member:mention"], ["Space control: maximize Andy", "member:control"],
      ["τι βλέπεις στο δωμάτιο;", "member:chat"]] as const) {
      await expect(service.send(c.room.id, content, requestId, `trace:${requestId}`, member)).rejects.toMatchObject({ errorCode: "ROOM_AGENT_UNAVAILABLE" });
    }
    await expect(service.executeCommand(c.room.id, { requestId: "member:typed", catalogVersion: PANE_CATALOG_VERSION,
      action: { type: "SEARCH", query: "books", engine: "GOOGLE" } }, "trace:typed", member)).rejects.toMatchObject({ errorCode: "ROOM_AGENT_UNAVAILABLE" });
    expect(executeRoutedCommand).not.toHaveBeenCalled();
    expect(c.model.bodies).toHaveLength(0);
    expect(c.chat.isRunning(c.room.id)).toBe(false);
    const operator = await service.send(c.room.id, "@Andy γράψε ένα haiku", "operator:mention", "trace:operator", actor);
    expect(operator.directCommand?.status).toBe("COMPLETED");
    expect(executeRoutedCommand).toHaveBeenCalledOnce();
  });
});

describe("Room Agent conversation history", () => {
  const row = (messageId: string, role: "user" | "assistant" | "tool" | "system", content: string, minute: number) => {
    const at = new Date(Date.UTC(2026, 9, 13, 8, minute)).toISOString();
    return { messageId, sessionId: "s", runId: null, role, content, status: "COMPLETED" as const, createdAt: at, updatedAt: at };
  };
  const tool = (turn: string, name: string, pane: string) => JSON.stringify({ v: 1, type: "TOOL", turn, callId: `call_${turn}_${name}`, name,
    arguments: { pane }, label: `Reading ${pane}`, display: `Read ${pane}'s screen`, status: "DONE", result: `${pane} screen` });

  it("keeps tool calls for recent turns, one line for older turns, and drops turns over the budget", () => {
    const history = Array.from({ length: 6 }, (_, index) => [
      row(`u${index}`, "user", `question ${index}`, index * 3),
      row(`a${index}`, "assistant", `answer ${index}`, index * 3 + 1),
      row(`t${index}`, "tool", tool(`a${index}`, "read_pane", "Bob"), index * 3 + 2)
    ]).flat();
    const messages = buildRoomAgentChatMessages({ systemPrompt: "system", history, budgetChars: 100_000 });
    expect(messages[0]).toEqual({ role: "system", content: "system" });
    expect(messages[1]).toEqual({ role: "user", content: "question 0" });
    expect(messages[2]).toEqual({ role: "assistant", content: "(used read_pane on Bob)\nanswer 0" });
    const recent = messages.slice(-4);
    expect(recent).toEqual([
      { role: "user", content: "question 5" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_a5_read_pane", type: "function", function: { name: "read_pane", arguments: '{"pane":"Bob"}' } }] },
      { role: "tool", tool_call_id: "call_a5_read_pane", content: "Bob screen" },
      { role: "assistant", content: "answer 5" }
    ]);
    const small = buildRoomAgentChatMessages({ systemPrompt: "system", history, budgetChars: 200 });
    expect(small[1]).toEqual({ role: "system", content: "Earlier messages were dropped from context." });
    expect(small.filter((message) => message.role === "user").length).toBeLessThan(6);
    expect(small.at(-1)).toEqual({ role: "assistant", content: "answer 5" });
  });

  it("leaves the answer being written, its tools and system rows out of the history", () => {
    const history = [row("u1", "user", "κλείσε τον Bob", 1), row("a1", "assistant", "", 2), row("t1", "tool", tool("a1", "close_pane", "Bob"), 3),
      row("s1", "system", JSON.stringify({ v: 1, type: "CONFIRMATION", turn: "a1", token: "t", action: "Close Bob", status: "PENDING", result: null, expiresAt: "2099-01-01T00:00:00.000Z" }), 4)];
    expect(buildRoomAgentChatMessages({ systemPrompt: "system", history, currentMessageId: "a1" })).toEqual([
      { role: "system", content: "system" }, { role: "user", content: "κλείσε τον Bob" }]);
  });
});

describe("chat completion stream parser", () => {
  it("joins tool call arguments by index, ignores [DONE] and reports errors", () => {
    const parser = new ChatCompletionSseParser();
    const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    const text = [
      frame({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }),
      frame({ choices: [{ index: 0, delta: { content: "Hi" } }] }),
      frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_pane", arguments: "" } }] } }] }),
      frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"pane\":" } }] } }] }),
      frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"Bob\"}" } }] } }] }),
      frame({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
      "data: [DONE]\n\n",
      frame({ error: { message: "overloaded", type: "server_error" } })
    ].join("");
    const chunks = [...parser.push(text.slice(0, 57)), ...parser.push(text.slice(57)), ...parser.end()];
    expect(chunks).toEqual([
      { content: "Hi" },
      { toolCalls: [{ index: 0, id: "call_1", name: "read_pane", arguments: "" }] },
      { toolCalls: [{ index: 0, arguments: "{\"pane\":" }] },
      { toolCalls: [{ index: 0, arguments: "\"Bob\"}" }] },
      { finishReason: "tool_calls" },
      { error: "overloaded" }
    ]);
  });
});

const csrfHeaderName = "x-space-csrf-token";
const ownedApps: Array<Awaited<ReturnType<typeof createApp>>> = [];
afterEach(async () => { await Promise.all(ownedApps.splice(0).map((app) => app.close())); });

describe("Room Agent conversation API", () => {
  async function setup(steps: Step[]) {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Room Agent API", initialPaneCount: 1 });
    const model = scriptedModel(steps);
    const app = await createApp({ store, roomAgentChatModel: model,
      roomAgentWorkflow: { enqueue: async () => { throw new Error("No mission is expected."); }, stop: async () => {} },
      auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false } });
    ownedApps.push(app);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
    const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
    const csrfToken = (await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } })).json().csrfToken as string;
    const send = (content: string, clientRequestId: string) => app.inject({ method: "POST", url: `/api/rooms/${room.id}/room-agent/messages`,
      headers: { cookie, [csrfHeaderName]: csrfToken }, payload: { content, clientRequestId } });
    const read = async () => (await app.inject({ method: "GET", url: `/api/rooms/${room.id}/room-agent`, headers: { cookie } })).json();
    return { app, store, room, model, cookie, csrfToken, send, read };
  }

  it("accepts a message with 202, streams frames to the dock and closes the answer", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const c = await setup([async () => { await released; return [{ content: "Βλέπω ένα pane." }]; }]);
    const address = await c.app.listen({ port: 0, host: "127.0.0.1" });
    const missing = await fetch(`${address}/api/rooms/room:missing/room-agent/stream`, { headers: { cookie: c.cookie } });
    expect(missing.status).toBe(404);
    const controller = new AbortController();
    const stream = await fetch(`${address}/api/rooms/${c.room.id}/room-agent/stream`, { headers: { cookie: c.cookie }, signal: controller.signal });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const readUntil = async (pattern: RegExp) => {
      while (!pattern.test(received)) {
        const { done, value } = await reader.read();
        if (done) break;
        received += decoder.decode(value);
      }
    };
    await readUntil(/: connected/);

    const accepted = await c.send("τι βλέπεις;", "api:stream");
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ status: "RUNNING", activeTurn: { requestId: "api:stream" } });
    expect((await c.send("και άλλο", "api:busy")).json()).toMatchObject({ error: { message: "The Room Agent is still answering. Wait for the reply or press Stop." } });
    release();
    await readUntil(/"phase":"done"/);
    controller.abort();
    expect(received).toContain('"phase":"text"');
    expect(received).toContain('"text":"Βλέπω ένα pane."');
    await vi.waitFor(async () => expect((await c.read()).status).toBe("IDLE"));
    expect((await c.read()).messages.at(-1)).toMatchObject({ kind: "CHAT", content: "Βλέπω ένα pane.", status: "COMPLETED" });
  });

  it("returns 409 for a second message and Stop interrupts the answer", async () => {
    const c = await setup([blockingStep("never")]);
    expect((await c.send("μεγάλη αναφορά", "api:long")).statusCode).toBe(202);
    expect((await c.send("δεύτερο", "api:second")).statusCode).toBe(409);
    const stop = await c.app.inject({ method: "POST", url: `/api/rooms/${c.room.id}/room-agent/stop`,
      headers: { cookie: c.cookie, [csrfHeaderName]: c.csrfToken }, payload: { reason: "Stopped from the Room Agent." } });
    expect(stop.statusCode).toBe(200);
    expect(stop.json()).toMatchObject({ status: "IDLE", activeTurn: null });
    expect(stop.json().messages.at(-1)).toMatchObject({ status: "INTERRUPTED", content: "(stopped)" });
  });

  it("closes answers a stopped server left running when the API starts again", async () => {
    const c = await setup([blockingStep("never")]);
    await c.send("μεγάλη αναφορά", "api:restart");
    const sessionId = (await c.read()).sessionId as string;
    const running = c.store.listSpaceAgentMessages(sessionId).find((message) => message.role === "assistant")!;
    expect(running.status).toBe("RUNNING");
    expect(c.store.interruptRoomAgentChatTurns("\n\n(stopped: the server restarted)")).toBe(1);
    expect(c.store.listSpaceAgentMessages(sessionId).find((message) => message.messageId === running.messageId))
      .toMatchObject({ status: "INTERRUPTED", content: "\n\n(stopped: the server restarted)" });
  });
});
