import type {
  AdminOperationRun,
  CliMaintenanceRequest,
  CliUpdateAllDetection,
  CliUpdateAllRequest,
  CliUpdateAllResult,
  CreateReleasePreviewInput,
  CreateReleaseRequest,
  ReleasePreview
} from "@space/contracts";
import type {
  CliMaintenanceRecoveryPayload,
  CliMaintenanceReplayPayload
} from "../../live-api.js";
import { Rocket, Wrench, Zap, X } from "../ui-theme/app-icons.js";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent
} from "react";
import { api } from "../../api.js";
import { MaintenancePanel } from "./MaintenancePanel.js";
import { CliUpdateAllPanel } from "./CliUpdateAllPanel.js";
import { ReleasePanel } from "./ReleasePanel.js";
import "./admin-operations.css";

export type AdminOperationTool = "maintenance" | "release" | "update-all";

export interface AdminOperationsClient {
  listCliMaintenanceRuns(): Promise<{ data: AdminOperationRun[] }>;
  getCliMaintenanceReplay(runId: string, afterSequence?: number): Promise<CliMaintenanceReplayPayload>;
  openCliMaintenanceStream(runId: string, afterSequence?: number): EventSource | null;
  cliMaintenanceExportUrl(runId: string): string;
  openCliMaintenanceRecovery(): Promise<CliMaintenanceRecoveryPayload>;
  startCliMaintenance(input: CliMaintenanceRequest): Promise<AdminOperationRun>;
  detectCliUpdateAll(): Promise<CliUpdateAllDetection>;
  runCliUpdateAll(input: CliUpdateAllRequest): Promise<CliUpdateAllResult>;
  createReleasePreview(input: CreateReleasePreviewInput): Promise<ReleasePreview>;
  publishRelease(input: CreateReleaseRequest): Promise<AdminOperationRun>;
  listReleaseRuns(): Promise<{ data: AdminOperationRun[] }>;
}

export function AdminOperationsDialog({
  client = api,
  initialTool,
  onClose
}: {
  client?: AdminOperationsClient;
  initialTool: AdminOperationTool;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [activeTool, setActiveTool] = useState<AdminOperationTool>(initialTool);

  const title = activeTool === "maintenance"
    ? "Space & CLI maintenance"
    : activeTool === "update-all"
      ? "Update all CLI types"
      : "Publish Space release";
  const description = activeTool === "maintenance"
    ? "Repair Space and every managed CLI with live stages, durable history, safe rollback and provider-login handoff."
    : activeTool === "update-all"
      ? "Detect every Space CLI type and update all managed types, including disabled ones, while preserving each custom procedure."
      : "Preview and publish the clean live Space version to the fixed Gitea and GitHub repositories.";
  const HeaderIcon = activeTool === "maintenance" ? Wrench : activeTool === "update-all" ? Zap : Rocket;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const close = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      if (!busy) {
        event.preventDefault();
        close();
      }
      return;
    }
    if (event.key !== "Tab") return;
    const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), textarea:not(:disabled)"
    ) ?? []);
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

  return (
    <div className="admin-operations-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}>
      <section
        ref={dialogRef}
        className="admin-operations-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-busy={busy}
        onKeyDown={handleKeyDown}
      >
        <header className="admin-operations-header">
          <span className="admin-operations-icon"><HeaderIcon aria-hidden="true" /></span>
          <div>
            <h2>{title}</h2>
            <p>{description}</p>
          </div>
          <div className="filter-tabs">
            <button
              type="button"
              className={`filter-tab${activeTool === "maintenance" ? " active" : ""}`}
              disabled={busy}
              onClick={() => setActiveTool("maintenance")}
            >
              Maintenance
            </button>
            <button
              type="button"
              className={`filter-tab${activeTool === "update-all" ? " active" : ""}`}
              disabled={busy}
              onClick={() => setActiveTool("update-all")}
            >
              Update All
            </button>
            <button
              type="button"
              className={`filter-tab${activeTool === "release" ? " active" : ""}`}
              disabled={busy}
              onClick={() => setActiveTool("release")}
            >
              Release
            </button>
          </div>
          <button ref={closeRef} type="button" aria-label={`Close ${title}`} disabled={busy} onClick={close}>
            <X aria-hidden="true" />
          </button>
        </header>
        {activeTool === "maintenance"
          ? <MaintenancePanel client={client} onBusyChange={setBusy} />
          : activeTool === "update-all"
            ? <CliUpdateAllPanel client={client} onBusyChange={setBusy} />
            : <ReleasePanel client={client} onBusyChange={setBusy} />}
      </section>
    </div>
  );
}
