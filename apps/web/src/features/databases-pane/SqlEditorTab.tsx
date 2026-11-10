import { useState, useMemo, useCallback } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { sql } from "@codemirror/lang-sql";
import { Play, Square, Clock, Database, CircleAlert, Copy, Check } from "../ui-theme/app-icons.js";
import type { DatabaseCatalog, DatabaseExecuteSqlResponse } from "@space/contracts";
import { formatCellDisplay } from "./DataTab.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";

export interface SqlEditorTabProps {
  connectionId: string;
  catalog: DatabaseCatalog | null;
  defaultSql?: string;
  isReadOnly?: boolean;
  onExecuteSql: (sql: string, limit?: number, sessionId?: string) => Promise<DatabaseExecuteSqlResponse>;
  onCancelSql: (sessionId: string) => Promise<void>;
}

export function SqlEditorTab({
  connectionId,
  catalog,
  defaultSql,
  isReadOnly,
  onExecuteSql,
  onCancelSql
}: SqlEditorTabProps) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [queryText, setQueryText] = useState(
    defaultSql || "SELECT * FROM information_schema.tables LIMIT 50;"
  );
  const [limit, setLimit] = useState(500);
  const [isRunning, setIsRunning] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [result, setResult] = useState<DatabaseExecuteSqlResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Schema-aware SQL completion tables config
  const sqlExtensions = useMemo(() => {
    const schemaMap: Record<string, string[]> = {};
    if (catalog?.schemas) {
      for (const s of catalog.schemas) {
        for (const tb of s.tables) {
          const colNames = tb.columns.map((c) => c.name);
          schemaMap[tb.name] = colNames;
          if (s.name !== "public" && s.name !== "main") {
            schemaMap[`${s.name}.${tb.name}`] = colNames;
          }
        }
      }
    }
    return [
      sql({
        schema: schemaMap
      })
    ];
  }, [catalog]);

  const handleRun = useCallback(async () => {
    if (!queryText.trim() || isRunning) return;
    setIsRunning(true);
    setErrorMessage(null);
    setResult(null);
    // The id is known before the query runs, so Cancel stops this query, not the previous one.
    const sessionId = crypto.randomUUID();
    setActiveSessionId(sessionId);

    try {
      const res = await onExecuteSql(queryText, limit, sessionId);
      if (res.error) {
        setErrorMessage(res.error);
      } else {
        setResult(res);
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRunning(false);
    }
  }, [queryText, limit, isRunning, onExecuteSql]);

  const handleCancel = async () => {
    if (!activeSessionId) return;
    try {
      await onCancelSql(activeSessionId);
    } catch (err) {
      console.error("Cancel failed:", err);
    }
  };

  const handleCopyJson = () => {
    if (!result?.rows) return;
    navigator.clipboard.writeText(JSON.stringify(result.rows, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="db-sql-container">
      {/* CodeMirror SQL Editor */}
      <div className="db-sql-editor-wrapper">
        <CodeMirror
          value={queryText}
          height="180px"
          theme="dark"
          extensions={sqlExtensions}
          onChange={(val) => setQueryText(val)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              void handleRun();
            }
          }}
          style={{ fontSize: "0.85rem" }}
        />
      </div>

      {/* SQL Toolbar */}
      <div className="db-sql-toolbar">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            className="db-btn db-btn-primary"
            onClick={() => void handleRun()}
            disabled={isRunning || !queryText.trim()}
            title={t("Execute query (Ctrl+Enter / Cmd+Enter)")}
          >
            <Play size={13} />
            <span>{t("Run")}</span>
          </button>

          {isRunning && (
            <button className="db-btn db-btn-danger" onClick={() => void handleCancel()} title={t("Cancel running query")}>
              <Square size={13} />
              <span>{t("Cancel")}</span>
            </button>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: 8 }}>
            <span style={{ fontSize: "0.78rem", color: "var(--modern-muted)" }}>{t("Limit:")}</span>
            <select
              className="db-select"
              style={{ padding: "2px 6px" }}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            >
              <option value="100">100</option>
              <option value="500">500</option>
              <option value="1000">1000</option>
              <option value="5000">5000</option>
            </select>
          </div>
        </div>

        {/* Execution Metadata */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {result && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "0.78rem", color: "var(--modern-muted)" }}>
                <Clock size={12} />
                <span>{result.executionTimeMs} ms</span>
              </div>
              <div style={{ fontSize: "0.78rem", color: "var(--modern-muted)" }}>
                {t("{count} rows", { count: result.rowCount })} {result.affectedRows !== undefined ? t("({count} affected)", { count: result.affectedRows }) : ""}
              </div>
              <button className="db-crumb-btn" onClick={handleCopyJson} title={t("Copy results as JSON")}>
                {copied ? <Check size={13} style={{ color: "var(--modern-accent)" }} /> : <Copy size={13} />}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Error Notice */}
      {errorMessage && (
        <div
          style={{
            padding: "8px 12px",
            background: "rgba(239, 68, 68, 0.15)",
            borderBottom: "1px solid rgba(239, 68, 68, 0.3)",
            color: "var(--modern-danger, #ef4444)",
            fontSize: "0.82rem",
            display: "flex",
            alignItems: "center",
            gap: 6
          }}
        >
          <CircleAlert size={14} style={{ flexShrink: 0 }} />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Results View */}
      <div className="db-sql-results">
        {result && result.columns.length > 0 ? (
          <table className="db-grid-table">
            <thead>
              <tr>
                {result.columns.map((c) => (
                  <th key={c} title={c}>
                    <div className="db-th-label">{c}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, idx) => (
                <tr key={idx}>
                  {result.columns.map((col) => {
                    const val = row[col];
                    const formatted = formatCellDisplay(val);
                    const cellText = formatted.replace(/\n+/g, " ");
                    return (
                      <td key={col} title={formatted}>
                        <div className="db-cell-content">
                          {val === null || val === undefined ? (
                            <span className="db-cell-null">NULL</span>
                          ) : (
                            cellText
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : result ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--modern-muted)" }}>
            {result.affectedRows !== undefined ? t("Query executed successfully. {count} rows affected.", { count: result.affectedRows }) : t("Query executed successfully. No rows returned.")}
          </div>
        ) : (
          <div style={{ padding: 24, textAlign: "center", color: "var(--modern-muted)" }}>
            {t("Enter SQL and press Run or Ctrl+Enter.")}
          </div>
        )}
      </div>
    </div>
  );
}
