import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginScreen } from "../src/features/auth/LoginScreen.js";
import { api, SpaceApiError } from "../src/api.js";
import type { AuthMe } from "@space/contracts";

vi.mock("../src/api.js", async () => {
  const { SpaceApiError } = await import("../src/runtime/SpaceRuntime.js");
  return { SpaceApiError, api: { login: vi.fn() } };
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
});
