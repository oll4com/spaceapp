import { useEffect, useMemo, useState } from "react";
import type { JobApplication, JobApplicationField } from "@space/contracts";
import { api } from "../../api.js";
import { Brain, Check, Pencil } from "../ui-theme/app-icons.js";
import { subscribeJobApplyLiveEvents } from "./live-events.js";

const SOURCE_LABEL: Record<JobApplicationField["source"], string> = { PROFILE: "profile", CV: "CV", USER: "you", AGENT: "agent" };

function FieldRow({ field, onEdited }: { field: JobApplicationField; onEdited(field: JobApplicationField): void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(field.value ?? "");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      const response = await api.editJobApplyField(field.id, draft || null);
      onEdited(response.field);
      setEditing(false);
      setNote("Saved. The copilot remembers this answer.");
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  async function remember() {
    if (busy || !field.value) return;
    setBusy(true);
    try {
      await api.rememberJobApplyMemory({ kind: "ANSWER", key: field.label, text: field.value, source: "USER" });
      setNote("Added to memory.");
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Could not add to memory.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="jc-fieldrow">
      <div className="jc-fieldrow-head">
        <span className="jc-fieldrow-label">{field.label}</span>
        <span className="jc-tag">{field.fieldType}</span>
        <span className="jc-muted">from {SOURCE_LABEL[field.source]}</span>
        {field.verifiedAt ? <span className="jc-tag ok" title={field.verifiedAt}><Check aria-hidden="true" /> verified</span> : null}
      </div>
      {editing ? (
        <form className="jc-fieldrow-edit" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <input value={draft} aria-label={`Value of ${field.label}`} onChange={(event) => setDraft(event.target.value)} disabled={busy} autoFocus />
          <button type="submit" className="jc-button primary" disabled={busy}>Save</button>
          <button type="button" className="jc-button ghost" disabled={busy} onClick={() => { setEditing(false); setDraft(field.value ?? ""); }}>Cancel</button>
        </form>
      ) : (
        <div className="jc-fieldrow-value">
          <span className={field.value ? "" : "jc-muted"}>{field.value ?? "(empty)"}</span>
          {field.fieldType !== "file" ? <button type="button" className="jc-icon-button" title="Edit value (saves as your answer)" aria-label={`Edit ${field.label}`} onClick={() => setEditing(true)}><Pencil aria-hidden="true" /></button> : null}
          {field.fieldType !== "file" && field.value ? <button type="button" className="jc-icon-button" title="Add to memory as an answer" aria-label={`Remember ${field.label}`} disabled={busy} onClick={() => void remember()}><Brain aria-hidden="true" /></button> : null}
        </div>
      )}
      {note ? <p className="jc-message" role="status">{note}</p> : null}
    </li>
  );
}

export function FieldsTab({ paneId, application }: { paneId: string; application: JobApplication | null }) {
  const [fields, setFields] = useState<JobApplicationField[]>([]);
  const [loading, setLoading] = useState(false);
  const applicationId = application?.id ?? null;

  useEffect(() => {
    if (!applicationId) { setFields([]); return; }
    let cancelled = false;
    const load = () => {
      setLoading(true);
      api.jobApplyFields(applicationId).then((response) => { if (!cancelled) setFields(response.fields); }).catch(() => undefined).finally(() => { if (!cancelled) setLoading(false); });
    };
    load();
    const unsubscribe = subscribeJobApplyLiveEvents(paneId, (detail) => {
      const event = detail.payload.event as { applicationId?: string | null; type?: string } | undefined;
      if (event?.applicationId === applicationId && (event.type === "FIELD_FILLED" || event.type === "UPLOAD")) load();
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [applicationId, paneId]);

  const steps = useMemo(() => {
    const groups = new Map<number, { title: string; fields: JobApplicationField[] }>();
    for (const field of fields) {
      const group = groups.get(field.stepIndex) ?? { title: field.stepTitle ?? `Step ${field.stepIndex + 1}`, fields: [] };
      group.fields.push(field);
      groups.set(field.stepIndex, group);
    }
    return [...groups.entries()].sort(([left], [right]) => left - right);
  }, [fields]);

  return (
    <div className="jc-fields" role="tabpanel" id="jc-panel-fields" aria-labelledby="jc-tab-fields">
      {!application ? (
        <div className="jc-empty">
          <strong>Pick an application</strong>
          <span>Select a row in the Queue or Activity tab to see every field the copilot filled, step by step. Edit a value to teach it the right answer.</span>
        </div>
      ) : (
        <>
          <header className="jc-fields-head">
            <strong>{application.company}</strong>
            <span className="jc-muted">{application.role}</span>
            <span className={`jc-pill status-${application.status.toLowerCase()}`}>{application.status.replace("_", " ").toLowerCase()}</span>
          </header>
          {loading && fields.length === 0 ? <p className="jc-muted jc-panel-loading" role="status">Loading fields…</p> : null}
          {!loading && fields.length === 0 ? <div className="jc-empty"><strong>No fields recorded yet</strong><span>The copilot records every control it fills before it submits.</span></div> : null}
          {steps.map(([index, step]) => (
            <section key={index} className="jc-step-group">
              <h4>{step.title}</h4>
              <ul className="jc-fieldlist">
                {step.fields.map((field) => <FieldRow key={field.id} field={field} onEdited={(updated) => setFields((current) => current.map((entry) => entry.id === updated.id ? updated : entry))} />)}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
