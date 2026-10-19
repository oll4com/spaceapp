import { useState } from "react";
import type { AuthMe } from "@space/contracts";
import { api } from "../../api.js";
import type { ModernColorMode } from "../../ui-theme.js";
import { Lock } from "../ui-theme/app-icons.js";

/** The invite link is `/invite#token=<token>`: the fragment never reaches a server log. */
export function readInviteToken(location: Pick<Location, "pathname" | "hash">): string | null {
  if (location.pathname.replace(/\/+$/, "") !== "/invite") return null;
  return new URLSearchParams(location.hash.replace(/^#/, "")).get("token") || null;
}

export function InviteAcceptScreen({
  token,
  colorMode,
  modern,
  onLogin
}: {
  token: string;
  colorMode: ModernColorMode | null;
  modern: boolean;
  onLogin: (auth: AuthMe) => void | Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
          if (password.length < 12) return setError("Use at least 12 characters.");
          if (password !== confirmation) return setError("The passwords do not match.");
          setBusy(true);
          setError(null);
          api
            .acceptUserInvite(token, password)
            .then((auth) => {
              window.history.replaceState({}, document.title, "/");
              return onLogin(auth);
            })
            .catch((err: unknown) => setError(err instanceof Error ? err.message : "The invite could not be accepted."))
            .finally(() => setBusy(false));
        }}
      >
        <div className="brand login-brand">
          <Lock aria-hidden="true" />
          <div>
            <h1>Space</h1>
            <span>Accept your invite</span>
          </div>
        </div>
        <label htmlFor="invite-password">
          Password
          <input
            id="invite-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            autoComplete="new-password"
          />
        </label>
        <label htmlFor="invite-password-confirmation">
          Repeat password
          <input
            id="invite-password-confirmation"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            type="password"
            autoComplete="new-password"
          />
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <button type="submit" disabled={busy}>Create account</button>
      </form>
    </main>
  );
}
