import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentPaneSession, Pane, PaneCliModelSettings } from "@space/contracts";
import { AgentPane } from "../src/features/agent-pane/AgentPane.js";
import { dispatchCliRuntimeVisibilityChange } from "../src/cli-runtime-visibility-events.js";

const apiMock = vi.hoisted(() => ({
  agentSession: vi.fn(),
  sendAgentMessage: vi.fn(),
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

const pane = { id: "pane:cli-visibility", roomId: "room:agents", title: "Chat 6", mode: "CHAT", isMinimized: false } as Pane;

function catalogModel(id: string, displayName: string) {
  return {
    id,
    displayName,
    isDefault: id === "gpt-6-astra",
    defaultReasoningEffort: "none",
    supportedReasoningEfforts: ["none"],
    reasoningOptions: [{ reasoningEffort: "none" }]
  };
}

function provider(providerId: string, providerName: string, modelId: string, modelName: string) {
  return {
    providerId,
    providerName,
    configIdPrefix: `${providerId}-v1|`,
    isCurrent: providerId === "codex",
    isInactive: false,
    statusReason: null,
    models: [catalogModel(modelId, modelName)]
  };
}

function session(includeClaudeCode: boolean): AgentPaneSessionWithModelCatalog {
  const providers = [provider("codex", "Codex (OpenAI)", "gpt-6-astra", "GPT-6-Astra")];
  if (includeClaudeCode) providers.push(provider("cli:claude", "Claude Code", "claude-opus-4.6", "Claude Opus 4.6"));
  return {
    binding: {
      paneId: pane.id,
      source: "SPACE",
      sessionId: `agent_session:${pane.id}`,
      coderChatId: null,
      status: "READY",
      title: pane.title,
      selectedModelConfigId: "gpt-6-astra:none",
      selectedProviderName: "Codex (OpenAI)",
      selectedModelName: "GPT-6-Astra",
      selectedReasoningKey: "none",
      selectedToolIds: [],
      lastSyncedAt: "2026-09-20T00:00:00.000Z"
    },
    threadId: null,
    messages: [],
    runStatus: "IDLE",
    statusReason: "Space agent session is ready.",
    modelOptions: [{
      id: "gpt-6-astra:none",
      displayName: "GPT-6-Astra",
      providerId: "codex",
      providerName: "Codex (OpenAI)",
      model: "gpt-6-astra",
      reasoningKey: "none",
      reasoningLabel: "No extra reasoning",
      isDefault: true
    }],
    modelCatalog: [
      catalogModel("gpt-6-astra", "GPT-6-Astra"),
      ...(includeClaudeCode ? [catalogModel("claude-opus-4.6", "Claude Opus 4.6")] : [])
    ],
    modelProviders: providers,
    selectedModelConfigId: "gpt-6-astra:none",
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
      canSend: true,
      canInterrupt: false,
      canSelectModel: true,
      canSelectTools: true,
      supportsTools: true
    }
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderPane() {
  render(<AgentPane pane={pane} codexEnvironment={null} workspaceTextSize={14} />);
  await waitFor(() => expect(apiMock.agentSession).toHaveBeenCalled());
  return screen.findByRole("textbox");
}

describe("Chat pane CLI runtime visibility", () => {
  it("reloads the model providers when a CLI is enabled in Settings", async () => {
    apiMock.agentSession.mockResolvedValue(session(false));
    await renderPane();
    expect(apiMock.agentSession).toHaveBeenCalledTimes(1);

    // The Settings card announces the toggle; the pane must pick the provider up
    // without a restart, a reload or a pane reopen.
    apiMock.agentSession.mockResolvedValue(session(true));
    dispatchCliRuntimeVisibilityChange({ runtimeId: "cli:claude", enabled: true, source: "settings-card" });
    // Stage 8: the model is chosen in Settings → Dots; the pane still refreshes which providers Chat can use.
    await waitFor(() => expect(apiMock.agentSession).toHaveBeenCalledTimes(2));
  });

  it("ignores window events that are not CLI runtime visibility changes", async () => {
    apiMock.agentSession.mockResolvedValue(session(false));
    await renderPane();

    window.dispatchEvent(new CustomEvent("space:cli-runtime-visibility-changed", { detail: { source: "other" } }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(apiMock.agentSession).toHaveBeenCalledTimes(1);
  });
});
