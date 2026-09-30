import { Keyboard, MessageSquare, MessageSquareX, Send } from "../ui-theme/app-icons.js";
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { SharedChatMessage } from "@space/contracts";
import {
  convertTextRange,
  createGreekInputState,
  detectKeyboardLayoutMismatch,
  handleEnglishKeyInput,
  handleGreekKeyInput,
  insertTextAtCursor,
  toggleKeyboardLayout,
  type LayoutMismatchDetection
} from "../agent-pane/greek-layout-converter.js";
import {
  isComposerLayoutIconVisible,
  isComposerSuggestionBarVisible,
  playLayoutSuggestionBeep,
  useKeyboardAutocorrectSettings
} from "../keyboard-autocorrect/keyboard-autocorrect-settings.js";
import { api } from "../../api.js";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import { cliRuntimePresentation } from "../../cli-runtime-presentation.js";
import "./shared-chat.css";

function messageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${day}/${month} ${hours}:${minutes}`;
}

function runtimePresentationFor(message: SharedChatMessage) {
  const runtimeId = message.metadata?.runtimeId;
  if (!runtimeId || typeof runtimeId !== "string") return undefined;
  return cliRuntimePresentation(runtimeId);
}

function senderLabelFor(message: SharedChatMessage): string {
  if (message.senderType === "user") return "You";
  if (message.senderType === "system") return "System";
  return message.senderLabel;
}

export function SharedChatDock() {
  const runtime = getSpaceRuntime();
  const [messages, setMessages] = useState<SharedChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [layoutSuggestion, setLayoutSuggestion] = useState<LayoutMismatchDetection | null>(null);
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
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const { settings: autocorrectSettings } = useKeyboardAutocorrectSettings();
  const prevLayoutSuggestionRef = useRef(false);

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
  const transcriptRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await api.sharedChatMessages({ limit: 100 });
      setMessages(result.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the shared chat.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (runtime.kind !== "live") return;
    const protocol = window.location.protocol === "https:" ? "wss://" : "ws://";
    const socket = new WebSocket(`${protocol}${window.location.host}/api/shared-chat/live`);
    socket.onmessage = (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as {
          type: string;
          message?: SharedChatMessage;
        };
        if (parsed.type === "message" && parsed.message) {
          setMessages((current) => [parsed.message as SharedChatMessage, ...current]);
        } else if (parsed.type === "clear") {
          setMessages([]);
          void refresh();
        }
      } catch {
        // Ignore malformed frames.
      }
    };
    return () => socket.close();
  }, [runtime.kind, refresh]);

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    let content = draft.trim();
    const layoutCheck = detectKeyboardLayoutMismatch(content);
    if (layoutCheck.hasMismatch && layoutCheck.confidence >= 0.90 && layoutCheck.direction === "toGreek") {
      content = layoutCheck.convertedText.trim();
    }
    if (!content || sending) return;
    setSending(true);
    setError(null);
    try {
      const message = await api.sendSharedChatMessage({ senderLabel: "operator", content, kind: "message", metadata: {} });
      setDraft("");
      setLayoutSuggestion(null);
      setMessages((current) => [message, ...current]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send the message.");
    } finally {
      setSending(false);
    }
  };

  const clearRoom = async () => {
    if (!window.confirm("Clear the Shared Chat? The immutable audit file keeps the full history.")) return;
    setClearing(true);
    setError(null);
    try {
      const result = await api.clearSharedChat();
      setMessages([]);
      void result;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear the shared chat.");
    } finally {
      setClearing(false);
    }
  };

  return (
    <section className="dock-panel shared-chat-dock" aria-label="Shared chat">
      <header className="shared-chat-head">
        <span className="shared-chat-mark" aria-hidden="true">
          <MessageSquare />
        </span>
        <span>
          <h2>Shared Chat</h2>
          <small>You and all the AIs in the same room</small>
        </span>
        <span className="shared-chat-head-actions">
          <button
            type="button"
            className="shared-chat-clear"
            onClick={() => void clearRoom()}
            disabled={clearing || messages.length === 0}
            aria-label="Clear Shared Chat"
            title="Clear the visible Shared Chat (the audit chain keeps the history)"
          >
            <MessageSquareX aria-hidden="true" />
          </button>
        </span>
      </header>

      <div className="shared-chat-transcript" ref={transcriptRef} aria-label="Shared Chat transcript">
        {messages.length === 0 ? (
          <div className="shared-chat-empty">
            <MessageSquare aria-hidden="true" />
            <span>
              No messages yet. Type something here — all agents will wake up and reply in this room. (Deepseek only wakes with an explicit @deepseek.)
            </span>
          </div>
        ) : (
          messages.map((message) => {
            const presentation = message.senderType === "agent" ? runtimePresentationFor(message) : undefined;
            return message.kind === "reaction" ? (
              <article key={message.id} className="shared-chat-message is-system">
                <header>
                  <strong>
                    {senderLabelFor(message)} {message.content}
                  </strong>
                  <time dateTime={message.createdAt}>{messageTime(message.createdAt)}</time>
                </header>
              </article>
            ) : (
              <article key={message.id} className={`shared-chat-message is-${message.senderType}`}>
                <header>
                  <span className="shared-chat-sender">
                    {presentation ? (
                      <img
                        className="shared-chat-agent-icon"
                        src={presentation.iconSrc}
                        alt={presentation.shortLabel}
                        title={presentation.displayName}
                      />
                    ) : null}
                    <strong>{senderLabelFor(message)}</strong>
                    {presentation ? <small className="shared-chat-runtime-tag">{presentation.shortLabel}</small> : null}
                  </span>
                  <time dateTime={message.createdAt}>{messageTime(message.createdAt)}</time>
                </header>
                <p>{message.content}</p>
              </article>
            );
          })
        )}
      </div>

      {error ? (
        <p className="shared-chat-error" role="alert">
          {error}
        </p>
      ) : null}

      <form className="shared-chat-composer" onSubmit={(event) => void send(event)}>
        <label htmlFor="shared-chat-message">Message the room</label>
        {layoutSuggestion && isComposerSuggestionBarVisible(autocorrectSettings) ? (
          <div className="codex-layout-suggestion" role="status" aria-live="polite" style={{ marginBottom: 6 }}>
            <Keyboard aria-hidden="true" style={{ width: 14, height: 14, flexShrink: 0 }} />
            <span className="codex-layout-suggestion-label">
              Wrong layout? Convert to: <strong>{layoutSuggestion.convertedText.length > 40 ? layoutSuggestion.convertedText.slice(0, 40) + "…" : layoutSuggestion.convertedText}</strong>
            </span>
            <button
              type="button"
              className="codex-layout-apply-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setDraft(layoutSuggestion.convertedText);
                setLayoutSuggestion(null);
                const isGreekTarget = /[\u0370-\u03FF]/.test(layoutSuggestion.convertedText);
                setTypingMode(isGreekTarget ? "el" : "en");
                composerRef.current?.focus();
              }}
              title="Apply layout conversion (Alt+G)"
            >
              Fix (Alt+G)
            </button>
          </div>
        ) : null}
        <textarea
          id="shared-chat-message"
          ref={composerRef}
          value={draft}
          onChange={(event) => {
            const val = event.target.value;
            setDraft(val);
            if (!autocorrectSettings.enabled) {
              setLayoutSuggestion(null);
              return;
            }
            const detection = detectKeyboardLayoutMismatch(val);
            const isLangSupported = (detection.direction === "toGreek" && autocorrectSettings.supportedLanguages.includes("el")) ||
              (detection.direction === "toQwerty" && autocorrectSettings.supportedLanguages.includes("en"));
            if (detection.hasMismatch && detection.confidence >= 0.85 && isLangSupported) {
              setLayoutSuggestion(detection);
            } else {
              setLayoutSuggestion(null);
            }
          }}
          onKeyDown={(event) => {
            const isGKey = event.code === "KeyG" || event.key.toLowerCase() === "g" || event.key === "γ" || event.key === "Γ" || event.key === "©";
            if (autocorrectSettings.enabled && (event.altKey || (event.ctrlKey && event.shiftKey)) && isGKey) {
              event.preventDefault();
              const textarea = event.currentTarget;
              if (layoutSuggestion || draft.trim()) {
                const selStart = textarea.selectionStart ?? 0;
                const selEnd = textarea.selectionEnd ?? 0;
                const converted = layoutSuggestion
                  ? layoutSuggestion.convertedText
                  : convertTextRange(draft, selStart, selEnd, "toggle").newText;
                const changed = converted !== draft;
                setDraft(converted);
                setLayoutSuggestion(null);
                if (changed) {
                  const isGreekTarget = /[\u0370-\u03FF]/.test(converted);
                  setTypingMode(isGreekTarget ? "el" : "en");
                } else {
                  const nextMode = typingLayoutMode === "el" ? "en" : "el";
                  setTypingMode(nextMode);
                }
              } else {
                const nextMode = typingLayoutMode === "el" ? "en" : "el";
                setTypingMode(nextMode);
              }
              return;
            }
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send(event);
              return;
            }
            if (typingLayoutMode === "el" && greekInputStateRef.current.enabled && composerRef.current) {
              const textarea = composerRef.current;
              const handled = handleGreekKeyInput(event, greekInputStateRef.current, (char) => {
                insertTextAtCursor(textarea, char);
                setDraft(textarea.value);
              });
              if (handled) return;
            } else if (typingLayoutMode === "en" && composerRef.current) {
              const textarea = composerRef.current;
              const handled = handleEnglishKeyInput(event, (char) => {
                insertTextAtCursor(textarea, char);
                setDraft(textarea.value);
              });
              if (handled) return;
            }
          }}
          placeholder="Message all agents… Deepseek only wakes with an explicit @deepseek."
          rows={3}
          maxLength={20_000}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="send"
          data-gramm="false"
          data-enable-grammarly="false"
        />
        <div className="shared-chat-composer-actions">
          {isComposerLayoutIconVisible(autocorrectSettings) ? (
            <button
              type="button"
              className={`codex-layout-toggle ${layoutSuggestion ? "has-suggestion" : ""} ${typingLayoutMode === "el" ? "is-greek-active" : ""} ${typingLayoutMode === "en" ? "is-english-active" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const textarea = composerRef.current;
                const selStart = textarea?.selectionStart ?? 0;
                const selEnd = textarea?.selectionEnd ?? 0;
                if (layoutSuggestion || draft.trim()) {
                  const converted = layoutSuggestion
                    ? layoutSuggestion.convertedText
                    : convertTextRange(draft, selStart, selEnd, "toggle").newText;
                  const changed = converted !== draft;
                  setDraft(converted);
                  setLayoutSuggestion(null);
                  if (changed) {
                    const isGreekTarget = /[\u0370-\u03FF]/.test(converted);
                    setTypingMode(isGreekTarget ? "el" : "en");
                  } else {
                    const nextMode = typingLayoutMode === "el" ? "en" : "el";
                    setTypingMode(nextMode);
                  }
                } else {
                  const nextMode = typingLayoutMode === "el" ? "en" : "el";
                  setTypingMode(nextMode);
                }
                textarea?.focus();
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
          <small>All messages stay recorded in the immutable audit file.</small>
          <button type="submit" className="shared-chat-send" disabled={sending || !draft.trim()}>
            <Send aria-hidden="true" />
            <span>Send</span>
          </button>
        </div>
      </form>
    </section>
  );
}
