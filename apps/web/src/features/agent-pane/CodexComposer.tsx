import { ArrowUp, Bot, Camera, File, FileVideo, Keyboard, Monitor, Paperclip, Plus, Sparkles, Square, Trash2, X } from "../ui-theme/app-icons.js";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
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
import {
  convertTextRange,
  createGreekInputState,
  detectKeyboardLayoutMismatch,
  handleEnglishKeyInput,
  handleGreekKeyInput,
  insertTextAtCursor,
  type LayoutMismatchDetection
} from "./greek-layout-converter.js";
import {
  isComposerLayoutIconVisible,
  isComposerSuggestionBarVisible,
  playLayoutSuggestionBeep,
  useKeyboardAutocorrectSettings
} from "../keyboard-autocorrect/keyboard-autocorrect-settings.js";

const OSK_CHAT_MODE_COMMANDS = OSK_CLI_COMMANDS.filter(command => Boolean(command.action) || command.id === "plan_progress" || command.id === "deploy" || command.id === "clean_worktree");

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
  focusRequestKey?: number;
  restorePromptKey?: number;
  onPromptChange: (value: string) => void;
  attachments: CodexComposerAttachment[];
  onRemoveAttachment: (artifactId: string) => void;
  onClearAttachments: () => void;
  onVoice: () => void;
  onAddFiles?: () => void;
  onSetGoal?: () => void;
  onVisualContext?: (source: "screen" | "camera") => void;
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
  focusRequestKey = 0,
  restorePromptKey = 0,
  onPromptChange,
  attachments,
  onRemoveAttachment,
  onClearAttachments,
  onVoice,
  onAddFiles,
  onSetGoal,
  onVisualContext,
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
  const lastFocusRequestKeyRef = useRef(focusRequestKey);
  const lastRestorePromptKeyRef = useRef(restorePromptKey);
  const initialPromptRef = useRef(prompt);
  const lastEmittedPromptRef = useRef(prompt);
  const restorePromptFocusRef = useRef(false);
  const isComposingRef = useRef(false);
  const debounceTimerRef = useRef<number | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [hasText, setHasText] = useState(() => Boolean(initialPromptRef.current.trim()));
  const [layoutSuggestion, setLayoutSuggestion] = useState<LayoutMismatchDetection | null>(null);
  const dismissedLayoutTextRef = useRef<string | null>(null);
  const { settings: autocorrectSettings } = useKeyboardAutocorrectSettings();
  const prevLayoutSuggestionRef = useRef(false);
  const [typingLayoutMode, setTypingLayoutMode] = useState<"el" | "en" | null>(null);
  const greekTypingMode = typingLayoutMode === "el";
  const greekInputStateRef = useRef(createGreekInputState(false));

  const setTypingMode = useCallback((mode: "el" | "en" | null) => {
    setTypingLayoutMode(mode);
    greekInputStateRef.current.enabled = mode === "el";
    if (mode) {
      try {
        const desktop = (window as any).spaceDesktop;
        if (typeof desktop?.switchKeyboardLayout === "function") {
          desktop.switchKeyboardLayout(mode).catch(() => {});
        }
      } catch {}
    }
  }, []);

  const layoutCheckDebounceRef = useRef<number | null>(null);

  const checkLayoutMismatch = useCallback((text: string, immediate?: boolean) => {
    if (layoutCheckDebounceRef.current !== null) {
      window.clearTimeout(layoutCheckDebounceRef.current);
      layoutCheckDebounceRef.current = null;
    }
    if (!autocorrectSettings.enabled || !text.trim() || text === dismissedLayoutTextRef.current) {
      setLayoutSuggestion(null);
      return;
    }
    const runCheck = () => {
      layoutCheckDebounceRef.current = null;
      const detection = detectKeyboardLayoutMismatch(text);
      const isLangSupported = (detection.direction === "toGreek" && autocorrectSettings.supportedLanguages.includes("el")) ||
        (detection.direction === "toQwerty" && autocorrectSettings.supportedLanguages.includes("en"));

      if (detection.hasMismatch && detection.confidence >= 0.85 && isLangSupported) {
        setLayoutSuggestion(detection);
      } else {
        setLayoutSuggestion(null);
      }
    };
    const isTest = typeof process !== "undefined" && (process.env?.NODE_ENV === "test" || process.env?.VITEST === "true");
    if (immediate || isTest) {
      runCheck();
    } else {
      layoutCheckDebounceRef.current = window.setTimeout(runCheck, 180);
    }
  }, [autocorrectSettings.enabled, autocorrectSettings.supportedLanguages]);

  useEffect(() => {
    if (layoutSuggestion && !prevLayoutSuggestionRef.current) {
      if (autocorrectSettings.enabled && autocorrectSettings.soundEnabled) {
        playLayoutSuggestionBeep();
      }
    }
    prevLayoutSuggestionRef.current = Boolean(layoutSuggestion);
  }, [layoutSuggestion, autocorrectSettings.enabled, autocorrectSettings.soundEnabled]);

  const applyLayoutFix = useCallback((explicitReplacement?: string) => {
    const textarea = promptRef.current;
    if (!textarea) return;
    const currentVal = textarea.value;
    if (!currentVal) return;
    dismissedLayoutTextRef.current = null;

    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (layoutCheckDebounceRef.current !== null) {
      window.clearTimeout(layoutCheckDebounceRef.current);
      layoutCheckDebounceRef.current = null;
    }

    let targetText = explicitReplacement;

    if (explicitReplacement !== undefined) {
      textarea.value = explicitReplacement;
      lastEmittedPromptRef.current = explicitReplacement;
      setHasText(Boolean(explicitReplacement.trim()));
      setLayoutSuggestion(null);
      onPromptChange(explicitReplacement);
      resizeTextarea();
      textarea.focus();
    } else {
      const selStart = textarea.selectionStart ?? 0;
      const selEnd = textarea.selectionEnd ?? 0;
      const converted = convertTextRange(currentVal, selStart, selEnd, "toggle");
      targetText = converted.newText;
      textarea.value = converted.newText;
      lastEmittedPromptRef.current = converted.newText;
      textarea.setSelectionRange(converted.newStart, converted.newEnd);
      setHasText(Boolean(converted.newText.trim()));
      setLayoutSuggestion(null);
      onPromptChange(converted.newText);
      resizeTextarea();
      textarea.focus();
    }

    const isGreekTarget = /[\u0370-\u03FF]/.test(targetText ?? "");
    const changed = targetText !== currentVal;
    console.log("[GreekLayoutComposer] applyLayoutFix executed:", {
      original: currentVal,
      targetText,
      changed,
      isGreekTarget
    });
    if (changed) {
      setTypingMode(isGreekTarget ? "el" : "en");
    } else {
      const nextMode = typingLayoutMode === "el" ? "en" : "el";
      setTypingMode(nextMode);
    }
  }, [onPromptChange, setTypingMode, typingLayoutMode]);

  const modelSettings = useMemo<PaneCliModelSettings | null>(() => {
    // A provider with an unavailable catalog must not hide the picker: the working
    // providers stay selectable so the user can switch away from the inactive one.
    if (!modelCatalog.length && !modelProviders.some((provider) => provider.models.length > 0)) return null;
    return {
      sessionId: "native-chat-model-picker",
      threadId: null,
      current: selectedModel(modelOptions, selectedModelConfigId),
      models: modelCatalog,
      controlMode: "DIRECT",
      isTurnActive: isRunning
    };
  }, [isRunning, modelCatalog, modelOptions, modelProviders, selectedModelConfigId]);
  const isDisabled = Boolean(disabledReason);
  const disabledTitle = disabledReason ?? undefined;

  useEffect(() => {
    if (focusRequestKey === lastFocusRequestKeyRef.current) return;
    lastFocusRequestKeyRef.current = focusRequestKey;
    if (isVisible && !isDisabled) promptRef.current?.focus();
  }, [focusRequestKey, isVisible, isDisabled]);

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
    if (lastRestorePromptKeyRef.current !== restorePromptKey) {
      lastRestorePromptKeyRef.current = restorePromptKey;
      if (debounceTimerRef.current !== null) window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
      textarea.value = prompt;
      lastEmittedPromptRef.current = prompt;
      setHasText(Boolean(prompt.trim()));
      checkLayoutMismatch(prompt);
      resetTextareaHeight();
      return;
    }
    if (prompt === "") {
      if (textarea.value !== "") {
        textarea.value = "";
      }
      lastEmittedPromptRef.current = "";
      setHasText(false);
      setLayoutSuggestion(null);
      resetTextareaHeight();
    } else if (prompt !== lastEmittedPromptRef.current && document.activeElement !== textarea && textarea.value !== prompt) {
      textarea.value = prompt;
      lastEmittedPromptRef.current = prompt;
      setHasText(Boolean(prompt.trim()));
      checkLayoutMismatch(prompt);
      resetTextareaHeight();
    }
    // An immediate submit can batch the debounced draft and its reset to the
    // same empty prop. The pending transition must still clear the DOM value.
  }, [prompt, pending, restorePromptKey, checkLayoutMismatch]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
      }
      if (layoutCheckDebounceRef.current !== null) {
        window.clearTimeout(layoutCheckDebounceRef.current);
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
    if (layoutCheckDebounceRef.current !== null) {
      window.clearTimeout(layoutCheckDebounceRef.current);
      layoutCheckDebounceRef.current = null;
    }
    let currentValue = promptRef.current?.value ?? "";
    if (autocorrectSettings.enabled) {
      const layoutCheck = detectKeyboardLayoutMismatch(currentValue);
      const isLangSupported = (layoutCheck.direction === "toGreek" && autocorrectSettings.supportedLanguages.includes("el")) ||
        (layoutCheck.direction === "toQwerty" && autocorrectSettings.supportedLanguages.includes("en"));
      if (!layoutCheck.requiresConfirmation && layoutCheck.hasMismatch && layoutCheck.confidence >= 0.90 && layoutCheck.direction === "toGreek" && isLangSupported) {
        currentValue = layoutCheck.convertedText;
        if (promptRef.current) {
          promptRef.current.value = currentValue;
        }
        setLayoutSuggestion(null);
      }
    }
    const canDoSubmit = !isDisabled && !pending && !isRunning && (attachments.length > 0 || Boolean(currentValue.trim()) || canSend);
    if (canDoSubmit) {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      lastEmittedPromptRef.current = currentValue;
      onPromptChange(currentValue);
      restorePromptFocusRef.current = true;
      onSend(currentValue.trim());
    }
  }

  function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const isGKey = event.code === "KeyG" || event.key.toLowerCase() === "g" || event.key === "γ" || event.key === "Γ" || event.key === "©";
    if (autocorrectSettings.enabled && (event.altKey || (event.ctrlKey && event.shiftKey)) && isGKey) {
      event.preventDefault();
      if (layoutCheckDebounceRef.current !== null) {
        window.clearTimeout(layoutCheckDebounceRef.current);
        layoutCheckDebounceRef.current = null;
      }
      const textarea = promptRef.current;
      console.log("[GreekLayoutComposer] Alt+G pressed:", {
        hasSuggestion: Boolean(layoutSuggestion),
        currentValue: textarea?.value,
        mode: typingLayoutMode ?? "none"
      });
      const activeSuggestion = layoutSuggestion || (textarea?.value ? detectKeyboardLayoutMismatch(textarea.value) : null);
      if (activeSuggestion && activeSuggestion.hasMismatch) {
        applyLayoutFix(activeSuggestion.convertedText);
      } else if (textarea && textarea.value.trim()) {
        applyLayoutFix();
      } else {
        const nextMode = typingLayoutMode === "el" ? "en" : "el";
        setTypingMode(nextMode);
      }
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !isComposingRef.current) {
      event.preventDefault();
      submit();
      return;
    }
    if (typingLayoutMode === "el" && greekInputStateRef.current.enabled && promptRef.current) {
      const textarea = promptRef.current;
      const handled = handleGreekKeyInput(event, greekInputStateRef.current, (char) => {
        insertTextAtCursor(textarea, char);
        setHasText(Boolean(textarea.value.trim()));
        checkLayoutMismatch(textarea.value);
        resizeTextarea();
      });
      if (handled) return;
    } else if (typingLayoutMode === "en" && promptRef.current) {
      const textarea = promptRef.current;
      const handled = handleEnglishKeyInput(event, (char) => {
        insertTextAtCursor(textarea, char);
        setHasText(Boolean(textarea.value.trim()));
        checkLayoutMismatch(textarea.value);
        resizeTextarea();
      });
      if (handled) return;
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
    <form className="codex-composer" onSubmit={submit} title={disabledTitle} onKeyDown={(event) => { if (event.key === "Escape") { setAddMenuOpen(false); } }}>
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
      {layoutSuggestion && isComposerSuggestionBarVisible(autocorrectSettings) ? (
        <div className="codex-layout-suggestion" role="status" aria-live="polite">
          <Keyboard aria-hidden="true" style={{ width: 14, height: 14, flexShrink: 0 }} />
          <span className="codex-layout-suggestion-label">
            Wrong layout? Convert to: <strong>{layoutSuggestion.convertedText.length > 48 ? layoutSuggestion.convertedText.slice(0, 48) + "…" : layoutSuggestion.convertedText}</strong>
          </span>
          <button
            type="button"
            className="codex-layout-apply-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => applyLayoutFix(layoutSuggestion.convertedText)}
            title="Apply layout conversion (Alt+G)"
          >
            Fix (Alt+G)
          </button>
          <button
            type="button"
            className="codex-layout-dismiss-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              dismissedLayoutTextRef.current = promptRef.current?.value ?? "";
              setLayoutSuggestion(null);
            }}
            aria-label="Dismiss layout suggestion"
          >
            <X aria-hidden="true" style={{ width: 14, height: 14 }} />
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
          lastEmittedPromptRef.current = value;
          checkLayoutMismatch(value);
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
          const val = event.currentTarget.value;
          lastEmittedPromptRef.current = val;
          onPromptChange(val);
          resetTextareaHeight();
        }}
        onChange={(event) => {
          const value = event.target.value;
          const hasNow = Boolean(value.trim());
          if (hasNow !== hasText) {
            setHasText(hasNow);
          }
          lastEmittedPromptRef.current = value;
          checkLayoutMismatch(value);
          resizeTextarea();
          if (debounceTimerRef.current !== null) {
            window.clearTimeout(debounceTimerRef.current);
          }
          debounceTimerRef.current = window.setTimeout(() => {
            onPromptChange(value);
          }, 1000);
        }}
        onKeyDown={handlePromptKeyDown}
        placeholder="Ask anything, or give me a goal…"
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
        {onAddFiles ? <button type="button" className="room-agent-add-trigger" aria-label="Add files or set a goal" aria-expanded={addMenuOpen} disabled={isDisabled || pending} onClick={() => { setAddMenuOpen(value => !value); }}><Plus aria-hidden="true" /></button> : null}
        {addMenuOpen && onAddFiles ? <div className="room-agent-add-menu" role="group" aria-label="Add to conversation">
          <button type="button" onClick={() => { setAddMenuOpen(false); onAddFiles(); }}><Paperclip aria-hidden="true" /><span><strong>Files</strong><small>Attach a document or image</small></span></button>
          {onSetGoal ? <button type="button" onClick={() => { setAddMenuOpen(false); onSetGoal(); }}><Sparkles aria-hidden="true" /><span><strong>Set a goal</strong><small>Keep the objective in this chat</small></span></button> : null}
          {onVisualContext ? <><button type="button" onClick={() => { setAddMenuOpen(false); onVisualContext("screen"); }}><Monitor aria-hidden="true" /><span><strong>Screen</strong><small>Attach a screenshot you select</small></span></button><button type="button" onClick={() => { setAddMenuOpen(false); onVisualContext("camera"); }}><Camera aria-hidden="true" /><span><strong>Camera</strong><small>Attach a photo you select</small></span></button></> : null}
        </div> : null}
        {isComposerLayoutIconVisible(autocorrectSettings) ? (
          <button
            type="button"
            className={`codex-layout-toggle ${layoutSuggestion ? "has-suggestion" : ""} ${typingLayoutMode === "el" ? "is-greek-active" : ""} ${typingLayoutMode === "en" ? "is-english-active" : ""}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const textarea = promptRef.current;
              console.log("[GreekLayoutComposer] Toolbar layout toggle clicked:", {
                hasSuggestion: Boolean(layoutSuggestion),
                currentValue: textarea?.value,
                mode: typingLayoutMode ?? "none"
              });
              if (layoutSuggestion) {
                applyLayoutFix(layoutSuggestion.convertedText);
              } else if (textarea && textarea.value.trim()) {
                applyLayoutFix();
              } else {
                const nextMode = typingLayoutMode === "el" ? "en" : "el";
                setTypingMode(nextMode);
              }
            }}
            aria-label={"Fix keyboard layout (Alt+G) " + paneTitle}
            title={
              layoutSuggestion
                ? `Fix layout: "${layoutSuggestion.convertedText}" (Alt+G)`
                : typingLayoutMode === "el"
                  ? "Keyboard layout: Greek (EL) active · Press Alt+G to switch to English"
                  : typingLayoutMode === "en"
                    ? "Keyboard layout: English (EN) active · Press Alt+G to switch to Greek"
                    : "Fix keyboard layout (Alt+G) · Convert EN ⇄ EL"
            }
            disabled={isDisabled || pending}
          >
            <Keyboard aria-hidden="true" />
            {typingLayoutMode === "el" ? (
              <span className="codex-layout-badge" aria-label="Greek layout active">EL</span>
            ) : typingLayoutMode === "en" ? (
              <span className="codex-layout-badge is-en" aria-label="English layout active">EN</span>
            ) : null}
          </button>
        ) : null}
        <div className="codex-composer-spacer" />
        {onShortcut ? <CliShortcutsMenu active={isVisible} disabled={isDisabled || pending || isRunning} onCommand={onShortcut} commands={OSK_CHAT_MODE_COMMANDS} /> : null}
        <VoiceInputButton label={paneTitle} active={voiceActive} disabled={voiceDisabled || isDisabled} onClick={onVoice} onPrewarm={onVoicePrewarm} />
        {modelSettings ? (
          <span title={disabledTitle}>
            <Suspense fallback={modelPickerLoadingFallback}>
              <LazyCodexModelPicker compact settings={modelSettings} providers={modelProviders} disabled={isDisabled || pending || isRunning || !canSelectModel} allowSelectionWithoutCurrent onRefreshCatalog={onRefreshModelCatalog} onSwitch={switchModel} />
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
