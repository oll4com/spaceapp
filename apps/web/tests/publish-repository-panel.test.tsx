// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { repositoryProviderRegistry, type RepositoryProviderId, type RepositoryProviderState, type RepositoryTarget } from "@space/contracts";
import { PublishRepositoryPanel } from "../src/features/source-control/PublishRepositoryPanel.js";
import type { SourceControlClient } from "../src/features/source-control/client.js";

afterEach(() => cleanup());
const connected = (ids: RepositoryProviderId[]): RepositoryProviderState[] => repositoryProviderRegistry.map(descriptor => ({ ...descriptor, enabled: ids.includes(descriptor.id),
  connection: { provider: descriptor.id, serverUrl: descriptor.defaultServerUrl, status: ids.includes(descriptor.id) ? "CONNECTED" : "NOT_CONNECTED", accountLogin: ids.includes(descriptor.id) ? "dev" : null, connectedAt: null, checkedAt: null, error: null } }));
const target = (provider: RepositoryProviderId, id: string, name: string, extra: Partial<RepositoryTarget> = {}): RepositoryTarget => ({ id, provider, kind: "namespace", name, canCreateRepository: true, ...extra });
function client(targets: (provider: RepositoryProviderId, parent?: string) => RepositoryTarget[]) {
  return {
    targets: vi.fn(async (provider: RepositoryProviderId, parent?: string) => ({ data: targets(provider, parent), nextPage: null, nextCursor: null })),
    pendingPublishes: vi.fn(async () => []),
    dismissPublish: vi.fn(async () => ({ ok: true })),
    bindRepository: vi.fn(async (projectPath: string, provider: RepositoryProviderId) => ({ kind: "provider" as const, id: `binding:${provider}`, ownerUserId: "u", projectPath, provider, serverUrl: "https://x", repository: null })),
    status: vi.fn(async () => ({ version: "v1" })),
    previewPublish: vi.fn(async input => ({ provider: "gitlab", serverUrl: "https://gitlab.com", targetId: input.targetId ?? null, targetName: "group/sub", createPermission: "allowed", name: input.name, private: input.private, visibility: input.private ? "private" : "public", hasCommits: true, willCommit: false, willPush: false, expectedVersion: "v1" })),
    operate: vi.fn(async () => ({ ok: true, remoteCreated: true, createOutcome: "created", committed: false, pushed: false, message: "Remote created and bound.", snapshot: {}, binding: { kind: "provider", id: "binding:gitlab", ownerUserId: "u", projectPath: "/p", provider: "gitlab", serverUrl: "https://gitlab.com", repository: { id: "9" } } }))
  } as unknown as SourceControlClient;
}
const choose = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("publish repository panel", () => {
  it("lists GitLab subgroups on demand and never stages, commits or pushes", async () => {
    const api = client((_provider, parent) => parent === "10" ? [target("gitlab", "11", "group/sub", { parentId: "10" })] : [target("gitlab", "1", "dev", { kind: "user" }), target("gitlab", "10", "group")]);
    const onPublished = vi.fn();
    render(<PublishRepositoryPanel client={api} projectPath="/p" providers={connected(["gitlab"])} preferred="gitlab" defaultName="p" disabled={false} onPublished={onPublished} />);
    await waitFor(() => expect(screen.getAllByRole("option").map(o => o.textContent)).toContain("group"));
    choose("Publish target", "10");
    fireEvent.click(screen.getByRole("button", { name: "Show subgroups of group" }));
    await waitFor(() => expect(screen.getAllByRole("option").map(o => o.textContent)).toContain("group/sub"));
    expect(api.targets).toHaveBeenCalledWith("gitlab", "10", undefined);
    choose("Publish target", "11");
    fireEvent.click(screen.getByRole("button", { name: "Review publish" }));
    expect(await screen.findByRole("group", { name: "Publish preview" })).toBeTruthy();
    expect(screen.getByText(/Existing commits stay local until you choose Push/)).toBeTruthy();
    expect(api.previewPublish).toHaveBeenCalledWith(expect.objectContaining({ bindingId: "binding:gitlab", targetId: "11", private: true, name: "p" }));
    fireEvent.click(screen.getByRole("button", { name: "Create remote repository" }));
    await waitFor(() => expect(onPublished).toHaveBeenCalledWith("/p", "gitlab", expect.objectContaining({ remoteCreated: true }), true));
    const call = vi.mocked(api.operate).mock.calls[0]!;
    expect(call[0]).toBe("publish");
    expect(call[1]).toMatchObject({ confirmed: true, paths: [], targetId: "11", operationId: vi.mocked(api.previewPublish).mock.calls[0]![0].operationId });
  });

  it("requires a Bitbucket workspace and project and shows unknown create permission honestly", async () => {
    const api = client((provider, parent) => parent ? [target("bitbucket", `${parent}/{p}`, "Project", { kind: "project", parentId: parent, canCreateRepository: false, createPermission: "unknown" })] : [target("bitbucket", "{w}", "Workspace", { kind: "workspace", canCreateRepository: false })]);
    render(<PublishRepositoryPanel client={api} projectPath="/p" providers={connected(["bitbucket"])} preferred={null} defaultName="p" disabled={false} onPublished={vi.fn()} />);
    await screen.findByText("Workspace");
    expect((screen.getByRole("button", { name: "Review publish" }) as HTMLButtonElement).disabled).toBe(true);
    choose("Bitbucket workspace", "{w}");
    expect(await screen.findByText("Project (permission checked on create)")).toBeTruthy();
    await waitFor(() => expect((screen.getByRole("button", { name: "Review publish" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("locks visibility to the Azure project's inherited setting", async () => {
    const api = client(() => [target("azure-devops", "proj-guid", "Public Project", { kind: "project", visibility: "public" })]);
    render(<PublishRepositoryPanel client={api} projectPath="/p" providers={connected(["azure-devops"])} preferred={null} defaultName="p" disabled={false} onPublished={vi.fn()} />);
    expect(await screen.findByText("Inherited from the public project.")).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "Private repository" }) as HTMLInputElement;
    expect(toggle.checked).toBe(false); expect(toggle.disabled).toBe(true);
  });

  it("reports busy state and offers a confirmed dismiss for an unconfirmed earlier publish", async () => {
    const api = client(() => [target("gitlab", "1", "dev", { kind: "user" })]);
    vi.mocked(api.pendingPublishes).mockResolvedValueOnce([{ bindingId: "binding:gitlab", provider: "gitlab", operationId: "op-1", state: "unknown", name: "tool", createdAt: "2026-10-10T00:00:00.000Z" }]).mockResolvedValue([]);
    const onBusyChange = vi.fn();
    render(<PublishRepositoryPanel client={api} projectPath="/p" providers={connected(["gitlab"])} preferred="gitlab" defaultName="p" disabled={false} onPublished={vi.fn()} onBusyChange={onBusyChange} />);
    const group = await screen.findByRole("group", { name: "Unconfirmed publish" });
    expect(group.textContent).toContain("GitLab"); expect(group.textContent).toContain("tool");
    fireEvent.click(screen.getByRole("button", { name: "Mark as not created" }));
    expect(api.dismissPublish).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm: no repository was created" }));
    await waitFor(() => expect(api.dismissPublish).toHaveBeenCalledWith("binding:gitlab", "op-1"));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Unconfirmed publish" })).toBeNull());
    expect(onBusyChange).toHaveBeenCalledWith(true); expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("keeps publish collapsible behind a button-style summary and lets errors be dismissed", async () => {
    const api = client(() => []);
    vi.mocked(api.targets).mockRejectedValue(new Error("GitLab is offline."));
    const view = render(<PublishRepositoryPanel client={api} projectPath="/p" providers={connected(["gitlab"])} preferred="gitlab" defaultName="p" disabled={false} onPublished={vi.fn()} />);
    const summary = view.container.querySelector("details.source-control-publish > summary") as HTMLElement;
    expect(summary.textContent).toBe("Publish to a provider");
    expect(summary.classList.contains("dock-kit-button")).toBe(true);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("GitLab is offline.");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss message" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("explains how to publish when no provider is connected", () => {
    render(<PublishRepositoryPanel client={client(() => [])} projectPath="/p" providers={connected([])} preferred={null} defaultName="p" disabled={false} onPublished={vi.fn()} />);
    expect(screen.getByText("Connect a repository provider in Settings → Plugins to publish this project.")).toBeTruthy();
  });
});
