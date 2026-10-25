import { useEffect, useState } from "react";
import type { AuthMe } from "@space/contracts";
import { api, SpaceApiError } from "../../api.js";
import type { ModernColorMode } from "../../ui-theme.js";
import { Lock } from "../ui-theme/app-icons.js";

export function LoginScreen({
  auth,
  colorMode,
  modern,
  onLogin
}: {
  auth: AuthMe;
  colorMode: ModernColorMode | null;
  modern: boolean;
  onLogin: (auth: AuthMe) => void | Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const authErr = params.get("authError");
      if (authErr) {
        setError(decodeURIComponent(authErr));
        const newUrl = window.location.pathname;
        window.history.replaceState({}, document.title, newUrl);
      }
    } catch {
      // Ignore
    }
  }, []);

  function loginErrorMessage(err: unknown): string {
    if (err instanceof SpaceApiError && err.code === "INVALID_CREDENTIALS") {
      return "Login rejected. Use the configured operator credentials, or run 'npx --yes run-spaceapp@latest owner reset-password' in your host terminal to set a new password.";
    }
    return err instanceof Error ? err.message : "Login failed";
  }

  return (
    <main
      className={modern ? "login-shell modern-theme-page" : "login-shell"}
      data-ui-theme={modern ? "modern" : undefined}
      data-color-mode={modern ? colorMode ?? undefined : undefined}
    >
      <form
        className="login-panel"
        onSubmit={(event) => {
          event.preventDefault();
          api
            .login(email, password)
            .then(onLogin)
            .catch((err: unknown) => setError(loginErrorMessage(err)));
        }}
      >
        <div className="brand login-brand">
          <Lock aria-hidden="true" />
          <div>
            <h1>Space</h1>
            <span>{auth.isSetupRequired ? "Operator setup required" : "Sign in to Space"}</span>
          </div>
        </div>

        {auth.googleAuthEnabled ? (
          <div className="google-auth-section" style={{ display: "grid", gap: "0.75rem", margin: "0.25rem 0" }}>
            <a
              href="/api/auth/google/start"
              className="button google-login-button"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "0.65rem",
                padding: "0.6rem 1rem",
                borderRadius: "6px",
                background: "#ffffff",
                color: "#1f1f1f",
                fontWeight: 500,
                fontSize: "0.85rem",
                textDecoration: "none",
                border: "1px solid #dadce0"
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
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
              <span>Sign in with Google</span>
            </a>
            <div
              className="login-divider"
              style={{
                display: "flex",
                alignItems: "center",
                textAlign: "center",
                color: "var(--room-muted, #a7a59e)",
                fontSize: "0.72rem",
                margin: "0.2rem 0"
              }}
            >
              <div style={{ flex: 1, borderBottom: "1px solid var(--room-border, #343638)" }} />
              <span style={{ padding: "0 0.5rem" }}>or continue with email</span>
              <div style={{ flex: 1, borderBottom: "1px solid var(--room-border, #343638)" }} />
            </div>
          </div>
        ) : null}
        <label htmlFor="operator-email">
          Email
          <input
            id="operator-email"
            name="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            type="email"
            autoComplete="username"
          />
        </label>
        <label htmlFor="operator-password">
          Password
          <input
            id="operator-password"
            name="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            autoComplete="current-password"
          />
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <button type="submit">Enter</button>

        <div
          className="login-self-hosted-hint"
          style={{
            marginTop: "1.25rem",
            padding: "0.75rem 0.85rem",
            fontSize: "0.75rem",
            lineHeight: 1.45,
            color: "var(--room-muted, #a7a59e)",
            border: "1px solid var(--room-border, rgba(255, 255, 255, 0.1))",
            borderRadius: "6px",
            background: "rgba(255, 255, 255, 0.02)",
            textAlign: "left"
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: "0.35rem", color: "var(--room-text, #e2e8f0)" }}>
            Self-hosted installation help:
          </div>
          <div style={{ marginBottom: "0.35rem" }}>
            Forgot your operator password? Run in your host terminal:
            <code
              style={{
                display: "block",
                marginTop: "0.25rem",
                padding: "0.25rem 0.4rem",
                background: "rgba(0, 0, 0, 0.35)",
                borderRadius: "4px",
                fontFamily: "monospace",
                fontSize: "0.72rem",
                color: "#67e8f9",
                wordBreak: "break-all"
              }}
            >
              npx --yes run-spaceapp@latest owner reset-password
            </code>
          </div>
          <div>
            Need a clean install from scratch? Run:
            <code
              style={{
                display: "block",
                marginTop: "0.25rem",
                padding: "0.25rem 0.4rem",
                background: "rgba(0, 0, 0, 0.35)",
                borderRadius: "4px",
                fontFamily: "monospace",
                fontSize: "0.72rem",
                color: "#67e8f9",
                wordBreak: "break-all"
              }}
            >
              npx --yes run-spaceapp@latest factory-reset
            </code>
          </div>
        </div>
      </form>
    </main>
  );
}

