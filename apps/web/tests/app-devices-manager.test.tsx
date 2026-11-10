import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDeviceSession } from "@space/contracts";

const apiMock = vi.hoisted(() => ({ listAppDevices: vi.fn(), revokeAppDevice: vi.fn(), allowAppDevice: vi.fn() }));
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

  it("a paired phone only reads until it is allowed (Nous Pro 1b-6)", async () => {
    const held = device("appdev:paired01", { paired: { scopes: ["read"], requestedScopes: ["read", "act"], allowedAt: null, lastSeenAt: null, decide: null } });
    apiMock.listAppDevices.mockResolvedValue({ devices: [held] });
    apiMock.allowAppDevice.mockResolvedValue({ device: { ...held, paired: { ...held.paired!, scopes: ["read", "act"], allowedAt: at } } });
    render(<AppDevicesManager />);
    expect(await screen.findByText(/it only reads until you allow it; it asks to read, act/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow Nous app on Pixel 9" }));
    await waitFor(() => expect(apiMock.allowAppDevice).toHaveBeenCalledWith("appdev:paired01"));
    expect(await screen.findByText(/may read, act/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Allow / })).toBeNull();
  });

  it("re-reads the list when a phone pairs while the card is open, with the minutes left to allow it (9/11 stable pairing)", async () => {
    const pairedAt = new Date(Date.now() - 3 * 60_000 - 1000).toISOString();
    const held = device("appdev:paired02", { createdAt: pairedAt, paired: { scopes: ["read"], requestedScopes: ["read", "act", "decide"], allowedAt: null, lastSeenAt: null, decide: null } });
    apiMock.listAppDevices.mockResolvedValueOnce({ devices: [] }).mockResolvedValue({ devices: [held] });
    render(<AppDevicesManager />);
    expect(await screen.findByText("No phone app is signed in.")).toBeTruthy();
    window.dispatchEvent(new CustomEvent("space:notification", { detail: { notificationId: "notification:other", kind: "AGENT_DONE", status: "OPEN" } }));
    expect(apiMock.listAppDevices).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new CustomEvent("space:notification", { detail: { notificationId: "notification:paired", kind: "MOBILE_PAIRED", status: "OPEN" } }));
    expect(await screen.findByRole("button", { name: "Allow Nous app on Pixel 9" })).toBeTruthy();
    expect(screen.getByText(/asks to read, act, decide · 7 min left to allow/)).toBeTruthy();
    expect(apiMock.listAppDevices).toHaveBeenCalledTimes(2);
  });

  it("names SpaceApp Android's sign-ins", async () => {
    apiMock.listAppDevices.mockResolvedValue({ devices: [device("appdev:space001", { app: "spaceapp" })] });
    render(<AppDevicesManager />);
    expect(await screen.findByRole("button", { name: "Revoke SpaceApp app on Pixel 9" })).toBeTruthy();
  });
});
