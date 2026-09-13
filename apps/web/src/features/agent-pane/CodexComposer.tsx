import { ArrowUp, Bot, File, FileVideo, Square, Trash2, X } from "../ui-theme/app-icons.js";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { AgentPaneModelProvider, PaneCliModelSettings } from "@space/contracts";
import { CliShortcutsMenu } from "../terminal-pane/CliShortcutsMenu.js";
import { OSK_CLI_COMMANDS, type OskCliCommand } from "../osk-keyboard/cli-shortcuts.js";
import { api } from "../../api.js";
import { VoiceInputButton } from "../voice-input/VoiceInputButton.js";
import {
  codexModelName,
  type CodexComposerAttachment,
  type CodexModelOption
} from "./codex-chat-types.js";

const OSK_CHAT_MODE_COMMANDS = OSK_CLI_COMMANDS.filter(command => Boolean(command.action) || command.id === "plan_progress" || command.id === "deploy");

type CodexModelCatalog = PaneCliModelSettings["models"];

const LazyCodexModelPicker = lazy(() =>
  import("../codex-model-picker/CodexModelPicker.js").then((module) => ({ default: module.CodexModelPicker }))
);
const modelPickerLoadingFallback = (
  <div className="terminal-model-picker">
    <button type="button" className="terminal-model-chip" aria-label="Loading model selector" disabled>
      <Bot aria-hidden="true" />
    </button>
  </div>
);

export interface CodexComposerProps {
  paneTitle: string;
  onShortcut?: (command: OskCliCommand) => void;
  isVisible?: boolean;
  disabledReason?: string | null;
  prompt: string;
  onPromptChange: (value: string) => void;
  attachments: CodexComposerAttachment[];
  onRemoveAttachment: (artifactId: string) => void;
  onClearAttachments: () => void;
  onVoice: () => void;
  onVoicePrewarm?: () => void;
  voiceActive: boolean;
  voiceDisabled: boolean;
  isRunning: boolean;
  canSend: boolean;
  canInterrupt: boolean;
  canSelectModel: boolean;
  pending: boolean;
  onSend: (message?: string) => void;
  onStop: () => void;
  modelCatalog: CodexModelCatalog;
  modelOptions: CodexModelOption[];
  modelProviders: AgentPaneModelProvider[];
  selectedModelConfigId: string | null;
  onRefreshModelCatalog?: () => Promise<void>;
  onModelConfigChange: (modelConfigId: string) => Promise<string | null>;
}

function selectedModel(
  modelOptions: CodexModelOption[],
  selectedModelConfigId: string | null
): NonNullable<PaneCliModelSettings["current"]> | null {
  const option = modelOptions.find((candidate) => candidate.id === selectedModelConfigId);
  const modelId = option ? codexModelName(option).trim() : "";
  const reasoningEffort = option?.reasoningKey?.trim() ?? "";
  return modelId && reasoningEffort ? { modelId, reasoningEffort } : null;
}

function attachmentName(attachment: CodexComposerAttachment): string {
  return String(attachment.metadata.originalFilename ?? attachment.metadata.storedFilename ?? attachment.id);
}

function attachmentKind(attachment: CodexComposerAttachment): "image" | "video" | "file" {
  if (attachment.kind === "IMAGE" || attachment.mimeType.startsWith("image/")) return "image";
  if (attachment.kind === "VIDEO" || attachment.mimeType.startsWith("video/")) return "video";
  return "file";
}

export function CodexComposer({
  paneTitle,
  onShortcut,
  isVisible = true,
  disabledReason = null,
  prompt,
  onPromptChange,
  attachments,
  onRemoveAttachment,
  onClearAttachments,
  onVoice,
  onVoicePrewarm,
  voiceActive,
  voiceDisabled,
  isRunning,
  canSend,
  canInterrupt,
  canSelectModel,
  pending,
  onSend,
  onStop,
  modelCatalog,
  modelOptions,
  modelProviders,
  selectedModelConfigId,
  onRefreshModelCatalog,
  onModelConfigChange
}: CodexComposerProps) {
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const initialPromptRef = useRef(prompt);
  const restorePromptFocusRef = useRef(false);
  const [hasText, setHasText] = useState(() => Boolean(initialPromptRef.current.trim()));
  const modelSettings = useMemo<PaneCliModelSettings | null>(() => {
    if (!modelCatalog.length) return null;
    return {
      sessionId: "native-chat-model-picker",
      threadId: null,
      current: selectedModel(modelOptions, selectedModelConfigId),
      models: modelCatalog,
      controlMode: "DIRECT",
      isTurnActive: isRunning
    };
  }, [isRunning, modelCatalog, modelOptions, selectedModelConfigId]);
  const isDisabled = Boolean(disabledReason);
  const disabledTitle = disabledReason ?? undefined;

  const isComposingRef = useRef(false);
  const debounceTimerRef = useRef<number | null>(null);

  const supportsFieldSizing = typeof CSS !== "undefined" && Boolean(CSS.supports?.("field-sizing", "content"));

  const resizeTextarea = () => {
    if (supportsFieldSizing) return;
    const textarea = promptRef.current;
    if (!textarea) return;
    if (textarea.scrollHeight > textarea.clientHeight) {
      textarea.style.height = String(Math.min(textarea.scrollHeight, 160)) + "px";
    }
  };

  const resetTextareaHeight = () => {
    if (supportsFieldSizing) return;
    const textarea = promptRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    if (textarea.value) {
      textarea.style.height = String(Math.min(textarea.scrollHeight, 160)) + "px";
    }
  };

  useEffect(() => {
    const textarea = promptRef.current;
    if (!textarea) return;
    if (prompt === "") {
      if (textarea.value !== "") {
        textarea.value = "";
      }
      setHasText(false);
      resetTextareaHeight();
    } else if (document.activeElement !== textarea && textarea.value !== prompt) {
      textarea.value = prompt;
      setHasText(Boolean(prompt.trim()));
      resetTextareaHeight();
    }
  }, [prompt]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (pending || !restorePromptFocusRef.current) return;
    restorePromptFocusRef.current = false;
    promptRef.current?.focus();
  }, [pending]);

  const canSubmit = !isDisabled && !pending && !isRunning && (attachments.length > 0 || hasText || canSend);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const currentValue = promptRef.current?.value ?? "";
    const canDoSubmit = !isDisabled && !pending && !isRunning && (attachments.length > 0 || Boolean(currentValue.trim()) || canSend);
    if (canDoSubmit) {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      onPromptChange(currentValue);
      restorePromptFocusRef.current = true;
      onSend(currentValue.trim());
    }
  }

  function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !isComposingRef.current) {
      event.preventDefault();
      submit();
    }
  }

  async function switchModel(modelId: string, reasoningEffort: string, providerId: string | null) {
    if (isDisabled) {
      throw new Error(disabledReason ?? "Codex is disabled.");
    }
    const targetProvider = providerId === null
      ? null
      : modelProviders.find((provider) => provider.providerId === providerId) ?? null;
    if (providerId !== null && !targetProvider) {
      throw new Error("The selected model provider is unavailable.");
    }
    let optionId: string;
    if (targetProvider) {
      const model = targetProvider.models.find((candidate) => candidate.id === modelId);
      if (!model) {
        throw new Error("The selected model configuration is unavailable for this provider.");
      }
      optionId = `${targetProvider.configIdPrefix}${model.id}|${reasoningEffort}`;
    } else {
      const option = modelOptions.find(
        (candidate) => codexModelName(candidate) === modelId && candidate.reasoningKey === reasoningEffort
      );
      if (!option) {
        throw new Error("The selected Codex model configuration is unavailable.");
      }
      optionId = option.id;
    }
    const normalizedModelConfigId = await onModelConfigChange(optionId);
    const normalizedOption = modelOptions.find((candidate) => candidate.id === normalizedModelConfigId);
    const normalizedModelId = normalizedOption ? codexModelName(normalizedOption).trim() : "";
    const normalizedReasoningEffort = normalizedOption?.reasoningKey?.trim() ?? "";
    if (!normalizedModelId || !normalizedReasoningEffort) {
      if (targetProvider && normalizedModelConfigId?.startsWith(targetProvider.configIdPrefix)) {
        const rest = normalizedModelConfigId.slice(targetProvider.configIdPrefix.length);
        const pipe = rest.lastIndexOf("|");
        return {
          current: {
            modelId: pipe > 0 ? rest.slice(0, pipe) : rest,
            reasoningEffort: pipe > 0 ? rest.slice(pipe + 1) : reasoningEffort
          },
          message: null
        };
      }
      throw new Error("The server returned an unavailable Codex model configuration.");
    }
    return {
      current: { modelId: normalizedModelId, reasoningEffort: normalizedReasoningEffort },
      message: null
    };
  }

  return (
    <form className="codex-composer" onSubmit={submit} title={disabledTitle}>
      {attachments.length ? (
        <div className="codex-attachments" aria-label={"Attachments " + paneTitle}>
          {attachments.map((artifact) => {
            const kind = attachmentKind(artifact);
            const name = attachmentName(artifact);
            const extension = name.includes(".") ? name.split(".").at(-1)?.toUpperCase() : kind.toUpperCase();
            return (
              <div className={`codex-attachment-card ${kind}`} data-attachment-kind={kind} key={artifact.id}>
                {kind === "image" ? (
                  <img src={api.artifactFileUrl(artifact.id)} alt={name} loading="lazy" />
                ) : (
                  <div className="codex-attachment-file">
                    {kind === "video" ? <FileVideo aria-hidden="true" /> : <File aria-hidden="true" />}
                    <span><strong>{name}</strong><small>{extension} · {artifact.byteSize.toLocaleString()} bytes</small></span>
                  </div>
                )}
                <button
                  type="button"
                  className="codex-attachment-remove"
                  onClick={() => onRemoveAttachment(artifact.id)}
                  aria-label={`Remove attachment ${name}`}
                  title={disabledTitle ?? "Remove attachment"}
                  disabled={isDisabled}
                >
                  <X aria-hidden="true" />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="codex-attachments-clear"
            onClick={onClearAttachments}
            aria-label="Clear all attachments"
            title={disabledTitle ?? "Clear all attachments"}
            disabled={isDisabled}
          >
            <Trash2 aria-hidden="true" />
          </button>
        </div>
      ) : null}
      <textarea
        ref={promptRef}
        name="agent-message"
        aria-label={"Message " + paneTitle}
        defaultValue={initialPromptRef.current}
        onCompositionStart={() => {
          isComposingRef.current = true;
        }}
        onCompositionEnd={(event) => {
          isComposingRef.current = false;
          const value = event.currentTarget.value;
          const hasNow = Boolean(value.trim());
          if (hasNow !== hasText) {
            setHasText(hasNow);
          }
          if (debounceTimerRef.current !== null) {
            window.clearTimeout(debounceTimerRef.current);
          }
          debounceTimerRef.current = window.setTimeout(() => {
            onPromptChange(value);
          }, 1000);
        }}
        onBlur={(event) => {
          if (debounceTimerRef.current !== null) {
            window.clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = null;
          }
          onPromptChange(event.currentTarget.value);
          resetTextareaHeight();
        }}
        onChange={(event) => {
          const value = event.target.value;
          const hasNow = Boolean(value.trim());
          if (hasNow !== hasText) {
            setHasText(hasNow);
          }
          resizeTextarea();
          if (debounceTimerRef.current !== null) {
            window.clearTimeout(debounceTimerRef.current);
          }
          debounceTimerRef.current = window.setTimeout(() => {
            onPromptChange(value);
          }, 1000);
        }}
        onKeyDown={handlePromptKeyDown}
        placeholder="Ask the selected provider"
        rows={1}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        enterKeyHint="send"
        data-gramm="false"
        data-enable-grammarly="false"
        disabled={pending || isDisabled}
        title={disabledTitle}
      />
      <div className="codex-composer-toolbar" aria-label={"Agent composer controls " + paneTitle}>
        <div className="codex-composer-spacer" />
        {onShortcut ? <CliShortcutsMenu active={isVisible} disabled={isDisabled || pending || isRunning} onCommand={onShortcut} commands={OSK_CHAT_MODE_COMMANDS} /> : null}
        <VoiceInputButton label={paneTitle} active={voiceActive} disabled={voiceDisabled || isDisabled} onClick={onVoice} onPrewarm={onVoicePrewarm} />
        {modelSettings ? (
          <span title={disabledTitle}>
            <Suspense fallback={modelPickerLoadingFallback}>
              <LazyCodexModelPicker
                compact
                settings={modelSettings}
                providers={modelProviders}
                disabled={isDisabled || pending || isRunning || !canSelectModel}
                allowSelectionWithoutCurrent
                onRefreshCatalog={onRefreshModelCatalog}
                onSwitch={switchModel}
              />
            </Suspense>
          </span>
        ) : <button type="button" className="codex-model-unavailable" aria-label={`Codex model unavailable ${paneTitle}`} title={disabledTitle ?? "Codex model catalog unavailable"} disabled><Bot aria-hidden="true" /></button>}
        <button
          type={isRunning ? "button" : "submit"}
          className="codex-send"
          onClick={isRunning ? onStop : undefined}
          disabled={isDisabled || (isRunning ? !canInterrupt || pending : !canSubmit || pending)}
          title={disabledTitle}
          aria-label={(isRunning ? "Stop" : "Send") + " " + paneTitle}
        >{isRunning ? <Square aria-hidden="true" fill="currentColor" /> : <ArrowUp aria-hidden="true" />}</button>
      </div>
    </form>
  );
}
