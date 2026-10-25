import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomSharing } from "../src/features/rooms-dock/RoomSharing.js";
import { api, SpaceApiError } from "../src/api.js";

vi.mock("../src/api.js", async () => {
  const { SpaceApiError } = await import("../src/runtime/SpaceRuntime.js");
  return { SpaceApiError, api: { roomShares: vi.fn(), addRoomShare: vi.fn(), setRoomShare: vi.fn(), removeRoomShare: vi.fn() } };
});

const at = "2026-10-17T08:00:00.000Z";
const bob = { roomId: "room:alice-room", userId: "user:bob", email: "bob@example.test", permission: "VIEW" as const, createdBy: "user:alice", createdAt: at };

afterEach(() => vi.clearAllMocks());

describe("room sharing in the rooms dock", () => {
  it("shows nothing while the API does not answer (multi-user off, or not the room's owner)", async () => {
    vi.mocked(api.roomShares).mockRejectedValue(new SpaceApiError("off", { code: "MULTI_USER_DISABLED", status: 404 }));
    const { container } = await act(async () => render(<RoomSharing roomId="room:alice-room" />));
    expect(container.innerHTML).toBe("");
  });

  it("shares by email, changes a permission and removes a share", async () => {
    vi.mocked(api.roomShares).mockResolvedValue({ shares: [bob] });
    vi.mocked(api.addRoomShare).mockResolvedValue({ ...bob, userId: "user:carol" });
    vi.mocked(api.setRoomShare).mockResolvedValue({ ...bob, permission: "COLLABORATE" });
    vi.mocked(api.removeRoomShare).mockResolvedValue({ removed: true });
    await act(async () => render(<RoomSharing roomId="room:alice-room" />));
    expect(screen.getByText("bob@example.test")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();

    fireEvent.change(screen.getByLabelText("Share with email"), { target: { value: " carol@example.test " } });
    fireEvent.change(screen.getByLabelText("Share permission"), { target: { value: "COLLABORATE" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Share" })));
    expect(api.addRoomShare).toHaveBeenCalledWith("room:alice-room", "carol@example.test", "COLLABORATE");

    await act(async () => fireEvent.change(screen.getByLabelText("Permission for bob@example.test"), { target: { value: "COLLABORATE" } }));
    expect(api.setRoomShare).toHaveBeenCalledWith("room:alice-room", "user:bob", "COLLABORATE");

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop sharing with bob@example.test" })));
    expect(api.removeRoomShare).toHaveBeenCalledWith("room:alice-room", "user:bob");
    expect(api.roomShares).toHaveBeenCalledTimes(4);
  });

  it("shows why a share failed", async () => {
    vi.mocked(api.roomShares).mockResolvedValue({ shares: [] });
    vi.mocked(api.addRoomShare).mockRejectedValue(new SpaceApiError("No other SpaceApp user has this account.", { code: "USER_NOT_FOUND", status: 404 }));
    await act(async () => render(<RoomSharing roomId="room:alice-room" />));
    fireEvent.change(screen.getByLabelText("Share with email"), { target: { value: "nobody@example.test" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Share" })));
    expect(screen.getByRole("alert").textContent).toContain("No other SpaceApp user has this account.");
  });
});
