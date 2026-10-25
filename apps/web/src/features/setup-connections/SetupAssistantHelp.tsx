import { useEffect, useId, useRef, useState, type FormEvent } from "react";

export interface SetupAssistantResponse { available: boolean; modelId: string | null; message: string }
export const SETUP_HELP_VERSION = "first-setup:v2";
const guidance = "Minimal starts with the free OpenCode assistant. Balanced adds tools for your profile. Full includes supported tools and their connections. Live is optional; use Skip Live if no provider is connected.";

export function SetupAssistantHelp({ ask }: { ask?: (question: string, signal?: AbortSignal) => Promise<SetupAssistantResponse> }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [reply, setReply] = useState<SetupAssistantResponse | null>(null);
  const [status, setStatus] = useState("");
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  useEffect(() => { if (expanded) field.current?.focus(); }, [expanded]);

  function close() {
    generation.current++; controller.current?.abort(); controller.current = null;
    setPending(false); setQuestion(""); setStatus(""); setExpanded(false); trigger.current?.focus();
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = question.trim(); if (!text || pending || !ask) return;
    setQuestion("");
    if (/(?:sk-[a-zA-Z0-9_-]{12,}|AKIA[A-Z0-9]{16}|(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[=:]\s*\S+)/i.test(text)) {
      setStatus("Keep credentials in their dedicated connection forms."); return;
    }
    const current = ++generation.current;
    controller.current = new AbortController();
    setPending(true); setStatus("Checking the free model and answering…");
    try {
      const result = await ask(text, controller.current.signal);
      if (current !== generation.current) return;
      setReply(result); setStatus(result.available ? `Answered by ${result.modelId ?? "OpenCode"}.` : "The setup assistant is unavailable. Built-in guidance remains available.");
    } catch {
      if (current !== generation.current) return;
      setStatus("The setup assistant is unavailable. Built-in guidance remains available.");
    } finally { if (current === generation.current) { setPending(false); controller.current = null; } }
  }
  return <div className="first-setup-assistant" data-guidance-version={SETUP_HELP_VERSION}>
    <button ref={trigger} type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(true)}>Ask setup assistant</button>
    {expanded && <section id={id} aria-label="Setup assistant help">
      <div className="first-setup-assistant-heading"><h3>Setup assistant</h3><button type="button" onClick={close}>Close assistant help</button></div>
      <p>{guidance}</p>
      <p>Answers use saved setup choices and safe installation notes. Keep API keys and passwords in their connection forms.</p>
      {reply && <p className="first-setup-assistant-reply">{reply.message}</p>}
      <form onSubmit={event => void submit(event)}>
        <label htmlFor={`${id}-question`}>Setup question</label>
        <textarea ref={field} id={`${id}-question`} rows={2} maxLength={1200} value={question} onChange={event => setQuestion(event.target.value)} disabled={pending || !ask} />
        <button type="submit" disabled={pending || !ask || !question.trim()}>{pending ? "Answering…" : "Ask OpenCode"}</button>
      </form>
      <p role="status" aria-live="polite">{status || (!ask ? "The setup assistant is unavailable. Built-in guidance remains available." : "Only the verified free setup model is used.")}</p>
    </section>}
  </div>;
}
