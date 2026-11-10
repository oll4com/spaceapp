import {
  cliModelIdentifierSchema,
  type Pane,
  type PaneCliModelSettings,
  type PaneCliSession
} from "@space/contracts";
import {
  fetchOpenCodeCurrentModel,
  fetchOpenCodeSessionIsTurnActive,
  fetchOpenCodeSessionModels,
  parseOpenCodeCompositeModelId,
  readOpenCodeSessionTurnActive,
  switchOpenCodeSessionModel,
  type OpenCodeServerControl
} from "@space/opencode-control";
import { SpaceConflictError, SpaceFeatureDisabledError, type SpaceStore } from "@space/runtime";
import { openCodeCurrentSelectionWithSource, openCodeTuiSelection } from "./cli-opencode-model-picker.js";
import type { CliTerminalManager } from "./cli-terminal.js";
import { roomTerminalState } from "./room-terminal-screen.js";

/**
 * An OpenCode pane's model picker: the server's catalog (Space Gateway's models first), the current model and effort read
 * from the server, the TUI and the session (the pane and session follow what the CLI really runs), and a switch that waits
 * for an idle turn, then for the server to confirm the model and effort before anything is saved.
 */
export function createOpenCodePaneModel(options: {
  store: SpaceStore;
  cliTerminalManager: CliTerminalManager;
  resolveOpenCodeServerControl: (session: PaneCliSession) => Promise<OpenCodeServerControl>;
}) {
  const { store, cliTerminalManager, resolveOpenCodeServerControl } = options;
  const readPaneOpenCodeModelSettings = async (pane: Pane, session: PaneCliSession, traceId: string) => {
    const control = await resolveOpenCodeServerControl(session);
    const refreshedSession = (await store.getPaneCliSession(session.sessionId)) ?? session;
    let models: PaneCliModelSettings["models"];
    try {
      const descriptors = await fetchOpenCodeSessionModels(control, session.cwd ?? '/etc');
      const currentModel = await fetchOpenCodeCurrentModel(control, control.nativeSessionId);
      const currentModelId = currentModel ? `${currentModel.providerID}/${currentModel.id}` : null;
      models = descriptors.flatMap((descriptor) => {
        const optionId = `${descriptor.providerId}/${descriptor.modelId}`;
        if (!cliModelIdentifierSchema.safeParse(optionId).success) return [];
        const listedVariants = descriptor.variants.length > 0 ? descriptor.variants : [];
        return [{
          id: optionId,
          displayName: descriptor.displayName,
          description: descriptor.providerName ?? descriptor.providerId,
          isDefault: optionId === currentModelId,
          defaultReasoningEffort:
            descriptor.defaultVariant ?? listedVariants[0] ?? "default",
          supportedReasoningEfforts: ["default", ...listedVariants.filter(variant => variant !== "default")],
          reasoningOptions: (listedVariants.length ? ["default", ...listedVariants.filter(variant => variant !== "default")] : []).map((reasoningEffort) => ({ reasoningEffort }))
        }];
      // Space Gateway's models first, so a picker search finds them ahead of the hundreds of OpenRouter rows.
      }).sort((left, right) => Number(!left.id.startsWith("space-gateway")) - Number(!right.id.startsWith("space-gateway")));
    } catch {
      throw new SpaceFeatureDisabledError(
        "OPENCODE_SESSION_CONTROL_UNAVAILABLE",
        "Live OpenCode model control is unavailable; the current CLI session was left unchanged."
      );
    }
    if (!models.length) {
      throw new SpaceFeatureDisabledError("OPENCODE_MODEL_CATALOG_UNAVAILABLE", "OpenCode did not advertise any selectable models.");
    }
    const currentModel = await fetchOpenCodeCurrentModel(control, control.nativeSessionId).catch(() => null);
    const currentModelOption = currentModel
      ? models.find(
          (model) => model.id === `${currentModel.providerID}/${currentModel.id}`
        ) ?? null
      : null;
    const nativeScreen = await cliTerminalManager.observeRoomScreen(session.sessionId).catch(() => null);
    const nativeCurrent = nativeScreen ? openCodeTuiSelection(nativeScreen.text, models) : null;
    const serverCurrent = currentModel
      ? {
          modelId: `${currentModel.providerID}/${currentModel.id}`,
          reasoningEffort: currentModelOption && currentModel.variant
            ? (currentModelOption.supportedReasoningEfforts.includes(currentModel.variant)
              ? currentModel.variant
              : currentModelOption.defaultReasoningEffort)
            : "default"
        }
      : null;
    const currentSelection = openCodeCurrentSelectionWithSource(refreshedSession.modelId, serverCurrent, nativeCurrent, models, refreshedSession.reasoningEffort);
    const current = currentSelection.current;
    if (current?.modelId && (refreshedSession.modelId !== current.modelId || refreshedSession.reasoningEffort !== current.reasoningEffort)) {
      try {
        await store.updatePaneCliSession(refreshedSession.sessionId, {
          modelId: current.modelId,
          reasoningEffort: current.reasoningEffort ?? "default"
        }, traceId);
        await store.updatePane(pane.id, {
          modelId: current.modelId
        }, traceId);
      } catch {}
    }
    const screen = await cliTerminalManager.observeRoomScreen(session.sessionId, true).catch(() => null);
    const screenIsRunning = screen ? roomTerminalState(screen.text) === "RUNNING" : false;
    const serverTurnActive = await fetchOpenCodeSessionIsTurnActive(control, control.nativeSessionId);
    const isTurnActive = Boolean(serverTurnActive || screenIsRunning);
    return {
      settings: {
        sessionId: refreshedSession.sessionId,
        threadId: null,
        current,
        models,
        controlMode: "OPENCODE" as const,
        isTurnActive,
        // A session-default reading means the picker can only show the pane's
        // persisted default: the CLI's real model was not readable yet.
        ...(currentSelection.source ? { currentSource: currentSelection.source } : {})
      },
      session: refreshedSession
    };
  };
  const applyOpenCodePaneSelection = async (
    pane: Pane, session: PaneCliSession, model: PaneCliModelSettings["models"][number], effort: string,
    traceId: string, assertControl?: (current: PaneCliSession) => Promise<void>,
    allModels?: PaneCliModelSettings["models"]
  ) => cliTerminalManager.runSerializedTerminalMutation(session.sessionId, async () => {
    if (!model.supportedReasoningEfforts.includes(effort)) throw new SpaceConflictError("This reasoning level is not advertised by OpenCode.");
    const control = await resolveOpenCodeServerControl(session);
    const turnActive = await readOpenCodeSessionTurnActive(control, control.nativeSessionId);
    if (turnActive !== false) throw new SpaceConflictError(turnActive ? "Wait for the OpenCode turn to finish before changing model settings." : "OpenCode did not report whether a turn is running; try again.");
    const assertCurrent = async () => {
      const current = await store.getActivePaneCliSession(pane.id);
      if (!current?.isActive || current.sessionId !== session.sessionId || current.status === "EXITED" || current.status === "ERROR") {
        throw new SpaceConflictError("The OpenCode session changed during model selection.");
      }
      await assertControl?.(current);
    };
    // OpenCode 2's TUI follows the server's session model live, so the server switch below is the whole change.
    await assertCurrent();
    const ref = parseOpenCodeCompositeModelId(model.id)!;
    try {
      await switchOpenCodeSessionModel(control, control.nativeSessionId, ref.providerId, ref.modelId, effort,
        model.supportedReasoningEfforts.filter(value => value !== "default"));
    } catch {
      throw new SpaceConflictError("OpenCode server rejected the model switch. Reopen the picker to refresh its current settings.");
    }
    // The server applies selections asynchronously and the TUI menu markers
    // can be graphics-wrapped: confirm the settled server model AND effort
    // with retries before persisting anything.
    const serverSelectionMatches = async (): Promise<boolean> => {
      const confirmed = await fetchOpenCodeCurrentModel(control, control.nativeSessionId).catch(() => null);
      if (!confirmed || `${confirmed.providerID}/${confirmed.id}` !== model.id) return false;
      const serverEffort = !confirmed.variant ? "default"
        : (model.supportedReasoningEfforts.includes(confirmed.variant) ? confirmed.variant : model.defaultReasoningEffort);
      return serverEffort === effort;
    };
    let serverConfirmed = await serverSelectionMatches();
    for (let i = 0; i < 30 && !serverConfirmed; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      serverConfirmed = await serverSelectionMatches();
    }
    if (!serverConfirmed) {
      throw new SpaceConflictError("OpenCode server did not confirm the selected model. Reopen the picker to refresh its current settings.");
    }
    await store.updatePaneCliSession(session.sessionId, {modelId:model.id,reasoningEffort:effort}, traceId);
    try { await store.updatePane(pane.id, {modelId:model.id}, traceId); } catch {}
  });

  return { readPaneOpenCodeModelSettings, applyOpenCodePaneSelection };
}
