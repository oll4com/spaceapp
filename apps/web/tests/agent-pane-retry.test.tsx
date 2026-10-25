import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPaneSession, Artifact, CodexThreadResponse, Pane, PaneCliModelSettings } from "@space/contracts";
import { AgentPane, sameCodexThread } from "../src/features/agent-pane/AgentPane.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime, SpaceApiError, SpaceRuntimeProvider } from "../src/runtime/SpaceRuntime.js";
import { readChatSubmission, writeChatSubmission } from "../src/features/agent-pane/chat-submission.js";

const apiMock = vi.hoisted(() => ({
  agentSession: vi.fn(),
  sendAgentMessage: vi.fn(),
  prepareAgentRetry: vi.fn(),
  artifactFileUrl: (id: string) => `/api/artifacts/${encodeURIComponent(id)}/file`,
  createAgentSession: vi.fn(),
  codexThread: vi.fn(),
  updateAgentSettings: vi.fn()
}));
vi.mock("../src/api.js", () => ({ api: apiMock }));
vi.mock("../src/features/voice-input/VoiceInputProvider.js", () => ({
  useOptionalVoiceInput: () => null,
  useVoiceInput: () => ({ ownerId: null, status: "idle", settings: {}, cancel: vi.fn(), prewarm: vi.fn() })
}));

type AgentPaneSessionWithModelCatalog = AgentPaneSession & { modelCatalog: PaneCliModelSettings["models"] };

const timeoutMessage =
  "Codex App Server turn timed out before completion. The worker now keeps the session fail-closed; inspect worker readiness or increase SPACE_CODEX_APP_SERVER_TURN_TIMEOUT_MS.";
const lastUserRequest = "ελεγξε το space app για προβληματα";

function session(
  paneId: string,
  overrides: { runStatus?: AgentPaneSession["runStatus"]; canSend?: boolean } = {}
): AgentPaneSessionWithModelCatalog {
  const runStatus = overrides.runStatus ?? "ERROR";
  const canSend = overrides.canSend ?? true;
  return {
    binding: {
      paneId,
      source: "SPACE",
      sessionId: `agent_session:${paneId}`,
      coderChatId: null,
      status: "READY",
      title: "Debug check",
      selectedModelConfigId: "gpt-5.5:high",
      selectedProviderName: "OpenAI",
      selectedModelName: "gpt-5.5",
      selectedReasoningKey: "high",
      selectedToolIds: [],
      lastSyncedAt: "2026-06-29T00:00:00.000Z"
    },
    threadId: null,
    messages: [
      {
        id: `msg:user:${paneId}`,
        role: "user",
        content: lastUserRequest,
        status: "COMPLETED",
        createdAt: "2026-06-29T00:00:00.000Z"
      },
      {
        id: `msg:assistant:${paneId}`,
        role: "assistant",
        content: timeoutMessage,
        status: "FAILED",
        createdAt: "2026-06-29T00:05:00.000Z"
      }
    ],
    runStatus,
    statusReason: runStatus === "ERROR" ? timeoutMessage : "Space agent session is ready.",
    modelOptions: [
      {
        id: "gpt-5.5:high",
        displayName: "GPT-5.5",
        providerId: "openai",
        providerName: "OpenAI",
        model: "gpt-5.5",
        reasoningKey: "high",
        reasoningLabel: "High reasoning",
        isDefault: true
      }
    ],
    modelCatalog: [],
    modelProviders: [],
    selectedModelConfigId: "gpt-5.5:high",
    toolOptions: [],
    selectedToolIds: [],
    permissionMode: null,
    collaborationMode: "default",
    permissionState: {
      mode: null,
      effectiveMode: "full_access",
      isInherited: true,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      reviewer: "user",
      statusReason: "Inherited runtime default."
    },
    permissionOptions: [],
    goal: null,
    history: [],
    capabilities: {
      canSend,
      canInterrupt: false,
      canSelectModel: true,
      canSelectTools: true,
      supportsTools: true
    }
  };
}

beforeEach(() => { installSpaceRuntime(liveRuntime); sessionStorage.clear(); });

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const pane = { id: "pane:retry", roomId: "room:agents", title: "Debug check", mode: "CHAT", isMinimized: false } as Pane;

async function renderFailedPane(overrides: { canSend?: boolean } = {}) {
  apiMock.agentSession.mockResolvedValue(session(pane.id, overrides));
  render(<SpaceRuntimeProvider runtime={liveRuntime}><AgentPane pane={pane} codexEnvironment={null} workspaceTextSize={14} /></SpaceRuntimeProvider>);
  // The failed-run banner is the only error notification in the pane.
  const retry = await screen.findByRole("button", { name: "Review request" });
  expect(screen.getByRole("alert").textContent).toContain("This task needs attention");
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.getByRole("alert").textContent).toContain(timeoutMessage);
  return retry;
}

const file = { id: "artifact:retry", roomId: pane.roomId, paneId: pane.id, kind: "IMAGE", mimeType: "image/png",
  turnId: null, workflowId: null,
  storageUri: "space-artifact://user-uploads/retry.png", sha256: "a".repeat(64), byteSize: 305,
  metadata: { originalFilename: "original.png" }, pinnedAt: null, deletedAt: null, expiresAt: null,
  createdAt: "2026-09-27T00:00:00.000Z" } as Artifact;

const frozen = { clientRequestId: "request:lost-response", content: lastUserRequest,
  selectedModelConfigId: "gpt-5.5:high", selectedToolIds: ["tool:original"], attachments: [file] };

function renderPane() {
  return render(<SpaceRuntimeProvider runtime={liveRuntime}><AgentPane pane={pane} codexEnvironment={null} workspaceTextSize={14} /></SpaceRuntimeProvider>);
}

describe("Agent pane request recovery", () => {
  it("restores the exact failed request with attachments for review without executing", async () => {
    apiMock.prepareAgentRetry.mockResolvedValue({ content: lastUserRequest, artifacts: [file] });
    const retry = await renderFailedPane();
    fireEvent.click(retry);
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(lastUserRequest));
    expect(screen.getByRole("img", { name: "original.png" })).toBeTruthy();
    expect(screen.getByText(/Review them before sending a new attempt/)).toBeTruthy();
    expect(apiMock.sendAgentMessage).not.toHaveBeenCalled();
  });

  it("does not silently omit missing original files", async () => {
    apiMock.prepareAgentRetry.mockRejectedValue(Error("Original attachments are unavailable."));
    fireEvent.click(await renderFailedPane());
    await waitFor(() => expect(apiMock.prepareAgentRetry).toHaveBeenCalledTimes(1));
    expect(apiMock.sendAgentMessage).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("preserves an existing draft instead of overwriting it with the old request", async () => {
    const retry = await renderFailedPane();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "My next request" } });
    fireEvent.blur(screen.getByRole("textbox"));
    fireEvent.click(retry);
    expect(apiMock.prepareAgentRetry).not.toHaveBeenCalled();
    expect(apiMock.sendAgentMessage).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("My next request");
  });

  it("lets the operator dismiss a failed run without sending", async () => {
    await renderFailedPane();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(apiMock.sendAgentMessage).not.toHaveBeenCalled();
  });

  it("does not prepare a task when sending is unavailable", async () => {
    fireEvent.click(await renderFailedPane({ canSend: false }));
    expect(await screen.findByText(/Another attempt is unavailable/)).toBeTruthy();
    expect(apiMock.prepareAgentRetry).not.toHaveBeenCalled();
  });

  it("coalesces two clicks on Review request", async () => {
    let finish!: (value: { content: string; artifacts: Artifact[] }) => void;
    apiMock.prepareAgentRetry.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const retry = await renderFailedPane();
    fireEvent.click(retry); fireEvent.click(retry);
    expect(apiMock.prepareAgentRetry).toHaveBeenCalledTimes(1);
    finish({ content: lastUserRequest, artifacts: [] });
    await screen.findByText(/Review them before sending a new attempt/);
  });

  it("recovers an unconfirmed submission after remount using the frozen key, model, tools and files", async () => {
    writeChatSubmission(pane.id, frozen);
    apiMock.agentSession.mockResolvedValue({ ...session(pane.id, { runStatus: "RUNNING", canSend: false }), selectedModelConfigId: "different:model" });
    apiMock.sendAgentMessage.mockRejectedValueOnce(Error("Network lost"));
    const mounted = renderPane();
    const check = await screen.findByRole("button", { name: "Check submission" });
    fireEvent.click(check); fireEvent.click(check);
    await waitFor(() => expect(apiMock.sendAgentMessage).toHaveBeenCalledTimes(1));
    expect(apiMock.sendAgentMessage).toHaveBeenLastCalledWith(pane.id, frozen.content, frozen.selectedModelConfigId,
      frozen.selectedToolIds, [file.id], frozen.clientRequestId, undefined);
    await waitFor(() => expect((check as HTMLButtonElement).disabled).toBe(false));
    expect(readChatSubmission(pane.id)?.clientRequestId).toBe(frozen.clientRequestId);
    expect(screen.queryByText("The task could not finish. Your conversation is still here.")).toBeNull();
    mounted.unmount();
    apiMock.sendAgentMessage.mockResolvedValue(session(pane.id, { runStatus: "IDLE" }));
    renderPane();
    fireEvent.click(await screen.findByRole("button", { name: "Check submission" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Check submission" })).toBeNull());
    expect(apiMock.sendAgentMessage.mock.calls[1]).toEqual(apiMock.sendAgentMessage.mock.calls[0]);
    expect(readChatSubmission(pane.id)).toBeNull();
  });

  it("retains the original key when a recovery check is rate limited or loses authentication", async () => {
    writeChatSubmission(pane.id, frozen);
    apiMock.agentSession.mockResolvedValue(session(pane.id, { runStatus: "IDLE" }));
    apiMock.sendAgentMessage.mockRejectedValueOnce(new SpaceApiError("Rate limited", { status: 429 }))
      .mockRejectedValueOnce(new SpaceApiError("Sign in", { status: 401 }));
    renderPane();
    const check = await screen.findByRole("button", { name: "Check submission" });
    fireEvent.click(check);
    await waitFor(() => expect((check as HTMLButtonElement).disabled).toBe(false));
    expect(readChatSubmission(pane.id)?.clientRequestId).toBe(frozen.clientRequestId);
    fireEvent.click(check);
    await waitFor(() => expect(apiMock.sendAgentMessage).toHaveBeenCalledTimes(2));
    await waitFor(() => expect((check as HTMLButtonElement).disabled).toBe(false));
    expect(readChatSubmission(pane.id)?.clientRequestId).toBe(frozen.clientRequestId);
  });

  it("sends once on double submit and keeps a recoverable request on a lost response", async () => {
    apiMock.agentSession.mockResolvedValue(session(pane.id, { runStatus: "IDLE" }));
    apiMock.sendAgentMessage.mockRejectedValue(Error("Network lost"));
    renderPane();
    const textarea = await screen.findByRole("textbox");
    await waitFor(() => expect((textarea as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(textarea, { target: { value: "New work" } });
    const button = await screen.findByRole("button", { name: "Send Debug check" });
    fireEvent.click(button); fireEvent.click(button);
    await screen.findByRole("button", { name: "Check submission" });
    expect(apiMock.sendAgentMessage).toHaveBeenCalledTimes(1);
    expect(apiMock.sendAgentMessage.mock.calls[0]?.[5]).toMatch(/^[a-f0-9-]{36}$/);
    expect(readChatSubmission(pane.id)?.content).toBe("New work");
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe("New work"));
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

function threadPayload(content: string, checkedAt = "2026-06-29T00:00:00.000Z"): CodexThreadResponse {
  return {
    thread: { id: "thread:poll", rolloutPath: null, title: "Poll", preview: "", model: null, reasoningEffort: null, cwd: null, archived: false,
      source: null, modelProvider: null, threadSource: null, firstUserMessage: "", updatedAt: "2026-06-29T00:00:00.000Z", recencyAt: null },
    items: [{ id: "item:1", kind: "message", role: "assistant", content, toolName: null, rawType: null, createdAt: null }],
    checkedAt
  };
}

describe("Agent pane running poll", () => {
  it("keeps the current transcript only when no thread or item field changed", () => {
    const current = threadPayload("Working");
    expect(sameCodexThread(current, threadPayload("Working", "2026-06-29T00:00:02.500Z"))).toBe(true);
    expect(sameCodexThread(null, current)).toBe(false);
    expect(sameCodexThread(current, threadPayload("Working on it"))).toBe(false);
    const appended = threadPayload("Working");
    appended.items.push({ ...appended.items[0]!, id: "item:2" });
    expect(sameCodexThread(current, appended)).toBe(false);
    expect(sameCodexThread(current, { ...current, thread: { ...current.thread, updatedAt: "2026-06-29T00:00:05.000Z" } })).toBe(false);
  });

  it("shows the final answer once the task finishes, even when the last poll read the thread too early", async () => {
    vi.useFakeTimers();
    try {
      const running = { ...session(pane.id, { runStatus: "RUNNING", canSend: false }), threadId: "thread:poll" };
      apiMock.agentSession.mockResolvedValue(running);
      apiMock.codexThread.mockResolvedValue(threadPayload("Working"));
      await act(async () => { renderPane(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      // The poll sees the finished session but the thread from just before the final message.
      // Stage 8: the answer comes from the stored conversation; the thread is read once more for the record.
      apiMock.agentSession.mockResolvedValue({ ...running, runStatus: "IDLE", capabilities: { ...running.capabilities, canSend: true },
        messages: [{ id: "msg:final", role: "assistant", content: "Final answer", status: "COMPLETED", createdAt: "2026-06-29T00:00:03.000Z" }] });
      apiMock.codexThread.mockResolvedValueOnce(threadPayload("Working")).mockResolvedValue(threadPayload("Final answer"));
      await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByText("Final answer")).toBeTruthy();
      expect(apiMock.codexThread).toHaveBeenLastCalledWith("thread:poll", "chat");
    } finally { vi.useRealTimers(); }
  });

  it("waits for Codex to write a new conversation instead of reporting it missing", async () => {
    vi.useFakeTimers();
    try {
      const run = { runId: "agent_run:new", status: "RUNNING" as const, createdAt: "2026-06-29T00:00:00.000Z", startedAt: "2026-06-29T00:00:00.000Z",
        completedAt: null, execution: null, runtimeModelAtStart: null, threadId: "thread:new", turnId: null as string | null,
        costStatus: "UNKNOWN" as const, evaluationStatus: "NOT_EVALUATED" as const };
      const running = { ...session(pane.id, { runStatus: "RUNNING", canSend: false }), threadId: "thread:new", latestRun: run };
      apiMock.agentSession.mockResolvedValue(running);
      await act(async () => { renderPane(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      // The task has no turn yet, so Codex has not written the conversation: nothing is read.
      expect(apiMock.codexThread).not.toHaveBeenCalled();

      // Its turn started, but the conversation reaches Codex's history a moment later.
      apiMock.agentSession.mockResolvedValue({ ...running, latestRun: { ...run, turnId: "turn:1" } });
      apiMock.codexThread.mockRejectedValueOnce(new SpaceApiError("Codex thread thread:new was not found.", { status: 404 }))
        .mockResolvedValue(threadPayload("First reply in the new conversation"));
      await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(apiMock.codexThread).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/was not found/)).toBeNull();

      await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByText("First reply in the new conversation")).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });

  it("schedules the next poll only after the previous one settled", async () => {
    vi.useFakeTimers();
    try {
      const running = { ...session(pane.id, { runStatus: "RUNNING", canSend: false }), threadId: "thread:poll" };
      apiMock.agentSession.mockResolvedValue(running);
      apiMock.codexThread.mockResolvedValue(threadPayload("Working"));
      await act(async () => { renderPane(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(apiMock.codexThread).toHaveBeenCalledTimes(1);
      const sessionReads = apiMock.agentSession.mock.calls.length;

      let finish!: (value: typeof running) => void;
      apiMock.agentSession.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
      await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
      expect(apiMock.agentSession).toHaveBeenCalledTimes(sessionReads + 1);
      expect(apiMock.codexThread).toHaveBeenCalledTimes(2);

      // A slow session read holds the next poll back instead of stacking requests.
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(apiMock.agentSession).toHaveBeenCalledTimes(sessionReads + 1);
      expect(apiMock.codexThread).toHaveBeenCalledTimes(2);

      await act(async () => { finish(running); await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
      expect(apiMock.agentSession).toHaveBeenCalledTimes(sessionReads + 2);
      expect(apiMock.codexThread).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
});
