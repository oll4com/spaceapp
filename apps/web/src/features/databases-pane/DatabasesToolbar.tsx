import {
  Database,
  Search,
  RefreshCw,
  Plus,
  Compass,
  FileDown,
  FileUp,
  PanelLeftClose,
  PanelLeft,
  ShieldCheck,
  UserCheck,
  ChevronRight,
  Table as TableIcon
} from "../ui-theme/app-icons.js";
import type { DatabaseConnection } from "@space/contracts";

export interface DatabasesToolbarProps {
  selectedConnection: DatabaseConnection | null;
  selectedSchema: string | null;
  selectedTable: string | null;
  mode: "user" | "admin";
  isAdminCapable: boolean;
  onModeToggle: () => void;
  onSelectCrumb: (level: "root" | "connection" | "schema" | "table") => void;
  onNewConnection: () => void;
  onDiscover: () => void;
  onRefresh: () => void;
  onNewTable: () => void;
  onImport: () => void;
  onExport: () => void;
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
}

export function DatabasesToolbar({
  selectedConnection,
  selectedSchema,
  selectedTable,
  mode,
  isAdminCapable,
  onModeToggle,
  onSelectCrumb,
  onNewConnection,
  onDiscover,
  onRefresh,
  onNewTable,
  onImport,
  onExport,
  sidebarVisible,
  onToggleSidebar
}: DatabasesToolbarProps) {
  return (
    <div className="db-toolbar">
      {/* Top Row: Sidebar toggle & Full Breadcrumbs in one line */}
      <div className="db-toolbar-row db-toolbar-top-row">
        <button
          type="button"
          className={`db-sidebar-toggle ${sidebarVisible ? "active" : "closed"}`}
          onClick={onToggleSidebar}
          title={sidebarVisible ? "Hide sidebar" : "Show sidebar"}
          aria-label={sidebarVisible ? "Hide sidebar" : "Show sidebar"}
          style={{ marginRight: 6 }}
        >
          {sidebarVisible ? <PanelLeftClose size={14} /> : <PanelLeft size={14} />}
        </button>

        <div className="db-breadcrumbs-wrapper">
          <div className="db-breadcrumbs">
            <button
              type="button"
              className={`db-crumb-btn ${!selectedConnection ? "db-crumb-active" : ""}`}
              onClick={() => onSelectCrumb("root")}
            >
              <Database size={13} />
              Databases
            </button>

            {selectedConnection && (
              <>
                <span className="db-crumb-sep">
                  <ChevronRight size={12} />
                </span>
                <button
                  type="button"
                  className={`db-crumb-btn ${!selectedTable ? "db-crumb-active" : ""}`}
                  onClick={() => onSelectCrumb("connection")}
                >
                  {selectedConnection.name}
                </button>
              </>
            )}

            {selectedSchema && selectedSchema !== "public" && selectedSchema !== "main" && (
              <>
                <span className="db-crumb-sep">
                  <ChevronRight size={12} />
                </span>
                <button
                  type="button"
                  className={`db-crumb-btn ${!selectedTable ? "db-crumb-active" : ""}`}
                  onClick={() => onSelectCrumb("schema")}
                >
                  {selectedSchema}
                </button>
              </>
            )}

            {selectedTable && (
              <>
                <span className="db-crumb-sep">
                  <ChevronRight size={12} />
                </span>
                <button
                  type="button"
                  className="db-crumb-btn db-crumb-active"
                  onClick={() => onSelectCrumb("table")}
                >
                  <TableIcon size={12} />
                  {selectedTable}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Row: Actions */}
      <div className="db-toolbar-row db-toolbar-actions-row">
        <div className="db-toolbar-actions">
          {/* Mode Switcher */}
          <button
            type="button"
            className={`db-btn ${mode === "admin" ? "db-btn-danger" : ""}`}
            onClick={onModeToggle}
            title={
              mode === "admin"
                ? "Admin Mode: Access all database connections & system instances"
                : "User Mode: Access project-scoped and personal databases"
            }
          >
            {mode === "admin" ? <ShieldCheck size={14} /> : <UserCheck size={14} />}
            <span className="db-btn-text">{mode === "admin" ? "Admin Mode" : "User Mode"}</span>
          </button>

          <button type="button" className="db-btn" onClick={onDiscover} title="Scan project files for databases (.env, docker, sqlite)">
            <Compass size={14} />
            <span className="db-btn-text">Discover</span>
          </button>

          <button type="button" className="db-btn db-btn-primary" onClick={onNewConnection} title="Add new database connection">
            <Plus size={14} />
            <span className="db-btn-text">New Connection</span>
          </button>

          {selectedConnection && !selectedConnection.isReadOnly && (
            <button type="button" className="db-btn" onClick={onNewTable} title="Create new table">
              <Plus size={14} />
              <span className="db-btn-text">New Table</span>
            </button>
          )}

          {selectedConnection && (
            <>
              {!selectedConnection.isReadOnly && (
                <button type="button" className="db-btn" onClick={onImport} title="Import SQL script or CSV data">
                  <FileUp size={14} />
                  <span className="db-btn-text">Import</span>
                </button>
              )}
              <button type="button" className="db-btn" onClick={onExport} title="Export data or structure to SQL / CSV">
                <FileDown size={14} />
                <span className="db-btn-text">Export</span>
              </button>
            </>
          )}

          <button type="button" className="db-btn db-btn-icon-only" onClick={onRefresh} title="Refresh catalog and data">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
