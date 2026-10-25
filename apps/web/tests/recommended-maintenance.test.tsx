import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AdminOperationRun } from "@space/contracts";
import { RecommendedMaintenance } from "../src/features/admin-operations/RecommendedMaintenance.js";

const plan = {
  id: "admin_run:abcdefghijkl", operationType: "CLI_MAINTENANCE_PLAN", status: "SUCCEEDED", summary: "Checked",
  result: { plan: { planId: "admin_run:abcdefghijkl", scope: "enabled", checkedAt: "2026-09-26T12:00:00.000Z", actions: [
    { id: "cli:codex", kind: "UPDATE", label: "Codex", reasons: ["Update available"], installedVersion: "1", targetVersion: "2", fingerprint: "check" }
  ] } }
} as unknown as AdminOperationRun;
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("restores review, preserves the selection and stops polling completed checks", async () => {
  vi.useFakeTimers();
  const client = { listCliMaintenanceRuns: vi.fn(async () => ({ data: [plan] })), createMaintenancePlan: vi.fn(), applyMaintenancePlan: vi.fn(async () => ({ ...plan, id: "admin_run:mnopqrstuvwx", operationType: "CLI_MAINTENANCE_APPLY" as const, status: "QUEUED" as const, result: {} })) };
  render(<RecommendedMaintenance client={client} onBusyChange={() => {}} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect((screen.getByRole("switch") as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole("switch"));
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect((screen.getByRole("switch") as HTMLInputElement).checked).toBe(false);
  expect(client.listCliMaintenanceRuns).toHaveBeenCalledTimes(1);
  expect((screen.getByRole("button", { name: "Confirm & run 0 actions" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("switch"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm & run 1 actions" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(client.applyMaintenancePlan).toHaveBeenCalledWith(plan.id, expect.objectContaining({ selectedActionIds: ["cli:codex"], confirmation: "APPLY MAINTENANCE" }));
});
it("defaults to enabled CLIs and submits only on Check", async () => {
  const client = { listCliMaintenanceRuns: vi.fn(async () => ({ data: [] })), createMaintenancePlan: vi.fn(async () => ({ ...plan, status: "QUEUED" as const, result: {} })), applyMaintenancePlan: vi.fn() };
  render(<RecommendedMaintenance client={client} onBusyChange={() => {}} />);
  expect((screen.getByRole("combobox", { name: "Maintenance scope" }) as HTMLSelectElement).value).toBe("enabled");
  expect(client.createMaintenancePlan).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check" })); });
  expect(client.createMaintenancePlan).toHaveBeenCalledWith({ scope: "enabled" });
});
it("shows check details even when a stored runtime row is missing or partial", async () => {
  const withGaps = { ...plan, result: { ...plan.result, runtimes: [
    { runtimeId: "cli:codex", displayName: "Codex CLI", status: "PASS", summary: "Healthy" },
    null,
    { runtimeId: "cli:gemini" }
  ] } } as unknown as AdminOperationRun;
  const client = { listCliMaintenanceRuns: vi.fn(async () => ({ data: [withGaps] })), createMaintenancePlan: vi.fn(), applyMaintenancePlan: vi.fn() };
  render(<RecommendedMaintenance client={client} onBusyChange={() => {}} />);
  expect(await screen.findByText("Codex CLI")).toBeTruthy();
  expect(screen.getByText("cli:gemini")).toBeTruthy();
});
