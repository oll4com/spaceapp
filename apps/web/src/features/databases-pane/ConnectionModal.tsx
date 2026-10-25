import { useState, useEffect } from "react";
import { X, Check, CircleAlert, RefreshCw } from "../ui-theme/app-icons.js";
import type { CreateDatabaseConnectionInput, DatabaseConnection, DatabaseEngine } from "@space/contracts";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";

export interface ConnectionModalProps {
  initialConnection?: DatabaseConnection | null;
  projectPath?: string | null;
  onClose: () => void;
  onSubmit: (input: CreateDatabaseConnectionInput) => Promise<void>;
  onTest: (input: CreateDatabaseConnectionInput) => Promise<{ ok: boolean; version?: string; error?: string }>;
}

export function ConnectionModal({
  initialConnection,
  projectPath,
  onClose,
  onSubmit,
  onTest
}: ConnectionModalProps) {
  const [engine, setEngine] = useState<DatabaseEngine>(initialConnection?.engine || "POSTGRES");
  const [name, setName] = useState(initialConnection?.name || "");
  const [host, setHost] = useState(initialConnection?.host || "127.0.0.1");
  const [port, setPort] = useState<number>(initialConnection?.port || 5432);
  const [database, setDatabase] = useState(initialConnection?.database || "postgres");
  const [username, setUsername] = useState(initialConnection?.username || "postgres");
  const [password, setPassword] = useState("");
  const [ssl, setSsl] = useState(Boolean(initialConnection?.ssl));
  const [filename, setFilename] = useState(initialConnection?.filename || "");

  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; version?: string; error?: string } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!initialConnection) {
      if (engine === "POSTGRES") {
        setPort(5432);
        if (database === "mysql") setDatabase("postgres");
        if (username === "root") setUsername("postgres");
      } else if (engine === "MYSQL") {
        setPort(3306);
        if (database === "postgres") setDatabase("mysql");
        if (username === "postgres") setUsername("root");
      }
    }
  }, [engine, initialConnection]);

  const handleTest = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const res = await onTest({
        name: name || "Test",
        engine,
        projectPath,
        host,
        port,
        database,
        username,
        password: password || undefined,
        ssl,
        filename
      });
      setTestResult(res);
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setIsTesting(false);
    }
  };

  const handleSave = async () => {
    if (!name.trim()) return;
    setIsSubmitting(true);
    try {
      await onSubmit({
        name: name.trim(),
        engine,
        projectPath,
        host: engine !== "SQLITE" ? host : undefined,
        port: engine !== "SQLITE" ? port : undefined,
        database: engine !== "SQLITE" ? database : undefined,
        username: engine !== "SQLITE" ? username : undefined,
        password: password || undefined,
        ssl: engine !== "SQLITE" ? ssl : undefined,
        filename: engine === "SQLITE" ? filename : undefined
      });
      onClose();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to save connection");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="db-modal-overlay">
      <div className="db-modal">
        <div className="db-modal-header">
          <span>{initialConnection ? "Edit Connection" : "New Database Connection"}</span>
          <button className="db-crumb-btn" onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div className="db-modal-body">
          {/* Engine Selector */}
          <div className="db-form-group">
            <label className="db-form-label">Database Engine</label>
            <div style={{ display: "flex", gap: 8 }}>
              {(["POSTGRES", "MYSQL", "SQLITE"] as const).map((eng) => (
                <button
                  key={eng}
                  type="button"
                  className={`db-btn ${engine === eng ? "db-btn-primary" : ""}`}
                  style={{ flex: 1, justifyContent: "center" }}
                  onClick={() => setEngine(eng)}
                >
                  {eng === "POSTGRES" ? "PostgreSQL" : eng === "MYSQL" ? "MySQL / MariaDB" : "SQLite"}
                </button>
              ))}
            </div>
          </div>

          {/* Connection Name */}
          <div className="db-form-group">
            <label className="db-form-label">Connection Name</label>
            <input
              type="text"
              className="db-input"
              placeholder="e.g. Production DB, Main SQLite"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {engine === "SQLITE" ? (
            <div className="db-form-group">
              <label className="db-form-label">Database File Path</label>
              <input
                type="text"
                className="db-input"
                placeholder="/opt/spaceapp/data.sqlite or ./app.db"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
              />
              <span style={{ fontSize: "0.72rem", color: "var(--modern-faint)" }}>
                Absolute path or relative to project workspace.
              </span>
            </div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 8 }}>
                <div className="db-form-group" style={{ flex: 3 }}>
                  <label className="db-form-label">Host</label>
                  <input
                    type="text"
                    className="db-input"
                    placeholder="127.0.0.1 or db.example.com"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                  />
                </div>
                <div className="db-form-group" style={{ flex: 1 }}>
                  <label className="db-form-label">Port</label>
                  <input
                    type="number"
                    className="db-input"
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value))}
                  />
                </div>
              </div>

              <div className="db-form-group">
                <label className="db-form-label">Database Name</label>
                <input
                  type="text"
                  className="db-input"
                  value={database}
                  onChange={(e) => setDatabase(e.target.value)}
                />
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <div className="db-form-group" style={{ flex: 1 }}>
                  <label className="db-form-label">Username</label>
                  <input
                    type="text"
                    className="db-input"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                  />
                </div>
                <div className="db-form-group" style={{ flex: 1 }}>
                  <label className="db-form-label">Password</label>
                  <input
                    type="password"
                    className="db-input"
                    placeholder={initialConnection ? "(unchanged)" : "Password..."}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
              </div>

              <SpaceToggle
                id="db_ssl"
                label="Enable SSL / TLS encryption"
                checked={ssl}
                onChange={setSsl}
              />
            </>
          )}

          {/* Test Status Feedback */}
          {testResult && (
            <div
              style={{
                padding: "8px 12px",
                borderRadius: 6,
                fontSize: "0.8rem",
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: testResult.ok ? "rgba(16, 185, 129, 0.15)" : "rgba(239, 68, 68, 0.15)",
                color: testResult.ok ? "var(--modern-success, #10b981)" : "var(--modern-danger, #ef4444)"
              }}
            >
              {testResult.ok ? <Check size={14} /> : <CircleAlert size={14} />}
              <span>{testResult.ok ? `Connection verified! (${testResult.version || "OK"})` : `Connection failed: ${testResult.error}`}</span>
            </div>
          )}
        </div>

        <div className="db-modal-footer">
          <button
            type="button"
            className="db-btn"
            onClick={handleTest}
            disabled={isTesting || !name.trim()}
          >
            {isTesting && <RefreshCw size={12} className="spin" />}
            <span>Test Connection</span>
          </button>
          <button type="button" className="db-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="db-btn db-btn-primary"
            onClick={handleSave}
            disabled={isSubmitting || !name.trim()}
          >
            {isSubmitting ? "Saving..." : "Save Connection"}
          </button>
        </div>
      </div>
    </div>
  );
}
