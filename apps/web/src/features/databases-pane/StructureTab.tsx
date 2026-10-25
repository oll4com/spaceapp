import { useState } from "react";
import { Plus, Trash2, Key, Link as LinkIcon, Layers, X } from "../ui-theme/app-icons.js";
import type { DatabaseTableMeta } from "@space/contracts";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";

export interface StructureTabProps {
  tableMeta: DatabaseTableMeta | null;
  isReadOnly?: boolean;
  onAddColumn: (column: { name: string; type: string; nullable?: boolean; defaultValue?: string }) => Promise<void>;
  onDropColumn: (columnName: string) => Promise<void>;
  onAddIndex: (index: { name: string; columns: string[]; unique?: boolean }) => Promise<void>;
  onDropIndex: (indexName: string) => Promise<void>;
}

export function StructureTab({
  tableMeta,
  isReadOnly,
  onAddColumn,
  onDropColumn,
  onAddIndex,
  onDropIndex
}: StructureTabProps) {
  const [showAddColModal, setShowAddColModal] = useState(false);
  const [colName, setColName] = useState("");
  const [colType, setColType] = useState("text");
  const [colNullable, setColNullable] = useState(true);
  const [colDefault, setColDefault] = useState("");

  const [showAddIdxModal, setShowAddIdxModal] = useState(false);
  const [idxName, setIdxName] = useState("");
  const [idxCols, setIdxCols] = useState<string[]>([]);
  const [idxUnique, setIdxUnique] = useState(false);

  if (!tableMeta) {
    return (
      <div style={{ padding: 24, textAlign: "center", color: "var(--modern-muted)" }}>
        Select a table to view structure.
      </div>
    );
  }

  const columns = tableMeta.columns || [];
  const foreignKeys = tableMeta.foreignKeys || [];
  const indexes = tableMeta.indexes || [];

  return (
    <div style={{ padding: 16, overflowY: "auto", height: "100%", display: "flex", flexDirection: "column", gap: 20 }}>
      {/* 1. Columns Section */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <h3 style={{ fontSize: "0.9rem", fontWeight: 600, display: "flex", alignItems: "center", gap: 6, margin: 0 }}>
            <Layers size={15} style={{ color: "var(--modern-accent)" }} />
            Columns ({columns.length})
          </h3>
          {!isReadOnly && (
            <button
              className="db-btn db-btn-primary"
              onClick={() => {
                setColName("");
                setColType("text");
                setColNullable(true);
                setColDefault("");
                setShowAddColModal(true);
              }}
            >
              <Plus size={13} />
              <span>Add Column</span>
            </button>
          )}
        </div>

        <table className="db-grid-table" style={{ border: "1px solid var(--modern-border, #2a3947)", borderRadius: 6 }}>
          <thead>
            <tr>
              <th>#</th>
              <th>Name</th>
              <th>Type</th>
              <th>Nullable</th>
              <th>Default</th>
              <th>Key</th>
              {!isReadOnly && <th className="actions-col" style={{ width: 36, minWidth: 36, maxWidth: 36, textAlign: "center" }}></th>}
            </tr>
          </thead>
          <tbody>
            {columns.map((c, i) => (
              <tr key={c.name}>
                <td style={{ color: "var(--modern-faint)" }}>{i + 1}</td>
                <td style={{ fontWeight: 600 }}>{c.name}</td>
                <td><code>{c.type}</code></td>
                <td>{c.nullable ? "YES" : "NO"}</td>
                <td>{c.defaultValue !== null && c.defaultValue !== undefined ? <code>{String(c.defaultValue)}</code> : <span className="db-cell-null">None</span>}</td>
                <td>
                  {c.isPrimaryKey && (
                    <span style={{ color: "var(--modern-accent)", display: "inline-flex", alignItems: "center", gap: 3, fontWeight: 700 }}>
                      <Key size={11} /> PK
                    </span>
                  )}
                </td>
                {!isReadOnly && (
                  <td className="actions-col" style={{ width: 36, minWidth: 36, maxWidth: 36, textAlign: "center", padding: "2px 4px" }}>
                    {!c.isPrimaryKey && (
                      <button
                        type="button"
                        className="db-table-action-btn"
                        title="Drop Column"
                        onClick={() => {
                          if (confirm(`Are you sure you want to drop column '${c.name}'?`)) {
                            void onDropColumn(c.name);
                          }
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 2. Indexes Section */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <h3 style={{ fontSize: "0.9rem", fontWeight: 600, display: "flex", alignItems: "center", gap: 6, margin: 0 }}>
            <Key size={15} style={{ color: "var(--modern-warning, #f59e0b)" }} />
            Indexes ({indexes.length})
          </h3>
          {!isReadOnly && (
            <button
              className="db-btn"
              onClick={() => {
                setIdxName(`idx_${tableMeta.name}_`);
                setIdxCols([]);
                setIdxUnique(false);
                setShowAddIdxModal(true);
              }}
            >
              <Plus size={13} />
              <span>Add Index</span>
            </button>
          )}
        </div>

        {indexes.length === 0 ? (
          <div style={{ fontSize: "0.8rem", color: "var(--modern-muted)" }}>No secondary indexes.</div>
        ) : (
          <table className="db-grid-table" style={{ border: "1px solid var(--modern-border, #2a3947)", borderRadius: 6 }}>
            <thead>
              <tr>
                <th>Index Name</th>
                <th>Columns</th>
                <th>Unique</th>
                {!isReadOnly && <th className="actions-col" style={{ width: 36, minWidth: 36, maxWidth: 36, textAlign: "center" }}></th>}
              </tr>
            </thead>
            <tbody>
              {indexes.map((idx) => (
                <tr key={idx.name}>
                  <td style={{ fontWeight: 600 }}>{idx.name}</td>
                  <td>{idx.columns.join(", ") || "-"}</td>
                  <td>{idx.unique ? "YES" : "NO"}</td>
                  {!isReadOnly && (
                    <td className="actions-col" style={{ width: 36, minWidth: 36, maxWidth: 36, textAlign: "center", padding: "2px 4px" }}>
                      <button
                        type="button"
                        className="db-table-action-btn"
                        title="Drop Index"
                        onClick={() => {
                          if (confirm(`Are you sure you want to drop index '${idx.name}'?`)) {
                            void onDropIndex(idx.name);
                          }
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 3. Foreign Keys Section */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <h3 style={{ fontSize: "0.9rem", fontWeight: 600, display: "flex", alignItems: "center", gap: 6, margin: 0 }}>
            <LinkIcon size={15} style={{ color: "#64b5f6" }} />
            Foreign Keys ({foreignKeys.length})
          </h3>
        </div>

        {foreignKeys.length === 0 ? (
          <div style={{ fontSize: "0.8rem", color: "var(--modern-muted)" }}>No foreign key relationships.</div>
        ) : (
          <table className="db-grid-table" style={{ border: "1px solid var(--modern-border, #2a3947)", borderRadius: 6 }}>
            <thead>
              <tr>
                <th>Constraint Name</th>
                <th>Column</th>
                <th>References</th>
                <th>On Update</th>
                <th>On Delete</th>
              </tr>
            </thead>
            <tbody>
              {foreignKeys.map((fk) => (
                <tr key={fk.name}>
                  <td style={{ fontWeight: 600 }}>{fk.name}</td>
                  <td><code>{fk.column}</code></td>
                  <td><code>{fk.referencedTable}({fk.referencedColumn})</code></td>
                  <td>{fk.onUpdate || "NO ACTION"}</td>
                  <td>{fk.onDelete || "NO ACTION"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Add Column Modal */}
      {showAddColModal && (
        <div className="db-modal-overlay">
          <div className="db-modal">
            <div className="db-modal-header">
              <span>Add Column to {tableMeta.name}</span>
              <button className="db-crumb-btn" onClick={() => setShowAddColModal(false)}>
                <X size={15} />
              </button>
            </div>
            <div className="db-modal-body">
              <div className="db-form-group">
                <label className="db-form-label">Column Name</label>
                <input
                  type="text"
                  className="db-input"
                  placeholder="e.g. status, user_id, bio"
                  value={colName}
                  onChange={(e) => setColName(e.target.value)}
                />
              </div>
              <div className="db-form-group">
                <label className="db-form-label">Data Type</label>
                <select
                  className="db-select"
                  value={colType}
                  onChange={(e) => setColType(e.target.value)}
                >
                  <option value="text">TEXT / VARCHAR</option>
                  <option value="integer">INTEGER / INT</option>
                  <option value="bigint">BIGINT</option>
                  <option value="boolean">BOOLEAN</option>
                  <option value="numeric">NUMERIC / DECIMAL</option>
                  <option value="timestamp with time zone">TIMESTAMP WITH TIME ZONE</option>
                  <option value="jsonb">JSON / JSONB</option>
                </select>
              </div>
              <div style={{ marginTop: 6 }}>
                <SpaceToggle
                  id="col_nullable"
                  label="Allow NULL values"
                  checked={colNullable}
                  onChange={setColNullable}
                />
              </div>
              <div className="db-form-group">
                <label className="db-form-label">Default Value (optional)</label>
                <input
                  type="text"
                  className="db-input"
                  placeholder="e.g. 'active', 0, now()"
                  value={colDefault}
                  onChange={(e) => setColDefault(e.target.value)}
                />
              </div>
            </div>
            <div className="db-modal-footer">
              <button className="db-btn" onClick={() => setShowAddColModal(false)}>
                Cancel
              </button>
              <button
                className="db-btn db-btn-primary"
                disabled={!colName.trim()}
                onClick={async () => {
                  await onAddColumn({
                    name: colName.trim(),
                    type: colType,
                    nullable: colNullable,
                    defaultValue: colDefault.trim() || undefined
                  });
                  setShowAddColModal(false);
                }}
              >
                Add Column
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Index Modal */}
      {showAddIdxModal && (
        <div className="db-modal-overlay">
          <div className="db-modal">
            <div className="db-modal-header">
              <span>Create Index on {tableMeta.name}</span>
              <button className="db-crumb-btn" onClick={() => setShowAddIdxModal(false)}>
                <X size={15} />
              </button>
            </div>
            <div className="db-modal-body">
              <div className="db-form-group">
                <label className="db-form-label">Index Name</label>
                <input
                  type="text"
                  className="db-input"
                  value={idxName}
                  onChange={(e) => setIdxName(e.target.value)}
                />
              </div>
              <div className="db-form-group">
                <label className="db-form-label">Indexed Columns</label>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 150, overflowY: "auto" }}>
                  {columns.map((c) => (
                    <SpaceToggle
                      key={c.name}
                      label={c.name}
                      checked={idxCols.includes(c.name)}
                      onChange={(checked) => {
                        if (checked) setIdxCols((prev) => [...prev, c.name]);
                        else setIdxCols((prev) => prev.filter((x) => x !== c.name));
                      }}
                    />
                  ))}
                </div>
              </div>
              <div style={{ marginTop: 6 }}>
                <SpaceToggle
                  id="idx_unique"
                  label="UNIQUE Index"
                  checked={idxUnique}
                  onChange={setIdxUnique}
                />
              </div>
            </div>
            <div className="db-modal-footer">
              <button className="db-btn" onClick={() => setShowAddIdxModal(false)}>
                Cancel
              </button>
              <button
                className="db-btn db-btn-primary"
                disabled={!idxName.trim() || idxCols.length === 0}
                onClick={async () => {
                  await onAddIndex({
                    name: idxName.trim(),
                    columns: idxCols,
                    unique: idxUnique
                  });
                  setShowAddIdxModal(false);
                }}
              >
                Create Index
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
