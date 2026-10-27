import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MaintenanceAutopilotRun, MaintenanceAutopilotStatus } from "@space/contracts";
import { MaintenanceHub, type MaintenanceHubClient } from "../src/features/admin-operations/MaintenanceHub.js";
import { ServerActionsMenu, type ServerActionCommand } from "../src/features/server-actions/ServerActionsMenu.js";
import { ServerCog, Trash2, Wrench } from "../src/features/ui-theme/app-icons.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const schedule = { enabled: false, hour: 4, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", nextRunAt: null };

function run(status: MaintenanceAutopilotRun["status"], stepStatuses: Array<MaintenanceAutopilotRun["steps"][number]["status"]>): MaintenanceAutopilotRun {
  const ids = ["cleanup", "memory", "check", "update"] as const;
  return {
    id: "maintenance_one",
    trigger: "MANUAL",
    status,
    summary: status === "RUNNING" ? "Maintenance is running." : status === "SUCCEEDED" ? "Maintenance finished. Space is clean and up to date." : "Maintenance finished with warnings. Review the steps below.",
    steps: ids.map((id, index) => ({
      id,
      status: stepStatuses[index]!,
      summary: `${id} summary`,
      startedAt: "2026-10-11T10:00:00.000Z",
      finishedAt: stepStatuses[index] === "RUNNING" || stepStatuses[index] === "PENDING" ? null : "2026-10-11T10:00:10.000Z"
    })),
    startedAt: "2026-10-11T10:00:00.000Z",
    finishedAt: status === "RUNNING" ? null : "2026-10-11T10:01:00.000Z"
  };
}

function status(overrides: Partial<MaintenanceAutopilotStatus> = {}): MaintenanceAutopilotStatus {
  return { schedule, currentRun: null, lastRun: null, checkedAt: "2026-10-11T10:00:00.000Z", ...overrides };
}

function client(initial: MaintenanceAutopilotStatus): MaintenanceHubClient & { [K in keyof MaintenanceHubClient]: ReturnType<typeof vi.fn> } {
  return {
    maintenanceAutopilotStatus: vi.fn(async () => initial),
    startMaintenanceAutopilot: vi.fn(async () => status({ currentRun: run("RUNNING", ["RUNNING", "PENDING", "PENDING", "PENDING"]) })),
    updateMaintenanceAutopilotSchedule: vi.fn(async (input) => status({ schedule: { ...schedule, enabled: input.enabled, hour: input.hour ?? 4, nextRunAt: input.enabled ? "2026-10-12T04:00:00.000Z" : null } }))
  };
}

describe("MaintenanceHub", () => {
  it("runs every step with one tap and follows the run until it finishes", async () => {
    vi.useFakeTimers();
    const api = client(status());
    render(<MaintenanceHub client={api} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("status").textContent).toContain("Not run yet");
    const steps = screen.getByRole("list", { name: "Maintenance steps" });
    for (const label of ["Clean up storage", "Free memory", "Check health", "Update & repair"]) expect(within(steps).getByText(label)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Run maintenance" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.startMaintenanceAutopilot).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Running…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("Running step 1 of 4");

    api.maintenanceAutopilotStatus.mockResolvedValue(status({ lastRun: run("SUCCEEDED", ["DONE", "DONE", "DONE", "DONE"]) }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.getByRole("status").textContent).toContain("Space is clean and up to date");
    expect(within(steps).getByText("update summary")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Run maintenance" }) as HTMLButtonElement).disabled).toBe(false);

    const polls = api.maintenanceAutopilotStatus.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(api.maintenanceAutopilotStatus.mock.calls.length).toBe(polls);
  });

  it("turns on the nightly run in the browser's time zone and changes its hour", async () => {
    // The switch stays disabled until the first status load; a click before it lands is ignored, so flush it first.
    vi.useFakeTimers();
    const api = client(status());
    render(<MaintenanceHub client={api} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole("switch", { name: "Run automatically every night" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.updateMaintenanceAutopilotSchedule).toHaveBeenCalledWith({ enabled: true, hour: 4, timeZone: schedule.timeZone });
    expect(screen.getByText(/Next run/)).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Nightly maintenance time" }), { target: { value: "2" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.updateMaintenanceAutopilotSchedule).toHaveBeenLastCalledWith({ enabled: true, hour: 2, timeZone: schedule.timeZone });
  });

  it("links to the detailed check when a run needs attention and shows start errors", async () => {
    const api = client(status({ lastRun: run("PARTIAL", ["DONE", "WARNING", "DONE", "FAILED"]) }));
    api.startMaintenanceAutopilot.mockRejectedValueOnce(new Error("Maintenance is already running."));
    const openTool = vi.fn();
    render(<MaintenanceHub client={api} onOpenTool={openTool} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open check & repair details" }));
    expect(openTool).toHaveBeenCalledWith("space-cli-maintenance");
    fireEvent.click(screen.getByRole("button", { name: "Run maintenance" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Maintenance is already running.");
  });
});

describe("Manage maintenance section", () => {
  it("shows one-tap maintenance above the individual tools and opens a tool from it", () => {
    const selectCleanup = vi.fn();
    const actions: ServerActionCommand[] = [
      { id: "restart-server", label: "Restart server", description: "Restart Space", icon: ServerCog, onSelect: vi.fn() },
      { id: "space-cli-maintenance", label: "Space & CLI maintenance", description: "Health and repair", icon: Wrench, onSelect: vi.fn() },
      { id: "cli-session-cleanup", label: "Clean CLI sessions & storage", description: "Safe cleanup", icon: Trash2, onSelect: selectCleanup }
    ];
    const renderGroupIntro = vi.fn((group: string, open: (id: string) => void) => group === "maintenance"
      ? <button type="button" onClick={() => open("cli-session-cleanup")}>Intro opens cleanup</button>
      : null);
    render(<ServerActionsMenu actions={actions} mobile={false} onClose={vi.fn()} triggerRef={createRef()} renderGroupIntro={renderGroupIntro} />);
    fireEvent.click(screen.getByRole("button", { name: "Services" }));
    expect(screen.queryByText("Individual tools")).toBeNull();
    fireEvent.click(screen.getByText("← All sections"));
    fireEvent.click(screen.getByRole("button", { name: "Maintenance" }));
    expect(screen.getByText("Individual tools")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Space & CLI maintenance" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Intro opens cleanup" }));
    expect(selectCleanup).toHaveBeenCalledTimes(1);
  });
});
