// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorktreeBadge } from "../src/features/worktrees/WorktreeBadge.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WorktreeBadge", () => {
  it("renders collapsed isolated worktree badge with branch name in title", () => {
    render(
      <WorktreeBadge
        worktreePath="/opt/spaceapp/var/worktrees/space/wt-test-123"
        branch="wt-test-123"
      />
    );

    const button = screen.getByRole("button", { name: "Isolated Worktree wt-test-123" });
    expect(button).toBeTruthy();
    expect(button.getAttribute("title")).toBe("Isolated Worktree: wt-test-123 (Click to open)");
  });

  it("expands when clicked and allows closing", () => {
    render(
      <WorktreeBadge
        worktreePath="/var/lib/spaceapp-user/agent-workspace/active/feat-custom-branch"
        branch="feat-custom-branch"
      />
    );

    const button = screen.getByRole("button", { name: "Isolated Worktree feat-custom-branch" });
    fireEvent.click(button);

    const branchName = screen.getByText("feat-custom-branch");
    expect(branchName.classList.contains("worktree-branch-name")).toBe(true);
    const mergeLabel = screen.getByText("Merge");
    expect(mergeLabel.classList.contains("worktree-action-label")).toBe(true);
    expect(screen.getByTitle("Merge to main")).toBeTruthy();
    expect(screen.getByTitle("Discard worktree")).toBeTruthy();

    const collapseButton = screen.getByTitle("Collapse");
    fireEvent.click(collapseButton);

    expect(screen.getByRole("button", { name: "Isolated Worktree feat-custom-branch" })).toBeTruthy();
  });

  it("hides icon when worktree is merged and does not show checkmark icon or branch icon", async () => {
    const onMerged = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          id: "wt:wt-test-merged",
          worktreePath: "/opt/spaceapp/var/worktrees/space/wt-test-merged",
          branch: "space/wt-test-merged",
          status: "MERGED",
          isDirty: false,
          aheadCount: 0
        }
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <WorktreeBadge
        worktreePath="/opt/spaceapp/var/worktrees/space/wt-test-merged"
        branch="wt-test-merged"
        onMerged={onMerged}
      />
    );

    // When merged, simply do NOT display an icon (returns null)
    await waitFor(() => {
      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.queryByText("Merged to main")).toBeNull();
    });

    expect(onMerged).not.toHaveBeenCalled();
  });

  it("keeps showing icon when worktree is clean and has aheadCount 0 but status is ACTIVE", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          id: "wt:wt-test-active-clean",
          worktreePath: "/opt/spaceapp/var/worktrees/space/wt-test-active-clean",
          branch: "space/wt-test-active-clean",
          status: "ACTIVE",
          isDirty: false,
          aheadCount: 0
        }
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <WorktreeBadge
        worktreePath="/opt/spaceapp/var/worktrees/space/wt-test-active-clean"
        branch="wt-test-active-clean"
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Isolated Worktree wt-test-active-clean" })).toBeTruthy();
    });
  });

  it("dynamically shows icon again when agent creates new changes and cycles through multiple merge cycles", async () => {
    let currentStatus = {
      id: "wt:wt-cycle",
      worktreePath: "/opt/spaceapp/var/worktrees/space/wt-cycle",
      branch: "space/wt-cycle",
      status: "MERGED",
      isDirty: false,
      aheadCount: 0
    };

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/api/worktrees/merge")) {
        currentStatus = { ...currentStatus, status: "MERGED", isDirty: false, aheadCount: 0 };
        return {
          ok: true,
          json: async () => ({ ok: true, status: "MERGED" })
        };
      }
      return {
        ok: true,
        json: async () => ({ data: currentStatus })
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <WorktreeBadge
        worktreePath="/opt/spaceapp/var/worktrees/space/wt-cycle"
        branch="wt-cycle"
      />
    );

    // Initial state: merged -> no icon
    await waitFor(() => {
      expect(screen.queryByRole("button")).toBeNull();
    });

    // Cycle 1: Agent creates new changes! (worktree becomes dirty)
    currentStatus = { ...currentStatus, status: "DIRTY", isDirty: true, aheadCount: 0 };
    // Trigger check via visibility/focus event
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    // Icon MUST reappear!
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Isolated Worktree wt-cycle" })).toBeTruthy();
    });

    // User merges cycle 1
    const iconBtn = screen.getByRole("button", { name: "Isolated Worktree wt-cycle" });
    fireEvent.click(iconBtn);
    const mergeBtn = screen.getByTitle("Merge to main");
    await act(async () => {
      fireEvent.click(mergeBtn);
    });

    // Merged -> Icon disappears again!
    await waitFor(() => {
      expect(screen.queryByRole("button")).toBeNull();
    });

    // Cycle 2: Agent creates new changes again!
    currentStatus = { ...currentStatus, status: "ACTIVE", isDirty: false, aheadCount: 2 };
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    // Icon MUST reappear again for cycle 2!
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Isolated Worktree wt-cycle" })).toBeTruthy();
    });
  });

  it("decides the Remove warning from a fresh status read, not the polled one", async () => {
    const worktreePath = "/opt/spaceapp/var/worktrees/space/wt-remove-check";
    const item = (isDirty: boolean) => ({ ok: true, json: async () => ({ data: { worktreePath, branch: "wt-remove-check", isDirty, aheadCount: 1, behindCount: 0, status: isDirty ? "DIRTY" : "ACTIVE" } }) });
    let freshDirty: boolean | null = true;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return { ok: true, json: async () => ({ ok: true }) };
      if (url.includes("fresh=1")) return freshDirty === null ? { ok: false, json: async () => ({}) } : item(freshDirty);
      return item(false);
    });
    vi.stubGlobal("fetch", fetchMock);
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    render(<WorktreeBadge worktreePath={worktreePath} branch="wt-remove-check" />);
    fireEvent.click(screen.getByRole("button", { name: "Isolated Worktree wt-remove-check" }));

    fireEvent.click(screen.getByTitle("Discard worktree"));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith("Worktree has uncommitted changes. Force discard?"));
    freshDirty = null;
    fireEvent.click(screen.getByTitle("Discard worktree"));
    await waitFor(() => expect(confirm).toHaveBeenLastCalledWith("Could not check the worktree for uncommitted changes. Force discard?"));
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);

    freshDirty = false;
    fireEvent.click(screen.getByTitle("Discard worktree"));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => (init as RequestInit | undefined)?.method === "DELETE" && String(url).includes("force=true"))).toBe(true));
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});
