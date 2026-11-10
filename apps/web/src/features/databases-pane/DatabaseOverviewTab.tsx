import { useState, useMemo } from "react";
import { Database, Table as TableIcon, Search, ArrowRight } from "../ui-theme/app-icons.js";
import type { DatabaseCatalog, DatabaseConnection } from "@space/contracts";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";

export interface DatabaseOverviewTabProps {
  connection: DatabaseConnection;
  catalog: DatabaseCatalog | null;
  isLoadingCatalog: boolean;
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  onSelectTable: (schema: string, tableName: string) => void;
}

export function DatabaseOverviewTab({
  connection,
  catalog,
  isLoadingCatalog,
  sidebarVisible,
  onToggleSidebar,
  onSelectTable
}: DatabaseOverviewTabProps) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [search, setSearch] = useState("");

  const allTables = useMemo(() => {
    if (!catalog?.schemas) return [];
    const list: Array<{ name: string; schema: string; rowCount?: number; columnCount: number }> = [];
    for (const schema of catalog.schemas) {
      const lower = schema.name.toLowerCase();
      if (
        lower.startsWith("pg_temp") ||
        lower.startsWith("pg_toast") ||
        lower === "information_schema" ||
        lower === "pg_catalog"
      ) {
        continue;
      }
      for (const table of schema.tables || []) {
        list.push({
          name: table.name,
          schema: schema.name,
          rowCount: table.rowCount,
          columnCount: table.columns?.length || 0
        });
      }
    }
    return list;
  }, [catalog]);

  const filteredTables = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return allTables;
    return allTables.filter((tb) => tb.name.toLowerCase().includes(q) || tb.schema.toLowerCase().includes(q));
  }, [allTables, search]);

  const totalRowsCount = useMemo(() => {
    return allTables.reduce((acc, tb) => acc + (tb.rowCount || 0), 0);
  }, [allTables]);

  return (
    <div className="db-overview-tab">
      <div className="db-overview-header">
        <div className="db-overview-info">
          <div className="db-overview-badge-row">
            <span className={`db-tree-node-badge db-badge-${connection.engine.toLowerCase()}`}>
              {connection.engine}
            </span>
            {connection.isInternal && <span className="db-tree-node-badge db-badge-internal">{t("INTERNAL")}</span>}
            {connection.isReadOnly && <span className="db-tree-node-badge db-badge-readonly">{t("READ ONLY")}</span>}
          </div>
          <h2 className="db-overview-title">
            <Database size={20} className="db-overview-icon" />
            <span>{connection.name}</span>
          </h2>
          <div className="db-overview-stats">
            <span>
              <strong>{t(allTables.length === 1 ? "{count} table" : "{count} tables", { count: allTables.length })}</strong>
            </span>
            <span className="db-overview-dot">•</span>
            <span>
              <strong>{t("{count} rows", { count: totalRowsCount.toLocaleString() })}</strong>
            </span>
            {connection.database && (
              <>
                <span className="db-overview-dot">•</span>
                <span>
                  {t("Database: ")}<code>{connection.database}</code>
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="db-overview-tables-section">
        <div className="db-overview-search-bar">
          <Search size={14} className="db-overview-search-icon" />
          <input
            type="text"
            className="db-input db-overview-search-input"
            placeholder={t("Search tables...")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {allTables.length > 0 && (
            <span className="db-overview-count-badge">
              {t("{shown} of {total}", { shown: filteredTables.length, total: allTables.length })}
            </span>
          )}
        </div>

        {isLoadingCatalog ? (
          <div className="db-overview-loading">{t("Loading database schema and tables...")}</div>
        ) : filteredTables.length === 0 ? (
          <div className="db-overview-empty">
            {allTables.length === 0 ? t("No tables found in this database.") : t("No tables match your search.")}
          </div>
        ) : (
          <div className="db-overview-grid">
            {filteredTables.map((tb) => (
              <button
                key={`${tb.schema}.${tb.name}`}
                type="button"
                className="db-overview-card"
                onClick={() => onSelectTable(tb.schema, tb.name)}
                title={t("Open table {name}", { name: tb.name })}
              >
                <div className="db-overview-card-header">
                  <span className="db-overview-card-name">
                    <TableIcon size={14} />
                    <strong>{tb.name}</strong>
                  </span>
                  <ArrowRight size={13} className="db-overview-card-arrow" />
                </div>
                <div className="db-overview-card-footer">
                  <span className={`db-overview-row-badge ${(tb.rowCount ?? 0) > 0 ? "has-data" : "empty"}`}>
                    {(tb.rowCount ?? 0) > 0 ? t("{count} rows", { count: tb.rowCount?.toLocaleString() ?? "" }) : t("0 rows")}
                  </span>
                  <span className="db-overview-col-count">
                    {t(tb.columnCount === 1 ? "{count} col" : "{count} cols", { count: tb.columnCount })}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
