import type { ReactNode } from "react";
import { ServerCog, Terminal, X } from "../ui-theme/app-icons.js";
import type { RestartDialogController } from "./useManageController.js";

function RestartConfirmDialog({ controller, title, summary, icon, iconClassName, detail, confirmLabel }: {
  controller: RestartDialogController;
  title: string;
  summary: string;
  icon: ReactNode;
  iconClassName: string;
  detail: string;
  confirmLabel: string;
}) {
  const { pending, message, error, close, confirm, dismissMessage, dismissError } = controller;
  return (
    <div
      className="attachment-modal server-restart-modal"
      onClick={close}
    >
      <section
        className="attachment-modal-body server-restart-modal-body"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !pending) {
            event.preventDefault();
            close();
          }
        }}
      >
        <header>
          <span className={iconClassName}>
            {icon}
          </span>
          <div>
            <h3>{title}</h3>
            <p>{summary}</p>
          </div>
          <button
            type="button"
            aria-label={`Close ${title}`}
            disabled={pending}
            onClick={close}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <p>{detail}</p>
        {message ? <p className="server-restart-status" role="status"><span>{message}</span><button type="button" className="notice-close" aria-label="Dismiss message" onClick={dismissMessage}><X aria-hidden="true" /></button></p> : null}
        {error ? <p className="server-restart-error" role="alert"><span>{error}</span><button type="button" className="notice-close" aria-label="Dismiss message" onClick={dismissError}><X aria-hidden="true" /></button></p> : null}
        <div className="server-restart-modal-actions">
          <button type="button" autoFocus onClick={close} disabled={pending}>
            Cancel
          </button>
          <button type="button" className="danger" onClick={() => void confirm()} disabled={pending}>
            {pending ? "Restarting..." : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

export function ServerRestartDialog({ controller }: { controller: RestartDialogController }) {
  return (
    <RestartConfirmDialog
      controller={controller}
      title="Restart Space server"
      summary="Restarts space-worker.service, space-api.service, and space-web.service."
      icon={<ServerCog aria-hidden="true" />}
      iconClassName="server-restart-modal-icon warning"
      detail="CLI and browser sessions stay protected because codex-pane-host, the admin host, and the browser host are not restarted."
      confirmLabel="Restart server"
    />
  );
}

export function CliRuntimeRestartAllDialog({ controller }: { controller: RestartDialogController }) {
  return (
    <RestartConfirmDialog
      controller={controller}
      title="Restart all CLI runtimes"
      summary="Stops and restarts the sessions of every CLI type one after another."
      icon={<Terminal aria-hidden="true" />}
      iconClassName="server-restart-modal-icon"
      detail="Codex, claude, gemini, opencode, kimi, and the other CLI runtimes are restarted individually; the pane host service itself is not restarted."
      confirmLabel="Restart all CLI runtimes"
    />
  );
}
