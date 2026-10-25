import { useState, useRef } from "react";
import { FileUp, FileDown, X } from "../ui-theme/app-icons.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";

export interface ImportModalProps {
  currentTable?: string | null;
  onClose: () => void;
  onImport: (params: { format: "SQL" | "CSV"; table?: string; content: string }) => Promise<{ importedRows: number; message?: string }>;
}

export function ImportModal({ currentTable, onClose, onImport }: ImportModalProps) {
  const [format, setFormat] = useState<"SQL" | "CSV">(currentTable ? "CSV" : "SQL");
  const [table, setTable] = useState(currentTable || "");
  const [content, setContent] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result;
      if (typeof text === "string") {
        setContent(text);
      }
    };
    reader.readAsText(file);
  };

  const handleSubmit = async () => {
    if (!content.trim()) return;
    setIsImporting(true);
    try {
      const res = await onImport({
        format,
        table: format === "CSV" ? table : undefined,
        content
      });
      alert(res.message || "Import completed successfully.");
      onClose();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Import failed");
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="db-modal-overlay">
      <div className="db-modal">
        <div className="db-modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <FileUp size={16} style={{ color: "var(--modern-accent)" }} />
            <span>Import Data / Script</span>
          </div>
          <button className="db-crumb-btn" onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div className="db-modal-body">
          <div className="db-form-group">
            <label className="db-form-label">Format</label>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className={`db-btn ${format === "SQL" ? "db-btn-primary" : ""}`}
                style={{ flex: 1, justifyContent: "center" }}
                onClick={() => setFormat("SQL")}
              >
                SQL Script
              </button>
              <button
                type="button"
                className={`db-btn ${format === "CSV" ? "db-btn-primary" : ""}`}
                style={{ flex: 1, justifyContent: "center" }}
                onClick={() => setFormat("CSV")}
              >
                CSV Data
              </button>
            </div>
          </div>

          {format === "CSV" && (
            <div className="db-form-group">
              <label className="db-form-label">Target Table</label>
              <input
                type="text"
                className="db-input"
                placeholder="Table name to insert records into"
                value={table}
                onChange={(e) => setTable(e.target.value)}
              />
            </div>
          )}

          <div className="db-form-group">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <label className="db-form-label">File or Raw Content</label>
              <button
                type="button"
                className="db-btn"
                style={{ padding: "2px 6px", fontSize: "0.75rem" }}
                onClick={() => fileInputRef.current?.click()}
              >
                Upload File...
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept={format === "SQL" ? ".sql" : ".csv"}
                style={{ display: "none" }}
                onChange={handleFileUpload}
              />
            </div>
            <textarea
              className="db-input"
              rows={8}
              style={{ fontFamily: "monospace", fontSize: "0.78rem" }}
              placeholder={format === "SQL" ? "Paste SQL statements here..." : "col1,col2,col3\nval1,val2,val3"}
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </div>
        </div>

        <div className="db-modal-footer">
          <button type="button" className="db-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="db-btn db-btn-primary"
            disabled={isImporting || !content.trim() || (format === "CSV" && !table.trim())}
            onClick={handleSubmit}
          >
            {isImporting ? "Importing..." : "Start Import"}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface ExportModalProps {
  currentTable?: string | null;
  tables: string[];
  onClose: () => void;
  onExport: (params: { format: "SQL" | "CSV"; table?: string; includeStructure?: boolean; includeData?: boolean }) => Promise<string>;
}

export function ExportModal({ currentTable, tables, onClose, onExport }: ExportModalProps) {
  const [format, setFormat] = useState<"SQL" | "CSV">("SQL");
  const [table, setTable] = useState(currentTable || (tables[0] || ""));
  const [includeStructure, setIncludeStructure] = useState(true);
  const [includeData, setIncludeData] = useState(true);
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const content = await onExport({
        format,
        table: table || undefined,
        includeStructure,
        includeData
      });

      // Download trigger
      const blob = new Blob([content], { type: format === "CSV" ? "text/csv" : "application/sql" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${table || "export"}_${Date.now()}.${format.toLowerCase()}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      onClose();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Export failed");
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="db-modal-overlay">
      <div className="db-modal">
        <div className="db-modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <FileDown size={16} style={{ color: "var(--modern-accent)" }} />
            <span>Export Database / Table</span>
          </div>
          <button className="db-crumb-btn" onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div className="db-modal-body">
          <div className="db-form-group">
            <label className="db-form-label">Format</label>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className={`db-btn ${format === "SQL" ? "db-btn-primary" : ""}`}
                style={{ flex: 1, justifyContent: "center" }}
                onClick={() => setFormat("SQL")}
              >
                SQL Dump
              </button>
              <button
                type="button"
                className={`db-btn ${format === "CSV" ? "db-btn-primary" : ""}`}
                style={{ flex: 1, justifyContent: "center" }}
                onClick={() => setFormat("CSV")}
              >
                CSV Table Data
              </button>
            </div>
          </div>

          <div className="db-form-group">
            <label className="db-form-label">Table</label>
            <select
              className="db-select"
              value={table}
              onChange={(e) => setTable(e.target.value)}
            >
              {tables.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          {format === "SQL" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
              <SpaceToggle
                label="Include Table Structure (DDL)"
                checked={includeStructure}
                onChange={setIncludeStructure}
              />
              <SpaceToggle
                label="Include Data (INSERTs)"
                checked={includeData}
                onChange={setIncludeData}
              />
            </div>
          )}
        </div>

        <div className="db-modal-footer">
          <button type="button" className="db-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="db-btn db-btn-primary"
            disabled={isExporting}
            onClick={handleExport}
          >
            {isExporting ? "Exporting..." : "Download Export"}
          </button>
        </div>
      </div>
    </div>
  );
}
