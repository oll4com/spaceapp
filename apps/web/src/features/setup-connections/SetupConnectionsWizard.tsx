import { createPortal } from "react-dom";
import { Check as CheckCheck, RefreshCw, X } from "../ui-theme/app-icons.js";
import { useEffect, useState, type ReactNode, type RefObject } from "react";
import type { SetupOverview } from "@space/contracts";
import { SetupConnectionCard } from "./SetupConnectionCard.js";
import {
  useSetupConnectionsWizard,
  type SetupConnectionChecksClient
} from "./useSetupConnectionsWizard.js";
import "./setup-connections.css";

interface SetupConnectionsWizardProps {
  guided?: boolean;
  connectionsContent?: ReactNode;
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
  guided = false,
  connectionsContent,
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
  const [step, setStep] = useState(0);
  const [showAllTools, setShowAllTools] = useState(false);
  const [connectionsVisited, setConnectionsVisited] = useState(false);
  useEffect(() => { if (step === 2) setConnectionsVisited(true); }, [step]);
  const steps = ["Welcome", "Tools", "Connections", "Ready"];
  useEffect(() => {
    if (open) { setStep(0); setShowAllTools(false); }
  }, [open]);
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
  const toolConnections = [...(wizard.overview?.connections ?? [])].sort((a, b) =>
    Number(b.id === "cli:opencode") - Number(a.id === "cli:opencode"));
  const visibleConnections = guided && !showAllTools && toolConnections.some(connection => connection.id === "cli:opencode")
    ? toolConnections.filter(connection => connection.id === "cli:opencode")
    : toolConnections;

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
            <span>Space setup</span>
            <h2 id="setup-connections-title" ref={wizard.headingRef} tabIndex={-1}>
              Setup &amp; connections
            </h2>
            <p>
              {guided ? "Set up what you need now. You can return here to add more tools at any time." :
                "Functional means the CLI is installed, launchable, and has a recognized credential. Live verification is stronger provider evidence and is tracked separately."}
            </p>
          </div>
          <button type="button" aria-label="Close Setup & connections" onClick={wizard.dismiss}>
            <X aria-hidden="true" />
          </button>
        </header>

        {guided ? <nav className="setup-guide-steps" aria-label="Setup steps">
          {steps.map((label, index) => <button key={label} type="button" aria-current={step === index ? "step" : undefined}
            onClick={() => setStep(index)}><span>{index + 1}</span>{label}</button>)}
        </nav> : null}
        {guided && step === 0 ? <div className="setup-guide-intro">
          <h3>Your workspace, one step at a time</h3>
          <p>Start with one coding assistant. Add other tools and connections whenever you need them.</p>
          <dl>
            <div><dt>Rooms</dt><dd>Separate workspaces for projects. Switch between them while your tools keep working.</dd></div>
            <div><dt>Panes</dt><dd>A CLI, Chat, or Browser inside a room. Use Create to add one.</dd></div>
            <div><dt>Docks</dt><dd>Open files, tasks, notes, and settings from the Workspace menu.</dd></div>
          </dl>
          <p>User mode keeps daily actions close. Administrators can switch to Admin mode for installation settings and maintenance.</p>
        </div> : null}

        <div hidden={guided && step !== 1} className="setup-guide-tools">
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

        {guided ? <div className="setup-guide-tool-choice">
          <p><strong>Recommended first tool: OpenCode</strong><br />Starts with the free DeepSeek V4 Flash model. Tools already set up stay ready.</p>
          <button type="button" onClick={() => setShowAllTools(!showAllTools)}>
            {showAllTools ? "Show recommended tool" : "Show all tools"}
          </button>
        </div> : null}
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

          {visibleConnections.map((connection) => {
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
        </div>

        {guided ? <div hidden={step !== 2} className="setup-guide-connections">
          <h3>Optional connections & defaults</h3>
          <p>Open only what you want to configure. These settings are also available under Admin → Advanced settings.</p>
          {connectionsVisited ? connectionsContent ?? <p>No additional connections are available for this account.</p> : null}
        </div> : null}
        {guided && step === 3 ? <div className="setup-guide-intro" aria-label="Setup result">
          <h3>{summary.functional ? "You can start working" : "Continue when you are ready"}</h3>
          <p>{summary.functional} of {summary.total} tools are ready to launch. {summary.needsSetup} still need setup.</p>
          <p>Open Rooms to choose or create a workspace, then use Create to add a CLI, Chat, or Browser pane.</p>
          <p>You can reopen this wizard from Help → Setup wizard. Optional connections can be added later.</p>
        </div> : null}

        <footer className="setup-connections-footer">
          {guided && step !== 1 && wizard.error ? <p role="alert" className="setup-connections-error">{wizard.error}</p> : null}
          <span>
            Finish for now closes this wizard without cancelling an active CLI check.
          </span>
          {guided && step > 0 ? <button type="button" onClick={() => setStep(step - 1)}>Back</button> : null}
          {guided && step < 3 ? <button type="button" onClick={() => setStep(step + 1)}>Continue</button> : null}
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
