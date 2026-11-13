import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstanceLink } from "../src/api.js";

const apiMock = vi.hoisted(() => ({ listInstanceLinks: vi.fn(), linkInstance: vi.fn(), checkInstanceLink: vi.fn(), removeInstanceLink: vi.fn() }));
vi.mock("../src/api.js", () => ({ api: apiMock }));
const { InstanceLinksManager } = await import("../src/features/auth/InstanceLinksManager.js");

// Settings > Account > Linked SpaceApps (Space Link slice 2b, ADR-014): paste another SpaceApp's code, check and remove a link.
const at = new Date().toISOString();
const link = (overrides: Partial<InstanceLink> = {}): InstanceLink => ({ id: "link:one", label: "SpaceApp vm207", origins: ["https://vm207.example:4911"],
  deviceId: "appdev:link0001", scopes: ["read"], createdAt: at, lastSeenAt: null, connected: false, ...overrides });
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); });

describe("InstanceLinksManager", () => {
  it("links from a pasted code kept out of the Space clipboard, checks and removes the link", async () => {
    apiMock.listInstanceLinks.mockResolvedValue({ links: [] });
    apiMock.linkInstance.mockResolvedValue({ link: link(), pending: ["read", "act"] });
    apiMock.checkInstanceLink.mockResolvedValue({ link: link({ scopes: ["read", "act"], lastSeenAt: at, connected: true }), scopes: ["read", "act"], status: 200, rttMs: 42 });
    apiMock.removeInstanceLink.mockResolvedValue({ ok: true });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<InstanceLinksManager />);
    expect(await screen.findByText("No SpaceApp is linked.")).toBeTruthy();
    const input = screen.getByPlaceholderText("SPACEAPP-PAIR:1:…");
    expect(input.closest("[data-space-clipboard-capture='off']")).toBeTruthy();
    expect(input.getAttribute("data-sensitive-masked")).toBe("pairing");
    fireEvent.change(input, { target: { value: "  SPACEAPP-PAIR:1:abc  " } });
    fireEvent.click(screen.getByRole("button", { name: "Link SpaceApp" }));
    await waitFor(() => expect(apiMock.linkInstance).toHaveBeenCalledWith("SPACEAPP-PAIR:1:abc"));
    expect(await screen.findByText(/Linked SpaceApp vm207\. It only reads until its person allows it/)).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Check SpaceApp vm207" }));
    expect(await screen.findByText("SpaceApp vm207 answered in 42 ms; this SpaceApp may read, act there.")).toBeTruthy();
    expect(screen.getByText(/may read, act · last connected/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove SpaceApp vm207" }));
    await waitFor(() => expect(apiMock.removeInstanceLink).toHaveBeenCalledWith("link:one"));
    expect(await screen.findByText("No SpaceApp is linked.")).toBeTruthy();
  });

  it("shows the server's refusal and hides where the list is not reachable (a USER account)", async () => {
    apiMock.listInstanceLinks.mockResolvedValueOnce({ links: [link()] });
    apiMock.checkInstanceLink.mockRejectedValue(new Error("That SpaceApp did not answer."));
    const { unmount } = render(<InstanceLinksManager />);
    fireEvent.click(await screen.findByRole("button", { name: "Check SpaceApp vm207" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That SpaceApp did not answer.");
    unmount();
    apiMock.listInstanceLinks.mockRejectedValue(new Error("Not found"));
    const { container } = render(<InstanceLinksManager />);
    await waitFor(() => expect(container.innerHTML).toBe(""));
  });
});
