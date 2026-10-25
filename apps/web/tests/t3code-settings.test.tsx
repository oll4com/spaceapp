import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { T3CodeAdminStatus } from "@space/contracts";
import { T3CodeServiceSettingsCard } from "../src/features/t3code-settings/T3CodeServiceSettingsCard.js";

const apiMock = vi.hoisted(() => ({ t3CodeAdminStatus: vi.fn(), updateT3CodeEnabled: vi.fn(), restartT3Code: vi.fn() }));
vi.mock("../src/api.js", () => ({ api: apiMock }));

function status(overrides: Partial<T3CodeAdminStatus> = {}): T3CodeAdminStatus {
  return {
    version: 1, featureEnabled: true, serviceEnabled: true, serviceActive: true, socketActive: true, pid: 4242, ready: true, serverVersion: "0.0.44",
    runtime: { tag: "v0.0.45", commit: "6c8fed35dded9ff71c5b46807125457acbb76be6", packageVersion: "0.0.44", integrationRevision: 4, runtimeId: "v0.0.45-space.4-40b46afa8d98feff" },
    activeRuns: 0, checkedAt: new Date().toISOString(), ...overrides
  };
}
const activeRunsError = (activeRuns: number | null) => Object.assign(new Error("active"), { code: "T3_ACTIVE_RUNS", status: 409, details: { activeRuns } });

describe("T3CodeServiceSettingsCard", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { cleanup(); });

  it("shows real status and version with a SpaceToggle switch, not a checkbox", async () => {
    apiMock.t3CodeAdminStatus.mockResolvedValue({ status: status({ activeRuns: 2 }) });
    render(<T3CodeServiceSettingsCard />);
    expect(await screen.findByText("Ready")).toBeTruthy();
    expect(screen.getByText(/T3 Code 0\.0\.44 · v0\.0\.45 · integration 4 · 2 active runs/)).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "Enable T3 Code service" }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });

  it("confirms before interrupting active runs and sends the confirmation once", async () => {
    apiMock.t3CodeAdminStatus.mockResolvedValue({ status: status() });
    apiMock.updateT3CodeEnabled.mockRejectedValueOnce(activeRunsError(null))
      .mockResolvedValueOnce({ status: status({ serviceEnabled: false, serviceActive: false, socketActive: false, ready: false, pid: null, activeRuns: null }) });
    render(<T3CodeServiceSettingsCard />);
    fireEvent.click(await screen.findByRole("switch", { name: "Enable T3 Code service" }));
    expect(await screen.findByText(/could not be counted/)).toBeTruthy();
    expect(apiMock.updateT3CodeEnabled).toHaveBeenCalledWith({ enabled: false });
    fireEvent.click(screen.getByRole("button", { name: "Turn off anyway" }));
    await waitFor(() => expect(apiMock.updateT3CodeEnabled).toHaveBeenLastCalledWith({ enabled: false, confirmActiveRuns: true }));
    expect(await screen.findByText("T3 Code is now off.")).toBeTruthy();
    expect(screen.getByText("Stopped")).toBeTruthy();
  });

  it("reports a failed restart instead of success and blocks a second click while pending", async () => {
    let reject!: (error: unknown) => void;
    apiMock.t3CodeAdminStatus.mockResolvedValue({ status: status() });
    apiMock.restartT3Code.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    render(<T3CodeServiceSettingsCard />);
    const restart = await screen.findByRole("button", { name: "Restart" });
    await waitFor(() => expect((restart as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(restart);
    fireEvent.click(restart);
    expect(apiMock.restartT3Code).toHaveBeenCalledTimes(1);
    reject(Object.assign(new Error("failed"), { code: "T3_SERVICE_RESTART_FAILED", status: 502 }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/did not become ready/);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss message" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
