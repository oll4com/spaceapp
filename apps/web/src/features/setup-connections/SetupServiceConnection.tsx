import { useEffect, useState } from "react";
import type { SetupFeatureId } from "@space/contracts";

export interface SetupServiceClient {
  getSetupServiceChoices(featureId: SetupFeatureId): Promise<{ choices: Array<{ id: string; label: string }> }>;
  checkSetupService(featureId: SetupFeatureId, draftRevision: number, choiceId: string): Promise<{ verified: boolean }>;
}
export function SetupServiceConnection({ client, featureId, label, initialChoice, onCheck }: {
  client: SetupServiceClient; featureId: SetupFeatureId; label: string; initialChoice?: string;
  onCheck: (choiceId: string) => Promise<void>;
}) {
  const [choices, setChoices] = useState<Array<{ id: string; label: string }>>([]);
  const [choice, setChoice] = useState(initialChoice ?? "");
  const [loading, setLoading] = useState(true); const [pending, setPending] = useState(false); const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true; setLoading(true); setError(null);
    void client.getSetupServiceChoices(featureId).then(result => {
      if (!active) return;
      setChoices(result.choices);
      setChoice(current => result.choices.some(item => item.id === current) ? current : result.choices[0]?.id ?? "");
    }).catch(() => { if (active) setError("Authorized connections could not be loaded. Review the service and try again."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, featureId]);
  async function check() {
    if (pending || !choice) return;
    setPending(true); setError(null);
    try { await onCheck(choice); }
    catch { setError("The connection did not pass its current check. Review it and try again."); }
    finally { setPending(false); }
  }
  return <div className="first-setup-service" aria-busy={loading || pending}>
    {loading ? <p role="status">Loading authorized connections…</p> : choices.length > 0 ? <>
      <label>{label} connection<select value={choice} disabled={pending} onChange={event => setChoice(event.target.value)}>
        {choices.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
      <p>This check uses the selected connection without publishing content or changing its data.</p>
      <button type="button" disabled={pending || !choice} onClick={() => void check()}>{pending ? "Checking…" : `Test ${label} connection`}</button>
    </> : <p>No authorized target is configured. Add a connection to this installation, then reopen setup, or remove this tool for now.</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
