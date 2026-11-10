import type { CodexAppServerSocketModelOption } from "@space/codex-app-server";
import type { SpaceStore } from "@space/runtime";
import {
  findSafeCodexThreadResumeSettings,
  resolveCodexThreadRuntimeSettings,
  type CodexThreadResumeSettingsFinder
} from "./cli-terminal.js";
import {
  CodexRuntimeModelSettingsUnconfirmedError, canonicalCodexAdvertisedModelId,
  type CodexRuntimeModelSettings
} from "./codex-model-settings.js";

const codexThreadSettingsConfirmationAttempts = 12;
const codexThreadSettingsConfirmationIntervalMs = 250;

/**
 * A Codex thread's model and effort read back after a switch: the thread's state settings (the effort taken from the
 * transcript tail when the state lacks it and both name the same model), and the bounded wait that confirms a switch
 * or throws CodexRuntimeModelSettingsUnconfirmedError.
 */
export function createCodexThreadSettings(options: {
  store: SpaceStore;
  findCodexThreadResumeSettings?: CodexThreadResumeSettingsFinder;
}) {
  const { store } = options;
  const findCodexThreadRuntimeSettings = async (input: {
    threadId: string;
    cwd: string | null;
    sessionId: string;
    models: CodexAppServerSocketModelOption[];
  }) => {
    const findStateSettings = options.findCodexThreadResumeSettings ?? findSafeCodexThreadResumeSettings;
    const stateSettings = await findStateSettings({
      threadId: input.threadId,
      cwd: input.cwd
    });
    if (stateSettings && stateSettings.reasoningEffort !== null) return stateSettings;
    const transcript = await store.listPaneCliTranscriptChunks(input.sessionId, 48);
    const transcriptSettings = await resolveCodexThreadRuntimeSettings({
      transcript: transcript.map((chunk) => chunk.content).join(""),
      threadId: input.threadId,
      cwd: input.cwd,
      fallback: async () => null
    });
    if (!stateSettings) return transcriptSettings;
    if (!transcriptSettings?.reasoningEffort) return stateSettings;
    const stateModelId = canonicalCodexAdvertisedModelId(stateSettings.modelId, input.models);
    const transcriptModelId = canonicalCodexAdvertisedModelId(transcriptSettings.modelId, input.models);
    return stateModelId && stateModelId === transcriptModelId
      ? { ...stateSettings, reasoningEffort: transcriptSettings.reasoningEffort }
      : stateSettings;
  };
  const waitForCodexThreadSettings = async (input: {
    threadId: string;
    cwd: string | null;
    sessionId: string;
    modelId: string;
    reasoningEffort: string;
    models: CodexAppServerSocketModelOption[];
  }) => {
    let observed: CodexRuntimeModelSettings | null = null;
    for (let attempt = 0; attempt < codexThreadSettingsConfirmationAttempts; attempt += 1) {
      const runtimeSettings = await findCodexThreadRuntimeSettings(input);
      observed = runtimeSettings;
      const confirmedModelId = canonicalCodexAdvertisedModelId(runtimeSettings?.modelId ?? null, input.models);
      if (confirmedModelId === input.modelId && runtimeSettings?.reasoningEffort === input.reasoningEffort) return;
      if (attempt < codexThreadSettingsConfirmationAttempts - 1) {
        await new Promise((resolveConfirmation) => setTimeout(resolveConfirmation, codexThreadSettingsConfirmationIntervalMs));
      }
    }
    throw new CodexRuntimeModelSettingsUnconfirmedError({
      stage: "THREAD_CONFIRMATION",
      expected: { modelId: input.modelId, reasoningEffort: input.reasoningEffort },
      observed,
      attempts: codexThreadSettingsConfirmationAttempts
    });
  };
  return { findCodexThreadRuntimeSettings, waitForCodexThreadSettings };
}
