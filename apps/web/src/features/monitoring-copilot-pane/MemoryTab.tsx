import { useCallback, useEffect, useState } from "react";
import { MONITORING_MEMORY_KINDS, type MonitoringMemory } from "@space/contracts";
import { api } from "../../api.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";

const KIND_LABEL: Record<MonitoringMemory["kind"], string> = { HOST: "Host", RULE: "Your rule", FACT: "Fact", LESSON: "Lesson", EXCEPTION: "Known false alarm", PLAYBOOK: "Playbook", PREFERENCE: "Preference" };

/** Memory: the copilot's own memory (separate from Space Memory): your rules, what runs where, known false alarms, lessons and playbooks. */
export function MemoryTab({ paneId }: { paneId: string }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [memories, setMemories] = useState<MonitoringMemory[]>([]);
  const [kind, setKind] = useState<MonitoringMemory["kind"]>("RULE");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setMemories((await api.monitoringCopilotMemory(paneId)).memories); } catch (error) { setMessage(error instanceof Error ? error.message : t("Memory could not be loaded.")); }
  }, [paneId]);
  useEffect(() => { void load(); }, [load]);

  async function run(action: () => Promise<unknown>, done: string) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try { await action(); setMessage(done); await load(); } catch (error) { setMessage(error instanceof Error ? error.message : t("That did not work.")); } finally { setBusy(false); }
  }

  return (
    <div className="mc-memory" role="tabpanel" id="jc-panel-memory" aria-labelledby="jc-tab-memory">
      <form className="jc-card" onSubmit={(event) => {
        event.preventDefault();
        if (text.trim()) void run(async () => { await api.createMonitoringCopilotMemory(paneId, { kind, text: text.trim(), pinned: kind === "RULE" }); setText(""); }, t("Saved to the copilot's memory."));
      }}>
        <label className="jc-field"><span>{t("Kind")}</span>
          <select value={kind} onChange={(event) => setKind(event.target.value as MonitoringMemory["kind"])}>
            {MONITORING_MEMORY_KINDS.map((entry) => <option key={entry} value={entry}>{t(KIND_LABEL[entry])}</option>)}
          </select>
        </label>
        <label className="jc-field"><span>{t("What the copilot should remember")}</span>
          <textarea value={text} rows={3} maxLength={4000} placeholder={t("e.g. RdpDiagnosticsStale fires whenever the office PC sleeps: not an outage")} onChange={(event) => setText(event.target.value)} /></label>
        <button type="submit" className="jc-button primary" disabled={busy || !text.trim()}>{t("Remember")}</button>
      </form>
      {message ? <p className="jc-message" role="status">{message}</p> : null}
      <ul className="jc-list mc-memory-list" aria-label={t("Monitoring Copilot memory")}>
        {memories.map((memory) => (
          <li key={memory.id} className="mc-memory-item">
            <div className="jc-row">
              <strong>{t(KIND_LABEL[memory.kind])}{memory.key ? `: ${memory.key}` : ""}</strong>
              {memory.pinned ? <span className="jc-pill">{t("Pinned")}</span> : null}
              <span className="jc-row-meta">{memory.source === "USER" ? t("You") : t("Copilot")}</span>
            </div>
            <p className="mc-feed-text">{memory.text}</p>
            <button type="button" className="jc-button" disabled={busy} onClick={() => void run(() => api.deleteMonitoringCopilotMemory(paneId, memory.id), t("Forgotten."))}>{t("Forget")}</button>
          </li>
        ))}
      </ul>
      {!memories.length ? <p className="jc-muted jc-empty">{t("Nothing remembered yet.")}</p> : null}
    </div>
  );
}
