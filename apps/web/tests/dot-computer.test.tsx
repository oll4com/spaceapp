import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DotComputer as DotComputerState, DotProfile } from "@space/contracts";
import { DotComputer } from "../src/features/agent-pane/DotComputer.js";
import { DotProfileForm } from "../src/features/agent-pane/DotSettings.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

vi.setConfig({ testTimeout: 30_000 });
beforeEach(() => installSpaceRuntime(liveRuntime));
afterEach(cleanup);
const at = "2026-10-10T10:00:00.000Z";
const dot = { dotId: `dot:${"1".repeat(32)}`, name: "Luna", preferences: { communicationStyle: "Brief", language: "Greek" },
  workLimits: { maxConcurrentTasks: 2, dailyBudgetUsd: null } } as unknown as DotProfile;
const computer = (overrides: Partial<DotComputerState> = {}): DotComputerState => ({ dotId: dot.dotId,
  workspace: { path: "/opt/spaceapp/var/dots/workspaces/111", exists: true, totalEntries: 3, sortedAll: true,
    entries: [{ name: "report.md", kind: "file", bytes: 2048, modifiedAt: at }, { name: "drafts", kind: "directory", bytes: null, modifiedAt: at }] },
  runs: [{ sessionId: "agent_session:1", runId: "run:1", roomId: "room:1", roomName: "Research", paneId: "pane:1", title: "Supplier report",
    status: "RUNNING", kind: "GOAL", startedAt: at }],
  goals: [{ goalId: "dot_goal:abcdefgh1", objective: "Ship the report", status: "ACTIVE", steps: 2, maxSteps: 20 }],
  browsers: [{ roomId: "room:1", roomName: "Research", paneId: "pane:browser", active: true, currentUrl: "https://example.com/", title: "Example", sessionId: "browser_session:1", ready: true }],
  limits: { maxConcurrentTasks: 2, activeTasks: 1 }, ...overrides });

describe("Dot computer view", () => {
  it("shows live work, the private workspace and the Dot's own browser", async () => {
    const read = vi.fn(async () => computer());
    render(<DotComputer dot={dot} sessionId="agent_session:1" read={read} stop={vi.fn()} />);
    expect(await screen.findByText("Supplier report")).toBeTruthy();
    expect(screen.getByText(/Goal step · Running · Research/)).toBeTruthy();
    expect(screen.getByText("1 of 2 task slots")).toBeTruthy();
    expect(screen.getByText("Ship the report")).toBeTruthy();
    expect(screen.getByText("/opt/spaceapp/var/dots/workspaces/111")).toBeTruthy();
    expect(screen.getByText("report.md")).toBeTruthy();
    expect(screen.getByText(/2\.0 KB/)).toBeTruthy();
    expect(screen.getByText("Showing the 2 most recent of 3 items.")).toBeTruthy();
    expect(screen.getByText(/Research · https:\/\/example\.com\//)).toBeTruthy();
    expect(screen.getByText(/not signed in to your accounts/)).toBeTruthy();
  });

  it("stops this task or all work and reports what happened", async () => {
    const read = vi.fn(async () => computer());
    const stop = vi.fn(async () => ({ dotId: dot.dotId, interruptedRuns: 1, pausedGoals: 1 }));
    render(<DotComputer dot={dot} sessionId="agent_session:1" read={read} stop={stop} />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop this task" }));
    await waitFor(() => expect(stop).toHaveBeenCalledWith(dot.dotId, "agent_session:1"));
    expect(await screen.findByText("1 task stopped, 1 goal paused.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop all Luna's work" }));
    await waitFor(() => expect(stop).toHaveBeenLastCalledWith(dot.dotId, null));
  });

  it("disables stopping when nothing runs, explains a missing workspace and retries after a failure", async () => {
    const idle = vi.fn(async () => computer({ runs: [], goals: [], browsers: [], workspace: { path: "/w", exists: false, entries: [], totalEntries: 0, sortedAll: true } }));
    const { unmount } = render(<DotComputer dot={dot} sessionId={null} read={idle} stop={vi.fn()} />);
    expect(await screen.findByText("No task is running.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Stop all Luna's work" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Stop this task" })).toBeNull();
    expect(screen.getByText("Not created yet.")).toBeTruthy();
    expect(screen.getByText("No browser open.")).toBeTruthy();
    unmount();
    const failing = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue(computer());
    render(<DotComputer dot={dot} sessionId={null} read={failing} stop={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Supplier report")).toBeTruthy();
  });

  it("does not poll while hidden and rejects another Dot's data", async () => {
    const read = vi.fn(async () => computer({ dotId: `dot:${"2".repeat(32)}` }));
    const { rerender } = render(<DotComputer dot={dot} sessionId={null} visible={false} read={read} stop={vi.fn()} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(read).not.toHaveBeenCalled();
    rerender(<DotComputer dot={dot} sessionId={null} visible read={read} stop={vi.fn()} />);
    expect(await screen.findByText("Computer unavailable.")).toBeTruthy();
  });
});

describe("Dot settings", () => {
  it("saves name, style, language and tasks at once, and can clear preferences", async () => {
    const update = vi.fn(async (_id: string, input: Record<string, unknown>) => ({ dot: { ...dot, name: input.name } as DotProfile }));
    const onSaved = vi.fn();
    const choices = { providers: [{ providerId: "codex", providerName: "Codex (OpenAI)", statusReason: null, options: [{ id: "codex-v1|gpt|high",
      displayName: "GPT", providerId: null, providerName: null, model: "gpt", reasoningKey: "high", reasoningLabel: "High reasoning", isDefault: true }] }] };
    render(<DotProfileForm dot={dot} choices={choices} onSaved={onSaved} update={update as never} />);
    expect(screen.getByRole("form", { name: "Luna profile" })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Dot name" }), { target: { value: "  Luna Prime " } });
    fireEvent.change(screen.getByRole("textbox", { name: "Communication style" }), { target: { value: "" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Reply language" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "4" }));
    expect(screen.getByRole("button", { name: "4" }).getAttribute("aria-pressed")).toBe("true");
    // Stage 8: the Dot's model and permissions are set here, in Settings → Dots.
    fireEvent.change(screen.getByRole("combobox", { name: "Dot model" }), { target: { value: "codex-v1|gpt|high" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Dot permissions" }), { target: { value: "approve_for_me" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith(dot.dotId, { name: "Luna Prime", preferences: { communicationStyle: "", language: "",
      runtime: { modelConfigId: "codex-v1|gpt|high", permissionMode: "approve_for_me" } }, workLimits: { maxConcurrentTasks: 4, dailyBudgetUsd: null } });
    expect(await screen.findByText(/apply from its next message/)).toBeTruthy();
  });

  it("validates input and shows a save failure", async () => {
    const update = vi.fn(async () => { throw new Error("Dot was not found."); });
    render(<DotProfileForm dot={dot} choices={null} onSaved={vi.fn()} update={update as never} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Reply language" }), { target: { value: "G" } });
    expect(screen.getByRole("alert").textContent).toMatch(/at least two characters/);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Reply language" }), { target: { value: "English" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Dot was not found.");
  });
});

describe("Dot workspace files and deliverables", () => {
  it("browses folders, opens and downloads files, and publishes a new version", async () => {
    const { DotWorkspaceFiles } = await import("../src/features/agent-pane/DotDeliverables.js");
    const readFolder = vi.fn(async (_dot: string, folder?: string) => ({ dotId: dot.dotId, folder: folder ?? "", exists: true, totalEntries: 1, sortedAll: true,
      entries: [{ name: "q3.pdf", kind: "file" as const, bytes: 4096, modifiedAt: at }] }));
    let published = 0;
    const deliverable = (version: number) => ({ deliverableId: `dot_deliverable:${String(version).padStart(32, "0")}`, dotId: dot.dotId, roomId: "room:1",
      name: "reports/q3.pdf", version, artifactId: `artifact:v${version}`, sha256: "a".repeat(64), byteSize: 4096, mimeType: "application/pdf",
      publishedBy: "USER" as const, createdAt: at });
    const readDeliverables = vi.fn(async () => ({ dotId: dot.dotId, items: Array.from({ length: published }, (_, index) => deliverable(index + 1)) }));
    const publish = vi.fn(async () => { published += 1; return { deliverable: deliverable(published), unchanged: false }; });
    render(<DotWorkspaceFiles dot={dot} roomId="room:1" refreshKey={0} readFolder={readFolder as never} readDeliverables={readDeliverables as never} publish={publish as never}
      rootEntries={[{ name: "reports", kind: "directory", bytes: null, modifiedAt: at }, { name: "page.html", kind: "file", bytes: 20, modifiedAt: at }]} />);
    expect(await screen.findByText("Nothing published yet.")).toBeTruthy();
    // HTML is not previewed in Space; it can only be downloaded.
    expect(screen.queryByRole("link", { name: "Open page.html" })).toBeNull();
    expect(screen.getByRole("link", { name: "Download page.html" }).getAttribute("href")).toContain("download=1");
    fireEvent.click(screen.getByRole("button", { name: "reports" }));
    await waitFor(() => expect(readFolder).toHaveBeenCalledWith(dot.dotId, "reports"));
    expect((await screen.findByRole("link", { name: "Open q3.pdf" })).getAttribute("href")).toBe(`/api/dots/${encodeURIComponent(dot.dotId)}/workspace/file?path=reports%2Fq3.pdf`);
    fireEvent.click(screen.getByRole("button", { name: "Publish q3.pdf to Agent Files" }));
    await waitFor(() => expect(publish).toHaveBeenCalledWith(dot.dotId, { path: "reports/q3.pdf", roomId: "room:1" }));
    expect(await screen.findByText("Published reports/q3.pdf as version 1 in Agent Files.")).toBeTruthy();
    expect(await screen.findByRole("link", { name: "Download reports/q3.pdf version 1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Publish q3.pdf to Agent Files" }));
    expect(await screen.findByRole("link", { name: "Download reports/q3.pdf version 2" })).toBeTruthy();
    expect(screen.getByText("v2 (latest)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    expect(await screen.findByRole("button", { name: "reports" })).toBeTruthy();
  });
});
