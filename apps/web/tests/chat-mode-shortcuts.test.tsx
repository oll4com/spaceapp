import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPaneSession, PaneCliModelSettings, Pane } from "@space/contracts";
import { AgentPane } from "../src/features/agent-pane/AgentPane.js";
import { OnScreenKeyboard } from "../src/features/osk-keyboard/OnScreenKeyboard.js";
import { dispatchAgentPaneActionEvent } from "../src/features/agent-pane/events.js";
import { CLEAN_WORKTREE_PROMPT, PROMOTE_PROMPT } from "../src/features/osk-keyboard/cli-shortcuts.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
const apiMock = vi.hoisted(() => ({ agentSession: vi.fn(), updateAgentSettings: vi.fn(), sendAgentMessage: vi.fn() }));
vi.mock("../src/api.js", () => ({ api: apiMock }));
vi.mock("../src/features/voice-input/VoiceInputProvider.js", () => ({ useOptionalVoiceInput: () => null, useVoiceInput: () => ({ ownerId: null, status: "idle", settings: {}, cancel: vi.fn(), prewarm: vi.fn() }) }));
vi.mock("../src/features/agent-pane/CodexTranscript.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/features/agent-pane/CodexTranscript.js")>(), CodexTranscript: () => null, CodexNotification: ({ message }: { message: string }) => <p>{message}</p>, copyableCodexTranscript: () => "" }));
type AgentPaneSessionWithModelCatalog = AgentPaneSession & { modelCatalog: PaneCliModelSettings["models"] };
function session(
  paneId: string,
  title: string,
  message: string,
  status: AgentPaneSession["binding"]["status"] = "READY",
  roomId = "room:agents"
): AgentPaneSessionWithModelCatalog {
  return {
    binding: {
      paneId,
      source: "SPACE",
      sessionId: `agent_session:${paneId}`,
      coderChatId: null,
      status,
      title,
      selectedModelConfigId: "gpt-5.5:high",
      selectedProviderName: "OpenAI",
      selectedModelName: "gpt-5.5",
      selectedReasoningKey: "high",
      selectedToolIds: ["mcp:github", "mcp:linear", "browser:extract_text"],
      lastSyncedAt: "2026-06-29T00:00:00.000Z"
    },
    threadId: null,
    messages: [
      {
        id: `msg:${paneId}`,
        role: "assistant",
        content: message,
        status: "COMPLETED",
        createdAt: "2026-06-29T00:00:00.000Z"
      }
    ],
    runStatus: status === "RUNNING" ? "RUNNING" : "IDLE",
    statusReason: "Space agent session is ready.",
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
      },
      {
        id: "gpt-5.5:low",
        displayName: "GPT-5.5",
        providerId: "openai",
        providerName: "OpenAI",
        model: "gpt-5.5",
        reasoningKey: "low",
        reasoningLabel: "Low reasoning",
        isDefault: false
      },
      {
        id: "gpt-5.5:research",
        displayName: "GPT-5.5",
        providerId: "openai",
        providerName: "OpenAI",
        model: "gpt-5.5",
        reasoningKey: "research",
        reasoningLabel: "Research reasoning",
        isDefault: false
      },
      {
        id: "gpt-5-mini:minimal",
        displayName: "GPT-5 Mini",
        providerId: "openai",
        providerName: "OpenAI",
        model: "gpt-5-mini",
        reasoningKey: "minimal",
        reasoningLabel: "Minimal reasoning",
        isDefault: true
      }
    ],
    modelCatalog: [
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        description: "Frontier coding model",
        isDefault: true,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: ["low", "high", "research"],
        reasoningOptions: [
          { reasoningEffort: "low", description: "Fast responses" },
          { reasoningEffort: "high", description: "Deep reasoning" },
          { reasoningEffort: "research", description: "Extended research" }
        ]
      },      {
        id: "gpt-5-mini",
        displayName: "GPT-5 Mini",
        description: "Fast coding model",
        isDefault: false,
        defaultReasoningEffort: "minimal",
        supportedReasoningEfforts: ["minimal"],
        reasoningOptions: [{ reasoningEffort: "minimal", description: "Lowest latency" }]
      }
    ],
    modelProviders: [],
    selectedModelConfigId: "gpt-5.5:high",
    toolOptions: [
      {
        id: "mcp:github",
        displayName: "GitHub",
        description: "GitHub MCP tools",
        category: "mcp",
        slug: "github",
        availability: "default_on",
        authType: "none",
        authConnected: true,
        enabled: true,
        isAvailable: true,
        statusReason: null,
        isForceOn: false
      },
      {
        id: "mcp:linear",
        displayName: "Linear",
        description: "Linear MCP tools",
        category: "mcp",
        slug: "linear",
        availability: "default_off",
        authType: "none",
        authConnected: true,
        enabled: true,
        isAvailable: true,
        statusReason: null,
        isForceOn: false
      },
      {
        id: "browser:extract_text",
        displayName: "Browser extract text",
        description: "Extract browser text",
        category: "browser",
        slug: "browser.extract_text",
        availability: "default_off",
        authType: "space-browser",
        authConnected: true,
        enabled: true,
        isAvailable: true,
        statusReason: null,
        isForceOn: false
      }
    ],
    selectedToolIds: ["mcp:github", "mcp:linear", "browser:extract_text"],
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
    permissionOptions: [
      {
        mode: "ask_for_approval",
        label: "Ask for approval",
        description: "Ask before elevated actions.",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        reviewer: "user",
        isAvailable: true,
        statusReason: null
      },
      {
        mode: "approve_for_me",
        label: "Approve for me",
        description: "Use the guardian reviewer.",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        reviewer: "guardian_subagent",
        isAvailable: true,
        statusReason: null
      },
      {
        mode: "full_access",
        label: "Full access",
        description: "Run without sandbox approvals.",
        sandbox: "danger-full-access",
        approvalPolicy: "never",
        reviewer: "user",
        isAvailable: true,
        statusReason: null
      }
    ],
    goal: null,
    history: [
      {
        paneId,
        roomId,
        source: "SPACE",
        sessionId: `agent_session:${paneId}`,
        coderChatId: null,
        status,
        title,
        selectedModelConfigId: "gpt-5.5:high",
        selectedProviderName: "OpenAI",
        selectedModelName: "gpt-5.5",
        selectedReasoningKey: "high",
        selectedToolIds: ["mcp:github", "mcp:linear", "browser:extract_text"],
        lastSyncedAt: "2026-06-29T00:00:00.000Z",
        paneTitle: title,
        paneIsClosed: false,
        updatedAt: "2026-06-29T00:00:00.000Z"
      }
    ],
    capabilities: {
      canSend: true,
      canInterrupt: status === "RUNNING",
      canSelectModel: true,
      canSelectTools: true,
      supportsTools: true
    }
  };
}

beforeEach(() => { installSpaceRuntime(liveRuntime); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); sessionStorage.clear(); });
const pane = { id: "pane:modes", roomId: "room:agents", title: "Modes", mode: "CHAT", isMinimized: false } as Pane;
const providers = ["codex", "opencode"];
describe("Chat mode controls", () => {
  it.each([
    ["plan_progress", "Plan completion percentage", "Plan completion percentage"],
    ["deploy", "Deploy", "Deploy the project to Gitea and GitHub."],
    ["promote", "Promote", PROMOTE_PROMPT],
    ["clean_worktree", "Clean worktree", CLEAN_WORKTREE_PROMPT]
  ] as const)("sends %s from the routed keyboard action, each time as a new request", async (action, _label, text) => {
    // Stage 8: the Dot composer has no shortcuts button; the on-screen keyboard and pane menu still route these actions.
    const current = session(pane.id, pane.title, "Ready");
    apiMock.agentSession.mockResolvedValue(current);
    apiMock.sendAgentMessage.mockResolvedValue(current);
    render(<AgentPane pane={pane} codexEnvironment={null} workspaceTextSize={14} />);
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(false));
    expect(screen.queryByRole("button", { name: "CLI shortcuts" })).toBeNull();
    act(() => dispatchAgentPaneActionEvent({ paneId: pane.id, action }));
    await waitFor(() => expect(apiMock.sendAgentMessage).toHaveBeenCalledTimes(1));
    expect(apiMock.sendAgentMessage.mock.calls[0]?.slice(0, 2)).toEqual([pane.id, text]);
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(false));
    act(() => dispatchAgentPaneActionEvent({ paneId: pane.id, action }));
    await waitFor(() => expect(apiMock.sendAgentMessage).toHaveBeenCalledTimes(2));
    expect(apiMock.sendAgentMessage.mock.calls[1]?.slice(0, 2)).toEqual([pane.id, text]);
    const firstRequestId = apiMock.sendAgentMessage.mock.calls[0]?.[5];
    const secondRequestId = apiMock.sendAgentMessage.mock.calls[1]?.[5];
    expect(firstRequestId).toEqual(expect.any(String));
    expect(secondRequestId).toEqual(expect.any(String));
    expect(secondRequestId).not.toBe(firstRequestId);
    expect(sessionStorage.getItem(`space.chatSubmission.v1:${pane.id}`)).toBeNull();
  });
  it("disables mode controls until the Chat session has loaded", async () => {
    let resolveSession!: (value: AgentPaneSessionWithModelCatalog) => void;
    apiMock.agentSession.mockReturnValue(new Promise<AgentPaneSessionWithModelCatalog>(resolve => { resolveSession = resolve; }));
    render(<AgentPane pane={pane} codexEnvironment={null} workspaceTextSize={14} />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true);
    act(() => dispatchAgentPaneActionEvent({ paneId: pane.id, action: "toggle_plan" }));
    expect(apiMock.updateAgentSettings).not.toHaveBeenCalled();
    await act(async () => resolveSession(session(pane.id, pane.title, "Ready")));
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(false));
  });
  it("keeps permission focus in the dialog and closes it when its pane is hidden", async () => {
    const current = session(pane.id, pane.title, "Ready");
    current.permissionOptions = current.permissionOptions.map(option => ({ ...option,
      isAvailable: option.mode === "full_access", statusReason: option.mode === "full_access" ? null : "Approval prompts are unavailable." }));
    apiMock.agentSession.mockResolvedValue(current);
    const view = render(<AgentPane pane={pane} codexEnvironment={null} workspaceTextSize={14} />);
    await waitFor(() => expect(screen.queryByText("Loading Chat…")).toBeNull());
    act(() => dispatchAgentPaneActionEvent({ paneId: pane.id, action: "permissions" }));
    const dialog = screen.getByRole("dialog", { name: "Chat permissions" });
    const close = within(dialog).getByRole("button", { name: "Close permissions" });
    const fullAccess = within(dialog).getByRole("button", { name: /^Full access/ });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(fullAccess);
    fireEvent.keyDown(fullAccess, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    expect(within(dialog).getAllByText("Approval prompts are unavailable.").length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve for me" }));
    expect(apiMock.updateAgentSettings).not.toHaveBeenCalled();
    view.rerender(<AgentPane pane={pane} codexEnvironment={null} workspaceTextSize={14} isVisible={false} />);
    view.rerender(<AgentPane pane={pane} codexEnvironment={null} workspaceTextSize={14} isVisible />);
    expect(screen.queryByRole("dialog", { name: "Chat permissions" })).toBeNull();
  });
  it.each(providers)("routes keyboard and quick-menu controls through %s Chat settings without sending a message", async provider => {
    let current = session(pane.id, pane.title, "Ready");
    current.modelCatalog = []; current.modelProviders = [];
    const selectedPermission = provider === "codex" ? "approve_for_me" : "full_access";
    const selectedLabel = provider === "codex" ? "Approve for me" : "Full access";
    if (provider === "opencode") current.permissionOptions = current.permissionOptions.map(option => ({
      ...option, isAvailable: option.mode === "full_access", statusReason: option.mode === "full_access" ? null : "Interactive approval prompts are unavailable for this provider."
    }));
    current.selectedModelConfigId = provider === "codex" ? "gpt-5.5:high" : `${provider === "opencode" ? "opencode" : provider}-v1|test|high`;
    apiMock.agentSession.mockImplementation(async () => current);
    apiMock.updateAgentSettings.mockImplementation(async (_pane, update) => {
      current = { ...current, ...update, permissionState: { ...current.permissionState, effectiveMode: update.permissionMode ?? current.permissionState.effectiveMode } };
      return current;
    });
    render(<><AgentPane pane={pane} codexEnvironment={null} workspaceTextSize={14} /><OnScreenKeyboard open mobile={false} roomTheme="graphite" onOpenChange={() => {}} defaultShowShortcuts onShortcut={command => {
      if (!command.action) return false;
      dispatchAgentPaneActionEvent({ paneId: pane.id, action: command.action === "plan" ? "toggle_plan" : command.action === "build" ? "build" : "permissions" }); return true;
    }} /></>);
    await waitFor(() => expect(screen.queryByText("Loading Chat…")).toBeNull());
    await act(async () => {});
    const keyboard = screen.getByRole("dialog", { name: "On-screen keyboard" });
    fireEvent.click(within(keyboard).getByRole("button", { name: "Plan mode" }));
    await waitFor(() => expect(apiMock.updateAgentSettings).toHaveBeenLastCalledWith(pane.id, { collaborationMode: "plan" }));
    await waitFor(() => expect((screen.getByRole("button", { name: `Disable Plan mode ${pane.title}` }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(keyboard).getByRole("button", { name: "Plan mode" }));
    await waitFor(() => expect(apiMock.updateAgentSettings).toHaveBeenLastCalledWith(pane.id, { collaborationMode: "default" }));
    fireEvent.click(within(keyboard).getByRole("button", { name: "Permissions" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Chat permissions" })).getByRole("button", { name: new RegExp(`^${selectedLabel}`) }));
    await waitFor(() => expect(apiMock.updateAgentSettings).toHaveBeenLastCalledWith(pane.id, { permissionMode: selectedPermission }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Chat permissions" })).toBeNull());
    fireEvent.click(within(keyboard).getByRole("button", { name: "Permissions" }));
    expect(within(screen.getByRole("dialog", { name: "Chat permissions" })).getByRole("button", { name: `${selectedLabel} ✓` }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Close permissions" }));
    act(() => dispatchAgentPaneActionEvent({ paneId: pane.id, action: "build" }));
    await waitFor(() => expect(current.collaborationMode).toBe("default"));
    act(() => dispatchAgentPaneActionEvent({ paneId: pane.id, action: "build" }));
    await waitFor(() => expect(current.collaborationMode).toBe("default"));
    expect(apiMock.sendAgentMessage).not.toHaveBeenCalled();
  });
});
