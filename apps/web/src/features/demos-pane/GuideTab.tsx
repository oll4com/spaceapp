import { useEffect, useMemo, useState } from "react";
import type { DemoVariantFile } from "@space/contracts";
import { api } from "../../api.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";

const GROUP_LABEL: Record<DemoVariantFile["group"], string> = { server: "SERVER", web: "WEB", config: "CONFIG", docs: "DOCS" };

/** Renders `code` and **bold** marks of an already translated sentence. */
function marked(text: string) {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((part, index) =>
    part.startsWith("`") ? <code key={index}>{part.slice(1, -1)}</code>
    : part.startsWith("**") ? <strong key={index}>{part.slice(2, -2)}</strong>
    : part
  );
}

interface GuideTabProps {
  projectId: string;
  variantId: string;
  onSelectFile: (filePath: string) => void;
  onNotice: (notice: { tone: "ok" | "error" | "warn"; message: string } | null) => void;
}

export function GuideTab({ projectId, variantId, onSelectFile, onNotice }: GuideTabProps) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
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
            <h3>{t("Live Codebase Metrics (LOC Counter)")}</h3>
            <p className="demos-muted" style={{ margin: "4px 0 0" }}>
              {t("Exact real-time line count computed directly from the active template source files on disk.")}
            </p>
          </div>
          <span className="demos-muted" style={{ fontSize: "12px" }}>
            {workspacePath ? t("Path: {path}", { path: workspacePath }) : ""}
          </span>
        </div>

        {loading ? (
          <p className="demos-muted" style={{ marginTop: 12 }}>{t("Reading live source metrics…")}</p>
        ) : (
          <>
            <div className="demos-metrics-grid" style={{ marginTop: 12 }}>
              <div className="demos-metric-card highlight">
                <span className="demos-metric-card-label">{t("TOTAL LINES OF CODE")}</span>
                <span className="demos-metric-card-value">{metrics.totalLines.toLocaleString()}</span>
                <span className="demos-metric-card-sub">{t("across {count} source files", { count: metrics.fileCount })}</span>
              </div>
              <div className="demos-metric-card">
                <span className="demos-metric-card-label">{t("BACKEND (NODE.JS)")}</span>
                <span className="demos-metric-card-value">{metrics.serverLines.toLocaleString()}</span>
                <span className="demos-metric-card-sub">
                  {t("{percent}% of codebase", { percent: metrics.totalLines > 0 ? Math.round((metrics.serverLines / metrics.totalLines) * 100) : 0 })}
                </span>
              </div>
              <div className="demos-metric-card">
                <span className="demos-metric-card-label">{t("FRONTEND (REACT)")}</span>
                <span className="demos-metric-card-value">{metrics.webLines.toLocaleString()}</span>
                <span className="demos-metric-card-sub">
                  {t("{percent}% of codebase", { percent: metrics.totalLines > 0 ? Math.round((metrics.webLines / metrics.totalLines) * 100) : 0 })}
                </span>
              </div>
              <div className="demos-metric-card">
                <span className="demos-metric-card-label">{t("CONFIG & DOCS")}</span>
                <span className="demos-metric-card-value">{metrics.configDocsLines.toLocaleString()}</span>
                <span className="demos-metric-card-sub">
                  {t("{percent}% of codebase", { percent: metrics.totalLines > 0 ? Math.round((metrics.configDocsLines / metrics.totalLines) * 100) : 0 })}
                </span>
              </div>
            </div>

            <div style={{ marginTop: 16 }}>
              <h4 style={{ margin: "0 0 8px" }}>{t("Source Files Breakdown (Click to inspect)")}</h4>
              <div className="demos-guide-files-table-wrap">
                <table className="demos-table">
                  <thead>
                    <tr>
                      <th>{t("File Path")}</th>
                      <th>{t("Layer")}</th>
                      <th style={{ textAlign: "right" }}>{t("Lines of Code")}</th>
                      <th style={{ textAlign: "right" }}>{t("Size")}</th>
                      <th style={{ textAlign: "right" }}>{t("Action")}</th>
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
                            {t(GROUP_LABEL[file.group])}
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
                            {t("Open in Code ↗")}
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
        <h3>{t("Architecture & Connectivity")}</h3>
        <p className="demos-muted" style={{ margin: "4px 0 12px" }}>
          {t("Fullstack enterprise integration connecting the Space App environment with Salesforce CRM and Google Sheets.")}
        </p>

        <div className="demos-guide-columns">
          <div className="demos-guide-box">
            <div className="demos-guide-box-header">
              <span className="demos-provider-icon salesforce" />
              <strong>{t("Salesforce Connected App")}</strong>
            </div>
            <p className="demos-guide-box-text">
              {marked(t("Connects using OAuth 2.0 Client Credentials or Authorization Code flow. Interacts with Salesforce REST APIs (`/services/data/v60.0/sobjects/Account` and `/sobjects/Contact`) to create, query, and verify CRM records."))}
            </p>
            <div className="demos-guide-badge-row">
              <span className="demos-badge-verified">{t("OAuth 2.0")}</span>
              <span className="demos-badge-verified">{t("REST API")}</span>
              <span className="demos-badge-verified">{t("AES-256 Encrypted")}</span>
            </div>
          </div>

          <div className="demos-guide-box">
            <div className="demos-guide-box-header">
              <span className="demos-provider-icon google-sheets" />
              <strong>{t("Google Sheets API v4")}</strong>
            </div>
            <p className="demos-guide-box-text">
              {marked(t("Authenticates through Google Cloud OAuth 2.0 with the `spreadsheets` scope. Appends records into the destination sheet with automatic header validation and idempotency checks to prevent duplicate entries."))}
            </p>
            <div className="demos-guide-badge-row">
              <span className="demos-badge-verified">{t("Google Cloud OAuth")}</span>
              <span className="demos-badge-verified">{t("Sheets API v4")}</span>
              <span className="demos-badge-verified">{t("Auto Provisioning")}</span>
            </div>
          </div>

          <div className="demos-guide-box">
            <div className="demos-guide-box-header">
              <span style={{ fontSize: "16px" }}>🔒</span>
              <strong>{t("Server-Side Security Guarantee")}</strong>
            </div>
            <p className="demos-guide-box-text">
              {t("Zero secret exposure to the browser. Client secrets, OAuth tokens, and refresh credentials are encrypted at rest using AES-256 in the Space database. The UI only ever receives status booleans and metadata.")}
            </p>
            <div className="demos-guide-badge-row">
              <span className="demos-badge-verified">{t("Zero Leaks")}</span>
              <span className="demos-badge-verified">{t("Encrypted at Rest")}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Capabilities & Enterprise Features */}
      <div className="demos-card">
        <h3>{t("Capabilities & Execution Features")}</h3>
        <p className="demos-muted" style={{ margin: "4px 0 12px" }}>
          {t("Key operational capabilities built into the demo pipeline.")}
        </p>

        <div className="demos-guide-features-grid">
          <div className="demos-feature-item">
            <h4>{t("Dual Runtime Modes: Sample vs Live")}</h4>
            <p className="demos-muted">
              {marked(t("**Sample Mode** runs locally with isolated mock data—making 0 external network calls for instant developer testing. **Live Mode** communicates in real time with external Salesforce and Google cloud endpoints."))}
            </p>
          </div>

          <div className="demos-feature-item">
            <h4>{t("Idempotent Pipeline & Duplicate Protection")}</h4>
            <p className="demos-muted">
              {marked(t("Every operation carries an `operationKey`. If a sync operation is retried or repeated, the system checks whether the Account or Spreadsheet row already exists before writing, guaranteeing that no duplicates are generated."))}
            </p>
          </div>

          <div className="demos-feature-item">
            <h4>{t("Multi-Step Synchronization Ledger")}</h4>
            <p className="demos-muted">
              {marked(t("Each CRM transaction executes through a 3-step sequence: `salesforce-account` → `salesforce-contact` → `google-sheets-row`. Every step is tracked individually with status badges in the Ledger."))}
            </p>
          </div>

          <div className="demos-feature-item">
            <h4>{t("Automatic & Manual Failure Retries")}</h4>
            <p className="demos-muted">
              {marked(t("If a network interruption occurs midway (e.g. Google Sheets API rate-limit), the operation enters a `PARTIAL` or `FAILED` state. Clicking **Retry** re-executes only the failed step without re-creating prior objects."))}
            </p>
          </div>
        </div>
      </div>

      {/* Button Action Catalog */}
      <div className="demos-card">
        <h3>{t("Button Action Catalog (What Every Button Does)")}</h3>
        <p className="demos-muted" style={{ margin: "4px 0 12px" }}>
          {t("Comprehensive reference guide for all controls available across the demo interface.")}
        </p>

        <div className="demos-guide-buttons-catalog">
          <div className="demos-button-doc-category">
            <h4>{t("Header & Lifecycle Controls")}</h4>
            <div className="demos-button-doc-list">
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-btn-start">{t("▶ Start Demo")}</span>
                <div className="demos-button-doc-desc">
                  {marked(t("**Launches the child Node.js process:** Binds an ephemeral local port, initializes the Express backend and React preview frontend, and monitors health checks until the service reports Healthy."))}
                </div>
              </div>
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-btn-stop">{t("⏹ Stop Demo")}</span>
                <div className="demos-button-doc-desc">
                  {marked(t("**Terminates the running process:** Sends graceful SIGTERM/SIGKILL signals, releases the occupied network port, and updates the state to STOPPED."))}
                </div>
              </div>
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-ghost">{t("↻ Restart")}</span>
                <div className="demos-button-doc-desc">
                  {marked(t("**Recycles the instance:** Performs a clean shutdown followed immediately by a fresh boot with the currently selected project and stack variant."))}
                </div>
              </div>
            </div>
          </div>

          <div className="demos-button-doc-category">
            <h4>{t("Preview Frame Controls")}</h4>
            <div className="demos-button-doc-list">
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-ghost">{t("↻ Reload")}</span>
                <div className="demos-button-doc-desc">
                  {marked(t("**Refreshes the live preview iframe:** Re-renders the client frame without restarting the underlying backend process."))}
                </div>
              </div>
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-ghost">{t("Open preview ↗")}</span>
                <div className="demos-button-doc-desc">
                  {marked(t("**Launches in a new browser tab:** Opens the sandboxed web application directly in a dedicated full-sized window."))}
                </div>
              </div>
            </div>
          </div>

          <div className="demos-button-doc-category">
            <h4>{t("Connections & OAuth Controls")}</h4>
            <div className="demos-button-doc-list">
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-ghost">{t("Refresh status")}</span>
                <div className="demos-button-doc-desc">
                  {marked(t("**Audits connection status:** Checks token validity with Salesforce and Google, ensuring active sessions haven't expired."))}
                </div>
              </div>
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-primary">{t("Connect / Reconnect")}</span>
                <div className="demos-button-doc-desc">
                  {marked(t("**OAuth 2.0 Consent Flow:** Opens the provider authorization window allowing you to grant account access."))}
                </div>
              </div>
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-ghost">{t("Disconnect")}</span>
                <div className="demos-button-doc-desc">
                  {marked(t("**Revokes access:** Deletes stored OAuth access and refresh tokens from encrypted storage."))}
                </div>
              </div>
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-primary">{t("Save settings")}</span>
                <div className="demos-button-doc-desc">
                  {marked(t("**Stores API credentials:** Encrypts your Client ID and Client Secret in AES-256 storage on the server."))}
                </div>
              </div>
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-primary">{t("Save target")}</span>
                <div className="demos-button-doc-desc">
                  {marked(t("**Binds destination sheet:** Associates a Google Spreadsheet ID or URL with the synchronization engine."))}
                </div>
              </div>
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-ghost">{t("Create spreadsheet")}</span>
                <div className="demos-button-doc-desc">
                  {marked(t("**Auto-provisions Google Sheet:** Uses the Google Sheets API to create a formatted spreadsheet titled \"Space Demo Salesforce Sync\" complete with header columns."))}
                </div>
              </div>
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-ghost">{t("Verify read-back")}</span>
                <div className="demos-button-doc-desc">
                  {marked(t("**Tests sheet connectivity:** Executes a read request against the configured sheet to confirm read and write permissions."))}
                </div>
              </div>
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-link-button">{t("Open in Google Sheets ↗")}</span>
                <div className="demos-button-doc-desc">
                  {marked(t("**Opens spreadsheet directly:** Navigates straight to the active Google Spreadsheet in a new browser tab."))}
                </div>
              </div>
            </div>
          </div>

          <div className="demos-button-doc-category">
            <h4>{t("Ledger & Tests Controls")}</h4>
            <div className="demos-button-doc-list">
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-ghost">{t("Retry")}</span>
                <div className="demos-button-doc-desc">
                  {marked(t("**Retries failed pipeline step:** Re-executes only the failed step of an operation without duplicating previous steps."))}
                </div>
              </div>
              <div className="demos-button-doc-item">
                <span className="demos-doc-btn-preview demos-primary">{t("Run checks")}</span>
                <div className="demos-button-doc-desc">
                  {marked(t("**Integration test suite:** Executes automated validation checks for upstream service health, OAuth tokens, and idempotency."))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
