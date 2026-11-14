import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstanceLink } from "../src/api.js";

const apiMock = vi.hoisted(() => ({ listInstanceLinks: vi.fn(), linkInstance: vi.fn(), checkInstanceLink: vi.fn(), removeInstanceLink: vi.fn(), instanceLinkHistory: vi.fn() }));
vi.mock("../src/api.js", () => ({ api: apiMock }));
const { InstanceLinksManager } = await import("../src/features/auth/InstanceLinksManager.js");

// Settings > Account > Linked SpaceApps (Space Link slice 2b, ADR-014): paste another SpaceApp's code, check and remove a link.
const at = new Date().toISOString();
const link = (overrides: Partial<InstanceLink> = {}): InstanceLink => ({ id: "link:one", label: "SpaceApp vm207", origins: ["https://vm207.example:4911"],
  deviceId: "appdev:link0001", scopes: ["read"], access: null, createdAt: at, lastSeenAt: null, connected: false, ...overrides });
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
    await waitFor(() => expect(apiMock.linkInstance).toHaveBeenCalledWith("SPACEAPP-PAIR:1:abc", undefined));
    expect(await screen.findByText(/Linked SpaceApp vm207\. It only reads until its person allows it/)).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Check SpaceApp vm207" }));
    expect(await screen.findByText("SpaceApp vm207 answered in 42 ms; this SpaceApp may read, act there.")).toBeTruthy();
    expect(screen.getByText(/may read, act · last connected/)).toBeTruthy();
    // Λ4: History lists the link's acts with the trace id both SpaceApps audit them under, and its pairing; a second click hides it.
    apiMock.instanceLinkHistory.mockResolvedValue({ events: [
      { id: "audit:2", action: "instance_link.request", requestId: "lnk:abcdefghijklmnop", createdAt: at, metadata: { method: "POST", path: "/api/control/v1/commands", status: 400 } },
      { id: "audit:1", action: "instance_link.paired", requestId: "req:pair", createdAt: at, metadata: null }] });
    const historyButton = screen.getByRole("button", { name: "History SpaceApp vm207" });
    fireEvent.click(historyButton);
    const list = await screen.findByRole("list", { name: "History of SpaceApp vm207" });
    expect(apiMock.instanceLinkHistory).toHaveBeenCalledWith("link:one");
    expect(list.textContent).toContain("POST /api/control/v1/commands → 400 · lnk:abcdefghijklmnop");
    expect(list.textContent).toContain("Linked · req:pair");
    expect(historyButton.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(historyButton);
    expect(screen.queryByRole("list", { name: "History of SpaceApp vm207" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove SpaceApp vm207" }));
    await waitFor(() => expect(apiMock.removeInstanceLink).toHaveBeenCalledWith("link:one"));
    expect(await screen.findByText("No SpaceApp is linked.")).toBeTruthy();
  });

  it("sends the Vault key ids of a Cloudflare Access service token and marks the link", async () => {
    apiMock.listInstanceLinks.mockResolvedValue({ links: [] });
    const access = { clientId: "vault_key:clientIdKey01", clientSecret: "vault_key:secretKey0001" };
    apiMock.linkInstance.mockResolvedValue({ link: link({ access }), pending: [] });
    render(<InstanceLinksManager />);
    // 13/11: the two Access fields filled and no code: the grey button says what it waits for, and the hint goes once the code is in.
    const waits = /Link SpaceApp turns on once the pairing code is in/;
    expect(await screen.findByText(waits)).toBeTruthy();
    fireEvent.change(await screen.findByPlaceholderText("SPACEAPP-PAIR:1:…"), { target: { value: "SPACEAPP-PAIR:1:abc" } });
    expect(screen.queryByText(waits)).toBeNull();
    fireEvent.change(screen.getByLabelText("Service token client id (Vault key id)"), { target: { value: ` ${access.clientId} ` } });
    fireEvent.change(screen.getByLabelText("Service token secret (Vault key id)"), { target: { value: access.clientSecret } });
    fireEvent.click(screen.getByRole("button", { name: "Link SpaceApp" }));
    await waitFor(() => expect(apiMock.linkInstance).toHaveBeenCalledWith("SPACEAPP-PAIR:1:abc", access));
    expect(await screen.findByText(/through Cloudflare Access ·/)).toBeTruthy();
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
