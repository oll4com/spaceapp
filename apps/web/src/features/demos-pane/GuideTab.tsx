import { useEffect, useMemo, useState } from "react";
import type { DemoVariantFile } from "@space/contracts";
import { api } from "../../api.js";

interface GuideTabProps {
  projectId: string;
  variantId: string;
  onSelectFile: (filePath: string) => void;
  onNotice: (notice: { tone: "ok" | "error" | "warn"; message: string } | null) => void;
}

export function GuideTab({ projectId, variantId, onSelectFile, onNotice }: GuideTabProps) {
  const [files, setFiles] = useState<DemoVariantFile[]>([]);
  const [workspacePath, setWorkspacePath] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api
      .demoVariantFiles(variantId, projectId)
      .then((payload) => {
        if (cancelled) return;
        setFiles(payload.files);
        setWorkspacePath(payload.workspacePath);
      })
      .catch((error) => onNotice({ tone: "error", message: error instanceof Error ? error.message : "Could not list files for LOC metrics." }))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onNotice, projectId, variantId]);

  const metrics = useMemo(() => {
    let totalLines = 0;
    let serverLines = 0;
    let webLines = 0;
    let configDocsLines = 0;
    let totalBytes = 0;

    for (const file of files) {
      const lines = file.lines ?? 0;
      totalLines += lines;
      totalBytes += file.bytes;
      if (file.group === "server") {
        serverLines += lines;
      } else if (file.group === "web") {
        webLines += lines;
      } else {
        configDocsLines += lines;
      }
    }

    return {
      totalLines,
      serverLines,
      webLines,
      configDocsLines,
      totalBytes,
      fileCount: files.length
    };
  }, [files]);

  return (
    <div className="demos-guide-wrap">
      {/* Live LOC & Codebase Metrics Section */}
      <div className="demos-card">
        <div className="demos-row spread">
          <div>
            <h3>Live Codebase Metrics (LOC Counter)</h3>
            <p className="demos-muted" style={{ margin: "4px 0 0" }}>
              Exact real-time line count computed directly from the active template source files on disk.
            </p>
          </div>
          <span className="demos-muted" style={{ fontSize: "12px" }}>
            {workspacePath ? `Path: ${workspacePath}` : ""}
          </span>
        </div>

        {loading ? (
          <p className="demos-muted" style={{ marginTop: 12 }}>Reading live source metrics…</p>
        ) : (
          <>
            <div className="demos-metrics-grid" style={{ marginTop: 12 }}>
              <div className="demos-metric-card highlight">
                <span className="demos-metric-card-label">TOTAL LINES OF CODE</span>
                <span className="demos-metric-card-value">{metrics.totalLines.toLocaleString()}</span>
                <span className="demos-metric-card-sub">across {metrics.fileCount} source files</span>
              </div>
              <div className="demos-metric-card">
                <span className="demos-metric-card-label">BACKEND (NODE.JS)</span>
                <span className="demos-metric-card-value">{metrics.serverLines.toLocaleString()}</span>
                <span className="demos-metric-card-sub">
                  {metrics.totalLines > 0 ? Math.round((metrics.serverLines / metrics.totalLines) * 100) : 0}% of codebase
                </span>
              </div>
              <div className="demos-metric-card">
                <span className="demos-metric-card-label">FRONTEND (REACT)</span>
                <span className="demos-metric-card-value">{metrics.webLines.toLocaleString()}</span>
                <span className="demos-metric-card-sub">
                  {metrics.totalLines > 0 ? Math.round((metrics.webLines / metrics.totalLines) * 100) : 0}% of codebase
                </span>
              </div>
              <div className="demos-metric-card">
                <span className="demos-metric-card-label">CONFIG & DOCS</span>
                <span className="demos-metric-card-value">{metrics.configDocsLines.toLocaleString()}</span>
                <span className="demos-metric-card-sub">
                  {metrics.totalLines > 0 ? Math.round((metrics.configDocsLines / metrics.totalLines) * 100) : 0}% of codebase
                </span>
              </div>
            </div>

            <div style={{ marginTop: 16 }}>
              <h4 style={{ margin: "0 0 8px" }}>Source Files Breakdown (Click to inspect)</h4>
              <div className="demos-guide-files-table-wrap">
                <table className="demos-table">
                  <thead>
                    <tr>
                      <th>File Path</th>
                      <th>Layer</th>
                      <th style={{ textAlign: "right" }}>Lines of Code</th>
                      <th style={{ textAlign: "right" }}>Size</th>
                      <th style={{ textAlign: "right" }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {files.map((file) => (
                      <tr key={file.path}>
                        <td className="demos-mono" style={{ fontWeight: 500 }}>
                          {file.path}
                        </td>
                        <td>
                          <span className={`demos-group-pill ${file.group}`}>
                            {file.group.toUpperCase()}
                          </span>
                        </td>
                        <td style={{ textAlign: "right", fontWeight: 600 }}>
                          <span className="demos-mono">{file.lines?.toLocaleString() ?? "—"}</span>
                        </td>
                        <td className="demos-muted" style={{ textAlign: "right" }}>
                          {Math.max(1, Math.round(file.bytes / 1024))} kB
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <button
                            type="button"
                            className="demos-ghost"
                            style={{ fontSize: "11px", padding: "2px 8px" }}
                            onClick={() => onSelectFile(file.path)}
                          >
                            Open in Code ↗
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Architecture & How It Connects */}
      <div className="demos-card">
        <h3>Architecture & Connectivity</h3>
        <p className="demos-muted" style={{ margin: "4px 0 12px" }}>
          Fullstack enterprise integration connecting the Space App environment with Salesforce CRM and Google Sheets.
        </p>

        <div className="demos-guide-columns">
          <div className="demos-guide-box">
            <div className="demos-guide-box-header">
              <span className="demos-provider-icon salesforce" />
              <strong>Salesforce Connected App</strong>
            </div>
            <p className="demos-guide-box-text">
              Connects using OAuth 2.0 Client Credentials or Authorization Code flow. Interacts with Salesforce REST APIs
              (<code>/services/data/v60.0/sobjects/Account</code> and <code>/sobjects/Contact</code>) to create, query, and verify CRM records.
            </p>
            <div className="demos-guide-badge-row">
              <span className="demos-badge-verified">OAuth 2.0</span>
              <span className="demos-badge-verified">REST API</span>
              <span className="demos-badge-verified">AES-256 Encrypted</span>
            </div>
          </div>

          <div className="demos-guide-box">
            <div className="demos-guide-box-header">
              <span className="demos-provider-icon google-sheets" />
              <strong>Google Sheets API v4</strong>
            </div>
            <p className="demos-guide-box-text">
              Authenticates through Google Cloud OAuth 2.0 with the <code>spreadsheets</code> scope. Appends records into the destination sheet
              with automatic header validation and idempotency checks to prevent duplicate entries.
            </p>
            <div className="demos-guide-badge-row">
              <span className="demos-badge-verified">Google Cloud OAuth</span>
              <span className="demos-badge-verified">Sheets API v4</span>
              <span className="demos-badge-verified">Auto Provisioning</span>
            </div>
          </div>

          <div className="demos-guide-box">
            <div className="demos-guide-box-header">
              <span style={{ fontSize: "16px" }}>🔒</span>
              <strong>Server-Side Security Guarantee</strong>
            </div>
            <p className="demos-guide-box-text">
              Zero secret exposure to the browser. Client secrets, OAuth tokens, and refresh credentials are encrypted at rest using AES-256
              in the Space database. The UI only ever receives status booleans and metadata.
            </p>
            <div className="demos-guide-badge-row">
              <span className="demos-badge-verified">Zero Leaks</span>
              <span className="demos-badge-verified">Encrypted at Rest</span>
            </div>
          </div>
        </div>
      </div>

      {/* Capabilities & Enterprise Features */}
      <div className="demos-card">
        <h3>Capabilities & Execution Features</h3>
        <p className="demos-muted" style={{ margin: "4px 0 12px" }}>
          Key operational capabilities built into the demo pipeline.
        </p>

        <div className="demos-guide-features-grid">
          <div className="demos-feature-item">
            <h4>Dual Runtime Modes: Sample vs Live</h4>
            <p className="demos-muted">
              <strong>Sample Mode</strong> runs locally with isolated mock data—making 0 external network calls for instant developer testing.
              <strong>Live Mode</strong> communicates in real time with external Salesforce and Google cloud endpoints.
            </p>
          </div>

          <div className="demos-feature-item">
            <h4>Idempotent Pipeline & Duplicate Protection</h4>
            <p className="demos-muted">
              Every operation carries an <code>operationKey</code>. If a sync operation is retried or repeated, the system checks whether the
              Account or Spreadsheet row already exists before writing, guaranteeing that no duplicates are generated.
            </p>
          </div>

          <div className="demos-feature-item">
            <h4>Multi-Step Synchronization Ledger</h4>
            <p className="demos-muted">
              Each CRM transaction executes through a 3-step sequence: <code>salesforce-account</code> → <code>salesforce-contact</code> →
              <code>google-sheets-row</code>. Every step is tracked individually with status badges in the Ledger.
            </p>
          </div>

          <div className="demos-feature-item">
            <h4>Automatic & Manual Failure Retries</h4>
            <p className="demos-muted">
              If a network interruption occurs midway (e.g. Google Sheets API rate-limit), the operation enters a <code>PARTIAL</code> or
              <code>FAILED</code> state. Clicking <strong>Retry</strong> re-executes only the failed step without re-creating prior objects.
            </p>
          </div>
        </div>
      </div>

      {/* Button Action Catalog */}
      <div className="demos-card">
        <h3>Button Action Catalog (What Every Button Does)</h3>
        <p className="demos-muted" style={{ margin: "4px 0 12px" }}>
          Comprehensive reference guide for all controls available across the demo interface.
        </p>

        <div className="demos-guide-buttons-catalog">
          <div className="demos-button-doc-category">
            <h4>Header & Lifecycle Controls</h4>
            <div className="demos-button-doc-list">
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-btn-start">▶ Start Demo</span>
                <div className="demos-button-doc-desc">
                  <strong>Launches the child Node.js process:</strong> Binds an ephemeral local port, initializes the Express backend and React
                  preview frontend, and monitors health checks until the service reports Healthy.
                </div>
              </div>
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-btn-stop">⏹ Stop Demo</span>
                <div className="demos-button-doc-desc">
                  <strong>Terminates the running process:</strong> Sends graceful SIGTERM/SIGKILL signals, releases the occupied network port,
                  and updates the state to STOPPED.
                </div>
              </div>
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-ghost">↻ Restart</span>
                <div className="demos-button-doc-desc">
                  <strong>Recycles the instance:</strong> Performs a clean shutdown followed immediately by a fresh boot with the currently
                  selected project and stack variant.
                </div>
              </div>
            </div>
          </div>

          <div className="demos-button-doc-category">
            <h4>Preview Frame Controls</h4>
            <div className="demos-button-doc-list">
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-ghost">↻ Reload</span>
                <div className="demos-button-doc-desc">
                  <strong>Refreshes the live preview iframe:</strong> Re-renders the client frame without restarting the underlying backend process.
                </div>
              </div>
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-ghost">Open preview ↗</span>
                <div className="demos-button-doc-desc">
                  <strong>Launches in a new browser tab:</strong> Opens the sandboxed web application directly in a dedicated full-sized window.
                </div>
              </div>
            </div>
          </div>

          <div className="demos-button-doc-category">
            <h4>Connections & OAuth Controls</h4>
            <div className="demos-button-doc-list">
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-ghost">Refresh status</span>
                <div className="demos-button-doc-desc">
                  <strong>Audits connection status:</strong> Checks token validity with Salesforce and Google, ensuring active sessions haven't expired.
                </div>
              </div>
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-primary">Connect / Reconnect</span>
                <div className="demos-button-doc-desc">
                  <strong>OAuth 2.0 Consent Flow:</strong> Opens the provider authorization window allowing you to grant account access.
                </div>
              </div>
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-ghost">Disconnect</span>
                <div className="demos-button-doc-desc">
                  <strong>Revokes access:</strong> Deletes stored OAuth access and refresh tokens from encrypted storage.
                </div>
              </div>
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-primary">Save settings</span>
                <div className="demos-button-doc-desc">
                  <strong>Stores API credentials:</strong> Encrypts your Client ID and Client Secret in AES-256 storage on the server.
                </div>
              </div>
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-primary">Save target</span>
                <div className="demos-button-doc-desc">
                  <strong>Binds destination sheet:</strong> Associates a Google Spreadsheet ID or URL with the synchronization engine.
                </div>
              </div>
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-ghost">Create spreadsheet</span>
                <div className="demos-button-doc-desc">
                  <strong>Auto-provisions Google Sheet:</strong> Uses the Google Sheets API to create a formatted spreadsheet titled "Space Demo Salesforce Sync" complete with header columns.
                </div>
              </div>
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-ghost">Verify read-back</span>
                <div className="demos-button-doc-desc">
                  <strong>Tests sheet connectivity:</strong> Executes a read request against the configured sheet to confirm read and write permissions.
                </div>
              </div>
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-link-button">Open in Google Sheets ↗</span>
                <div className="demos-button-doc-desc">
                  <strong>Opens spreadsheet directly:</strong> Navigates straight to the active Google Spreadsheet in a new browser tab.
                </div>
              </div>
            </div>
          </div>

          <div className="demos-button-doc-category">
            <h4>Ledger & Tests Controls</h4>
            <div className="demos-button-doc-list">
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-ghost">Retry</span>
                <div className="demos-button-doc-desc">
                  <strong>Retries failed pipeline step:</strong> Re-executes only the failed step of an operation without duplicating previous steps.
                </div>
              </div>
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-primary">Run checks</span>
                <div className="demos-button-doc-desc">
                  <strong>Integration test suite:</strong> Executes automated validation checks for upstream service health, OAuth tokens, and idempotency.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
