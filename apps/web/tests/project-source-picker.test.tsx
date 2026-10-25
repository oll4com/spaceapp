// @vitest-environment jsdom
import React, { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { repositoryProviderRegistry, type OpenProjectResult, type RepositoryProviderId, type RepositoryProviderState } from "@space/contracts";
import { ProjectSourcePicker } from "../src/features/source-control/ProjectSourcePicker.js";
import { RepositoryProvidersSection } from "../src/features/source-control/RepositoryProvidersSection.js";
import type { SourceControlClient } from "../src/features/source-control/client.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
type Setup = Partial<Record<RepositoryProviderId, { enabled?: boolean; status?: "CONNECTED" | "NOT_CONNECTED" | "ERROR"; login?: string }>>;
function states(setup: Setup): RepositoryProviderState[] {
  return repositoryProviderRegistry.map(descriptor => {
    const item = setup[descriptor.id] ?? {};
    return { ...descriptor, enabled: item.enabled ?? descriptor.defaultEnabled,
      connection: { provider: descriptor.id, serverUrl: descriptor.id === "gitea" ? "https://git.example.test" : descriptor.defaultServerUrl, status: item.status ?? "NOT_CONNECTED", accountLogin: item.login ?? null, connectedAt: null, checkedAt: null, error: item.status === "ERROR" ? "Token expired." : null } };
  });
}
const repo = { id: "42", fullName: "team/app", cloneUrl: "https://github.com/team/app.git", webUrl: "https://github.com/team/app", private: true, defaultBranch: "main", permissions: { pull: true, push: false, admin: false } };
function client(setup: Setup) {
  return {
    providers: vi.fn(async () => states(setup)),
    listRepositories: vi.fn(async () => ({ data: [repo], nextPage: null, nextCursor: null })),
    openProject: vi.fn(async (input): Promise<OpenProjectResult> => ({ projectPath: input.destination ?? (input.source.kind === "local" ? input.source.path : "/x"), created: true, repositoryRoot: null,
      binding: { kind: "local", id: "binding:local", ownerUserId: "user:a", projectPath: input.destination ?? "/x" }, source: { kind: input.source.kind, label: "New project", detail: null } }))
  } as unknown as SourceControlClient;
}
function Harness({ api, onOpened, kind = "dock" }: { api: SourceControlClient; onOpened?: (result: OpenProjectResult) => Promise<void> | void; kind?: "dock" | "room" }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)}>Open project</button>
    {open ? <ProjectSourcePicker context={kind === "dock" ? { kind: "dock" } : { kind: "room", roomId: "room:1", roomName: "Design" }} client={api} isAdmin defaultParent="/opt/spaceapp/projects"
      onOpened={onOpened ?? (() => undefined)} onClose={() => setOpen(false)} /> : null}
  </>;
}
const sourceIds = () => Array.from(document.querySelectorAll("[data-source-id]")).map(item => item.getAttribute("data-source-id"));

describe("project source picker", () => {
  it("orders permanent sources first, then only enabled providers alphabetically with their setup state", async () => {
    const api = client({ github: { status: "CONNECTED", login: "octo" }, gitlab: { enabled: true }, forgejo: { enabled: true, status: "ERROR" }, bitbucket: { enabled: false, status: "CONNECTED" } });
    render(<Harness api={api} />);
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() => expect(sourceIds()).toEqual(["new", "local", "git-url", "forgejo", "gitea", "github", "gitlab"]));
    const list = screen.getByRole("listbox", { name: "Project sources" });
    expect(within(list).getByText("Reconnect required")).toBeTruthy();
    expect(within(list).getAllByText("Setup required")).toHaveLength(2);
    expect(within(list).getByText("Clone from octo")).toBeTruthy();
    expect(within(list).queryByText("Bitbucket Cloud")).toBeNull();
  });

  it("supports search, arrow keys, Enter, Backspace outside inputs and Escape with focus return", async () => {
    const api = client({ github: { status: "CONNECTED", login: "octo" } });
    render(<Harness api={api} />);
    const opener = screen.getByRole("button", { name: "Open project" });
    opener.focus(); fireEvent.click(opener);
    const search = await screen.findByRole("combobox", { name: "Search project sources" });
    await waitFor(() => expect(sourceIds()).toContain("github"));
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(screen.getByRole("option", { selected: true }).getAttribute("data-source-id")).toBe("local");
    fireEvent.keyDown(search, { key: "Enter" });
    expect(await screen.findByRole("heading", { name: "Local folder" })).toBeTruthy();
    // Backspace inside a text field edits text; outside it returns to the source list.
    fireEvent.keyDown(screen.getByLabelText("Folder path"), { key: "Backspace" });
    expect(screen.getByRole("heading", { name: "Local folder" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("button", { name: "Open this folder" }), { key: "Backspace" });
    const again = await screen.findByRole("combobox", { name: "Search project sources" });
    fireEvent.change(again, { target: { value: "git u" } });
    expect(sourceIds()).toEqual(["git-url"]);
    fireEvent.keyDown(again, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("creates a new project once even when submitted twice, and closes after the context accepts it", async () => {
    const api = client({});
    let release!: () => void;
    vi.mocked(api.openProject).mockImplementation(input => new Promise(resolve => { release = () => resolve({ projectPath: input.destination!, created: true, repositoryRoot: input.destination!, binding: { kind: "local", id: "b", ownerUserId: "u", projectPath: input.destination! }, source: { kind: "new", label: "New project", detail: null } }); }));
    const onOpened = vi.fn();
    render(<Harness api={api} onOpened={onOpened} />);
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    fireEvent.click(await screen.findByText("New project"));
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "demo-app" } });
    const create = screen.getByRole("button", { name: "Create project" });
    fireEvent.click(create); fireEvent.click(create);
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByText("Creating project…")).toBeTruthy();
    release();
    await waitFor(() => expect(onOpened).toHaveBeenCalledTimes(1));
    expect(api.openProject).toHaveBeenCalledTimes(1);
    expect(api.openProject).toHaveBeenCalledWith({ source: { kind: "new", name: "demo-app" }, destination: "/opt/spaceapp/projects/demo-app" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps a prepared clone and retries only the room attachment", async () => {
    const api = client({ github: { status: "CONNECTED", login: "octo" } });
    const onOpened = vi.fn().mockRejectedValueOnce(new Error("Room update failed.")).mockResolvedValueOnce(undefined);
    render(<Harness api={api} onOpened={onOpened} kind="room" />);
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    expect(await screen.findByRole("dialog", { name: "Choose project for Design" })).toBeTruthy();
    await waitFor(() => expect(sourceIds()).toContain("github"));
    fireEvent.click(screen.getByText("GitHub"));
    fireEvent.click(await screen.findByText("team/app"));
    expect(screen.getByText("Read only", { exact: false })).toBeTruthy();
    expect((screen.getByLabelText("Folder name") as HTMLInputElement).value).toBe("app");
    fireEvent.click(screen.getByRole("button", { name: "Clone team/app" }));
    expect(await screen.findByText("Room update failed.")).toBeTruthy();
    expect(api.openProject).toHaveBeenCalledWith({ source: { kind: "provider", provider: "github", repositoryId: "42" }, destination: "/opt/spaceapp/projects/app" });
    fireEvent.click(screen.getByRole("button", { name: "Retry attachment" }));
    await waitFor(() => expect(onOpened).toHaveBeenCalledTimes(2));
    expect(api.openProject).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("sets up an enabled provider inside the picker and keeps the other fields", async () => {
    let connected = false;
    const api = client({ gitlab: { enabled: true } });
    vi.mocked(api.providers).mockImplementation(async () => states({ gitlab: { enabled: true, ...(connected ? { status: "CONNECTED" as const, login: "dev" } : {}) } }));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/auth/csrf") return new Response(JSON.stringify({ csrfToken: "csrf" }), { status: 200 });
      if (url === "/api/plugins/gitlab/connect") { connected = true; return new Response(JSON.stringify({ pluginId: "gitlab", status: "CONNECTED" }), { status: 200 }); }
      throw new Error(`Unhandled ${url}`);
    }));
    render(<Harness api={api} />);
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    fireEvent.click(await screen.findByText("Git URL"));
    fireEvent.change(screen.getByLabelText("Repository URL"), { target: { value: "https://gitlab.com/group/sub/tool.git" } });
    expect((screen.getByLabelText("Folder name") as HTMLInputElement).value).toBe("tool");
    fireEvent.click(screen.getByRole("button", { name: "Back to project sources" }));
    fireEvent.click(await screen.findByText("GitLab"));
    const form = await screen.findByRole("form", { name: "Connect GitLab" });
    expect((within(form).getByLabelText(/Server URL/) as HTMLInputElement).value).toBe("https://gitlab.com");
    fireEvent.change(within(form).getByLabelText(/Personal Access Token/), { target: { value: "glpat-secret" } });
    fireEvent.submit(form);
    expect(await screen.findByRole("listbox", { name: "GitLab repositories" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to project sources" }));
    fireEvent.click(await screen.findByText("Git URL"));
    expect((screen.getByLabelText("Repository URL") as HTMLInputElement).value).toBe("https://gitlab.com/group/sub/tool.git");
    expect(screen.getByText("Uses your connected GitLab account for this host only.")).toBeTruthy();
  });
});

describe("repository provider cards", () => {
  it("toggles a provider without disconnecting it and tests the saved connection", async () => {
    let enabled = true;
    const api = { providers: vi.fn(async () => states({ github: { status: "CONNECTED", login: "octo", enabled } })) } as unknown as SourceControlClient;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/csrf") return new Response(JSON.stringify({ csrfToken: "csrf" }), { status: 200 });
      if (url === "/api/plugins/github/enabled") { enabled = JSON.parse(String(init?.body)).enabled; return new Response(JSON.stringify({ provider: "github", enabled }), { status: 200 }); }
      if (url === "/api/plugins/github/test") return new Response(JSON.stringify({ ok: true, message: "Verified github account octo." }), { status: 200 });
      throw new Error(`Unhandled ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<RepositoryProvidersSection client={api} />);
    const toggle = await screen.findByRole("switch", { name: "Enable GitHub" });
    fireEvent.click(toggle);
    await waitFor(() => expect((screen.getByRole("switch", { name: "Enable GitHub" }) as HTMLInputElement).checked).toBe(false));
    const card = view.container.querySelector('[data-provider-id="github"]') as HTMLElement;
    expect(card.textContent).toContain("Disabled");
    expect(card.textContent).toContain("octo");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("disconnect"))).toBe(false);
    fireEvent.click(within(card).getByRole("button", { name: /Test connection/ }));
    expect(await within(card).findByText("Verified github account octo.")).toBeTruthy();
  });
  it("offers Retry before Reconnect for a saved account in error", async () => {
    const api = { providers: vi.fn(async () => states({ forgejo: { enabled: true, status: "ERROR", login: "dev" } })) } as unknown as SourceControlClient;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/auth/csrf") return new Response(JSON.stringify({ csrfToken: "csrf" }), { status: 200 });
      if (url === "/api/plugins/forgejo/test") return new Response(JSON.stringify({ ok: false, message: "Provider is offline or could not be reached." }), { status: 200 });
      throw new Error(`Unhandled ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<RepositoryProvidersSection client={api} />);
    await waitFor(() => expect(view.container.querySelector('[data-provider-id="forgejo"]')).toBeTruthy());
    const card = view.container.querySelector('[data-provider-id="forgejo"]') as HTMLElement;
    expect(card.textContent).toContain("Reconnect required");
    expect(within(card).getByRole("button", { name: "Reconnect" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Disconnect" })).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: /Retry/ }));
    expect(await within(card).findByText("Provider is offline or could not be reached.")).toBeTruthy();
  });
});
