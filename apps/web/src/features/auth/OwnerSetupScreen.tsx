import { KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { SetupClaimInput } from "@space/contracts";

type SetupField = keyof SetupClaimInput | "confirmation";
type SetupFieldErrors = Partial<Record<SetupField, string>>;

interface OwnerSetupScreenProps {
  expiresAt: string | null;
  onClaim: (input: SetupClaimInput) => Promise<void>;
}

function setupExpiryLabel(expiresAt: string | null): string | null {
  if (!expiresAt) return null;
  const expires = new Date(expiresAt);
  if (!Number.isFinite(expires.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(expires);
}

function validateSetup(input: SetupClaimInput, confirmation: string): SetupFieldErrors {
  const errors: SetupFieldErrors = {};
  if (input.token.length < 32) {
    errors.token = "The setup token must contain at least 32 characters.";
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
    errors.email = "Enter a valid email address.";
  }
  if (input.password.length < 12) {
    errors.password = "The password must contain at least 12 characters.";
  }
  if (input.password !== confirmation) {
    errors.confirmation = "The passwords do not match.";
  }
  return errors;
}

export function OwnerSetupScreen({ expiresAt, onClaim }: OwnerSetupScreenProps) {
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [fieldErrors, setFieldErrors] = useState<SetupFieldErrors>({});
  const [claimError, setClaimError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const expiryLabel = setupExpiryLabel(expiresAt);

  function clearFieldError(field: SetupField) {
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const input = {
      token: token.trim(),
      email: email.trim(),
      password
    };
    const nextErrors = validateSetup(input, confirmation);
    setFieldErrors(nextErrors);
    setClaimError(null);
    if (Object.keys(nextErrors).length > 0) return;

    setPending(true);
    try {
      await onClaim(input);
    } catch (error) {
      setClaimError(error instanceof Error ? error.message : "Owner setup could not be completed.");
      setPending(false);
    }
  }

  return (
    <main className="login-shell setup-shell">
      <form className="login-panel setup-panel" onSubmit={(event) => void submit(event)} noValidate>
        <div className="brand login-brand setup-brand">
          <ShieldCheck aria-hidden="true" />
          <div>
            <h1>Create your Space owner</h1>
            <span>One private account controls this installation</span>
          </div>
        </div>

        <p className="setup-intro">
          Use the one-time token shown at the end of <code>spaceapp install</code>, then choose the
          email and password you will use to sign in. If the token expires, run{" "}
          <code>spaceapp owner rotate-setup-token</code> and paste the new token here.
        </p>

        <div className="setup-security-note">
          <KeyRound aria-hidden="true" />
          <p>
            The token and password are sent only in the request body. Space does not place them in
            the URL or browser storage.
          </p>
        </div>

        <section className="setup-next-steps" aria-labelledby="space-setup-next-steps-title">
          <h2 id="space-setup-next-steps-title">After you sign in</h2>
          <ol>
            <li>Register only the workspaces this installation may access.</li>
            <li>Connect one provider at a time through official login or masked credential input.</li>
            <li>Create a test room, then make a backup before any update.</li>
          </ol>
        </section>

        {expiryLabel ? <p className="setup-expiry">Setup token expires {expiryLabel}.</p> : null}

        <label htmlFor="space-setup-token">
          One-time setup token
          <input
            id="space-setup-token"
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
              clearFieldError("token");
            }}
            type="password"
            autoComplete="one-time-code"
            spellCheck={false}
            aria-invalid={Boolean(fieldErrors.token)}
            aria-describedby={fieldErrors.token ? "space-setup-token-error" : undefined}
            disabled={pending}
            autoFocus
          />
        </label>
        {fieldErrors.token ? <p id="space-setup-token-error" className="form-field-error">{fieldErrors.token}</p> : null}

        <label htmlFor="space-owner-email">
          Owner email
          <input
            id="space-owner-email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              clearFieldError("email");
            }}
            type="email"
            inputMode="email"
            autoComplete="username"
            aria-invalid={Boolean(fieldErrors.email)}
            aria-describedby={fieldErrors.email ? "space-owner-email-error" : undefined}
            disabled={pending}
          />
        </label>
        {fieldErrors.email ? <p id="space-owner-email-error" className="form-field-error">{fieldErrors.email}</p> : null}

        <label htmlFor="space-owner-password">
          New password
          <input
            id="space-owner-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              clearFieldError("password");
              clearFieldError("confirmation");
            }}
            type="password"
            autoComplete="new-password"
            aria-invalid={Boolean(fieldErrors.password)}
            aria-describedby={fieldErrors.password ? "space-owner-password-error" : "space-owner-password-help"}
            disabled={pending}
          />
        </label>
        <p id="space-owner-password-help" className="form-help">Use at least 12 characters.</p>
        {fieldErrors.password ? <p id="space-owner-password-error" className="form-field-error">{fieldErrors.password}</p> : null}

        <label htmlFor="space-owner-password-confirmation">
          Confirm password
          <input
            id="space-owner-password-confirmation"
            value={confirmation}
            onChange={(event) => {
              setConfirmation(event.target.value);
              clearFieldError("confirmation");
            }}
            type="password"
            autoComplete="new-password"
            aria-invalid={Boolean(fieldErrors.confirmation)}
            aria-describedby={fieldErrors.confirmation ? "space-owner-confirmation-error" : undefined}
            disabled={pending}
          />
        </label>
        {fieldErrors.confirmation ? (
          <p id="space-owner-confirmation-error" className="form-field-error">{fieldErrors.confirmation}</p>
        ) : null}

        {claimError ? <p className="form-error" role="alert">{claimError}</p> : null}

        <button type="submit" disabled={pending} aria-busy={pending}>
          {pending ? <Loader2 className="setup-spinner" aria-hidden="true" /> : null}
          {pending ? "Creating owner..." : "Create owner account"}
        </button>
      </form>
    </main>
  );
}
