import { useState } from "react";
import { Plus, Trash2, Key, Link as LinkIcon, Layers, X } from "../ui-theme/app-icons.js";
import type { DatabaseTableMeta } from "@space/contracts";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";

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
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
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
        {t("Select a table to view structure.")}
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
            {t("Columns ({count})", { count: columns.length })}
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
              <span>{t("Add Column")}</span>
            </button>
          )}
        </div>

        <table className="db-grid-table" style={{ border: "1px solid var(--modern-border, #2a3947)", borderRadius: 6 }}>
          <thead>
            <tr>
              <th>#</th>
              <th>{t("Name")}</th>
              <th>{t("Type")}</th>
              <th>{t("Nullable")}</th>
              <th>{t("Default")}</th>
              <th>{t("Key")}</th>
              {!isReadOnly && <th className="actions-col" style={{ width: 36, minWidth: 36, maxWidth: 36, textAlign: "center" }}></th>}
            </tr>
          </thead>
          <tbody>
            {columns.map((c, i) => (
              <tr key={c.name}>
                <td style={{ color: "var(--modern-faint)" }}>{i + 1}</td>
                <td style={{ fontWeight: 600 }}>{c.name}</td>
                <td><code>{c.type}</code></td>
                <td>{c.nullable ? t("YES") : t("NO")}</td>
                <td>{c.defaultValue !== null && c.defaultValue !== undefined ? <code>{String(c.defaultValue)}</code> : <span className="db-cell-null">{t("None")}</span>}</td>
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
                        title={t("Drop Column")}
                        onClick={() => {
                          if (confirm(t("Are you sure you want to drop column '{name}'?", { name: c.name }))) {
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
            {t("Indexes ({count})", { count: indexes.length })}
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
              <span>{t("Add Index")}</span>
            </button>
          )}
        </div>

        {indexes.length === 0 ? (
          <div style={{ fontSize: "0.8rem", color: "var(--modern-muted)" }}>{t("No secondary indexes.")}</div>
        ) : (
          <table className="db-grid-table" style={{ border: "1px solid var(--modern-border, #2a3947)", borderRadius: 6 }}>
            <thead>
              <tr>
                <th>{t("Index Name")}</th>
                <th>{t("Columns")}</th>
                <th>{t("Unique")}</th>
                {!isReadOnly && <th className="actions-col" style={{ width: 36, minWidth: 36, maxWidth: 36, textAlign: "center" }}></th>}
              </tr>
            </thead>
            <tbody>
              {indexes.map((idx) => (
                <tr key={idx.name}>
                  <td style={{ fontWeight: 600 }}>{idx.name}</td>
                  <td>{idx.columns.join(", ") || "-"}</td>
                  <td>{idx.unique ? t("YES") : t("NO")}</td>
                  {!isReadOnly && (
                    <td className="actions-col" style={{ width: 36, minWidth: 36, maxWidth: 36, textAlign: "center", padding: "2px 4px" }}>
                      <button
                        type="button"
                        className="db-table-action-btn"
                        title={t("Drop Index")}
                        onClick={() => {
                          if (confirm(t("Are you sure you want to drop index '{name}'?", { name: idx.name }))) {
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
            {t("Foreign Keys ({count})", { count: foreignKeys.length })}
          </h3>
        </div>

        {foreignKeys.length === 0 ? (
          <div style={{ fontSize: "0.8rem", color: "var(--modern-muted)" }}>{t("No foreign key relationships.")}</div>
        ) : (
          <table className="db-grid-table" style={{ border: "1px solid var(--modern-border, #2a3947)", borderRadius: 6 }}>
            <thead>
              <tr>
                <th>{t("Constraint Name")}</th>
                <th>{t("Column")}</th>
                <th>{t("References")}</th>
                <th>{t("On Update")}</th>
                <th>{t("On Delete")}</th>
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
              <span>{t("Add Column to {name}", { name: tableMeta.name })}</span>
              <button className="db-crumb-btn" onClick={() => setShowAddColModal(false)}>
                <X size={15} />
              </button>
            </div>
            <div className="db-modal-body">
              <div className="db-form-group">
                <label className="db-form-label">{t("Column Name")}</label>
                <input
                  type="text"
                  className="db-input"
                  placeholder={t("e.g. status, user_id, bio")}
                  value={colName}
                  onChange={(e) => setColName(e.target.value)}
                />
              </div>
              <div className="db-form-group">
                <label className="db-form-label">{t("Data Type")}</label>
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
                  label={t("Allow NULL values")}
                  checked={colNullable}
                  onChange={setColNullable}
                />
              </div>
              <div className="db-form-group">
                <label className="db-form-label">{t("Default Value (optional)")}</label>
                <input
                  type="text"
                  className="db-input"
                  placeholder={t("e.g. 'active', 0, now()")}
                  value={colDefault}
                  onChange={(e) => setColDefault(e.target.value)}
                />
              </div>
            </div>
            <div className="db-modal-footer">
              <button className="db-btn" onClick={() => setShowAddColModal(false)}>
                {t("Cancel")}
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
                {t("Add Column")}
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
              <span>{t("Create Index on {name}", { name: tableMeta.name })}</span>
              <button className="db-crumb-btn" onClick={() => setShowAddIdxModal(false)}>
                <X size={15} />
              </button>
            </div>
            <div className="db-modal-body">
              <div className="db-form-group">
                <label className="db-form-label">{t("Index Name")}</label>
                <input
                  type="text"
                  className="db-input"
                  value={idxName}
                  onChange={(e) => setIdxName(e.target.value)}
                />
              </div>
              <div className="db-form-group">
                <label className="db-form-label">{t("Indexed Columns")}</label>
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
                  label={t("UNIQUE Index")}
                  checked={idxUnique}
                  onChange={setIdxUnique}
                />
              </div>
            </div>
            <div className="db-modal-footer">
              <button className="db-btn" onClick={() => setShowAddIdxModal(false)}>
                {t("Cancel")}
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
                {t("Create Index")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
