import { useCallback, useEffect, useState } from "react";
import { MONITORING_MEMORY_KINDS, type MonitoringMemory } from "@space/contracts";
import { api } from "../../api.js";

const KIND_LABEL: Record<MonitoringMemory["kind"], string> = { HOST: "Host", RULE: "Your rule", FACT: "Fact", LESSON: "Lesson", EXCEPTION: "Known false alarm", PLAYBOOK: "Playbook", PREFERENCE: "Preference" };

/** Memory: the copilot's own memory (separate from Space Memory): your rules, what runs where, known false alarms, lessons and playbooks. */
export function MemoryTab({ paneId }: { paneId: string }) {
  const [memories, setMemories] = useState<MonitoringMemory[]>([]);
  const [kind, setKind] = useState<MonitoringMemory["kind"]>("RULE");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setMemories((await api.monitoringCopilotMemory(paneId)).memories); } catch (error) { setMessage(error instanceof Error ? error.message : "Memory could not be loaded."); }
  }, [paneId]);
  useEffect(() => { void load(); }, [load]);

  async function run(action: () => Promise<unknown>, done: string) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try { await action(); setMessage(done); await load(); } catch (error) { setMessage(error instanceof Error ? error.message : "That did not work."); } finally { setBusy(false); }
  }

  return (
    <div className="mc-memory" role="tabpanel" id="jc-panel-memory" aria-labelledby="jc-tab-memory">
      <form className="jc-card" onSubmit={(event) => {
        event.preventDefault();
        if (text.trim()) void run(async () => { await api.createMonitoringCopilotMemory(paneId, { kind, text: text.trim(), pinned: kind === "RULE" }); setText(""); }, "Saved to the copilot's memory.");
      }}>
        <label className="jc-field"><span>Kind</span>
          <select value={kind} onChange={(event) => setKind(event.target.value as MonitoringMemory["kind"])}>
            {MONITORING_MEMORY_KINDS.map((entry) => <option key={entry} value={entry}>{KIND_LABEL[entry]}</option>)}
          </select>
        </label>
        <label className="jc-field"><span>What the copilot should remember</span>
          <textarea value={text} rows={3} maxLength={4000} placeholder="e.g. RdpDiagnosticsStale fires whenever the office PC sleeps: not an outage" onChange={(event) => setText(event.target.value)} /></label>
        <button type="submit" className="jc-button primary" disabled={busy || !text.trim()}>Remember</button>
      </form>
      {message ? <p className="jc-message" role="status">{message}</p> : null}
      <ul className="jc-list mc-memory-list" aria-label="Monitoring Copilot memory">
        {memories.map((memory) => (
          <li key={memory.id} className="mc-memory-item">
            <div className="jc-row">
              <strong>{KIND_LABEL[memory.kind]}{memory.key ? `: ${memory.key}` : ""}</strong>
              {memory.pinned ? <span className="jc-pill">Pinned</span> : null}
              <span className="jc-row-meta">{memory.source === "USER" ? "You" : "Copilot"}</span>
            </div>
            <p className="mc-feed-text">{memory.text}</p>
            <button type="button" className="jc-button" disabled={busy} onClick={() => void run(() => api.deleteMonitoringCopilotMemory(paneId, memory.id), "Forgotten.")}>Forget</button>
          </li>
        ))}
      </ul>
      {!memories.length ? <p className="jc-muted jc-empty">Nothing remembered yet.</p> : null}
    </div>
  );
}
