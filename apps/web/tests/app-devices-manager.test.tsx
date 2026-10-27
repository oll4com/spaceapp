import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDeviceSession } from "@space/contracts";

const apiMock = vi.hoisted(() => ({ listAppDevices: vi.fn(), revokeAppDevice: vi.fn() }));
vi.mock("../src/api.js", () => ({ api: apiMock }));
const { AppDevicesManager } = await import("../src/features/auth/AppDevicesManager.js");

// Settings > Account > Devices (plan clipboard:VLBu2ge110ho step 4): live phone-app sign-ins with Revoke; revoked and expired ones are not shown.
const future = new Date(Date.now() + 20 * 86400_000).toISOString(), past = new Date(Date.now() - 86400_000).toISOString(), at = new Date().toISOString();
const device = (id: string, overrides: Partial<AppDeviceSession> = {}): AppDeviceSession => ({ id, app: "nous", deviceName: "Pixel 9", createdAt: at, expiresAt: future, revokedAt: null, ...overrides });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("AppDevicesManager", () => {
  it("lists live devices only and revokes one", async () => {
    apiMock.listAppDevices.mockResolvedValue({ devices: [device("appdev:live0001"), device("appdev:gone0001", { revokedAt: at }), device("appdev:old00001", { expiresAt: past })] });
    apiMock.revokeAppDevice.mockResolvedValue({ device: device("appdev:live0001", { revokedAt: at }) });
    render(<AppDevicesManager />);
    const button = await screen.findByRole("button", { name: "Revoke Nous app on Pixel 9" });
    expect(screen.getAllByRole("button", { name: /^Revoke / })).toHaveLength(1);
    fireEvent.click(button);
    await waitFor(() => expect(apiMock.revokeAppDevice).toHaveBeenCalledWith("appdev:live0001"));
    expect(await screen.findByText("No phone app is signed in.")).toBeTruthy();
    expect(apiMock.listAppDevices).toHaveBeenCalledTimes(1);
  });
});
