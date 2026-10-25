import { Database, Plus, Compass, ArrowRight } from "../ui-theme/app-icons.js";
import type { DatabaseConnection } from "@space/contracts";

export interface DatabaseConnectionsOverviewProps {
  connections: DatabaseConnection[];
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  onSelectConnection: (conn: DatabaseConnection) => void;
  onNewConnection: () => void;
  onDiscover: () => void;
}

export function DatabaseConnectionsOverview({
  connections,
  sidebarVisible,
  onToggleSidebar,
  onSelectConnection,
  onNewConnection,
  onDiscover
}: DatabaseConnectionsOverviewProps) {
  return (
    <div className="db-overview-tab">
      <div className="db-overview-header">
        <div className="db-overview-info">
          <h2 className="db-overview-title">
            <Database size={20} className="db-overview-icon" />
            <span>Databases & Connections</span>
          </h2>
          <div className="db-overview-stats">
            <span>
              <strong>{connections.length}</strong> {connections.length === 1 ? "connection" : "connections"} available
            </span>
          </div>
        </div>
      </div>

      <div className="db-overview-tables-section">
        {connections.length === 0 ? (
          <div className="db-overview-empty">
            <Database size={32} style={{ display: "block", margin: "0 auto 12px auto", opacity: 0.5 }} />
            <div style={{ fontSize: "1rem", fontWeight: 600, marginBottom: 6 }}>No database connections found</div>
            <div style={{ fontSize: "0.85rem", color: "var(--modern-muted)", marginBottom: 16 }}>
              Create a new database connection or discover databases in your project.
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
              <button type="button" className="db-btn db-btn-primary" onClick={onNewConnection}>
                <Plus size={14} />
                <span>New Connection</span>
              </button>
              <button type="button" className="db-btn" onClick={onDiscover}>
                <Compass size={14} />
                <span>Discover Project Databases</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="db-overview-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
            {connections.map((conn) => (
              <button
                key={conn.id}
                type="button"
                className="db-overview-card"
                onClick={() => onSelectConnection(conn)}
                title={`Connect to ${conn.name}`}
                style={{ padding: "14px 16px" }}
              >
                <div className="db-overview-card-header">
                  <span className="db-overview-card-name" style={{ fontSize: "0.95rem" }}>
                    <Database size={16} className="db-overview-icon" />
                    <strong>{conn.name}</strong>
                  </span>
                  <ArrowRight size={14} className="db-overview-card-arrow" />
                </div>

                <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}>
                  <span className={`db-tree-node-badge db-badge-${conn.engine.toLowerCase()}`}>
                    {conn.engine}
                  </span>
                  {conn.isInternal && <span className="db-tree-node-badge db-badge-internal">INTERNAL</span>}
                  {conn.isReadOnly && <span className="db-tree-node-badge db-badge-readonly">READ ONLY</span>}
                </div>

                <div className="db-overview-card-footer" style={{ marginTop: 8, color: "var(--modern-muted)" }}>
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      minWidth: 0,
                      flex: 1,
                      textAlign: "left"
                    }}
                    title={String(conn.database || conn.filename || conn.host || "Local database")}
                  >
                    {conn.database || conn.filename || conn.host || "Local database"}
                  </span>
                  <span style={{ color: "var(--modern-accent)", fontWeight: 500, flexShrink: 0, whiteSpace: "nowrap", marginLeft: "auto" }}>
                    Open &rarr;
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
