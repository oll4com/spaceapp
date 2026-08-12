import { ArrowUp, Bot, File, FileVideo, Square, Trash2, X } from "../ui-theme/app-icons.js";
import { useEffect, useMemo, useRef, type FormEvent, type KeyboardEvent } from "react";
import type { AgentPaneModelProvider, PaneCliModelSettings } from "@space/contracts";
import { CodexModelPicker } from "../codex-model-picker/CodexModelPicker.js";
import { api } from "../../api.js";
import { VoiceInputButton } from "../voice-input/VoiceInputButton.js";
import {
  codexModelName,
  type CodexComposerAttachment,
  type CodexModelOption
} from "./codex-chat-types.js";

type CodexModelCatalog = PaneCliModelSettings["models"];

export interface CodexComposerProps {
  paneTitle: string;
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
  onSend: () => void;
  onStop: () => void;
  modelCatalog: CodexModelCatalog;
  modelOptions: CodexModelOption[];
  modelProviders: AgentPaneModelProvider[];
  selectedModelConfigId: string | null;
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
  onModelConfigChange
}: CodexComposerProps) {
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const restorePromptFocusRef = useRef(false);
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

  useEffect(() => {
    const textarea = promptRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = String(Math.min(textarea.scrollHeight, 160)) + "px";
  }, [prompt]);

  useEffect(() => {
    if (pending || !restorePromptFocusRef.current) return;
    restorePromptFocusRef.current = false;
    promptRef.current?.focus();
  }, [pending]);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!isDisabled && canSend && !pending && !isRunning) {
      restorePromptFocusRef.current = true;
      onSend();
    }
  }

  function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
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
        value={prompt}
        onChange={(event) => onPromptChange(event.target.value)}
        onKeyDown={handlePromptKeyDown}
        placeholder="Ask Codex"
        rows={1}
        disabled={pending || isDisabled}
        title={disabledTitle}
      />
      <div className="codex-composer-toolbar" aria-label={"Agent composer controls " + paneTitle}>
        <div className="codex-composer-spacer" />
        <VoiceInputButton label={paneTitle} active={voiceActive} disabled={voiceDisabled || isDisabled} onClick={onVoice} onPrewarm={onVoicePrewarm} />
        {modelSettings ? (
          <span title={disabledTitle}>
            <CodexModelPicker
              settings={modelSettings}
              providers={modelProviders}
              disabled={isDisabled || pending || isRunning || !canSelectModel}
              allowSelectionWithoutCurrent
              onSwitch={switchModel}
            />
          </span>
        ) : <button type="button" className="codex-model-unavailable" aria-label={`Codex model unavailable ${paneTitle}`} title={disabledTitle ?? "Codex model catalog unavailable"} disabled><Bot aria-hidden="true" /></button>}
        <button
          type={isRunning ? "button" : "submit"}
          className="codex-send"
          onClick={isRunning ? onStop : undefined}
          disabled={isDisabled || (isRunning ? !canInterrupt || pending : !canSend || pending)}
          title={disabledTitle}
          aria-label={(isRunning ? "Stop" : "Send") + " " + paneTitle}
        >{isRunning ? <Square aria-hidden="true" fill="currentColor" /> : <ArrowUp aria-hidden="true" />}</button>
      </div>
    </form>
  );
}
