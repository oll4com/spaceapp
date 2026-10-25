import { useState } from "react";
import { Plus, Trash2, X, Table as TableIcon } from "../ui-theme/app-icons.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";

export interface CreateTableModalProps {
  schemas?: string[];
  defaultSchema?: string;
  onClose: () => void;
  onSubmit: (data: {
    tableName: string;
    schema?: string;
    columns: Array<{
      name: string;
      type: string;
      nullable?: boolean;
      defaultValue?: string;
      isPrimaryKey?: boolean;
    }>;
  }) => Promise<void>;
}

export function CreateTableModal({
  schemas,
  defaultSchema,
  onClose,
  onSubmit
}: CreateTableModalProps) {
  const [tableName, setTableName] = useState("");
  const [schema, setSchema] = useState(defaultSchema || "public");
  const [columns, setColumns] = useState<
    Array<{ name: string; type: string; nullable: boolean; defaultValue: string; isPrimaryKey: boolean }>
  >([
    { name: "id", type: "integer", nullable: false, defaultValue: "", isPrimaryKey: true },
    { name: "name", type: "text", nullable: false, defaultValue: "", isPrimaryKey: false }
  ]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleAddCol = () => {
    setColumns((prev) => [
      ...prev,
      { name: `col_${prev.length + 1}`, type: "text", nullable: true, defaultValue: "", isPrimaryKey: false }
    ]);
  };

  const handleRemoveCol = (index: number) => {
    setColumns((prev) => prev.filter((_, i) => i !== index));
  };

  const handleColChange = (
    index: number,
    field: "name" | "type" | "nullable" | "defaultValue" | "isPrimaryKey",
    val: unknown
  ) => {
    setColumns((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index]!, [field]: val };
      return copy;
    });
  };

  const handleSubmit = async () => {
    if (!tableName.trim() || columns.length === 0) return;
    setIsSubmitting(true);
    try {
      await onSubmit({
        tableName: tableName.trim(),
        schema: schemas && schemas.length > 0 ? schema : undefined,
        columns: columns.map((c) => ({
          name: c.name.trim(),
          type: c.type,
          nullable: c.nullable,
          defaultValue: c.defaultValue.trim() || undefined,
          isPrimaryKey: c.isPrimaryKey
        }))
      });
      onClose();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to create table");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="db-modal-overlay">
      <div className="db-modal" style={{ maxWidth: 640 }}>
        <div className="db-modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <TableIcon size={16} style={{ color: "var(--modern-accent)" }} />
            <span>Create New Table</span>
          </div>
          <button className="db-crumb-btn" onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div className="db-modal-body">
          <div style={{ display: "flex", gap: 10 }}>
            <div className="db-form-group" style={{ flex: 2 }}>
              <label className="db-form-label">Table Name</label>
              <input
                type="text"
                className="db-input"
                placeholder="e.g. users, products, orders"
                value={tableName}
                onChange={(e) => setTableName(e.target.value)}
              />
            </div>

            {schemas && schemas.length > 1 && (
              <div className="db-form-group" style={{ flex: 1 }}>
                <label className="db-form-label">Schema</label>
                <select
                  className="db-select"
                  value={schema}
                  onChange={(e) => setSchema(e.target.value)}
                >
                  {schemas.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <label className="db-form-label" style={{ fontWeight: 600 }}>
                Columns Definition
              </label>
              <button type="button" className="db-btn" onClick={handleAddCol} style={{ padding: "3px 8px" }}>
                <Plus size={12} />
                <span>Add Column</span>
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {columns.map((col, idx) => (
                <div
                  key={idx}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: 6,
                    background: "var(--modern-surface-raised, #17212b)",
                    borderRadius: 6,
                    border: "1px solid var(--modern-border-subtle, rgba(255,255,255,0.05))"
                  }}
                >
                  <input
                    type="text"
                    className="db-input"
                    placeholder="Column name"
                    style={{ flex: 2 }}
                    value={col.name}
                    onChange={(e) => handleColChange(idx, "name", e.target.value)}
                  />

                  <select
                    className="db-select"
                    style={{ flex: 2 }}
                    value={col.type}
                    onChange={(e) => handleColChange(idx, "type", e.target.value)}
                  >
                    <option value="text">TEXT</option>
                    <option value="varchar(255)">VARCHAR(255)</option>
                    <option value="integer">INTEGER</option>
                    <option value="bigint">BIGINT</option>
                    <option value="boolean">BOOLEAN</option>
                    <option value="numeric">NUMERIC</option>
                    <option value="timestamp with time zone">TIMESTAMP</option>
                    <option value="jsonb">JSONB</option>
                  </select>

                  <SpaceToggle
                    className="db-col-toggle"
                    label="PK"
                    checked={col.isPrimaryKey}
                    onChange={(checked) => handleColChange(idx, "isPrimaryKey", checked)}
                  />

                  <SpaceToggle
                    className="db-col-toggle"
                    label="Null"
                    checked={col.nullable}
                    onChange={(checked) => handleColChange(idx, "nullable", checked)}
                  />

                  <button
                    type="button"
                    className="db-crumb-btn"
                    style={{ color: "var(--modern-danger)", padding: 4 }}
                    onClick={() => handleRemoveCol(idx)}
                    disabled={columns.length <= 1}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="db-modal-footer">
          <button type="button" className="db-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="db-btn db-btn-primary"
            onClick={handleSubmit}
            disabled={isSubmitting || !tableName.trim() || columns.length === 0}
          >
            {isSubmitting ? "Creating..." : "Create Table"}
          </button>
        </div>
      </div>
    </div>
  );
}
