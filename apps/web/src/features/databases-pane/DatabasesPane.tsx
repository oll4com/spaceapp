import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import type {
  CreateDatabaseConnectionInput,
  DatabaseCatalog,
  DatabaseConnection,
  DatabaseDiscoveryItem,
  DatabaseExecuteSqlResponse,
  DatabaseTableDataResponse,
  Pane
} from "@space/contracts";
import { api } from "../../api.js";
import { DatabasesToolbar } from "./DatabasesToolbar.js";
import { DatabasesSidebar } from "./DatabasesSidebar.js";
import { DataTab } from "./DataTab.js";
import { StructureTab } from "./StructureTab.js";
import { SqlEditorTab } from "./SqlEditorTab.js";
import { DatabaseOverviewTab } from "./DatabaseOverviewTab.js";
import { DatabaseConnectionsOverview } from "./DatabaseConnectionsOverview.js";
import { ConnectionModal } from "./ConnectionModal.js";
import { DiscoverModal } from "./DiscoverModal.js";
import { CreateTableModal } from "./CreateTableModal.js";
import { ImportModal, ExportModal } from "./ImportExportModals.js";
import "./databases-pane.css";

export interface DatabasesPaneProps {
  pane?: Pane;
  uiTheme?: string;
  mobile?: boolean;
  projectPath?: string | null;
}

const STORAGE_MODE_KEY = "space.dbManager.mode";
const STORAGE_CONN_KEY = "space.dbManager.lastConnectionId";
const STORAGE_TABLE_KEY_PREFIX = "space.dbManager.lastTable.";

export function DatabasesPane({ pane, mobile = false, projectPath }: DatabasesPaneProps) {
  const effectiveProjectPath = useMemo(() => {
    return pane?.cwd?.trim() || projectPath?.trim() || null;
  }, [pane?.cwd, projectPath]);

  const [mode, setMode] = useState<"user" | "admin">(() => {
    const saved = localStorage.getItem(STORAGE_MODE_KEY);
    return saved === "admin" ? "admin" : "user";
  });
  const [isAdminCapable, setIsAdminCapable] = useState<boolean>(false);

  // Connections & Catalog State
  const [connections, setConnections] = useState<DatabaseConnection[]>([]);
  const [selectedConnection, setSelectedConnection] = useState<DatabaseConnection | null>(null);
  const [catalog, setCatalog] = useState<DatabaseCatalog | null>(null);
  const [selectedSchema, setSelectedSchema] = useState<string | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);

  // Tabs: "data" | "structure" | "sql"
  const [activeTab, setActiveTab] = useState<"data" | "structure" | "sql">("data");

  // Table Data State
  const [tableData, setTableData] = useState<DatabaseTableDataResponse | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sortColumn, setSortColumn] = useState<string | undefined>();
  const [sortDirection, setSortDirection] = useState<"asc" | "desc" | undefined>();
  const [filterColumn, setFilterColumn] = useState<string | undefined>();
  const [filterOp, setFilterOp] = useState<string | undefined>();
  const [filterValue, setFilterValue] = useState<string | undefined>();
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Loading & Error State
  const [isLoadingConnections, setIsLoadingConnections] = useState(true);
  const [isLoadingCatalog, setIsLoadingCatalog] = useState(false);
  const [isLoadingTableData, setIsLoadingTableData] = useState(false);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);

  // UI Panels
  const [sidebarVisible, setSidebarVisible] = useState<boolean>(() => {
    if (mobile) return false;
    if (typeof window !== "undefined" && window.innerWidth < 768) return false;
    try {
      const saved = localStorage.getItem("space_db_sidebar");
      return saved === null ? true : saved === "true";
    } catch {
      return true;
    }
  });

  useEffect(() => {
    if (mobile) {
      setSidebarVisible(false);
      return;
    }
    if (!rootRef.current || typeof ResizeObserver === "undefined") return;
    let checked = false;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        if (!checked && width > 0) {
          checked = true;
          if (width < 768) {
            try {
              const saved = localStorage.getItem("space_db_sidebar");
              if (saved === null) {
                setSidebarVisible(false);
              }
            } catch {
              setSidebarVisible(false);
            }
          }
        }
      }
    });
    observer.observe(rootRef.current);
    return () => observer.disconnect();
  }, [mobile]);

  const handleToggleSidebar = useCallback(() => {
    setSidebarVisible((prev) => {
      const next = !prev;
      if (!mobile) {
        try {
          localStorage.setItem("space_db_sidebar", String(next));
        } catch {
          // ignore
        }
      }
      return next;
    });
  }, [mobile]);

  const [showConnectionModal, setShowConnectionModal] = useState(false);
  const [editingConnection, setEditingConnection] = useState<DatabaseConnection | null>(null);
  const [showDiscoverModal, setShowDiscoverModal] = useState(false);
  const [discoveredItems, setDiscoveredItems] = useState<DatabaseDiscoveryItem[]>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [showCreateTableModal, setShowCreateTableModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);

  // Check admin role
  useEffect(() => {
    api.me()
      .then((res) => {
        const role = res.user?.role;
        const isAdmin = role === "ADMIN" || role === "OPERATOR";
        setIsAdminCapable(isAdmin);
        if (!isAdmin && mode === "admin") {
          setMode("user");
        }
      })
      .catch(() => {
        setIsAdminCapable(false);
      });
  }, [mode]);

  // Load connections
  const loadConnections = useCallback(async (opts?: { preserveSelection?: boolean }) => {
    setIsLoadingConnections(true);
    try {
      const res = await api.databasesListConnections({
        projectPath: effectiveProjectPath,
        mode
      });
      if (res.ok) {
        setConnections(res.connections);
        if (res.connections.length > 0) {
          const savedId = localStorage.getItem(STORAGE_CONN_KEY);
          const found = (savedId && res.connections.find((c) => c.id === savedId)) || res.connections[0];
          setSelectedConnection((prev) => {
            if (prev) {
              return res.connections.find((c) => c.id === prev.id) || found || null;
            }
            if (opts?.preserveSelection) {
              return null;
            }
            return found || null;
          });
        } else {
          setSelectedConnection(null);
          setCatalog(null);
        }
      }
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : "Failed to load database connections");
    } finally {
      setIsLoadingConnections(false);
    }
  }, [effectiveProjectPath, mode]);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  // Load catalog for selected connection
  const loadCatalog = useCallback(async (connId: string) => {
    setIsLoadingCatalog(true);
    setErrorNotice(null);
    try {
      const res = await api.databasesGetCatalog(connId, undefined, mode);
      if (res.ok) {
        setCatalog(res.catalog);
        // Automatically restore saved table or select table with data if none selected
        const allTables = res.catalog.schemas.flatMap((s) => s.tables || []);
        if (allTables.length > 0) {
          const savedTable = localStorage.getItem(`${STORAGE_TABLE_KEY_PREFIX}${connId}`);
          if (savedTable === "none") {
            // User explicitly navigated to database overview
            setSelectedTable(null);
          } else if (savedTable && !savedTable.startsWith("activity_log_")) {
            const foundSaved = allTables.find((t) => t.name === savedTable);
            if (foundSaved) {
              setSelectedSchema((prev) => prev || foundSaved.schema || "public");
              setSelectedTable((prev) => prev || foundSaved.name);
            }
          } else if (!savedTable) {
            // First time load: pick primary entity tables (rooms, etc.) rather than internal plumbing
            const targetTable =
              allTables.find((t) => !t.name.startsWith("activity_log_") && !t.name.startsWith("spatial_") && (t.rowCount ?? 0) > 0) ||
              allTables.find((t) => !t.name.startsWith("activity_log_") && !t.name.startsWith("spatial_")) ||
              allTables[0];
            if (targetTable) {
              setSelectedSchema((prev) => prev || targetTable.schema || "public");
              setSelectedTable((prev) => prev || targetTable.name);
            }
          }
        }
      }
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : "Failed to load schema catalog");
    } finally {
      setIsLoadingCatalog(false);
    }
  }, [mode]);

  useEffect(() => {
    if (selectedConnection) {
      localStorage.setItem(STORAGE_CONN_KEY, selectedConnection.id);
      void loadCatalog(selectedConnection.id);
    } else {
      setCatalog(null);
      setSelectedTable(null);
      setTableData(null);
    }
  }, [selectedConnection?.id, loadCatalog]);

  // Load table data
  const loadTableData = useCallback(async () => {
    if (!selectedConnection || !selectedTable) {
      setTableData(null);
      return;
    }
    setIsLoadingTableData(true);
    setErrorNotice(null);
    try {
      const res = await api.databasesGetTableData(selectedConnection.id, selectedTable, {
        schema: selectedSchema || undefined,
        page,
        pageSize,
        sortColumn,
        sortDirection,
        filterColumn,
        filterOp: filterOp as "eq" | "neq" | "like" | "gt" | "lt" | "gte" | "lte" | "null" | "notnull" | undefined,
        filterValue,
        search: searchQuery || undefined,
        mode
      });
      if (res.ok) {
        setTableData(res);
        if (typeof res.totalRows === "number" && !searchQuery && !filterColumn) {
          const currentTable = selectedTable;
          const currentSchema = selectedSchema;
          const updatedRowCount = res.totalRows;
          setCatalog((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              schemas: prev.schemas.map((s) => {
                if (currentSchema && s.name !== currentSchema) return s;
                return {
                  ...s,
                  tables: s.tables.map((t) => {
                    if (t.name === currentTable) {
                      return { ...t, rowCount: updatedRowCount };
                    }
                    return t;
                  })
                };
              })
            };
          });
        }
      }
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : "Failed to load table data");
    } finally {
      setIsLoadingTableData(false);
    }
  }, [selectedConnection, selectedTable, selectedSchema, page, pageSize, sortColumn, sortDirection, filterColumn, filterOp, filterValue, searchQuery, mode]);

  useEffect(() => {
    if (activeTab === "data") {
      void loadTableData();
    }
  }, [activeTab, loadTableData]);

  // Discover databases in project
  const handleDiscover = async () => {
    setIsDiscovering(true);
    setShowDiscoverModal(true);
    try {
      const res = await api.databasesDiscover(pane?.roomId, effectiveProjectPath || undefined);
      if (res.ok) {
        setDiscoveredItems(res.discovered);
      }
    } catch (err) {
      console.error("Discovery failed:", err);
    } finally {
      setIsDiscovering(false);
    }
  };

  const handleConnectDiscovered = (item: DatabaseDiscoveryItem) => {
    setShowDiscoverModal(false);
    setShowConnectionModal(true);
    setEditingConnection({
      id: "discovered-template",
      ownerUserId: "user",
      projectPath: effectiveProjectPath,
      name: item.name,
      engine: item.engine,
      host: item.host || "127.0.0.1",
      port: item.port || (item.engine === "POSTGRES" ? 5432 : 3306),
      database: item.database || (item.engine === "POSTGRES" ? "postgres" : "mysql"),
      username: item.username || (item.engine === "POSTGRES" ? "postgres" : "root"),
      ssl: false,
      filename: item.filename || null,
      isInternal: false,
      isReadOnly: false,
      options: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  };

  // Row mutations
  const handleSaveRowUpdates = async (
    updates: Array<{ keys: Record<string, unknown>; values: Record<string, unknown> }>
  ) => {
    if (!selectedConnection || !selectedTable) return;
    for (const item of updates) {
      await api.databasesUpdateRow(selectedConnection.id, selectedTable, {
        schema: selectedSchema || undefined,
        keys: item.keys,
        values: item.values,
        mode
      });
    }
    void loadTableData();
  };

  const handleDeleteRow = async (keys: Record<string, unknown>) => {
    if (!selectedConnection || !selectedTable) return;
    await api.databasesDeleteRow(selectedConnection.id, selectedTable, {
      schema: selectedSchema || undefined,
      keys,
      mode
    });
    void loadTableData();
  };

  const handleInsertRow = async (values: Record<string, unknown>) => {
    if (!selectedConnection || !selectedTable) return;
    await api.databasesInsertRow(selectedConnection.id, selectedTable, {
      schema: selectedSchema || undefined,
      values,
      mode
    });
    void loadTableData();
  };

  // Schema alterations
  const handleAddColumn = async (col: { name: string; type: string; nullable?: boolean; defaultValue?: string }) => {
    if (!selectedConnection || !selectedTable) return;
    await api.databasesAlterTable(selectedConnection.id, selectedTable, {
      action: "ADD_COLUMN",
      schema: selectedSchema || undefined,
      column: col,
      mode
    });
    void loadCatalog(selectedConnection.id);
    void loadTableData();
  };

  const handleDropColumn = async (columnName: string) => {
    if (!selectedConnection || !selectedTable) return;
    await api.databasesAlterTable(selectedConnection.id, selectedTable, {
      action: "DROP_COLUMN",
      schema: selectedSchema || undefined,
      columnName,
      mode
    });
    void loadCatalog(selectedConnection.id);
    void loadTableData();
  };

  const handleAddIndex = async (index: { name: string; columns: string[]; unique?: boolean }) => {
    if (!selectedConnection || !selectedTable) return;
    await api.databasesAlterTable(selectedConnection.id, selectedTable, {
      action: "ADD_INDEX",
      schema: selectedSchema || undefined,
      index,
      mode
    });
    void loadCatalog(selectedConnection.id);
  };

  const handleDropIndex = async (indexName: string) => {
    if (!selectedConnection || !selectedTable) return;
    await api.databasesAlterTable(selectedConnection.id, selectedTable, {
      action: "DROP_INDEX",
      schema: selectedSchema || undefined,
      indexName,
      mode
    });
    void loadCatalog(selectedConnection.id);
  };

  const handleCreateTable = async (data: {
    tableName: string;
    schema?: string;
    columns: Array<{ name: string; type: string; nullable?: boolean; defaultValue?: string; isPrimaryKey?: boolean }>;
  }) => {
    if (!selectedConnection) return;
    await api.databasesCreateTable(selectedConnection.id, {
      ...data,
      mode
    });
    setSelectedTable(data.tableName);
    if (data.schema) setSelectedSchema(data.schema);
    void loadCatalog(selectedConnection.id);
  };

  // SQL execution
  const handleExecuteSql = async (sqlText: string, limit?: number): Promise<DatabaseExecuteSqlResponse> => {
    if (!selectedConnection) throw new Error("No database selected.");
    return await api.databasesExecuteSql({
      connectionId: selectedConnection.id,
      sql: sqlText,
      schema: selectedSchema || undefined,
      limit: limit ?? 100,
      mode
    });
  };

  const handleCancelSql = async (sessionId: string) => {
    if (!selectedConnection) return;
    await api.databasesCancelSql(sessionId, selectedConnection.id);
  };

  // Selected table metadata object
  const selectedTableMeta = useMemo(() => {
    if (!catalog || !selectedTable) return null;
    for (const s of catalog.schemas) {
      if (selectedSchema && s.name !== selectedSchema) continue;
      const found = s.tables.find((t) => t.name === selectedTable);
      if (found) return found;
    }
    return null;
  }, [catalog, selectedTable, selectedSchema]);

  const allTableNames = useMemo(() => {
    if (!catalog) return [];
    const list: string[] = [];
    for (const s of catalog.schemas) {
      for (const t of s.tables) {
        list.push(t.name);
      }
    }
    return list;
  }, [catalog]);

  const isEffectiveReadOnly = Boolean(
    selectedConnection?.isReadOnly && (!selectedConnection?.isInternal || mode !== "admin")
  );

  return (
    <div ref={rootRef} className="databases-pane-root" data-space-pane-id={pane?.id}>
      {/* Top Toolbar */}
      <DatabasesToolbar
        selectedConnection={
          selectedConnection
            ? { ...selectedConnection, isReadOnly: isEffectiveReadOnly }
            : null
        }
        selectedSchema={selectedSchema}
        selectedTable={selectedTable}
        mode={mode}
        isAdminCapable={isAdminCapable}
        onModeToggle={() => {
          if (mode === "user") {
            if (!isAdminCapable) {
              alert("Admin Mode requires Administrator or Operator privileges.");
              return;
            }
            setMode("admin");
            localStorage.setItem(STORAGE_MODE_KEY, "admin");
          } else {
            setMode("user");
            localStorage.setItem(STORAGE_MODE_KEY, "user");
          }
        }}
        onSelectCrumb={(level) => {
          if (level === "root") {
            setSelectedConnection(null);
            setSelectedTable(null);
            setTableData(null);
            try {
              localStorage.removeItem(STORAGE_CONN_KEY);
            } catch {}
          } else if (level === "connection") {
            setSelectedTable(null);
            setTableData(null);
            if (selectedConnection) {
              try {
                localStorage.setItem(`${STORAGE_TABLE_KEY_PREFIX}${selectedConnection.id}`, "none");
              } catch {}
            }
          } else if (level === "schema") {
            setSelectedTable(null);
            setTableData(null);
          }
        }}
        onNewConnection={() => {
          setEditingConnection(null);
          setShowConnectionModal(true);
        }}
        onDiscover={handleDiscover}
        onRefresh={() => {
          void loadConnections({ preserveSelection: true });
          if (selectedConnection) void loadCatalog(selectedConnection.id);
          if (selectedTable) void loadTableData();
        }}
        onNewTable={() => setShowCreateTableModal(true)}
        onImport={() => setShowImportModal(true)}
        onExport={() => setShowExportModal(true)}
        sidebarVisible={sidebarVisible}
        onToggleSidebar={handleToggleSidebar}
      />

      {/* Error Banner */}
      {errorNotice && (
        <div style={{ padding: "6px 14px", background: "rgba(239, 68, 68, 0.15)", color: "var(--modern-danger, #ef4444)", fontSize: "0.82rem" }}>
          {errorNotice}
        </div>
      )}

      {/* Main Body */}
      <div className="db-body">
        {/* Navigation Sidebar Tree */}
        <DatabasesSidebar
          collapsed={!sidebarVisible}
          connections={connections}
          selectedConnection={selectedConnection}
          selectedSchema={selectedSchema}
          selectedTable={selectedTable}
          catalog={catalog}
          isLoadingCatalog={isLoadingCatalog}
          onSelectConnection={(conn) => {
            setSelectedConnection(conn);
            setSelectedTable(null);
            setTableData(null);
            try {
              localStorage.setItem(STORAGE_CONN_KEY, conn.id);
              localStorage.removeItem(`${STORAGE_TABLE_KEY_PREFIX}${conn.id}`);
            } catch {}
          }}
          onSelectTable={(schema, tableName) => {
            setSelectedSchema(schema);
            setSelectedTable(tableName);
            setPage(1);
            if (selectedConnection) {
              try {
                localStorage.setItem(`${STORAGE_TABLE_KEY_PREFIX}${selectedConnection.id}`, tableName);
              } catch {}
            }
          }}
          onNewConnection={() => {
            setEditingConnection(null);
            setShowConnectionModal(true);
          }}
          onEditConnection={(conn) => {
            setEditingConnection(conn);
            setShowConnectionModal(true);
          }}
          onDeleteConnection={async (conn) => {
            if (confirm(`Remove connection '${conn.name}'? (The actual database will not be affected).`)) {
              await api.databasesDeleteConnection(conn.id, mode);
              void loadConnections();
            }
          }}
        />

        {/* Center Main Work Area */}
        <div className="db-main">
          {selectedConnection ? (
            <>
              {/* Tab Navigation */}
              <div className="db-tabs" role="tablist">
                <button
                  role="tab"
                  aria-selected={activeTab === "data"}
                  className={`db-tab-btn ${activeTab === "data" ? "active" : ""}`}
                  onClick={() => setActiveTab("data")}
                >
                  Data
                </button>
                <button
                  role="tab"
                  aria-selected={activeTab === "structure"}
                  className={`db-tab-btn ${activeTab === "structure" ? "active" : ""}`}
                  onClick={() => setActiveTab("structure")}
                >
                  Structure
                </button>
                <button
                  role="tab"
                  aria-selected={activeTab === "sql"}
                  className={`db-tab-btn ${activeTab === "sql" ? "active" : ""}`}
                  onClick={() => setActiveTab("sql")}
                >
                  SQL Editor
                </button>
              </div>

              {/* Tab Content */}
              <div className="db-tab-content">
                {activeTab === "data" && (
                  !selectedTable ? (
                    <DatabaseOverviewTab
                      connection={selectedConnection}
                      catalog={catalog}
                      isLoadingCatalog={isLoadingCatalog}
                      sidebarVisible={sidebarVisible}
                      onToggleSidebar={handleToggleSidebar}
                      onSelectTable={(schema, tableName) => {
                        setSelectedSchema(schema);
                        setSelectedTable(tableName);
                        setPage(1);
                        if (selectedConnection) {
                          try {
                            localStorage.setItem(`${STORAGE_TABLE_KEY_PREFIX}${selectedConnection.id}`, tableName);
                          } catch {}
                        }
                      }}
                    />
                  ) : (
                    <DataTab
                      tableName={selectedTable}
                      sidebarVisible={sidebarVisible}
                      onToggleSidebar={handleToggleSidebar}
                      onBrowseTables={() => {
                        setSelectedTable(null);
                        setTableData(null);
                        if (selectedConnection) {
                          try {
                            localStorage.setItem(`${STORAGE_TABLE_KEY_PREFIX}${selectedConnection.id}`, "none");
                          } catch {}
                        }
                      }}
                      tableData={tableData}
                      isLoading={isLoadingTableData}
                      page={page}
                      pageSize={pageSize}
                      sortColumn={sortColumn}
                      sortDirection={sortDirection}
                      filterColumn={filterColumn}
                      filterOp={filterOp}
                      filterValue={filterValue}
                      searchQuery={searchQuery}
                      isReadOnly={isEffectiveReadOnly}
                      onPageChange={setPage}
                      onPageSizeChange={setPageSize}
                      onSortChange={(col, dir) => {
                        setSortColumn(col);
                        setSortDirection(dir);
                      }}
                      onFilterChange={(col, op, val) => {
                        setFilterColumn(col);
                        setFilterOp(op);
                        setFilterValue(val);
                        setPage(1);
                      }}
                      onSearchChange={(q) => {
                        setSearchQuery(q);
                        setPage(1);
                      }}
                      onSaveRowUpdates={handleSaveRowUpdates}
                      onDeleteRow={handleDeleteRow}
                      onInsertRow={handleInsertRow}
                    />
                  )
                )}

                {activeTab === "structure" && (
                  <StructureTab
                    tableMeta={selectedTableMeta}
                    isReadOnly={isEffectiveReadOnly}
                    onAddColumn={handleAddColumn}
                    onDropColumn={handleDropColumn}
                    onAddIndex={handleAddIndex}
                    onDropIndex={handleDropIndex}
                  />
                )}

                {activeTab === "sql" && (
                  <SqlEditorTab
                    connectionId={selectedConnection.id}
                    catalog={catalog}
                    defaultSql={selectedTable ? `SELECT * FROM ${selectedTable} LIMIT 50;` : undefined}
                    isReadOnly={isEffectiveReadOnly}
                    onExecuteSql={handleExecuteSql}
                    onCancelSql={handleCancelSql}
                  />
                )}
              </div>
            </>
          ) : (
            <DatabaseConnectionsOverview
              connections={connections}
              sidebarVisible={sidebarVisible}
              onToggleSidebar={handleToggleSidebar}
              onSelectConnection={(conn) => {
                setSelectedConnection(conn);
                setSelectedTable(null);
                setTableData(null);
                try {
                  localStorage.setItem(STORAGE_CONN_KEY, conn.id);
                  localStorage.removeItem(`${STORAGE_TABLE_KEY_PREFIX}${conn.id}`);
                } catch {}
              }}
              onNewConnection={() => {
                setEditingConnection(null);
                setShowConnectionModal(true);
              }}
              onDiscover={handleDiscover}
            />
          )}
        </div>
      </div>

      {/* Modals */}
      {showConnectionModal && (
        <ConnectionModal
          initialConnection={editingConnection}
          projectPath={effectiveProjectPath}
          onClose={() => {
            setShowConnectionModal(false);
            setEditingConnection(null);
          }}
          onSubmit={async (input) => {
            if (editingConnection && editingConnection.id !== "discovered-template") {
              await api.databasesUpdateConnection(editingConnection.id, input, mode);
            } else {
              await api.databasesCreateConnection(input);
            }
            void loadConnections();
          }}
          onTest={async (input) => {
            return await api.databasesTestConnection(input);
          }}
        />
      )}

      {showDiscoverModal && (
        <DiscoverModal
          discovered={discoveredItems}
          isLoading={isDiscovering}
          onClose={() => setShowDiscoverModal(false)}
          onRefresh={handleDiscover}
          onConnectDiscovered={handleConnectDiscovered}
        />
      )}

      {showCreateTableModal && (
        <CreateTableModal
          schemas={catalog?.schemas.map((s) => s.name)}
          defaultSchema={selectedSchema || "public"}
          onClose={() => setShowCreateTableModal(false)}
          onSubmit={handleCreateTable}
        />
      )}

      {showImportModal && selectedConnection && (
        <ImportModal
          currentTable={selectedTable}
          onClose={() => setShowImportModal(false)}
          onImport={async (params) => {
            return await api.databasesImport(selectedConnection.id, {
              ...params,
              schema: selectedSchema || undefined,
              mode
            });
          }}
        />
      )}

      {showExportModal && selectedConnection && (
        <ExportModal
          currentTable={selectedTable}
          tables={allTableNames}
          onClose={() => setShowExportModal(false)}
          onExport={async (params) => {
            return await api.databasesExport(selectedConnection.id, {
              ...params,
              schema: selectedSchema || undefined,
              mode
            });
          }}
        />
      )}
    </div>
  );
}

export default DatabasesPane;
