import { useEffect, useState } from "react";
import { CLI_PANE_TYPES, nativeToolRoutingRuntimeIds, type EffectiveToolPlanV1, type ModelCapabilityProfileV1, type ToolRoutingStateV1, type ToolRoutingOverride } from "@space/contracts";
import { api } from "../../api.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";

const modes: Array<[ToolRoutingOverride["mode"], string]> = [
  ["AUTOMATIC", "Automatic"], ["NATIVE_ONLY", "Built-in only"],
  ["ALLOW_FALLBACK", "Built-in, else Space"], ["DISABLED", "Off"]
];
const registrationText: Record<EffectiveToolPlanV1["registration"], string> = {
  NONE: "no tool servers are registered; agents reach Space tools on demand",
  LAZY_DISPATCHER: "one dispatcher is registered and starts tool servers only when needed",
  LEGACY_CONFIG: "the agent keeps its own tool configuration"
};
const routeText: Record<EffectiveToolPlanV1["routes"][number]["route"], string> = {
  NATIVE: "uses its built-in ability", ON_DEMAND: "starts the Space tool when a task needs it",
  UNAVAILABLE: "not available", DISABLED: "off"
};
export function ToolRoutingSettings() {
  const [state, setState] = useState<ToolRoutingStateV1 | null>(null);
  const [profiles, setProfiles] = useState<ModelCapabilityProfileV1[]>([]);
  const [runtimeId, setRuntimeId] = useState("cli:codex");
  const [modelId, setModelId] = useState("*");
  const [plan, setPlan] = useState<EffectiveToolPlanV1 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const nativeRuntime = (nativeToolRoutingRuntimeIds as readonly string[]).includes(runtimeId);
  useEffect(() => {
    let active = true;
    api.modelCapabilities().then((result) => {
      if (active) { setState(result.state); setProfiles(result.profiles); }
    }).catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    api.effectiveToolRouting(runtimeId, modelId).then((result) => { if (active) setPlan(result); })
      .catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [runtimeId, modelId, state?.revision]);
  function choose(toolId: string, mode: ToolRoutingOverride["mode"]) {
    setState((current) => current ? {
      ...current,
      overrides: [...current.overrides.filter((entry) => !(entry.toolId === toolId && entry.runtimeId === runtimeId && entry.modelId === modelId)),
        { toolId, runtimeId, modelId, mode }]
    } : current);
    setDirty(true);
  }
  async function save() {
    if (!state) return;
    setBusy(true); setError(null);
    try {
      const updated = await api.saveToolRouting({
        expectedRevision: state.revision, enabledRuntimeIds: state.enabledRuntimeIds, overrides: state.overrides
      });
      setState(updated); setDirty(false);
    } catch (err) { setError(err instanceof Error ? err.message : "Routing update failed."); }
    finally { setBusy(false); }
  }
  // Text sits in divs: the Modern theme makes dock paragraphs inherit their colour.
  return <section aria-label="Tool routing" className="agent-tools-routing">
    <div className="agent-capabilities-intro">
      Agents use their own built-in abilities first and start a Space tool server only when a task needs it.
      Change a rule only if one agent or model should handle a tool differently.
    </div>
    {error && <div className="agent-capabilities-error" role="alert">{error}</div>}
    <div className="agent-tools-routing-filters">
      <label>Agent
        <select value={runtimeId} onChange={(event) => { setRuntimeId(event.target.value); setModelId("*"); }}>
          <option value="*">All agents</option>
          {CLI_PANE_TYPES.map((type) => <option key={type.id} value={type.id}>{type.shortLabel}</option>)}
        </select>
      </label>
      <label>Model
        <input value={modelId === "*" ? "" : modelId} placeholder="All models" list="routing-models"
          onChange={(event) => setModelId(event.target.value.trim() || "*")} aria-label="Routing model" />
        <datalist id="routing-models">
          {profiles.filter((entry) => entry.runtimeId === runtimeId).map((entry) => <option key={entry.modelId} value={entry.modelId} />)}
        </datalist>
      </label>
    </div>
    {state && nativeRuntime && (
      <SpaceToggle
        className="tool-routing-toggle"
        label="Enable capability routing for new sessions"
        detail="New sessions of this agent follow these rules. Sessions already open keep theirs."
        checked={state.enabledRuntimeIds.includes(runtimeId)}
        onChange={(checked) => {
          setState({ ...state, enabledRuntimeIds: checked ? [...new Set([...state.enabledRuntimeIds, runtimeId])] : state.enabledRuntimeIds.filter((id) => id !== runtimeId) });
          setDirty(true);
        }}
      />
    )}
    <div className="agent-capabilities-note">
      {plan ? `At start, ${registrationText[plan.registration]}. Sessions already open keep their setup.` : "Loading the saved rules…"}
    </div>
    {!nativeRuntime && <div className="agent-capabilities-note">These start-up rules apply to Codex and Claude Code. Other agents keep their existing configuration.</div>}
    <details className="agent-tools-routing-legend">
      <summary>What do the choices mean?</summary>
      <dl>
        <dt>Automatic</dt><dd>Use the built-in ability when the agent has one, otherwise the Space tool when a task needs it.</dd>
        <dt>Built-in only</dt><dd>Never start the Space tool, even if the agent has no built-in ability.</dd>
        <dt>Built-in, else Space</dt><dd>Always allow the Space tool when the built-in ability is missing.</dd>
        <dt>Off</dt><dd>The agent never uses this tool.</dd>
      </dl>
    </details>
    <ul className="agent-capabilities-list agent-tools-routing-list">{plan?.routes.map((route) => {
      const mode = state?.overrides.find((entry) => entry.toolId === route.toolId && entry.runtimeId === runtimeId && entry.modelId === modelId)?.mode ?? route.mode;
      return <li key={route.toolId}>
        <div className="agent-capabilities-main">
          <div className="agent-capabilities-name">{route.toolId.replace("mcp:", "")}</div>
          <details>
            <summary>Why?</summary>
            <div className="agent-capabilities-meta">{route.reason} {plan.managed ? "Saved rule" : "Preview"}: {routeText[route.route]}.</div>
          </details>
        </div>
        <select aria-label={route.toolId + " routing"} value={mode} onChange={(event) => choose(route.toolId, event.target.value as ToolRoutingOverride["mode"])}>
          {modes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </li>;
    })}</ul>
    <div className="agent-tools-routing-actions">
      {dirty && <div className="agent-capabilities-note">Unsaved changes. The “Why?” notes show the last saved rules.</div>}
      <button type="button" className="agent-capabilities-apply" disabled={!state || !dirty || busy} onClick={() => void save()}>{busy ? "Saving..." : "Save routing"}</button>
    </div>
  </section>;
}
