import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from "react";
import type { RoomAgentPaneStripItem } from "@space/contracts";
import { CircleStop, Keyboard, Send, X } from "../ui-theme/app-icons.js";
import { DockButton } from "../dock-kit/DockKit.js";
import { VoiceInputButton } from "../voice-input/VoiceInputButton.js";
import {
  convertTextRange,
  createGreekInputState,
  detectKeyboardLayoutMismatch,
  enterAddsLine,
  isTouchOnlyDevice,
  handleEnglishKeyInput,
  handleGreekKeyInput,
  insertTextAtCursor,
  type LayoutMismatchDetection
} from "../agent-pane/greek-layout-converter.js";
import {
  isComposerLayoutIconVisible,
  isComposerSuggestionBarVisible,
  playLayoutSuggestionBeep,
  useKeyboardAutocorrectSettings
} from "../keyboard-autocorrect/keyboard-autocorrect-settings.js";

export interface RoomAgentComposerVoice {
  active: boolean;
  disabled: boolean;
  onClick(): void;
  onPrewarm?: () => void;
}

/** The message box: "@Bo" offers the room's panes by name, Enter sends, and Stop replaces Send while an answer runs. */
export function RoomAgentComposer({ composerRef, draft, onDraftChange, onSubmit, onStop, onKeyboardSend, running, canSend, canStop, stopping, disabled, panes, voice }: {
  composerRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  onDraftChange(value: string | ((current: string) => string)): void;
  onSubmit(event?: FormEvent): void;
  onStop(): void;
  /** Enter in the box: also ends voice capture before sending. */
  onKeyboardSend(): void;
  running: boolean;
  canSend: boolean;
  canStop: boolean;
  stopping: boolean;
  disabled: boolean;
  panes: RoomAgentPaneStripItem[];
  voice?: RoomAgentComposerVoice;
}) {
  const [layoutSuggestion, setLayoutSuggestion] = useState<LayoutMismatchDetection | null>(null);
  const layoutCheckTimerRef = useRef<number | null>(null);
  const [typingLayoutMode, setTypingLayoutMode] = useState<"el" | "en" | null>(null);
  const greekInputStateRef = useRef(createGreekInputState(false));
  const { settings: autocorrectSettings } = useKeyboardAutocorrectSettings();
  const prevLayoutSuggestionRef = useRef(false);

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

  useEffect(() => {
    if (layoutSuggestion && !prevLayoutSuggestionRef.current) {
      if (autocorrectSettings.enabled && autocorrectSettings.soundEnabled) {
        playLayoutSuggestionBeep();
      }
    }
    prevLayoutSuggestionRef.current = Boolean(layoutSuggestion);
  }, [layoutSuggestion, autocorrectSettings.enabled, autocorrectSettings.soundEnabled]);

  useEffect(() => {
    if (!autocorrectSettings.enabled) {
      setLayoutSuggestion(null);
    }
  }, [autocorrectSettings.enabled]);

  useEffect(() => {
    return () => {
      if (layoutCheckTimerRef.current !== null) {
        window.clearTimeout(layoutCheckTimerRef.current);
        layoutCheckTimerRef.current = null;
      }
    };
  }, []);

  // "@Bo" offers the room's panes by name; the message then goes straight to them.
  const mentionQuery = draft.match(/(?:^|\s)@([\p{L}\p{N}_-]*)$/u)?.[1]?.toLocaleLowerCase() ?? null;
  const mentionMatches = mentionQuery === null ? [] : panes
    .filter((item) => item.paneName && item.paneName.toLocaleLowerCase().startsWith(mentionQuery)).slice(0, 6);
  function completeMention(name: string) {
    onDraftChange((current) => current.replace(/@([\p{L}\p{N}_-]*)$/u, `@${name} `));
    composerRef.current?.focus();
  }

  function toggleLayout(textarea: HTMLTextAreaElement | null) {
    const selStart = textarea?.selectionStart ?? 0;
    const selEnd = textarea?.selectionEnd ?? 0;
    if (layoutSuggestion || draft.trim()) {
      const converted = layoutSuggestion
        ? layoutSuggestion.convertedText
        : convertTextRange(draft, selStart, selEnd, "toggle").newText;
      const changed = converted !== draft;
      onDraftChange(converted);
      setLayoutSuggestion(null);
      if (changed) {
        const isGreekTarget = /[\u0370-\u03FF]/.test(converted);
        setTypingMode(isGreekTarget ? "el" : "en");
      } else {
        setTypingMode(typingLayoutMode === "el" ? "en" : "el");
      }
    } else {
      setTypingMode(typingLayoutMode === "el" ? "en" : "el");
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Tab" && !event.shiftKey && mentionMatches[0]?.paneName) {
      event.preventDefault();
      completeMention(mentionMatches[0].paneName);
      return;
    }
    const isGKey = event.code === "KeyG" || event.key.toLowerCase() === "g" || event.key === "γ" || event.key === "Γ" || event.key === "©";
    if (autocorrectSettings.enabled && (event.altKey || (event.ctrlKey && event.shiftKey)) && isGKey) {
      event.preventDefault();
      toggleLayout(composerRef.current);
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || enterAddsLine(event.nativeEvent)) {
      if (typingLayoutMode === "el" && greekInputStateRef.current.enabled && composerRef.current) {
        const textarea = composerRef.current;
        const handled = handleGreekKeyInput(event, greekInputStateRef.current, (char) => {
          insertTextAtCursor(textarea, char);
          onDraftChange(textarea.value);
        });
        if (handled) return;
      } else if (typingLayoutMode === "en" && composerRef.current) {
        const textarea = composerRef.current;
        const handled = handleEnglishKeyInput(event, (char) => {
          insertTextAtCursor(textarea, char);
          onDraftChange(textarea.value);
        });
        if (handled) return;
      }
      return;
    }
    event.preventDefault();
    onKeyboardSend();
  }

  const showStop = running && canStop;
  return (
    <form className="room-agent-composer" onSubmit={(event) => { event.preventDefault(); if (!showStop) onSubmit(event); }}>
      <label className="room-agent-composer-label" htmlFor="room-agent-message">Message Room Agent</label>
      {mentionMatches.length ? (
        <div className="room-agent-mentions" role="listbox" aria-label="Panes to mention">
          {mentionMatches.map((item) => (
            <button key={item.paneId} type="button" role="option" aria-selected={false} className="room-agent-mention" data-activity={item.activity}
              onMouseDown={(mouseEvent) => mouseEvent.preventDefault()} onClick={() => completeMention(item.paneName!)}>
              <span className="room-agent-pane-dot" aria-hidden="true" />
              <strong>{item.paneName}</strong>
              <span>{item.taskTitle ?? item.title}</span>
            </button>
          ))}
        </div>
      ) : null}
      {layoutSuggestion && isComposerSuggestionBarVisible(autocorrectSettings) ? (
        <div className="codex-layout-suggestion" role="status" aria-live="polite" style={{ marginBottom: 6 }}>
          <Keyboard aria-hidden="true" style={{ width: 14, height: 14, flexShrink: 0 }} />
          <span className="codex-layout-suggestion-label">
            Wrong layout? Convert to: <strong>{layoutSuggestion.convertedText.length > 36 ? layoutSuggestion.convertedText.slice(0, 36) + "…" : layoutSuggestion.convertedText}</strong>
          </span>
          <button
            type="button"
            className="codex-layout-apply-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onDraftChange(layoutSuggestion.convertedText);
              setLayoutSuggestion(null);
              const isGreekTarget = /[\u0370-\u03FF]/.test(layoutSuggestion.convertedText);
              setTypingMode(isGreekTarget ? "el" : "en");
              composerRef.current?.focus();
            }}
            title="Apply layout conversion (Alt+G)"
          >
            Fix (Alt+G)
          </button>
          <button
            type="button"
            className="codex-layout-dismiss-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setLayoutSuggestion(null)}
            aria-label="Dismiss layout suggestion"
          >
            <X aria-hidden="true" style={{ width: 14, height: 14 }} />
          </button>
        </div>
      ) : null}
      <textarea
        id="room-agent-message"
        ref={composerRef}
        value={draft}
        onChange={(event) => {
          const val = event.target.value;
          onDraftChange(val);
          if (layoutCheckTimerRef.current !== null) {
            window.clearTimeout(layoutCheckTimerRef.current);
            layoutCheckTimerRef.current = null;
          }
          if (!autocorrectSettings.enabled || !val.trim()) {
            setLayoutSuggestion(null);
            return;
          }
          layoutCheckTimerRef.current = window.setTimeout(() => {
            layoutCheckTimerRef.current = null;
            const detection = detectKeyboardLayoutMismatch(val);
            const isLangSupported = (detection.direction === "toGreek" && autocorrectSettings.supportedLanguages.includes("el")) ||
              (detection.direction === "toQwerty" && autocorrectSettings.supportedLanguages.includes("en"));
            if (detection.hasMismatch && detection.confidence >= 0.85 && isLangSupported) {
              setLayoutSuggestion(detection);
            } else {
              setLayoutSuggestion(null);
            }
          }, 150);
        }}
        onKeyDown={handleKeyDown}
        placeholder={disabled ? "Select a room first" : "Message the Room Agent, or @name a pane"}
        disabled={disabled}
        rows={2}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        enterKeyHint={isTouchOnlyDevice() ? "enter" : "send"}
        data-gramm="false"
        data-enable-grammarly="false"
      />
      <div className="room-agent-composer-actions">
        {voice ? <VoiceInputButton label="Room Agent" active={voice.active} disabled={voice.disabled} onClick={voice.onClick} onPrewarm={voice.onPrewarm} /> : null}
        {isComposerLayoutIconVisible(autocorrectSettings) ? (
          <button
            type="button"
            className={`codex-layout-toggle ${layoutSuggestion ? "has-suggestion" : ""} ${typingLayoutMode === "el" ? "is-greek-active" : ""} ${typingLayoutMode === "en" ? "is-english-active" : ""}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              toggleLayout(composerRef.current);
              composerRef.current?.focus();
            }}
            title={
              layoutSuggestion
                ? `Fix layout: "${layoutSuggestion.convertedText}" (Alt+G)`
                : typingLayoutMode === "el"
                  ? "Keyboard layout: Greek (EL) active · Press Alt+G to switch to English"
                  : typingLayoutMode === "en"
                    ? "Keyboard layout: English (EN) active · Press Alt+G to switch to Greek"
                    : "Fix keyboard layout (Alt+G) · Convert EN ⇄ EL"
            }
            aria-label="Fix keyboard layout (Alt+G)"
          >
            <Keyboard aria-hidden="true" />
            {typingLayoutMode === "el" ? (
              <span className="codex-layout-badge" aria-label="Greek layout active">EL</span>
            ) : typingLayoutMode === "en" ? (
              <span className="codex-layout-badge is-en" aria-label="English layout active">EN</span>
            ) : null}
          </button>
        ) : null}
        <span className="room-agent-composer-hint">{showStop ? "Answering…" : isTouchOnlyDevice() ? null : "Enter to send"}</span>
        {showStop ? (
          <DockButton icon={CircleStop} className="room-agent-submit room-agent-stop-button" onClick={onStop} disabled={stopping} busy={stopping}
            aria-label="Stop Room Agent">
            {stopping ? "Stopping" : "Stop"}
          </DockButton>
        ) : (
          <DockButton type="submit" tone="primary" icon={Send} className="room-agent-submit" disabled={disabled || !draft.trim() || !canSend}
            aria-label="Send to Room Agent">
            Send
          </DockButton>
        )}
      </div>
    </form>
  );
}
