import React, { useState, useRef } from "react";
import {
  Download,
  Upload,
  FileJson,
  CheckCircle2,
  CircleAlert,
  RefreshCw,
  Layers,
  Bookmark,
  ClipboardList,
  SlidersHorizontal,
  Server,
  Key,
  Lock
} from "../ui-theme/app-icons.js";
import { api, type ConfigurationCliLogin, type ConfigurationInspectResult } from "../../api.js";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import type { SpaceConfigBundle, ImportConfigResult, ImportConfigMode } from "@space/contracts";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { useDockConfirm } from "../dock-kit/DockKit.js";
import "./configuration-migration.css";

const cliAuthReasons: Record<string, string> = {
  "not-selected": "not selected",
  "not-supported-on-target": "this CLI's login cannot be moved; sign in on this computer",
  "rejected-file-name": "rejected: the backup holds an unexpected file",
  "cannot-write-as-runtime-user": "this installation cannot write the CLI's login; sign in on this computer",
  "cli-home-not-reachable": "the CLI's home is not reachable from the Space server; update the installation and import again",
  "unreadable-login-file": "the login in the backup is damaged",
  "not-a-regular-file": "the existing login is not a regular file",
  "already-logged-in": "already signed in here",
  "write-failed": "the login could not be written"
};
const rotationWarning = "Using the same login on two installations can sign one of them out when the other refreshes its token. If that happens, sign in again there.";
const minPassphraseLength = 12;

export function ConfigurationMigrationCard({ canManageInstallation = false }: { canManageInstallation?: boolean }) {
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [includeApiKeys, setIncludeApiKeys] = useState(false);
  const [includeCredentials, setIncludeCredentials] = useState(false);
  const [cliLogins, setCliLogins] = useState<ConfigurationCliLogin[] | null>(null);
  const [exportRuntimes, setExportRuntimes] = useState<string[]>([]);
  const [exportPassphrase, setExportPassphrase] = useState("");
  const [exportPassphraseConfirm, setExportPassphraseConfirm] = useState("");

  // Merge adds; Replace deletes rooms, links, clipboard and tasks first, so it is never the default (Record Retention Invariant).
  const [importMode, setImportMode] = useState<ImportConfigMode>("merge");
  const { confirm, confirmDialog } = useDockConfirm();
  const [importApiKeys, setImportApiKeys] = useState(true);
  const [importCredentials, setImportCredentials] = useState(true);
  const [importPassphrase, setImportPassphrase] = useState("");
  const [importRuntimes, setImportRuntimes] = useState<string[]>([]);
  const [cliAuthConflict, setCliAuthConflict] = useState<"backup-and-replace" | "skip-if-logged-in">("backup-and-replace");
  const [projectFolder, setProjectFolder] = useState("");
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [isInspecting, setIsInspecting] = useState(false);
  const [inspection, setInspection] = useState<ConfigurationInspectResult | null>(null);
  const [rawBundle, setRawBundle] = useState<SpaceConfigBundle | null>(null);

  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportConfigResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const exportsSecrets = canManageInstallation && (includeApiKeys || includeCredentials);
  const passphraseProblem = !exportsSecrets ? null
    : exportPassphrase.length < minPassphraseLength ? `Enter a passphrase of at least ${minPassphraseLength} characters.`
      : exportPassphrase !== exportPassphraseConfirm ? "The two passphrases do not match." : null;

  const toggleIncludeCredentials = (next: boolean) => {
    setIncludeCredentials(next);
    if (!next || cliLogins) return;
    void Promise.resolve().then(() => api.configurationCliLogins()).then(({ items }) => {
      setCliLogins(items);
      setExportRuntimes(items.filter((login) => login.exportable && login.loggedIn).map((login) => login.runtimeId));
    }, (err: unknown) => setExportError(err instanceof Error ? err.message : "Could not read the CLI logins."));
  };

  const handleExport = async () => {
    if (passphraseProblem) {
      setExportError(passphraseProblem);
      return;
    }
    setIsExporting(true);
    setExportError(null);
    setExportNote(null);
    try {
      const bundle = await api.exportConfiguration({
        includeApiKeys: canManageInstallation && includeApiKeys,
        includeCredentials: canManageInstallation && includeCredentials,
        ...(exportsSecrets ? { passphrase: exportPassphrase } : {}),
        ...(canManageInstallation && includeCredentials ? { cliAuthRuntimes: exportRuntimes } : {})
      });
      const blob = new Blob([JSON.stringify(bundle, null, 2)], {
        type: "application/json;charset=utf-8"
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const dateStr = new Date().toISOString().slice(0, 10);
      anchor.href = url;
      // A file with secrets is not .json, so viewers and previews do not open it by accident.
      anchor.download = bundle.encrypted ? `spaceapp-config-${bundle.source.instance}-${dateStr}.spaceapp` : `spaceapp-config-${dateStr}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      const included = bundle.sections?.cliAuth?.runtimes ?? [];
      const missing = includeCredentials ? exportRuntimes.filter((runtimeId) => !included.includes(runtimeId)) : [];
      if (missing.length) setExportNote(`No login file was found for ${missing.join(", ")}; those CLIs need a sign-in on the new computer.`);
      setExportPassphrase("");
      setExportPassphraseConfirm("");
    } catch (err: unknown) {
      setExportError(err instanceof Error ? err.message : "Failed to export configuration.");
    } finally {
      setIsExporting(false);
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => inspectFile(event.target.files?.[0]);

  const inspectFile = async (file: File | undefined) => {
    if (!file) return;

    setSelectedFileName(file.name);
    setInspection(null);
    setRawBundle(null);
    setImportError(null);
    setImportResult(null);
    setIsInspecting(true);

    try {
      const text = await file.text();
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(text);
      } catch {
        throw new Error("Selected file is not valid JSON.");
      }

      const inspectRes = await api.inspectConfiguration(parsedJson);
      if (!inspectRes.valid) {
        throw new Error("This file is not a SpaceApp backup.");
      }

      setInspection(inspectRes);
      setImportRuntimes(inspectRes.secrets?.cliAuthRuntimes ?? []);
      setProjectFolder("");
      setRawBundle(parsedJson as SpaceConfigBundle);
    } catch (err: unknown) {
      setImportError(err instanceof Error ? err.message : "Failed to parse configuration file.");
    } finally {
      setIsInspecting(false);
    }
  };

  const handleImport = async () => {
    if (!canManageInstallation || !rawBundle) return;
    const confirmReplace = importMode === "replace";
    if (confirmReplace && !await confirm({ title: "Replace everything?", message: "Your current rooms, panes, links, clipboard items, plans and tasks will be deleted, then the backup is set up. This cannot be undone.", confirmLabel: "Replace everything" })) return;
    setIsImporting(true);
    setImportError(null);
    try {
      const missingRoot = inspection?.missingProjectRoots?.[0];
      const res = await api.importConfiguration({
        bundle: rawBundle,
        mode: importMode,
        ...(confirmReplace ? { confirmReplace } : {}),
        importApiKeys,
        importCredentials,
        ...(inspection?.secrets?.encrypted && importPassphrase ? { passphrase: importPassphrase } : {}),
        ...(inspection?.secrets?.cliAuthRuntimes?.length ? { cliAuthRuntimes: importRuntimes, cliAuthConflict } : {}),
        ...(missingRoot && projectFolder.trim() ? { pathRewrite: { from: missingRoot, to: projectFolder.trim() } } : {})
      });
      setImportPassphrase("");
      setImportResult(res);
    } catch (err: unknown) {
      setImportError(err instanceof Error ? err.message : "Failed to import configuration.");
    } finally {
      setIsImporting(false);
    }
  };

  const handleReload = () => {
    getSpaceRuntime().platform.reloadPage();
  };

  return (
    <div className="config-migration-card" aria-label="Configuration backup and migration">
      {/* Export Section */}
      <div className="config-migration-section">
        <div className="config-migration-section-header">
          <div className="config-migration-section-title">
            <Download size={18} aria-hidden="true" />
            <span>Save a backup</span>
          </div>
        </div>
        <p className="config-migration-desc">
          Download one file with your rooms, panes, preferences, bookmarks, plans and CLI defaults.
        </p>

        {canManageInstallation ? <div className="config-migration-options-group">
          <SpaceToggle
            className="config-migration-toggle-row"
            name="export-include-api-keys"
            ariaLabel="Include Provider API Keys"
            label={
              <span className="config-migration-toggle-title">
                <Key size={14} color="#f59e0b" />
                <span>Include Provider API Keys</span>
                <span className="config-migration-badge sensitive">Sensitive</span>
              </span>
            }
            detail="Adds your AI service keys (OpenAI, Anthropic, DeepSeek and others) to the file. Keep the file private."
            checked={includeApiKeys}
            disabled={isExporting}
            onChange={setIncludeApiKeys}
          />

          <SpaceToggle
            className="config-migration-toggle-row"
            name="export-include-credentials"
            ariaLabel="Include CLI logins"
            label={
              <span className="config-migration-toggle-title">
                <Lock size={14} color="#f59e0b" />
                <span>Include CLI logins</span>
                <span className="config-migration-badge sensitive">Sensitive</span>
              </span>
            }
            detail="Adds the sign-ins of the AI coding tools you pick below, so they start signed in on the other computer."
            checked={includeCredentials}
            disabled={isExporting}
            onChange={toggleIncludeCredentials}
          />

          {includeCredentials && cliLogins ? (
            <fieldset className="config-migration-check-list" aria-label="CLI logins to export">
              {cliLogins.map((login) => {
                const available = login.exportable && login.loggedIn;
                return (
                  <SpaceToggle
                    key={login.runtimeId}
                    compact
                    className="config-migration-check-row"
                    label={login.displayName}
                    detail={!login.exportable ? "not exportable" : login.loggedIn ? "signed in" : "not signed in"}
                    checked={available && exportRuntimes.includes(login.runtimeId)}
                    disabled={!available || isExporting}
                    onChange={(checked) => setExportRuntimes((current) => checked
                      ? [...current, login.runtimeId]
                      : current.filter((runtimeId) => runtimeId !== login.runtimeId))}
                  />
                );
              })}
            </fieldset>
          ) : null}

          {exportsSecrets ? (
            <div className="config-migration-fields">
              <label className="config-migration-field">
                <span>Passphrase (at least {minPassphraseLength} characters)</span>
                <input type="password" autoComplete="new-password" value={exportPassphrase} disabled={isExporting}
                  onChange={(event) => setExportPassphrase(event.target.value)} />
              </label>
              <label className="config-migration-field">
                <span>Confirm passphrase</span>
                <input type="password" autoComplete="new-password" value={exportPassphraseConfirm} disabled={isExporting}
                  onChange={(event) => setExportPassphraseConfirm(event.target.value)} />
              </label>
              <p className="config-migration-alert warn">
                The keys and logins are encrypted with this passphrase. Anyone who has the file and the passphrase can use your accounts.
              </p>
            </div>
          ) : null}
        </div> : <p className="config-migration-desc">Import and secret exports require ADMIN or OPERATOR access.</p>}

        {exportError ? (
          <div className="config-migration-alert bad" role="alert">
            <CircleAlert size={16} />
            <span>{exportError}</span>
          </div>
        ) : null}
        {exportNote ? <div className="config-migration-alert warn" role="status">{exportNote}</div> : null}

        <div className="config-migration-actions">
          <button
            type="button"
            className="config-migration-btn primary"
            onClick={() => void handleExport()}
            disabled={isExporting}
          >
            {isExporting ? <RefreshCw size={16} className="spin" /> : <Download size={16} />}
            <span>{isExporting ? "Exporting..." : "Download backup file"}</span>
          </button>
        </div>
      </div>

      {/* Import Section */}
      {canManageInstallation ? <div className="config-migration-section">
        <div className="config-migration-section-header">
          <div className="config-migration-section-title">
            <Upload size={18} aria-hidden="true" />
            <span>Restore from a backup</span>
          </div>
        </div>
        <p className="config-migration-desc">
          Load a backup file saved here or on another Space.
        </p>

        {/* Mode Selector */}
        <div className="config-migration-mode-selector">
          <label className={`config-migration-mode-option ${importMode === "replace" ? "selected" : ""}`}>
            <input
              type="radio"
              name="config-import-mode"
              value="replace"
              checked={importMode === "replace"}
              onChange={() => setImportMode("replace")}
              disabled={isImporting}
            />
            <div className="config-migration-mode-info">
              <strong>Replace everything</strong>
              <small>Deletes your current rooms, panes, links, clipboard and tasks, then sets everything up exactly as in the backup. You confirm before anything is deleted.</small>
            </div>
          </label>

          <label className={`config-migration-mode-option ${importMode === "merge" ? "selected" : ""}`}>
            <input
              type="radio"
              name="config-import-mode"
              value="merge"
              checked={importMode === "merge"}
              onChange={() => setImportMode("merge")}
              disabled={isImporting}
            />
            <div className="config-migration-mode-info">
              <strong>Merge with what I have</strong>
              <small>Keeps your current rooms, panes and bookmarks and adds the ones from the backup.</small>
            </div>
          </label>
        </div>

        {/* File Dropzone */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.spaceapp,application/json"
          className="config-migration-file-input"
          onChange={(e) => void handleFileChange(e)}
        />

        <div
          className="config-migration-dropzone"
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void inspectFile(e.dataTransfer.files?.[0]);
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              fileInputRef.current?.click();
            }
          }}
        >
          <FileJson size={32} color="var(--text-muted, #888)" />
          <div>
            <strong>{selectedFileName ? selectedFileName : "Choose a backup file (.json or .spaceapp)"}</strong>
            <p className="config-migration-desc">Click to browse, or drop the file here.</p>
          </div>
        </div>

        {isInspecting ? (
          <div className="config-migration-meta">
            <RefreshCw size={14} className="spin" />
            <span>Checking the backup file…</span>
          </div>
        ) : null}

        {importError ? (
          <div className="config-migration-alert bad" role="alert">
            <CircleAlert size={16} />
            <span>{importError}</span>
          </div>
        ) : null}

        {/* Inspection Preview */}
        {inspection && !importResult ? (
          <div className="config-migration-preview">
            <div className="config-migration-meta">
              <span>Source: <strong>{inspection.source.instance}</strong></span>
              <span>Exported: <strong>{new Date(inspection.exportedAt).toLocaleString()}</strong></span>
              <span>Version: <strong>{inspection.version}</strong></span>
            </div>

            <div className="config-migration-stats-grid">
              <div className="config-migration-stat-badge">
                <Layers size={16} color="#60a5fa" />
                <span className="stat-count">{inspection.summary.roomsCount}</span>
                <span className="stat-label">Rooms</span>
              </div>
              <div className="config-migration-stat-badge">
                <span className="stat-count">{inspection.summary.panesCount}</span>
                <span className="stat-label">Panes</span>
              </div>
              <div className="config-migration-stat-badge">
                <Bookmark size={16} color="#34d399" />
                <span className="stat-count">{inspection.summary.userLinksCount}</span>
                <span className="stat-label">Bookmarks</span>
              </div>
              <div className="config-migration-stat-badge">
                <ClipboardList size={16} color="#fbbf24" />
                <span className="stat-count">{inspection.summary.clipboardItemsCount}</span>
                <span className="stat-label">Plans / Notes</span>
              </div>
              <div className="config-migration-stat-badge">
                <SlidersHorizontal size={16} color="#a78bfa" />
                <span className="stat-count">{inspection.summary.cliRuntimeSettingsCount}</span>
                <span className="stat-label">CLI Runtimes</span>
              </div>
              <div className="config-migration-stat-badge">
                <Server size={16} color="#f472b6" />
                <span className="stat-count">{inspection.summary.providersCount}</span>
                <span className="stat-label">Providers</span>
              </div>
              {(inspection.summary.apiKeysCount ?? 0) > 0 ? (
                <div className="config-migration-stat-badge">
                  <Key size={16} color="#f59e0b" />
                  <span className="stat-count">{inspection.summary.apiKeysCount}</span>
                  <span className="stat-label">API Keys</span>
                </div>
              ) : null}
              {(inspection.summary.credentialsCount ?? 0) > 0 ? (
                <div className="config-migration-stat-badge">
                  <Lock size={16} color="#f59e0b" />
                  <span className="stat-count">{inspection.summary.credentialsCount}</span>
                  <span className="stat-label">Credentials</span>
                </div>
              ) : null}
            </div>

            {inspection.warnings?.length ? (
              <ul className="config-migration-list warn" aria-label="Checks for this computer">
                {inspection.warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            ) : null}

            {inspection.missingProjectRoots?.length ? (
              <label className="config-migration-field">
                <span>Project folder on this computer for {inspection.missingProjectRoots[0]} (optional)</span>
                <input type="text" placeholder="/home/you/Projects/space" value={projectFolder} disabled={isImporting}
                  onChange={(event) => setProjectFolder(event.target.value)} />
              </label>
            ) : null}

            {inspection.secrets?.plaintextApiKeys ? (
              <p className="config-migration-alert warn">
                This older backup stores API keys unencrypted. Delete it after the import and consider replacing those keys.
              </p>
            ) : null}

            {(inspection.summary.apiKeysCount ?? 0) > 0 || (inspection.summary.credentialsCount ?? 0) > 0 ? (
              <div className="config-migration-options-group">
                {inspection.secrets?.encrypted ? (
                  <label className="config-migration-field">
                    <span>Backup passphrase</span>
                    <input type="password" autoComplete="off" value={importPassphrase} disabled={isImporting}
                      onChange={(event) => setImportPassphrase(event.target.value)} />
                  </label>
                ) : null}
                {(inspection.summary.apiKeysCount ?? 0) > 0 ? (
                  <SpaceToggle
                    className="config-migration-toggle-row"
                    name="import-api-keys"
                    ariaLabel={`Import Provider API Keys (${inspection.summary.apiKeysCount} found)`}
                    label={
                      <span className="config-migration-toggle-title">
                        <Key size={14} color="#f59e0b" />
                        <span>Import Provider API Keys ({inspection.summary.apiKeysCount} found)</span>
                      </span>
                    }
                    detail="Restores the AI service keys saved in the backup."
                    checked={importApiKeys}
                    disabled={isImporting}
                    onChange={setImportApiKeys}
                  />
                ) : null}

                {inspection.secrets?.cliAuthRuntimes?.length ? (
                  <>
                    <SpaceToggle
                      className="config-migration-toggle-row"
                      name="import-credentials"
                      ariaLabel={`Import CLI logins (${inspection.secrets.cliAuthRuntimes.length} found)`}
                      label={
                        <span className="config-migration-toggle-title">
                          <Lock size={14} color="#f59e0b" />
                          <span>Import CLI logins ({inspection.secrets.cliAuthRuntimes.length} found)</span>
                        </span>
                      }
                      detail={rotationWarning}
                      checked={importCredentials}
                      disabled={isImporting}
                      onChange={setImportCredentials}
                    />
                    {importCredentials ? (
                      <fieldset className="config-migration-check-list" aria-label="CLI logins to import">
                        {inspection.secrets.cliAuthRuntimes.map((runtimeId) => (
                          <SpaceToggle key={runtimeId} compact className="config-migration-check-row"
                            label={runtimeId.replace(/^cli:/, "")} checked={importRuntimes.includes(runtimeId)} disabled={isImporting}
                            onChange={(checked) => setImportRuntimes((current) => checked
                              ? [...current, runtimeId]
                              : current.filter((id) => id !== runtimeId))} />
                        ))}
                        <label className="config-migration-field">
                          <span>When this computer already has a login</span>
                          <select value={cliAuthConflict} disabled={isImporting}
                            onChange={(event) => setCliAuthConflict(event.target.value as typeof cliAuthConflict)}>
                            <option value="backup-and-replace">Keep a backup copy and replace it</option>
                            <option value="skip-if-logged-in">Keep the login already here</option>
                          </select>
                        </label>
                      </fieldset>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}

            <div className="config-migration-actions">
              <button
                type="button"
                className="config-migration-btn primary"
                onClick={() => void handleImport()}
                disabled={isImporting}
              >
                {isImporting ? <RefreshCw size={16} className="spin" /> : <Upload size={16} />}
                <span>{isImporting ? "Applying Configuration..." : `Apply & Import (${importMode.toUpperCase()})`}</span>
              </button>
            </div>
          </div>
        ) : null}

        {/* Success Result */}
        {importResult ? (
          <div className="config-migration-preview">
            <div className="config-migration-alert good">
              <CheckCircle2 size={18} />
              <span><strong>Configuration successfully imported!</strong></span>
            </div>
            <div className="config-migration-stats-grid">
              <div className="config-migration-stat-badge">
                <span className="stat-count">{importResult.stats.roomsImported}</span>
                <span className="stat-label">Rooms Imported</span>
              </div>
              <div className="config-migration-stat-badge">
                <span className="stat-count">{importResult.stats.panesImported}</span>
                <span className="stat-label">Panes Imported</span>
              </div>
              <div className="config-migration-stat-badge">
                <span className="stat-count">{importResult.stats.linksImported}</span>
                <span className="stat-label">Links Imported</span>
              </div>
              <div className="config-migration-stat-badge">
                <span className="stat-count">{importResult.stats.clipboardImported}</span>
                <span className="stat-label">Plans Imported</span>
              </div>
              {importResult.stats.apiKeysImported ? (
                <div className="config-migration-stat-badge">
                  <Key size={16} color="#f59e0b" />
                  <span className="stat-count">{importResult.stats.apiKeysImported}</span>
                  <span className="stat-label">API Keys</span>
                </div>
              ) : null}
              {importResult.stats.credentialsImported ? (
                <div className="config-migration-stat-badge">
                  <Lock size={16} color="#f59e0b" />
                  <span className="stat-count">{importResult.stats.credentialsImported}</span>
                  <span className="stat-label">CLI logins</span>
                </div>
              ) : null}
            </div>

            {importResult.cliAuth?.length ? (
              <ul className="config-migration-list" aria-label="CLI logins">
                {importResult.cliAuth.map((entry) => (
                  <li key={entry.runtimeId}>
                    <strong>{entry.runtimeId.replace(/^cli:/, "")}</strong>{": "}
                    {entry.result === "imported"
                      ? entry.detect === "logged-in" ? "signed in" : "login restored; if it still asks you to sign in, use Create → CLI tools"
                      : `${entry.result === "failed" ? "not imported" : "skipped"} (${cliAuthReasons[entry.reason ?? ""] ?? entry.reason ?? "unknown reason"})`}
                  </li>
                ))}
              </ul>
            ) : null}

            {importResult.warnings.length ? (
              <ul className="config-migration-list warn" aria-label="Import notes">
                {importResult.warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            ) : null}

            {rawBundle?.encrypted || inspection?.secrets?.plaintextApiKeys ? (
              <p className="config-migration-desc">The import is done: delete the backup file from this computer, since it holds your keys and logins.</p>
            ) : null}

            <div className="config-migration-actions">
              <button
                type="button"
                className="config-migration-btn success"
                onClick={handleReload}
              >
                <RefreshCw size={16} />
                <span>Reload SpaceApp to Apply Changes</span>
              </button>
            </div>
          </div>
        ) : null}
      </div> : null}
      {confirmDialog}
    </div>
  );
}
