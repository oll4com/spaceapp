import { useEffect, useRef, useState } from "react";
import { maintenancePlanSchema, type AdminOperationRun, type MaintenancePlanRequest, type MaintenanceApplyRequest } from "@space/contracts";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";

export interface RecommendedMaintenanceClient {
  createMaintenancePlan(input: MaintenancePlanRequest): Promise<AdminOperationRun>;
  applyMaintenancePlan(planId: string, input: MaintenanceApplyRequest): Promise<AdminOperationRun>;
  listCliMaintenanceRuns(): Promise<{ data: AdminOperationRun[] }>;
}
/** Tolerates missing or partial entries; a malformed row must never take the view down. */
function runtimeRows(run: AdminOperationRun): Array<{ runtimeId: string; displayName: string; status: string; summary: string }> {
  const value = run.result.runtimes;
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const runtimeId = typeof row.runtimeId === "string" ? row.runtimeId : "runtime";
    return [{
      runtimeId,
      displayName: typeof row.displayName === "string" ? row.displayName : runtimeId,
      status: typeof row.status === "string" ? row.status : "UNKNOWN",
      summary: typeof row.summary === "string" ? row.summary : ""
    }];
  });
}
export function RecommendedMaintenance({ client, onBusyChange }: { client: RecommendedMaintenanceClient; onBusyChange: (busy: boolean) => void }) {
  const requestGeneration = useRef(0);
  const initializedPlan = useRef<string | null>(null);
  const [scope, setScope] = useState<"enabled" | "all">("enabled");
  const [run, setRun] = useState<AdminOperationRun | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const plan = maintenancePlanSchema.safeParse(run?.result.plan);
  const active = run?.status === "QUEUED" || run?.status === "RUNNING";
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => {
    let disposed = false;
    const generation = requestGeneration.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loading = false;
    let needsRefresh = !run || run.status === "QUEUED" || run.status === "RUNNING";
    const load = async () => {
      if (disposed || loading || document.hidden || !needsRefresh) return;
      loading = true;
      try {
        const runs = (await client.listCliMaintenanceRuns()).data;
        const next = run ? runs.find(r => r.id === run.id) : runs.find(r => ["CLI_MAINTENANCE_PLAN", "CLI_MAINTENANCE_APPLY"].includes(r.operationType));
        if (!disposed && generation === requestGeneration.current) {
          needsRefresh = next?.status === "QUEUED" || next?.status === "RUNNING";
          if (next) {
            setRun(next);
            const parsed = maintenancePlanSchema.safeParse(next.result.plan);
            if (parsed.success && initializedPlan.current !== parsed.data.planId) {
              initializedPlan.current = parsed.data.planId;
              setSelected(parsed.data.actions.map(a => a.id));
            }
          }
        }
      } catch { if (!disposed) setError("Progress could not be refreshed. The recorded run remains available."); }
      finally {
        loading = false;
        if (!disposed && generation === requestGeneration.current && needsRefresh && !document.hidden) timer = setTimeout(load, 2500);
      }
    };
    const visibility = () => { clearTimeout(timer); if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", visibility);
    void load();
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [client, run?.id]);
  async function check() {
    requestGeneration.current += 1;
    setBusy(true); setError(null);
    try { setRun(await client.createMaintenancePlan({ scope })); setKey(crypto.randomUUID()); setSelected([]); }
    catch (e) { setError(e instanceof Error ? e.message : "Check could not start."); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (!plan.success || !selected.length) return;
    requestGeneration.current += 1;
    setBusy(true); setError(null);
    try { setRun(await client.applyMaintenancePlan(plan.data.planId, { selectedActionIds: selected as MaintenanceApplyRequest["selectedActionIds"], idempotencyKey: key, confirmation: "APPLY MAINTENANCE" })); }
    catch (e) { setError(e instanceof Error ? e.message : "Maintenance could not start. Retry uses the same request."); }
    finally { setBusy(false); }
  }
  const phase = run?.operationType === "CLI_MAINTENANCE_APPLY" && !active ? "Results" : active ? (run?.operationType === "CLI_MAINTENANCE_PLAN" ? "Check" : "Run") : plan.success ? "Review" : run ? "Results" : "Check";
  return <section className="recommended-maintenance" aria-label="Recommended maintenance">
    <nav aria-label="Maintenance progress">{["Check", "Review", "Run", "Results"].map(label => <span key={label} aria-current={phase === label ? "step" : undefined}>{label}</span>)}</nav>
    <h3>Check & fix</h3><p>Review the changes before running them. Progress is saved so you can return later.</p>
    <label>Tools <select aria-label="Maintenance scope" value={scope} disabled={busy || active} onChange={e => { setScope(e.target.value as typeof scope); }}><option value="enabled">Enabled CLIs</option><option value="all">All managed CLIs</option></select></label>
    <button type="button" disabled={busy || active} onClick={() => void check()}>{active && run?.operationType === "CLI_MAINTENANCE_PLAN" ? "Checking…" : "Check"}</button>
    {error && <p role="alert">{error}</p>}
    {run && <p role="status">{run.status} · {run.summary}</p>}
    {plan.success && run?.operationType === "CLI_MAINTENANCE_PLAN" && run.status === "SUCCEEDED" && !active && <div>
      {plan.data.actions.length ? plan.data.actions.map(action => (
        <SpaceToggle
          key={action.id}
          className="maintenance-choice-toggle"
          name={`maintenance-action-${action.id}`}
          label={<strong>{action.label} · {action.kind === "REPAIR" ? "Repair & update" : "Update"}</strong>}
          detail={<>{action.installedVersion ?? "Not installed"} → {action.targetVersion ?? "—"} · {action.reasons.join(" · ")}</>}
          checked={selected.includes(action.id)}
          disabled={busy}
          onChange={(checked) => setSelected(ids => checked ? [...ids, action.id] : ids.filter(id => id !== action.id))}
        />
      )) : <p>No automatic changes are recommended. Review any unavailable checks or login requirements below.</p>}
      <button type="button" disabled={busy || !selected.length} onClick={() => void apply()}>Confirm & run {selected.length} actions</button>
    </div>}
    {run && <details><summary>Check details & results</summary><ul>{runtimeRows(run).map((r, index) => <li key={`${r.runtimeId}-${index}`}><strong>{r.displayName}</strong> · {r.status} · {r.summary}</li>)}</ul></details>}
  </section>;
}
