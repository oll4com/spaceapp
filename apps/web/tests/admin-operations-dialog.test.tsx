import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import type {
  AdminOperationRun,
  CliUpdateAllDetection,
  CliUpdateAllResult,
  ReleasePreview
} from "@space/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdminOperationsDialog,
  type AdminOperationsClient
} from "../src/features/admin-operations/AdminOperationsDialog.js";
import type { CliMaintenanceReplayPayload } from "../src/live-api.js";
import { resetCliUpdateRun, useMinimizedCliUpdateRun } from "../src/features/admin-operations/cli-update-run.js";

const timestamp = "2026-07-23T08:30:00.000Z";
const sourceCommit = "42aac2eac274e2ab0512071615647073582d43a8";

function run(
  id: string,
  operationType: AdminOperationRun["operationType"],
  status: AdminOperationRun["status"],
  result: AdminOperationRun["result"] = {}
): AdminOperationRun {
  return {
    id,
    operationType,
    status,
    actorUserId: "user:admin",
    summary: `${operationType} ${status}`,
    result,
    createdAt: timestamp,
    startedAt: status === "QUEUED" ? null : timestamp,
    finishedAt: ["SUCCEEDED", "PARTIAL", "FAILED"].includes(status) ? timestamp : null,
    updatedAt: timestamp
  };
}

const preview: ReleasePreview = {
  id: "release_preview:Abcd_1234",
  tag: "v2026.07.23.1",
  notes: "- Publish guarded Space releases (81723350e)",
  sourceCommit,
  previousTag: "v2026.07.22.1",
  remoteMainCommits: {
    gitea: "15aac2eac274e2ab0512071615647073582d43a1",
    github: "15aac2eac274e2ab0512071615647073582d43a1"
  },
  expiresAt: "2026-07-23T09:00:00.000Z",
  createdAt: timestamp
};

function client(overrides: Partial<AdminOperationsClient> = {}): AdminOperationsClient {
  return {
    listCliMaintenanceRuns: vi.fn(async () => ({ data: [] })),
    getCliMaintenanceReplay: vi.fn(async (runId: string) => ({
      run: run(runId, "CLI_MAINTENANCE_REPAIR", "SUCCEEDED"),
      events: [],
      authHandoffs: []
    })),
    openCliMaintenanceStream: vi.fn(() => null),
    cliMaintenanceExportUrl: vi.fn((runId: string) =>
      `/api/admin/cli-maintenance/runs/${encodeURIComponent(runId)}/export`
    ),
    openCliMaintenanceRecovery: vi.fn(async () => ({
      status: "NOOP" as const,
      room: null,
      handoffs: [],
      loginPanes: []
    })),
    startCliMaintenance: vi.fn(async (input) =>
      run(
        "admin_run:Repair_123-x",
        input.mode === "REPAIR" ? "CLI_MAINTENANCE_REPAIR" : "CLI_MAINTENANCE_CHECK",
        "QUEUED"
      )
    ),
    detectCliUpdateAll: vi.fn(async (): Promise<CliUpdateAllDetection> => ({
      schemaVersion: "space.cli-update-all.detection.v1",
      detectedAt: timestamp,
      cliTypes: [
        {
          key: "claude",
          cliType: "cli:claude",
          displayName: "Claude Code CLI",
          managed: true,
          updateKind: "npm-native",
          enabled: true,
          hasCustom: true,
          custom: [
            {
              kind: "config",
              path: "/opt/spaceapp/deploy/claude-space-settings.json",
              label: "Claude Space settings overlay",
              present: true
            }
          ]
        },
        {
          key: "hermes",
          cliType: "cli:hermes",
          displayName: "Hermes Agent CLI",
          managed: false,
          updateKind: "not-managed",
          enabled: false,
          hasCustom: false,
          custom: []
        }
      ]
    })),
    runCliUpdateAll: vi.fn(async (): Promise<CliUpdateAllResult> => ({
      mode: "UPDATE_ALL",
      overallStatus: "PASS",
      scope: "all",
      reinstall: false,
      runtimes: [{
        runtimeId: "cli:claude",
        displayName: "Claude Code CLI",
        installedVersion: "1.0.0",
        availableVersion: "1.0.0",
        status: "PASS",
        code: "CURRENT",
        summary: "Already current.",
        checks: [],
        customPreserved: true,
        customReinstalled: true,
        reinstallResults: [{
          path: "/opt/spaceapp/deploy/claude-space-settings.json",
          kind: "verify",
          status: "PASS",
          code: "CUSTOM_PROCEDURE_PRESERVED",
          message: "Claude Space settings overlay preserved."
        }]
      }],
      customSummary: [{
        key: "claude",
        hasCustom: true,
        custom: [{
          kind: "config",
          path: "/opt/spaceapp/deploy/claude-space-settings.json",
          label: "Claude Space settings overlay",
          present: true
        }]
      }],
      startedAt: null,
      finishedAt: timestamp
    })),
    createReleasePreview: vi.fn(async () => preview),
    publishRelease: vi.fn(async () =>
      run("admin_run:Rel_123456-x", "SPACE_RELEASE", "QUEUED", {
        previewId: preview.id,
        tag: preview.tag,
        sourceCommit: preview.sourceCommit,
        notes: preview.notes
      })
    ),
    listReleaseRuns: vi.fn(async () => ({ data: [] })),
    ...overrides
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetCliUpdateRun();
});

describe("AdminOperationsDialog", () => {
  it("replaces the separate health and update controls with one health and repair action", async () => {
    const operations = client();
    render(<AdminOperationsDialog initialTool="maintenance" client={operations} onClose={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: "Space & CLI maintenance" });
    await waitFor(() => expect(operations.listCliMaintenanceRuns).toHaveBeenCalledTimes(1));
    expect(within(dialog).queryByRole("button", { name: "Update all CLI apps" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Run Space and CLI health check" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Run Space and CLI health and repair" }));
    await waitFor(() => expect(operations.startCliMaintenance).toHaveBeenCalledWith({ mode: "REPAIR" }));
  });

  it("renders durable stage replay, redacted export, and provider-login handoff controls", async () => {
    const repair = run("admin_run:Repair_123-x", "CLI_MAINTENANCE_REPAIR", "PARTIAL", {
      runtimes: [{
        runtimeId: "cli:gemini",
        displayName: "Gemini CLI",
        outcome: "ACTION_REQUIRED",
        summary: "Provider login is required."
      }]
    });
    const operations = client({
      listCliMaintenanceRuns: vi.fn(async () => ({ data: [repair] })),
      getCliMaintenanceReplay: vi.fn(async (): Promise<CliMaintenanceReplayPayload> => ({
        run: repair,
        events: [{
          id: "cli_maintenance_event:Replay123456",
          runId: repair.id,
          sequence: 1,
          runtimeId: "cli:gemini",
          phase: "AUTH_HANDOFF",
          state: "WARNING",
          severity: "WARN",
          code: "AUTH_REQUIRED",
          message: "Gemini CLI requires provider login.",
          attempt: 1,
          installedVersion: "0.52.0",
          availableVersion: "0.52.0",
          targetVersion: "0.52.0",
          durationMs: 8,
          outcome: "ACTION_REQUIRED",
          rollback: null,
          diagnostics: {},
          createdAt: timestamp
        }],
        authHandoffs: [{
          id: "cli_auth_handoff:Replay12345",
          runId: repair.id,
          runtimeId: "cli:gemini",
          roomId: null,
          status: "PENDING",
          attemptCount: 0,
          safeErrorCode: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          completedAt: null
        }]
      }))
    });
    render(<AdminOperationsDialog initialTool="maintenance" client={operations} onClose={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: "Space & CLI maintenance" });
    expect(await within(dialog).findByText("Gemini CLI requires provider login.")).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "Export redacted maintenance JSON" }).getAttribute("href"))
      .toBe(`/api/admin/cli-maintenance/runs/${encodeURIComponent(repair.id)}/export`);
    fireEvent.click(within(dialog).getByRole("button", { name: "Open CLI Recovery" }));
    await waitFor(() => expect(operations.openCliMaintenanceRecovery).toHaveBeenCalledTimes(1));
    expect(await within(dialog).findByText("No provider login handoff is pending.")).toBeTruthy();
  });

  it("keeps polling durable progress when EventSource is unavailable", async () => {
    vi.useFakeTimers();
    const active = run("admin_run:Repair_123-x", "CLI_MAINTENANCE_REPAIR", "RUNNING");
    const operations = client({
      listCliMaintenanceRuns: vi.fn(async () => ({ data: [active] })),
      getCliMaintenanceReplay: vi.fn(async (): Promise<CliMaintenanceReplayPayload> => ({
        run: active,
        events: [],
        authHandoffs: []
      })),
      openCliMaintenanceStream: vi.fn(() => null)
    });
    render(<AdminOperationsDialog initialTool="maintenance" client={operations} onClose={vi.fn()} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const initialLoadCount = vi.mocked(operations.listCliMaintenanceRuns).mock.calls.length;
    expect(initialLoadCount).toBeGreaterThan(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_100);
    });
    expect(operations.listCliMaintenanceRuns).toHaveBeenCalledTimes(initialLoadCount + 2);
    expect(screen.getByText("Live stream is unavailable in this browser; durable replay refresh remains active.")).toBeTruthy();
  });

  it("keeps live progress connected while a partial run has an unresolved login handoff", async () => {
    const partial = run("admin_run:Repair_123-x", "CLI_MAINTENANCE_REPAIR", "PARTIAL");
    const source = {
      addEventListener: vi.fn(),
      close: vi.fn()
    } as unknown as EventSource;
    const operations = client({
      listCliMaintenanceRuns: vi.fn(async () => ({ data: [partial] })),
      getCliMaintenanceReplay: vi.fn(async (): Promise<CliMaintenanceReplayPayload> => ({
        run: partial,
        events: [],
        authHandoffs: [{
          id: "cli_auth_handoff:Replay12345",
          runId: partial.id,
          runtimeId: "cli:gemini",
          roomId: "room:Recovery123",
          status: "OPENED",
          attemptCount: 1,
          safeErrorCode: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          completedAt: null
        }]
      })),
      openCliMaintenanceStream: vi.fn(() => source)
    });
    render(<AdminOperationsDialog initialTool="maintenance" client={operations} onClose={vi.fn()} />);

    await waitFor(() => expect(operations.openCliMaintenanceStream).toHaveBeenCalledWith(partial.id, 0));
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("previews an Athens release and requires exact publish confirmation", async () => {
    const operations = client();
    render(<AdminOperationsDialog initialTool="release" client={operations} onClose={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: "Publish Space release" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Prepare release preview" }));
    expect(await within(dialog).findByText(preview.tag)).toBeTruthy();
    expect(within(dialog).getByText(preview.notes)).toBeTruthy();

    const publish = within(dialog).getByRole("button", { name: "Publish to Gitea and GitHub" }) as HTMLButtonElement;
    expect(publish.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Type PUBLISH to confirm"), {
      target: { value: "PUBLISH" }
    });
    fireEvent.click(publish);

    await waitFor(() => expect(operations.publishRelease).toHaveBeenCalledWith({
      previewId: preview.id,
      tag: preview.tag,
      notes: preview.notes,
      confirmation: "PUBLISH"
    }));
  });

  it("reconstructs an idempotent retry from the newest durable partial run", async () => {
    const partial = run("admin_run:Part_12345-x", "SPACE_RELEASE", "PARTIAL", {
      previewId: preview.id,
      tag: preview.tag,
      sourceCommit: preview.sourceCommit,
      notes: preview.notes,
      providers: []
    });
    const operations = client({
      listReleaseRuns: vi.fn(async () => ({ data: [partial] }))
    });
    render(<AdminOperationsDialog initialTool="release" client={operations} onClose={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: "Publish Space release" });
    expect(await within(dialog).findByText("Partial release ready to retry")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Type PUBLISH to confirm"), {
      target: { value: "PUBLISH" }
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry Gitea and GitHub publishing" }));

    await waitFor(() => expect(operations.publishRelease).toHaveBeenCalledWith({
      previewId: preview.id,
      tag: preview.tag,
      notes: preview.notes,
      confirmation: "PUBLISH"
    }));
  });

  it("can dismiss a partial retry and prepare a fresh release preview", async () => {
    const partial = run("admin_run:Part_12345-x", "SPACE_RELEASE", "PARTIAL", {
      previewId: preview.id,
      tag: preview.tag,
      sourceCommit: preview.sourceCommit,
      notes: preview.notes
    });
    const operations = client({
      listReleaseRuns: vi.fn(async () => ({ data: [partial] }))
    });
    render(<AdminOperationsDialog initialTool="release" client={operations} onClose={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: "Publish Space release" });
    expect(await within(dialog).findByText("Partial release ready to retry")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Prepare new preview" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Prepare release preview" }));

    await waitFor(() => expect(operations.createReleasePreview).toHaveBeenCalledWith({}));
    expect(await within(dialog).findByText("Release preview ready")).toBeTruthy();
  });

  it("keeps the durable partial retry visible after a failed retry attempt", async () => {
    const partial = run("admin_run:Part_12345-x", "SPACE_RELEASE", "PARTIAL", {
      previewId: preview.id,
      tag: preview.tag,
      sourceCommit: preview.sourceCommit,
      notes: preview.notes
    });
    const failedRetry = run("admin_run:Fail_12345-x", "SPACE_RELEASE", "FAILED", {
      previewId: preview.id,
      tag: preview.tag,
      sourceCommit: preview.sourceCommit,
      notes: preview.notes,
      retryOfRunId: partial.id,
      code: "DISPATCH_FAILED"
    });
    const operations = client({
      listReleaseRuns: vi.fn(async () => ({ data: [failedRetry, partial] }))
    });
    render(<AdminOperationsDialog initialTool="release" client={operations} onClose={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: "Publish Space release" });
    expect(await within(dialog).findByText("Partial release ready to retry")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Retry Gitea and GitHub publishing" })).toBeTruthy();
  });

  it("detects custom procedures and updates the full set or a selected subset", async () => {
    const operations = client();
    render(<AdminOperationsDialog initialTool="update-all" client={operations} onClose={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: "Update all CLI types" });
    await waitFor(() => expect(operations.detectCliUpdateAll).toHaveBeenCalledTimes(1));
    expect(await within(dialog).findByText(/1 custom procedure protected in 1 CLI$/)).toBeTruthy();
    expect(within(dialog).getAllByText("Claude Code CLI").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("Hermes Agent CLI")).toBeTruthy();

    // Update all (no selection required).
    fireEvent.click(within(dialog).getByRole("button", { name: "Update all" }));
    await waitFor(() => expect(operations.runCliUpdateAll).toHaveBeenCalledWith({ reinstall: true }));
    const result = await within(dialog).findByRole("region", { name: "Update-all result" });
    expect(within(result).getByText("Update finished")).toBeTruthy();
    expect(within(result).getByText(/1 of 1 custom procedure verified unchanged/)).toBeTruthy();
    expect(within(result).getByText("1 custom kept")).toBeTruthy();
    expect(within(result).getByText("Claude Space settings overlay preserved.")).toBeTruthy();
    expect(within(result).getByText("1.0.0")).toBeTruthy();

    // Select a single managed type (non-managed rows are not individually updatable).
    const claudeRow = within(dialog).getByLabelText("Claude Code CLI") as HTMLInputElement;
    fireEvent.click(claudeRow);
    fireEvent.click(within(dialog).getByRole("button", { name: "Update selected (1)" }));
    await waitFor(() => expect(operations.runCliUpdateAll).toHaveBeenCalledWith({ keys: ["claude"], reinstall: true }));
  });

  it("updates only the CLIs that need it with one click and always keeps custom code", async () => {
    const operations = client();
    const base = await operations.detectCliUpdateAll();
    operations.detectCliUpdateAll = vi.fn(async (): Promise<CliUpdateAllDetection> => ({
      ...base,
      cliTypes: base.cliTypes.map((entry) => entry.key === "claude"
        ? { ...entry, installedVersion: "2.1.296", availableVersion: "2.1.300", updateAvailable: true }
        : entry.key === "hermes"
          ? { ...entry, installedVersion: "0.21.0", availableVersion: "0.21.7", updateAvailable: true }
          : { ...entry, updateAvailable: false })
    }));
    render(<AdminOperationsDialog initialTool="update-all" client={operations} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Update all CLI types" });
    const recommended = await within(dialog).findByRole("region", { name: "Recommended update" });
    expect(await within(recommended).findByText("1 update available")).toBeTruthy();
    expect(within(recommended).getByText("2.1.296 → 2.1.300")).toBeTruthy();
    // Re-apply stays on for the one-click update even when the advanced toggle is off.
    fireEvent.click(within(dialog).getByLabelText("Reinstall custom procedures after update"));
    fireEvent.click(within(recommended).getByRole("button", { name: "Update 1 CLI" }));
    await waitFor(() => expect(operations.runCliUpdateAll).toHaveBeenCalledWith({ keys: ["claude"], reinstall: true }));
  });

  it("keeps a minimized update running and shows its result when the window opens again", async () => {
    const finished = await client().runCliUpdateAll({});
    let finish!: () => void;
    const operations = client({ runCliUpdateAll: vi.fn(() => new Promise<CliUpdateAllResult>((resolve) => { finish = () => resolve(finished); })) });
    const onClose = vi.fn();
    const first = render(<AdminOperationsDialog initialTool="update-all" client={operations} onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Update all CLI types" });
    await waitFor(() => expect(operations.detectCliUpdateAll).toHaveBeenCalled());
    fireEvent.click(within(dialog).getByRole("button", { name: "Update all" }));
    // The close button stays locked while the update runs; Minimize hides the window anyway.
    expect((within(dialog).getByRole("button", { name: "Close Update all CLI types" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Minimize" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    first.unmount();

    const minimized = renderHook(() => useMinimizedCliUpdateRun());
    expect(minimized.result.current).toMatchObject({ label: "every managed CLI type", finished: false });
    await act(async () => finish());
    expect(minimized.result.current).toMatchObject({ finished: true, seen: false });

    render(<AdminOperationsDialog initialTool="update-all" client={operations} onClose={onClose} />);
    const result = await screen.findByRole("region", { name: "Update-all result" });
    expect(within(result).getByText("Update finished")).toBeTruthy();
    expect(minimized.result.current).toBeNull();
    expect(operations.runCliUpdateAll).toHaveBeenCalledTimes(1);
  });

  it("custom verification is enabled by default and can be disabled", async () => {
    const operations = client();
    render(<AdminOperationsDialog initialTool="update-all" client={operations} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Update all CLI types" });
    await waitFor(() => expect(operations.detectCliUpdateAll).toHaveBeenCalled());

    fireEvent.click(within(dialog).getByRole("button", { name: "Update all" }));
    await waitFor(() => expect(operations.runCliUpdateAll).toHaveBeenCalledWith({ reinstall: true }));

    fireEvent.click(within(dialog).getByLabelText("Reinstall custom procedures after update"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Update all" }));
    await waitFor(() => expect(operations.runCliUpdateAll).toHaveBeenLastCalledWith({}));
  });

  it("displays current vs latest versions, update status indicators, and custom procedure chips", async () => {
    const operations = client();
    operations.detectCliUpdateAll = vi.fn(async (): Promise<CliUpdateAllDetection> => ({
      schemaVersion: "space.cli-update-all.detection.v1",
      detectedAt: timestamp,
      cliTypes: [
        {
          key: "codex",
          cliType: "cli:codex",
          displayName: "Codex CLI",
          managed: true,
          updateKind: "npm",
          enabled: true,
          hasCustom: false,
          custom: [],
          installedVersion: "0.152.0",
          availableVersion: "0.152.1",
          updateAvailable: true
        },
        {
          key: "claude",
          cliType: "cli:claude",
          displayName: "Claude Code CLI",
          managed: true,
          updateKind: "npm-native",
          enabled: true,
          hasCustom: true,
          custom: [
            {
              kind: "config",
              path: "/opt/spaceapp/deploy/claude-space-settings.json",
              label: "Claude Space settings overlay",
              present: true
            }
          ],
          installedVersion: "2.1.258",
          availableVersion: "2.1.258",
          updateAvailable: false
        }
      ]
    }));

    render(<AdminOperationsDialog initialTool="update-all" client={operations} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Update all CLI types" });
    await waitFor(() => expect(operations.detectCliUpdateAll).toHaveBeenCalled());

    // Check version labels and verdict pills.
    expect(await within(dialog).findByText("v0.152.0")).toBeTruthy();
    expect(within(dialog).getByText("v0.152.1")).toBeTruthy();
    expect(within(dialog).getByText("0.152.0 → 0.152.1")).toBeTruthy();
    expect(within(dialog).getByText("Update available")).toBeTruthy();

    expect(within(dialog).getAllByText("v2.1.258").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("Up to date")).toBeTruthy();

    // Custom procedures open from the row.
    expect(within(dialog).queryByText("Claude Space settings overlay")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: /1 custom/ }));
    expect(within(dialog).getByText("Claude Space settings overlay")).toBeTruthy();
    expect(within(dialog).getByText("/opt/spaceapp/deploy/claude-space-settings.json")).toBeTruthy();

    // Check filter tab switching.
    const catalog = within(dialog).getByRole("region", { name: "All CLI types" });
    fireEvent.click(within(catalog).getByRole("tab", { name: /^Updates/ }));
    expect(within(catalog).getByText("Codex CLI")).toBeTruthy();
    expect(within(catalog).queryByText("Claude Code CLI")).toBeNull();
  });
});
