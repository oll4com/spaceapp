import { useCallback, useEffect, useRef, useState } from "react";
import { SECURITY_MEMORY_KINDS, type SecurityMemory } from "@space/contracts";
import { api } from "../../api.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";

const KIND_LABEL: Record<SecurityMemory["kind"], string> = { HOST: "Host", RULE: "Your rule", FACT: "Fact", LESSON: "Lesson", EXCEPTION: "Accepted risk", PLAYBOOK: "Playbook", PREFERENCE: "Preference" };

/** Memory: the copilot's own memory (separate from Space Memory): your rules for hosts, accepted risks, lessons and playbooks. */
export function MemoryTab({ paneId }: { paneId: string }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  // load keeps one identity (an effect runs on it); it reads the language when an error happens.
  const languageRef = useRef(language);
  languageRef.current = language;
  const [memories, setMemories] = useState<SecurityMemory[]>([]);
  const [kind, setKind] = useState<SecurityMemory["kind"]>("RULE");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setMemories((await api.securityCopilotMemory(paneId)).memories); } catch (error) { setMessage(error instanceof Error ? error.message : uiText(languageRef.current, "Memory could not be loaded.")); }
  }, [paneId]);
  useEffect(() => { void load(); }, [load]);

  async function run(action: () => Promise<unknown>, done: string) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try { await action(); setMessage(done); await load(); } catch (error) { setMessage(error instanceof Error ? error.message : t("That did not work.")); } finally { setBusy(false); }
  }

  return (
    <div className="sc-memory" role="tabpanel" id="jc-panel-memory" aria-labelledby="jc-tab-memory">
      <form className="jc-card" onSubmit={(event) => {
        event.preventDefault();
        if (text.trim()) void run(async () => { await api.createSecurityCopilotMemory(paneId, { kind, text: text.trim(), pinned: kind === "RULE" }); setText(""); }, t("Saved to the copilot's memory."));
      }}>
        <label className="jc-field"><span>{t("Kind")}</span>
          <select value={kind} onChange={(event) => setKind(event.target.value as SecurityMemory["kind"])}>
            {SECURITY_MEMORY_KINDS.map((entry) => <option key={entry} value={entry}>{t(KIND_LABEL[entry])}</option>)}
          </select>
        </label>
        <label className="jc-field"><span>{t("What the copilot should remember")}</span>
          <textarea value={text} rows={3} maxLength={4000} placeholder={t("e.g. Never reboot public-host before 23:00 Athens")} onChange={(event) => setText(event.target.value)} /></label>
        <button type="submit" className="jc-button primary" disabled={busy || !text.trim()}>{t("Remember")}</button>
      </form>
      {message ? <p className="jc-message" role="status">{message}</p> : null}
      <ul className="jc-list sc-memory-list" aria-label={t("Security Copilot memory")}>
        {memories.map((memory) => (
          <li key={memory.id} className="sc-memory-item">
            <div className="jc-row">
              <strong>{t(KIND_LABEL[memory.kind])}{memory.key ? `: ${memory.key}` : ""}</strong>
              {memory.pinned ? <span className="jc-pill">{t("Pinned")}</span> : null}
              <span className="jc-row-meta">{memory.source === "USER" ? t("You") : t("Copilot")}</span>
            </div>
            <p className="sc-feed-text">{memory.text}</p>
            <button type="button" className="jc-button" disabled={busy} onClick={() => void run(() => api.deleteSecurityCopilotMemory(paneId, memory.id), t("Forgotten."))}>{t("Forget")}</button>
          </li>
        ))}
      </ul>
      {!memories.length ? <p className="jc-muted jc-empty">{t("Nothing remembered yet.")}</p> : null}
    </div>
  );
}
