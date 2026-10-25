import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AppDiagnosticsStatus } from "@space/contracts";
import {
  AppDiagnosticsGlobalIndicators,
  AppDiagnosticsSettingsCard
} from "../src/features/app-diagnostics/AppDiagnosticsSettingsCard.js";

const status: AppDiagnosticsStatus = {
  isEnabled: true,
  captureId: "app_debug_capture:settings0001",
  enabledAt: "2026-07-24T10:00:00.000Z",
  enabledByUserId: "user:admin",
  retentionHours: 24,
  quotaBytes: 8 * 1024 ** 3,
  technicalQuotaBytes: 512 * 1024 ** 2,
  visualQuotaBytes: 8 * 1024 ** 3 - 512 * 1024 ** 2,
  usage: { technicalBytes: 1024, visualBytes: 2048, totalBytes: 3072, segmentCount: 3 },
  counters: { droppedEvents: 4, quotaDrops: 1, rejectedUploads: 2 },
  recorder: { status: "IDLE" },
  checkedAt: "2026-07-24T10:00:12.000Z"
};

describe("AppDiagnosticsSettingsCard", () => {
  it("shows global state to operators while keeping controls read-only", () => {
    render(
      <AppDiagnosticsSettingsCard
        canManage={false}
        state={{
          status,
          collector: { isCollecting: true, bufferedEvents: 2, bufferedBytes: 100, droppedEvents: 5, lastSequence: 8 },
          lastErrorCode: null
        }}
        recorderState={{ status: "IDLE", startedAt: null, errorCode: null, paused: false }}
      />
    );

    expect(screen.getByText("DEBUG ON")).toBeTruthy();
    expect(screen.getByText(/8 GiB total/)).toBeTruthy();
    expect((screen.getByLabelText("Enable global app diagnostics") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "App diagnostics actions" }));
    expect(screen.queryByRole("menuitem", { name: "Start tab recording" })).toBeNull();
  });

  it("updates the admin toggle and requires explicit visible consent before requesting tab recording", async () => {
    const updateStatus = vi.fn(async () => ({ ...status, isEnabled: false, captureId: null }));
    const onStatus = vi.fn();
    const onStartRecording = vi.fn(async () => undefined);
    render(
      <AppDiagnosticsSettingsCard
        canManage
        client={{ updateStatus }}
        onStatus={onStatus}
        onStartRecording={onStartRecording}
        state={{
          status,
          collector: { isCollecting: true, bufferedEvents: 0, bufferedBytes: 0, droppedEvents: 0, lastSequence: 1 },
          lastErrorCode: null
        }}
        recorderState={{ status: "IDLE", startedAt: null, errorCode: null, paused: false }}
      />
    );

    fireEvent.click(screen.getByLabelText("Enable global app diagnostics"));
    await waitFor(() => expect(updateStatus).toHaveBeenCalledWith(false));
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ isEnabled: false }));

    fireEvent.click(screen.getByRole("button", { name: "App diagnostics actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Start tab recording" }));
    expect(onStartRecording).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Confirm diagnostic tab recording" }).textContent)
      .toContain("anything visible in the selected tab");
    fireEvent.click(screen.getByRole("button", { name: "Share this Space tab" }));
    await waitFor(() => expect(onStartRecording).toHaveBeenCalledTimes(1));
  });

  it("explains a rejected tab capture and requires consent again before retrying", async () => {
    const onStartRecording = vi.fn(async () => undefined);
    render(
      <AppDiagnosticsSettingsCard
        canManage
        onStartRecording={onStartRecording}
        state={{
          status,
          collector: { isCollecting: true, bufferedEvents: 0, bufferedBytes: 0, droppedEvents: 0, lastSequence: 1 },
          lastErrorCode: null
        }}
        recorderState={{ status: "ERROR", startedAt: null, errorCode: "CAPTURE_HANDLE_MISMATCH", paused: false }}
      />
    );
    expect(screen.getByRole("alert").textContent).toContain("could not verify this Space tab");
    expect(screen.getByRole("alert").getAttribute("data-recorder-error-code")).toBe("CAPTURE_HANDLE_MISMATCH");
    fireEvent.click(screen.getByRole("button", { name: "App diagnostics actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Start tab recording" }));
    expect(onStartRecording).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Share this Space tab" }));
    await waitFor(() => expect(onStartRecording).toHaveBeenCalledTimes(1));
  });

  it("keeps DEBUG ON and REC visible outside Settings", () => {
    render(
      <AppDiagnosticsGlobalIndicators
        state={{
          status: { ...status, recorder: { status: "ACTIVE", leaseId: "app_debug_lease:settings0001", clientId: "app_debug_client:settings0001", acquiredAt: status.enabledAt!, heartbeatAt: status.enabledAt!, expiresAt: status.checkedAt } },
          collector: { isCollecting: true, bufferedEvents: 0, bufferedBytes: 0, droppedEvents: 0, lastSequence: 1 },
          lastErrorCode: null
        }}
        recorderState={{ status: "RECORDING", startedAt: status.enabledAt, errorCode: null, paused: false }}
      />
    );
    expect(screen.getByText("DEBUG ON")).toBeTruthy();
    expect(screen.getByText("REC")).toBeTruthy();
  });
});
