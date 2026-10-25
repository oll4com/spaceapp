import { useCallback, useEffect, useState } from "react";
import { SECURITY_MEMORY_KINDS, type SecurityMemory } from "@space/contracts";
import { api } from "../../api.js";

const KIND_LABEL: Record<SecurityMemory["kind"], string> = { HOST: "Host", RULE: "Your rule", FACT: "Fact", LESSON: "Lesson", EXCEPTION: "Accepted risk", PLAYBOOK: "Playbook", PREFERENCE: "Preference" };

/** Memory: the copilot's own memory (separate from Space Memory): your rules for hosts, accepted risks, lessons and playbooks. */
export function MemoryTab({ paneId }: { paneId: string }) {
  const [memories, setMemories] = useState<SecurityMemory[]>([]);
  const [kind, setKind] = useState<SecurityMemory["kind"]>("RULE");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setMemories((await api.securityCopilotMemory(paneId)).memories); } catch (error) { setMessage(error instanceof Error ? error.message : "Memory could not be loaded."); }
  }, [paneId]);
  useEffect(() => { void load(); }, [load]);

  async function run(action: () => Promise<unknown>, done: string) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try { await action(); setMessage(done); await load(); } catch (error) { setMessage(error instanceof Error ? error.message : "That did not work."); } finally { setBusy(false); }
  }

  return (
    <div className="sc-memory" role="tabpanel" id="jc-panel-memory" aria-labelledby="jc-tab-memory">
      <form className="jc-card" onSubmit={(event) => {
        event.preventDefault();
        if (text.trim()) void run(async () => { await api.createSecurityCopilotMemory(paneId, { kind, text: text.trim(), pinned: kind === "RULE" }); setText(""); }, "Saved to the copilot's memory.");
      }}>
        <label className="jc-field"><span>Kind</span>
          <select value={kind} onChange={(event) => setKind(event.target.value as SecurityMemory["kind"])}>
            {SECURITY_MEMORY_KINDS.map((entry) => <option key={entry} value={entry}>{KIND_LABEL[entry]}</option>)}
          </select>
        </label>
        <label className="jc-field"><span>What the copilot should remember</span>
          <textarea value={text} rows={3} maxLength={4000} placeholder="e.g. Never reboot public-host before 23:00 Athens" onChange={(event) => setText(event.target.value)} /></label>
        <button type="submit" className="jc-button primary" disabled={busy || !text.trim()}>Remember</button>
      </form>
      {message ? <p className="jc-message" role="status">{message}</p> : null}
      <ul className="jc-list sc-memory-list" aria-label="Security Copilot memory">
        {memories.map((memory) => (
          <li key={memory.id} className="sc-memory-item">
            <div className="jc-row">
              <strong>{KIND_LABEL[memory.kind]}{memory.key ? `: ${memory.key}` : ""}</strong>
              {memory.pinned ? <span className="jc-pill">Pinned</span> : null}
              <span className="jc-row-meta">{memory.source === "USER" ? "You" : "Copilot"}</span>
            </div>
            <p className="sc-feed-text">{memory.text}</p>
            <button type="button" className="jc-button" disabled={busy} onClick={() => void run(() => api.deleteSecurityCopilotMemory(paneId, memory.id), "Forgotten.")}>Forget</button>
          </li>
        ))}
      </ul>
      {!memories.length ? <p className="jc-muted jc-empty">Nothing remembered yet.</p> : null}
    </div>
  );
}
