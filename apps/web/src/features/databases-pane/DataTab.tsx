import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Plus,
  Trash2,
  Save,
  RotateCcw,
  Search,
  Filter,
  ChevronLeft,
  ChevronRight,
  Check,
  X,
  Table as TableIcon
} from "../ui-theme/app-icons.js";
import type { DatabaseColumnMeta, DatabaseTableDataResponse } from "@space/contracts";

export function formatCellDisplay(val: unknown): string {
  if (val === null || val === undefined) return "";
  let str = typeof val === "object" ? JSON.stringify(val) : String(val);
  if (str.includes("\u001b") || str.includes("\x1b")) {
    str = str
      .replace(/\x1b\[[0-9;?<>]*[a-zA-Z~]/g, "")
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b[()][AB012]/g, "")
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\r]/g, "");
  }
  return str;
}


export interface DataTabProps {
  tableName?: string;
  sidebarVisible?: boolean;
  onToggleSidebar?: () => void;
  onBrowseTables?: () => void;
  tableData: DatabaseTableDataResponse | null;
  isLoading: boolean;
  page: number;
  pageSize: number;
  sortColumn?: string;
  sortDirection?: "asc" | "desc";
  filterColumn?: string;
  filterOp?: string;
  filterValue?: string;
  searchQuery?: string;
  isReadOnly?: boolean;
  onPageChange: (newPage: number) => void;
  onPageSizeChange: (newSize: number) => void;
  onSortChange: (columnName: string, direction?: "asc" | "desc") => void;
  onFilterChange: (col?: string, op?: string, val?: string) => void;
  onSearchChange: (q: string) => void;
  onSaveRowUpdates: (updates: Array<{ keys: Record<string, unknown>; values: Record<string, unknown> }>) => Promise<void>;
  onDeleteRow: (keys: Record<string, unknown>) => Promise<void>;
  onInsertRow: (values: Record<string, unknown>) => Promise<void>;
}

export function DataTab({
  tableName,
  sidebarVisible,
  onToggleSidebar,
  onBrowseTables,
  tableData,
  isLoading,
  page,
  pageSize,
  sortColumn,
  sortDirection,
  filterColumn: initialFilterColumn,
  filterOp: initialFilterOp,
  filterValue: initialFilterValue,
  searchQuery: initialSearchQuery,
  isReadOnly,
  onPageChange,
  onPageSizeChange,
  onSortChange,
  onFilterChange,
  onSearchChange,
  onSaveRowUpdates,
  onDeleteRow,
  onInsertRow
}: DataTabProps) {
  // Pending row edits: rowKey -> { keys, values }
  const [pendingEdits, setPendingEdits] = useState<Record<string, { keys: Record<string, unknown>; values: Record<string, unknown> }>>({});
  const [editingCell, setEditingCell] = useState<{ rowKey: string; colName: string } | null>(null);
  const [cellEditValue, setCellEditValue] = useState<string>("");
  const [isSaving, setIsSaving] = useState(false);

  // Filter local state
  const [filterCol, setFilterCol] = useState(initialFilterColumn || "");
  const [filterOp, setFilterOp] = useState(initialFilterOp || "eq");
  const [filterVal, setFilterVal] = useState(initialFilterValue || "");
  const [searchVal, setSearchVal] = useState(initialSearchQuery || "");

  // Add row modal
  const [showAddRowModal, setShowAddRowModal] = useState(false);
  const [newRowValues, setNewRowValues] = useState<Record<string, string>>({});

  const columnsMeta = tableData?.columns || [];
  const primaryKeys = tableData?.primaryKeys || [];
  const rows = tableData?.rows || [];
  const totalRows = tableData?.totalRows || 0;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));

  // Helper to extract unique row key
  const getRowKey = useCallback((row: Record<string, unknown>, index: number) => {
    if (primaryKeys.length > 0) {
      return primaryKeys.map((pk) => String(row[pk])).join("::");
    }
    return `row_${index}`;
  }, [primaryKeys]);

  const getRowKeyObject = useCallback((row: Record<string, unknown>) => {
    const keysObj: Record<string, unknown> = {};
    if (primaryKeys.length > 0) {
      for (const pk of primaryKeys) {
        keysObj[pk] = row[pk];
      }
    } else {
      // Fallback: use all non-null values
      for (const [k, v] of Object.entries(row)) {
        if (v !== null && v !== undefined) keysObj[k] = v;
      }
    }
    return keysObj;
  }, [primaryKeys]);

  // Construct TanStack columns
  const tableColumns = useMemo<ColumnDef<Record<string, unknown>>[]>(() => {
    const cols: ColumnDef<Record<string, unknown>>[] = [];

    // Actions column
    if (!isReadOnly) {
      cols.push({
        id: "_actions",
        header: () => <span style={{ width: 36, display: "inline-block" }}></span>,
        cell: ({ row }) => (
          <button
            type="button"
            className="db-table-action-btn"
            title="Delete row"
            onClick={(e) => {
              e.stopPropagation();
              const keys = getRowKeyObject(row.original);
              if (confirm("Are you sure you want to delete this row?")) {
                void onDeleteRow(keys);
              }
            }}
          >
            <Trash2 size={13} />
          </button>
        ),
        size: 36
      });
    }

    for (const c of columnsMeta) {
      const nameLen = c.name.length;
      const isWideField = ["message", "prompt", "preview", "title", "content", "query", "sql", "error", "description", "details"].some((k) =>
        c.name.toLowerCase().includes(k)
      );
      const colSize = c.isPrimaryKey
        ? 130
        : isWideField
        ? 280
        : Math.max(130, Math.min(260, nameLen * 11 + 50));

      cols.push({
        id: c.name,
        accessorKey: c.name,
        size: colSize,
        header: () => {
          const isSorted = sortColumn === c.name;
          return (
            <div
              className="db-th-inner"
              title={`${c.name} (${c.type || "unknown"})${c.isPrimaryKey ? " - Primary Key" : ""}`}
              style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", width: "100%", overflow: "hidden" }}
              onClick={() => {
                if (!isSorted) {
                  onSortChange(c.name, "asc");
                } else if (sortDirection === "asc") {
                  onSortChange(c.name, "desc");
                } else {
                  onSortChange(c.name, undefined);
                }
              }}
            >
              <span className="db-th-label" style={{ fontWeight: c.isPrimaryKey ? 700 : 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {c.name}
              </span>
              {c.isPrimaryKey && <span style={{ color: "var(--modern-accent)", fontSize: "0.68rem", flexShrink: 0 }}>[PK]</span>}
              {isSorted ? (
                sortDirection === "asc" ? <ArrowUp size={12} style={{ flexShrink: 0 }} /> : <ArrowDown size={12} style={{ flexShrink: 0 }} />
              ) : (
                <ArrowUpDown size={11} style={{ opacity: 0.3, flexShrink: 0 }} />
              )}
            </div>
          );
        },
        cell: ({ row }) => {
          const rKey = getRowKey(row.original, row.index);
          const isEditing = editingCell?.rowKey === rKey && editingCell?.colName === c.name;
          const pendingRow = pendingEdits[rKey];
          const hasPending = pendingRow && Object.prototype.hasOwnProperty.call(pendingRow.values, c.name);
          const rawVal = hasPending ? pendingRow.values[c.name] : row.original[c.name];

          if (isEditing) {
            return (
              <input
                autoFocus
                className="db-cell-input"
                value={cellEditValue}
                onChange={(e) => setCellEditValue(e.target.value)}
                onBlur={() => {
                  if (cellEditValue !== String(row.original[c.name] ?? "")) {
                    const keys = getRowKeyObject(row.original);
                    setPendingEdits((prev) => ({
                      ...prev,
                      [rKey]: {
                        keys,
                        values: { ...(prev[rKey]?.values || {}), [c.name]: cellEditValue }
                      }
                    }));
                  }
                  setEditingCell(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.currentTarget.blur();
                  } else if (e.key === "Escape") {
                    setEditingCell(null);
                  }
                }}
              />
            );
          }

          const formatted = formatCellDisplay(rawVal);
          const cellText = formatted.replace(/\n+/g, " ");

          return (
            <div
              className="db-cell-content"
              title={formatted}
              style={{ minHeight: 18, cursor: isReadOnly ? "default" : "text", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              onDoubleClick={() => {
                if (isReadOnly) return;
                setEditingCell({ rowKey: rKey, colName: c.name });
                setCellEditValue(rawVal !== null && rawVal !== undefined ? String(rawVal) : "");
              }}
            >
              {rawVal === null || rawVal === undefined ? (
                <span className="db-cell-null">NULL</span>
              ) : (
                cellText
              )}
            </div>
          );
        }
      });
    }

    return cols;
  }, [columnsMeta, sortColumn, sortDirection, isReadOnly, editingCell, cellEditValue, pendingEdits, getRowKey, getRowKeyObject, onSortChange, onDeleteRow]);

  const table = useReactTable({
    data: rows,
    columns: tableColumns,
    getCoreRowModel: getCoreRowModel()
  });

  const tableContainerRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: () => 32,
    overscan: 10
  });

  useEffect(() => {
    if (tableContainerRef.current) {
      tableContainerRef.current.scrollLeft = 0;
      tableContainerRef.current.scrollTop = 0;
    }
  }, [tableName]);

  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();
  const paddingTop = virtualRows.length > 0 ? (virtualRows[0]?.start ?? 0) : 0;
  const paddingBottom = virtualRows.length > 0 ? Math.max(0, totalSize - (virtualRows[virtualRows.length - 1]?.end ?? totalSize)) : 0;
  const colCount = table.getVisibleLeafColumns().length;

  const pendingCount = Object.keys(pendingEdits).length;

  const handleSavePending = async () => {
    setIsSaving(true);
    try {
      const updates = Object.values(pendingEdits);
      await onSaveRowUpdates(updates);
      setPendingEdits({});
    } finally {
      setIsSaving(false);
    }
  };

  const handleDiscardPending = () => {
    setPendingEdits({});
  };

  const handleApplyFilter = () => {
    if (filterCol && filterOp) {
      onFilterChange(filterCol, filterOp, filterVal);
    } else {
      onFilterChange(undefined, undefined, undefined);
    }
  };

  const handleClearFilter = () => {
    setFilterCol("");
    setFilterOp("eq");
    setFilterVal("");
    onFilterChange(undefined, undefined, undefined);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", overflow: "hidden" }}>
      {/* Controls Bar */}
      <div className="db-data-controls">
        <div className="db-data-controls-left">
          {/* Quick Search */}
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <Search size={13} style={{ color: "var(--modern-muted)" }} />
            <input
              type="text"
              className="db-input"
              style={{ width: 140 }}
              placeholder="Search data..."
              value={searchVal}
              onChange={(e) => setSearchVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSearchChange(searchVal);
              }}
            />
          </div>

          {/* Filter Bar */}
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <Filter size={13} style={{ color: "var(--modern-muted)" }} />
            <select
              className="db-select"
              value={filterCol}
              onChange={(e) => setFilterCol(e.target.value)}
            >
              <option value="">Filter column...</option>
              {columnsMeta.map((col) => (
                <option key={col.name} value={col.name}>
                  {col.name}
                </option>
              ))}
            </select>

            {filterCol && (
              <>
                <select
                  className="db-select"
                  value={filterOp}
                  onChange={(e) => setFilterOp(e.target.value)}
                >
                  <option value="eq">=</option>
                  <option value="neq">!=</option>
                  <option value="like">contains</option>
                  <option value="gt">&gt;</option>
                  <option value="lt">&lt;</option>
                  <option value="null">is null</option>
                  <option value="notnull">is not null</option>
                </select>

                {!["null", "notnull"].includes(filterOp) && (
                  <input
                    type="text"
                    className="db-input"
                    placeholder="Value..."
                    value={filterVal}
                    onChange={(e) => setFilterVal(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleApplyFilter();
                    }}
                  />
                )}

                <button className="db-btn" onClick={handleApplyFilter} title="Apply Filter">
                  <Check size={12} />
                </button>
                <button className="db-btn" onClick={handleClearFilter} title="Clear Filter">
                  <X size={12} />
                </button>
              </>
            )}
          </div>
        </div>

        <div className="db-data-controls-right">
          {!isReadOnly && (
            <button
              className="db-btn db-btn-primary"
              onClick={() => {
                setNewRowValues({});
                setShowAddRowModal(true);
              }}
            >
              <Plus size={13} />
              <span>Add Row</span>
            </button>
          )}
        </div>
      </div>

      {/* Virtual Table Area */}
      <div className="db-table-wrapper" ref={tableContainerRef}>
        {isLoading ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--modern-muted)" }}>
            Loading table data...
          </div>
        ) : !tableName ? (
          <div style={{ padding: 32, textAlign: "center", color: "var(--modern-muted)" }}>
            <TableIcon size={24} style={{ display: "block", margin: "0 auto 8px auto", opacity: 0.6 }} />
            <div style={{ fontWeight: 500 }}>No table selected</div>
            <div style={{ fontSize: "0.8rem", marginTop: 4 }}>Select a table from the sidebar to view records.</div>
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 36, textAlign: "center", color: "var(--modern-muted)" }}>
            <TableIcon size={24} style={{ display: "block", margin: "0 auto 8px auto", opacity: 0.6 }} />
            <div style={{ fontWeight: 600, fontSize: "0.95rem", color: "var(--modern-text)" }}>
              Table "{tableName}" has 0 records
            </div>
            <div style={{ fontSize: "0.82rem", marginTop: 4, color: "var(--modern-muted)" }}>
              This table is currently empty in the database.
            </div>
            <div style={{ marginTop: 16, display: "flex", gap: 8, justifyContent: "center" }}>
              {onBrowseTables && (
                <button
                  type="button"
                  className="db-btn db-btn-primary"
                  onClick={onBrowseTables}
                >
                  Browse other tables
                </button>
              )}
            </div>
          </div>
        ) : (
          <table className="db-grid-table">
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => {
                    const isAction = header.column.id === "_actions";
                    return (
                      <th
                        key={header.id}
                        className={isAction ? "actions-col" : ""}
                        style={{
                          width: header.getSize(),
                          minWidth: isAction ? 36 : 120,
                          maxWidth: isAction ? 36 : 400
                        }}
                      >
                        {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {paddingTop > 0 && (
                <tr className="db-grid-spacer-row">
                  <td colSpan={colCount} style={{ height: `${paddingTop}px` }} />
                </tr>
              )}
              {virtualRows.map((virtualRow) => {
                const row = table.getRowModel().rows[virtualRow.index];
                if (!row) return null;
                const rKey = getRowKey(row.original, row.index);
                const isModified = Boolean(pendingEdits[rKey]);
                return (
                  <tr
                    key={row.id}
                    className={isModified ? "modified" : ""}
                    style={{
                      height: `${virtualRow.size}px`
                    }}
                  >
                    {row.getVisibleCells().map((cell) => {
                      const isAction = cell.column.id === "_actions";
                      return (
                        <td
                          key={cell.id}
                          className={isAction ? "actions-col" : ""}
                          style={{
                            width: cell.column.getSize(),
                            minWidth: isAction ? 36 : 120,
                            maxWidth: isAction ? 36 : 400
                          }}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {paddingBottom > 0 && (
                <tr className="db-grid-spacer-row">
                  <td colSpan={colCount} style={{ height: `${paddingBottom}px` }} />
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Floating Pending Edits Bar */}
      {pendingCount > 0 && (
        <div className="db-pending-bar">
          <span style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--modern-text)" }}>
            {pendingCount} unsaved row {pendingCount === 1 ? "change" : "changes"}
          </span>
          <button
            className="db-btn db-btn-primary"
            onClick={() => void handleSavePending()}
            disabled={isSaving}
          >
            <Save size={13} />
            <span>{isSaving ? "Saving..." : "Save All"}</span>
          </button>
          <button
            className="db-btn"
            onClick={handleDiscardPending}
            disabled={isSaving}
          >
            <RotateCcw size={13} />
            <span>Discard</span>
          </button>
        </div>
      )}

      {/* Pagination Footer */}
      <div className="db-pagination-bar">
        <div>
          {!tableName
            ? "No table selected"
            : `Showing ${rows.length > 0 ? (page - 1) * pageSize + 1 : 0} to ${Math.min(page * pageSize, totalRows)} of ${totalRows} records`}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span>Rows per page:</span>
            <select
              className="db-select"
              style={{ padding: "2px 6px" }}
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
            >
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="200">200</option>
            </select>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <button
              className="db-btn db-btn-icon-only"
              onClick={() => onPageChange(page - 1)}
              disabled={page <= 1}
              title="Previous Page"
            >
              <ChevronLeft size={14} />
            </button>
            <span style={{ padding: "0 6px" }}>
              Page {page} of {totalPages}
            </span>
            <button
              className="db-btn db-btn-icon-only"
              onClick={() => onPageChange(page + 1)}
              disabled={page >= totalPages}
              title="Next Page"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Add Row Modal */}
      {showAddRowModal && (
        <div className="db-modal-overlay">
          <div className="db-modal">
            <div className="db-modal-header">
              <span>Insert New Row</span>
              <button className="db-crumb-btn" onClick={() => setShowAddRowModal(false)}>
                <X size={15} />
              </button>
            </div>
            <div className="db-modal-body">
              {columnsMeta.map((col) => {
                if (col.isAutoIncrement) return null;
                return (
                  <div key={col.name} className="db-form-group">
                    <label className="db-form-label">
                      {col.name} <span style={{ opacity: 0.6 }}>({col.type})</span>
                      {col.isPrimaryKey && <span style={{ color: "var(--modern-accent)", marginLeft: 4 }}>[PK]</span>}
                    </label>
                    <input
                      type="text"
                      className="db-input"
                      placeholder={col.nullable ? "NULL (leave empty)" : "Value..."}
                      value={newRowValues[col.name] || ""}
                      onChange={(e) =>
                        setNewRowValues((prev) => ({ ...prev, [col.name]: e.target.value }))
                      }
                    />
                  </div>
                );
              })}
            </div>
            <div className="db-modal-footer">
              <button className="db-btn" onClick={() => setShowAddRowModal(false)}>
                Cancel
              </button>
              <button
                className="db-btn db-btn-primary"
                onClick={async () => {
                  const valuesToSend: Record<string, unknown> = {};
                  for (const [k, v] of Object.entries(newRowValues)) {
                    if (v.trim() !== "") valuesToSend[k] = v;
                  }
                  await onInsertRow(valuesToSend);
                  setShowAddRowModal(false);
                }}
              >
                Insert Row
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
