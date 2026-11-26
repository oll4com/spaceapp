import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

class FakeApiError extends Error {
  constructor(message: string, readonly input: { code?: string; details?: unknown }) { super(message); }
  get code() { return this.input.code; }
  get details() { return this.input.details; }
}
const apiMock = vi.hoisted(() => ({ mobileInstance: vi.fn(), stepUpWithPassword: vi.fn(), setUpMobileInstance: vi.fn(), rotateMobileInstance: vi.fn(), createMobilePairing: vi.fn(), cancelMobilePairing: vi.fn(),
  requestStepUpMail: vi.fn(), stepUpWithMail: vi.fn(), passwordStatus: vi.fn(() => Promise.resolve({ hasPassword: true, stepUpUntil: null })) }));
vi.mock("../src/api.js", () => ({ api: apiMock, SpaceApiError: FakeApiError }));
const { MobileAppManager } = await import("../src/features/auth/MobileAppManager.js");
const { settlePairAfterStepUp } = await import("../src/features/auth/mobile-pair-resume.js");

// Settings > Account > Mobile app (Nous Pro 1b-6, ADR-013): set up after a fresh Google sign-in, pair with a QR shown only in this tab.
const configured = { configured: true, fingerprint: "ABCD-EFGH-IJKL-MNOP-QRST-UVWX", retiring: [] };
const offered = { offerId: "AAAAAAAAAAA", qr: "SPACEAPP-PAIR:1:abc", fingerprint: configured.fingerprint, scopes: ["read", "act", "decide"],
  expiresAt: new Date(Date.now() + 120_000).toISOString() };
const stepUpRequired = () => new FakeApiError("STEP_UP_REQUIRED: Confirm it is you", { code: "STEP_UP_REQUIRED",
  details: { stepUpUrl: "/api/auth/google/start?stepUp=mobile", passwordUrl: "/api/auth/step-up/password" } });
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); window.sessionStorage.clear(); });

describe("MobileAppManager", () => {
  it("sends the person to the Google step-up when the server asks for it", async () => {
    apiMock.mobileInstance.mockResolvedValue({ configured: false });
    apiMock.createMobilePairing.mockRejectedValue(new FakeApiError("Confirm it is you", { code: "STEP_UP_REQUIRED", details: { stepUpUrl: "/api/auth/google/start?stepUp=mobile" } }));
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    render(<MobileAppManager />);
    fireEvent.click(await screen.findByRole("button", { name: "Pair a phone" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/api/auth/google/start?stepUp=mobile"));
  });

  it("not set up: Pair a phone, the password behind its link, Confirm, and the QR shows with no Set up step (7/11)", async () => {
    apiMock.mobileInstance.mockResolvedValueOnce({ configured: false }).mockResolvedValue(configured);
    apiMock.createMobilePairing.mockRejectedValueOnce(stepUpRequired()).mockResolvedValueOnce(offered);
    apiMock.stepUpWithPassword.mockResolvedValue({ steppedUp: true, until: new Date().toISOString() });
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    render(<MobileAppManager />);
    expect(screen.queryByRole("button", { name: "Set up" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Pair a phone" }));
    expect(await screen.findByRole("button", { name: "Confirm with Google" })).toBeTruthy();
    // The reason shows as a request, not an error (8/11), and Google takes the focus: a second click is no longer a silent loop.
    expect(screen.getByRole("status").textContent).toBe("Confirm it is you to pair a phone.");
    expect(screen.queryByRole("alert")).toBeNull();
    // Google or a link by mail first, no password field (operator 17/11); the password stays behind a link for whoever knows it.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Confirm with Google" }));
    expect(await screen.findByRole("button", { name: "Email me a link" })).toBeTruthy();
    expect(document.querySelector("input[type=password]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use my password instead" }));
    fireEvent.change(screen.getByLabelText("Your SpaceApp password"), { target: { value: "secret words" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(apiMock.stepUpWithPassword).toHaveBeenCalledWith("secret words"));
    expect(await screen.findByRole("img", { name: "Pairing code" })).toBeTruthy();
    expect(apiMock.createMobilePairing).toHaveBeenCalledTimes(2);
    expect(apiMock.setUpMobileInstance).not.toHaveBeenCalled();
    expect(await screen.findByText(/Fingerprint/)).toBeTruthy();
    expect(screen.queryByLabelText("Your SpaceApp password")).toBeNull();
    expect(assign).not.toHaveBeenCalled();
  });

  it("Sign in to Google instead comes back confirmed and shows the QR without another click (7/11)", async () => {
    apiMock.mobileInstance.mockResolvedValue(configured);
    apiMock.createMobilePairing.mockRejectedValueOnce(stepUpRequired()).mockResolvedValueOnce(offered);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    render(<MobileAppManager />);
    fireEvent.click(await screen.findByRole("button", { name: "Pair a phone" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm with Google" }));
    expect(assign).toHaveBeenCalledWith("/api/auth/google/start?stepUp=mobile");
    cleanup();
    // The page came back with ?mobileStepUp=ok (useAppNotices settles it and opens Settings > Account): Mobile app pairs on its own.
    expect(settlePairAfterStepUp(true)).toBe(true);
    render(<MobileAppManager />);
    expect(await screen.findByRole("img", { name: "Pairing code" })).toBeTruthy();
    expect(apiMock.createMobilePairing).toHaveBeenCalledTimes(2);
    cleanup();
    // Once only: the next visit to Settings shows the button again.
    render(<MobileAppManager />);
    expect(await screen.findByRole("button", { name: "Pair a phone" })).toBeTruthy();
    expect(apiMock.createMobilePairing).toHaveBeenCalledTimes(2);
  });

  it("in the desktop app, someone who does not know the password gets a link by mail and the pairing goes on, with no password changed (operator 17/11)", async () => {
    apiMock.mobileInstance.mockResolvedValue(configured);
    apiMock.createMobilePairing.mockRejectedValueOnce(stepUpRequired()).mockResolvedValueOnce(offered);
    apiMock.requestStepUpMail.mockResolvedValue({ ok: true, sentTo: "owner@example.test" });
    apiMock.stepUpWithMail.mockResolvedValue({ steppedUp: true, until: new Date(Date.now() + 5 * 60_000).toISOString() });
    vi.stubGlobal("spaceDesktop", {});
    render(<MobileAppManager />);
    fireEvent.click(await screen.findByRole("button", { name: "Pair a phone" }));
    fireEvent.click(await screen.findByRole("button", { name: "Email me a link" }));
    const token = "c".repeat(43);
    fireEvent.change(await screen.findByLabelText("Link from the mail"), { target: { value: `https://space.example.test/#space-step-up=${token}` } });
    expect(document.querySelector("input[type=password]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByRole("img", { name: "Pairing code" })).toBeTruthy();
    expect(apiMock.stepUpWithMail).toHaveBeenCalledWith(token);
    expect(apiMock.stepUpWithPassword).not.toHaveBeenCalled();
  });

  it("offers no Google in the desktop app, whose Google sign-in is not a step-up", async () => {
    apiMock.mobileInstance.mockResolvedValue({ configured: false });
    apiMock.createMobilePairing.mockRejectedValue(stepUpRequired());
    vi.stubGlobal("spaceDesktop", {});
    render(<MobileAppManager />);
    fireEvent.click(await screen.findByRole("button", { name: "Pair a phone" }));
    expect(await screen.findByRole("button", { name: "Email me a link" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm with Google" })).toBeNull();
    expect(document.querySelector("input[type=password]")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Confirm it is you to pair a phone.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("pairs with a QR that is masked as pairing and can be cancelled", async () => {
    apiMock.mobileInstance.mockResolvedValue(configured);
    apiMock.createMobilePairing.mockResolvedValue({ offerId: "AAAAAAAAAAA", qr: "SPACEAPP-PAIR:1:abc", fingerprint: configured.fingerprint, scopes: ["read", "act"],
      expiresAt: new Date(Date.now() + 120_000).toISOString() });
    apiMock.cancelMobilePairing.mockResolvedValue({ cancelled: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<MobileAppManager />);
    fireEvent.click(await screen.findByRole("button", { name: "Pair a phone" }));
    const code = await screen.findByRole("img", { name: "Pairing code" });
    expect(code.closest("[data-sensitive-masked='pairing']")).toBeTruthy();
    expect(screen.getByText(/check that it shows the fingerprint ABCD-EFGH-IJKL-MNOP-QRST-UVWX/)).toBeTruthy();
    // Space Link (ADR-014): the same code links another SpaceApp; writeText fires no copy event, so the Space clipboard never keeps it.
    fireEvent.click(screen.getByRole("button", { name: "Copy code for another SpaceApp" }));
    expect(await screen.findByRole("button", { name: "Copied: paste it in the other SpaceApp" })).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith("SPACEAPP-PAIR:1:abc");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(apiMock.cancelMobilePairing).toHaveBeenCalledWith("AAAAAAAAAAA"));
    await waitFor(() => expect(screen.queryByRole("img", { name: "Pairing code" })).toBeNull());
  });

  it("rotates only after the person confirms, and says which keys still answer", async () => {
    apiMock.mobileInstance.mockResolvedValue(configured);
    apiMock.rotateMobileInstance.mockResolvedValue({ ...configured, fingerprint: "ZZZZ-EFGH-IJKL-MNOP-QRST-UVWX", retiring: [{ fingerprint: configured.fingerprint, until: "2026-12-01T00:00:00.000Z" }] });
    apiMock.createMobilePairing.mockResolvedValue({ offerId: "AAAAAAAAAAA", qr: "SPACEAPP-PAIR:1:abc", fingerprint: configured.fingerprint, scopes: ["read"],
      expiresAt: new Date(Date.now() + 120_000).toISOString() });
    vi.stubGlobal("confirm", vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true));
    render(<MobileAppManager />);
    fireEvent.click(await screen.findByRole("button", { name: "Pair a phone" }));
    await screen.findByRole("img", { name: "Pairing code" });
    fireEvent.click(await screen.findByRole("button", { name: "Rotate keys" }));
    await waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(1));
    expect(apiMock.rotateMobileInstance).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keys exposed" }));
    await waitFor(() => expect(apiMock.rotateMobileInstance).toHaveBeenCalledWith(true));
    expect(await screen.findByText(/Older keys still answer phones/)).toBeTruthy();
    // The code shown before names the old keys: it goes with them.
    expect(screen.queryByRole("img", { name: "Pairing code" })).toBeNull();
  });
});
