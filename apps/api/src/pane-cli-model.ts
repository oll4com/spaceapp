import type { CodexAppServerSocketControlService, CodexAppServerSocketModelOption } from "@space/codex-app-server";
import { reasoningEffortSchema, type Pane, type PaneCliModelSettings, type PaneCliSession } from "@space/contracts";
import { SpaceConflictError, SpaceFeatureDisabledError, type SpaceStore } from "@space/runtime";
import {
  createNativeCliModelCatalog, nativeCliConfirmedModel, nativeCliConfirmedReasoning, switchNativeCliModel, switchNativeCliReasoning, withOmpSessionModel
} from "./cli-native-model-picker.js";
import { codexDirectParityCodexHome, isCodexDirectParityRuntime, isDirectOperatorParityRuntime } from "./cli-parity.js";
import { findCliRuntimeDescriptor } from "./cli-runtime-descriptors.js";
import { findRuntime, type createAgentRuntimeRegistryCache } from "./cli-runtimes.js";
import { codexPrivateAppServerSocketPath, type CliTerminalManager, type CodexThreadFinder } from "./cli-terminal.js";
import { cliModelReasoningEffortSchema, canonicalCodexAdvertisedModelId } from "./codex-model-settings.js";
import { codexStaleTurnActivity } from "./codex-rollout-diagnostics.js";
import type { createCodexThreadSettings } from "./codex-thread-settings.js";
import { findCodexWriterThreads } from "./codex-thread-writer.js";
import { resolvePaneCodexThreadId } from "./pane-codex-thread.js";
import { roomTerminalState } from "./room-terminal-screen.js";

/**
 * A CLI pane's model and effort: for native-picker CLIs the advertised catalog with the model and effort read back from the
 * screen, and a switch through the CLI's own picker, confirmed on screen before the session and the pane keep it; for Codex the
 * live app-server's catalog, the pane's thread and its current model, effort and turn activity.
 */
export function createPaneCliModel(options: {
  store: SpaceStore;
  cliTerminalManager: CliTerminalManager;
  cliRuntimeRegistryCache: Pick<ReturnType<typeof createAgentRuntimeRegistryCache>, "read">;
  codexSessionSocketProbe: (socketPath: string) => Promise<boolean>;
  codexSocketControlFactory: (socketPath: string) => CodexAppServerSocketControlService;
  findCodexThreadRuntimeSettings: ReturnType<typeof createCodexThreadSettings>["findCodexThreadRuntimeSettings"];
  findCodexThreadId?: CodexThreadFinder;
  findCodexModelControlThreads?: typeof findCodexWriterThreads;
}) {
  const { store, cliTerminalManager, cliRuntimeRegistryCache, codexSessionSocketProbe, codexSocketControlFactory, findCodexThreadRuntimeSettings } = options;
  const loadNativeCliModels = createNativeCliModelCatalog();
  /** `mark` names each step's finish for the status route's slow-step log (cliRouteSteps). */
  const readScreenNativeModelSettings = async (session: PaneCliSession, mark?: (step: string) => void, signal?: AbortSignal): Promise<PaneCliModelSettings> => {
    const runtime = findRuntime(await cliRuntimeRegistryCache.read(), session.runtimeId);
    mark?.("registry");
    if (!runtime?.detectedCommandPath || !isDirectOperatorParityRuntime(session.runtimeId)) {
      throw new SpaceConflictError("This CLI does not expose a model catalog.");
    }
    const [models, screen] = await Promise.all([
      loadNativeCliModels(
        runtime.detectedCommandPath,
        findCliRuntimeDescriptor(session.runtimeId)?.accountProfileEnv ? session.accountProfileId : null
      ).finally(() => mark?.("catalog")),
      cliTerminalManager.observeRoomScreen(session.sessionId, true, false, signal).finally(() => mark?.("screen"))
    ]);
    // A pane is pinned to its model at launch, which need not be the catalog's first entry.
    const modelId = nativeCliConfirmedModel(screen.text, models, session.runtimeId)
      ?? (models.some(model => model.id === session.modelId) ? session.modelId : null)
      ?? null;
    const model = models.find(entry => entry.id === modelId);
    return {
      sessionId: session.sessionId, threadId: null, models, controlMode: "NATIVE",
      current: modelId ? { modelId, reasoningEffort: nativeCliConfirmedReasoning(screen.text, session.runtimeId, model)
        ?? (session.modelId === modelId && model?.supportedReasoningEfforts.includes(session.reasoningEffort ?? '') ? session.reasoningEffort! : 'unknown') } : null,
      isTurnActive: roomTerminalState(screen.text) === "RUNNING"
    };
  };
  const readPaneNativeModelSettings = (session: PaneCliSession, mark?: (step: string) => void, signal?: AbortSignal) =>
    withOmpSessionModel(readScreenNativeModelSettings(session, mark, signal), session, cliTerminalManager, store);
  /** Switches a native-picker CLI to an advertised model and effort with screen readback, then
   * records it on the session and the pane (the pane's next session starts on it). Callers serialize. */
  const applyNativePaneModel = async (input: {
    pane: Pane;
    active: PaneCliSession;
    modelId: string;
    reasoningEffort: string;
    traceId: string;
    assertControl: (current: PaneCliSession) => Promise<void>;
  }) => {
    const { pane, active, traceId } = input;
    const before = await readPaneNativeModelSettings(active);
    let model = before.models.find((entry) => entry.id === input.modelId);
    if (!model || !model.supportedReasoningEfforts.includes(input.reasoningEffort)) {
      throw new SpaceConflictError("The selected model settings are not advertised by this CLI.");
    }
    if (active.runtimeId === 'cli:gemini' && model.reasoningOptions?.length) {
      const variantId = model.id.replace(/-(low|medium|high)$/, `-${input.reasoningEffort}`);
      model = before.models.find(entry => entry.id === variantId) ?? model;
    }
    if (before.isTurnActive) throw new SpaceConflictError("Wait for this CLI turn to finish before changing models.");
    const assertCurrent = async () => {
      const current = await store.getActivePaneCliSession(pane.id);
      if (!current?.isActive || current.sessionId !== active.sessionId || current.status === "EXITED" || current.status === "ERROR") {
        throw new SpaceConflictError("The CLI session changed during the model switch.");
      }
      await input.assertControl(current);
    };
    let step = 0;
    await switchNativeCliModel({ model, effort: input.reasoningEffort, runtimeId: active.runtimeId, assertCurrent,
      read: () => cliTerminalManager.observeRoomScreen(active.sessionId, true),
      readUndimmed: () => cliTerminalManager.observeRoomScreenUndimmed(active.sessionId),
      write: (data) => cliTerminalManager.sendInput(active.sessionId, data, traceId, null, `model-picker:${traceId}:${step++}`),
      // Claude's /model menu needs ~100x30; a narrower pane is fitted for the pick and given back its size.
      widen: async () => {
        const fit = await cliTerminalManager.fitPaneTerminal(pane.id, 100, 30);
        const [cols, rows] = fit?.before?.split("x").map(Number) ?? [];
        return fit ? async () => { if (cols && rows) await cliTerminalManager.fitPaneTerminal(pane.id, cols, rows); } : null;
      }
    });
    // Preserve the confirmed model even if its separate effort command fails.
    await store.updatePaneCliSession(active.sessionId, { modelId: model.id, reasoningEffort: "unknown" }, traceId);
    // Gemini, OMP, Claude and Droid apply the effort together with the model.
    if (active.runtimeId !== 'cli:gemini' && active.runtimeId !== 'cli:omp' && active.runtimeId !== 'cli:claude' && active.runtimeId !== 'cli:droid') await switchNativeCliReasoning({ model, effort: input.reasoningEffort, runtimeId: active.runtimeId, assertCurrent,
      read: () => cliTerminalManager.observeRoomScreen(active.sessionId, true),
      write: data => cliTerminalManager.sendInput(active.sessionId, data, traceId, null, `reasoning-picker:${traceId}:${step++}`)
    });
    await assertCurrent();
    const current = { modelId: model.id, reasoningEffort: input.reasoningEffort };
    const updated = await store.updatePaneCliSession(active.sessionId, current, traceId);
    const paneEffort = reasoningEffortSchema.safeParse(input.reasoningEffort);
    if (paneEffort.success) {
      // A pick belongs to this pane: its next session (restart, resume) starts on it.
      await store.updatePane(pane.id, { modelId: model.id, reasoningEffort: paneEffort.data }, traceId);
    }
    return { before, current, updated };
  };
  const readPaneCliModelSettings = async (pane: Pane, session: PaneCliSession, traceId: string) => {
    if (!isCodexDirectParityRuntime(session.runtimeId)) {
      throw new SpaceConflictError("Model switching is available only for Codex CLI panes.");
    }
    let refreshedSession = (await store.getPaneCliSession(session.sessionId)) ?? session;
    const socketPath = codexPrivateAppServerSocketPath(refreshedSession);
    const directAvailable = await codexSessionSocketProbe(socketPath);
    if (!directAvailable) {
      throw new SpaceFeatureDisabledError(
        "CODEX_SESSION_CONTROL_UNAVAILABLE",
        "Live Codex model control is unavailable; the current CLI session was left unchanged."
      );
    }
    const directControl = codexSocketControlFactory(socketPath);
    let models: CodexAppServerSocketModelOption[];
    try {
      models = await directControl.listModels();
    } catch {
      throw new SpaceFeatureDisabledError(
        "CODEX_SESSION_CONTROL_UNAVAILABLE",
        "Live Codex model control is unavailable; the current CLI session was left unchanged."
      );
    }
    if (!models.length) {
      throw new SpaceFeatureDisabledError("CODEX_MODEL_CATALOG_UNAVAILABLE", "Codex did not advertise any selectable models.");
    }
    // The TUI can restore a task without replacing its Space CLI session.
    // Its confirmed selection outranks persisted ownership and writer locks.
    // undefined means an older multiplexer; null means a selection is pending.
    const primaryThreadId = await directControl.readCurrentThreadId?.().catch(() => {
      throw new SpaceFeatureDisabledError(
        "CODEX_SESSION_CONTROL_UNAVAILABLE",
        "Live Codex model control is unavailable; the current CLI session was left unchanged."
      );
    });
    let threadId = primaryThreadId !== undefined ? primaryThreadId : await resolvePaneCodexThreadId({
      store, session: refreshedSession, traceId, findThreadId: options.findCodexThreadId
    });
    if (primaryThreadId === undefined) refreshedSession = (await store.getPaneCliSession(session.sessionId)) ?? refreshedSession;
    // A fresh TUI already owns a native thread before its first message is
    // persisted. Resolve only this app-server's kernel-held writer lock; never
    // drive its composer with /model or Enter to change settings.
    if (primaryThreadId === undefined && !threadId && directControl.readThreadSettings) {
      const candidates = await (options.findCodexModelControlThreads ?? findCodexWriterThreads)({
        codexHome: codexDirectParityCodexHome, paneId: pane.id, sessionId: session.sessionId
      });
      if (candidates.length === 1) threadId = candidates[0]!;
    }
    // A just-started or just-resumed Codex can reject thread/read briefly;
    // report it like an unavailable catalog instead of a server error.
    const nativeSettings = threadId && directControl.readThreadSettings
      ? await directControl.readThreadSettings(threadId).catch(() => {
          throw new SpaceFeatureDisabledError(
            "CODEX_SESSION_CONTROL_UNAVAILABLE",
            "Live Codex model control is unavailable; the current CLI session was left unchanged."
          );
        })
      : null;
    const isSessionOwnedThread = refreshedSession.codexThreadId === threadId;
    if (nativeSettings && nativeSettings.cwd !== refreshedSession.cwd && !isSessionOwnedThread && primaryThreadId !== threadId) {
      throw new SpaceConflictError("Codex model control did not confirm this pane's working directory.");
    }
    const runtimeSettings = nativeSettings ?? (threadId
      ? await findCodexThreadRuntimeSettings({
          threadId,
          cwd: refreshedSession.cwd,
          sessionId: refreshedSession.sessionId,
          models
        })
      : null);
    const effectiveModelId = runtimeSettings ? runtimeSettings.modelId : refreshedSession.modelId;
    const effectiveReasoningEffort = runtimeSettings ? runtimeSettings.reasoningEffort : refreshedSession.reasoningEffort;
    const currentModelId = canonicalCodexAdvertisedModelId(effectiveModelId, models);
    const currentReasoningEffort = cliModelReasoningEffortSchema.safeParse(effectiveReasoningEffort).data;
    const persistedCombinationIsAdvertised = runtimeSettings !== null || Boolean(
      currentModelId &&
      currentReasoningEffort &&
      models.some(
        (model) => model.id === currentModelId && model.supportedReasoningEfforts.includes(currentReasoningEffort)
      )
    );
    const current = currentModelId && currentReasoningEffort && persistedCombinationIsAdvertised
      ? { modelId: currentModelId, reasoningEffort: currentReasoningEffort }
      : null;
    const screen = await cliTerminalManager.observeRoomScreen(refreshedSession.sessionId, true).catch(() => null);
    const screenIsRunning = screen ? roomTerminalState(screen.text) === "RUNNING" : false;
    const activity = threadId ? codexStaleTurnActivity(pane.id, threadId, await cliTerminalManager.getCurrentTurnActivity(refreshedSession.sessionId),
      nativeSettings ? nativeSettings.isTurnActive : null, screen?.text ?? null) // R16-5: a turn Codex never finished ends after 2 idle minutes.
      : { status: "PENDING" as const, turnId: null };
    return {
      settings: {
        sessionId: refreshedSession.sessionId,
        threadId,
        current,
        models,
        controlMode: "DIRECT" as const,
        isTurnActive: Boolean(nativeSettings?.isTurnActive || activity.status === "RUNNING" || screenIsRunning)
      },
      activity,
      directControl,
      primaryThreadId,
      controlCwd: nativeSettings?.cwd ?? refreshedSession.cwd,
      session: refreshedSession
    };
  };
  return { loadNativeCliModels, readPaneNativeModelSettings, applyNativePaneModel, readPaneCliModelSettings };
}
