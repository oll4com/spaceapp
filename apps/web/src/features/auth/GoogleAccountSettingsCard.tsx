import React, { useState } from "react";
import type { AuthMe } from "@space/contracts";
import { CheckCircle2, Shield, Link2, Eye, EyeOff } from "../ui-theme/app-icons.js";
import { api } from "../../api.js";
import { GoogleAccountsManager } from "./GoogleAccountsManager.js";
import { AppDevicesManager } from "./AppDevicesManager.js";

export function maskEmail(email: string): string {
  if (!email || !email.includes("@")) return "***";
  const [localPart, domain] = email.split("@");
  if (!localPart || !domain) return "***";

  let maskedLocal = "***";
  if (localPart.length <= 2) {
    maskedLocal = `${localPart[0]}***`;
  } else if (localPart.length <= 4) {
    maskedLocal = `${localPart[0]}***${localPart[localPart.length - 1]}`;
  } else {
    maskedLocal = `${localPart.slice(0, 2)}***${localPart.slice(-2)}`;
  }

  const domainParts = domain.split(".");
  let maskedDomain = domain;
  if (domainParts.length >= 2) {
    const host = domainParts[0]!;
    const tld = domainParts.slice(1).join(".");
    const maskedHost = host.length <= 2 ? `${host[0]}***` : `${host[0]}***${host[host.length - 1]}`;
    maskedDomain = `${maskedHost}.${tld}`;
  }

  return `${maskedLocal}@${maskedDomain}`;
}

export interface GoogleAccountSettingsCardProps {
  auth: AuthMe | null;
  onAuthRefresh: () => Promise<void>;
}

export function GoogleAccountSettingsCard({ auth, onAuthRefresh }: GoogleAccountSettingsCardProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [configClientId, setConfigClientId] = useState("");
  const [configClientSecret, setConfigClientSecret] = useState("");
  const [showConfig, setShowConfig] = useState(false);
  const [showFullEmail, setShowFullEmail] = useState(false);

  const user = auth?.user;
  const isLinked = Boolean(user?.googleId);
  const googleAuthEnabled = Boolean(auth?.googleAuthEnabled);

  async function handleConfigureGoogle(e: React.FormEvent) {
    e.preventDefault();
    if (!configClientId || !configClientSecret) {
      setError("Please provide both Google Client ID and Client Secret.");
      return;
    }
    setPending(true);
    setError(null);
    setSuccess(null);
    try {
      await api.configureGoogleOAuth({ clientId: configClientId.trim(), clientSecret: configClientSecret.trim() });
      await onAuthRefresh();
      setSuccess("Google OAuth configured successfully! You can now link your Google account.");
      setShowConfig(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to configure Google OAuth");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="agent-settings-card settings-flat-card google-account-card" aria-label="Google account linking">
      <div className="agent-settings-section-title settings-flat-heading">
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" style={{ flexShrink: 0 }}>
          <path
            fill="#4285F4"
            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
          />
          <path
            fill="#34A853"
            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
          />
          <path
            fill="#FBBC05"
            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
          />
          <path
            fill="#EA4335"
            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
          />
        </svg>
        <span>
          <strong>Sign in with Google</strong>
          <small>{isLinked ? "Connected to Google" : "Not connected"}</small>
        </span>
      </div>

      <div className="settings-flat-row" style={{ alignItems: "center", gridTemplateColumns: "1fr auto" }}>
        <span className="settings-flat-row-copy">
          <strong>Signed in as</strong>
          <small style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
            <span data-sensitive-masked="manual">
              {user?.email
                ? (showFullEmail ? user.email : maskEmail(user.email))
                : (user?.id ?? "Current session")}
            </span>
            {user?.email ? (
              <button
                type="button"
                onClick={() => setShowFullEmail(!showFullEmail)}
                aria-label={showFullEmail ? "Hide email" : "Show full email"}
                title={showFullEmail ? "Hide email" : "Show full email"}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  color: "var(--room-text-secondary, #9ca3af)",
                  display: "inline-flex",
                  alignItems: "center"
                }}
              >
                {showFullEmail ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            ) : null}
          </small>
        </span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.3rem",
            padding: "0.2rem 0.6rem",
            borderRadius: "999px",
            fontSize: "0.75rem",
            fontWeight: 600,
            background: user?.role === "ADMIN" ? "rgba(59, 130, 246, 0.15)" : "rgba(107, 114, 128, 0.2)",
            color: user?.role === "ADMIN" ? "#60a5fa" : "#9ca3af",
            border: "1px solid rgba(255, 255, 255, 0.08)",
            justifySelf: "end",
            whiteSpace: "nowrap"
          }}
        >
          <Shield size={12} />
          {user?.role ?? "USER"}
        </span>
      </div>

      {/* Wraps: in a narrow dock the button moves under the text instead of squeezing it. */}
      <div className="settings-flat-row" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0.6rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", minWidth: 0, flex: "1 1 12rem" }}>
          {user?.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt="Google avatar"
              style={{
                width: "36px",
                height: "36px",
                borderRadius: "50%",
                border: "2px solid #34a853",
                objectFit: "cover",
                flexShrink: 0
              }}
            />
          ) : (
            <div
              style={{
                width: "36px",
                height: "36px",
                borderRadius: "50%",
                background: "var(--room-hover, #232528)",
                border: `2px solid ${isLinked ? "#34a853" : "var(--room-border, #343638)"}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0
              }}
            >
              {isLinked ? <CheckCircle2 size={20} color="#34a853" /> : <Link2 size={18} color="#9ca3af" />}
            </div>
          )}
          <span className="settings-flat-row-copy" style={{ minWidth: 0 }}>
            <strong>{isLinked ? "Google account linked" : "Link a Google account"}</strong>
            <small>
              {isLinked
                ? (
                  <span data-sensitive-masked="manual">
                    Google ID {user?.googleId ? `${user.googleId.slice(0, 4)}••••${user.googleId.slice(-4)}` : ""}
                  </span>
                )
                : googleAuthEnabled
                  ? "Then you can sign in with Google in one click."
                  : "Google sign-in is not turned on for this Space yet."}
            </small>
          </span>
        </div>

        <div style={{ flexShrink: 0, marginLeft: "auto" }}>
          {isLinked ? (
            <span className="settings-flat-note">Manage linked accounts below</span>
          ) : (
            <a
              href={googleAuthEnabled ? "/api/auth/google/start?link=true" : "#"}
              className="button"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.5rem",
                padding: "0.45rem 0.9rem",
                fontSize: "0.82rem",
                borderRadius: "6px",
                fontWeight: 500,
                background: googleAuthEnabled ? "#ffffff" : "rgba(255, 255, 255, 0.1)",
                color: googleAuthEnabled ? "#3c4043" : "#6b7280",
                border: "1px solid #dadce0",
                textDecoration: "none",
                opacity: googleAuthEnabled ? 1 : 0.5,
                pointerEvents: googleAuthEnabled ? "auto" : "none",
                cursor: googleAuthEnabled ? "pointer" : "not-allowed"
              }}
              title={googleAuthEnabled ? "Choose a Google account to link" : "Google Auth is disabled"}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                />
              </svg>
              <span>Connect Google Account</span>
            </a>
          )}
        </div>
      </div>

      {user?.role === "ADMIN" ? (
        <div style={{ marginTop: "0.75rem", borderTop: "1px solid rgba(255, 255, 255, 0.08)", paddingTop: "0.75rem" }}>
          <button
            type="button"
            className="button"
            onClick={() => setShowConfig(!showConfig)}
            style={{
              fontSize: "0.78rem",
              padding: "0.3rem 0.6rem",
              background: "transparent",
              color: "var(--room-text-secondary, #9ca3af)",
              border: "1px dashed rgba(255, 255, 255, 0.15)",
              cursor: "pointer"
            }}
          >
            {showConfig ? "Hide Google OAuth Config" : (googleAuthEnabled ? "Update Google OAuth Credentials" : "Configure Google OAuth (Admin)")}
          </button>

          {showConfig ? (
            <form onSubmit={handleConfigureGoogle} style={{ marginTop: "0.6rem", display: "grid", gap: "0.5rem" }}>
              <div style={{ display: "grid", gap: "0.25rem" }}>
                <label style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--room-text-secondary, #9ca3af)" }}>
                  Google OAuth Client ID
                </label>
                <input
                  type="text"
                  value={configClientId}
                  onChange={(e) => setConfigClientId(e.target.value)}
                  placeholder="e.g. 123456789.apps.googleusercontent.com"
                  style={{
                    padding: "0.4rem 0.6rem",
                    borderRadius: "4px",
                    background: "var(--room-input-bg, rgba(0, 0, 0, 0.3))",
                    border: "1px solid var(--room-border, rgba(255, 255, 255, 0.12))",
                    color: "inherit",
                    fontSize: "0.82rem"
                  }}
                />
              </div>

              <div style={{ display: "grid", gap: "0.25rem" }}>
                <label style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--room-text-secondary, #9ca3af)" }}>
                  Google OAuth Client Secret
                </label>
                <input
                  type="password"
                  value={configClientSecret}
                  onChange={(e) => setConfigClientSecret(e.target.value)}
                  placeholder="e.g. GOCSPX-xxxxxxxxxxxx"
                  style={{
                    padding: "0.4rem 0.6rem",
                    borderRadius: "4px",
                    background: "var(--room-input-bg, rgba(0, 0, 0, 0.3))",
                    border: "1px solid var(--room-border, rgba(255, 255, 255, 0.12))",
                    color: "inherit",
                    fontSize: "0.82rem"
                  }}
                />
              </div>

              <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.25rem" }}>
                <button
                  type="submit"
                  className="button"
                  disabled={pending || !configClientId || !configClientSecret}
                  style={{
                    padding: "0.4rem 0.8rem",
                    fontSize: "0.8rem",
                    fontWeight: 600,
                    borderRadius: "4px",
                    background: "#3b82f6",
                    color: "#ffffff",
                    border: "none",
                    cursor: pending || !configClientId || !configClientSecret ? "not-allowed" : "pointer"
                  }}
                >
                  {pending ? "Saving..." : "Save & Enable Google SSO"}
                </button>
              </div>
            </form>
          ) : null}
        </div>
      ) : null}

      <GoogleAccountsManager enabled={googleAuthEnabled} onAuthRefresh={onAuthRefresh} />
      <AppDevicesManager />

      {error ? (
        <div className="validation-result bad" role="alert" style={{ marginTop: "0.5rem" }}>
          <strong>Couldn't save</strong>
          <small>{error}</small>
        </div>
      ) : null}

      {success ? (
        <div className="validation-result ok" role="status" style={{ marginTop: "0.5rem" }}>
          <strong>Saved</strong>
          <small>{success}</small>
        </div>
      ) : null}

      <p className="settings-flat-note" style={{ marginTop: "0.75rem" }}>
        Linking adds Google sign-in to this Space user. Your rooms, sessions, panes and permissions stay exactly as they are.
      </p>
    </section>
  );
}
