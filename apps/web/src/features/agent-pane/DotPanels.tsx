import { useEffect, useMemo, useState } from "react";
import type { AgentPaneSession, DotCollection, DotCollectionItem, DotGoal, DotProfile, DotResource, DotToolInvocation, DotToolSource, DotToolSummary } from "@space/contracts";
import { dotGoalStatusLabel } from "./DotGoals.js";
import { DotSchedules } from "./DotSchedules.js";
import { DotComputer } from "./DotComputer.js";
import { DotMemoryPanel } from "./DotMemory.js";
import { DotConnections } from "./DotConnections.js";
import { DotChannels } from "./DotChannels.js";
import { api } from "../../api.js";
export const dotTabs = ["Chat", "Activity", "Tasks", "Memory", "Tools", "Computer"] as const;
export type DotTab = typeof dotTabs[number];
const resources: Record<Exclude<DotTab, "Chat" | "Computer" | "Tools">, DotResource[]> = {
  Activity: ["activity", "receipts"], Tasks: ["tasks", "goals"], Memory: ["memory"]
};
const emptyText = { Activity: "No activity yet.", Tasks: "No tasks or goals yet.", Memory: "No attributed memory yet.", Tools: "No invocation receipts yet." };
interface Result { key: string; state: "loading" | "ready" | "unavailable"; items: DotCollectionItem[] }
const sourceLabels: Record<DotToolSource, string> = { SPACE_CONTROL: "Space control", SPACE_RESOURCE: "Space resources", SPACE_NATIVE: "Memory, tasks and chat", SPACE_GOAL: "Goals", SPACE_SCHEDULE: "Schedules", SPACE_COMPUTER: "Computer", SPACE_MEMORY: "Dot memory", CONNECTOR: "Email and calendar",
  BROWSER: "Browser", MCP: "MCP tools", INSTALLED_MCP: "Installed MCP servers" };
const availabilityLabels: Record<DotToolSummary["availability"], string> = { AVAILABLE: "Available", UNAVAILABLE: "Unavailable",
  NEEDS_CONNECTION: "Needs connection", FORBIDDEN: "Not allowed" };
const riskLabels: Record<DotToolSummary["risk"], string> = { READ: "Read", WRITE: "Changes state", DESTRUCTIVE: "Destructive" };
interface ToolsResult { key: string; state: "loading" | "ready" | "unavailable"; tools: DotToolSummary[]; receipts: DotToolInvocation[] }
export function DotToolsPanel({ dot, roomId, readTools, readReceipts }: { dot: DotProfile | null; roomId: string | null;
  readTools: (dotId: string, roomId?: string | null) => Promise<{ dotId: string; tools: DotToolSummary[] }>;
  readReceipts: (dotId: string) => Promise<{ dotId: string; items: DotToolInvocation[] }> }) {
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<DotToolSource | "ALL">("ALL");
  const key = `${dot?.dotId ?? "none"}:${roomId ?? ""}`;
  const [result, setResult] = useState<ToolsResult>({ key: "", state: "loading", tools: [], receipts: [] });
  useEffect(() => {
    let current = true;
    if (!dot) { setResult({ key, state: "unavailable", tools: [], receipts: [] }); return; }
    setResult({ key, state: "loading", tools: [], receipts: [] });
    void Promise.all([readTools(dot.dotId, roomId), readReceipts(dot.dotId)]).then(([tools, receipts]) => {
      if (!current) return;
      if (tools.dotId !== dot.dotId || receipts.dotId !== dot.dotId || receipts.items.some(item => item.dotId !== dot.dotId)) throw Error("Dot tool identity mismatch");
      setResult({ key, state: "ready", tools: tools.tools, receipts: receipts.items });
    }).catch(() => { if (current) setResult({ key, state: "unavailable", tools: [], receipts: [] }); });
    return () => { current = false; };
  }, [key, retry, readTools, readReceipts]);
  const state = result.key === key ? result.state : "loading";
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const visible = useMemo(() => result.tools.filter(tool => (source === "ALL" || tool.source === source)
    && terms.every(term => `${tool.id} ${tool.title} ${tool.description}`.toLocaleLowerCase().includes(term))), [result.tools, source, query]);
  const sources = [...new Set(result.tools.map(tool => tool.source))];
  const available = result.tools.filter(tool => tool.availability === "AVAILABLE").length;
  return <section className="dots-panel" aria-label={`Tools for ${dot?.name ?? "selected Dot"}`}>
    <h3>Tools</h3>
    <p className="dots-panel-hint">Availability reflects your current permissions. Every call is checked again when it runs, and receipts record what actually happened.</p>
    <DotConnections />
    <DotChannels />
    {state === "loading" ? <p role="status">Loading tools…</p> : state === "unavailable" ? <div role="status"><p>Tools unavailable.</p>
      <button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button></div> : <>
      <div className="dots-tools-controls">
        <input type="search" aria-label="Search tools" placeholder="Search tools" value={query} onChange={event => setQuery(event.currentTarget.value)} />
        <div className="dots-tools-filters" role="group" aria-label="Tool source">
          {(["ALL", ...sources] as Array<DotToolSource | "ALL">).map(value => <button key={value} type="button" aria-pressed={source === value}
            onClick={() => setSource(value)}>{value === "ALL" ? `All (${available} available)` : sourceLabels[value]}</button>)}
        </div>
      </div>
      {visible.length ? <ul className="dots-records dots-tool-list">{visible.map(tool => <li key={tool.id} data-availability={tool.availability}>
        <strong>{tool.title}</strong>
        <span><code>{tool.id}</code> · {availabilityLabels[tool.availability]} · {riskLabels[tool.risk]}{tool.requiredRole === "ADMIN" ? " · Administrator" : ""}</span>
        <p>{tool.statusReason ?? tool.description}</p>
      </li>)}</ul> : <p>No tools match this search.</p>}
      <h4>Recorded receipts</h4>
      {result.receipts.length ? <ul className="dots-records">{result.receipts.map(receipt => <li key={receipt.invocationId}>
        <strong><code>{receipt.toolId}</code></strong>
        <span>{receipt.status}</span>
        {receipt.statusReason ?? receipt.resultSummary ? <p>{(receipt.statusReason ?? receipt.resultSummary ?? "").slice(0, 300)}</p> : null}
        <time dateTime={receipt.startedAt}>{receipt.startedAt}</time>
      </li>)}</ul> : <p>No invocation receipts yet.</p>}
    </>}
  </section>;
}
function DotGoalList({ dot, readGoals }: { dot: DotProfile; readGoals: (dotId: string) => Promise<{ dotId: string; items: DotGoal[] }> }) {
  const [goals, setGoals] = useState<DotGoal[] | null>(null);
  useEffect(() => {
    let current = true;
    void Promise.resolve().then(() => readGoals(dot.dotId)).then((result) => { if (current && result.dotId === dot.dotId) setGoals(result.items.filter((goal) => goal.dotId === dot.dotId)); })
      .catch(() => { if (current) setGoals(null); });
    return () => { current = false; };
  }, [dot.dotId, readGoals]);
  if (!goals?.length) return null;
  return <><h4>Goals</h4><ul className="dots-records">{goals.map((goal) => <li key={goal.goalId}>
    <strong>{goal.objective}</strong>
    <span>{dotGoalStatusLabel(goal.status)} · Step {goal.usage.steps} of {goal.budget.maxSteps}{goal.milestones.length
      ? ` · ${goal.milestones.filter((milestone) => milestone.status === "DONE").length}/${goal.milestones.length} milestones` : ""}</span>
    {goal.statusReason ? <p>{goal.statusReason}</p> : null}
    <time dateTime={goal.updatedAt}>{goal.updatedAt}</time>
  </li>)}</ul></>;
}
export function DotPanels({ tab, dot, session, sessionId: sessionIdOverride, roomId = null, visible = true, read = api.dotCollection, readTools = api.dotTools,
  readReceipts = api.dotToolInvocations, readGoals = api.dotGoals }: {
  tab: Exclude<DotTab, "Chat">; dot: DotProfile | null; session: AgentPaneSession | null; roomId?: string | null; visible?: boolean;
  /** Settings → Dots: the Dot's latest conversation, where new reminders run. */
  sessionId?: string | null;
  readGoals?: (dotId: string) => Promise<{ dotId: string; items: DotGoal[] }>;
  read?: (dotId: string, resource: DotResource) => Promise<DotCollection>;
  readTools?: (dotId: string, roomId?: string | null) => Promise<{ dotId: string; tools: DotToolSummary[] }>;
  readReceipts?: (dotId: string) => Promise<{ dotId: string; items: DotToolInvocation[] }>;
}) {
  const [retry, setRetry] = useState(0);
  const key = `${dot?.dotId ?? "none"}:${tab}`;
  const [result, setResult] = useState<Result>({ key: "", state: "loading", items: [] });
  useEffect(() => {
    let current = true;
    if (tab === "Computer" || tab === "Tools") return;
    if (!dot) { setResult({ key, state: "unavailable", items: [] }); return; }
    setResult({ key, state: "loading", items: [] });
    void Promise.all(resources[tab].map(resource => read(dot.dotId, resource))).then(collections => {
      if (!current) return;
      if (collections.some(collection => collection.dotId !== dot.dotId || collection.items.some(item => item.dotId !== dot.dotId))) throw Error("Dot collection identity mismatch");
      setResult({ key, state: "ready", items: collections.flatMap(collection => collection.items) });
    }).catch(() => { if (current) setResult({ key, state: "unavailable", items: [] }); });
    return () => { current = false; };
  }, [key, retry, read]);
  const dotSessionId = sessionIdOverride !== undefined ? sessionIdOverride : dot && session?.dotId === dot.dotId ? session.binding.sessionId ?? null : null;
  if (tab === "Computer") return <DotComputer key={dot?.dotId ?? "none"} dot={dot} roomId={roomId} visible={visible} sessionId={dotSessionId} />;
  if (tab === "Tools") return <DotToolsPanel dot={dot} roomId={roomId} readTools={readTools} readReceipts={readReceipts} />;
  const state = result.key === key ? result.state : "loading";
  return <section className="dots-panel" aria-label={`${tab} for ${dot?.name ?? "selected Dot"}`}>
    <h3>{tab}</h3>
    {tab === "Memory" && dot ? <DotMemoryPanel key={dot.dotId} dot={dot} roomId={roomId} /> : null}
    {tab === "Memory" ? <><h4>Space memory attributed to {dot?.name ?? "this Dot"}</h4>
      <p className="dots-panel-hint">Read-only Space memory linked to this Dot. Source labels reflect recorded attribution.</p></> : null}
    {tab === "Tasks" && dot ? <><DotGoalList dot={dot} readGoals={readGoals} />
      <DotSchedules dot={dot} sessionId={dotSessionId} /></> : null}
    {state === "loading" ? <p role="status">Loading {tab.toLowerCase()}…</p> : state === "unavailable" ? <div role="status"><p>{tab} unavailable.</p>
      <button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button></div> : !result.items.length ? <p>{emptyText[tab]}</p> :
      <ul className="dots-records">{result.items.map((item, i) => <li key={`${item.id ?? item.runId ?? item.sessionId ?? i}:${i}`}>
        <strong>{item.title ?? item.objective ?? item.kind ?? (tab === "Memory" ? "Attributed memory" : "Recorded task")}</strong>
        {item.status ? <span>{item.status}</span> : null}
        {item.statusReason ? <p>{item.statusReason}</p> : null}
        {tab === "Memory" ? <><span>{item.kind === "PERSONAL" ? "Dot-attributed personal source" : "Dot-attributed room source"}{item.scope ? ` · ${item.scope}` : ""}</span>
          {item.source ? <small>Source: {item.source}</small> : <small>Source attribution unavailable.</small>}
          {item.body ? <p className="dots-memory-body">{item.body}</p> : item.kind === "PERSONAL" ? <p>Structured personal memory is available as read-only metadata.</p> : null}</> : null}
        {item.updatedAt ?? item.createdAt ? <time dateTime={item.updatedAt ?? item.createdAt}>{item.updatedAt ?? item.createdAt}</time> : null}
      </li>)}</ul>}
  </section>;
}
