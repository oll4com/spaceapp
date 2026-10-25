import { useState, useMemo } from "react";
import { Database, Table as TableIcon, Search, ArrowRight } from "../ui-theme/app-icons.js";
import type { DatabaseCatalog, DatabaseConnection } from "@space/contracts";

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
    return allTables.filter((t) => t.name.toLowerCase().includes(q) || t.schema.toLowerCase().includes(q));
  }, [allTables, search]);

  const totalRowsCount = useMemo(() => {
    return allTables.reduce((acc, t) => acc + (t.rowCount || 0), 0);
  }, [allTables]);

  return (
    <div className="db-overview-tab">
      <div className="db-overview-header">
        <div className="db-overview-info">
          <div className="db-overview-badge-row">
            <span className={`db-tree-node-badge db-badge-${connection.engine.toLowerCase()}`}>
              {connection.engine}
            </span>
            {connection.isInternal && <span className="db-tree-node-badge db-badge-internal">INTERNAL</span>}
            {connection.isReadOnly && <span className="db-tree-node-badge db-badge-readonly">READ ONLY</span>}
          </div>
          <h2 className="db-overview-title">
            <Database size={20} className="db-overview-icon" />
            <span>{connection.name}</span>
          </h2>
          <div className="db-overview-stats">
            <span>
              <strong>{allTables.length}</strong> {allTables.length === 1 ? "table" : "tables"}
            </span>
            <span className="db-overview-dot">•</span>
            <span>
              <strong>{totalRowsCount.toLocaleString()}</strong> rows
            </span>
            {connection.database && (
              <>
                <span className="db-overview-dot">•</span>
                <span>
                  Database: <code>{connection.database}</code>
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
            placeholder="Search tables..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {allTables.length > 0 && (
            <span className="db-overview-count-badge">
              {filteredTables.length} of {allTables.length}
            </span>
          )}
        </div>

        {isLoadingCatalog ? (
          <div className="db-overview-loading">Loading database schema and tables...</div>
        ) : filteredTables.length === 0 ? (
          <div className="db-overview-empty">
            {allTables.length === 0 ? "No tables found in this database." : "No tables match your search."}
          </div>
        ) : (
          <div className="db-overview-grid">
            {filteredTables.map((t) => (
              <button
                key={`${t.schema}.${t.name}`}
                type="button"
                className="db-overview-card"
                onClick={() => onSelectTable(t.schema, t.name)}
                title={`Open table ${t.name}`}
              >
                <div className="db-overview-card-header">
                  <span className="db-overview-card-name">
                    <TableIcon size={14} />
                    <strong>{t.name}</strong>
                  </span>
                  <ArrowRight size={13} className="db-overview-card-arrow" />
                </div>
                <div className="db-overview-card-footer">
                  <span className={`db-overview-row-badge ${(t.rowCount ?? 0) > 0 ? "has-data" : "empty"}`}>
                    {(t.rowCount ?? 0) > 0 ? `${t.rowCount?.toLocaleString()} rows` : "0 rows"}
                  </span>
                  <span className="db-overview-col-count">
                    {t.columnCount} {t.columnCount === 1 ? "col" : "cols"}
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
