import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginScreen } from "../src/features/auth/LoginScreen.js";
import { takePasswordStepUp } from "../src/features/settings/LoginPasswordSettingsCard.js";
import { api, SpaceApiError } from "../src/api.js";
import type { AuthMe } from "@space/contracts";

vi.mock("../src/api.js", async () => {
  const { SpaceApiError } = await import("../src/runtime/SpaceRuntime.js");
  return { SpaceApiError, api: { login: vi.fn(), requestPasswordReset: vi.fn(), completePasswordReset: vi.fn(), passwordResetAvailable: vi.fn() } };
});

const guest: AuthMe = { user: null, isAuthenticated: false, isSetupRequired: false };

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("login domain without application bootstrap", () => {
  it("submits entered credentials and hands the authenticated session to the shell", async () => {
    const signedIn = { ...guest, isAuthenticated: true };
    const login = vi.spyOn(api, "login").mockResolvedValue(signedIn);
    const onLogin = vi.fn();
    render(<LoginScreen auth={guest} modern colorMode="dark" onLogin={onLogin} />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "test@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "synthetic-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Enter" }));
    await waitFor(() => expect(onLogin).toHaveBeenCalledWith(signedIn));
    expect(login).toHaveBeenCalledExactlyOnceWith("test@example.test", "synthetic-password");
    expect(screen.getByRole("main").dataset.colorMode).toBe("dark");
  });

  it("keeps a rejected login unauthenticated and explains owner password recovery", async () => {
    vi.spyOn(api, "login").mockRejectedValue(new SpaceApiError("Rejected", { code: "INVALID_CREDENTIALS", status: 401 }));
    const onLogin = vi.fn();
    render(<LoginScreen auth={guest} modern={false} colorMode={null} onLogin={onLogin} />);
    fireEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(await screen.findByText(/Login rejected.*owner reset-password/)).toBeTruthy();
    expect(onLogin).not.toHaveBeenCalled();
  });

  it("shows only configured Google login and consumes the callback error without keeping it in the URL", async () => {
    window.history.replaceState({}, "", "/?authError=Provider%20rejected%20login");
    await act(async () => render(<LoginScreen auth={{ ...guest, googleAuthEnabled: true }} modern={false} colorMode={null} onLogin={vi.fn()} />));
    expect(screen.getByText("Provider rejected login")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in with Google" }).getAttribute("href")).toBe("/api/auth/google/start");
    expect(window.location.search).toBe("");
  });

  it("offers Forgot password? through Google only where Google sign-in is on, and its return opens Login password", async () => {
    const { unmount } = render(<LoginScreen auth={guest} modern={false} colorMode={null} onLogin={vi.fn()} />);
    expect(screen.queryByRole("link", { name: /Forgot password/ })).toBeNull();
    unmount();
    render(<LoginScreen auth={{ ...guest, googleAuthEnabled: true }} modern={false} colorMode={null} onLogin={vi.fn()} />);
    const link = screen.getByRole("link", { name: "Forgot password? Reset it with Google" });
    expect(link.getAttribute("href")).toBe("/api/auth/google/start?reset=password");
    link.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(link);
    expect(takePasswordStepUp()).toBe(true);
  });

  it("opens a reset form with only the email, mails the link and answers the same generic line (operator 17/11)", async () => {
    const ask = vi.spyOn(api, "requestPasswordReset").mockResolvedValue({ ok: true });
    render(<LoginScreen auth={{ ...guest, googleAuthEnabled: true }} modern={false} colorMode={null} onLogin={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: " owner@example.test " } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "half remembered" } });
    fireEvent.click(screen.getByRole("button", { name: "Forgot password? Email me a reset link" }));
    const form = screen.getByRole("form", { name: "Reset your password" });
    // Only the email: no password field of any kind, nothing else to type.
    expect(form.querySelectorAll("input")).toHaveLength(1);
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("owner@example.test");
    fireEvent.click(screen.getByRole("button", { name: "Email me a reset link" }));
    expect(await screen.findByText(/If that is the owner's address, a reset link is on its way. Open it in this browser/)).toBeTruthy();
    expect(ask).toHaveBeenCalledExactlyOnceWith("owner@example.test", false);
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Forgot password? Email me a reset link" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to sign in" }));
    expect(screen.getByRole("button", { name: "Enter" })).toBeTruthy();
  });

  it("on a server that cannot mail, the reset form says so and offers Google instead of a button that does nothing", async () => {
    vi.spyOn(api, "passwordResetAvailable").mockResolvedValue({ available: false });
    const ask = vi.spyOn(api, "requestPasswordReset"); ask.mockClear();
    render(<LoginScreen auth={{ ...guest, googleAuthEnabled: true }} modern={false} colorMode={null} onLogin={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Forgot password? Email me a reset link" }));
    expect((await screen.findByRole("alert")).textContent).toContain("This server cannot send reset mail.");
    expect(screen.queryByRole("button", { name: "Email me a reset link" })).toBeNull();
    expect(screen.getAllByRole("link", { name: "Sign in with Google" }).some((link) => link.getAttribute("href") === "/api/auth/google/start")).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("gives the desktop app the same email-only form, then takes the mailed link pasted back with the new password", async () => {
    vi.stubGlobal("spaceDesktop", {});
    try {
      const ask = vi.spyOn(api, "requestPasswordReset").mockResolvedValue({ ok: true });
      ask.mockClear();
      const complete = vi.spyOn(api, "completePasswordReset").mockResolvedValue({ ok: true });
      render(<LoginScreen auth={{ ...guest, googleAuthEnabled: true }} modern={false} colorMode={null} onLogin={vi.fn()} />);
      expect(screen.queryByRole("link", { name: /Reset it with Google/ })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Forgot password? Email me a reset link" }));
      expect(screen.getByRole("form", { name: "Reset your password" }).querySelectorAll("input")).toHaveLength(1);
      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "owner@example.test" } });
      fireEvent.click(screen.getByRole("button", { name: "Email me a reset link" }));
      expect(await screen.findByText(/paste it here/)).toBeTruthy();
      expect(ask).toHaveBeenCalledExactlyOnceWith("owner@example.test", true);
      const token = "b".repeat(43);
      fireEvent.change(screen.getByLabelText("Link from the mail"), { target: { value: `https://space.example.test/#password-reset=${token}` } });
      fireEvent.change(screen.getByLabelText("New password"), { target: { value: "synthetic-new-password" } });
      fireEvent.click(screen.getByRole("button", { name: "Set new password" }));
      expect(await screen.findByText(/Your password is reset/)).toBeTruthy();
      expect(complete).toHaveBeenCalledExactlyOnceWith(token, "synthetic-new-password");
      expect(screen.getByRole("button", { name: "Enter" })).toBeTruthy();
    } finally { vi.unstubAllGlobals(); }
  });

  it("takes the mailed token out of the address bar, sets the new password and shows the server's refusal", async () => {
    const token = "a".repeat(43);
    window.history.replaceState({}, "", `/#password-reset=${token}`);
    const complete = vi.spyOn(api, "completePasswordReset")
      .mockRejectedValueOnce(new SpaceApiError("RESET_LINK_INVALID: Open the reset link in the same browser where you asked for it.", { code: "RESET_LINK_INVALID", status: 400 }))
      .mockResolvedValueOnce({ ok: true });
    await act(async () => render(<LoginScreen auth={guest} modern={false} colorMode={null} onLogin={vi.fn()} />));
    expect(window.location.hash).toBe("");
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "synthetic-new-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Set new password" }));
    expect(await screen.findByText("Open the reset link in the same browser where you asked for it.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set new password" }));
    expect(await screen.findByText(/Your password is reset/)).toBeTruthy();
    expect(complete).toHaveBeenLastCalledWith(token, "synthetic-new-password");
    expect(screen.getByRole("button", { name: "Enter" })).toBeTruthy();
  });
});
