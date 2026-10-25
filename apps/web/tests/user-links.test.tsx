import { useLayoutEffect, useRef } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserLink } from "@space/contracts";

const mocks = vi.hoisted(() => ({
  links: vi.fn(),
  inspectLink: vi.fn(),
  createLink: vi.fn(),
  updateLink: vi.fn(),
  deleteLink: vi.fn()
}));

vi.mock("../src/api.js", () => ({ api: mocks }));

import { LinkFavicon, LinksPanel, QuickLinksPopover, USER_LINKS_UPDATED_EVENT, writeQuickLinksCache } from "../src/features/user-links/UserLinks.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

const seeded: UserLink[] = [{
  id: "link:codex", title: "Codex LB", description: "Routing dashboard", url: "https://example.invalid:2455/",
  openMode: "EMBEDDED", category: "GENERAL", isQuick: true, sortOrder: 0,
  createdAt: "2026-07-16T08:00:00.000Z", updatedAt: "2026-07-16T08:00:00.000Z"
}];
const musicLink: UserLink = {
  ...seeded[0]!, id: "link:music", title: "Focus mix", description: "", url: "https://www.youtube.com/watch?v=abc",
  category: "MUSIC_LIBRARY", isQuick: false, sortOrder: 1
};
const page = (data: UserLink[], totalItems = data.length) => ({ data, pagination: { page: 1, pageSize: 10, totalItems, totalPages: totalItems ? 1 : 0 } });
const filterGroup = () => screen.getByRole("group", { name: "Filter by link type" });
const confirmDialog = (name: string) => screen.getByRole("alertdialog", { name });

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  localStorage.clear();
  installSpaceRuntime(liveRuntime);
  vi.clearAllMocks();
});

describe("Links UI", () => {
  it("retains an immediate image-error fallback and retries only when the URL changes", () => {
    function ImmediateFailure() {
      const root = useRef<HTMLDivElement>(null);
      useLayoutEffect(() => { fireEvent.error(root.current!.querySelector("img")!); }, []);
      return <div ref={root}><LinkFavicon link={seeded[0]!} /></div>;
    }
    const first = render(<ImmediateFailure />);
    expect(first.container.querySelector("img")).toBeNull();
    expect(first.container.querySelector("svg")).toBeTruthy();
    first.unmount();

    const view = render(<LinkFavicon link={seeded[0]!} />);
    fireEvent.error(view.container.querySelector("img")!);
    view.rerender(<LinkFavicon link={{ ...seeded[0]!, title: "Renamed link" }} />);
    expect(view.container.querySelector("img")).toBeNull();
    view.rerender(<LinkFavicon link={{ ...seeded[0]!, url: "https://example.org/new" }} />);
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe("https://example.org/favicon.ico");
  });

  it("loads, searches as you type, opens, falls back from a blocked favicon, and toggles Quick", async () => {
    mocks.links.mockResolvedValue(page(seeded));
    mocks.updateLink.mockResolvedValue({ ...seeded[0]!, isQuick: false });
    const onOpen = vi.fn();
    const { container } = render(<LinksPanel onOpen={onOpen} />);
    expect(screen.getByRole("status").textContent).toContain("Loading links");
    expect(await screen.findByText("Codex LB")).toBeTruthy();
    expect(container.querySelector(".links-panel")?.getAttribute("aria-label")).toBe("Links library");
    expect(container.querySelector(".dock-kit-toolbar")?.textContent).toContain("1 link");
    expect(container.querySelector("input[type='checkbox']:not([role='switch'])")).toBeNull();
    const favicon = container.querySelector(".link-favicon img")!;
    expect(favicon.getAttribute("referrerpolicy")).toBe("no-referrer");
    fireEvent.error(favicon);
    await waitFor(() => expect(container.querySelector(".link-favicon svg")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Open Codex LB" }));
    expect(onOpen).toHaveBeenCalledWith(seeded[0]);

    // No Search button: the list follows the search box after a short pause.
    expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search links" }), { target: { value: "routing" } });
    await waitFor(() => expect(mocks.links).toHaveBeenLastCalledWith(expect.objectContaining({ q: "routing", page: 1 })));
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() => expect(mocks.links).toHaveBeenLastCalledWith(expect.objectContaining({ q: undefined })));

    const star = screen.getByRole("button", { name: "Remove Codex LB from Quick Links" });
    expect(star.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(star);
    await waitFor(() => expect(mocks.updateLink).toHaveBeenCalledWith("link:codex", { isQuick: false }));
    expect(screen.getByRole("button", { name: "Add Codex LB to Quick Links" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("debounces typing into one request", async () => {
    mocks.links.mockResolvedValue(page(seeded));
    render(<LinksPanel onOpen={vi.fn()} />);
    await screen.findByText("Codex LB");
    const search = screen.getByRole("searchbox", { name: "Search links" });
    fireEvent.change(search, { target: { value: "r" } });
    fireEvent.change(search, { target: { value: "ro" } });
    fireEvent.change(search, { target: { value: "rou" } });
    await waitFor(() => expect(mocks.links).toHaveBeenLastCalledWith(expect.objectContaining({ q: "rou" })));
    expect(mocks.links.mock.calls.filter(([query]) => query.q).map(([query]) => query.q)).toEqual(["rou"]);
  });

  it("submits a link by URL with an auto-read title and confirms deletion in the dock", async () => {
    mocks.links.mockResolvedValue(page(seeded));
    mocks.inspectLink.mockResolvedValue({ url: "https://example.com/docs", title: "Auto Docs", openMode: "EMBEDDED", canEmbed: true });
    mocks.createLink.mockResolvedValue(seeded[0]!);
    mocks.deleteLink.mockResolvedValue({ id: seeded[0]!.id, deleted: true });
    const nativeConfirm = vi.fn(() => true);
    vi.stubGlobal("confirm", nativeConfirm);
    const updated = vi.fn();
    window.addEventListener(USER_LINKS_UPDATED_EVENT, updated);
    render(<LinksPanel onOpen={vi.fn()} />);
    await screen.findByText("Codex LB");
    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    const form = screen.getByRole("form", { name: "Add link" });
    expect(within(form).queryByLabelText("Description")).toBeNull();
    fireEvent.change(within(form).getByLabelText("URL"), { target: { value: "https://example.com/docs" } });
    fireEvent.click(within(form).getByRole("switch", { name: "Add to Quick Links" }));
    fireEvent.click(within(form).getByRole("button", { name: "Save link" }));
    await waitFor(() => expect(mocks.createLink).toHaveBeenCalledWith(expect.objectContaining({
      title: "Auto Docs", url: "https://example.com/docs", isQuick: true, category: "GENERAL", openMode: "EMBEDDED", description: ""
    })));
    await waitFor(() => expect(screen.queryByRole("form", { name: "Add link" })).toBeNull());
    expect(updated).toHaveBeenCalled();

    // Cancelling the in-app confirmation keeps the link.
    fireEvent.click(screen.getByRole("button", { name: "Delete Codex LB" }));
    fireEvent.click(within(confirmDialog("Delete this link?")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(mocks.deleteLink).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete Codex LB" }));
    expect(confirmDialog("Delete this link?").textContent).toContain("\"Codex LB\" will be removed");
    fireEvent.click(within(confirmDialog("Delete this link?")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mocks.deleteLink).toHaveBeenCalledWith("link:codex"));
    expect(nativeConfirm).not.toHaveBeenCalled();
    window.removeEventListener(USER_LINKS_UPDATED_EVENT, updated);
    vi.unstubAllGlobals();
  });

  it("filters with link type chips, remembers the choice, and defaults a new link to the active type", async () => {
    mocks.links.mockResolvedValue(page(seeded));
    mocks.inspectLink.mockResolvedValue({ url: "https://example.com/vinyl", title: "Vinyl Records", openMode: "EMBEDDED", canEmbed: true });
    mocks.createLink.mockResolvedValue(seeded[0]!);
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    render(<LinksPanel onOpen={vi.fn()} />);
    await screen.findByText("Codex LB");

    const musicChip = within(filterGroup()).getByRole("button", { name: "Music library" });
    fireEvent.click(musicChip);
    expect(musicChip.getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("space:user-links-selected-category")).toBe("MUSIC_LIBRARY");
    await waitFor(() => expect(mocks.links).toHaveBeenLastCalledWith(expect.objectContaining({ category: "MUSIC_LIBRARY" })));

    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    const form = screen.getByRole("form", { name: "Add link" });
    expect((within(form).getByLabelText("Link type") as HTMLSelectElement).value).toBe("MUSIC_LIBRARY");
    expect(within(form).queryByText("Inside Space")).toBeNull();
    expect(within(form).getByText("Music links always play inside Space.")).toBeTruthy();
    fireEvent.change(within(form).getByLabelText("URL"), { target: { value: "https://example.com/vinyl" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save link" }));
    await waitFor(() => expect(mocks.createLink).toHaveBeenCalledWith(expect.objectContaining({ title: "Vinyl Records", category: "MUSIC_LIBRARY", openMode: "EMBEDDED" })));

    fireEvent.click(within(filterGroup()).getByRole("button", { name: "All" }));
    await waitFor(() => expect(mocks.links).toHaveBeenLastCalledWith(expect.objectContaining({ category: undefined })));
    expect(localStorage.getItem("space:user-links-selected-category")).toBe("ALL");
    fireEvent.click(await screen.findByRole("button", { name: "Edit Codex LB" }));
    const editForm = screen.getByRole("form", { name: "Edit link" });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(within(editForm).getByRole("group", { name: "Opens in" })).toBeTruthy();
    expect(within(editForm).getByRole("button", { name: "Inside Space" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("restores the remembered link type on the next visit", async () => {
    localStorage.setItem("space:user-links-selected-category", "MUSIC_LIBRARY");
    mocks.links.mockResolvedValue(page([musicLink]));
    render(<LinksPanel onOpen={vi.fn()} />);
    expect(await screen.findByText("Focus mix")).toBeTruthy();
    expect(mocks.links).toHaveBeenCalledWith(expect.objectContaining({ category: "MUSIC_LIBRARY", page: 1 }));
    expect(within(filterGroup()).getByRole("button", { name: "Music library" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("lets the user choose the link type when adding and explains where a saved link went", async () => {
    mocks.links.mockResolvedValue(page(seeded));
    mocks.inspectLink.mockResolvedValue({ url: "https://example.com/beats", title: "Beats", openMode: "EMBEDDED", canEmbed: true });
    mocks.createLink.mockResolvedValue({ ...musicLink, id: "link:beats", title: "Beats" });
    render(<LinksPanel onOpen={vi.fn()} />);
    await screen.findByText("Codex LB");
    fireEvent.click(within(filterGroup()).getByRole("button", { name: "General" }));
    await waitFor(() => expect(mocks.links).toHaveBeenLastCalledWith(expect.objectContaining({ category: "GENERAL" })));

    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    const form = screen.getByRole("form", { name: "Add link" });
    expect((within(form).getByLabelText("Link type") as HTMLSelectElement).value).toBe("GENERAL");
    fireEvent.change(within(form).getByLabelText("Link type"), { target: { value: "MUSIC_LIBRARY" } });
    fireEvent.change(within(form).getByLabelText("URL"), { target: { value: "https://example.com/beats" } });
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Beats" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save link" }));
    await waitFor(() => expect(mocks.createLink).toHaveBeenCalledWith(expect.objectContaining({ title: "Beats", category: "MUSIC_LIBRARY", openMode: "EMBEDDED" })));
    expect(await screen.findByText(/Saved to Music library\. Choose All or Music library to see it\./)).toBeTruthy();
  });

  it("keeps the saved description when a link is edited", async () => {
    mocks.links.mockResolvedValue(page(seeded));
    mocks.updateLink.mockResolvedValue({ ...seeded[0]!, title: "Codex balancer" });
    render(<LinksPanel onOpen={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Codex LB" }));
    const form = screen.getByRole("form", { name: "Edit link" });
    expect((within(form).getByLabelText("Title") as HTMLInputElement).value).toBe("Codex LB");
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Codex balancer" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save link" }));
    await waitFor(() => expect(mocks.updateLink).toHaveBeenCalledTimes(1));
    const [id, payload] = mocks.updateLink.mock.calls[0]!;
    expect(id).toBe("link:codex");
    expect(payload).toEqual({ title: "Codex balancer", url: "https://example.invalid:2455/", openMode: "EMBEDDED", category: "GENERAL", isQuick: true });
    // An empty description would erase "Routing dashboard" on the server.
    expect(payload).not.toHaveProperty("description");
    expect(mocks.inspectLink).not.toHaveBeenCalled();
  });

  it("explains why plain HTTP links open in a new tab", async () => {
    mocks.links.mockResolvedValue(page(seeded));
    mocks.inspectLink.mockResolvedValue({ url: "http://intranet.example/wiki", title: "Wiki", openMode: "NEW_TAB", canEmbed: false });
    mocks.createLink.mockResolvedValue(seeded[0]!);
    render(<LinksPanel onOpen={vi.fn()} />);
    await screen.findByText("Codex LB");
    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    const form = screen.getByRole("form", { name: "Add link" });
    expect(within(form).getByRole("button", { name: "Inside Space" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(within(form).getByLabelText("URL"), { target: { value: "http://intranet.example/wiki" } });
    expect(within(form).getByText(/Plain HTTP pages cannot be shown inside Space/)).toBeTruthy();
    expect((within(form).getByRole("button", { name: "Inside Space" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(form).getByRole("button", { name: "New browser tab" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Wiki" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save link" }));
    await waitFor(() => expect(mocks.createLink).toHaveBeenCalledWith(expect.objectContaining({ url: "http://intranet.example/wiki", openMode: "NEW_TAB" })));
  });

  it("explains a site that blocks embedding and keeps an explicit new-tab choice", async () => {
    mocks.links.mockResolvedValue(page(seeded));
    mocks.inspectLink.mockImplementation(async (url: string) => url.includes("blocked")
      ? { url, title: "Blocked site", openMode: "NEW_TAB", canEmbed: false }
      : { url, title: "Open site", openMode: "EMBEDDED", canEmbed: true });
    mocks.createLink.mockResolvedValue(seeded[0]!);
    render(<LinksPanel onOpen={vi.fn()} />);
    await screen.findByText("Codex LB");
    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    let form = screen.getByRole("form", { name: "Add link" });
    fireEvent.change(within(form).getByLabelText("URL"), { target: { value: "https://blocked.example" } });
    fireEvent.blur(within(form).getByLabelText("URL"));
    expect(await within(form).findByText(/This site does not allow being shown inside Space/)).toBeTruthy();
    expect(within(form).getByRole("button", { name: "New browser tab" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Add link" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    form = screen.getByRole("form", { name: "Add link" });
    fireEvent.click(within(form).getByRole("button", { name: "New browser tab" }));
    fireEvent.change(within(form).getByLabelText("URL"), { target: { value: "https://open.example" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save link" }));
    await waitFor(() => expect(mocks.createLink).toHaveBeenCalledWith(expect.objectContaining({ title: "Open site", openMode: "NEW_TAB" })));
  });

  it("auto-detects a real YouTube title without the trailing - YouTube and hides open options in Music library", async () => {
    mocks.links.mockResolvedValue(page(seeded));
    mocks.inspectLink.mockResolvedValue({
      url: "https://www.youtube.com/watch?v=cALSSb4RLik",
      title: "Night Coding Music — Work Focus Music for Programmers - YouTube",
      openMode: "EMBEDDED",
      canEmbed: true
    });
    mocks.createLink.mockResolvedValue(seeded[0]!);

    render(<LinksPanel onOpen={vi.fn()} />);
    await screen.findByText("Codex LB");
    fireEvent.click(within(filterGroup()).getByRole("button", { name: "Music library" }));
    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    const form = screen.getByRole("form", { name: "Add link" });
    expect(within(form).queryByText("Inside Space")).toBeNull();
    expect(within(form).queryByText("New browser tab")).toBeNull();

    fireEvent.change(within(form).getByLabelText("URL"), { target: { value: "https://www.youtube.com/watch?v=cALSSb4RLik" } });
    await waitFor(() => {
      const titleInput = within(form).getByPlaceholderText(/Auto-detected from site|Reading title from site…/) as HTMLInputElement;
      expect(titleInput.value).toBe("Night Coding Music — Work Focus Music for Programmers");
    });

    fireEvent.click(within(form).getByRole("button", { name: "Save link" }));
    await waitFor(() => expect(mocks.createLink).toHaveBeenCalledWith(expect.objectContaining({
      title: "Night Coding Music — Work Focus Music for Programmers",
      url: "https://www.youtube.com/watch?v=cALSSb4RLik",
      category: "MUSIC_LIBRARY",
      openMode: "EMBEDDED"
    })));
  });

  it("does not overwrite an address the user kept typing while the site check ran", async () => {
    mocks.links.mockResolvedValue(page(seeded));
    let resolveInspect: (value: unknown) => void = () => undefined;
    mocks.inspectLink.mockReturnValueOnce(new Promise((resolve) => { resolveInspect = resolve; }));
    render(<LinksPanel onOpen={vi.fn()} />);
    await screen.findByText("Codex LB");
    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    const url = screen.getByLabelText("URL") as HTMLInputElement;
    fireEvent.change(url, { target: { value: "example.com" } });
    fireEvent.blur(url);
    await waitFor(() => expect(mocks.inspectLink).toHaveBeenCalledWith("https://example.com"));
    fireEvent.change(url, { target: { value: "example.com/docs" } });
    resolveInspect({ url: "https://example.com", title: "Example", openMode: "EMBEDDED", canEmbed: true });
    await waitFor(() => expect(screen.queryByText("Reading the page title…")).toBeNull());
    expect(url.value).toBe("example.com/docs");
  });

  it("shows a YouTube hint instead of open options for a General YouTube link", async () => {
    mocks.links.mockResolvedValue(page(seeded));
    mocks.inspectLink.mockResolvedValue({ url: "https://youtu.be/abc", title: "A talk", openMode: "EMBEDDED", canEmbed: true });
    render(<LinksPanel onOpen={vi.fn()} />);
    await screen.findByText("Codex LB");
    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    const form = screen.getByRole("form", { name: "Add link" });
    fireEvent.change(within(form).getByLabelText("URL"), { target: { value: "https://youtu.be/abc" } });
    expect(within(form).getByText("YouTube links play in a YouTube pane inside Space.")).toBeTruthy();
    expect(within(form).queryByRole("group", { name: "Opens in" })).toBeNull();
  });

  it("shows a retryable error when the first load fails", async () => {
    mocks.links.mockRejectedValueOnce(new Error("The links service is offline.")).mockResolvedValue(page(seeded));
    render(<LinksPanel onOpen={vi.fn()} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Links could not be loaded");
    expect(alert.textContent).toContain("The links service is offline.");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Codex LB")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the list and shows a dismissible notice when a later load fails", async () => {
    mocks.links.mockResolvedValueOnce(page(seeded)).mockRejectedValueOnce(new Error("Search is unavailable."));
    render(<LinksPanel onOpen={vi.fn()} />);
    await screen.findByText("Codex LB");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search links" }), { target: { value: "x" } });
    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toContain("Search is unavailable.");
    expect(screen.getByText("Codex LB")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(within(notice).getByRole("button", { name: "Dismiss message" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the server result as is, without filtering it again", async () => {
    localStorage.setItem("space:user-links-selected-category", "MUSIC_LIBRARY");
    // The server owns filtering; whatever it returns for the active type is shown.
    mocks.links.mockResolvedValue(page([seeded[0]!, musicLink]));
    render(<LinksPanel onOpen={vi.fn()} />);
    expect(await screen.findByText("Focus mix")).toBeTruthy();
    expect(screen.getByText("Codex LB")).toBeTruthy();
  });

  it("ignores a slower response for a filter the user already left", async () => {
    let resolveGeneral: (value: unknown) => void = () => undefined;
    mocks.links.mockImplementation((query: { category?: string }) => {
      if (query.category === "GENERAL") return new Promise((resolve) => { resolveGeneral = resolve; });
      if (query.category === "MUSIC_LIBRARY") return Promise.resolve(page([musicLink]));
      return Promise.resolve(page(seeded));
    });
    render(<LinksPanel onOpen={vi.fn()} />);
    await screen.findByText("Codex LB");
    fireEvent.click(within(filterGroup()).getByRole("button", { name: "General" }));
    await waitFor(() => expect(mocks.links).toHaveBeenLastCalledWith(expect.objectContaining({ category: "GENERAL" })));
    fireEvent.click(within(filterGroup()).getByRole("button", { name: "Music library" }));
    expect(await screen.findByText("Focus mix")).toBeTruthy();
    resolveGeneral(page([{ ...seeded[0]!, id: "link:late", title: "Late general link" }]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Late general link")).toBeNull();
    expect(screen.getByText("Focus mix")).toBeTruthy();
  });

  it("loads more links with a styled button", async () => {
    mocks.links
      .mockResolvedValueOnce(page(seeded, 2))
      .mockResolvedValueOnce({ data: [musicLink], pagination: { page: 2, pageSize: 10, totalItems: 2, totalPages: 1 } });
    render(<LinksPanel onOpen={vi.fn()} />);
    await screen.findByText("Codex LB");
    const loadMore = screen.getByRole("button", { name: "Load more" });
    expect(loadMore.className).toContain("dock-kit-button");
    fireEvent.click(loadMore);
    expect(await screen.findByText("Focus mix")).toBeTruthy();
    expect(mocks.links).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
    expect(screen.getByText("Codex LB")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("shows clear empty states and opens the editor from the first-run action", async () => {
    mocks.links.mockResolvedValue(page([]));
    render(<LinksPanel onOpen={vi.fn()} />);
    expect(await screen.findByText("No links yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add your first link" }));
    expect(screen.getByRole("form", { name: "Add link" })).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText("URL"), { key: "Escape" });
    expect(screen.queryByRole("form", { name: "Add link" })).toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search links" }), { target: { value: "nothing" } });
    expect(await screen.findByText("No links match this search.")).toBeTruthy();
  });

  it("opens and leaves fullscreen", async () => {
    mocks.links.mockResolvedValue(page(seeded));
    const { container } = render(<LinksPanel onOpen={vi.fn()} />);
    await screen.findByText("Codex LB");
    expect(container.querySelector(".dock-kit-title")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open links fullscreen" }));
    expect(container.querySelector(".dock-kit-shell.is-fullscreen")).toBeTruthy();
    expect(container.querySelector(".dock-kit-title")?.textContent).toBe("Links");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(container.querySelector(".dock-kit-shell.is-fullscreen")).toBeNull());
  });
});

describe("Quick Links popover", () => {
  it("shows Quick-only empty state and Manage Links action with Escape dismissal", async () => {
    mocks.links.mockResolvedValue(page([]));
    const onClose = vi.fn(); const onManage = vi.fn();
    render(<QuickLinksPopover open onClose={onClose} onOpen={vi.fn()} onManage={onManage} />);
    expect(await screen.findByText(/No Quick Links yet/)).toBeTruthy();
    expect(mocks.links).toHaveBeenCalledWith({ isQuick: true, page: 1, pageSize: 10 });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Manage Links" }));
    expect(onManage).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("renders Quick Links with title only, without description and without Loading Quick Links text", async () => {
    mocks.links.mockResolvedValue(page(seeded));
    render(<QuickLinksPopover open onClose={vi.fn()} onOpen={vi.fn()} onManage={vi.fn()} />);
    expect(await screen.findByText("Codex LB")).toBeTruthy();
    expect(screen.queryByText("Routing dashboard")).toBeNull();
    expect(screen.queryByText(/Loading Quick Links/)).toBeNull();
  });

  it("serves Quick Links instantly from cache without network delay and revalidates", async () => {
    writeQuickLinksCache(seeded, 1);
    let resolveApi: ((val: unknown) => void) | null = null;
    mocks.links.mockReturnValue(new Promise((resolve) => { resolveApi = resolve; }));

    render(<QuickLinksPopover open onClose={vi.fn()} onOpen={vi.fn()} onManage={vi.fn()} />);

    // Cached links must be present IMMEDIATELY without waiting for mocks.links to resolve
    expect(screen.getByText("Codex LB")).toBeTruthy();

    const dialog = screen.getByRole("dialog", { name: "Quick Links" });
    expect(dialog.classList.contains("toolbar-floating-menu")).toBe(true);

    // Resolve the in-flight background revalidation with updated link
    const updatedLink: UserLink = { ...seeded[0]!, title: "Codex LB Revalidated" };
    resolveApi!(page([updatedLink]));

    await waitFor(() => expect(screen.getByText("Codex LB Revalidated")).toBeTruthy());
  });

  it("opens a link, loads more, and closes on an outside click", async () => {
    mocks.links
      .mockResolvedValueOnce(page(seeded, 2))
      .mockResolvedValueOnce({ data: [musicLink], pagination: { page: 2, pageSize: 10, totalItems: 2, totalPages: 1 } });
    const onOpen = vi.fn(); const onClose = vi.fn();
    render(<QuickLinksPopover open onClose={onClose} onOpen={onOpen} onManage={vi.fn()} />);
    await screen.findByText("Codex LB");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Focus mix")).toBeTruthy();
    expect(mocks.links).toHaveBeenLastCalledWith({ isQuick: true, page: 2, pageSize: 10 });
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    fireEvent.click(screen.getByText("Codex LB"));
    expect(onOpen).toHaveBeenCalledWith(seeded[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("shows a dismissible error when Quick Links cannot load", async () => {
    mocks.links.mockRejectedValue(new Error("Quick Links are offline."));
    render(<QuickLinksPopover open onClose={vi.fn()} onOpen={vi.fn()} onManage={vi.fn()} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Quick Links are offline.");
    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss message" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
