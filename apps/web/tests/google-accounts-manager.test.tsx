import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleAccountsManager } from "../src/features/auth/GoogleAccountsManager.js";

const apiMock = vi.hoisted(() => ({
  listGoogleAccounts: vi.fn(),
  setPrimaryGoogleAccount: vi.fn(),
  removeGoogleAccount: vi.fn(),
  checkGoogleAccountBrowser: vi.fn()
}));
vi.mock("../src/api.js", () => ({ api: apiMock }));

const first = { id: "google_account:first", email: "first@example.test", displayName: "First", isPrimary: true, browserStatus: "UNKNOWN" };
const second = { id: "google_account:second", email: "second@example.test", displayName: "Second", isPrimary: false, browserStatus: "NOT_CONNECTED" };

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.listGoogleAccounts.mockResolvedValue({ accounts: [first, second] });
  apiMock.setPrimaryGoogleAccount.mockResolvedValue({ account: { ...second, isPrimary: true } });
  apiMock.removeGoogleAccount.mockResolvedValue({ ok: true });
  vi.stubGlobal("confirm", vi.fn(() => true));
});
afterEach(cleanup);

describe("Google account settings", () => {
  it("lists owned accounts, distinguishes SSO from browser status and sets the default", async () => {
    render(<GoogleAccountsManager enabled onAuthRefresh={vi.fn(async () => {})} />);
    expect(await screen.findByText("First · Default")).toBeTruthy();
    expect(screen.getByText("Second")).toBeTruthy();
    expect(screen.getByText(/Browser session unknown/)).toBeTruthy();
    expect(screen.getByText(/Browser not connected/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Add Google account" }).getAttribute("href")).toBe("/api/auth/google/accounts/link");
    fireEvent.click(screen.getByRole("button", { name: "Make Second default" }));
    await waitFor(() => expect(apiMock.setPrimaryGoogleAccount).toHaveBeenCalledWith(second.id));
  });

  it("removes only the chosen account after confirmation and reloads the list", async () => {
    render(<GoogleAccountsManager enabled onAuthRefresh={vi.fn(async () => {})} />);
    await screen.findByText("Second");
    fireEvent.click(screen.getByRole("button", { name: "Remove Second" }));
    await waitFor(() => expect(apiMock.removeGoogleAccount).toHaveBeenCalledWith(second.id));
    expect(apiMock.listGoogleAccounts).toHaveBeenCalledTimes(2);
  });

  it("does not mistake a failed account load for an empty registry", async () => {
    apiMock.listGoogleAccounts.mockRejectedValueOnce(new Error("Network unavailable"));
    render(<GoogleAccountsManager enabled onAuthRefresh={vi.fn(async () => {})} />);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Network unavailable");
    expect(screen.queryByText("No Google accounts linked yet.")).toBeNull();
  });

  it("shows Connected with its check time and checks a browser session on request", async () => {
    const checkedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    apiMock.listGoogleAccounts.mockResolvedValue({ accounts: [{ ...first, browserStatus: "CONNECTED", browserStatusReason: "VERIFIED", browserCheckedAt: checkedAt }, second] });
    apiMock.checkGoogleAccountBrowser.mockResolvedValue({ account: { ...second, browserStatus: "NOT_CONNECTED", browserStatusReason: "OTHER_ACCOUNT", browserCheckedAt: new Date().toISOString() }, check: { status: "NOT_CONNECTED", reason: "OTHER_ACCOUNT", checkedAt: new Date().toISOString(), connectedAt: null } });
    render(<GoogleAccountsManager enabled onAuthRefresh={vi.fn(async () => {})} />);
    expect(await screen.findByText("Space SSO linked · Browser connected · checked 5 min ago")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check browser session for Second" }));
    await waitFor(() => expect(apiMock.checkGoogleAccountBrowser).toHaveBeenCalledWith(second.id));
    expect(await screen.findByText(/signed in to a different Google account/)).toBeTruthy();
    expect(screen.getByText("Space SSO linked · Browser not connected · checked just now")).toBeTruthy();
  });

  it("reports a failed check without presenting it as a sign-out", async () => {
    apiMock.checkGoogleAccountBrowser.mockResolvedValue({ account: { ...first, browserStatus: "CONNECTED", browserStatusReason: "VERIFIED", browserCheckedAt: new Date().toISOString() }, check: { status: "UNKNOWN", reason: "CHECK_FAILED", checkedAt: new Date().toISOString(), connectedAt: null } });
    render(<GoogleAccountsManager enabled onAuthRefresh={vi.fn(async () => {})} />);
    fireEvent.click(await screen.findByRole("button", { name: "Check browser session for First" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/could not reach Google\. No sign-out was detected/);
    expect(screen.getByText(/Browser connected/)).toBeTruthy();
    expect(screen.queryByText(/reauthentication required/i)).toBeNull();
  });

  it("explains how to reconnect a browser profile without claiming Google sign-in", async () => {
    render(<GoogleAccountsManager enabled onAuthRefresh={vi.fn(async () => {})} />);
    expect(await screen.findByText(/Browser not connected/)).toBeTruthy();
    expect(screen.getByText(/Select this account in a Browser or YouTube pane/)).toBeTruthy();
  });
});
