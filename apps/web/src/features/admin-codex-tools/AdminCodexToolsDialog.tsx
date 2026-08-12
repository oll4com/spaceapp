import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent
} from "react";
import { Gauge, ShieldAlert, Trash2, X } from "../ui-theme/app-icons.js";
import type {
  CliSessionCleanupExecuteRequest,
  CliSessionCleanupPreviewResponse,
  CliSessionCleanupResponse,
  CodexHistoryPurgeExecuteRequest,
  CodexHistoryPurgePreviewResponse,
  CodexHistoryPurgeResponse,
  CodexLbSpeedDefaultsResponse,
  CodexLbSpeedTier
} from "@space/contracts";
import { api } from "../../api.js";
import { DEMO_LOCAL_REPLY, getSpaceRuntimeKind } from "../../runtime/SpaceRuntime.js";
import "./admin-codex-tools.css";

export type AdminCodexTool = "speed" | "history" | "cleanup";

export interface AdminCodexToolsClient {
  speedDefaults(): Promise<CodexLbSpeedDefaultsResponse>;
  updateSpeedDefault(
    modelId: CodexLbSpeedDefaultsResponse["models"][number]["modelId"],
    tier: CodexLbSpeedTier
  ): Promise<CodexLbSpeedDefaultsResponse>;
  previewHistoryPurge(): Promise<CodexHistoryPurgePreviewResponse>;
  executeHistoryPurge(
    previewId: string,
    confirmation: CodexHistoryPurgeExecuteRequest["confirmation"]
  ): Promise<CodexHistoryPurgeResponse>;
  previewCliSessionCleanup(): Promise<CliSessionCleanupPreviewResponse>;
  executeCliSessionCleanup(
    previewId: string,
    confirmation: CliSessionCleanupExecuteRequest["confirmation"]
  ): Promise<CliSessionCleanupResponse>;
}

const defaultClient: AdminCodexToolsClient = {
  speedDefaults: () => api.codexLbSpeedDefaults(),
  updateSpeedDefault: (modelId, tier) => api.updateCodexLbSpeedDefault(modelId, tier),
  previewHistoryPurge: () => api.previewCodexHistoryPurge(),
  executeHistoryPurge: (previewId, confirmation) => api.executeCodexHistoryPurge(previewId, confirmation),
  previewCliSessionCleanup: () => api.previewCliSessionCleanup(),
  executeCliSessionCleanup: (previewId, confirmation) => api.executeCliSessionCleanup(previewId, confirmation)
};

const purgeConfirmation = "PURGE HISTORY" as const;
const cleanupConfirmText = "CLEAN CLI SESSIONS" as const;

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

function plural(count: number, singular: string, pluralValue = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

function PurgeCounts({ counts }: {
  counts: CodexHistoryPurgePreviewResponse["candidates"] | CodexHistoryPurgeResponse["purged"];
}) {
  return (
    <dl className="admin-codex-counts" aria-label="History counts">
      <div><dt>Threads</dt><dd>{counts.threads}</dd></div>
      <div><dt>Shared CLI tasks</dt><dd>{counts.cliTasks}</dd></div>
      <div><dt>Index entries</dt><dd>{counts.indexEntries}</dd></div>
      <div><dt>Rollout files</dt><dd>{counts.rolloutFiles}</dd></div>
      <div><dt>Shell snapshots</dt><dd>{counts.shellSnapshots}</dd></div>
    </dl>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function CleanupCounts({ counts }: {
  counts: CliSessionCleanupPreviewResponse["counts"];
}) {
  return (
    <dl className="admin-codex-counts" aria-label="CLI session counts">
      <div><dt>opencode sessions</dt><dd>{counts.opencode.sessions}</dd></div>
      <div><dt>opencode tmp entries</dt><dd>{plural(counts.opencodeTmp.entries, "entry")} · {formatBytes(counts.opencodeTmp.bytes)}</dd></div>
      <div><dt>codex threads</dt><dd>{counts.codex.threads}</dd></div>
      <div><dt>codex orphan rollouts</dt><dd>{counts.codexOrphans.rolloutFiles}</dd></div>
      <div><dt>codex pane homes</dt><dd>{plural(counts.codexPaneHomes.dirs, "dir")} · {formatBytes(counts.codexPaneHomes.bytes)}</dd></div>
      <div><dt>CLI store entries</dt><dd>{counts.cliStores.reduce((sum, store) => sum + store.entries, 0)}</dd></div>
      <div><dt>total space</dt><dd>{formatBytes(counts.totalBytes)}</dd></div>
    </dl>
  );
}

function CleanupResultSummary({ result }: { result: CliSessionCleanupResponse }) {
  const { cleaned, failures } = result;
  return (
    <div className="admin-codex-result">
      <PurgeCounts counts={{
        threads: cleaned.codex.threads,
        cliTasks: 0,
        indexEntries: cleaned.codex.indexEntries,
        rolloutFiles: cleaned.codex.rolloutFiles + cleaned.codexOrphans.rolloutFiles,
        shellSnapshots: cleaned.codex.shellSnapshots
      }} />
      <dl className="admin-codex-counts" aria-label="Cleaned session counts">
        <div><dt>opencode sessions</dt><dd>{cleaned.opencode.sessions}</dd></div>
        <div><dt>opencode mapping files</dt><dd>{cleaned.opencode.mappingFiles}</dd></div>
        <div><dt>opencode tmp entries</dt><dd>{plural(cleaned.opencodeTmp.entries, "entry")} · {formatBytes(cleaned.opencodeTmp.bytes)}</dd></div>
        <div><dt>codex pane homes</dt><dd>{plural(cleaned.codexPaneHomes.dirs, "dir")} · {formatBytes(cleaned.codexPaneHomes.bytes)}</dd></div>
        <div><dt>total space</dt><dd>{formatBytes(result.totalBytes)}</dd></div>
      </dl>
      <p className="admin-codex-alert success" role="status" aria-live="polite">
        {result.status === "NOOP"
          ? "Nothing removable was found."
          : result.status === "PARTIAL"
            ? `Cleanup completed with ${plural(failures.length, "failure")}.`
            : "Cleanup completed successfully."}
      </p>
      {failures.length > 0 ? <ul className="admin-codex-failures">
        {failures.slice(0, 10).map((failure, index) => <li key={index}>{failure}</li>)}
      </ul> : null}
    </div>
  );
}

export function AdminCodexToolsDialog({
  client = defaultClient,
  initialTool,
  isCodexEnabled = true,
  anyCliEnabled = true,
  onClose
}: {
  client?: AdminCodexToolsClient;
  initialTool: AdminCodexTool;
  isCodexEnabled?: boolean;
  anyCliEnabled?: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [speed, setSpeed] = useState<CodexLbSpeedDefaultsResponse | null>(null);
  const [speedLoading, setSpeedLoading] = useState(initialTool === "speed" && isCodexEnabled);
  const [speedUpdatingModel, setSpeedUpdatingModel] = useState<string | null>(null);
  const [speedError, setSpeedError] = useState<string | null>(null);
  const [speedMessage, setSpeedMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<CodexHistoryPurgePreviewResponse | null>(null);
  const [purgeResult, setPurgeResult] = useState<CodexHistoryPurgeResponse | null>(null);
  const [purgeBusy, setPurgeBusy] = useState(false);
  const [purgeError, setPurgeError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [cleanupPreview, setCleanupPreview] = useState<CliSessionCleanupPreviewResponse | null>(null);
  const [cleanupResult, setCleanupResult] = useState<CliSessionCleanupResponse | null>(null);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [cleanupConfirmation, setCleanupConfirmation] = useState("");
  const busy = speedLoading || Boolean(speedUpdatingModel) || purgeBusy || cleanupBusy;

  const loadSpeed = useCallback(async () => {
    if (!isCodexEnabled) return;
    setSpeedLoading(true);
    setSpeedError(null);
    try {
      setSpeed(await client.speedDefaults());
    } catch (reason) {
      setSpeedError(errorMessage(reason, "Codex-LB speed defaults are unavailable."));
    } finally {
      setSpeedLoading(false);
    }
  }, [client, isCodexEnabled]);

  useEffect(() => {
    const focusFrame = window.requestAnimationFrame(() => closeRef.current?.focus());
    if (initialTool === "speed" && isCodexEnabled) void loadSpeed();
    if (!isCodexEnabled) setSpeedLoading(false);
    return () => window.cancelAnimationFrame(focusFrame);
  }, [initialTool, isCodexEnabled, loadSpeed]);

  function close() {
    if (!busy) onClose();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      if (!busy) {
        event.preventDefault();
        onClose();
      }
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)"));
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function updateSpeed(
    modelId: CodexLbSpeedDefaultsResponse["models"][number]["modelId"],
    displayName: string,
    tier: CodexLbSpeedTier
  ) {
    if (!isCodexEnabled || speedUpdatingModel) return;
    setSpeedUpdatingModel(modelId);
    setSpeedError(null);
    setSpeedMessage(null);
    try {
      setSpeed(await client.updateSpeedDefault(modelId, tier));
      setSpeedMessage(getSpaceRuntimeKind() === "demo"
        ? DEMO_LOCAL_REPLY
        : `${displayName} now uses ${tier === "FAST" ? "Fast" : "Standard"}.`);
    } catch (reason) {
      setSpeedError(errorMessage(reason, "Codex-LB speed update failed."));
    } finally {
      setSpeedUpdatingModel(null);
    }
  }

  async function previewPurge() {
    if (!anyCliEnabled || purgeBusy) return;
    setPurgeBusy(true);
    setPurgeError(null);
    setPurgeResult(null);
    setConfirmation("");
    try {
      setPreview(await client.previewHistoryPurge());
    } catch (reason) {
      setPreview(null);
      setPurgeError(errorMessage(reason, "History purge preview failed."));
    } finally {
      setPurgeBusy(false);
    }
  }

  async function executePurge() {
    if (!anyCliEnabled || purgeBusy || preview?.status !== "READY" || confirmation !== purgeConfirmation) return;
    setPurgeBusy(true);
    setPurgeError(null);
    try {
      setPurgeResult(await client.executeHistoryPurge(preview.previewId, purgeConfirmation));
      setConfirmation("");
    } catch (reason) {
      setPurgeError(errorMessage(reason, "History purge failed."));
    } finally {
      setPurgeBusy(false);
    }
  }

  async function previewCleanup() {
    if (!anyCliEnabled || cleanupBusy) return;
    setCleanupBusy(true);
    setCleanupError(null);
    setCleanupResult(null);
    setCleanupConfirmation("");
    try {
      setCleanupPreview(await client.previewCliSessionCleanup());
    } catch (reason) {
      setCleanupPreview(null);
      setCleanupError(errorMessage(reason, "CLI session cleanup preview failed."));
    } finally {
      setCleanupBusy(false);
    }
  }

  async function executeCleanup() {
    if (!anyCliEnabled || cleanupBusy || cleanupPreview?.status !== "READY" || cleanupConfirmation !== cleanupConfirmText) return;
    setCleanupBusy(true);
    setCleanupError(null);
    try {
      setCleanupResult(await client.executeCliSessionCleanup(cleanupPreview.previewId, cleanupConfirmText));
      setCleanupConfirmation("");
    } catch (reason) {
      setCleanupError(errorMessage(reason, "CLI session cleanup failed."));
    } finally {
      setCleanupBusy(false);
    }
  }

  const isSpeed = initialTool === "speed";
  const isCleanup = initialTool === "cleanup";
  const title = isSpeed ? "Codex-LB speed control" : (isCleanup ? "Clean CLI sessions" : "Purge history");
  const HeaderIcon = isSpeed ? Gauge : Trash2;

  return (
    <div className="admin-codex-tools-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}>
      <section
        ref={dialogRef}
        className="admin-codex-tools-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-busy={busy}
        onKeyDown={handleKeyDown}
      >
        <header className="admin-codex-tools-header">
          <span className={isSpeed ? "admin-codex-tools-icon" : "admin-codex-tools-icon danger"}>
            <HeaderIcon aria-hidden="true" />
          </span>
          <div>
            <h2>{title}</h2>
            <p>{isSpeed
              ? "Choose the global Standard or Fast default for each supported model."
              : isCleanup
                ? "Remove empty CLI sessions, orphaned codex pane homes and disposable CLI store files."
                : "Remove inactive task history only after a fresh server-side preview."}</p>
          </div>
          {isSpeed ? (!isCodexEnabled ? <span className="status muted">OFF</span> : null) : (!anyCliEnabled ? <span className="status muted">OFF</span> : null)}
          <button ref={closeRef} type="button" aria-label={`Close ${title}`} disabled={busy} onClick={close}>
            <X aria-hidden="true" />
          </button>
        </header>

        {isSpeed ? (
          <div className="admin-codex-tools-content">
            {!isCodexEnabled ? <p role="status">Enable Codex in Settings to use speed controls.</p> : null}
            {speedLoading ? <p role="status">Loading Codex-LB speed defaults…</p> : null}
            {speedError ? <div className="admin-codex-alert error" role="alert">
              <span>{speedError}</span>
              {!speed ? (
                <button
                  type="button"
                  disabled={!isCodexEnabled}
                  title={!isCodexEnabled ? "Enable Codex in Settings" : undefined}
                  onClick={() => void loadSpeed()}
                >
                  Retry
                </button>
              ) : null}
            </div> : null}
            {speed ? <div className="admin-codex-speed-list">
              {speed.models.map((model) => (
                <div className="admin-codex-speed-row" key={model.modelId}>
                  <div><strong>{model.displayName}</strong><small>{model.modelId}</small></div>
                  <div className="admin-codex-segmented" role="group" aria-label={`${model.displayName} speed tier`}>
                    {(["STANDARD", "FAST"] as const).map((tier) => (
                      <button
                        key={tier}
                        type="button"
                        aria-label={`Set ${model.displayName} to ${tier === "FAST" ? "Fast" : "Standard"}`}
                        aria-pressed={model.tier === tier}
                        disabled={!isCodexEnabled || Boolean(speedUpdatingModel) || model.tier === tier}
                        title={!isCodexEnabled ? "Enable Codex in Settings" : undefined}
                        onClick={() => void updateSpeed(model.modelId, model.displayName, tier)}
                      >
                        {tier === "FAST" ? "Fast" : "Standard"}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div> : null}
            {speedMessage ? <p className="admin-codex-alert success" role="status" aria-live="polite">{speedMessage}</p> : null}
            <p className="admin-codex-tools-note">Changes are global and apply only to the currently advertised provider model selected here.</p>
          </div>
        ) : isCleanup ? (
          <div className="admin-codex-tools-content">
            <div className="admin-codex-warning">
              <ShieldAlert aria-hidden="true" />
              <p>In-use CLI sessions, active pane homes and native codex history are protected. The server rechecks usage immediately before cleanup.</p>
            </div>
            {!cleanupPreview && !cleanupResult ? (
              <button
                className="admin-codex-primary"
                type="button"
                disabled={!anyCliEnabled || cleanupBusy}
                title={!anyCliEnabled ? "Enable a CLI in Settings" : undefined}
                onClick={() => void previewCleanup()}
              >
                {cleanupBusy ? "Preparing preview…" : "Preview CLI session cleanup"}
              </button>
            ) : null}
            {cleanupPreview && !cleanupResult ? <div className="admin-codex-preview">
              <div className="admin-codex-preview-heading">
                <strong>{cleanupPreview.status === "READY" ? "Removable CLI sessions" : "Nothing to clean"}</strong>
              </div>
              <CleanupCounts counts={cleanupPreview.counts} />
              {cleanupPreview.status === "NOOP" ? <p className="admin-codex-alert success" role="status">No removable CLI sessions were found.</p> : null}
            </div> : null}
            {cleanupPreview?.status === "READY" && !cleanupResult ? <div className="admin-codex-confirmation">
              <label htmlFor="cli-session-cleanup-confirmation">Type <code>{cleanupConfirmText}</code> to confirm</label>
              <input
                id="cli-session-cleanup-confirmation"
                aria-label="Type CLEAN CLI SESSIONS to confirm"
                autoComplete="off"
                spellCheck={false}
                value={cleanupConfirmation}
                disabled={!anyCliEnabled || cleanupBusy}
                title={!anyCliEnabled ? "Enable a CLI in Settings" : undefined}
                onChange={(event) => setCleanupConfirmation(event.currentTarget.value)}
              />
              <button
                type="button"
                className="danger"
                disabled={!anyCliEnabled || cleanupBusy || cleanupConfirmation !== cleanupConfirmText}
                title={!anyCliEnabled ? "Enable a CLI in Settings" : undefined}
                onClick={() => void executeCleanup()}
              >
                {cleanupBusy ? "Cleaning…" : "Clean CLI sessions"}
              </button>
            </div> : null}
            {cleanupResult ? <CleanupResultSummary result={cleanupResult} /> : null}
            {cleanupError ? <p className="admin-codex-alert error" role="alert">{cleanupError}</p> : null}
          </div>
        ) : (
          <div className="admin-codex-tools-content">
            <div className="admin-codex-warning">
              <ShieldAlert aria-hidden="true" />
              <p>Active Space CLI and Chat threads stay protected. The server rechecks them again immediately before purge.</p>
            </div>
            {!preview && !purgeResult ? (
              <button
                className="admin-codex-primary"
                type="button"
                disabled={!anyCliEnabled || purgeBusy}
                title={!anyCliEnabled ? "Enable a CLI in Settings" : undefined}
                onClick={() => void previewPurge()}
              >
                {purgeBusy ? "Preparing preview…" : "Preview history purge"}
              </button>
            ) : null}
            {preview && !purgeResult ? <div className="admin-codex-preview">
              <div className="admin-codex-preview-heading">
                <strong>{preview.status === "READY" ? "Removable history" : "Nothing to purge"}</strong>
                <small>{preview.protectedThreads} active protected</small>
              </div>
              <PurgeCounts counts={preview.candidates} />
              <p>{plural(preview.protectedThreads, "active thread")} {preview.protectedThreads === 1 ? "is" : "are"} protected.</p>
              {preview.status === "NOOP" ? <p className="admin-codex-alert success" role="status">No removable history was found.</p> : null}
            </div> : null}
            {preview?.status === "READY" && !purgeResult ? <div className="admin-codex-confirmation">
              <label htmlFor="codex-history-purge-confirmation">Type <code>{purgeConfirmation}</code> to confirm</label>
              <input
                id="codex-history-purge-confirmation"
                aria-label="Type PURGE HISTORY to confirm"
                autoComplete="off"
                spellCheck={false}
                value={confirmation}
                disabled={!anyCliEnabled || purgeBusy}
                title={!anyCliEnabled ? "Enable a CLI in Settings" : undefined}
                onChange={(event) => setConfirmation(event.currentTarget.value)}
              />
              <button
                type="button"
                className="danger"
                disabled={!anyCliEnabled || purgeBusy || confirmation !== purgeConfirmation}
                title={!anyCliEnabled ? "Enable a CLI in Settings" : undefined}
                onClick={() => void executePurge()}
              >
                {purgeBusy ? "Purging…" : "Purge history"}
              </button>
            </div> : null}
            {purgeResult ? <div className="admin-codex-result">
              <PurgeCounts counts={purgeResult.purged} />
              <p className="admin-codex-alert success" role="status" aria-live="polite">
                {purgeResult.status === "NOOP"
                  ? "No history was removed."
                  : `${plural(purgeResult.purged.threads, "native thread")} and ${plural(
                    purgeResult.purged.cliTasks,
                    "shared CLI task"
                  )} purged.`}
              </p>
              {purgeResult.newlyProtectedThreads > 0 ? <p>
                {plural(purgeResult.newlyProtectedThreads, "thread")} became protected after preview and {purgeResult.newlyProtectedThreads === 1 ? "was" : "were"} not removed.
              </p> : null}
            </div> : null}
            {purgeError ? <p className="admin-codex-alert error" role="alert">{purgeError}</p> : null}
          </div>
        )}
      </section>
    </div>
  );
}
