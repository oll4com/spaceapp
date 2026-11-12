import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

class FakeApiError extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}
const apiMock = vi.hoisted(() => ({ changePassword: vi.fn() }));
vi.mock("../src/api.js", () => ({ api: apiMock, SpaceApiError: FakeApiError }));
const { LoginPasswordSettingsCard, takePasswordStepUp } = await import("../src/features/settings/LoginPasswordSettingsCard.js");

// Settings > Login password (operator 12/11): labelled fields with the browser's password autocomplete, errors by code, and the Google step-up.
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); window.sessionStorage.clear(); });
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("LoginPasswordSettingsCard", () => {
  it("labels its fields for password managers and saves with the current password", async () => {
    apiMock.changePassword.mockResolvedValue({ ok: true });
    render(<LoginPasswordSettingsCard />);
    expect(screen.getByLabelText("Current password").getAttribute("autocomplete")).toBe("current-password");
    expect(screen.getByLabelText("New password").getAttribute("autocomplete")).toBe("new-password");
    type("Current password", "old words here");
    type("New password", "a brand new phrase");
    type("Confirm new password", "a brand new phrase!");
    fireEvent.click(screen.getByRole("button", { name: "Save password" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The two new passwords are not the same.");
    type("Confirm new password", "a brand new phrase");
    fireEvent.click(screen.getByRole("button", { name: "Save password" }));
    expect((await screen.findByRole("status")).textContent).toContain("Password changed");
    expect(apiMock.changePassword).toHaveBeenCalledWith("a brand new phrase", "old words here");
    expect((screen.getByLabelText("Current password") as HTMLInputElement).value).toBe("");
  });

  it("names a wrong current password, and Confirm with Google marks the return before leaving", async () => {
    apiMock.changePassword.mockRejectedValue(new FakeApiError("no", "INVALID_CREDENTIALS"));
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    render(<LoginPasswordSettingsCard />);
    type("Current password", "wrong");
    type("New password", "a brand new phrase");
    type("Confirm new password", "a brand new phrase");
    fireEvent.click(screen.getByRole("button", { name: "Save password" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Your current password is not right.");
    fireEvent.click(screen.getByRole("button", { name: "Confirm with Google" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/api/auth/google/start?stepUp=mobile"));
    expect(takePasswordStepUp()).toBe(true);
    expect(takePasswordStepUp()).toBe(false);
  });

  it("offers no Google step-up in the desktop app", () => {
    vi.stubGlobal("spaceDesktop", {});
    render(<LoginPasswordSettingsCard />);
    expect(screen.queryByRole("button", { name: "Confirm with Google" })).toBeNull();
  });
});
