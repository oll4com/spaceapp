import { useEffect, useRef, useState } from "react";
import type { TaskAcceptance } from "@space/contracts";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";

export function TaskAcceptanceDialog({ current, onSave, onClose }: {
  current?: TaskAcceptance; onSave: (value?: TaskAcceptance) => void; onClose: () => void;
}) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const check = current?.checks[0];
  const [expected, setExpected] = useState(check?.kind === "TEXT_EQUALS" ? check.expected : "");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} aria-label={t("Result check")} className="attachment-modal-body codex-resume-modal-body"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <form className="codex-goal-editor" onSubmit={event => {
      event.preventDefault();
      if (expected.length) onSave({ version: 1, checks: [{ id: "expected-text", kind: "TEXT_EQUALS",
        expected, normalization: "TRIM", critical: true }] });
    }}>
      <strong>{t("Check the next result")}</strong>
      <p>{t("Compare the final answer with the text you expect. Only this check is assessed; it does not certify the whole answer.")}</p>
      <label>{t("Expected answer")}
        <textarea aria-label={t("Expected answer")} autoFocus rows={4} maxLength={4000} value={expected}
          onChange={event => setExpected(event.currentTarget.value)} />
      </label>
      <p>{t("Leading and trailing whitespace in the answer is ignored. Write the task instructions in your message.")}</p>
      <div>
        {current && <button type="button" onClick={() => onSave(undefined)}>{t("Remove check")}</button>}
        <button type="button" onClick={onClose}>{t("Cancel")}</button>
        <button type="submit" disabled={!expected.length}>{t("Save check")}</button>
      </div>
    </form>
  </dialog>;
}
