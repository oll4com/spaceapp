import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentToolsCatalogResponse, AgentToolScope, ApplyAgentToolsInput } from "@space/contracts";
import { api } from "../../api.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { ToolRoutingSettings } from "./ToolRoutingSettings.js";
import type { AgentToolsUsage } from "./agent-tools-usage.js";
import "./agent-capabilities.css";

/** GET /api/agent-tools/usage: written every 10 minutes by the inventory job (identifiers and counts only). */
export type { AgentToolsUsage } from "./agent-tools-usage.js";

type Tab = "skills" | "backends" | "routing";
const tabs: Array<[Tab, string]> = [["skills", "Skills"], ["backends", "Tool servers"], ["routing", "Routing"]];

function day(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "";
}

function runtimeLabel(runtimeId: string): string {
  return runtimeId.replace(/^cli:/, "");
}

export function AgentCapabilitiesCard() {
  const [tab, setTab] = useState<Tab>("skills");
  const [catalog, setCatalog] = useState<AgentToolsCatalogResponse | null>(null);
  const [usage, setUsage] = useState<AgentToolsUsage | null>(null);
  const [drafts, setDrafts] = useState<Map<string, AgentToolScope>>(new Map());
  const [unusedOnly, setUnusedOnly] = useState(false);
  const [applying, setApplying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const [nextCatalog, nextUsage] = await Promise.allSettled([api.agentToolsCatalog(), api.agentToolsUsage()]);
    if (nextCatalog.status === "fulfilled") setCatalog(nextCatalog.value);
    else setError(nextCatalog.reason instanceof Error ? nextCatalog.reason.message : "The skill catalog could not be loaded.");
    if (nextUsage.status === "fulfilled") setUsage(nextUsage.value);
    setDrafts(new Map());
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Reads of a nested skill or bundled file (`space-superpowers/brainstorming`) count for the installed skill.
  const usageBySkill = useMemo(() => {
    const totals = new Map<string, { uses: number; lastUsedAt: string | null; byRuntime: Record<string, number> }>();
    for (const entry of usage?.skills ?? []) {
      const root = entry.name.split("/")[0]!;
      const total = totals.get(root) ?? { uses: 0, lastUsedAt: null, byRuntime: {} };
      total.uses += entry.uses;
      if (entry.lastUsedAt && (!total.lastUsedAt || entry.lastUsedAt > total.lastUsedAt)) total.lastUsedAt = entry.lastUsedAt;
      for (const [runtime, count] of Object.entries(entry.byRuntime)) total.byRuntime[runtime] = (total.byRuntime[runtime] ?? 0) + count;
      totals.set(root, total);
    }
    return totals;
  }, [usage]);
  const skills = useMemo(() => {
    const states = catalog?.states ?? [];
    return (catalog?.entries ?? [])
      .filter((entry) => entry.kind === "SKILL")
      .map((entry) => ({
        ...entry,
        enabled: states.some((state) => state.toolId === entry.toolId && state.enabled),
        usage: usageBySkill.get(entry.name) ?? null
      }))
      .sort((a, b) => (b.usage?.uses ?? 0) - (a.usage?.uses ?? 0) || a.name.localeCompare(b.name));
  }, [catalog, usageBySkill]);
  const visibleSkills = unusedOnly ? skills.filter((skill) => !skill.usage?.uses) : skills;
  const unusedCount = skills.filter((skill) => !skill.usage?.uses).length;

  const backends = useMemo(() => {
    const calls = new Map<string, { calls: number; errors: number; lastUsedAt: string | null; p95Ms: number | null }>();
    for (const tool of usage?.mcp ?? []) {
      const current = calls.get(tool.serverId) ?? { calls: 0, errors: 0, lastUsedAt: null, p95Ms: null };
      current.calls += tool.calls;
      current.errors += tool.errors;
      if (tool.lastUsedAt && (!current.lastUsedAt || tool.lastUsedAt > current.lastUsedAt)) current.lastUsedAt = tool.lastUsedAt;
      if (tool.p95Ms !== null) current.p95Ms = Math.max(current.p95Ms ?? 0, tool.p95Ms);
      calls.set(tool.serverId, current);
    }
    return (usage?.backends ?? []).map((backend) => ({ ...backend, usage: calls.get(backend.id) ?? null }));
  }, [usage]);

  function toggle(toolId: string, enabled: boolean) {
    setDrafts((current) => {
      const next = new Map(current);
      const target: AgentToolScope = enabled ? "NONE" : "COMMON";
      if (next.get(toolId) !== undefined) next.delete(toolId);
      else next.set(toolId, target);
      return next;
    });
    setMessage(null);
  }

  async function apply() {
    const assignments: ApplyAgentToolsInput["assignments"] = [...drafts.entries()].map(([toolId, scope]) => ({ toolId, kind: "SKILL", scope, runtimeIds: [] }));
    if (assignments.length === 0) return;
    setApplying(true);
    setError(null);
    try {
      const result = await api.applyAgentTools(assignments);
      const changed = result.results.filter((runtime) => runtime.files.some((file) => file.changed)).map((runtime) => runtimeLabel(runtime.runtimeId));
      setMessage(changed.length ? `Applied to ${changed.join(", ")}. New CLI sessions pick it up.` : "Applied; no CLI configuration needed a change.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Applying the skill changes failed.");
    } finally {
      setApplying(false);
    }
  }

  // Text sits in divs: the Modern theme makes dock paragraphs, spans and strong text inherit their colour.
  return (
    <div className="agent-capabilities">
      <div className="agent-capabilities-tabs" role="tablist" aria-label="Agent capabilities">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {error ? <div className="agent-capabilities-error" role="alert">{error}</div> : null}

      {tab === "skills" ? (
        <section aria-label="Skills">
          <div className="agent-capabilities-intro">
            Skills are ready-made instructions an agent reads only when a task needs them. Switch one off to stop every agent from using it.
          </div>
          <div className="agent-capabilities-note">
            {usage?.available
              ? `Counts how often Claude Code, Codex and Space's tool dispatcher used each skill in the last ${usage.windowDays ?? 30} days.${usage.complete === false ? " Older sessions are still being counted." : ""}`
              : usage?.reason ?? "Usage is not available yet."}
          </div>
          <div className="agent-capabilities-toolbar">
            <SpaceToggle
              compact
              name="agent-capabilities-unused-only"
              label={`Only unused in 30 days (${unusedCount})`}
              checked={unusedOnly}
              onChange={setUnusedOnly}
            />
            {drafts.size || applying ? (
              <button type="button" className="agent-capabilities-apply" disabled={applying} onClick={() => void apply()}>
                {applying ? "Applying..." : `Apply ${drafts.size} change${drafts.size === 1 ? "" : "s"}`}
              </button>
            ) : null}
          </div>
          {message ? <div className="agent-capabilities-note" role="status">{message}</div> : null}
          <ul className="agent-capabilities-list">
            {visibleSkills.map((skill) => {
              const pending = drafts.has(skill.toolId);
              const enabled = pending ? !skill.enabled : skill.enabled;
              return (
                <li key={skill.toolId} data-skill={skill.name} data-pending={pending || undefined}>
                  <div className="agent-capabilities-main">
                    <div className="agent-capabilities-name">{skill.name}</div>
                    <div className="agent-capabilities-description" title={skill.description}>{skill.description}</div>
                    <div className="agent-capabilities-meta">
                      {skill.usage?.uses
                        ? `${skill.usage.uses} use${skill.usage.uses === 1 ? "" : "s"}, last ${day(skill.usage.lastUsedAt)} (${Object.keys(skill.usage.byRuntime).map(runtimeLabel).join(", ")})`
                        : "Not used in 30 days"}
                    </div>
                  </div>
                  <SpaceToggle compact className={pending ? "agent-capabilities-pending" : undefined} checked={enabled}
                    label={pending ? "Pending" : enabled ? "On" : "Off"} ariaLabel={`${skill.name} for every agent`}
                    onChange={() => toggle(skill.toolId, skill.enabled)} />
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {tab === "backends" ? (
        <section aria-label="Tool servers">
          <div className="agent-capabilities-intro">
            Tool servers (MCP) give agents extra abilities, such as a browser or Space operations. Each one starts only when a task needs it.
            To keep one away from a specific agent, use Routing.
          </div>
          <ul className="agent-capabilities-list">
            {backends.map((backend) => (
              <li key={backend.id} data-backend={backend.id}>
                <div className="agent-capabilities-main">
                  <div className="agent-capabilities-name">{backend.name} <code>{backend.id}</code></div>
                  <div className="agent-capabilities-description" title={backend.description}>{backend.description}</div>
                  <div className="agent-capabilities-meta">
                    {backend.stale
                      ? "Tool list could not be refreshed; agents see the last known tools."
                      : `${backend.toolCount ?? 0} tools cached ${day(backend.schemaBuiltAt)}`}
                    {" · "}
                    {backend.usage?.calls
                      ? `${backend.usage.calls} calls, ${backend.usage.errors} failed, p95 ${backend.usage.p95Ms ?? "?"} ms, last ${day(backend.usage.lastUsedAt)}`
                      : "No calls in 30 days"}
                  </div>
                </div>
              </li>
            ))}
            {backends.length === 0 ? <li className="agent-capabilities-empty">No tool server information has been collected yet.</li> : null}
          </ul>
        </section>
      ) : null}

      {tab === "routing" ? <ToolRoutingSettings /> : null}
    </div>
  );
}
