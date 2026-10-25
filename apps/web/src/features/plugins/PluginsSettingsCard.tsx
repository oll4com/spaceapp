import React, { useState, useEffect, useMemo } from "react";
import {
  Search,
  Sparkles,
  Layers,
  MessageSquare,
  GitBranch,
  Database,
  CreditCard,
  Cpu,
  Activity,
  BookOpen,
  Send,
  Globe,
  Box,
  Share2,
  Plug,
  RefreshCw,
  X,
  Compass,
  Zap,
  Palette,
  CheckCircle2,
  CircleAlert,
  Plus,
  ExternalLink
} from "../ui-theme/app-icons.js";
import { isRepositoryProviderId, type PluginWithState, type PluginCategory } from "@space/contracts";
import "./plugins-settings.css";
import { SOURCE_CONTROL_CONNECTION_EVENT } from "../source-control/client.js";
import { RepositoryProvidersSection } from "../source-control/RepositoryProvidersSection.js";

const CATEGORIES: Array<{ id: string; label: string }> = [
  { id: "all", label: "All" },
  { id: "developer", label: "Developer" },
  { id: "communication", label: "Communication" },
  { id: "database", label: "Database" },
  { id: "productivity", label: "Productivity" },
  { id: "creative", label: "Creative" },
  { id: "finance", label: "Finance" },
  { id: "infra", label: "Infra" }
];

function getPluginIcon(iconName: string) {
  switch (iconName) {
    case "GitBranch":
      return <GitBranch size={20} />;
    case "MessageSquare":
      return <MessageSquare size={20} />;
    case "Database":
      return <Database size={20} />;
    case "Layers":
      return <Layers size={20} />;
    case "Sparkles":
      return <Sparkles size={20} />;
    case "CreditCard":
      return <CreditCard size={20} />;
    case "Cpu":
      return <Cpu size={20} />;
    case "Activity":
      return <Activity size={20} />;
    case "BookOpen":
      return <BookOpen size={20} />;
    case "Send":
      return <Send size={20} />;
    case "Globe":
      return <Globe size={20} />;
    case "Compass":
      return <Compass size={20} />;
    case "Box":
      return <Box size={20} />;
    case "Share2":
      return <Share2 size={20} />;
    case "Zap":
      return <Zap size={20} />;
    case "Palette":
      return <Palette size={20} />;
    case "CheckCircle2":
      return <CheckCircle2 size={20} />;
    default:
      return <Plug size={20} />;
  }
}

let cachedCsrfToken: string | null = null;

async function getCsrfToken(): Promise<string> {
  if (cachedCsrfToken) return cachedCsrfToken;
  try {
    const res = await fetch("/api/auth/csrf", { credentials: "same-origin" });
    if (res.ok) {
      const data = (await res.json()) as { csrfToken?: string };
      if (data.csrfToken) cachedCsrfToken = data.csrfToken;
    }
  } catch {}
  return cachedCsrfToken || "";
}

async function authedPost(url: string, body?: unknown): Promise<Response> {
  let token = await getCsrfToken();
  const headers: Record<string, string> = {};
  if (token) headers["x-space-csrf-token"] = token;
  if (body !== undefined) headers["content-type"] = "application/json";

  let res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  if (res.status === 403 || res.status === 401) {
    cachedCsrfToken = null;
    token = await getCsrfToken();
    if (token) headers["x-space-csrf-token"] = token;
    res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  }
  return res;
}

// canManage: installation plugins are shared by every account; only administrators change them.
export function PluginsSettingsCard({ canManage = true }: { canManage?: boolean } = {}) {
  const [plugins, setPlugins] = useState<PluginWithState[]>([]);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("all");
  const [loading, setLoading] = useState(false);
  const [selectedPlugin, setSelectedPlugin] = useState<PluginWithState | null>(null);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [accountLabel, setAccountLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  const fetchPlugins = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/plugins", { credentials: "same-origin" });
      if (res.ok) {
        const data = await res.json();
        setPlugins(data);
      }
    } catch {
      // Ignore or handle error
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchPlugins();
  }, []);

  const filteredPlugins = useMemo(() => {
    // Repository providers have their own group with personal enable toggles and credentials.
    return plugins.filter((p) => !isRepositoryProviderId(p.id)).filter((p) => {
      const matchesSearch =
        p.displayName.toLowerCase().includes(search.toLowerCase()) ||
        p.description.toLowerCase().includes(search.toLowerCase());
      const matchesCategory =
        activeCategory === "all" || p.category === activeCategory;
      return matchesSearch && matchesCategory;
    });
  }, [plugins, search, activeCategory]);

  const handleOpenConnect = (plugin: PluginWithState) => {
    setSelectedPlugin(plugin);
    setCredentials(plugin.id === "gitea" ? { serverUrl: plugin.authFields.find(f => f.key === "serverUrl")?.placeholder || "" } : {});
    setAccountLabel("");
    setActionError(null);
    setTestResult(null);
  };

  const handleCloseModal = () => {
    setSelectedPlugin(null);
    setCredentials({});
    setActionError(null);
    setTestResult(null);
  };

  const handleConnectSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPlugin) return;
    setSubmitting(true);
    setActionError(null);
    try {
      const res = await authedPost(`/api/plugins/${selectedPlugin.id}/connect`, {
        credentials,
        accountLabel: accountLabel.trim() || undefined
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error?.message || data.message || "Connection failed");
      }
      await fetchPlugins();
      if ((selectedPlugin.id === "github" || selectedPlugin.id === "gitea") && data.status === "CONNECTED") {
        window.dispatchEvent(new CustomEvent(SOURCE_CONTROL_CONNECTION_EVENT, { detail: { openDock: true } }));
      }
      handleCloseModal();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Error connecting plugin");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!selectedPlugin) return;
    setSubmitting(true);
    setActionError(null);
    try {
      const res = await authedPost(`/api/plugins/${selectedPlugin.id}/disconnect`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error?.message || data.message || "Failed to disconnect");
      }
      await fetchPlugins();
      if (selectedPlugin.id === "github" || selectedPlugin.id === "gitea") window.dispatchEvent(new CustomEvent(SOURCE_CONTROL_CONNECTION_EVENT));
      handleCloseModal();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Error disconnecting");
    } finally {
      setSubmitting(false);
    }
  };

  const handleTestConnection = async () => {
    if (!selectedPlugin) return;
    setSubmitting(true);
    setActionError(null);
    setTestResult(null);
    try {
      const res = await authedPost(`/api/plugins/${selectedPlugin.id}/test`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setTestResult(data.message || `Active (${data.toolCount} tools ready)`);
      } else {
        const errorMsg = data.error?.message || data.message || "Test failed";
        setActionError(errorMsg);
      }
      if (selectedPlugin.id === "github" || selectedPlugin.id === "gitea") {
        await fetchPlugins();
        window.dispatchEvent(new CustomEvent(SOURCE_CONTROL_CONNECTION_EVENT));
      }
    } catch {
      setActionError("Handshake probe timed out.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="plugins-settings-container">
      {/* The Settings section above already names and explains Plugins. */}
      {canManage ? null : <p className="plugins-readonly-note" role="note">Only an administrator can change installation plugins.</p>}

      <div className="plugins-search-bar-wrap">
        <Search className="plugins-search-icon" />
        <input
          type="text"
          className="plugins-search-input"
          aria-label="Search plugins"
          placeholder="Search plugins"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="plugins-category-pills">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            className={`plugin-pill ${activeCategory === cat.id ? "active" : ""}`}
            onClick={() => setActiveCategory(cat.id)}
            type="button"
          >
            {cat.label}
          </button>
        ))}
      </div>

      {activeCategory === "all" || activeCategory === "developer" ? <RepositoryProvidersSection filter={search} /> : null}

      <div className="plugins-grid">
        {filteredPlugins.map((plugin) => {
          const isConnected = plugin.connection.status === "CONNECTED";
          return (
            <div key={plugin.id} className="plugin-card" data-plugin-id={plugin.id}>
              <div className="plugin-card-header">
                <div className="plugin-info-left">
                  <div className="plugin-icon-wrap">
                    {getPluginIcon(plugin.icon)}
                  </div>
                  <div className="plugin-title-wrap">
                    <strong>{plugin.displayName}</strong>
                  </div>
                </div>

                <div className="plugin-actions-right">
                  {isConnected ? (
                    <button
                      type="button"
                      className="plugin-status-badge connected"
                      onClick={() => handleOpenConnect(plugin)}
                      title="Connected • Click to inspect or configure"
                    >
                      <span className="plugin-status-dot-pulse" />
                      <span>Connected</span>
                    </button>
                  ) : plugin.preview ? (
                    <span className="plugin-preview-badge">
                      <Sparkles size={11} className="plugin-preview-sparkle" />
                      <span>Preview</span>
                    </span>
                  ) : canManage ? (
                    <button
                      type="button"
                      className="plugin-connect-btn"
                      onClick={() => handleOpenConnect(plugin)}
                    >
                      <Plus size={13} className="plugin-connect-icon" />
                      <span>Connect</span>
                    </button>
                  ) : null}
                </div>
              </div>

              <p className="plugin-card-desc">{plugin.description}</p>
            </div>
          );
        })}
      </div>

      <div className="plugins-footer-banner">
        A connected plugin works for every agent on this Space; built-in ones (such as Context7) start only when a task needs them. Repository providers (GitHub, Gitea and others) are personal: each person connects their own account.
      </div>

      {selectedPlugin && (
        <div className="plugin-modal-overlay" onClick={handleCloseModal}>
          <div className="plugin-modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="plugin-modal-header">
              <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                <div className="plugin-icon-wrap" style={{ width: "2rem", height: "2rem" }}>
                  {getPluginIcon(selectedPlugin.icon)}
                </div>
                <h3>
                  {selectedPlugin.connection.status === "CONNECTED"
                    ? `${selectedPlugin.displayName} Settings`
                    : `Connect ${selectedPlugin.displayName}`}
                </h3>
              </div>
              <button className="plugin-modal-close-btn" onClick={handleCloseModal}>
                <X size={18} />
              </button>
            </div>

            {selectedPlugin.connection.status === "CONNECTED" ? (
              <div className="plugin-modal-body">
                {/* Status & Active Tools */}
                <div className="plugin-modal-field">
                  <label>Status</label>
                  <div style={{ color: "#34d399", fontSize: "0.9rem", fontWeight: 500, display: "flex", alignItems: "center", gap: "0.45rem" }}>
                    <span className="plugin-status-dot-pulse" />
                    <span>Connected ({selectedPlugin.connection.toolCount} tools active)</span>
                  </div>
                </div>

                {selectedPlugin.connection.accountLabel && (
                  <div className="plugin-modal-field">
                    <label>Account / Workspace</label>
                    <div style={{ color: "#c5c9ce", fontSize: "0.85rem" }}>
                      {selectedPlugin.connection.accountLabel}
                    </div>
                  </div>
                )}

                {/* Overview & GitHub link */}
                <div className="plugin-modal-field">
                  <div className="plugin-field-header-row">
                    <label>Overview</label>
                    {selectedPlugin.githubUrl && (
                      <a
                        href={selectedPlugin.githubUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="plugin-github-badge-link"
                        title="Open GitHub Repository in a new tab"
                      >
                        <GitBranch size={13} />
                        <span>GitHub</span>
                        <ExternalLink size={11} className="plugin-ext-icon" />
                      </a>
                    )}
                  </div>
                  <div className="plugin-overview-box">
                    <p className="plugin-overview-text">
                      {selectedPlugin.overview || selectedPlugin.description}
                    </p>
                  </div>
                </div>

                {/* Built-in plugins are pinned in the repository and update with SpaceApp releases. */}
                {selectedPlugin.installedVersion ? (
                  <div className="plugin-modal-field">
                    <label>Version</label>
                    <div className="plugin-version-card">
                      <div className="plugin-version-info">
                        <div className="plugin-version-row">
                          <span className="plugin-version-label">Pinned to:</span>
                          <span className="plugin-version-value">{selectedPlugin.installedVersion}</span>
                        </div>
                        <div className="plugin-version-row">
                          <span className="plugin-version-label">Updates with SpaceApp releases.</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}

                {testResult && (
                  <div className="plugin-success-alert">
                    <CheckCircle2 size={16} className="plugin-alert-icon" />
                    <span>{testResult}</span>
                  </div>
                )}

                {actionError && (
                  <div className="plugin-error-alert">
                    <CircleAlert size={16} className="plugin-alert-icon" />
                    <span>{actionError}</span>
                  </div>
                )}

                <div className="plugin-modal-actions" style={{ justifyContent: canManage ? "space-between" : "flex-end" }}>
                  {canManage ? <button
                    type="button"
                    className="plugin-btn-danger"
                    onClick={handleDisconnect}
                    disabled={submitting}
                  >
                    {submitting ? "Disconnecting..." : "Disconnect"}
                  </button> : null}
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <button
                      type="button"
                      className="plugin-btn-secondary"
                      onClick={handleTestConnection}
                      disabled={submitting}
                    >
                      <RefreshCw size={14} className={submitting ? "plugin-spin" : ""} style={{ display: "inline", marginRight: "4px" }} />
                      {submitting ? "Testing..." : "Test Connection"}
                    </button>
                    <button
                      type="button"
                      className="plugin-btn-secondary"
                      onClick={handleCloseModal}
                    >
                      Close
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <form onSubmit={handleConnectSubmit} className="plugin-modal-body">
                {/* Overview & GitHub link */}
                <div className="plugin-modal-field">
                  <div className="plugin-field-header-row">
                    <label>Overview</label>
                    {selectedPlugin.githubUrl && (
                      <a
                        href={selectedPlugin.githubUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="plugin-github-badge-link"
                        title="Open GitHub Repository in a new tab"
                      >
                        <GitBranch size={13} />
                        <span>GitHub</span>
                        <ExternalLink size={11} className="plugin-ext-icon" />
                      </a>
                    )}
                  </div>
                  <div className="plugin-overview-box">
                    <p className="plugin-overview-text">
                      {selectedPlugin.overview || selectedPlugin.description}
                    </p>
                  </div>
                </div>

                {/* MCP Version Preview */}
                <div className="plugin-modal-field">
                  <label>MCP Version</label>
                  <div className="plugin-version-card">
                    <div className="plugin-version-info">
                      <div className="plugin-version-row">
                        <span className="plugin-version-label">Available:</span>
                        <span className="plugin-version-value">v{selectedPlugin.latestVersion || selectedPlugin.installedVersion || "1.0.0"}</span>
                      </div>
                    </div>
                    <span className="plugin-up-to-date-badge">
                      <CheckCircle2 size={13} />
                      <span>Ready to connect</span>
                    </span>
                  </div>
                </div>

                {selectedPlugin.authFields.map((field) => (
                  <div key={field.key} className="plugin-modal-field">
                    <label>
                      {field.label} {field.required && "*"}
                    </label>
                    <input
                      type={field.type}
                      placeholder={field.placeholder}
                      value={credentials[field.key] || ""}
                      onChange={(e) =>
                        setCredentials({ ...credentials, [field.key]: e.target.value })
                      }
                      required={field.required}
                    />
                    {field.description && <small>{field.description}</small>}
                  </div>
                ))}

                <div className="plugin-modal-field">
                  <label>Workspace / Account Label (Optional)</label>
                  <input
                    type="text"
                    placeholder="e.g. My Team Workspace"
                    value={accountLabel}
                    onChange={(e) => setAccountLabel(e.target.value)}
                  />
                </div>

                {actionError && (
                  <div className="plugin-error-alert">
                    <CircleAlert size={16} className="plugin-alert-icon" />
                    <span>{actionError}</span>
                  </div>
                )}

                <div className="plugin-modal-actions">
                  <button
                    type="button"
                    className="plugin-btn-secondary"
                    onClick={handleCloseModal}
                    disabled={submitting}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="plugin-btn-primary"
                    disabled={submitting}
                  >
                    {submitting ? "Connecting..." : "Connect"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
