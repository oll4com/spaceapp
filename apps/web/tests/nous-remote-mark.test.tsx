import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({ liveDeviceSessions: vi.fn(), listInstanceLinks: vi.fn(), linkManagement: vi.fn() }));
const settings = vi.hoisted(() => ({ openSettingsSection: vi.fn() }));
vi.mock("../src/api.js", () => ({ api: apiMock }));
vi.mock("../src/features/settings/settings-section-request.js", () => settings);
const { NousRemoteMark } = await import("../src/features/nous/NousRemoteMark.js");

// Space Link slice 4 (ADR-014, operator 13/11): the Remote mark shows which Nous is connected, from where, since when; Managing N lists the links.
const at = "2026-11-13T01:00:00.000Z";
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("NousRemoteMark", () => {
  it("shows Remote with the connected Nous's address and last request, and Managing N, and opens Settings > Account", async () => {
    apiMock.liveDeviceSessions.mockResolvedValue({ sessions: [
      { deviceId: "appdev:a", app: "spaceapp-link", name: "SpaceApp vm208", ip: "203.0.113.7", since: at, scopes: ["read", "act"],
        last: { method: "POST", path: "/api/control/v1/commands", at }, rttMs: 23 },
      { deviceId: "appdev:p", app: "spaceapp-mobile", name: "Pixel", ip: "198.51.100.2", since: at, scopes: ["read"], last: null, rttMs: null }] });
    apiMock.listInstanceLinks.mockResolvedValue({ links: [{ id: "link:one", label: "SpaceApp vm207", origins: ["https://vm207.example:4911"], deviceId: "appdev:x",
      scopes: ["read"], createdAt: at, lastSeenAt: null, connected: false }] });
    render(<NousRemoteMark active />);
    const remote = await screen.findByRole("button", { name: "Remote" });
    const info = remote.getAttribute("title")!;
    expect(info).toContain("SpaceApp vm208 from 203.0.113.7");
    expect(info).toContain("May read, act");
    expect(info).toContain("Last request POST /api/control/v1/commands at");
    expect(info).toContain("Round trip 23 ms");
    expect(info).not.toContain("Pixel");
    // The same text reaches the keyboard and a screen reader as the button's description.
    expect(document.getElementById(remote.getAttribute("aria-describedby")!)!.textContent).toBe(info);
    expect((await screen.findByRole("button", { name: "Managing 1" })).getAttribute("title")).toContain("SpaceApp vm207 at https://vm207.example:4911: may read; never connected yet");
    fireEvent.click(remote);
    expect(settings.openSettingsSection).toHaveBeenCalledWith("account");
  });

  it("Take back holds the links at reading and shows Give back, which lets them act again (slice 5)", async () => {
    const session = { deviceId: "appdev:a", app: "spaceapp-link", name: "SpaceApp vm208", ip: "203.0.113.7", since: at, scopes: ["read", "act"], last: null, rttMs: null };
    apiMock.liveDeviceSessions.mockResolvedValue({ sessions: [session], lease: { deviceId: "appdev:a", name: "SpaceApp vm208", since: at }, takenBackAt: null });
    apiMock.listInstanceLinks.mockResolvedValue({ links: [] });
    apiMock.linkManagement.mockResolvedValueOnce({ sessions: [session], lease: null, takenBackAt: at }).mockResolvedValueOnce({ sessions: [session], lease: null, takenBackAt: null });
    render(<NousRemoteMark active />);
    expect((await screen.findByRole("button", { name: "Remote" })).getAttribute("title")).toContain("Manages this SpaceApp since");
    fireEvent.click(screen.getByRole("button", { name: "Take back" }));
    expect(apiMock.linkManagement).toHaveBeenCalledWith("take-back");
    fireEvent.click(await screen.findByRole("button", { name: "Give back" }));
    expect(apiMock.linkManagement).toHaveBeenLastCalledWith("give-back");
    expect(await screen.findByRole("button", { name: "Take back" })).toBeTruthy();
  });

  it("shows nothing without links, or where the routes answer an error", async () => {
    apiMock.liveDeviceSessions.mockRejectedValue(new Error("403"));
    apiMock.listInstanceLinks.mockResolvedValue({ links: [] });
    const { container } = render(<NousRemoteMark active />);
    await Promise.resolve();
    expect(container.innerHTML).toBe("");
  });
});
