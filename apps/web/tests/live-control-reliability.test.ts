// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearLiveRoomCaches, describeLiveControlReceipt, executeLiveFunction } from "../src/features/live-pane/live-session.js";
import { liveAnswerDeclines, noteLiveUserText, noteLiveUserTurn } from "../src/features/live-pane/live-command-origin.js";
import { registerRoomPlaybackTarget } from "../src/features/room-agent/room-playback-control.js";
import { api } from "../src/api.js";

vi.mock("../src/api.js", () => ({ api: {
  inspectControlMcp: vi.fn(), executeControlMcp: vi.fn(), callControlMcpTool: vi.fn(), reportLiveVoiceLog: vi.fn(async () => ({})),
  cliModelSettingsStatus: vi.fn(), updateCliModelSettings: vi.fn(async () => ({})),
  watchesControlMcp: vi.fn(), updateRoomPaneLayout: vi.fn(), getLiveRoomActivity: vi.fn(),
  dashboardAgents: vi.fn(async () => ({ data: [], activity: {} })),
  rooms: vi.fn(async () => ({ data: [] })),
  me: vi.fn(async () => ({ isAuthenticated: true, user: { id: "user:operator" } }))
} }));

beforeEach(() => {
  vi.clearAllMocks();
  clearLiveRoomCaches();
  vi.mocked(api.inspectControlMcp).mockResolvedValue({ result: { structuredContent: { panes: [
    { id: "pane:one", title: "One", mode: "TERMINAL", runtimeId: "cli:gemini", status: "IDLE" }
  ] } } });
  vi.mocked(api.executeControlMcp).mockResolvedValue({ result: { structuredContent: { id: "operation:one", status: "COMPLETED", results: [{ status: "COMPLETED" }] } } });
});

describe("Live action receipts and identity", () => {
  it("reads fresh activity instead of counting open terminals as working agents", async () => {
    vi.mocked(api.getLiveRoomActivity).mockResolvedValue({ roomId: "room:one", checkedAt: "now", activitySummary: {
      totalAgentPanes: 12, running: 2, idle: 8, waitingForInput: 1, stopped: 0, unknown: 1 }, panes: [] } as any);
    const result = JSON.parse(await executeLiveFunction("space_inspect_activity", "{}", { roomId: "room:one", callbacks: {} }));
    expect(api.getLiveRoomActivity).toHaveBeenCalledExactlyOnceWith("room:one");
    expect(result.counts).toMatchObject({ running: 2, unknown: 1, totalAgentPanes: 12 });
    expect(api.inspectControlMcp).not.toHaveBeenCalled();
  });
  it("submits playback once through the executor without applying NEXT locally first", async () => {
    const run = vi.fn(() => true);
    const unregister = registerRoomPlaybackTarget("youtube:one", { roomId: "room:one", kind: "YOUTUBE", playing: true, run });
    try {
      const result = JSON.parse(await executeLiveFunction("space_control_playback", '{"operation":"next"}', { roomId: "room:one", callbacks: {} }));
      expect(api.executeControlMcp).toHaveBeenCalledTimes(1);
      expect(run).not.toHaveBeenCalled();
      expect(result).toMatchObject({ completed: true, evidenceSource: "CONTROL_RECEIPT" });
      expect(result.message).not.toContain("Verified");
    } finally { unregister(); }
  });
  it.each(["PENDING", "RUNNING", "UNKNOWN", "FAILED", "PARTIAL", "CANCELLED"])("does not report %s control receipts as completion", status => {
    expect(JSON.parse(describeLiveControlReceipt({ id: "operation:test", status, results: [{ status: "COMPLETED" }] }, "layout.tree")).completed).toBe(false);
  });
  it("does not confirm completion without individual effects or after a skipped effect", () => {
    expect(JSON.parse(describeLiveControlReceipt({ status: "COMPLETED", results: [] }, "layout.tree")).completed).toBe(false);
    expect(JSON.parse(describeLiveControlReceipt({ status: "COMPLETED", results: [{ status: "COMPLETED" }, { status: "SKIPPED" }] }, "layout.tree")).completed).toBe(false);
  });
  it("reports layout execution failure and does not silently confirm the requested preset", async () => {
    vi.mocked(api.executeControlMcp).mockRejectedValueOnce(new Error("layout unavailable"));
    const result = await executeLiveFunction("space_set_pane_layout", '{"preset":"2 columns"}', { roomId: "room:one", callbacks: {} });
    expect(result).toContain("layout unavailable");
    expect(result).not.toContain("State verified");
    expect(api.updateRoomPaneLayout).not.toHaveBeenCalled();
  });
  it("reports a failed stop instead of claiming the pane stopped, and sends only schema fields", async () => {
    vi.mocked(api.executeControlMcp).mockResolvedValueOnce({ result: { structuredContent: { id: "operation:stop", status: "FAILED", results: [{ status: "FAILED", detail: "Session not attached" }] } } });
    const result = await executeLiveFunction("space_stop_pane", '{"paneId":"pane:one","reason":"user asked"}', { roomId: "room:one", callbacks: {} });
    expect(result).toContain("Session not attached");
    expect(result).not.toContain("State verified");
    expect(vi.mocked(api.executeControlMcp).mock.calls[0]?.[1][0]).toEqual({ kind: "pane", operation: "stop", target: { paneIds: ["pane:one"] }, when: "NOW" });
  });
  it("never runs tests, deploy or CLI access by voice", async () => {
    const result = await executeLiveFunction("space_execute_mcp", JSON.stringify({ confirmed: true, actions: [{ kind: "resource", operation: "ops.deploy", input: {} }] }), { roomId: "room:one", callbacks: {} });
    expect(result).toContain("never available by voice");
    expect(api.executeControlMcp).not.toHaveBeenCalled();
  });
  it("asks for confirmation before a deletion or settings change and runs it once confirmed", async () => {
    const remove = { kind: "resource", operation: "tasks.delete", id: "task:one", input: {} };
    for (const action of [remove, { kind: "resource", operation: "settings.update", input: {} }, { kind: "clipboard", operation: "delete", id: "clip:one" }]) {
      const pending = JSON.parse(await executeLiveFunction("space_execute_mcp", JSON.stringify({ actions: [action] }), { roomId: "room:one", callbacks: {} }));
      expect(pending).toMatchObject({ code: "CONFIRMATION_REQUIRED", executed: false, actions: [{ operation: action.operation }] });
    }
    expect(api.executeControlMcp).not.toHaveBeenCalled();
    // The model cannot confirm on the user's behalf: the user must answer after Live asked.
    const early = JSON.parse(await executeLiveFunction("space_execute_mcp", JSON.stringify({ confirmed: true, actions: [remove] }), { roomId: "room:one", callbacks: {} }));
    expect(early).toMatchObject({ code: "CONFIRMATION_REQUIRED", message: expect.stringContaining("has not answered yet") });
    expect(api.executeControlMcp).not.toHaveBeenCalled();
    noteLiveUserTurn(); noteLiveUserText("Ναι, σβήσ' το");
    const done = await executeLiveFunction("space_execute_mcp", JSON.stringify({ confirmed: true, actions: [remove] }), { roomId: "room:one", callbacks: {} });
    expect(done).toContain("space_execute completed");
    expect(vi.mocked(api.executeControlMcp).mock.calls[0]?.[1]).toEqual([remove]);
    // A confirmation is used once; the same deletion later asks again.
    const again = JSON.parse(await executeLiveFunction("space_execute_mcp", JSON.stringify({ confirmed: true, actions: [remove] }), { roomId: "room:one", callbacks: {} }));
    expect(again).toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    expect(api.executeControlMcp).toHaveBeenCalledTimes(1);
  });
  it.each(["Όχι, άσ' το", "no, don't", "Wait, cancel that"])("does not run a confirmed deletion when the user answered %s", async answer => {
    const remove = { kind: "resource", operation: "files.delete", id: "artifact:one", input: {} };
    await executeLiveFunction("space_execute_mcp", JSON.stringify({ actions: [remove] }), { roomId: "room:one", callbacks: {} });
    noteLiveUserTurn(); noteLiveUserText(answer);
    const declined = JSON.parse(await executeLiveFunction("space_execute_mcp", JSON.stringify({ confirmed: true, actions: [remove] }), { roomId: "room:one", callbacks: {} }));
    expect(declined).toMatchObject({ code: "DECLINED", executed: false });
    expect(api.executeControlMcp).not.toHaveBeenCalled();
  });
  it("reads a refusal in Greek or English, ignoring accents and case, and lets a yes through", () => {
    for (const no of ["ΟΧΙ", "όχι ακόμα", "μην το σβήσεις", "άκυρο", "Περίμενε", "nope", "Do not delete it", "hold on"]) expect(liveAnswerDeclines(no)).toBe(true);
    for (const yes of ["Ναι", "ναι, σβήσ' το", "yes please", "go ahead", "Do it", "ok delete it", "now"]) expect(liveAnswerDeclines(yes)).toBe(false);
  });
  it("runs a change before a later read of the same Live session, and reads without waiting for each other", async () => {
    const order: string[] = [];
    let finishOpen!: () => void;
    vi.mocked(api.executeControlMcp).mockImplementationOnce(() => new Promise(resolve => { finishOpen = () => { order.push("change"); resolve({ result: { structuredContent: { status: "COMPLETED", results: [{ status: "COMPLETED" }] } } }); }; }));
    vi.mocked(api.getLiveRoomActivity).mockImplementation(async () => { order.push("read"); return { roomId: "room:one", checkedAt: "now", activitySummary: {}, panes: [] } as any; });
    const change = executeLiveFunction("space_execute_mcp", JSON.stringify({ actions: [{ kind: "resource", operation: "tasks.create", input: { title: "A" } }] }), { roomId: "room:one", callbacks: {}, callId: "session-a:1" });
    const read = executeLiveFunction("space_inspect_activity", "{}", { roomId: "room:one", callbacks: {}, callId: "session-a:2" });
    const otherSession = executeLiveFunction("space_inspect_activity", "{}", { roomId: "room:one", callbacks: {}, callId: "session-b:1" });
    await otherSession;
    expect(order).toEqual(["read"]);
    await vi.waitFor(() => expect(finishOpen).toBeTypeOf("function"));
    finishOpen();
    await Promise.all([change, read]);
    expect(order).toEqual(["read", "change", "read"]);
  });
  it("runs other Space actions, such as creating a task, without asking", async () => {
    await executeLiveFunction("space_execute_mcp", JSON.stringify({ actions: [{ kind: "resource", operation: "tasks.create", input: { title: "Notes" } }] }), { roomId: "room:one", callbacks: {} });
    expect(api.executeControlMcp).toHaveBeenCalledTimes(1);
  });
  it("reads any Space area through space_inspect with the user's filter", async () => {
    vi.mocked(api.callControlMcpTool).mockResolvedValueOnce({ result: { structuredContent: { items: [{ id: "task:one", title: "Release notes" }] } } });
    const result = JSON.parse(await executeLiveFunction("space_inspect_room", '{"section":"tasks","query":"release"}', { roomId: "room:one", callbacks: {} }));
    expect(api.callControlMcpTool).toHaveBeenCalledExactlyOnceWith("space_inspect", { roomId: "room:one", section: "TASKS", query: "release" });
    expect(result).toMatchObject({ status: "SUCCESS", section: "TASKS", data: { items: [{ title: "Release notes" }] } });
    expect(api.inspectControlMcp).not.toHaveBeenCalled();
  });
  it("rejects all workspace actions after an ambiguous room switch, including explicit model-supplied targets", async () => {
    const result = await executeLiveFunction("space_execute_mcp", JSON.stringify({ roomId: "room:other", actions: [] }), { roomId: "room:old", getCommandRoom: () => undefined, callbacks: {} });
    expect(JSON.parse(result).code).toBe("LIVE_ROOM_CONTEXT_UNSET");
    expect(api.executeControlMcp).not.toHaveBeenCalled();
  });

  it("keeps the same operation identity for provider replay and distinguishes a new call", async () => {
    const args = JSON.stringify({ actions: [{ kind: "pane", operation: "stop", target: { paneIds: ["pane:one"] } }] });
    const run = (callId: string) => executeLiveFunction("space_execute_mcp", args, { roomId: "room:one", provider: "google", callId, callbacks: {} });
    await run("session:one:call:one"); await run("session:one:call:one"); await run("session:one:call:two");
    const calls = vi.mocked(api.executeControlMcp).mock.calls;
    expect(calls[0]?.[4]).toBe(calls[1]?.[4]);
    expect(calls[0]?.[4]).not.toBe(calls[2]?.[4]);
  });

  it("changes a model through one route and verifies effective settings", async () => {
    const settings = { sessionId: "session:one", isTurnActive: false, current: { modelId: "gemini", reasoningEffort: "high" }, models: [{ id: "gemini", displayName: "Gemini", supportedReasoningEfforts: ["low", "high"] }] };
    vi.mocked(api.cliModelSettingsStatus).mockResolvedValueOnce({ status: "AVAILABLE", settings } as never)
      .mockResolvedValueOnce({ status: "AVAILABLE", settings: { ...settings, current: { modelId: "gemini", reasoningEffort: "low" } } } as never);
    const event = vi.spyOn(window, "dispatchEvent");
    const result = await executeLiveFunction("space_set_pane_model", '{"paneId":"pane:one","reasoningEffort":"low"}', { roomId: "room:one", callbacks: {} });
    expect(api.updateCliModelSettings).toHaveBeenCalledTimes(1);
    expect(api.updateCliModelSettings).toHaveBeenCalledWith("pane:one", expect.objectContaining({ continueActiveTurn: false }));
    expect(api.executeControlMcp).not.toHaveBeenCalled();
    expect(event.mock.calls.some(([e]) => e.type === "space:terminal-pane-action")).toBe(false);
    expect(result).toContain("successfully changed");
    event.mockRestore();
  });

  it("allows model change when pane has status RUNNING but isTurnActive is false, and resolves free models", async () => {
    vi.mocked(api.inspectControlMcp).mockResolvedValueOnce({
      result: {
        structuredContent: {
          panes: [
            { id: "pane:opencode", title: "Emma (OpenCode CLI 22)", paneName: "Emma", mode: "TERMINAL", terminalRuntimeId: "cli:opencode", status: "RUNNING", isClosed: false }
          ]
        }
      }
    } as any);
    const settings = {
      sessionId: "session:opencode",
      isTurnActive: false,
      current: { modelId: "opencode/default", reasoningEffort: "default" },
      models: [
        { id: "opencode/default", displayName: "Default Model", supportedReasoningEfforts: ["default"] },
        { id: "opencode/muse-spark-1.3-contributor-free", displayName: "Muse Spark Free", defaultReasoningEffort: "default", supportedReasoningEfforts: ["default"] }
      ]
    };
    vi.mocked(api.cliModelSettingsStatus).mockResolvedValueOnce({ status: "AVAILABLE", settings } as never)
      .mockResolvedValueOnce({
        status: "AVAILABLE",
        settings: {
          ...settings,
          current: { modelId: "opencode/muse-spark-1.3-contributor-free", reasoningEffort: "default" }
        }
      } as never);

    const result = await executeLiveFunction("space_set_pane_model", '{"targetPosition":"latest","model":"free","cliType":"opencode"}', { roomId: "room:one", callbacks: {} });
    expect(api.updateCliModelSettings).toHaveBeenCalledWith("pane:opencode", {
      expectedSessionId: "session:opencode",
      modelId: "opencode/muse-spark-1.3-contributor-free",
      reasoningEffort: "default",
      continueActiveTurn: false
    });
    expect(result).toContain("successfully changed");
    expect(result).toContain("Muse Spark Free");
  });

  it("blocks model change when isTurnActive is true", async () => {
    vi.mocked(api.inspectControlMcp).mockResolvedValueOnce({
      result: {
        structuredContent: {
          panes: [
            { id: "pane:opencode", title: "Emma (OpenCode CLI 22)", paneName: "Emma", mode: "TERMINAL", terminalRuntimeId: "cli:opencode", status: "RUNNING", isClosed: false }
          ]
        }
      }
    } as any);
    const settings = {
      sessionId: "session:opencode",
      isTurnActive: true,
      current: { modelId: "opencode/default", reasoningEffort: "default" },
      models: [{ id: "opencode/default", displayName: "Default", supportedReasoningEfforts: ["default"] }]
    };
    vi.mocked(api.cliModelSettingsStatus).mockResolvedValueOnce({ status: "AVAILABLE", settings } as never);

    const result = await executeLiveFunction("space_set_pane_model", '{"paneId":"pane:opencode","model":"opencode/default"}', { roomId: "room:one", callbacks: {} });
    expect(result).toContain("is running a task");
    expect(api.updateCliModelSettings).not.toHaveBeenCalled();
  });

  it("does not create duplicate client watches or call a pending prompt completed", async () => {
    vi.mocked(api.executeControlMcp).mockResolvedValue({ result: { structuredContent: { id: "operation:pending", status: "PENDING", results: [] } } });
    const result = await executeLiveFunction("space_send_prompt", '{"paneIds":["pane:one"],"prompt":"Hello"}', { roomId: "room:one", callbacks: {} });
    expect(JSON.parse(result)).toMatchObject({ status: "PENDING", operationId: "operation:pending" });
    expect(api.watchesControlMcp).not.toHaveBeenCalled();
  });

  it("sends to CLI and Chat and returns one receipt for every pane", async () => {
    vi.mocked(api.inspectControlMcp).mockResolvedValue({ result: { structuredContent: { panes: [
      { id: "pane:one", mode: "TERMINAL" }, { id: "pane:chat", mode: "CHAT" }
    ] } } });
    const result = JSON.parse(await executeLiveFunction("space_send_prompt", '{"all":true,"prompt":"Hello"}', { roomId: "room:one", callbacks: {} }));
    expect(vi.mocked(api.executeControlMcp).mock.calls[0]?.[1][0]).toMatchObject({ target: { paneIds: ["pane:one", "pane:chat"] } });
    expect(result.panes).toHaveLength(2);
    expect(result.panes.every((pane: any) => pane.taskCompleted === false)).toBe(true);
  });

  it("preserves accepted and failed pane receipts when MCP marks a partial operation as an error", async () => {
    vi.mocked(api.inspectControlMcp).mockResolvedValue({ result: { structuredContent: { panes: [
      { id: "pane:one", mode: "TERMINAL" }, { id: "pane:chat", mode: "CHAT" }
    ] } } });
    vi.mocked(api.executeControlMcp).mockResolvedValue({ result: { isError: true, structuredContent: {
      id: "operation:partial", status: "PARTIAL", results: [
        { paneId: "pane:one", status: "COMPLETED", evidence: { result: { watchId: "watch:one" } } },
        { paneId: "pane:chat", status: "FAILED", detail: "Chat provider is unavailable." }
      ]
    } } });
    const result = JSON.parse(await executeLiveFunction("space_send_prompt", '{"all":true,"prompt":"Hello"}', { roomId: "room:one", callbacks: {} }));
    expect(result).toMatchObject({ operationId: "operation:partial", status: "PARTIAL", panes: [
      { paneId: "pane:one", submission: "ACCEPTED", watchId: "watch:one", taskCompleted: false },
      { paneId: "pane:chat", submission: "FAILED", detail: "Chat provider is unavailable.", taskCompleted: false }
    ] });
    expect(api.executeControlMcp).toHaveBeenCalledTimes(1);
  });

  it("reports an MCP rejection reason when there is no operation receipt", async () => {
    vi.mocked(api.executeControlMcp).mockResolvedValue({ result: { isError: true, content: [
      { type: "text", text: "The requested pane is still starting." }
    ] } });
    const result = await executeLiveFunction("space_send_prompt", '{"all":true,"prompt":"Hello"}', { roomId: "room:one", callbacks: {} });
    expect(result).toContain("The requested pane is still starting.");
    expect(result).not.toContain("Prompt dispatch failed.");
  });

  it.each(["space_send_prompt", "space_close_panes"])("rejects every invalid explicit target before %s executes", async tool => {
    const result = await executeLiveFunction(tool, '{"paneIds":["pane:one","pane:missing"],"all":true,"prompt":"Hello"}', { roomId: "room:one", callbacks: {} });
    expect(result).toContain("pane:missing");
    expect(api.executeControlMcp).not.toHaveBeenCalled();
  });

  it("rechecks the captured room after inspecting targets", async () => {
    let current: string | undefined = "room:one";
    vi.mocked(api.inspectControlMcp).mockImplementationOnce(async () => {
      current = undefined;
      return { result: { structuredContent: { panes: [{ id: "pane:one", mode: "TERMINAL" }] } } };
    });
    const result = await executeLiveFunction("space_send_prompt", '{"paneIds":["pane:one"],"prompt":"Hello"}', { roomId: "room:one", getCommandRoom: () => current, callbacks: {} });
    expect(result).toContain("LIVE_ROOM_CONTEXT_UNSET");
    expect(api.executeControlMcp).not.toHaveBeenCalled();
  });

  it("does not guess a room when context is absent", async () => {
    await executeLiveFunction("space_execute_mcp", '{"actions":[]}', { callbacks: {} });
    expect(api.executeControlMcp).not.toHaveBeenCalled();
  });

  it("dispatches space-pane-control-action refresh event when minimizing, restoring or closing panes", async () => {
    const events: CustomEvent[] = [];
    const handler = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener("space-pane-control-action", handler);
    try {
      vi.mocked(api.inspectControlMcp).mockResolvedValue({
        result: { structuredContent: { panes: [{ id: "pane:one", paneName: "Dana", mode: "TERMINAL", isMinimized: true, isClosed: false }] } }
      } as any);

      await executeLiveFunction("space_minimize_panes", '{"all":true}', { roomId: "room:one", callbacks: {} });
      expect(events.some(e => e.detail?.action === "refresh")).toBe(true);

      events.length = 0;
      await executeLiveFunction("space_restore_panes", '{"all":true}', { roomId: "room:one", callbacks: {} });
      expect(events.some(e => e.detail?.action === "refresh")).toBe(true);

      events.length = 0;
      vi.mocked(api.inspectControlMcp)
        .mockResolvedValueOnce({
          result: { structuredContent: { panes: [{ id: "pane:one", paneName: "Dana", mode: "TERMINAL", isClosed: false }] } }
        } as any)
        .mockResolvedValueOnce({
          result: { structuredContent: { panes: [{ id: "pane:one", paneName: "Dana", mode: "TERMINAL", isClosed: true }] } }
        } as any);
      await executeLiveFunction("space_close_panes", '{"all":true}', { roomId: "room:one", callbacks: {} });
      expect(events.some(e => e.detail?.action === "refresh")).toBe(true);
    } finally {
      window.removeEventListener("space-pane-control-action", handler);
    }
  });

  it("includes paneName in space_inspect_activity output", async () => {
    vi.mocked(api.getLiveRoomActivity).mockResolvedValue({
      roomId: "room:one", checkedAt: "now",
      activitySummary: { totalAgentPanes: 1, running: 0, idle: 1, waitingForInput: 0, stopped: 0, unknown: 0 },
      panes: [{ id: "pane:one", paneName: "Andy", title: "Task title", mode: "TERMINAL", activity: "IDLE", task: null }]
    } as any);
    const result = JSON.parse(await executeLiveFunction("space_inspect_activity", "{}", { roomId: "room:one", callbacks: {} }));
    expect(result.panes[0]).toMatchObject({ paneId: "pane:one", paneName: "Andy", title: "Task title", activity: "IDLE" });
  });

  it("verifies restore for specific pane without failing when other panes remain minimized", async () => {
    vi.mocked(api.inspectControlMcp)
      .mockResolvedValueOnce({
        result: { structuredContent: { panes: [
          { id: "pane:bob", paneName: "Bob", mode: "TERMINAL", isMinimized: false, isMaximized: true, isClosed: false },
          { id: "pane:jack", paneName: "Jack", mode: "TERMINAL", isMinimized: true, isMaximized: false, isClosed: false }
        ] } }
      } as any)
      .mockResolvedValueOnce({
        result: { structuredContent: { panes: [
          { id: "pane:bob", paneName: "Bob", mode: "TERMINAL", isMinimized: false, isMaximized: false, isClosed: false },
          { id: "pane:jack", paneName: "Jack", mode: "TERMINAL", isMinimized: true, isMaximized: false, isClosed: false }
        ] } }
      } as any);

    const result = await executeLiveFunction("space_restore_panes", '{"paneNames":["Bob"]}', { roomId: "room:one", callbacks: {} });
    expect(result).toContain("State verified");
    expect(result).not.toContain("Jack");
  });

  it("confirms room capacity limit without failing verification in space_open_panes", async () => {
    const panes16 = Array.from({ length: 16 }, (_, i) => ({
      id: `pane:${i}`, title: `CLI ${i}`, mode: "TERMINAL", isClosed: false
    }));
    vi.mocked(api.executeControlMcp).mockResolvedValue({
      result: { structuredContent: { id: "op:open", status: "COMPLETED", results: [{ status: "COMPLETED", evidence: { result: { data: [{ id: "pane:15", title: "OpenCode CLI 15" }] } } }] } }
    } as any);
    vi.mocked(api.inspectControlMcp).mockResolvedValue({
      result: { structuredContent: { paneCap: 16, panes: panes16 } }
    } as any);

    const result = await executeLiveFunction("space_open_panes", '{"counts":{"opencode":2,"codex":2}}', { roomId: "room:one", callbacks: {} });
    expect(result).toContain("State verified");
    expect(result).not.toContain("State verification failed");
  });

  it("inspects agents dashboard in current room with accurate working, done, idle and waiting counts", async () => {
    vi.mocked(api.dashboardAgents).mockResolvedValueOnce({
      data: [
        { id: "pane:jack", paneName: "Jack", title: "Codex Worker", mode: "TERMINAL", terminalRuntimeId: "cli:codex", isClosed: false },
        { id: "pane:andy", paneName: "Andy", title: "Gemini Story", mode: "TERMINAL", terminalRuntimeId: "cli:gemini", isClosed: false },
        { id: "pane:bob", paneName: "Bob", title: "Gemini Coder", mode: "TERMINAL", terminalRuntimeId: "cli:gemini", isClosed: false },
        { id: "pane:cody", paneName: "Cody", title: "Gemini Idle", mode: "TERMINAL", terminalRuntimeId: "cli:gemini", isClosed: false }
      ] as any,
      activity: {
        "pane:jack": "done",
        "pane:andy": "working",
        "pane:bob": "working",
        "pane:cody": "idle"
      }
    });

    const result = JSON.parse(await executeLiveFunction("space_inspect_dashboard", '{"roomScope":"current"}', { roomId: "room:one", callbacks: {} }));
    expect(result.summary).toEqual({ total: 4, working: 2, waiting: 0, done: 1, idle: 1 });
    expect(result.workingText).toContain("Andy");
    expect(result.workingText).toContain("Bob");
    expect(result.doneText).toContain("Jack");
    expect(result.idleText).toContain("Cody");
  });

  it("enriches space_inspect_activity with agents dashboard activity", async () => {
    vi.mocked(api.getLiveRoomActivity).mockResolvedValueOnce({
      roomId: "room:one", checkedAt: "now",
      activitySummary: { totalAgentPanes: 4, running: 0, idle: 1, waitingForInput: 0, stopped: 0, unknown: 3 },
      panes: [
        { id: "pane:jack", paneName: "Jack", title: "Codex Worker", mode: "TERMINAL", activity: "IDLE", task: { status: "COMPLETED" } },
        { id: "pane:andy", paneName: "Andy", title: "Gemini Story", mode: "TERMINAL", activity: "UNKNOWN", task: null },
        { id: "pane:bob", paneName: "Bob", title: "Gemini Coder", mode: "TERMINAL", activity: "UNKNOWN", task: null },
        { id: "pane:cody", paneName: "Cody", title: "Gemini Idle", mode: "TERMINAL", activity: "UNKNOWN", task: null }
      ]
    } as any);
    vi.mocked(api.dashboardAgents).mockResolvedValueOnce({
      data: [] as any,
      activity: {
        "pane:jack": "done",
        "pane:andy": "working",
        "pane:bob": "working",
        "pane:cody": "idle"
      }
    });

    const result = JSON.parse(await executeLiveFunction("space_inspect_activity", "{}", { roomId: "room:one", callbacks: {} }));
    expect(result.counts.running).toBe(2);
    expect(result.agentsDashboard).toEqual({ total: 4, working: 2, done: 1, idle: 1, waiting: 0 });
    expect(result.workingAgents).toEqual(["Andy", "Bob"]);
    expect(result.doneAgents).toEqual(["Jack"]);
    expect(result.idleAgents).toEqual(["Cody"]);
  });
});
