import type { AgentRuntime, Pane, SpaceAgentRoomActionRequest, RoomTaskTiming, RoomTaskModelUsage } from "@space/contracts";
import { nowIso, redactMemoryText, SpaceConflictError, type SpaceStore } from "@space/runtime";
import type { SpaceAgentAdapter } from "./space-agent.js";
import type { NativeTaskExecution } from "./room-task-telemetry.js";

export type RoomConfigureAction = Extract<SpaceAgentRoomActionRequest, { toolId: "room:configure_pane" }>["action"];
export type RoomCommandAction = Extract<SpaceAgentRoomActionRequest, { toolId: "room:cli_command" }>["action"];
export interface RoomRuntimeType {
  id: string; title: string; mode: "TERMINAL" | "CHAT";
  terminalRuntimeId?: string; modelId?: string; selectedModelConfigId?: string;
}
export interface RoomPaneObservation {
  paneId: string; title: string; runtimeId: string | null; sessionId: string | null;
  state: "RUNNING" | "IDLE" | "WAITING_FOR_INPUT" | "EXITED" | "ERROR" | "UNKNOWN";
  nativeTaskRef: string | null; modelId: string | null; nativeMode: string | null;
  checkedAt: string; tasks: NativeTaskExecution[];
  models?: Array<{ id: string; supportedReasoningEfforts: string[]; defaultReasoningEffort?: string }>;
  modes?: string[]; commands?: string[]; text?: string;
}
export interface RoomPaneController {
  catalog(roomId: string): Promise<{ types: RoomRuntimeType[]; unavailable: Array<{ id: string; reason: string }> }>;
  inspect(pane: Pane): Promise<RoomPaneObservation>;
  configure(pane: Pane, action: RoomConfigureAction, traceId: string): Promise<Record<string, unknown>>;
  command(pane: Pane, action: RoomCommandAction, traceId: string): Promise<Record<string, unknown>>;
  start(pane: Pane, traceId: string): Promise<Record<string, unknown>>;
  resume(pane: Pane, taskId: string | undefined, traceId: string): Promise<Record<string, unknown>>;
  interrupt(pane: Pane, traceId: string): Promise<Record<string, unknown>>;
}

export function createRoomPaneController(options: {
  store: SpaceStore; chat: SpaceAgentAdapter;
  listRuntimes(): Promise<{ data: AgentRuntime[] }>;
  isEnabled(runtimeId: string): Promise<boolean>;
  chatTypes(): Promise<RoomRuntimeType[]>;
  chatTasks?(pane: Pane): Promise<NativeTaskExecution[]>;
  inspectCli(pane: Pane): Promise<RoomPaneObservation>;
  configureCli(pane: Pane, action: RoomConfigureAction, traceId: string): Promise<Record<string, unknown>>;
  commandCli(pane: Pane, action: RoomCommandAction, traceId: string): Promise<Record<string, unknown>>;
  startCli(pane: Pane, traceId: string): Promise<Record<string, unknown>>;
  resumeCli(pane: Pane, taskId: string | undefined, traceId: string): Promise<Record<string, unknown>>;
  interruptCli(pane: Pane, traceId: string): Promise<Record<string, unknown>>;
}): RoomPaneController {
  async function inspect(pane: Pane): Promise<RoomPaneObservation> {
    if (pane.mode === "TERMINAL") return options.inspectCli(pane);
    const session = pane.mode === "CHAT" ? await options.store.getActiveSpaceAgentSession(pane.id) : null;
    // Reuse the same advertised catalog and effective mode as the Chat UI.
    // The stored selection alone has no model list and may inherit its mode.
    const chatView = session && !pane.isClosed ? await options.chat.loadSession({ pane }) : null;
    if (chatView && chatView.binding.sessionId !== session?.sessionId) throw new SpaceConflictError("The Chat session changed during inspection; inspect it again.");
    const models = new Map<string, { id: string; supportedReasoningEfforts: string[]; defaultReasoningEffort?: string }>();
    for (const option of chatView?.modelOptions ?? []) {
      if (!option.model) continue;
      const model = models.get(option.model) ?? { id: option.model, supportedReasoningEfforts: [] };
      if (option.reasoningKey && !model.supportedReasoningEfforts.includes(option.reasoningKey)) model.supportedReasoningEfforts.push(option.reasoningKey);
      if (option.isDefault && option.reasoningKey) model.defaultReasoningEffort = option.reasoningKey;
      models.set(option.model, model);
    }
    const selected = chatView?.modelOptions.find(option => option.id === chatView.selectedModelConfigId);
    const run = session ? await options.store.getLatestSpaceAgentRun(session.sessionId) : null;
    const messages = session ? await options.store.listSpaceAgentMessages(session.sessionId, 100) : [];
    const nativeTasks = await options.chatTasks?.(pane) ?? [];
    const timing: RoomTaskTiming = { startedAt: null, completedAt: run?.completedAt ?? null,
      durationMs: null, source: run ? "OBSERVED" : "UNKNOWN", observedAt: nowIso() };
    const modelsUsed: RoomTaskModelUsage[] = [];
    return {
      paneId: pane.id, title: pane.title, runtimeId: chatView?.modelProviders.find(provider => provider.isCurrent)?.providerId ?? session?.selectedProviderId ?? pane.providerId,
      sessionId: session?.sessionId ?? null, nativeTaskRef: session?.threadId ?? null,
      modelId: selected?.model ?? session?.selectedModelId ?? pane.modelId, nativeMode: chatView?.collaborationMode ?? session?.collaborationMode ?? null,
      ...(chatView ? { models: [...models.values()], modes: ["default", "plan"] } : {}),
      state: pane.isClosed ? "EXITED" : run?.status === "RUNNING" || run?.status === "QUEUED" ? "RUNNING"
        : run?.status === "FAILED" ? "ERROR" : session?.status === "BLOCKED" ? "WAITING_FOR_INPUT" : "IDLE",
      checkedAt: nowIso(),
      tasks: nativeTasks.length ? nativeTasks : run ? [{ taskId: run.runId, title: messages.find((message) => message.runId === run.runId && message.role === "user")?.content ?? pane.title,
        status: run.status === "COMPLETED" ? "COMPLETED" : run.status === "INTERRUPTED" ? "INTERRUPTED" : run.status === "RUNNING" || run.status === "QUEUED" ? "RUNNING" : "UNKNOWN",
        timing, modelsUsed }] : [],
      text: redactMemoryText(messages.map((message) => message.content).join("\n")).slice(-24_000)
    };
  }
  return {
    async catalog() {
      const registry = await options.listRuntimes();
      const types: RoomRuntimeType[] = [];
      const unavailable: Array<{ id: string; reason: string }> = [];
      for (const runtime of registry.data) {
        if (!runtime.capabilities.includes("CLI") || runtime.id === "cli:root") continue;
        const enabled = await options.isEnabled(runtime.id);
        if (!enabled || runtime.adapterStatus !== "ENABLED" || !runtime.detectedCommandPath || runtime.authState !== "READY") {
          unavailable.push({ id: runtime.id, reason: enabled ? runtime.statusReason : "Disabled in Settings." });
          continue;
        }
        types.push({ id: runtime.id, title: runtime.displayName, mode: "TERMINAL", terminalRuntimeId: runtime.id });
      }
      types.push(...await options.chatTypes());
      return { types, unavailable };
    },
    inspect,
    async configure(pane, action, traceId) {
      if (pane.mode === "TERMINAL") return options.configureCli(pane, action, traceId);
      if (pane.mode !== "CHAT") throw new SpaceConflictError("Model and native mode controls require an AI pane.");
      const before = await options.store.getActiveSpaceAgentSession(pane.id);
      if (!before || before.sessionId !== action.expectedSessionId) throw new SpaceConflictError("The Chat session changed before this command.");
      let selectedModelConfigId = action.selectedModelConfigId;
      if (!selectedModelConfigId && (action.modelId || action.reasoningEffort)) {
        const catalog = await options.chat.loadSession({ pane });
        const matches = catalog.modelOptions.filter((model) => model.model === (action.modelId ?? before.selectedModelId) && (!action.reasoningEffort || model.reasoningKey === action.reasoningEffort));
        selectedModelConfigId = (matches.find((model) => model.isDefault) ?? matches[0])?.id;
        if (!selectedModelConfigId) throw new SpaceConflictError("The selected model is not advertised for this Chat provider.");
      }
      if (action.nativeMode && !["plan", "default", "build"].includes(action.nativeMode)) throw new SpaceConflictError("This Chat provider does not advertise the requested mode.");
      const result = await options.chat.updateSettings({ pane, ...(selectedModelConfigId ? { selectedModelConfigId } : {}),
        ...(action.nativeMode ? { collaborationMode: action.nativeMode === "plan" ? "plan" : "default" } : {}) });
      return { sessionId: result.session.binding.sessionId,
        modelId: result.session.modelOptions.find(model => model.id === result.session.selectedModelConfigId)?.model ?? null,
        selectedModelConfigId: result.session.selectedModelConfigId, nativeMode: result.session.collaborationMode };
    },
    command: options.commandCli,
    async start(pane, traceId) {
      if (pane.mode === "TERMINAL") return options.startCli(pane, traceId);
      if (pane.mode !== "CHAT") throw new SpaceConflictError("Task start requires an AI pane.");
      const session = await options.chat.createOrRestoreSession({ pane });
      return { sessionId: session.binding.sessionId, state: session.runStatus };
    },
    async resume(pane, taskId, traceId) {
      if (pane.mode === "TERMINAL") return options.resumeCli(pane, taskId, traceId);
      if (pane.mode !== "CHAT") throw new SpaceConflictError("Task resume requires an AI pane.");
      const session = await options.chat.loadSession({ pane });
      if (taskId && taskId !== session.threadId && taskId !== session.binding.sessionId) throw new SpaceConflictError("Choose this pane's own Chat task to resume.");
      const result = await options.chat.sendMessage({ pane, content: "Continue the existing task from its last completed step.", traceId });
      return { sessionId: result.session.binding.sessionId, state: result.session.runStatus };
    },
    async interrupt(pane, traceId) {
      if (pane.mode === "TERMINAL") return options.interruptCli(pane, traceId);
      const result = await options.chat.interrupt({ pane, reason: "Interrupted by operator through Room Agent." });
      return { sessionId: result.session.binding.sessionId, state: result.session.runStatus };
    }
  };
}
