import { createPortal } from "react-dom";
import { CheckCheck, RefreshCw, X } from "lucide-react";
import type { RefObject } from "react";
import type { SetupOverview } from "@space/contracts";
import { SetupConnectionCard } from "./SetupConnectionCard.js";
import {
  useSetupConnectionsWizard,
  type SetupConnectionChecksClient
} from "./useSetupConnectionsWizard.js";
import "./setup-connections.css";

interface SetupConnectionsWizardProps {
  checks: SetupConnectionChecksClient;
  open: boolean;
  finish: () => Promise<SetupOverview>;
  loadOverview: () => Promise<SetupOverview>;
  onOpenChange: (open: boolean) => void;
  openLogin: (connectionId: string) => Promise<void>;
  onOpenMaintenance?: () => void;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  replayIntervalMs?: number;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function SetupConnectionsWizard({
  checks,
  open,
  finish,
  loadOverview,
  onOpenChange,
  openLogin,
  onOpenMaintenance,
  pollIntervalMs = 2_000,
  pollTimeoutMs = 10 * 60 * 1_000,
  replayIntervalMs = 2_000,
  triggerRef
}: SetupConnectionsWizardProps) {
  const wizard = useSetupConnectionsWizard({
    checks,
    finish,
    loadOverview,
    onOpenChange,
    open,
    openLogin,
    pollIntervalMs,
    pollTimeoutMs,
    replayIntervalMs,
    triggerRef
  });

  if (!open) return null;
  const summary = wizard.overview?.summary ?? {
    total: 0,
    functional: 0,
    liveVerified: 0,
    needsSetup: 0
  };
  const completedConnectionIds = new Set(
    wizard.checkEvents
      .filter((event) => event.state === "COMPLETED")
      .map((event) => event.connectionId)
  );
  const activeRun = wizard.checkRun?.status === "RUNNING";

  return createPortal(
    <div className="setup-connections-backdrop" onClick={wizard.dismiss}>
      <section
        ref={wizard.dialogRef}
        className="setup-connections-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-connections-title"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={wizard.handleKeyDown}
      >
        <header className="setup-connections-header">
          <div>
            <span>SpaceApp onboarding</span>
            <h2 id="setup-connections-title" ref={wizard.headingRef} tabIndex={-1}>
              Setup &amp; connections
            </h2>
            <p>
              Functional means the CLI is installed, launchable, and has a recognized credential.
              Live verification is stronger provider evidence and is tracked separately.
            </p>
          </div>
          <button type="button" aria-label="Close Setup & connections" onClick={wizard.dismiss}>
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="setup-connections-summary" aria-label="CLI setup summary">
          <div>
            <strong>{summary.functional} of {summary.total} functional</strong>
            <span>Ready in Space</span>
          </div>
          <div>
            <strong>{summary.liveVerified} live verified</strong>
            <span>Fresh provider evidence</span>
          </div>
          <div>
            <strong>{summary.needsSetup} needs setup</strong>
            <span>Login or runtime action required</span>
          </div>
        </div>

        {wizard.checkRun ? (
          <div className="setup-connections-run-progress" role="status" aria-live="polite">
            <div>
              <strong>
                {wizard.checkRun.completedCount} of {wizard.checkRun.totalCount} completed
              </strong>
              <span>Elapsed {formatElapsed(wizard.elapsedSeconds)}</span>
            </div>
            <progress
              aria-label="CLI check progress"
              value={wizard.checkRun.completedCount}
              max={wizard.checkRun.totalCount}
            />
          </div>
        ) : (
          <progress
            className="setup-connections-functional-progress"
            aria-label="Functional CLI setup progress"
            value={summary.functional}
            max={Math.max(summary.total, 1)}
          />
        )}

        {wizard.notice ? (
          <p className="setup-connections-notice" role="status"><span>{wizard.notice}</span><button type="button" className="notice-close" aria-label="Dismiss message" onClick={wizard.dismissNotice}><X aria-hidden="true" /></button></p>
        ) : null}
        {wizard.streamNotice ? (
          <p className="setup-connections-stream-notice" role="status"><span>{wizard.streamNotice}</span><button type="button" className="notice-close" aria-label="Dismiss message" onClick={wizard.dismissStreamNotice}><X aria-hidden="true" /></button></p>
        ) : null}
        {wizard.error ? (
          <p className="setup-connections-error" role="alert"><span>{wizard.error}</span><button type="button" className="notice-close" aria-label="Dismiss message" onClick={wizard.dismissError}><X aria-hidden="true" /></button></p>
        ) : null}

        <div className="setup-connections-toolbar">
          <p>
            Checks run independently and continue on the server if you finish or close this wizard.
          </p>
          <button
            type="button"
            disabled={wizard.checkAllPending || wizard.loading || activeRun || !summary.total}
            onClick={() => void wizard.checkAll()}
          >
            {wizard.checkAllPending || activeRun
              ? <RefreshCw className="is-spinning" aria-hidden="true" />
              : <CheckCheck aria-hidden="true" />}
            Check all CLIs
          </button>
        </div>

        <div className="setup-connections-list" aria-busy={wizard.loading}>
          {wizard.loading && !wizard.overview ? (
            <p className="setup-connections-empty" role="status">Detecting CLIs…</p>
          ) : null}

          {!wizard.loading && wizard.overview?.connections.length === 0 ? (
            <div className="setup-connections-empty">
              <p>No setup connections are available in this installation.</p>
              <button type="button" onClick={() => void wizard.refreshOverview()}>Retry</button>
            </div>
          ) : null}

          {wizard.overview?.connections.map((connection) => {
            const connectionEvents = wizard.checkEvents.filter((event) =>
              event.connectionId === connection.id
            );
            const checking =
              wizard.pendingIds.has(connection.id) ||
              wizard.waitingConnectionId === connection.id ||
              Boolean(
                activeRun &&
                wizard.checkRun?.connectionIds.includes(connection.id) &&
                !completedConnectionIds.has(connection.id)
              );
            return (
              <SetupConnectionCard
                key={connection.id}
                checking={checking}
                connection={connection}
                events={connectionEvents}
                onCheck={() => void wizard.checkConnection(connection)}
                onConnect={() => void wizard.connect(connection)}
                onOpenMaintenance={onOpenMaintenance}
              />
            );
          })}
        </div>

        <footer className="setup-connections-footer">
          <span>
            Finish for now closes this wizard without cancelling an active CLI check.
          </span>
          <button
            type="button"
            disabled={wizard.finishPending}
            onClick={() => void wizard.finishNow()}
          >
            {wizard.finishPending ? "Saving…" : "Finish for now"}
          </button>
        </footer>
      </section>
    </div>,
    document.body
  );
}
