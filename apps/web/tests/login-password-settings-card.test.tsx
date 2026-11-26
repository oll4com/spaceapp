import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeApiError extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}
const apiMock = vi.hoisted(() => ({ changePassword: vi.fn(), requestStepUpMail: vi.fn(), stepUpWithMail: vi.fn(), stepUpWithPassword: vi.fn(),
  passwordStatus: vi.fn(() => Promise.resolve<{ hasPassword: boolean; stepUpUntil: string | null }>({ hasPassword: true, stepUpUntil: null })) }));
vi.mock("../src/api.js", () => ({ api: apiMock, SpaceApiError: FakeApiError }));
const { LoginPasswordSettingsCard, takePasswordStepUp } = await import("../src/features/settings/LoginPasswordSettingsCard.js");

// Settings > Login password (operator 12/11; 17/11 nous_msg:db5f61cafe3847b1ad5f59f6 and nous_msg:ccf452a2bf474536b8d4e685): no Current
// password field; Google or a link by mail first, then only the new password.
beforeEach(() => { apiMock.passwordStatus.mockImplementation(() => Promise.resolve({ hasPassword: true, stepUpUntil: null })); });
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); window.sessionStorage.clear(); });
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const fresh = () => ({ hasPassword: true, stepUpUntil: new Date(Date.now() + 4 * 60_000).toISOString() });

describe("LoginPasswordSettingsCard", () => {
  it("shows no password field before it is confirmed: Google and a link by mail, the password only behind a link", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    render(<LoginPasswordSettingsCard />);
    expect(await screen.findByRole("button", { name: "Email me a link" })).toBeTruthy();
    expect(document.querySelector("input[type=password]")).toBeNull();
    expect(screen.queryByLabelText("Current password")).toBeNull();
    expect(screen.queryByLabelText("New password")).toBeNull();
    expect(screen.getByRole("button", { name: "I know my current password" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm with Google" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/api/auth/google/start?stepUp=mobile"));
    expect(takePasswordStepUp()).toBe(true);
    expect(takePasswordStepUp()).toBe(false);
  });

  it("once confirmed, asks only for the new password, labelled for password managers, and saves it with no current password", async () => {
    apiMock.passwordStatus.mockResolvedValueOnce(fresh());
    apiMock.changePassword.mockResolvedValue({ ok: true });
    render(<LoginPasswordSettingsCard />);
    expect(await screen.findByText(/Confirmed it is you until .+\. Choose the new password\./)).toBeTruthy();
    expect(screen.queryByLabelText("Current password")).toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm with Google" })).toBeNull();
    expect(screen.getByLabelText("New password").getAttribute("autocomplete")).toBe("new-password");
    type("New password", "a brand new phrase");
    type("Confirm new password", "a brand new phrase!");
    fireEvent.click(screen.getByRole("button", { name: "Save password" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The two new passwords are not the same.");
    type("Confirm new password", "a brand new phrase");
    fireEvent.click(screen.getByRole("button", { name: "Save password" }));
    await waitFor(() => expect(screen.getByText(/Password changed/)).toBeTruthy());
    expect(apiMock.changePassword).toHaveBeenCalledWith("a brand new phrase");
  });

  it("on the web too, a mailed link confirms it is you and then the new password saves, with no current password", async () => {
    apiMock.requestStepUpMail.mockResolvedValue({ ok: true, sentTo: "owner@example.test" });
    apiMock.stepUpWithMail.mockResolvedValue({ steppedUp: true, until: fresh().stepUpUntil });
    apiMock.changePassword.mockResolvedValue({ ok: true });
    render(<LoginPasswordSettingsCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Email me a link" }));
    const token = "Ab1_".repeat(11);
    await screen.findByLabelText("Link from the mail");
    type("Link from the mail", `https://space.example.test/#space-step-up=${token}`);
    apiMock.passwordStatus.mockResolvedValue(fresh());
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByLabelText("New password");
    expect(apiMock.stepUpWithMail).toHaveBeenCalledWith(token);
    type("New password", "a brand new phrase");
    type("Confirm new password", "a brand new phrase");
    fireEvent.click(screen.getByRole("button", { name: "Save password" }));
    await waitFor(() => expect(apiMock.changePassword).toHaveBeenCalledWith("a brand new phrase"));
  });

  it("in the desktop app, offers the mailed link and no Google", async () => {
    vi.stubGlobal("spaceDesktop", {});
    render(<LoginPasswordSettingsCard />);
    expect(await screen.findByRole("button", { name: "Email me a link" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm with Google" })).toBeNull();
    expect(document.querySelector("input[type=password]")).toBeNull();
  });

  it("in the desktop app on a server that cannot mail, sends no mail and points to the browser, never a password field first", async () => {
    vi.stubGlobal("spaceDesktop", { openExternal: vi.fn(() => Promise.resolve(true)) });
    apiMock.passwordStatus.mockImplementation(() => Promise.resolve({ hasPassword: true, stepUpUntil: null, canMail: false } as never));
    render(<LoginPasswordSettingsCard />);
    expect(await screen.findByRole("button", { name: "Open SpaceApp in your browser" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Email me a link" })).toBeNull();
    expect(document.querySelector("input[type=password]")).toBeNull();
    expect(apiMock.requestStepUpMail).not.toHaveBeenCalled();
  });

  it("on the web without Google sign-in turned on, offers no Google button", async () => {
    render(<LoginPasswordSettingsCard googleAuthEnabled={false} />);
    expect(await screen.findByRole("button", { name: "Email me a link" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm with Google" })).toBeNull();
  });

  it("names a refused mail without its error code", async () => {
    apiMock.requestStepUpMail.mockRejectedValue(new FakeApiError("STEP_UP_MAIL_RATE_LIMITED: Three links were sent in the last hour.", "STEP_UP_MAIL_RATE_LIMITED"));
    render(<LoginPasswordSettingsCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Email me a link" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Three links were sent in the last hour.");
  });

  it("asks an account with no password (Google only) to confirm, then to choose one, with no password link", async () => {
    apiMock.passwordStatus.mockResolvedValue({ hasPassword: false, stepUpUntil: null });
    render(<LoginPasswordSettingsCard />);
    expect(await screen.findByText("This account has no SpaceApp password yet. Confirm it is you first; then choose one.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "I know my current password" })).toBeNull());
    expect(screen.getByRole("button", { name: "Confirm with Google" })).toBeTruthy();
  });

  it("when the 5 minutes ran out before saving, says so and asks to confirm again", async () => {
    apiMock.passwordStatus.mockResolvedValueOnce(fresh());
    apiMock.changePassword.mockRejectedValue(new FakeApiError("no", "STEP_UP_REQUIRED"));
    render(<LoginPasswordSettingsCard />);
    await screen.findByLabelText("New password");
    type("New password", "a brand new phrase");
    type("Confirm new password", "a brand new phrase");
    fireEvent.click(screen.getByRole("button", { name: "Save password" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The 5 minutes ran out. Confirm it is you again, then save.");
    expect(await screen.findByRole("button", { name: "Email me a link" })).toBeTruthy();
  });
});
