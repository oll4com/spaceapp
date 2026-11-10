import { useState } from "react";
import type { DemoConnection, DemoConnectionProvider, DemoSheetsTarget } from "@space/contracts";
import { api } from "../../api.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";

interface ConnectionsTabProps {
  connections: DemoConnection[];
  sheets: DemoSheetsTarget;
  onRefresh: () => Promise<void>;
  onNotice: (notice: { tone: "ok" | "error" | "warn"; message: string } | null) => void;
}

function statusTone(connection: DemoConnection): string {
  if (connection.status === "CONNECTED") return "demos-pill demos-running";
  if (connection.status === "NEEDS_RECONNECT" || connection.status === "ERROR") return "demos-pill demos-failed";
  return "demos-pill demos-stopped";
}

export function ConnectionsTab({ connections, sheets, onRefresh, onNotice }: ConnectionsTabProps) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [salesforceId, setSalesforceId] = useState("");
  const [salesforceSecret, setSalesforceSecret] = useState("");
  const [salesforceLoginUrl, setSalesforceLoginUrl] = useState("https://login.salesforce.com");
  const [googleId, setGoogleId] = useState("");
  const [googleSecret, setGoogleSecret] = useState("");
  const [spreadsheet, setSpreadsheet] = useState(sheets.spreadsheetUrl ?? sheets.spreadsheetId ?? "");
  const [tab, setTab] = useState(sheets.tab ?? "");
  const [busy, setBusy] = useState<string | null>(null);

  const [editingSalesforce, setEditingSalesforce] = useState(false);
  const [editingGoogle, setEditingGoogle] = useState(false);

  const salesforce = connections.find((connection) => connection.provider === "salesforce") ?? null;
  const google = connections.find((connection) => connection.provider === "google-sheets") ?? null;

  async function run(action: string, task: () => Promise<void>): Promise<void> {
    setBusy(action);
    onNotice(null);
    try {
      await task();
    } catch (error) {
      onNotice({ tone: "error", message: error instanceof Error ? error.message : t("The action failed.") });
    } finally {
      setBusy(null);
    }
  }

  function saveSettings(provider: DemoConnectionProvider): Promise<void> {
    return run(`settings-${provider}`, async () => {
      const input =
        provider === "salesforce"
          ? { clientId: salesforceId.trim(), clientSecret: salesforceSecret.trim() || null, loginUrl: salesforceLoginUrl }
          : { clientId: googleId.trim(), clientSecret: googleSecret.trim() || null };
      if (input.clientId.length < 5) throw new Error(t("Enter the client id first."));
      await api.demoSaveConnectionSettings(provider, input);
      setSalesforceSecret("");
      setGoogleSecret("");
      if (provider === "salesforce") setEditingSalesforce(false);
      if (provider === "google-sheets") setEditingGoogle(false);
      onNotice({ tone: "ok", message: t("Client settings stored encrypted on the server.") });
      await onRefresh();
    });
  }

  function authorize(provider: DemoConnectionProvider): Promise<void> {
    return run(`authorize-${provider}`, async () => {
      const result = await api.demoAuthorizeConnection(provider);
      const popup = window.open(result.authorizationUrl, "space-demo-oauth", "width=560,height=720");
      if (!popup) {
        onNotice({ tone: "warn", message: t("The browser blocked the connection window. Allow popups for Space and retry.") });
        return;
      }
      onNotice({ tone: "ok", message: t("Complete the consent screen; the pane refreshes when the connection returns.") });
      const started = Date.now();
      const timer = window.setInterval(() => {
        if (popup.closed || Date.now() - started > 5 * 60_000) {
          window.clearInterval(timer);
          void onRefresh();
        }
      }, 2_000);
    });
  }

  function disconnect(provider: DemoConnectionProvider): Promise<void> {
    return run(`disconnect-${provider}`, async () => {
      await api.demoDisconnectConnection(provider);
      onNotice({ tone: "ok", message: t("Connection removed; stored tokens were revoked and deleted.") });
      await onRefresh();
    });
  }

  function saveSheet(): Promise<void> {
    return run("sheet-save", async () => {
      const result = await api.demoSelectSheet({ spreadsheet: spreadsheet.trim(), tab: tab.trim() || null });
      onNotice({
        tone: "ok",
        message: result.sheets.headerPresent
          ? t("Spreadsheet ready: {title}.", { title: result.sheets.title ?? result.sheets.spreadsheetId ?? "" })
          : t("Spreadsheet selected, but the header row is incomplete.")
      });
      await onRefresh();
    });
  }

  function createSheet(): Promise<void> {
    return run("sheet-create", async () => {
      const result = await api.demoCreateSheet({ tab: tab.trim() || null });
      setSpreadsheet(result.sheets.spreadsheetUrl ?? result.sheets.spreadsheetId ?? "");
      onNotice({ tone: "ok", message: t("Created spreadsheet {title}.", { title: result.sheets.title ?? "" }) });
      await onRefresh();
    });
  }

  function verifySheet(): Promise<void> {
    return run("sheet-verify", async () => {
      const result = await api.demoVerifySheet();
      onNotice({ tone: "ok", message: t("Spreadsheet read-back verified at {tab}.", { tab: result.sheets.tab ?? t("the selected tab") }) });
      await onRefresh();
    });
  }

  const sheetLink =
    sheets.spreadsheetUrl || (sheets.spreadsheetId ? `https://docs.google.com/spreadsheets/d/${sheets.spreadsheetId}` : null);

  const inputTrimmed = spreadsheet.trim();
  const inputSheetLink = inputTrimmed
    ? inputTrimmed.startsWith("http://") || inputTrimmed.startsWith("https://")
      ? inputTrimmed
      : `https://docs.google.com/spreadsheets/d/${inputTrimmed}`
    : null;
  const activeSheetLink = inputSheetLink || sheetLink;

  return (
    <div className="demos-connections-wrap">
      <div className="demos-card">
        <div className="demos-row spread">
          <div>
            <h3>{t("OAuth Connections")}</h3>
            <p className="demos-muted" style={{ margin: "4px 0 0" }}>
              {t("Active provider connections for live integrations. Sample runs remain isolated and never call external services.")}
            </p>
          </div>
          <button type="button" className="demos-ghost" onClick={() => void onRefresh()} disabled={busy !== null}>
            {t("Refresh status")}
          </button>
        </div>

        <table className="demos-table" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>{t("Provider")}</th>
              <th>{t("Status")}</th>
              <th>{t("Connected Account")}</th>
              <th>{t("Redirect URI")}</th>
              <th style={{ textAlign: "right" }}>{t("Actions")}</th>
            </tr>
          </thead>
          <tbody>
            {[salesforce, google].map((connection) => {
              const providerName = connection?.provider === "salesforce" ? "Salesforce" : "Google Sheets";
              const isConfigured = Boolean(connection?.configured);
              const isConnected = connection?.status === "CONNECTED";

              return (
                <tr key={connection?.provider ?? "missing"}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className={`demos-provider-icon ${connection?.provider ?? ""}`} />
                      <strong>{providerName}</strong>
                    </div>
                  </td>
                  <td>
                    <span className={connection ? statusTone(connection) : "demos-pill"}>
                      {t(!isConfigured ? "UNCONFIGURED" : connection!.status === "UNCONFIGURED" ? "CONFIGURED" : connection!.status)}
                    </span>
                    {connection?.safeErrorMessage ? <div className="demos-muted">{connection.safeErrorMessage}</div> : null}
                  </td>
                  <td>
                    {connection?.label ? (
                      <div>
                        <div>{connection.label}</div>
                        {connection.detail ? <div className="demos-mono demos-subtle">{connection.detail}</div> : null}
                      </div>
                    ) : (
                      <span className="demos-muted">—</span>
                    )}
                  </td>
                  <td className="demos-mono">{connection?.redirectUri ?? "—"}</td>
                  <td style={{ textAlign: "right" }}>
                    <div className="demos-row" style={{ justifyContent: "flex-end" }}>
                      <button
                        type="button"
                        className={isConnected ? "demos-ghost" : "demos-action-btn"}
                        disabled={!isConfigured || busy !== null}
                        onClick={() => void authorize(connection!.provider)}
                      >
                        {isConnected ? t("Reconnect") : t("Connect")}
                      </button>
                      {isConfigured ? (
                        <button
                          type="button"
                          className="demos-ghost demos-danger"
                          disabled={busy !== null}
                          onClick={() => void disconnect(connection!.provider)}
                        >
                          {t("Disconnect")}
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Salesforce Credentials Section */}
      <div className="demos-card">
        <div className="demos-row spread">
          <div>
            <h3>{t("Salesforce API Credentials")}</h3>
            <p className="demos-muted" style={{ margin: "4px 0 0" }}>
              {t("OAuth 2.0 Connected App client credentials. Stored with AES encryption on the server.")}
            </p>
          </div>
          {salesforce?.configured && !editingSalesforce ? (
            <button type="button" className="demos-ghost" onClick={() => setEditingSalesforce(true)}>
              {t("Update credentials")}
            </button>
          ) : null}
        </div>

        {salesforce?.configured && !editingSalesforce ? (
          <div className="demos-masked-card">
            <div className="demos-masked-field">
              <span className="demos-masked-label">{t("Consumer Key (Client ID)")}</span>
              <span className="demos-masked-dots">••••••••••••••••••••••••••••••••</span>
              <span className="demos-badge-verified">{t("Configured & Encrypted")}</span>
            </div>
            <div className="demos-masked-field">
              <span className="demos-masked-label">{t("Consumer Secret")}</span>
              <span className="demos-masked-dots">••••••••••••••••</span>
              <span className="demos-badge-verified">{t("Protected")}</span>
            </div>
            <div className="demos-masked-field">
              <span className="demos-masked-label">{t("Login Host")}</span>
              <span className="demos-mono">{salesforceLoginUrl}</span>
            </div>
          </div>
        ) : (
          <form
            autoComplete="off"
            onSubmit={(e) => {
              e.preventDefault();
              void saveSettings("salesforce");
            }}
          >
            {/* Hidden dummy input to defeat Chrome autofill heuristics */}
            <input type="text" style={{ display: "none" }} tabIndex={-1} autoComplete="off" />
            <input type="password" style={{ display: "none" }} tabIndex={-1} autoComplete="off" />

            <div className="demos-grid">
              <label className="demos-field">
                <span>{t("Salesforce consumer key (client id)")}</span>
                <input
                  name="sf_cid_field"
                  autoComplete="off"
                  data-1p-ignore="true"
                  data-lpignore="true"
                  spellCheck={false}
                  value={salesforceId}
                  onChange={(event) => setSalesforceId(event.target.value)}
                  placeholder="3MVG9…"
                />
              </label>
              <label className="demos-field">
                <span>{t("Salesforce consumer secret")}</span>
                <input
                  type="password"
                  name="sf_secret_field"
                  autoComplete="new-password"
                  data-1p-ignore="true"
                  data-lpignore="true"
                  value={salesforceSecret}
                  onChange={(event) => setSalesforceSecret(event.target.value)}
                  placeholder={salesforce?.configured ? t("leave empty to keep the stored secret") : t("Enter consumer secret")}
                />
              </label>
              <label className="demos-field">
                <span>{t("Salesforce login host")}</span>
                <select value={salesforceLoginUrl} onChange={(event) => setSalesforceLoginUrl(event.target.value)}>
                  <option value="https://login.salesforce.com">{t("login.salesforce.com (production / Developer Edition)")}</option>
                  <option value="https://test.salesforce.com">{t("test.salesforce.com (sandbox)")}</option>
                </select>
              </label>
              <div className="demos-row" style={{ alignItems: "flex-end" }}>
                <button type="submit" disabled={busy !== null}>
                  {busy === "settings-salesforce" ? t("Saving…") : t("Save Salesforce settings")}
                </button>
                {salesforce?.configured ? (
                  <button type="button" className="demos-ghost" onClick={() => setEditingSalesforce(false)}>
                    {t("Cancel")}
                  </button>
                ) : null}
              </div>
            </div>
          </form>
        )}
      </div>

      {/* Google Sheets Credentials Section */}
      <div className="demos-card">
        <div className="demos-row spread">
          <div>
            <h3>{t("Google Sheets API Credentials")}</h3>
            <p className="demos-muted" style={{ margin: "4px 0 0" }}>
              {t("Google Cloud OAuth 2.0 Web Application credentials with Google Sheets & Drive scopes.")}
            </p>
          </div>
          {google?.configured && !editingGoogle ? (
            <button type="button" className="demos-ghost" onClick={() => setEditingGoogle(true)}>
              {t("Update credentials")}
            </button>
          ) : null}
        </div>

        {google?.configured && !editingGoogle ? (
          <div className="demos-masked-card">
            <div className="demos-masked-field">
              <span className="demos-masked-label">{t("Google OAuth Client ID")}</span>
              <span className="demos-masked-dots">••••••••••••••••••••••••••••••••</span>
              <span className="demos-badge-verified">{t("Configured & Encrypted")}</span>
            </div>
            <div className="demos-masked-field">
              <span className="demos-masked-label">{t("Client Secret")}</span>
              <span className="demos-masked-dots">••••••••••••••••</span>
              <span className="demos-badge-verified">{t("Protected")}</span>
            </div>
          </div>
        ) : (
          <form
            autoComplete="off"
            onSubmit={(e) => {
              e.preventDefault();
              void saveSettings("google-sheets");
            }}
          >
            {/* Hidden dummy input to defeat Chrome autofill heuristics */}
            <input type="text" style={{ display: "none" }} tabIndex={-1} autoComplete="off" />
            <input type="password" style={{ display: "none" }} tabIndex={-1} autoComplete="off" />

            <div className="demos-grid">
              <label className="demos-field">
                <span>{t("Google OAuth client id")}</span>
                <input
                  name="google_cid_field"
                  autoComplete="off"
                  data-1p-ignore="true"
                  data-lpignore="true"
                  spellCheck={false}
                  value={googleId}
                  onChange={(event) => setGoogleId(event.target.value)}
                  placeholder="…apps.googleusercontent.com"
                />
              </label>
              <label className="demos-field">
                <span>{t("Google OAuth client secret")}</span>
                <input
                  type="password"
                  name="google_secret_field"
                  autoComplete="new-password"
                  data-1p-ignore="true"
                  data-lpignore="true"
                  value={googleSecret}
                  onChange={(event) => setGoogleSecret(event.target.value)}
                  placeholder={google?.configured ? t("leave empty to keep stored secret") : t("Enter client secret")}
                />
              </label>
              <div className="demos-row" style={{ alignItems: "flex-end" }}>
                <button type="submit" disabled={busy !== null}>
                  {busy === "settings-google-sheets" ? t("Saving…") : t("Save Google settings")}
                </button>
                {google?.configured ? (
                  <button type="button" className="demos-ghost" onClick={() => setEditingGoogle(false)}>
                    {t("Cancel")}
                  </button>
                ) : null}
              </div>
            </div>
          </form>
        )}
      </div>

      {/* Google Sheets Target Section */}
      <div className="demos-card">
        <div className="demos-row spread">
          <div>
            <h3>{t("Google Sheets Target Spreadsheet")}</h3>
            <p className="demos-muted" style={{ margin: "4px 0 0" }}>
              {t("Destination spreadsheet for Account synchronizations. Appends rows with idempotency verification.")}
            </p>
          </div>
          {sheetLink ? (
            <a
              href={sheetLink}
              target="_blank"
              rel="noopener noreferrer"
              className="demos-link-button"
            >
              {t("Open in Google Sheets ↗")}
            </a>
          ) : null}
        </div>

        {sheets.spreadsheetId ? (
          <div className="demos-target-card">
            <div className="demos-target-header">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="demos-sheet-icon">📊</span>
                <strong>{sheets.title || t("Untitled Spreadsheet")}</strong>
              </div>
              <span className={`demos-pill ${sheets.verified ? "demos-running" : "demos-starting"}`}>
                {sheets.verified ? t("VERIFIED ✓") : t("UNVERIFIED")}
              </span>
            </div>
            <div className="demos-grid" style={{ marginTop: 8 }}>
              <div className="demos-field">
                <span>{t("Spreadsheet ID")}</span>
                <span className="demos-mono">{sheets.spreadsheetId}</span>
              </div>
              <div className="demos-field">
                <span>{t("Tab Name")}</span>
                <span className="demos-mono">{sheets.tab || t("Default")}</span>
              </div>
              <div className="demos-field">
                <span>{t("Header Verified")}</span>
                <span>{sheets.headerPresent ? t("Yes (Headers Present)") : t("No")}</span>
              </div>
            </div>
          </div>
        ) : null}

        <div className="demos-grid" style={{ marginTop: 10 }}>
          <label className="demos-field">
            <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>{t("Spreadsheet URL or id")}</span>
              {activeSheetLink ? (
                <a
                  href={activeSheetLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="demos-inline-link"
                >
                  {t("Open in Google Sheets ↗")}
                </a>
              ) : null}
            </span>
            <input
              value={spreadsheet}
              onChange={(event) => setSpreadsheet(event.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/…"
            />
          </label>
          <label className="demos-field">
            <span>{t("Tab Name")}</span>
            <input value={tab} onChange={(event) => setTab(event.target.value)} placeholder="Demo Sync" />
          </label>
          <div className="demos-row" style={{ alignItems: "flex-end" }}>
            <button type="button" disabled={busy !== null || !google?.configured} onClick={() => void saveSheet()}>
              {busy === "sheet-save" ? t("Saving…") : t("Save target")}
            </button>
            <button
              type="button"
              className="demos-ghost"
              disabled={busy !== null || !google?.configured}
              onClick={() => void createSheet()}
            >
              {busy === "sheet-create" ? t("Creating…") : t("Create spreadsheet")}
            </button>
            <button
              type="button"
              className="demos-ghost"
              disabled={busy !== null || !sheets.spreadsheetId || google?.status !== "CONNECTED"}
              onClick={() => void verifySheet()}
            >
              {busy === "sheet-verify" ? t("Verifying…") : t("Verify read-back")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
