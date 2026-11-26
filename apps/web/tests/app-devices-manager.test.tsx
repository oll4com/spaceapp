import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDeviceSession } from "@space/contracts";

const apiMock = vi.hoisted(() => ({ listAppDevices: vi.fn(), revokeAppDevice: vi.fn(), allowAppDevice: vi.fn(), setLinkScopes: vi.fn(), stepUpWithPassword: vi.fn(), answerLinkedNousDecision: vi.fn(),
  requestStepUpMail: vi.fn(), stepUpWithMail: vi.fn(), passwordStatus: vi.fn(() => Promise.resolve({ hasPassword: true, stepUpUntil: null })) }));
const ApiError = vi.hoisted(() => class extends Error { constructor(message: string, readonly code: string) { super(message); } });
vi.mock("../src/api.js", () => ({ api: apiMock, SpaceApiError: ApiError }));
const { AppDevicesManager } = await import("../src/features/auth/AppDevicesManager.js");

// Settings > Account > Devices (plan clipboard:VLBu2ge110ho step 4): live phone-app sign-ins with Revoke; revoked and expired ones are not shown.
const future = new Date(Date.now() + 20 * 86400_000).toISOString(), past = new Date(Date.now() - 86400_000).toISOString(), at = new Date().toISOString();
const device = (id: string, overrides: Partial<AppDeviceSession> = {}): AppDeviceSession => ({ id, app: "nous", deviceName: "Pixel 9", createdAt: at, expiresAt: future, revokedAt: null, ...overrides });
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); window.sessionStorage.clear(); });

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

  // Space Link v2 (ADR-014 v2): an allowed link's grants; Nous brings Manage, more asks the password first and then runs the same change.
  it("grants an allowed SpaceApp link Manage and Nous after the password step-up", async () => {
    const link = device("appdev:link0001", { app: "spaceapp-link", deviceName: "vm207", paired: { scopes: ["read", "act"], requestedScopes: ["read", "act"], allowedAt: at, lastSeenAt: null, decide: null } });
    apiMock.listAppDevices.mockResolvedValue({ devices: [link] });
    apiMock.setLinkScopes.mockRejectedValueOnce(new ApiError("STEP_UP_REQUIRED: Confirm it is you.", "STEP_UP_REQUIRED"))
      .mockResolvedValue({ device: { ...link, paired: { ...link.paired!, scopes: ["read", "act", "manage", "nous"] } } });
    apiMock.stepUpWithPassword.mockResolvedValue({ steppedUp: true, until: future });
    render(<AppDevicesManager />);
    fireEvent.click(await screen.findByRole("switch", { name: "Nous: SpaceApp link on vm207" }));
    await waitFor(() => expect(apiMock.setLinkScopes).toHaveBeenCalledWith("appdev:link0001", ["nous", "manage"]));
    expect(await screen.findByText("Confirm it is you to grant this link more.")).toBeTruthy();
    expect(document.querySelector("input[type=password]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use my password instead" }));
    fireEvent.change(screen.getByLabelText("Your SpaceApp password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect((screen.getByRole("switch", { name: "Manage: SpaceApp link on vm207" }) as HTMLInputElement).checked).toBe(true));
    expect(apiMock.stepUpWithPassword).toHaveBeenCalledWith("pw");
    expect(apiMock.setLinkScopes).toHaveBeenCalledTimes(2);
    expect(screen.queryByLabelText("Your SpaceApp password")).toBeNull();
  });

  it("with Google sign-in, Confirm with Google keeps the grants and the return saves them (operator 17/11)", async () => {
    const { takeStepUpResume, runStepUpResume } = await import("../src/features/auth/step-up-resume.js");
    const link = device("appdev:link0001", { app: "spaceapp-link", deviceName: "vm207", paired: { scopes: ["read", "act"], requestedScopes: ["read", "act"], allowedAt: at, lastSeenAt: null, decide: null } });
    apiMock.listAppDevices.mockResolvedValue({ devices: [link] });
    apiMock.setLinkScopes.mockRejectedValueOnce(new ApiError("STEP_UP_REQUIRED: Confirm it is you.", "STEP_UP_REQUIRED")).mockResolvedValue({ device: link });
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    render(<AppDevicesManager googleAuthEnabled />);
    fireEvent.click(await screen.findByRole("switch", { name: "Manage: SpaceApp link on vm207" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm with Google" }));
    expect(assign).toHaveBeenCalledWith("/api/auth/google/start?stepUp=mobile");
    // Back with ?mobileStepUp=ok, useAppNotices takes the held grants once and saves them.
    const resume = takeStepUpResume();
    expect(resume).toEqual({ purpose: "link-scopes", deviceId: "appdev:link0001", scopes: ["manage"] });
    expect(takeStepUpResume()).toBeNull();
    expect(await runStepUpResume(resume!)).toMatch(/grants .* are saved/);
    expect(apiMock.setLinkScopes).toHaveBeenLastCalledWith("appdev:link0001", ["manage"]);
    await runStepUpResume({ purpose: "linked-decision", linkId: "link:1", decisionId: "d1", answer: "ANSWER", text: "yes" });
    expect(apiMock.answerLinkedNousDecision).toHaveBeenCalledWith("link:1", "d1", { answer: "ANSWER", text: "yes" });
  });
});
