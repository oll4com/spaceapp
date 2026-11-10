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
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";

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
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  return (
    <div className="db-toolbar">
      {/* Top Row: Sidebar toggle & Full Breadcrumbs in one line */}
      <div className="db-toolbar-row db-toolbar-top-row">
        <button
          type="button"
          className={`db-sidebar-toggle ${sidebarVisible ? "active" : "closed"}`}
          onClick={onToggleSidebar}
          title={sidebarVisible ? t("Hide sidebar") : t("Show sidebar")}
          aria-label={sidebarVisible ? t("Hide sidebar") : t("Show sidebar")}
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
              {t("Databases")}
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
                ? t("Admin Mode: Access all database connections & system instances")
                : t("User Mode: Access project-scoped and personal databases")
            }
          >
            {mode === "admin" ? <ShieldCheck size={14} /> : <UserCheck size={14} />}
            <span className="db-btn-text">{mode === "admin" ? t("Admin Mode") : t("User Mode")}</span>
          </button>

          <button type="button" className="db-btn" onClick={onDiscover} title={t("Scan project files for databases (.env, docker, sqlite)")}>
            <Compass size={14} />
            <span className="db-btn-text">{t("Discover")}</span>
          </button>

          <button type="button" className="db-btn db-btn-primary" onClick={onNewConnection} title={t("Add new database connection")}>
            <Plus size={14} />
            <span className="db-btn-text">{t("New Connection")}</span>
          </button>

          {selectedConnection && !selectedConnection.isReadOnly && (
            <button type="button" className="db-btn" onClick={onNewTable} title={t("Create new table")}>
              <Plus size={14} />
              <span className="db-btn-text">{t("New Table")}</span>
            </button>
          )}

          {selectedConnection && (
            <>
              {!selectedConnection.isReadOnly && (
                <button type="button" className="db-btn" onClick={onImport} title={t("Import SQL script or CSV data")}>
                  <FileUp size={14} />
                  <span className="db-btn-text">{t("Import")}</span>
                </button>
              )}
              <button type="button" className="db-btn" onClick={onExport} title={t("Export data or structure to SQL / CSV")}>
                <FileDown size={14} />
                <span className="db-btn-text">{t("Export")}</span>
              </button>
            </>
          )}

          <button type="button" className="db-btn db-btn-icon-only" onClick={onRefresh} title={t("Refresh catalog and data")}>
            <RefreshCw size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
