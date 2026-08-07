import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AgentToolApplyRuntimeResult,
  AgentToolsCatalogResponse,
  AgentToolScope,
  ApplyAgentToolsInput
} from "@space/contracts";
import { CheckCircle2, Loader2, RefreshCw, Save, ServerCog, Sparkles } from "../ui-theme/app-icons.js";
import { api, SpaceApiError } from "../../api.js";

interface AgentToolsDockProps {
  canManage: boolean;
  refreshKey?: string | null;
}

function enabledRuntimeCount(states: AgentToolsCatalogResponse["states"], toolId: string): number {
  return states.filter((state) => state.toolId === toolId && state.enabled).length;
}

export function AgentToolsDock({ canManage, refreshKey }: AgentToolsDockProps) {
  const [catalog, setCatalog] = useState<AgentToolsCatalogResponse | null>(null);
  const [drafts, setDrafts] = useState<Map<string, AgentToolScope>>(new Map());
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<AgentToolApplyRuntimeResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await api.agentToolsCatalog();
      setCatalog(payload);
      setDrafts(new Map());
      setApplyResult(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Agent tools catalog load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog, refreshKey]);

  const runtimes = catalog?.runtimes ?? [];
  const writableRuntimes = runtimes.filter((runtime) => runtime.supported && !runtime.readOnly);
  const states = catalog?.states ?? [];

  const { mcpEntries, skillEntries } = useMemo(() => {
    const entries = catalog?.entries ?? [];
    return {
      mcpEntries: entries.filter((entry) => entry.kind === "MCP"),
      skillEntries: entries.filter((entry) => entry.kind === "SKILL")
    };
  }, [catalog]);

  const enabledCountFor = useCallback(
    (toolId: string) => enabledRuntimeCount(states, toolId),
    [states]
  );

  const mcpAllOn = mcpEntries.length > 0 && mcpEntries.every((entry) => enabledCountFor(entry.toolId) > 0);
  const mcpAllOff = mcpEntries.length === 0 || mcpEntries.every((entry) => enabledCountFor(entry.toolId) === 0);
  const skillsAllOn = skillEntries.length > 0 && skillEntries.every((entry) => enabledCountFor(entry.toolId) > 0);
  const skillsAllOff = skillEntries.length === 0 || skillEntries.every((entry) => enabledCountFor(entry.toolId) === 0);

  const dirtyFor = useCallback(
    (toolId: string): boolean => {
      const draft = drafts.get(toolId);
      if (!draft) return false;
      return (draft === "COMMON") !== (enabledCountFor(toolId) > 0);
    },
    [drafts, enabledCountFor]
  );

  const pendingCount = useMemo(() => {
    return [...mcpEntries, ...skillEntries].filter((entry) => dirtyFor(entry.toolId)).length;
  }, [mcpEntries, skillEntries, dirtyFor]);

  function setBulkDraft(kind: "MCP" | "SKILL", scope: AgentToolScope) {
    const entries = kind === "MCP" ? mcpEntries : skillEntries;
    setDrafts((current) => {
      const next = new Map(current);
      for (const entry of entries) {
        next.set(entry.toolId, scope);
      }
      return next;
    });
    setApplyResult(null);
  }

  function toggleToolDraft(toolId: string, scope: AgentToolScope) {
    setDrafts((current) => {
      const next = new Map(current);
      if (next.get(toolId) === scope) {
        next.delete(toolId);
      } else {
        next.set(toolId, scope);
      }
      return next;
    });
    setApplyResult(null);
  }

  async function applyChanges() {
    const assignments: ApplyAgentToolsInput["assignments"] = [];
    for (const entry of [...mcpEntries, ...skillEntries]) {
      const draft = drafts.get(entry.toolId);
      if (!draft) continue;
      assignments.push({
        toolId: entry.toolId,
        kind: entry.kind,
        scope: draft,
        runtimeIds: []
      });
    }
    if (assignments.length === 0) {
      setError("No agent tool changes to apply.");
      return;
    }
    setApplying(true);
    setError(null);
    setApplyResult(null);
    try {
      const result = await api.applyAgentTools(assignments);
      setApplyResult(result.results);
      await loadCatalog();
    } catch (err) {
      setError(err instanceof SpaceApiError ? err.message : err instanceof Error ? err.message : "Applying agent tools failed");
    } finally {
      setApplying(false);
    }
  }

  const toolRow = (toolId: string, name: string, kind: "MCP" | "SKILL") => {
    const enabled = enabledCountFor(toolId) > 0;
    const draft = drafts.get(toolId);
    const pending = dirtyFor(toolId);
    const nextScope = enabled ? "NONE" : "COMMON";
    const scope = draft ?? (enabled ? "COMMON" : "NONE");
    return (
      <li key={toolId} className="agent-tools-tool-item">
        <div className="agent-tools-tool-main">
          <div className="agent-tools-tool-title">
            <span>{name}</span>
            <span className={`agent-tools-kind-chip ${kind === "MCP" ? "mcp" : "skill"}`}>
              {kind === "MCP" ? "MCP" : "SKILL"}
            </span>
          </div>
          <span className={`agent-tools-tool-state ${enabled ? "enabled" : ""}`}>
            {enabled ? "Enabled" : "Disabled"}
          </span>
        </div>
        <button
          type="button"
          className={`agent-tools-scope-button ${scope === "COMMON" ? "active" : ""} ${pending ? "pending" : ""}`}
          onClick={() => toggleToolDraft(toolId, nextScope)}
        >
          {enabled ? "Disable" : "Enable"}
        </button>
      </li>
    );
  };

  return (
    <div className="agent-tools-dock">
      <div className="dock-section-heading">
        <span>Agent Tools</span>
        {canManage && (
          <button type="button" className="icon-button" onClick={() => void loadCatalog()} aria-label="Refresh agent tools">
            <RefreshCw aria-hidden="true" />
          </button>
        )}
      </div>

      {!canManage ? (
        <p className="dock-muted-text">The ADMIN role can manage agent tools across CLI runtimes.</p>
      ) : (
        <>
          {error && <p className="dock-error-text">{error}</p>}

          <div className="agent-tools-bulk">
            <div className="agent-tools-bulk-card">
              <div className="agent-tools-bulk-heading">
                <ServerCog aria-hidden="true" />
                <span>MCP servers</span>
                <span className="dock-muted-text">
                  {mcpEntries.length === 0
                    ? "none discovered"
                    : `${mcpEntries.filter((entry) => enabledCountFor(entry.toolId) > 0).length}/${mcpEntries.length} enabled`}
                </span>
              </div>
              <p className="dock-muted-text agent-tools-description">
                Applies to every CLI runtime at once.
              </p>
              <div className="agent-tools-bulk-actions">
                <button
                  type="button"
                  className={`agent-tools-scope-button ${mcpAllOn ? "active" : ""}`}
                  disabled={mcpEntries.length === 0}
                  onClick={() => setBulkDraft("MCP", "COMMON")}
                >
                  Enable all
                </button>
                <button
                  type="button"
                  className={`agent-tools-scope-button ${mcpAllOff ? "active" : ""}`}
                  disabled={mcpEntries.length === 0}
                  onClick={() => setBulkDraft("MCP", "NONE")}
                >
                  Disable all
                </button>
              </div>
            </div>

            <div className="agent-tools-bulk-card">
              <div className="agent-tools-bulk-heading">
                <Sparkles aria-hidden="true" />
                <span>Skills</span>
                <span className="dock-muted-text">
                  {skillEntries.length === 0
                    ? "none discovered"
                    : `${skillEntries.filter((entry) => enabledCountFor(entry.toolId) > 0).length}/${skillEntries.length} enabled`}
                </span>
              </div>
              <p className="dock-muted-text agent-tools-description">
                Applies to every CLI runtime at once.
              </p>
              <div className="agent-tools-bulk-actions">
                <button
                  type="button"
                  className={`agent-tools-scope-button ${skillsAllOn ? "active" : ""}`}
                  disabled={skillEntries.length === 0}
                  onClick={() => setBulkDraft("SKILL", "COMMON")}
                >
                  Enable all
                </button>
                <button
                  type="button"
                  className={`agent-tools-scope-button ${skillsAllOff ? "active" : ""}`}
                  disabled={skillEntries.length === 0}
                  onClick={() => setBulkDraft("SKILL", "NONE")}
                >
                  Disable all
                </button>
              </div>
            </div>
          </div>

          <div className="agent-tools-toolbar">
            <span className="dock-muted-text">
              {pendingCount > 0 ? `${pendingCount} change${pendingCount === 1 ? "" : "s"} pending` : "All applied"}
            </span>
            <button
              type="button"
              className="dock-primary-button"
              disabled={!pendingCount || applying}
              onClick={() => void applyChanges()}
            >
              {applying ? <Loader2 className="spin" aria-hidden="true" /> : <Save aria-hidden="true" />}
              {pendingCount > 0 ? "Apply" : "Applied"}
            </button>
          </div>

          {applyResult && applyResult.length > 0 && (
            <div className="agent-tools-apply-summary">
              {applyResult.map((result) => {
                const updated = result.files.filter((file) => file.changed).length;
                const backups = result.files.filter((file) => file.action === "BACKUP_CREATED").length;
                return (
                  <div key={result.runtimeId} className="agent-tools-apply-row">
                    <CheckCircle2 aria-hidden="true" />
                    <span className="agent-tools-runtime-name">{result.runtimeId.replace("cli:", "")}</span>
                    <span>{updated > 0 ? `${updated} file${updated === 1 ? "" : "s"} updated` : "unchanged"}</span>
                    {backups > 0 && <span className="dock-muted-text">{backups} backup{backups === 1 ? "" : "s"}</span>}
                  </div>
                );
              })}
            </div>
          )}

          <ul className="agent-tools-tool-list">
            <li className="agent-tools-tool-group">
              <div className="agent-tools-tool-group-title">MCP servers</div>
              {mcpEntries.length === 0 ? (
                <p className="dock-muted-text">No MCP servers discovered.</p>
              ) : (
                mcpEntries.map((entry) => toolRow(entry.toolId, entry.name, "MCP"))
              )}
            </li>
            <li className="agent-tools-tool-group">
              <div className="agent-tools-tool-group-title">Skills</div>
              {skillEntries.length === 0 ? (
                <p className="dock-muted-text">No skills discovered.</p>
              ) : (
                skillEntries.map((entry) => toolRow(entry.toolId, entry.name, "SKILL"))
              )}
            </li>
          </ul>

          {loading && catalog === null && <p className="dock-muted-text">Loading agent tools...</p>}
        </>
      )}
    </div>
  );
}
