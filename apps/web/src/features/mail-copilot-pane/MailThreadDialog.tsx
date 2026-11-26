import { useEffect, useRef, useState } from "react";
import type { MailThread } from "@space/contracts";
import { api } from "../../api.js";
import { X } from "../ui-theme/app-icons.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";
import { MessageCard } from "./MailClient.js";
import "../copilot-kit/copilot-pane.css";
import "./mail-copilot-pane.css";

export interface MailThreadRef { paneId: string | undefined; account: string; threadId: string; title: string }

/**
 * A mail notification's thread, read where the operator is (operator 19/11, nous_msg:8c3a737937b14ac089e5a7e6: «απλα να μπορώ να δω το εμαιλ που
 * στειλαμε», not the Mail pane): no room or pane changes. The newest message and the newest one the account itself sent open expanded.
 */
export function MailThreadDialog({ mail, onClose }: { mail: MailThreadRef; onClose(): void }) {
  const language = useUiLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const [thread, setThread] = useState<MailThread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    const node = dialog.current;
    try { if (node && !node.open) { if (typeof node.showModal === "function") node.showModal(); else node.setAttribute("open", ""); } } catch { node?.setAttribute("open", ""); }
  }, []);
  useEffect(() => {
    let cancelled = false;
    api.mailThread(mail.paneId, mail.account, mail.threadId, images).then(({ thread: loaded }) => {
      if (cancelled) return;
      setThread(loaded);
      const sent = loaded.messages.findLast((message) => message.from.address.toLowerCase() === mail.account.toLowerCase());
      setExpanded((current) => current.size ? current : new Set([loaded.messages.at(-1)?.messageId, sent?.messageId].filter((id): id is string => Boolean(id))));
    }, (cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [mail.paneId, mail.account, mail.threadId, images]);
  const subject = thread?.subject || mail.title;
  const toggle = (id: string) => setExpanded((current) => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
  return (
    <dialog ref={dialog} className="jc-launch mc-camp-full mc-mail-view" aria-label={subject}
      onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="mc-camp-full-head">
        <div className="mc-camp-full-title"><strong>{subject}</strong><small className="jc-muted">{mail.account}</small></div>
        <button type="button" className="jc-icon-button" aria-label={uiText(language, "Close")} onClick={onClose}><X aria-hidden="true" /></button>
      </div>
      <div className="mc-mail-view-body">
        {error ? <p role="alert">{error}</p> : !thread ? <p className="jc-muted">{uiText(language, "Loading…")}</p> : thread.messages.map((message) => (
          <MessageCard key={message.messageId} message={message} paneId={mail.paneId} expanded={expanded.has(message.messageId)}
            onToggle={() => toggle(message.messageId)} onLoadImages={() => setImages(true)} />
        ))}
      </div>
    </dialog>
  );
}
