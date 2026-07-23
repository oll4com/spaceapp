import { Loader2, ShieldCheck } from "lucide-react";

export function AuthenticationBootstrap({
  error,
  onRetry
}: {
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <main className="login-shell">
      <section className="login-panel auth-bootstrap-panel" aria-live="polite">
        <div className="brand login-brand">
          <ShieldCheck aria-hidden="true" />
          <div>
            <h1>Space</h1>
            <span>Secure owner access</span>
          </div>
        </div>
        {error ? (
          <>
            <p className="form-error" role="alert">Space could not check owner setup. {error}</p>
            <button type="button" onClick={onRetry}>Try again</button>
          </>
        ) : (
          <p className="auth-bootstrap-status" role="status">
            <Loader2 className="setup-spinner" aria-hidden="true" />
            Checking owner setup...
          </p>
        )}
      </section>
    </main>
  );
}
