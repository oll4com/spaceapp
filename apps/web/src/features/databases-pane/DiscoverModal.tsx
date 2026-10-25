import { Compass, Database, Check, X, RefreshCw } from "../ui-theme/app-icons.js";
import type { DatabaseDiscoveryItem } from "@space/contracts";

export interface DiscoverModalProps {
  discovered: DatabaseDiscoveryItem[];
  isLoading: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onConnectDiscovered: (item: DatabaseDiscoveryItem) => void;
}

export function DiscoverModal({
  discovered,
  isLoading,
  onClose,
  onRefresh,
  onConnectDiscovered
}: DiscoverModalProps) {
  const getBadgeClass = (engine: string) => {
    if (engine === "POSTGRES") return "db-badge-pg";
    if (engine === "MYSQL") return "db-badge-mysql";
    if (engine === "SQLITE") return "db-badge-sqlite";
    return "";
  };

  return (
    <div className="db-modal-overlay">
      <div className="db-modal">
        <div className="db-modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Compass size={16} style={{ color: "var(--modern-accent)" }} />
            <span>Discover Project Databases</span>
          </div>
          <button className="db-crumb-btn" onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div className="db-modal-body">
          <p style={{ fontSize: "0.8rem", color: "var(--modern-muted)", margin: 0 }}>
            Scanning project directory, configuration files (.env, docker-compose.yml), and SQLite database files.
          </p>

          {isLoading ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--modern-muted)" }}>
              Scanning workspace...
            </div>
          ) : discovered.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--modern-muted)" }}>
              No database configurations or SQLite files detected in this project.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {discovered.map((item, idx) => (
                <div
                  key={idx}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 6,
                    border: "1px solid var(--modern-border, #2a3947)",
                    background: "var(--modern-surface-raised, #17212b)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span className={`db-badge-engine ${getBadgeClass(item.engine)}`}>
                        {item.engine}
                      </span>
                      <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>{item.name}</span>
                    </div>
                    <div style={{ fontSize: "0.74rem", color: "var(--modern-muted)" }}>
                      Source: <code>{item.source}</code>
                      {item.database && ` • DB: ${item.database}`}
                      {item.filename && ` • File: ${item.filename}`}
                    </div>
                  </div>

                  <button
                    className="db-btn db-btn-primary"
                    onClick={() => onConnectDiscovered(item)}
                  >
                    Connect
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="db-modal-footer">
          <button className="db-btn" onClick={onRefresh} disabled={isLoading}>
            <RefreshCw size={13} className={isLoading ? "spin" : ""} />
            <span>Rescan</span>
          </button>
          <button className="db-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
