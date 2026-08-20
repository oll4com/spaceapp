import { MessageSquare, MessageSquareX, Send } from "../ui-theme/app-icons.js";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { SharedChatMessage } from "@space/contracts";
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

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setError(null);
    try {
      const message = await api.sendSharedChatMessage({ senderLabel: "operator", content, kind: "message", metadata: {} });
      setDraft("");
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
        <textarea
          id="shared-chat-message"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Message all agents… Deepseek only wakes with an explicit @deepseek."
          rows={3}
          maxLength={20_000}
        />
        <div className="shared-chat-composer-actions">
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
