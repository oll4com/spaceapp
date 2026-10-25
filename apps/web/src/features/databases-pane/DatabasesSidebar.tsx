import { useState, useMemo } from "react";
import {
  Database,
  Table as TableIcon,
  Eye,
  ChevronDown,
  ChevronRight,
  Search,
  Plus,
  Trash2,
  Settings,
  Layers,
  Lock
} from "../ui-theme/app-icons.js";
import type { DatabaseCatalog, DatabaseConnection } from "@space/contracts";

export interface DatabasesSidebarProps {
  connections: DatabaseConnection[];
  selectedConnection: DatabaseConnection | null;
  selectedSchema: string | null;
  selectedTable: string | null;
  catalog: DatabaseCatalog | null;
  isLoadingCatalog: boolean;
  onSelectConnection: (conn: DatabaseConnection) => void;
  onSelectTable: (schema: string, tableName: string) => void;
  onNewConnection: () => void;
  onEditConnection: (conn: DatabaseConnection) => void;
  onDeleteConnection: (conn: DatabaseConnection) => void;
  collapsed?: boolean;
}

export function DatabasesSidebar({
  connections,
  selectedConnection,
  selectedSchema,
  selectedTable,
  catalog,
  isLoadingCatalog,
  onSelectConnection,
  onSelectTable,
  onNewConnection,
  onEditConnection,
  onDeleteConnection,
  collapsed = false
}: DatabasesSidebarProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [filterWithData, setFilterWithData] = useState(false);
  const [collapsedSchemas, setCollapsedSchemas] = useState<Record<string, boolean>>({});

  const toggleSchema = (schemaName: string) => {
    setCollapsedSchemas((prev) => ({ ...prev, [schemaName]: !prev[schemaName] }));
  };

  const getEngineBadgeClass = (engine: string, isInternal?: boolean) => {
    if (isInternal) return "db-badge-internal";
    if (engine === "POSTGRES") return "db-badge-pg";
    if (engine === "MYSQL") return "db-badge-mysql";
    if (engine === "SQLITE") return "db-badge-sqlite";
    return "";
  };

  const isInternalSchema = (name: string) => {
    const lower = name.toLowerCase();
    return lower.startsWith("pg_temp") || lower.startsWith("pg_toast") || lower === "information_schema" || lower === "pg_catalog";
  };

  // Compute table statistics
  const { totalTables, tablesWithData } = useMemo(() => {
    if (!catalog?.schemas) return { totalTables: 0, tablesWithData: 0 };
    let total = 0;
    let withData = 0;
    for (const s of catalog.schemas) {
      if (isInternalSchema(s.name)) continue;
      for (const t of s.tables || []) {
        total++;
        if ((t.rowCount ?? 0) > 0) withData++;
      }
    }
    return { totalTables: total, tablesWithData: withData };
  }, [catalog]);

  // Filter schemas/tables based on search query and data filter
  const filteredSchemas = useMemo(() => {
    if (!catalog?.schemas) return [];
    const q = searchQuery.toLowerCase().trim();
    return catalog.schemas
      .filter((schema) => !isInternalSchema(schema.name))
      .map((schema) => {
        let tables = schema.tables || [];
        let views = schema.views || [];

        if (filterWithData) {
          tables = tables.filter((t) => (t.rowCount ?? 0) > 0);
          views = [];
        }

        if (q) {
          tables = tables.filter((t) => t.name.toLowerCase().includes(q));
          views = views.filter((v) => v.name.toLowerCase().includes(q));
          if (tables.length === 0 && views.length === 0 && !schema.name.toLowerCase().includes(q)) {
            return null;
          }
        } else if (filterWithData && tables.length === 0) {
          return null;
        }

        return {
          ...schema,
          tables,
          views
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);
  }, [catalog, searchQuery, filterWithData]);

  return (
    <aside
      className={`db-sidebar ${collapsed ? "db-sidebar-collapsed" : ""}`}
      aria-label="Databases Sidebar"
    >
      {/* Search Header */}
      <div className="db-sidebar-header">
        <div className="db-sidebar-search">
          <Search size={13} style={{ color: "var(--modern-muted)" }} />
          <input
            type="text"
            placeholder="Filter tables & schemas..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="db-btn db-btn-icon-only"
          onClick={onNewConnection}
          title="Add Connection"
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Filter Tabs / Pills when catalog is loaded */}
      {catalog && (
        <div className="db-sidebar-filter-bar">
          <button
            type="button"
            className={`db-sidebar-filter-btn ${!filterWithData ? "active" : ""}`}
            onClick={() => setFilterWithData(false)}
          >
            All <span className="db-filter-count">{totalTables}</span>
          </button>
          <button
            type="button"
            className={`db-sidebar-filter-btn ${filterWithData ? "active" : ""}`}
            onClick={() => setFilterWithData(true)}
            title="Show only tables that contain records (rows > 0)"
          >
            With Data <span className={`db-filter-count ${tablesWithData > 0 ? "has-data" : ""}`}>{tablesWithData}</span>
          </button>
        </div>
      )}

      {/* Tree Content in Scroll Area */}
      <div className="db-sidebar-scroll-area">
        <div className="db-tree-container">
        {/* Connections List */}
        <div style={{ marginBottom: 12 }}>
          <div
            style={{
              padding: "4px 8px",
              fontSize: "0.72rem",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: "var(--modern-faint)"
            }}
          >
            Connections ({connections.length})
          </div>

          {connections.map((conn) => {
            const isSelected = selectedConnection?.id === conn.id;
            return (
              <div key={conn.id} style={{ marginBottom: 2 }}>
                <div
                  className={`db-tree-node ${isSelected ? "active" : ""}`}
                  onClick={() => onSelectConnection(conn)}
                >
                  <Database size={14} style={{ flexShrink: 0 }} />
                  <span className="db-tree-node-title" title={conn.name}>
                    {conn.name}
                  </span>
                  {conn.isReadOnly && (
                    <span title="Read-only" style={{ display: "inline-flex" }}>
                      <Lock size={11} style={{ color: "var(--modern-warning, #f59e0b)" }} />
                    </span>
                  )}
                  <span className={`db-badge-engine ${getEngineBadgeClass(conn.engine, conn.isInternal)}`}>
                    {conn.isInternal ? "INTERNAL" : conn.engine}
                  </span>
                  {!conn.isInternal && (
                    <div style={{ display: "flex", gap: 2 }} onClick={(e) => e.stopPropagation()}>
                      <button
                        className="db-crumb-btn"
                        style={{ padding: 2 }}
                        title="Edit Connection"
                        onClick={() => onEditConnection(conn)}
                      >
                        <Settings size={12} />
                      </button>
                      <button
                        className="db-crumb-btn"
                        style={{ padding: 2, color: "var(--modern-danger)" }}
                        title="Delete Connection"
                        onClick={() => onDeleteConnection(conn)}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  )}
                </div>

                {/* Expanded Objects for Selected Connection */}
                {isSelected && (
                  <div style={{ paddingLeft: 12, borderLeft: "1px dashed var(--modern-border, #2a3947)", marginLeft: 10, marginTop: 4 }}>
                    {isLoadingCatalog ? (
                      <div style={{ padding: "8px 6px", fontSize: "0.75rem", color: "var(--modern-muted)" }}>
                        Loading catalog...
                      </div>
                    ) : filteredSchemas.length === 0 ? (
                      <div style={{ padding: "8px 6px", fontSize: "0.75rem", color: "var(--modern-muted)" }}>
                        No tables found.
                      </div>
                    ) : (
                      filteredSchemas.map((schema) => {
                        const isCollapsed = Boolean(collapsedSchemas[schema.name]);
                        return (
                          <div key={schema.name} style={{ marginBottom: 6 }}>
                            {/* Schema Header (if multiple schemas or not default) */}
                            {catalog?.capabilities.schemas && (
                              <div
                                className="db-tree-node"
                                style={{ fontSize: "0.75rem", padding: "3px 6px" }}
                                onClick={() => toggleSchema(schema.name)}
                              >
                                {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                                <Layers size={13} style={{ color: "var(--modern-muted)" }} />
                                <span className="db-tree-node-title" style={{ fontWeight: 600 }}>
                                  {schema.name}
                                </span>
                                <span className="db-tree-node-count">{schema.tables.length}</span>
                              </div>
                            )}

                            {/* Tables List */}
                            {!isCollapsed && (
                              <div style={{ paddingLeft: catalog?.capabilities.schemas ? 10 : 0 }}>
                                {(schema.tables || []).map((table) => {
                                  const isTableSelected = selectedTable === table.name && (selectedSchema === schema.name || !selectedSchema);
                                  return (
                                    <div
                                      key={table.name}
                                      className={`db-tree-node ${isTableSelected ? "active" : ""}`}
                                      style={{ padding: "3px 6px" }}
                                      onClick={() => onSelectTable(schema.name, table.name)}
                                    >
                                      <TableIcon size={13} style={{ flexShrink: 0 }} />
                                      <span className="db-tree-node-title" title={table.name}>
                                        {table.name}
                                      </span>
                                      {table.rowCount !== undefined && (
                                        <span
                                          className={`db-tree-node-count ${table.rowCount > 0 ? "has-data" : "empty"}`}
                                          title={`${table.rowCount.toLocaleString()} rows`}
                                        >
                                          {table.rowCount >= 1000000
                                            ? `${(table.rowCount / 1000000).toFixed(1)}M`
                                            : table.rowCount >= 1000
                                            ? `${(table.rowCount / 1000).toFixed(1)}k`
                                            : table.rowCount}
                                        </span>
                                      )}
                                    </div>
                                  );
                                })}

                                {(schema.views || []).map((view) => (
                                  <div
                                    key={view.name}
                                    className={`db-tree-node ${selectedTable === view.name ? "active" : ""}`}
                                    style={{ padding: "3px 6px" }}
                                    onClick={() => onSelectTable(schema.name, view.name)}
                                  >
                                    <Eye size={13} style={{ flexShrink: 0, color: "var(--modern-accent)" }} />
                                    <span className="db-tree-node-title" title={`View: ${view.name}`}>
                                      {view.name}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  </aside>
  );
}
