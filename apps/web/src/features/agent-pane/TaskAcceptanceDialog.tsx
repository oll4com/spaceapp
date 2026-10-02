import { useEffect, useRef, useState } from "react";
import type { TaskAcceptance } from "@space/contracts";

export function TaskAcceptanceDialog({ current, onSave, onClose }: {
  current?: TaskAcceptance; onSave: (value?: TaskAcceptance) => void; onClose: () => void;
}) {
  const check = current?.checks[0];
  const [expected, setExpected] = useState(check?.kind === "TEXT_EQUALS" ? check.expected : "");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} aria-label="Result check" className="attachment-modal-body codex-resume-modal-body"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <form className="codex-goal-editor" onSubmit={event => {
      event.preventDefault();
      if (expected.length) onSave({ version: 1, checks: [{ id: "expected-text", kind: "TEXT_EQUALS",
        expected, normalization: "TRIM", critical: true }] });
    }}>
      <strong>Check the next result</strong>
      <p>Compare the final answer with the text you expect. Only this check is assessed; it does not certify the whole answer.</p>
      <label>Expected answer
        <textarea aria-label="Expected answer" autoFocus rows={4} maxLength={4000} value={expected}
          onChange={event => setExpected(event.currentTarget.value)} />
      </label>
      <p>Leading and trailing whitespace in the answer is ignored. Write the task instructions in your message.</p>
      <div>
        {current && <button type="button" onClick={() => onSave(undefined)}>Remove check</button>}
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="submit" disabled={!expected.length}>Save check</button>
      </div>
    </form>
  </dialog>;
}
