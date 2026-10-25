// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SourceControlDock } from "../src/features/source-control/SourceControlDock.js";
import { DockActiveContext } from "../src/features/docks/dock-active-context.js";
import type { SourceControlClient } from "../src/features/source-control/client.js";
import { SOURCE_CONTROL_CONNECTION_EVENT, SourceControlRequestError } from "../src/features/source-control/client.js";
import { repositoryProviderRegistry, type PersonalGitConnection, type RepositoryProviderId, type SpaceWorktree } from "@space/contracts";

const worktreeApi = vi.hoisted(() => ({
  listWorktrees: vi.fn(async (): Promise<SpaceWorktree[]> => []),
  mergeWorktree: vi.fn(async () => ({ ok: true })),
  removeWorktree: vi.fn(async () => undefined)
}));
vi.mock("../src/features/worktrees/worktree-client.js", () => worktreeApi);

afterEach(() => { cleanup(); localStorage.clear(); worktreeApi.listWorktrees.mockReset().mockResolvedValue([]); worktreeApi.mergeWorktree.mockClear(); worktreeApi.removeWorktree.mockClear(); });
/** Derives the provider API from the legacy connection fixtures so both shapes stay in one place. */
function withProviderApi(api: SourceControlClient, enabled: Partial<Record<RepositoryProviderId, boolean>> = {}) {
  api.providers = vi.fn(async () => {
    const connections = await api.connections() as PersonalGitConnection<RepositoryProviderId>[];
    return repositoryProviderRegistry.map(descriptor => {
      const connection = connections.find(c => c.provider === descriptor.id);
      return { ...descriptor, enabled: enabled[descriptor.id] ?? descriptor.defaultEnabled,
        connection: connection ?? { provider: descriptor.id, serverUrl: descriptor.defaultServerUrl, status: "NOT_CONNECTED" as const, accountLogin: null, connectedAt: null, checkedAt: null, error: null } };
    });
  });
  api.listRepositories = vi.fn(async input => { const page = await api.repositories(input.provider as "github", input.page ?? 1); return { data: page.data, nextPage: page.nextPage, nextCursor: null }; });
  api.bindRepository = vi.fn(async (path, provider, repositoryId, signal) => ({ kind: "provider" as const, ...await api.bind(path, provider as "github", repositoryId, signal) }));
  api.bindLocal = vi.fn(async (path: string) => ({ kind: "local" as const, id: "binding:local", ownerUserId: "user:a", projectPath: path }));
  api.setDefaultRepository = vi.fn(async () => ({ ok: true, isDefault: true, repository: null }));
  api.targets = vi.fn(async () => ({ data: [], nextPage: null, nextCursor: null }));
  api.previewPublish = vi.fn();
  api.openProject = vi.fn();
  api.pendingPublishes = vi.fn(async () => []);
  api.dismissPublish = vi.fn(async () => ({ ok: true }));
  return api;
}
function client() {
  return withProviderApi({
    connections: vi.fn(async () => [{ provider: "github", serverUrl: "https://github.com", status: "CONNECTED", accountLogin: "proof", connectedAt: null, checkedAt: null, error: null }]),
    repositories: vi.fn(async () => ({ data: [], nextPage: null })),
    bind: vi.fn(async () => ({ id: "binding:1", ownerUserId: "user:a", projectPath: "/proof", provider: "github", serverUrl: "https://github.com", repository: null })),
    defaults: vi.fn(async () => ({ projectPath: "/proof", defaults: { github: { fullName: null, repository: null, isDefault: false, active: true }, gitea: { fullName: null, repository: null, isDefault: false, active: false } } })),
    setDefault: vi.fn(async () => ({ ok: true, isDefault: true, repository: null })),
    status: vi.fn(async () => ({ version: "1", initialized: true, branch: "main", head: "abc", upstream: null, ahead: 1, behind: 0, changes: [{ path: "file.txt", status: "M", originalPath: null }], staged: [], conflicts: [], outgoing: [{ id: "abc", message: "Earlier local commit" }], remoteUrl: null })),
    diff: vi.fn(async () => ({ path: "file.txt", staged: false, binary: false, version: "1", text: "", hunks: [{ id: "hunk:1", header: "@@ -1 +1 @@", lines: ["-old", "+new"] }] })),
    operate: vi.fn()
  } as unknown as SourceControlClient);
}
describe("Source Control dock", () => {
  it("shows committed differences against GitHub even when the working tree is clean", async () => {
    const api = client();
    const snapshot = { ...await api.status("binding:1"), changes: [], ahead: 2, comparison: { ready: true, branch: "main", head: "remote-head", checkedAt: "2026-10-03T12:00:00.000Z", related: true, changes: [{ path: "committed.txt", originalPath: null, status: "M" }] } };
    vi.mocked(api.status).mockResolvedValue(snapshot);
    const binding = await api.bind("/proof", "github");
    vi.mocked(api.bind).mockResolvedValue({ ...binding, repository: { id: "1", fullName: "proof/repo", cloneUrl: "https://github.com/proof/repo.git", webUrl: "https://github.com/proof/repo", private: true, defaultBranch: "main", permissions: { pull: true, push: true, admin: true } } });
    vi.mocked(api.operate).mockResolvedValue({ ok: true, committed: false, pushed: false, message: "fetched", snapshot });
    vi.mocked(api.diff).mockResolvedValue({ path: "committed.txt", staged: false, binary: false, version: "1", text: "", hunks: [{ id: "remote-hunk", header: "@@ -1 +1 @@", lines: ["-remote", "+local"] }] });
    render(<SourceControlDock userId="user:a" projects={[{ label: "Proof", path: "/proof" }]} client={api} />);
    const button = await screen.findByRole("button", { name: "Compare committed.txt with GitHub" }, { timeout: 5000 });
    expect(screen.getByText("Working tree is clean.")).toBeTruthy();
    fireEvent.click(button);
    expect(await screen.findByText("-remote")).toBeTruthy();
    expect(api.diff).toHaveBeenCalledWith("binding:1", "committed.txt", false, expect.anything(), true);
    expect(screen.queryByRole("button", { name: "Stage hunk 1" })).toBeNull();
    await waitFor(() => expect(api.operate).toHaveBeenCalledWith("fetch", expect.objectContaining({ bindingId: "binding:1" })));
  });

  it("shows a diff failure inside the dialog instead of leaving it loading", async () => {
    const api = client();
    vi.mocked(api.diff).mockRejectedValue(new Error("File changed. Refresh the diff."));
    render(<SourceControlDock userId="user:a" projects={[{ label: "Proof", path: "/proof" }]} client={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open diff for file.txt" }));
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("File changed. Refresh the diff."));
    expect(screen.queryByText("Loading diff…")).toBeNull();
  });

  it("works in Local only mode without any connected provider and never requests repositories", async () => {
    const api = client();
    vi.mocked(api.connections).mockResolvedValue([]);
    render(<SourceControlDock userId="user:a" projects={[{ label: "Space", path: "/opt/spaceapp" }]} client={api} />);
    expect(await screen.findByRole("button", { name: "Open diff for file.txt" })).toBeTruthy();
    expect((screen.getByLabelText("Provider") as HTMLSelectElement).value).toBe("local");
    expect(api.bindLocal).toHaveBeenCalledWith("/opt/spaceapp", expect.anything());
    expect(api.bind).not.toHaveBeenCalled();
    expect(api.repositories).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Push" })).toBeNull();
    expect(screen.getByText("Local only. Choose a provider to fetch, pull or push.")).toBeTruthy();
  });
  it("defaults to the room project, shows external changes and stages a server-selected hunk", async () => {
    const api = client();
    render(<SourceControlDock userId="user:a" projects={[{ label: "Proof", path: "/proof" }]} currentProjectPath="/proof" client={api} />);
    await screen.findByRole("button", { name: "Open diff for file.txt" });
    expect(api.bind).toHaveBeenCalledWith("/proof", "github", undefined, expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Open diff for file.txt" }));
    await screen.findByRole("button", { name: "Stage hunk 1" });
    fireEvent.click(screen.getByRole("button", { name: "Stage hunk 1" }));
    await waitFor(() => expect(api.operate).toHaveBeenCalledWith("stage", expect.objectContaining({ bindingId: "binding:1", expectedVersion: "1", paths: ["file.txt"], hunkId: "hunk:1" })));
  });
  it("preserves drafts per user and project", async () => {
    const api = client();
    const props = { userId: "user:a", projects: [{ label: "Proof", path: "/proof" }], currentProjectPath: "/proof", client: api };
    const view = render(<SourceControlDock {...props} />);
    const input = await screen.findByLabelText("Commit message");
    fireEvent.change(input, { target: { value: "Selected changes" } });
    view.unmount(); render(<SourceControlDock {...props} />);
    await waitFor(() => expect((screen.getByLabelText("Commit message") as HTMLTextAreaElement).value).toBe("Selected changes"));
  });
  it("stops polling in a hidden tab and shows all outgoing commits before push", async () => {
    const api = client();
    const binding = await api.bind("/proof", "github");
    vi.mocked(api.bind).mockResolvedValue({ ...binding, repository: { id: "1", fullName: "proof/repo", cloneUrl: "https://github.com/proof/repo.git", webUrl: "https://github.com/proof/repo", private: true, defaultBranch: "main", permissions: { pull: true, push: true, admin: true } } });
    render(<SourceControlDock userId="user:a" projects={[{ label: "Proof", path: "/proof" }]} currentProjectPath="/proof" client={api} />);
    await screen.findByRole("button", { name: "Push" });
    fireEvent.click(screen.getByRole("button", { name: "Push" }));
    expect(await screen.findByText("Earlier local commit")).toBeTruthy();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    fireEvent(document, new Event("visibilitychange"));
    const count = vi.mocked(api.status).mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 1150));
    expect(vi.mocked(api.status).mock.calls.length).toBe(count);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });
  it("rejects delayed polling data after a staging operation completed", async () => {
    const api = client();
    const initial = await api.status("binding:1");
    let finish!: (snapshot: typeof initial) => void;
    vi.mocked(api.status).mockResolvedValueOnce(initial).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ ...initial, version: "after", changes: [], staged: initial.changes });
    vi.mocked(api.operate).mockResolvedValue({ ok: true, committed: false, pushed: false, message: "stage completed.", snapshot: { ...initial, version: "after", changes: [], staged: initial.changes } });
    render(<SourceControlDock userId="user:a" projects={[{ label: "Proof", path: "/proof" }]} currentProjectPath="/proof" client={api} />);
    await screen.findByRole("button", { name: "Stage file.txt" });
    await waitFor(() => expect(finish).toBeTypeOf("function"), { timeout: 2500 });
    fireEvent.click(screen.getByRole("button", { name: "Stage file.txt" }));
    await screen.findByRole("button", { name: "Unstage file.txt" });
    finish(initial);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(screen.queryByRole("button", { name: "Stage file.txt" })).toBeNull();
  });
  it("refreshes repositories after switching Gitea instances through Plugins", async () => {
    const api = client();
    const connection = { provider: "gitea" as const, serverUrl: "https://first.example", status: "CONNECTED" as const, accountLogin: "proof", connectedAt: null, checkedAt: null, error: null };
    const remote = (fullName: string) => ({ id: fullName, fullName, cloneUrl: `https://first.example/${fullName}.git`, webUrl: "https://first.example", private: true, defaultBranch: "main", permissions: { pull: true, push: true, admin: true } });
    vi.mocked(api.connections).mockResolvedValue([connection]);
    vi.mocked(api.repositories).mockResolvedValueOnce({ data: [remote("proof/first")], nextPage: null }).mockResolvedValue({ data: [remote("proof/second")], nextPage: null });
    render(<SourceControlDock userId="user:a" projects={[{ label: "Proof", path: "/proof" }]} client={api} />);
    await screen.findByRole("option", { name: "proof/first" });
    vi.mocked(api.connections).mockResolvedValue([{ ...connection, serverUrl: "https://second.example" }]);
    fireEvent(window, new Event(SOURCE_CONTROL_CONNECTION_EVENT));
    expect(await screen.findByRole("option", { name: "proof/second" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "proof/first" })).toBeNull();
  });

  it("renders VS Code status badges and split file paths with proper status classes", async () => {
    const api = client();
    const snapshot = {
      ...await api.status("binding:1"),
      changes: [
        { path: "apps/api/src/new-file.ts", status: "A", originalPath: null },
        { path: "apps/api/src/modified-file.ts", status: "M", originalPath: null },
        { path: "deleted-file.txt", status: "D", originalPath: null }
      ]
    };
    vi.mocked(api.status).mockResolvedValue(snapshot);
    render(<SourceControlDock userId="user:a" projects={[{ label: "Proof", path: "/proof" }]} currentProjectPath="/proof" client={api} />);

    // Verify status badges
    const addedBadge = await screen.findByTitle("Added (New file)");
    expect(addedBadge.textContent).toBe("A");
    expect(addedBadge.className).toContain("status-added");

    const modBadge = await screen.findByTitle("Modified file");
    expect(modBadge.textContent).toBe("M");
    expect(modBadge.className).toContain("status-modified");

    const delBadge = await screen.findByTitle("Deleted file");
    expect(delBadge.textContent).toBe("D");
    expect(delBadge.className).toContain("status-deleted");

    // Verify split basename and directory
    expect(screen.getByText("new-file.ts")).toBeTruthy();
    expect(screen.getAllByText("apps/api/src").length).toBe(2);
  });

  it("toggles dock fullscreen and diff viewer split vs inline modes", async () => {
    const api = client();
    render(<SourceControlDock userId="user:a" projects={[{ label: "Proof", path: "/proof" }]} currentProjectPath="/proof" client={api} />);

    // Dock fullscreen toggle
    const dockFsBtn = await screen.findByRole("button", { name: "Open source control fullscreen" });
    fireEvent.click(dockFsBtn);
    expect(screen.getByRole("button", { name: "Exit source control fullscreen" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Exit source control fullscreen" }));
    expect(screen.getByRole("button", { name: "Open source control fullscreen" })).toBeTruthy();

    // Open diff
    const openDiffBtn = await screen.findByRole("button", { name: "Open diff for file.txt" });
    fireEvent.click(openDiffBtn);
    expect(await screen.findByRole("region", { name: "Diff viewer" })).toBeTruthy();

    // Maximize diff modal
    const diffMaxBtn = screen.getByRole("button", { name: "Maximize diff" });
    fireEvent.click(diffMaxBtn);
    expect(screen.getByRole("button", { name: "Exit diff fullscreen" })).toBeTruthy();

    // Toggle split vs inline
    const inlineBtn = screen.getByRole("button", { name: "Inline" });
    fireEvent.click(inlineBtn);
    expect(inlineBtn.getAttribute("aria-pressed")).toBe("true");

    const splitBtn = screen.getByRole("button", { name: "Split" });
    fireEvent.click(splitBtn);
    expect(splitBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("filters files by status, file extension, and search query in comparison view", async () => {
    const api = client();
    const snapshot = {
      ...await api.status("binding:1"),
      changes: [],
      comparison: {
        ready: true,
        branch: "main",
        head: "remote-head",
        checkedAt: "2026-10-03T12:00:00.000Z",
        related: true,
        changes: [
          { path: "apps/api/src/app.ts", status: "M", originalPath: null },
          { path: "apps/api/src/errors.ts", status: "A", originalPath: null },
          { path: "apps/web/src/style.css", status: "M", originalPath: null },
          { path: "README.md", status: "D", originalPath: null }
        ]
      }
    };
    vi.mocked(api.status).mockResolvedValue(snapshot);
    const binding = await api.bind("/proof", "github");
    vi.mocked(api.bind).mockResolvedValue({
      ...binding,
      repository: {
        id: "1",
        fullName: "proof/repo",
        cloneUrl: "https://github.com/proof/repo.git",
        webUrl: "https://github.com/proof/repo",
        private: true,
        defaultBranch: "main",
        permissions: { pull: true, push: true, admin: true }
      }
    });

    render(<SourceControlDock userId="user:a" projects={[{ label: "Proof", path: "/proof" }]} client={api} />);

    // Initial state: all 4 files are displayed
    expect(await screen.findByRole("button", { name: "Compare apps/api/src/app.ts with GitHub" })).toBeTruthy();

    expect(screen.getByRole("button", { name: "Compare apps/api/src/errors.ts with GitHub" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Compare apps/web/src/style.css with GitHub" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Compare README.md with GitHub" })).toBeTruthy();

    // Filter by status 'M' (Modified)
    const modChip = screen.getByRole("button", { name: /Modified/i });
    fireEvent.click(modChip);
    expect(screen.getByRole("button", { name: "Compare apps/api/src/app.ts with GitHub" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Compare apps/web/src/style.css with GitHub" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Compare apps/api/src/errors.ts with GitHub" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Compare README.md with GitHub" })).toBeNull();

    // Filter by extension '.css'
    const extSelect = screen.getByLabelText("Filter by file type");
    fireEvent.change(extSelect, { target: { value: ".css" } });
    expect(screen.getByRole("button", { name: "Compare apps/web/src/style.css with GitHub" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Compare apps/api/src/app.ts with GitHub" })).toBeNull();

    // Reset filters
    const resetBtn = screen.getByRole("button", { name: "Reset filters" });
    fireEvent.click(resetBtn);
    expect(screen.getByRole("button", { name: "Compare apps/api/src/app.ts with GitHub" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Compare apps/api/src/errors.ts with GitHub" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Compare apps/web/src/style.css with GitHub" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Compare README.md with GitHub" })).toBeTruthy();

    // Search query filtering
    const searchInput = screen.getByLabelText("Filter files by name");
    fireEvent.change(searchInput, { target: { value: "errors" } });
    expect(screen.getByRole("button", { name: "Compare apps/api/src/errors.ts with GitHub" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Compare apps/api/src/app.ts with GitHub" })).toBeNull();
  });

  it("displays project and repository version, commit hash and date metadata", async () => {
    const api = client();
    const snapshot = {
      ...await api.status("binding:1"),
      projectVersion: "0.1.20",
      headShort: "08c0db6",
      headDate: "2026-10-03T19:21:00.000Z",
      comparison: {
        ready: true,
        branch: "main",
        head: "remote-head",
        headShort: "9aee38c",
        headDate: "2026-10-03T13:53:00.000Z",
        repoVersion: "0.1.19",
        checkedAt: "2026-10-03T19:28:00.000Z",
        related: true,
        changes: [{ path: "file.ts", status: "M", originalPath: null }]
      }
    };
    vi.mocked(api.status).mockResolvedValue(snapshot);
    const binding = await api.bind("/proof", "github");
    vi.mocked(api.bind).mockResolvedValue({
      ...binding,
      repository: {
        id: "1",
        fullName: "proof/repo",
        cloneUrl: "https://github.com/proof/repo.git",
        webUrl: "https://github.com/proof/repo",
        private: true,
        defaultBranch: "main",
        permissions: { pull: true, push: true, admin: true }
      }
    });

    render(<SourceControlDock userId="user:a" projects={[{ label: "Proof", path: "/proof" }]} client={api} />);

    // Verify metadata card contents
    const metaCard = await screen.findByLabelText("Project and repository details");
    expect(metaCard.textContent).toContain("v0.1.20");
    expect(metaCard.textContent).toContain("commit 08c0db6");
    expect(metaCard.textContent).toContain("v0.1.19");
    expect(metaCard.textContent).toContain("commit 9aee38c");
  });

  it("handles workspace repository defaults and plugin status gating in settings dialog", async () => {
    const api = client();
    vi.mocked(api.defaults).mockResolvedValue({
      projectPath: "/proof",
      defaults: {
        github: { fullName: "proof/repo", repository: { id: "1", fullName: "proof/repo", cloneUrl: "https://github.com/proof/repo.git", webUrl: "https://github.com/proof/repo", private: true, defaultBranch: "main", permissions: { pull: true, push: true, admin: true } }, isDefault: true, active: true },
        gitea: { fullName: null, repository: null, isDefault: false, active: false }
      }
    });
    vi.mocked(api.repositories).mockResolvedValue({
      data: [{ id: "1", fullName: "proof/repo", cloneUrl: "https://github.com/proof/repo.git", webUrl: "https://github.com/proof/repo", private: true, defaultBranch: "main", permissions: { pull: true, push: true, admin: true } }],
      nextPage: null
    });
    const binding = await api.bind("/proof", "github");
    vi.mocked(api.bind).mockResolvedValue({
      ...binding,
      repository: {
        id: "1",
        fullName: "proof/repo",
        cloneUrl: "https://github.com/proof/repo.git",
        webUrl: "https://github.com/proof/repo",
        private: true,
        defaultBranch: "main",
        permissions: { pull: true, push: true, admin: true }
      }
    });

    render(<SourceControlDock userId="user:a" projects={[{ label: "Proof", path: "/proof" }]} client={api} />);

    // Initially when defaults load, repository is proof/repo and should show Default badge
    await screen.findByRole("option", { name: "proof/repo" });
    const repoSelect = await screen.findByLabelText("Repository");
    fireEvent.change(repoSelect, { target: { value: "1" } });

    const badge = (await screen.findByText("Default (GitHub)")).closest(".source-control-default-badge");
    // The star is an icon, not an emoji that needs an emoji font.
    expect(badge?.querySelector("svg.source-control-star-icon")).toBeTruthy();
    expect(badge?.textContent).not.toMatch(/[\u2B50\u2606]/u);

    // Click "Clear" to unset default
    const clearBtn = screen.getByRole("button", { name: "Clear" });
    fireEvent.click(clearBtn);
    await waitFor(() => expect(api.setDefaultRepository).toHaveBeenCalledWith("/proof", "github", null));

    // Open the repository defaults dialog
    const settingsBtn = screen.getByRole("button", { name: "Repository defaults" });
    fireEvent.click(settingsBtn);

    const dialog = await screen.findByRole("dialog", { name: "Repository defaults" });
    expect(dialog).toBeTruthy();

    // Provider gating: GitHub is connected; Gitea is enabled but needs setup.
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("Setup required")).toBeTruthy();
    expect(screen.getByText("Connect Gitea in Plugins to choose a default repository.")).toBeTruthy();

    // Select default in GitHub select inside dialog (stable repository ID)
    const githubDefaultSelect = screen.getByLabelText("Default Repository");
    fireEvent.change(githubDefaultSelect, { target: { value: "1" } });
    await waitFor(() => expect(api.setDefaultRepository).toHaveBeenCalledWith("/proof", "github", "1"));
  });

  it("filters local working tree changes by status, file extension, and search query", async () => {
    const api = client();
    const snapshot = {
      ...await api.status("binding:1"),
      changes: [
        { path: "apps/api/package.json", status: "M", originalPath: null },
        { path: "apps/desktop/package.json", status: "M", originalPath: null },
        { path: "apps/web/src/index.ts", status: "A", originalPath: null }
      ],
      staged: [],
      conflicts: [],
      comparison: undefined
    };
    vi.mocked(api.status).mockResolvedValue(snapshot);

    render(<SourceControlDock userId="user:a" projects={[{ label: "Proof", path: "/proof" }]} client={api} />);

    // Initial state: all 3 local changes are displayed
    expect(await screen.findByRole("button", { name: "Open diff for apps/api/package.json" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open diff for apps/desktop/package.json" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open diff for apps/web/src/index.ts" })).toBeTruthy();
    expect(screen.getByText("Changes")).toBeTruthy();

    // Filter by status 'M' (Modified)
    const modChip = screen.getByRole("button", { name: /Modified/i });
    fireEvent.click(modChip);
    expect(screen.getByRole("button", { name: "Open diff for apps/api/package.json" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open diff for apps/desktop/package.json" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open diff for apps/web/src/index.ts" })).toBeNull();
    expect(screen.getByText("2 of 3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stage filtered" })).toBeTruthy();

    // Toggle status filter back to all
    fireEvent.click(modChip);
    expect(screen.getByRole("button", { name: "Open diff for apps/web/src/index.ts" })).toBeTruthy();

    // Filter by extension '.ts'
    const extSelect = screen.getByLabelText("Filter by file type");
    fireEvent.change(extSelect, { target: { value: ".ts" } });
    expect(screen.getByRole("button", { name: "Open diff for apps/web/src/index.ts" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open diff for apps/api/package.json" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open diff for apps/desktop/package.json" })).toBeNull();

    // Search query filtering for 'desktop'
    const searchInput = screen.getByLabelText("Filter files by name");
    fireEvent.change(searchInput, { target: { value: "desktop" } });
    // Reset extension to all to test search across all types
    fireEvent.change(extSelect, { target: { value: "all" } });
    expect(screen.getByRole("button", { name: "Open diff for apps/desktop/package.json" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open diff for apps/api/package.json" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open diff for apps/web/src/index.ts" })).toBeNull();

    // Reset filters
    const resetBtn = screen.getByRole("button", { name: "Reset filters" });
    fireEvent.click(resetBtn);
    expect(screen.getByRole("button", { name: "Open diff for apps/api/package.json" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open diff for apps/desktop/package.json" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open diff for apps/web/src/index.ts" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stage all" })).toBeTruthy();
  });

  it("refreshes repository status, performs remote fetch, and shows status notice on refresh click", async () => {
    const api = client();
    const initialSnapshot = await api.status("binding:1");
    const updatedSnapshot = {
      ...initialSnapshot,
      version: "version-2",
      ahead: 2,
      changes: [{ path: "new-file.txt", status: "M", originalPath: null }]
    };
    vi.mocked(api.status).mockResolvedValueOnce(initialSnapshot).mockResolvedValue(updatedSnapshot);
    const binding = await api.bind("/proof", "github");
    vi.mocked(api.bind).mockResolvedValue({
      ...binding,
      repository: {
        id: "1",
        fullName: "proof/repo",
        cloneUrl: "https://github.com/proof/repo.git",
        webUrl: "https://github.com/proof/repo",
        private: true,
        defaultBranch: "main",
        permissions: { pull: true, push: true, admin: true }
      }
    });
    vi.mocked(api.operate).mockResolvedValue({ ok: true, committed: false, pushed: false, message: "fetched", snapshot: updatedSnapshot });

    render(<SourceControlDock userId="user:a" projects={[{ label: "Proof", path: "/proof" }]} currentProjectPath="/proof" client={api} />);
    await screen.findByText("main");
    const refreshBtn = await screen.findByRole("button", { name: "Refresh repository" });
    expect(refreshBtn).toBeTruthy();
    expect(refreshBtn.getAttribute("disabled")).toBeNull();

    fireEvent.click(refreshBtn);
    await waitFor(() => expect(screen.getByText("Repository and remote status refreshed.")).toBeTruthy());
    expect(api.operate).toHaveBeenCalledWith("fetch", expect.objectContaining({ bindingId: "binding:1" }));
  });

  it("keeps a slow manual refresh from being overtaken by background status polling", async () => {
    const api = client();
    const binding = await api.bind("/proof", "github");
    vi.mocked(api.bind).mockResolvedValue({ ...binding, repository: { id: "1", fullName: "proof/repo", cloneUrl: "https://github.com/proof/repo.git", webUrl: "https://github.com/proof/repo", private: true, defaultBranch: "main", permissions: { pull: true, push: true, admin: true } } });
    const snapshot = await api.status("binding:1");
    vi.mocked(api.operate).mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 2500)); return { ok: true, committed: false, pushed: false, message: "fetched", snapshot }; });
    render(<SourceControlDock userId="user:a" projects={[{ label: "Proof", path: "/proof" }]} currentProjectPath="/proof" client={api} />);
    const refreshBtn = await screen.findByRole("button", { name: "Refresh repository" });
    await waitFor(() => expect(refreshBtn.getAttribute("disabled")).toBeNull());
    fireEvent.click(refreshBtn);
    await waitFor(() => expect(screen.getByText("Repository and remote status refreshed.")).toBeTruthy(), { timeout: 8000 });
  }, 15000);

  it("allows refreshing connections and defaults even when disconnected without disabling the button", async () => {
    const api = client();
    vi.mocked(api.connections).mockResolvedValue([]);
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => [] }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      render(<SourceControlDock userId="user:a" projects={[{ label: "Space", path: "/opt/spaceapp" }]} client={api} />);
      const refreshBtn = await screen.findByRole("button", { name: "Refresh repository" });
      expect(refreshBtn).toBeTruthy();
      expect(refreshBtn.getAttribute("disabled")).toBeNull();

      await screen.findByRole("button", { name: "Open diff for file.txt" });
      fireEvent.click(refreshBtn);
      await waitFor(() => expect(api.providers).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getByText("Repository and remote status refreshed.")).toBeTruthy());
      expect(api.operate).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refreshes active file diff when clicking refresh while a diff is open", async () => {
    const api = client();
    const initialDiff = { path: "file.txt", staged: false, binary: false, version: "1", text: "", hunks: [{ id: "hunk:1", header: "@@ -1 +1 @@", lines: ["-old", "+new"] }] };
    const reloadedDiff = { path: "file.txt", staged: false, binary: false, version: "2", text: "", hunks: [{ id: "hunk:1", header: "@@ -1 +1 @@", lines: ["-old", "+newer content"] }] };
    vi.mocked(api.diff).mockResolvedValueOnce(initialDiff).mockResolvedValue(reloadedDiff);

    render(<SourceControlDock userId="user:a" projects={[{ label: "Proof", path: "/proof" }]} currentProjectPath="/proof" client={api} />);
    const openDiffBtn = await screen.findByRole("button", { name: "Open diff for file.txt" });
    fireEvent.click(openDiffBtn);
    expect(await screen.findByText("+new")).toBeTruthy();

    const refreshBtn = screen.getByRole("button", { name: "Refresh repository" });
    fireEvent.click(refreshBtn);

    await waitFor(() => expect(screen.getByText("+newer content")).toBeTruthy());
  });

  it("opens a project from the dock into personal presets without touching rooms", async () => {
    const api = client();
    vi.mocked(api.connections).mockResolvedValue([]);
    vi.mocked(api.openProject).mockResolvedValue({ projectPath: "/opt/spaceapp/projects/demo", created: true, repositoryRoot: "/opt/spaceapp/projects/demo",
      binding: { kind: "local", id: "binding:demo", ownerUserId: "user:a", projectPath: "/opt/spaceapp/projects/demo" }, source: { kind: "new", label: "New project", detail: null } });
    const onProjectOpened = vi.fn();
    render(<SourceControlDock userId="user:a" projects={[{ label: "Space", path: "/opt/spaceapp" }]} client={api} onProjectOpened={onProjectOpened} />);
    // The shell header names the dock; its own title appears only in fullscreen.
    expect(within(screen.getByRole("region", { name: "Source Control" })).queryByRole("heading", { name: "Source Control" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Open project" }));
    expect(await screen.findByRole("dialog", { name: "Open project" })).toBeTruthy();
    fireEvent.click(await screen.findByText("New project"));
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "demo" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(onProjectOpened).toHaveBeenCalledWith({ label: "demo", path: "/opt/spaceapp/projects/demo" }));
    await waitFor(() => expect((screen.getByLabelText("Project") as HTMLSelectElement).value).toBe("/opt/spaceapp/projects/demo"));
    await waitFor(() => expect(api.bindLocal).toHaveBeenCalledWith("/opt/spaceapp/projects/demo", expect.anything()));
  });

  it("fetches and pulls a Git URL origin anonymously but requires a provider to push", async () => {
    const api = client();
    vi.mocked(api.connections).mockResolvedValue([]);
    vi.mocked(api.bindLocal).mockResolvedValue({ kind: "git-url", id: "binding:url", ownerUserId: "user:a", projectPath: "/proof", url: "https://example.org/team/app.git", provider: null });
    vi.mocked(api.operate).mockImplementation(async () => ({ ok: true, committed: false, pushed: false, message: "fetch completed.", snapshot: await api.status("binding:url") }));
    render(<SourceControlDock userId="user:a" projects={[{ label: "Proof", path: "/proof" }]} client={api} />);
    expect(await screen.findByText(/Origin: https:\/\/example.org\/team\/app.git/)).toBeTruthy();
    const push = await screen.findByRole("button", { name: "Push" });
    expect(push.hasAttribute("disabled")).toBe(true);
    expect(push.getAttribute("title")).toBe("Connect the provider that hosts this repository to push.");
    fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
    await waitFor(() => expect(api.operate).toHaveBeenCalledWith("fetch", expect.objectContaining({ bindingId: "binding:url" })));
    expect(screen.queryByText("Publish to a provider")).toBeNull();
  });

  it("locks the project and provider while a publish runs", async () => {
    const api = client();
    vi.mocked(api.targets).mockResolvedValue({ data: [{ id: "user:1", provider: "github", kind: "user", name: "proof", canCreateRepository: true }], nextPage: null, nextCursor: null });
    vi.mocked(api.previewPublish).mockResolvedValue({ provider: "github", serverUrl: "https://github.com", targetId: "user:1", targetName: "proof", createPermission: "allowed", name: "proof", private: true, visibility: "private", hasCommits: true, willCommit: false, willPush: false, expectedVersion: "1" });
    let finish!: () => void;
    vi.mocked(api.operate).mockImplementation(async (operation) => {
      if (operation !== "publish") return { ok: true, committed: false, pushed: false, message: "ok", snapshot: await api.status("binding:1") };
      await new Promise<void>(resolve => { finish = resolve; });
      return { ok: false, remoteCreated: false, createOutcome: "unknown", committed: false, pushed: false, message: "Remote creation is unconfirmed.", snapshot: await api.status("binding:1") };
    });
    render(<SourceControlDock userId="user:a" projects={[{ label: "Proof", path: "/proof" }, { label: "Other", path: "/other" }]} currentProjectPath="/proof" client={api} />);
    fireEvent.click(await screen.findByText("Publish to a provider"));
    await waitFor(() => expect((screen.getByRole("button", { name: "Review publish" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Review publish" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create remote repository" }));
    await waitFor(() => expect((screen.getByLabelText("Project") as HTMLSelectElement).disabled).toBe(true));
    expect((screen.getByRole("combobox", { name: "Provider" }) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Open project" }) as HTMLButtonElement).disabled).toBe(true);
    finish();
    await waitFor(() => expect((screen.getByLabelText("Project") as HTMLSelectElement).disabled).toBe(false));
    expect(await screen.findByText(/Remote creation is unconfirmed/)).toBeTruthy();
  });

  it("refreshes the comparison once when the remote branch moved before a file opened", async () => {
    const api = client();
    const base = await api.status("binding:1");
    const listed = { ...base, changes: [], comparison: { ready: true, branch: "main", head: "remote-old", checkedAt: "2026-10-11T00:00:00.000Z", related: true, changes: [{ path: "moved.txt", originalPath: null, status: "M" }] } };
    const refreshed = { ...listed, version: "2", comparison: { ...listed.comparison, head: "remote-new", changes: [] } };
    vi.mocked(api.status).mockResolvedValueOnce(listed).mockResolvedValue(refreshed);
    const binding = await api.bind("/proof", "github");
    vi.mocked(api.bind).mockResolvedValue({ ...binding, repository: { id: "1", fullName: "proof/repo", cloneUrl: "https://github.com/proof/repo.git", webUrl: "https://github.com/proof/repo", private: true, defaultBranch: "main", permissions: { pull: true, push: true, admin: true } } });
    vi.mocked(api.operate).mockImplementation(async () => { throw new Error("offline"); });
    vi.mocked(api.diff).mockRejectedValue(new SourceControlRequestError("File is not in the remote change list. Fetch and refresh first.", "INVALID_PATH", 409));
    render(<SourceControlDock userId="user:a" projects={[{ label: "Proof", path: "/proof" }]} client={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Compare moved.txt with GitHub" }, { timeout: 5000 }));
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("The remote branch changed while this file was being opened."));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Compare moved.txt with GitHub" })).toBeNull());
  });

  describe("dock kit behavior", () => {
    const remoteRepo = { id: "1", fullName: "proof/repo", cloneUrl: "https://github.com/proof/repo.git", webUrl: "https://github.com/proof/repo", private: true, defaultBranch: "main", permissions: { pull: true, push: true, admin: true } };
    const worktree = (overrides: Partial<SpaceWorktree> = {}): SpaceWorktree => ({ id: "wt:1", repoPath: "/proof", worktreePath: "/proof/.worktrees/login", branch: "feature/login", baseBranch: "develop", baseCommit: "abc",
      roomId: "room:1", status: "ACTIVE", isDirty: false, aheadCount: 2, behindCount: 0, createdAt: "2026-10-11T00:00:00.000Z", updatedAt: "2026-10-11T00:00:00.000Z", ...overrides });
    const dock = (api: SourceControlClient, active = true) => (
      <DockActiveContext.Provider value={active}>
        <SourceControlDock userId="user:a" projects={[{ label: "Proof", path: "/proof" }]} currentProjectPath="/proof" client={api} />
      </DockActiveContext.Provider>
    );

    it("never lists worktrees for a project folder that is not a Git repository", async () => {
      const api = client();
      vi.mocked(api.status).mockResolvedValue({ version: "1", initialized: false, branch: null, head: null, upstream: null, ahead: 0, behind: 0, changes: [], staged: [], conflicts: [], outgoing: [], remoteUrl: null });
      render(dock(api, true));
      await waitFor(() => expect(api.status).toHaveBeenCalled());
      expect(await screen.findByText("This project has no Git repository")).toBeTruthy();
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(worktreeApi.listWorktrees).not.toHaveBeenCalled();
    });

    it("does not poll status, fetch the remote or list worktrees while the dock is hidden", async () => {
      const api = client();
      const binding = await api.bind("/proof", "github");
      vi.mocked(api.bind).mockClear().mockResolvedValue({ ...binding, repository: remoteRepo });
      vi.mocked(api.operate).mockImplementation(async () => ({ ok: true, committed: false, pushed: false, message: "fetched", snapshot: await api.status("binding:1") }));
      vi.mocked(api.status).mockClear();
      const view = render(dock(api, false));
      await waitFor(() => expect(api.bind).toHaveBeenCalled());
      await new Promise(resolve => setTimeout(resolve, 1150));
      expect(api.status).not.toHaveBeenCalled();
      expect(api.operate).not.toHaveBeenCalled();
      expect(worktreeApi.listWorktrees).not.toHaveBeenCalled();

      view.rerender(dock(api, true));
      expect(await screen.findByRole("button", { name: "Push" })).toBeTruthy();
      await waitFor(() => expect(api.operate).toHaveBeenCalledWith("fetch", expect.objectContaining({ bindingId: "binding:1" })));
      expect(worktreeApi.listWorktrees).toHaveBeenCalledWith("/proof");

      view.rerender(dock(api, false));
      const statusCalls = vi.mocked(api.status).mock.calls.length;
      const fetches = vi.mocked(api.operate).mock.calls.length;
      await new Promise(resolve => setTimeout(resolve, 1150));
      expect(vi.mocked(api.status).mock.calls.length).toBe(statusCalls);
      expect(vi.mocked(api.operate).mock.calls.length).toBe(fetches);

      // Showing the dock again within 30 s polls status but does not repeat the remote fetch.
      view.rerender(dock(api, true));
      await waitFor(() => expect(vi.mocked(api.status).mock.calls.length).toBeGreaterThan(statusCalls));
      expect(vi.mocked(api.operate).mock.calls.length).toBe(fetches);
    });

    it("shows the loading state in Local only mode too", async () => {
      const api = client();
      vi.mocked(api.connections).mockResolvedValue([]);
      vi.mocked(api.status).mockImplementation(() => new Promise(() => undefined));
      render(dock(api));
      expect(await screen.findByText("Loading repository…")).toBeTruthy();
      expect((screen.getByLabelText("Provider") as HTMLSelectElement).value).toBe("local");
    });

    it("offers Try again when the first status load fails", async () => {
      const api = client();
      vi.mocked(api.connections).mockResolvedValue([]);
      const snapshot = await api.status("binding:local");
      vi.mocked(api.status).mockRejectedValue(new Error("git is not installed"));
      render(dock(api));
      const failure = await screen.findByRole("alert");
      expect(failure.textContent).toContain("Repository could not load");
      expect(failure.textContent).toContain("git is not installed");
      vi.mocked(api.status).mockResolvedValue(snapshot);
      fireEvent.click(within(failure).getByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("button", { name: "Open diff for file.txt" })).toBeTruthy();
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    });

    it("shows operation errors as a dismissible notice", async () => {
      const api = client();
      vi.mocked(api.connections).mockResolvedValue([]);
      vi.mocked(api.operate).mockRejectedValue(new Error("index.lock exists"));
      render(dock(api));
      fireEvent.click(await screen.findByRole("button", { name: "Stage file.txt" }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("index.lock exists");
      fireEvent.click(within(alert).getByRole("button", { name: "Dismiss message" }));
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("hides the conflicts group when there are no conflicts", async () => {
      const api = client();
      vi.mocked(api.connections).mockResolvedValue([]);
      const base = await api.status("binding:local");
      vi.mocked(api.status).mockResolvedValue(base);
      const view = render(dock(api));
      await screen.findByRole("button", { name: "Open diff for file.txt" });
      expect(screen.queryByRole("region", { name: "Conflicts" })).toBeNull();
      view.unmount();
      vi.mocked(api.status).mockResolvedValue({ ...base, conflicts: [{ path: "merge.txt", status: "U", originalPath: null }] });
      render(dock(api));
      const conflicts = await screen.findByRole("region", { name: "Conflicts" });
      expect(within(conflicts).getByRole("button", { name: "Open diff for merge.txt" })).toBeTruthy();
    });

    it("uses readable change-type chips with counts and a search field for files", async () => {
      const api = client();
      vi.mocked(api.connections).mockResolvedValue([]);
      vi.mocked(api.status).mockResolvedValue({ ...await api.status("binding:local"), changes: [
        { path: "a.ts", status: "M", originalPath: null }, { path: "b.ts", status: "M", originalPath: null }, { path: "c.ts", status: "?", originalPath: null }] });
      render(dock(api));
      const chips = await screen.findByRole("group", { name: "Change types" });
      expect(within(chips).getAllByRole("button").map(button => button.textContent)).toEqual(["All3", "Modified2", "Added1"]);
      fireEvent.click(within(chips).getByRole("button", { name: /Added/ }));
      expect(within(chips).getByRole("button", { name: /Added/ }).getAttribute("aria-pressed")).toBe("true");
      expect(screen.queryByRole("button", { name: "Open diff for a.ts" })).toBeNull();
      expect(screen.getByRole("button", { name: "Open diff for c.ts" })).toBeTruthy();
      fireEvent.click(within(chips).getByRole("button", { name: /Added/ }));
      expect(screen.getByRole("searchbox", { name: "Filter files by name" })).toBeTruthy();
      fireEvent.change(screen.getByRole("searchbox", { name: "Filter files by name" }), { target: { value: "b.ts" } });
      expect(screen.queryByRole("button", { name: "Open diff for a.ts" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
      expect(screen.getByRole("button", { name: "Open diff for a.ts" })).toBeTruthy();
    });

    it("confirms worktree merge into its real base branch and every worktree discard", async () => {
      const api = client();
      vi.mocked(api.connections).mockResolvedValue([]);
      worktreeApi.listWorktrees.mockResolvedValue([worktree()]);
      render(dock(api));
      fireEvent.click(await screen.findByRole("button", { name: /^Worktrees/ }));
      const merge = await screen.findByRole("button", { name: "Merge into develop" });
      expect(screen.queryByRole("button", { name: /Merge into main/ })).toBeNull();
      fireEvent.click(merge);
      fireEvent.click(within(await screen.findByRole("alertdialog", { name: "Merge feature/login into develop?" })).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(worktreeApi.mergeWorktree).not.toHaveBeenCalled();

      fireEvent.click(merge);
      fireEvent.click(within(await screen.findByRole("alertdialog", { name: "Merge feature/login into develop?" })).getByRole("button", { name: "Merge" }));
      await waitFor(() => expect(worktreeApi.mergeWorktree).toHaveBeenCalledWith("/proof/.worktrees/login", { strategy: "merge", deleteBranchAfter: true }));
      expect(await screen.findByText("Merged feature/login into develop.")).toBeTruthy();

      // A clean worktree is still confirmed before it is discarded.
      fireEvent.click(screen.getByRole("button", { name: "Discard worktree feature/login" }));
      fireEvent.click(within(await screen.findByRole("alertdialog", { name: "Discard worktree feature/login?" })).getByRole("button", { name: "Discard" }));
      await waitFor(() => expect(worktreeApi.removeWorktree).toHaveBeenCalledWith("/proof/.worktrees/login", true));
    });

    it("keeps worktrees folded until the user opens them, then filters them by branch and state", async () => {
      const api = client();
      vi.mocked(api.connections).mockResolvedValue([]);
      const many = Array.from({ length: 8 }, (_, index) => worktree({ id: `wt:${index}`, worktreePath: `/proof/.worktrees/w${index}`, branch: `feature/w${index}`, isDirty: index < 2, aheadCount: index === 7 ? 3 : 0 }));
      worktreeApi.listWorktrees.mockResolvedValue([worktree({ id: "wt:main", worktreePath: "/proof", branch: "main", baseBranch: "main", aheadCount: 0 }), ...many]);
      render(dock(api));
      const toggle = await screen.findByRole("button", { name: /^Worktrees/ });
      await waitFor(() => expect(toggle.textContent).toContain("9"));
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(toggle.textContent).toContain("2 uncommitted");
      expect(screen.queryByRole("button", { name: /^Merge into/ })).toBeNull();

      fireEvent.click(toggle);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(screen.getAllByRole("button", { name: "Merge into develop" })).toHaveLength(8);
      // The repository's own checkout offers neither merge nor discard.
      expect(screen.getByText("Main checkout")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Discard worktree main" })).toBeNull();

      fireEvent.click(within(screen.getByRole("group", { name: "Worktree filter" })).getByRole("button", { name: /Uncommitted/ }));
      expect(screen.getAllByRole("button", { name: /^Discard worktree/ }).map(button => button.getAttribute("aria-label"))).toEqual(["Discard worktree feature/w0", "Discard worktree feature/w1"]);
      fireEvent.click(within(screen.getByRole("group", { name: "Worktree filter" })).getByRole("button", { name: /^All/ }));
      fireEvent.change(screen.getByRole("searchbox", { name: "Filter worktrees by branch" }), { target: { value: "w7" } });
      expect(screen.getAllByRole("button", { name: /^Discard worktree/ }).map(button => button.getAttribute("aria-label"))).toEqual(["Discard worktree feature/w7"]);

      fireEvent.click(toggle);
      expect(screen.queryByRole("button", { name: /^Discard worktree/ })).toBeNull();
    });

    it("shows the running deploy to ADMIN users only, with its CLI, pane and elapsed time", async () => {
      const api = client();
      vi.mocked(api.connections).mockResolvedValue([]);
      const startedAt = new Date(Date.now() - 125_000).toISOString();
      const deployQueue = vi.fn(async () => ({
        available: true, daemonRunning: true, heartbeatAt: new Date().toISOString(), paused: null,
        current: { batchId: "b-1", phase: "DEPLOYING", ticketIds: ["q-1"], batchStartedAt: startedAt, phaseStartedAt: startedAt, candidate: "c".repeat(40) },
        next: null,
        active: [{ id: "q-1", status: "DEPLOYING" as const, branch: "space/wt-a", summary: "Deploy panel in Source Control", sha: "a".repeat(40),
          submittedAt: startedAt, updatedAt: startedAt, statusSince: startedAt, note: null, deployedCommit: null, conflictFiles: [], autoResolvedFiles: [], remotes: null,
          submitter: { runtimeId: "cli:claude", cliSessionId: "cli_session:a", paneId: "pane:a", roomId: "room:a", paneTitle: "Source Control work", roomName: "Space" } }],
        recent: []
      }));
      const view = render(dock(api));
      await screen.findByRole("button", { name: "Open diff for file.txt" });
      expect(screen.queryByRole("region", { name: "Deploys" })).toBeNull();
      view.unmount();

      render(<DockActiveContext.Provider value={true}>
        <SourceControlDock userId="user:a" projects={[{ label: "Proof", path: "/proof" }]} currentProjectPath="/proof" client={api} canViewDeploys deployClient={{ deployQueue }} />
      </DockActiveContext.Provider>);
      const deploys = await screen.findByRole("region", { name: "Deploys" });
      const run = await within(deploys).findByRole("group", { name: "Running deploy" });
      expect(within(deploys).getByText("Running")).toBeTruthy();
      expect(within(run).getByText("Source Control work")).toBeTruthy();
      expect(within(run).getByText("Claude Code CLI · Space")).toBeTruthy();
      expect(within(run).getByText("Deploy panel in Source Control")).toBeTruthy();
      expect(within(run).getByLabelText(/^Running for 2m 0[5-9]s$/)).toBeTruthy();
      expect(within(run).getByRole("listitem", { current: "step" }).textContent).toContain("Deploy");
    });

    it("refreshes status and worktrees from the one toolbar Refresh", async () => {
      const api = client();
      vi.mocked(api.connections).mockResolvedValue([]);
      worktreeApi.listWorktrees.mockResolvedValue([worktree()]);
      render(dock(api));
      fireEvent.click(await screen.findByRole("button", { name: /^Worktrees/ }));
      await screen.findByRole("button", { name: "Merge into develop" });
      expect(screen.getAllByRole("button", { name: /refresh/i }).map(button => button.getAttribute("aria-label"))).toEqual(["Refresh repository"]);
      const before = worktreeApi.listWorktrees.mock.calls.length;
      fireEvent.click(screen.getByRole("button", { name: "Refresh repository" }));
      await waitFor(() => expect(screen.getByText("Repository and remote status refreshed.")).toBeTruthy());
      expect(worktreeApi.listWorktrees.mock.calls.length).toBeGreaterThan(before);
    });

    it("asks in the app before discarding a file", async () => {
      const api = client();
      vi.mocked(api.connections).mockResolvedValue([]);
      const nativeConfirm = vi.fn(() => true);
      vi.stubGlobal("confirm", nativeConfirm);
      try {
        vi.mocked(api.operate).mockImplementation(async () => ({ ok: true, committed: false, pushed: false, message: "discard completed.", snapshot: await api.status("binding:local") }));
        render(dock(api));
        fireEvent.click(await screen.findByRole("button", { name: "Discard file.txt" }));
        const question = await screen.findByRole("alertdialog", { name: "Discard changes?" });
        expect(question.textContent).toContain("file.txt");
        expect(api.operate).not.toHaveBeenCalled();
        fireEvent.click(within(question).getByRole("button", { name: "Discard changes" }));
        await waitFor(() => expect(api.operate).toHaveBeenCalledWith("discard", expect.objectContaining({ paths: ["file.txt"], confirmed: true })));
        expect(nativeConfirm).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("labels a detached checkout and the sync counts in plain words", async () => {
      const api = client();
      vi.mocked(api.connections).mockResolvedValue([]);
      vi.mocked(api.status).mockResolvedValue({ ...await api.status("binding:local"), branch: null, ahead: 1, behind: 3,
        projectVersion: "0.1.20", projectPillars: { core: "0.1.20", desktop: "0.1.3" } });
      render(dock(api));
      const detached = await screen.findByText("Detached (no branch)");
      expect(detached.getAttribute("title")).toMatch(/detached HEAD/);
      expect(screen.queryByText("Detached HEAD")).toBeNull();
      expect(screen.getByLabelText("1 to push, 3 to pull").getAttribute("title")).toBe("1 to push, 3 to pull");
      const version = screen.getByText("v0.1.20");
      expect(version.getAttribute("title")).toContain("core: v0.1.20");
      expect(version.getAttribute("title")).not.toMatch(/Space Platform|Desktop App|Mobile App|Setup CLI/);
    });

    it("keeps fullscreen when Escape closes a dialog inside the dock", async () => {
      const api = client();
      vi.mocked(api.connections).mockResolvedValue([]);
      render(dock(api));
      await screen.findByRole("button", { name: "Open diff for file.txt" });
      fireEvent.click(screen.getByRole("button", { name: "Open source control fullscreen" }));
      expect(screen.getByRole("heading", { name: "Source Control" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Repository defaults" }));
      const dialog = await screen.findByRole("dialog", { name: "Repository defaults" });
      act(() => { fireEvent.keyDown(dialog, { key: "Escape" }); });
      expect(screen.getByRole("button", { name: "Exit source control fullscreen" })).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: "Close Repository defaults" }));
      act(() => { fireEvent.keyDown(screen.getByRole("button", { name: "Refresh repository" }), { key: "Escape" }); });
      expect(screen.getByRole("button", { name: "Open source control fullscreen" })).toBeTruthy();
    });
  });
});
