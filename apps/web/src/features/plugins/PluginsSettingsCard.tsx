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
  Compass
} from "lucide-react";
import type { PluginWithState, PluginCategory } from "@space/contracts";
import "./plugins-settings.css";

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
    default:
      return <Plug size={20} />;
  }
}

export function PluginsSettingsCard() {
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
      const res = await fetch("/api/plugins");
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
    return plugins.filter((p) => {
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
    setCredentials({});
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
      const res = await fetch(`/api/plugins/${selectedPlugin.id}/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          credentials,
          accountLabel: accountLabel.trim() || undefined
        })
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Connection failed");
      }
      await fetchPlugins();
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
      const res = await fetch(`/api/plugins/${selectedPlugin.id}/disconnect`, {
        method: "POST"
      });
      if (!res.ok) {
        throw new Error("Failed to disconnect");
      }
      await fetchPlugins();
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
      const res = await fetch(`/api/plugins/${selectedPlugin.id}/test`, {
        method: "POST"
      });
      const data = await res.json();
      if (data.ok) {
        setTestResult(`✓ Active (${data.toolCount} tools ready)`);
      } else {
        setActionError(data.message || "Test failed");
      }
    } catch {
      setActionError("Handshake probe timed out.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="plugins-settings-container">
      <div className="plugins-header-block">
        <h2>Plugins</h2>
        <p>Accounts and services your agents can act through.</p>
      </div>

      <div className="plugins-search-bar-wrap">
        <Search className="plugins-search-icon" />
        <input
          type="text"
          className="plugins-search-input"
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

      <div className="plugins-grid">
        {filteredPlugins.map((plugin) => {
          const isConnected = plugin.connection.status === "CONNECTED";
          return (
            <div key={plugin.id} className="plugin-card">
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
                      title="Click to view details or disconnect"
                    >
                      • Connected
                    </button>
                  ) : plugin.preview ? (
                    <span className="plugin-preview-badge">Preview</span>
                  ) : (
                    <button
                      type="button"
                      className="plugin-connect-btn"
                      onClick={() => handleOpenConnect(plugin)}
                    >
                      Connect
                    </button>
                  )}
                </div>
              </div>

              <p className="plugin-card-desc">{plugin.description}</p>
            </div>
          );
        })}
      </div>

      <div className="plugins-footer-banner">
        Plugins connect once to SpaceApp and every agent can use them — turn one off for a specific agent in Agent Settings. Agent-mode chats expose them to Claude Code and Codex through one private gateway; credentials never enter either engine&apos;s configuration.
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
                <div className="plugin-modal-field">
                  <label>Status</label>
                  <div style={{ color: "#34d399", fontSize: "0.9rem", fontWeight: 500 }}>
                    Connected ({selectedPlugin.connection.toolCount} tools active)
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

                {testResult && (
                  <div style={{ color: "#34d399", fontSize: "0.85rem", fontWeight: 500 }}>
                    {testResult}
                  </div>
                )}

                {actionError && <div className="plugin-error-alert">{actionError}</div>}

                <div className="plugin-modal-actions" style={{ justifyContent: "space-between" }}>
                  <button
                    type="button"
                    className="plugin-btn-danger"
                    onClick={handleDisconnect}
                    disabled={submitting}
                  >
                    Disconnect
                  </button>
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <button
                      type="button"
                      className="plugin-btn-secondary"
                      onClick={handleTestConnection}
                      disabled={submitting}
                    >
                      <RefreshCw size={14} style={{ display: "inline", marginRight: "4px" }} />
                      Test Connection
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
                <p style={{ margin: 0, fontSize: "0.85rem", color: "#92979e" }}>
                  {selectedPlugin.description}
                </p>

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

                {actionError && <div className="plugin-error-alert">{actionError}</div>}

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
