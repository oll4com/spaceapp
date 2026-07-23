import type {
  AdminOperationRun,
  CliMaintenanceRequest,
  CreateReleasePreviewInput,
  CreateReleaseRequest,
  ReleasePreview
} from "@space/contracts";
import { Rocket, Wrench, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent
} from "react";
import { api } from "../../api.js";
import { MaintenancePanel } from "./MaintenancePanel.js";
import { ReleasePanel } from "./ReleasePanel.js";
import "./admin-operations.css";

export type AdminOperationTool = "maintenance" | "release";

export interface AdminOperationsClient {
  listCliMaintenanceRuns(): Promise<{ data: AdminOperationRun[] }>;
  startCliMaintenance(input: CliMaintenanceRequest): Promise<AdminOperationRun>;
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
  const title = initialTool === "maintenance" ? "Space & CLI maintenance" : "Publish Space release";
  const description = initialTool === "maintenance"
    ? "Check Space health and every managed CLI, or update all CLI apps through the guarded sequential flow."
    : "Preview and publish the clean live Space version to the fixed Gitea and GitHub repositories.";
  const HeaderIcon = initialTool === "maintenance" ? Wrench : Rocket;

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
          <button ref={closeRef} type="button" aria-label={`Close ${title}`} disabled={busy} onClick={close}>
            <X aria-hidden="true" />
          </button>
        </header>
        {initialTool === "maintenance"
          ? <MaintenancePanel client={client} onBusyChange={setBusy} />
          : <ReleasePanel client={client} onBusyChange={setBusy} />}
      </section>
    </div>
  );
}
