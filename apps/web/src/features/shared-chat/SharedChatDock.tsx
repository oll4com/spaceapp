import { MessageSquare, Send } from "../ui-theme/app-icons.js";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { AuditVerifyResponse, SharedChatMessage } from "@space/contracts";
import { api } from "../../api.js";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import "./shared-chat.css";

function timeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${day}/${month} ${hours}:${minutes}`;
}

function senderBadgeLabel(message: SharedChatMessage): string {
  if (message.senderType === "user") return "you";
  if (message.senderType === "system") return "system";
  return message.senderLabel;
}

export function SharedChatDock() {
  const runtime = getSpaceRuntime();
  const [messages, setMessages] = useState<SharedChatMessage[]>([]);
  const [audit, setAudit] = useState<AuditVerifyResponse | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await api.sharedChatMessages({ limit: 100 });
      setMessages(result.data);
      setAudit(await api.auditVerify());
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
        const parsed = JSON.parse(String(event.data)) as { type: string; message?: SharedChatMessage };
        if (parsed.type === "message" && parsed.message) {
          setMessages((current) => [parsed.message as SharedChatMessage, ...current]);
        }
      } catch {
        // Ignore malformed frames.
      }
    };
    return () => socket.close();
  }, [runtime.kind]);

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
      setAudit(await api.auditVerify());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send the message.");
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="dock-panel shared-chat-dock" aria-label="Shared chat">
      <header className="shared-chat-head">
        <span className="shared-chat-mark" aria-hidden="true">
          <MessageSquare size={18} />
        </span>
        <div className="shared-chat-title">
          <strong>Shared chat</strong>
          <small>Εσύ και όλα τα AI στο ίδιο δωμάτιο</small>
        </div>
      </header>

      <div className="shared-chat-list" ref={listRef}>
        {messages.length === 0 ? (
          <p className="shared-chat-empty">
            Κανένα μήνυμα ακόμα. Γράψε κάτι εδώ ή ζήτα από έναν agent να γράψει με το εργαλείο chat:send.
          </p>
        ) : (
          messages.map((message) => (
            <article
              key={message.id}
              className={`shared-chat-message is-${message.kind} is-${message.senderType}`}
            >
              {message.kind === "reaction" ? (
                <span className="shared-chat-reaction">
                  {message.content} <small>από {senderBadgeLabel(message)}</small>
                </span>
              ) : (
                <>
                  <header>
                    <strong>{senderBadgeLabel(message)}</strong>
                    <time dateTime={message.createdAt}>{timeLabel(message.createdAt)}</time>
                  </header>
                  <p>{message.content}</p>
                </>
              )}
            </article>
          ))
        )}
      </div>

      <form className="shared-chat-compose" onSubmit={send}>
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Μήνυμα για όλους (εσένα και τα AI)…"
          maxLength={20_000}
          aria-label="Shared chat message"
        />
        <button type="submit" disabled={sending || !draft.trim()}>
          <Send size={16} aria-hidden="true" />
          <span>Send</span>
        </button>
      </form>

      <footer className="shared-chat-foot">
        {audit ? (
          audit.ok ? (
            <span className="shared-chat-audit is-ok">
              Αδιάβλητο αρχείο: OK · {audit.entryCount} εγγραφές
            </span>
          ) : (
            <span className="shared-chat-audit is-bad">
              Αδιάβλητο αρχείο: ΣΦΑΛΜΑ στη σειρά {audit.firstTamperedSeq}
            </span>
          )
        ) : null}
        {error ? <span className="shared-chat-error">{error}</span> : null}
      </footer>
    </section>
  );
}
