import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminUserItem, AuthMe, UserInvite } from "@space/contracts";
import { UserManagementDialog } from "../src/features/user-management/UserManagementDialog.js";
import { InviteAcceptScreen, readInviteToken } from "../src/features/auth/InviteAcceptScreen.js";
import { api, SpaceApiError } from "../src/api.js";

vi.mock("../src/api.js", async () => {
  const { SpaceApiError } = await import("../src/runtime/SpaceRuntime.js");
  return {
    SpaceApiError,
    api: {
      listAdminUsers: vi.fn(),
      updateUserRole: vi.fn(),
      listUserInvites: vi.fn(),
      createUserInvite: vi.fn(),
      revokeUserInvite: vi.fn(),
      setUserDisabled: vi.fn(),
      acceptUserInvite: vi.fn()
    }
  };
});

const at = "2026-10-16T10:00:00.000Z";
const user = (id: string, email: string, role: AdminUserItem["role"], disabled = false): AdminUserItem =>
  ({ id, email, role, roomCount: 1, disabled, createdAt: at, updatedAt: at });
const users = [user("user:owner", "owner@example.test", "ADMIN"), user("user:me", "me@example.test", "ADMIN"), user("user:b", "b@example.test", "USER")];
const openInvite: UserInvite = {
  id: "invite:1", email: "new@example.test", role: "USER", createdBy: "user:me", createdAt: at,
  expiresAt: "2999-01-01T00:00:00.000Z", acceptedAt: null, acceptedUserId: null, revokedAt: null
};

afterEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/");
});

async function renderDialog() {
  vi.mocked(api.listAdminUsers).mockResolvedValue({ users });
  await act(async () => render(<UserManagementDialog currentUserId="user:me" onClose={vi.fn()} />));
  await screen.findByText("b@example.test");
}

describe("multi-user account management", () => {
  it("shows nothing new while the API answers MULTI_USER_DISABLED", async () => {
    vi.mocked(api.listUserInvites).mockRejectedValue(new SpaceApiError("off", { code: "MULTI_USER_DISABLED", status: 404 }));
    await renderDialog();
    expect(screen.queryByLabelText("Invite email")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText("Active")).toBeNull();
    expect(screen.queryByText("off")).toBeNull();
  });

  it("shows the invite link once and revokes an open invite", async () => {
    vi.mocked(api.listUserInvites).mockResolvedValue({ invites: [] });
    vi.mocked(api.createUserInvite).mockResolvedValue({ invite: openInvite, token: "t".repeat(43) });
    await renderDialog();
    vi.mocked(api.listUserInvites).mockResolvedValue({ invites: [openInvite] });
    fireEvent.change(screen.getByLabelText("Invite email"), { target: { value: " new@example.test " } });
    fireEvent.change(screen.getByLabelText("Invite role"), { target: { value: "OPERATOR" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Invite" })));
    expect(api.createUserInvite).toHaveBeenCalledWith({ email: "new@example.test", role: "OPERATOR" });
    const link = `${window.location.origin}/invite#token=${"t".repeat(43)}`;
    expect(screen.getByText(link)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText(link)).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh" })));
    expect(screen.queryByText(link)).toBeNull();

    vi.mocked(api.revokeUserInvite).mockResolvedValue({ id: openInvite.id, revoked: true });
    vi.mocked(api.listUserInvites).mockResolvedValue({ invites: [{ ...openInvite, revokedAt: at }] });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Revoke invite for new@example.test" })));
    expect(api.revokeUserInvite).toHaveBeenCalledWith("invite:1");
    expect(await screen.findByText("Revoked")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Revoke invite/ })).toBeNull();
  });

  it("disables another user but never the owner or yourself", async () => {
    vi.mocked(api.listUserInvites).mockResolvedValue({ invites: [] });
    vi.mocked(api.setUserDisabled).mockResolvedValue({ id: "user:b", disabled: true });
    await renderDialog();
    expect((screen.getByLabelText("Active account owner@example.test") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Active account me@example.test") as HTMLInputElement).disabled).toBe(true);
    const other = screen.getByLabelText("Active account b@example.test") as HTMLInputElement;
    expect(other.checked).toBe(true);
    await act(async () => fireEvent.click(other));
    expect(api.setUserDisabled).toHaveBeenCalledWith("user:b", true);
    await waitFor(() => expect((screen.getByLabelText("Active account b@example.test") as HTMLInputElement).checked).toBe(false));
  });
});

describe("invite acceptance", () => {
  it("reads the token only from /invite#token=", () => {
    expect(readInviteToken({ pathname: "/invite", hash: "#token=abc" })).toBe("abc");
    expect(readInviteToken({ pathname: "/", hash: "#token=abc" })).toBeNull();
    expect(readInviteToken({ pathname: "/invite", hash: "" })).toBeNull();
  });

  it("asks for the password twice, then signs the new account in", async () => {
    window.history.replaceState({}, "", "/invite#token=abc");
    const signedIn: AuthMe = { user: null, isAuthenticated: true, isSetupRequired: false };
    vi.mocked(api.acceptUserInvite).mockResolvedValue(signedIn);
    const onLogin = vi.fn();
    render(<InviteAcceptScreen token="abc" modern={false} colorMode={null} onLogin={onLogin} />);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "synthetic-password-1" } });
    fireEvent.change(screen.getByLabelText("Repeat password"), { target: { value: "synthetic-password-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(screen.getByText("The passwords do not match.")).toBeTruthy();
    expect(api.acceptUserInvite).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Repeat password"), { target: { value: "synthetic-password-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(onLogin).toHaveBeenCalledWith(signedIn));
    expect(api.acceptUserInvite).toHaveBeenCalledExactlyOnceWith("abc", "synthetic-password-1");
    expect(window.location.pathname + window.location.hash).toBe("/");
  });
});
