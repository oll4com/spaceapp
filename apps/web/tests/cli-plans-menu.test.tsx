// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { CliPlansMenu } from "../src/features/terminal-pane/CliPlansMenu.js";
import { notifyClipboardUpdated } from "../src/features/clipboard-dock/clipboard-events.js";
import { SPACE_OPEN_PLAN_PANE_EVENT } from "../src/features/clipboard-dock/plan-assignee.js";
import { api } from "../src/api.js";
import { installSpaceRuntime, type SpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import type { ClipboardItem } from "@space/contracts";

vi.mock("../src/api.js", () => ({
  api: {
    clipboardItems: vi.fn(),
    rooms: vi.fn().mockResolvedValue({ data: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 1 } }),
    updatePlanProgress: vi.fn().mockResolvedValue({}),
    setClipboardItemCompleted: vi.fn().mockResolvedValue({})
  }
}));

describe("CliPlansMenu", () => {
  const mockPlans: ClipboardItem[] = [
    {
      id: "clipboard:old1",
      text: "Older plan content",
      source: "PLAN",
      title: "Older Plan",
      minimumModel: "gpt-5.6-sol",
      isCompleted: false,
      executionStatus: "PLANNED",
      progressPercentage: 0,
      activeAgent: null,
      steps: [],
      lastProgressAt: null,
      roomId: null,
      paneId: null,
      paneTitle: null,
      occurrenceCount: 1,
      characterCount: 18,
      createdAt: "2026-09-27T10:00:00.000Z",
      lastUsedAt: "2026-09-27T10:00:00.000Z"
    },
    {
      id: "clipboard:new1",
      text: "Newer plan content with steps",
      source: "PLAN",
      title: "Newer Plan",
      minimumModel: "gpt-6.1-sol",
      minimumReasoning: "medium",
      isCompleted: false,
      executionStatus: "IN_PROGRESS",
      progressPercentage: 50,
      activeAgent: null,
      steps: [],
      lastProgressAt: null,
      roomId: null,
      paneId: null,
      paneTitle: null,
      occurrenceCount: 1,
      characterCount: 30,
      createdAt: "2026-09-28T10:00:00.000Z",
      lastUsedAt: "2026-09-28T10:00:00.000Z"
    },
    {
      id: "clipboard:completed1",
      text: "Completed plan content",
      source: "PLAN",
      title: "Completed Plan",
      minimumModel: "gpt-5.6-sol",
      isCompleted: true,
      executionStatus: "COMPLETED",
      progressPercentage: 100,
      activeAgent: null,
      steps: [],
      lastProgressAt: null,
      roomId: null,
      paneId: null,
      paneTitle: null,
      occurrenceCount: 1,
      characterCount: 22,
      createdAt: "2026-09-28T11:00:00.000Z",
      lastUsedAt: "2026-09-28T11:00:00.000Z"
    }
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.clipboardItems).mockResolvedValue({
      data: mockPlans,
      pagination: {
        page: 1,
        pageSize: 100,
        totalItems: mockPlans.length,
        totalPages: 1
      }
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the plans menu button with badge", async () => {
    render(<CliPlansMenu active={true} disabled={false} onSelectPlan={vi.fn()} />);

    const button = screen.getByRole("button", { name: /Open plans/i });
    expect(button).toBeDefined();

    await waitFor(() => {
      // 2 open plans (older and newer; completed is excluded)
      expect(screen.getByText("2")).toBeDefined();
    });
  });

  it("opens popover with plans sorted from newest to oldest, previews a plan on click and sends it only from Send to CLI", async () => {
    const handleSelectPlan = vi.fn();
    render(<CliPlansMenu active={true} disabled={false} onSelectPlan={handleSelectPlan} />);

    const button = screen.getByRole("button", { name: /Open plans/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText("Open plans")).toBeDefined();
      expect(screen.getByText("Newer Plan")).toBeDefined();
      expect(screen.getByText("Older Plan")).toBeDefined();
      // Completed plan should not be shown
      expect(screen.queryByText("Completed Plan")).toBeNull();
    });

    expect(screen.getByText("gpt-6.1-sol · medium")).toBeDefined();
    expect(screen.getByTitle("Minimum capable model: gpt-6.1-sol; Recommended reasoning: medium")).toBeDefined();

    // Check ordering: Newer Plan should come before Older Plan
    const planItems = screen.getAllByRole("listitem");
    expect(planItems).toHaveLength(2);
    expect(planItems[0]?.textContent).toContain("Newer Plan");
    expect(planItems[1]?.textContent).toContain("Older Plan");

    // Each list item holds a real button; clicking it only previews the plan: nothing is sent or linked yet.
    fireEvent.click(within(planItems[0]!).getByRole("button"));
    expect(screen.getByText("Plan preview")).toBeDefined();
    expect(screen.getByText("Newer plan content with steps")).toBeDefined();
    expect(handleSelectPlan).not.toHaveBeenCalled();
    expect(api.updatePlanProgress).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Insert without sending" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Send to CLI" }));
    expect(handleSelectPlan).toHaveBeenCalledTimes(1);
    expect(handleSelectPlan).toHaveBeenCalledWith(mockPlans[1]);
    expect(api.updatePlanProgress).not.toHaveBeenCalled();
  });

  it("offers insert without sending, warns before clearing a typed draft and copies the plan text", async () => {
    const writeText = vi.fn(async () => undefined);
    installSpaceRuntime({
      ...liveRuntime,
      platform: { ...liveRuntime.platform, clipboard: { writeText } as unknown as SpaceRuntime["platform"]["clipboard"] }
    });
    const handleSelectPlan = vi.fn();
    const handleInsertPlan = vi.fn();
    render(
      <CliPlansMenu
        active={true}
        disabled={false}
        onSelectPlan={handleSelectPlan}
        onInsertPlan={handleInsertPlan}
        draftWillBeCleared={() => true}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Open plans/i }));
    await waitFor(() => expect(screen.getByText("Older Plan")).toBeDefined());
    fireEvent.click(screen.getByText("Older Plan"));

    expect(screen.getByText(/Send to CLI clears the text you have typed in this CLI/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Copy plan" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeDefined());
    expect(writeText).toHaveBeenCalledWith("Older plan content");

    fireEvent.click(screen.getByRole("button", { name: "Back to plans" }));
    expect(screen.getByText("Open plans")).toBeDefined();
    fireEvent.click(screen.getByText("Older Plan"));
    fireEvent.click(screen.getByRole("button", { name: "Insert without sending" }));
    expect(handleInsertPlan).toHaveBeenCalledWith(mockPlans[0]);
    expect(handleSelectPlan).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    installSpaceRuntime(liveRuntime);
  });

  it("renders active plan view directly when pane has an active plan", async () => {
    const pane = {
      id: "pane-active-1",
      paneName: "Finn",
      title: "Finn"
    };

    const activePlanItem: ClipboardItem = {
      ...mockPlans[1]!,
      id: "clipboard:active1",
      title: "Active Multi-stage Plan",
      paneId: "pane-active-1",
      paneTitle: "Finn",
      progressPercentage: 40,
      executionStatus: "IN_PROGRESS",
      steps: [
        {
          id: "step-1",
          order: 1,
          title: "Architecture & Contracts",
          status: "COMPLETED",
          progress: 100,
          agent: "sol",
          notes: "All schemas defined",
          proof: "contracts test pass",
          startedAt: null,
          completedAt: null
        },
        {
          id: "step-2",
          order: 2,
          title: "UI Implementation",
          status: "IN_PROGRESS",
          progress: 60,
          agent: "astra",
          notes: "Stepper in progress",
          proof: null,
          startedAt: null,
          completedAt: null
        },
        {
          id: "step-3",
          order: 3,
          title: "Verification & Preflight",
          status: "PENDING",
          progress: 0,
          agent: null,
          notes: null,
          proof: null,
          startedAt: null,
          completedAt: null
        }
      ]
    };

    vi.mocked(api.clipboardItems).mockResolvedValue({
      data: [mockPlans[0]!, activePlanItem],
      pagination: {
        page: 1,
        pageSize: 100,
        totalItems: 2,
        totalPages: 1
      }
    });

    render(<CliPlansMenu pane={pane} active={true} disabled={false} onSelectPlan={vi.fn()} />);

    // Active plan badge shows 40%
    await waitFor(() => {
      expect(screen.getByText("40%")).toBeDefined();
    });

    const button = screen.getByRole("button", { name: /Active plan: Active Multi-stage Plan \(40%\)/i });
    expect(button).toBeDefined();

    // Click button to open menu
    fireEvent.click(button);

    // Should open directly into Active Plan Progress view
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Active plan progress" })).toBeDefined();
      expect(screen.getByText("Plan Progress")).toBeDefined();
      expect(screen.getByText("Overall Progress:")).toBeDefined();
    });

    // Verify stage graphic nodes and labels
    expect(screen.getByText("Stages & Milestones")).toBeDefined();
    expect(screen.getByText("Stage 1: Architecture & Contracts")).toBeDefined();
    // Stage 2 appears both in Current Stage callout and in the stepper timeline
    expect(screen.getAllByText("Stage 2: UI Implementation")).toHaveLength(2);
    expect(screen.getByText("Stage 3: Verification & Preflight")).toBeDefined();
    expect(screen.getByText("Current Stage:")).toBeDefined();

    // Test expanding step details (notes and proof)
    const step1Titles = screen.getAllByText("Stage 1: Architecture & Contracts");
    const step1Content = step1Titles[0]?.closest(".terminal-plan-step-content");
    expect(step1Content).toBeDefined();
    fireEvent.click(step1Content!);

    await waitFor(() => {
      expect(screen.getByText("All schemas defined")).toBeDefined();
      expect(screen.getByText("contracts test pass")).toBeDefined();
    });

    // Test header close 'X' button
    const closeBtn = screen.getByRole("button", { name: "Close" });
    expect(closeBtn).toBeDefined();
    fireEvent.click(closeBtn);

    // Popover should close
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Active plan progress" })).toBeNull();
    });
  });

  it("allows switching between active plan view and all plans view, and filtering with search", async () => {
    const pane = {
      id: "pane-active-1",
      paneName: "Finn"
    };

    const activePlanItem: ClipboardItem = {
      ...mockPlans[1]!,
      id: "clipboard:active1",
      title: "Searchable Active Plan",
      paneId: "pane-active-1",
      paneTitle: "Finn",
      progressPercentage: 25,
      executionStatus: "IN_PROGRESS"
    };

    const secondPlanItem: ClipboardItem = {
      ...mockPlans[0]!,
      id: "clipboard:extra1",
      title: "Another Database Migration Plan",
      paneId: null,
      executionStatus: "PLANNED",
      progressPercentage: 0
    };

    const thirdPlanItem: ClipboardItem = {
      ...mockPlans[0]!,
      id: "clipboard:extra2",
      title: "Refactor Frontend State",
      paneId: null,
      executionStatus: "PLANNED",
      progressPercentage: 0
    };

    const fourthPlanItem: ClipboardItem = {
      ...mockPlans[0]!,
      id: "clipboard:extra3",
      title: "Cleanup Temp Files",
      paneId: null,
      executionStatus: "PLANNED",
      progressPercentage: 0
    };

    vi.mocked(api.clipboardItems).mockResolvedValue({
      data: [activePlanItem, secondPlanItem, thirdPlanItem, fourthPlanItem],
      pagination: {
        page: 1,
        pageSize: 100,
        totalItems: 4,
        totalPages: 1
      }
    });

    render(<CliPlansMenu pane={pane} active={true} disabled={false} onSelectPlan={vi.fn()} />);

    const button = await screen.findByRole("button", { name: /Active plan/i });
    fireEvent.click(button);

    // We start in Active Plan view
    await waitFor(() => {
      expect(screen.getByText("Plan Progress")).toBeDefined();
    });

    // Click "All plans (4)"
    const allPlansNavBtn = screen.getByRole("button", { name: /All plans \(4\)/i });
    fireEvent.click(allPlansNavBtn);

    // Now in All Plans view
    await waitFor(() => {
      expect(screen.getByText(/Currently Running:/i)).toBeDefined();
      expect(screen.getByRole("button", { name: "Back to active plan progress" })).toBeDefined();
    });

    // Check search input filtering
    const searchInput = screen.getByPlaceholderText("Filter plans…");
    expect(searchInput).toBeDefined();

    fireEvent.change(searchInput, { target: { value: "Frontend" } });

    await waitFor(() => {
      expect(screen.getByText("Refactor Frontend State")).toBeDefined();
      expect(screen.queryByText("Another Database Migration Plan")).toBeNull();
      expect(screen.queryByText("Cleanup Temp Files")).toBeNull();
    });

    // Click "Active Plan" back button
    const backBtn = screen.getByRole("button", { name: "Back to active plan progress" });
    fireEvent.click(backBtn);

    // Should return to Active Plan view
    await waitFor(() => {
      expect(screen.getByText("Plan Progress")).toBeDefined();
    });
  });

  it("matches active plan automatically by cwd / worktree slug", async () => {
    const pane = {
      id: "pane-emma-1",
      title: "Emma",
      cwd: "/opt/spaceapp/var/worktrees/space/wt-muxzbyt1-c32720"
    };

    const worktreePlan: ClipboardItem = {
      ...mockPlans[1]!,
      id: "clipboard:setup1",
      title: "SpaceApp First Setup — implementation + 3-VM acceptance",
      text: "Current worktree: /opt/spaceapp/var/worktrees/space/wt-muxzbyt1-c32720",
      paneId: null,
      paneTitle: null,
      progressPercentage: 45,
      executionStatus: "IN_PROGRESS",
      steps: [
        {
          id: "step-1",
          order: 1,
          title: "Setup acceptance environment",
          status: "COMPLETED",
          progress: 100,
          agent: "Emma",
          notes: null,
          proof: null,
          startedAt: null,
          completedAt: null
        }
      ]
    };

    vi.mocked(api.clipboardItems).mockResolvedValue({
      data: [mockPlans[0]!, worktreePlan],
      pagination: {
        page: 1,
        pageSize: 100,
        totalItems: 2,
        totalPages: 1
      }
    });

    render(<CliPlansMenu pane={pane} active={true} disabled={false} onSelectPlan={vi.fn()} />);

    const button = await screen.findByRole("button", { name: /Active plan/i });
    expect(button).toBeDefined();
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText("Plan Progress")).toBeDefined();
      expect(screen.getByText("SpaceApp First Setup — implementation + 3-VM acceptance")).toBeDefined();
      expect(screen.getByText(/Setup acceptance environment/)).toBeDefined();
    });

    // A worktree-name guess is only a suggestion: nothing is written until the operator links it.
    expect(api.updatePlanProgress).not.toHaveBeenCalled();
    expect(screen.getByText("Suggested match for this pane. It is not linked yet.")).toBeDefined();
    const readsBefore = vi.mocked(api.clipboardItems).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Link to this pane" }));
    await waitFor(() => {
      expect(api.updatePlanProgress).toHaveBeenCalledExactlyOnceWith("clipboard:setup1", expect.objectContaining({ paneId: "pane-emma-1" }));
      expect(vi.mocked(api.clipboardItems).mock.calls.length).toBeGreaterThan(readsBefore);
    });
  });

  it("opens the room and pane of a plan linked to another pane and closes the menu", async () => {
    vi.mocked(api.clipboardItems).mockResolvedValue({
      data: [{ ...mockPlans[1]!, id: "clipboard:theirs", title: "Theirs", roomId: "room:ops", paneId: "pane:other", paneTitle: "Other pane" }],
      pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
    });
    render(<CliPlansMenu pane={{ id: "pane:own", title: "Own" }} active={true} disabled={false} onSelectPlan={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Open plans/i }));
    fireEvent.click(await within(screen.getByRole("list", { name: "Open plans list" })).findByText("Theirs"));
    const opened = vi.fn();
    window.addEventListener(SPACE_OPEN_PLAN_PANE_EVENT, opened);
    fireEvent.click(screen.getByRole("button", { name: "Open pane" }));
    window.removeEventListener(SPACE_OPEN_PLAN_PANE_EVENT, opened);
    expect((opened.mock.calls[0]![0] as CustomEvent).detail).toEqual({ roomId: "room:ops", paneId: "pane:other" });
    await waitFor(() => expect(screen.queryByRole("list", { name: "Open plans list" })).toBeNull());
  });

  it("marks a plan done after confirming and detaches a plan linked to this pane", async () => {
    const pane = { id: "pane:own", title: "Own" };
    vi.mocked(api.clipboardItems).mockResolvedValue({
      data: [
        { ...mockPlans[0]!, id: "clipboard:mine", title: "Mine", paneId: "pane:own", executionStatus: "IN_PROGRESS", progressPercentage: 10 },
        { ...mockPlans[1]!, id: "clipboard:theirs", title: "Theirs", roomId: "room:ops", paneId: "pane:other", paneTitle: "Other pane" }
      ],
      pagination: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 }
    });
    vi.mocked(api.rooms).mockResolvedValueOnce({
      data: [{ id: "room:ops", name: "Ops" }],
      pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
    } as any);
    render(<CliPlansMenu pane={pane} active={true} disabled={false} onSelectPlan={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Active plan: Mine/i }));
    fireEvent.click(await screen.findByRole("button", { name: /All plans/ }));
    expect(await screen.findByText("· Linked to Other pane · Room: Ops")).toBeDefined();
    expect(screen.getByText("· Linked to this pane")).toBeDefined();

    fireEvent.click(within(screen.getByRole("list", { name: "Open plans list" })).getByText("Theirs"));
    expect(screen.queryByRole("button", { name: "Detach from pane" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open pane" }).getAttribute("title")).toBe("Open Other pane");
    fireEvent.click(screen.getByRole("button", { name: "Mark done" }));
    expect(api.setClipboardItemCompleted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm done" }));
    await waitFor(() => expect(api.setClipboardItemCompleted).toHaveBeenCalledExactlyOnceWith("clipboard:theirs", true));
    // The preview closes and the list (headed by the way back to the active plan) returns.
    await waitFor(() => expect(screen.getByRole("button", { name: "Back to active plan progress" })).toBeDefined());

    fireEvent.click(within(screen.getByRole("list", { name: "Open plans list" })).getByText("Mine"));
    fireEvent.click(screen.getByRole("button", { name: "Detach from pane" }));
    await waitFor(() => expect(api.updatePlanProgress).toHaveBeenCalledWith("clipboard:mine", { paneId: null, roomId: null, paneTitle: null }));
  });

  it("keeps plans viewable without an attached CLI but holds back sending", async () => {
    const handleSelectPlan = vi.fn();
    render(<CliPlansMenu active={true} disabled={false} canSend={false} onSelectPlan={handleSelectPlan} onInsertPlan={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Open plans/i }));
    fireEvent.click(await screen.findByText("Older Plan"));
    expect(screen.getByText("Attach a running CLI to send or insert this plan.")).toBeDefined();
    expect((screen.getByRole("button", { name: "Send to CLI" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Insert without sending" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Copy plan" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("reads every page of open plans and keeps the loaded list visible when a refresh fails", async () => {
    vi.mocked(api.clipboardItems)
      .mockResolvedValueOnce({ data: [mockPlans[0]!], pagination: { page: 1, pageSize: 100, totalItems: 2, totalPages: 2 } })
      .mockResolvedValueOnce({ data: [mockPlans[1]!], pagination: { page: 2, pageSize: 100, totalItems: 2, totalPages: 2 } });
    render(<CliPlansMenu active={true} disabled={false} onSelectPlan={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Open plans/i }));
    await waitFor(() => {
      expect(screen.getByText("Older Plan")).toBeDefined();
      expect(screen.getByText("Newer Plan")).toBeDefined();
    });
    expect(api.clipboardItems).toHaveBeenCalledWith(expect.objectContaining({ page: 2 }));

    vi.mocked(api.clipboardItems).mockRejectedValue(new Error("Space API is restarting."));
    fireEvent.click(screen.getByRole("button", { name: "Refresh plans" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Space API is restarting. Showing the plans loaded before.");
    expect(screen.getByText("Older Plan")).toBeDefined();
  });

  it("labels stage completion inferred from the overall percentage as an estimate", async () => {
    const pane = { id: "pane:steps", title: "Steps" };
    vi.mocked(api.clipboardItems).mockResolvedValue({
      data: [{ ...mockPlans[0]!, id: "clipboard:md", title: "Markdown plan", paneId: "pane:steps", steps: [],
        text: "## One\n## Two\n## Three\n## Four", executionStatus: "IN_PROGRESS", progressPercentage: 50 }],
      pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
    });
    render(<CliPlansMenu pane={pane} active={true} disabled={false} onSelectPlan={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Active plan: Markdown plan/i }));
    expect(await screen.findByText("2 of 4 stages completed (estimated from overall progress)")).toBeDefined();
  });

  it("keeps plan cards as buttons inside list items and opens stage details from the keyboard", async () => {
    const pane = { id: "pane:keys", title: "Keys" };
    vi.mocked(api.clipboardItems).mockResolvedValue({
      data: [{ ...mockPlans[1]!, id: "clipboard:keys", title: "Keyboard plan", paneId: "pane:keys", executionStatus: "IN_PROGRESS", progressPercentage: 40,
        steps: [{ id: "k1", order: 1, title: "First stage", status: "IN_PROGRESS", progress: 40, agent: null, notes: "Stage notes here", proof: null, startedAt: null, completedAt: null }] as any }],
      pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
    });
    render(<CliPlansMenu pane={pane} active={true} disabled={false} onSelectPlan={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Active plan: Keyboard plan/i }));
    const stage = await screen.findByRole("button", { name: /Stage 1: First stage/ });
    expect(stage.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(stage, { key: "Enter" });
    expect(stage.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Stage notes here")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /All plans/ }));
    const item = screen.getAllByRole("listitem").find((entry) => entry.textContent?.includes("Keyboard plan"))!;
    expect(item.tagName).toBe("DIV");
    expect(within(item).getByRole("button").className).toContain("terminal-plan-item");
  });

  it("never rebinds a plan that another pane holds, even when this pane's task names it", async () => {
    const pane = { id: "pane:second", title: "Second", taskMetadata: { title: "Run plan", planId: "clipboard:held" } } as any;
    vi.mocked(api.clipboardItems).mockResolvedValue({
      data: [{ ...mockPlans[1]!, id: "clipboard:held", title: "Held plan", paneId: "pane:first", paneTitle: "First", executionStatus: "IN_PROGRESS", progressPercentage: 30 }],
      pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
    });
    render(<CliPlansMenu pane={pane} active={true} disabled={false} onSelectPlan={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Active plan: Held plan/i }));
    await waitFor(() => expect(screen.getByText("Suggested match for this pane. It is not linked yet.")).toBeDefined());
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(api.updatePlanProgress).not.toHaveBeenCalled();
  });

  it("automatically closes popover when pane is unmaximized / restored", async () => {
    const initialPane = {
      id: "pane-1",
      title: "Codex",
      isMaximized: true
    };

    const { rerender } = render(
      <CliPlansMenu pane={initialPane} active={true} disabled={false} onSelectPlan={vi.fn()} />
    );

    const button = screen.getByRole("button", { name: /Open plans/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText("Open plans")).toBeDefined();
    });

    // Pane is unmaximized / restored:
    rerender(
      <CliPlansMenu pane={{ ...initialPane, isMaximized: false }} active={true} disabled={false} onSelectPlan={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.queryByText("Open plans")).toBeNull();
    });
  });

  it("does not close popover when scrolling inside active plan progress or plans list", async () => {
    const pane = {
      id: "pane-active-1",
      paneName: "Finn"
    };

    const activePlanItem: ClipboardItem = {
      ...mockPlans[1]!,
      id: "clipboard:active1",
      title: "Scrollable Active Plan",
      paneId: "pane-active-1",
      paneTitle: "Finn",
      progressPercentage: 30,
      executionStatus: "IN_PROGRESS",
      steps: [
        {
          id: "step-1",
          order: 1,
          title: "Stage 1",
          status: "COMPLETED",
          progress: 100,
          agent: "Emma",
          notes: null,
          proof: null,
          startedAt: null,
          completedAt: null
        },
        {
          id: "step-2",
          order: 2,
          title: "Stage 2",
          status: "IN_PROGRESS",
          progress: 50,
          agent: "Emma",
          notes: null,
          proof: null,
          startedAt: null,
          completedAt: null
        }
      ]
    };

    vi.mocked(api.clipboardItems).mockResolvedValue({
      data: [activePlanItem],
      pagination: {
        page: 1,
        pageSize: 100,
        totalItems: 1,
        totalPages: 1
      }
    });

    render(<CliPlansMenu pane={pane} active={true} disabled={false} onSelectPlan={vi.fn()} />);

    const button = await screen.findByRole("button", { name: /Active plan/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Active plan progress" })).toBeDefined();
    });

    const dialog = screen.getByRole("dialog", { name: "Active plan progress" });
    const scrollBody = dialog.querySelector(".terminal-plan-active-body");
    expect(scrollBody).toBeDefined();

    // 1. Scrolling the active plan body must NOT close the popover
    fireEvent.scroll(scrollBody!);
    expect(screen.getByRole("dialog", { name: "Active plan progress" })).toBeDefined();

    // 2. Scrolling on window/document capture must NOT close the popover
    fireEvent.scroll(window);
    expect(screen.getByRole("dialog", { name: "Active plan progress" })).toBeDefined();

    // 3. Blurring with null relatedTarget (e.g. clicking non-focusable area or dragging scrollbar) must NOT close
    fireEvent.blur(dialog, { relatedTarget: null });
    expect(screen.getByRole("dialog", { name: "Active plan progress" })).toBeDefined();

    // 4. Blurring to an outside element DOES close the popover
    const outsideElement = document.createElement("button");
    document.body.appendChild(outsideElement);
    fireEvent.blur(dialog, { relatedTarget: outsideElement });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Active plan progress" })).toBeNull();
    });
    outsideElement.remove();
  });

  it("does NOT automatically match generic CLI panes or friendly names to plans mentioning the CLI name", async () => {
    const freshPane = {
      id: "pane-fresh-gemini",
      title: "Gemini CLI",
      paneName: "Andy",
      cwd: "/opt/spaceapp/var/worktrees/space/wt-fresh-123456"
    };

    const unrelatedPlan: ClipboardItem = {
      ...mockPlans[0]!,
      id: "clipboard:unrelated-plan",
      title: "Resolve Antigravity/Gemini CLI reload evidence failure",
      text: "Investigate why Gemini CLI reload evidence is failing.",
      paneId: null,
      paneTitle: null,
      progressPercentage: 0,
      executionStatus: "PLANNED"
    };

    vi.mocked(api.clipboardItems).mockResolvedValue({
      data: [unrelatedPlan],
      pagination: {
        page: 1,
        pageSize: 100,
        totalItems: 1,
        totalPages: 1
      }
    });

    render(<CliPlansMenu pane={freshPane} active={true} disabled={false} onSelectPlan={vi.fn()} />);

    // Must NOT have active plan button or active plan progress view
    await waitFor(() => {
      const button = screen.getByRole("button", { name: "Open plans (1)" });
      expect(button).toBeDefined();
      expect(button.classList.contains("is-plan-active")).toBe(false);
      expect(screen.queryByText("0%")).toBeNull();
    });
  });

  it("filters plans by status (in progress vs not in progress)", async () => {
    const plansWithStatuses: ClipboardItem[] = [
      {
        ...mockPlans[0]!,
        id: "clipboard:plan-planned-1",
        title: "Planned Task 1",
        executionStatus: "PLANNED",
        minimumModel: "gpt-5.6-sol"
      },
      {
        ...mockPlans[1]!,
        id: "clipboard:plan-inprogress-1",
        title: "In Progress Task 1",
        executionStatus: "IN_PROGRESS",
        progressPercentage: 50,
        minimumModel: "gpt-6.1-sol"
      },
      {
        ...mockPlans[0]!,
        id: "clipboard:plan-planned-2",
        title: "Planned Task 2",
        executionStatus: "PLANNED",
        minimumModel: "claude-3-7-sonnet"
      }
    ];

    vi.mocked(api.clipboardItems).mockResolvedValue({
      data: plansWithStatuses,
      pagination: {
        page: 1,
        pageSize: 100,
        totalItems: 3,
        totalPages: 1
      }
    });

    render(<CliPlansMenu active={true} disabled={false} onSelectPlan={vi.fn()} />);

    const openBtn = screen.getByRole("button", { name: /Open plans/i });
    fireEvent.click(openBtn);

    await waitFor(() => {
      expect(screen.getByText("Planned Task 1")).toBeDefined();
      expect(screen.getByText("In Progress Task 1")).toBeDefined();
      expect(screen.getByText("Planned Task 2")).toBeDefined();
    });

    // Click "In Progress" filter
    const inProgressBtn = screen.getByRole("button", { name: /In Progress \(1\)/i });
    fireEvent.click(inProgressBtn);

    await waitFor(() => {
      expect(screen.getByText("In Progress Task 1")).toBeDefined();
      expect(screen.queryByText("Planned Task 1")).toBeNull();
      expect(screen.queryByText("Planned Task 2")).toBeNull();
    });

    // Click "Not in Progress" filter
    const notInProgressBtn = screen.getByRole("button", { name: /Not in Progress \(2\)/i });
    fireEvent.click(notInProgressBtn);

    await waitFor(() => {
      expect(screen.getByText("Planned Task 1")).toBeDefined();
      expect(screen.getByText("Planned Task 2")).toBeDefined();
      expect(screen.queryByText("In Progress Task 1")).toBeNull();
    });

    // Click "All" filter to restore
    const allBtn = screen.getByRole("button", { name: /All \(3\)/i });
    fireEvent.click(allBtn);

    await waitFor(() => {
      expect(screen.getByText("Planned Task 1")).toBeDefined();
      expect(screen.getByText("In Progress Task 1")).toBeDefined();
      expect(screen.getByText("Planned Task 2")).toBeDefined();
    });
  });

  it("filters plans by multiple model selection", async () => {
    const plansWithModels: ClipboardItem[] = [
      {
        ...mockPlans[0]!,
        id: "clipboard:m1",
        title: "Model Plan GPT5",
        minimumModel: "gpt-5.6-sol",
        executionStatus: "PLANNED"
      },
      {
        ...mockPlans[1]!,
        id: "clipboard:m2",
        title: "Model Plan GPT6",
        minimumModel: "gpt-6.1-sol",
        executionStatus: "IN_PROGRESS",
        progressPercentage: 50
      },
      {
        ...mockPlans[0]!,
        id: "clipboard:m3",
        title: "Model Plan Claude",
        minimumModel: "claude-3-7-sonnet",
        executionStatus: "PLANNED"
      }
    ];

    vi.mocked(api.clipboardItems).mockResolvedValue({
      data: plansWithModels,
      pagination: {
        page: 1,
        pageSize: 100,
        totalItems: 3,
        totalPages: 1
      }
    });

    render(<CliPlansMenu active={true} disabled={false} onSelectPlan={vi.fn()} />);

    const openBtn = screen.getByRole("button", { name: /Open plans/i });
    fireEvent.click(openBtn);

    await waitFor(() => {
      expect(screen.getByText("Model Plan GPT5")).toBeDefined();
      expect(screen.getByText("Model Plan GPT6")).toBeDefined();
      expect(screen.getByText("Model Plan Claude")).toBeDefined();
    });

    // Open models dropdown
    const modelsDropdownBtn = screen.getByRole("button", { name: /Filter plans by model/i });
    fireEvent.click(modelsDropdownBtn);

    // Model filters are pill switches, never native square checkboxes.
    const modelOptions = screen.getByRole("group", { name: "Model options" });
    expect(within(modelOptions).queryAllByRole("checkbox")).toHaveLength(0);
    const gpt5Checkbox = within(modelOptions).getByRole("switch", { name: /gpt-5\.6-sol/i });
    const claudeCheckbox = within(modelOptions).getByRole("switch", { name: /claude-3-7-sonnet/i });
    expect(gpt5Checkbox.closest(".space-toggle")).not.toBeNull();
    expect((gpt5Checkbox as HTMLInputElement).checked).toBe(false);

    // Select gpt-5.6-sol only
    fireEvent.click(gpt5Checkbox);

    await waitFor(() => {
      expect(screen.getByText("Model Plan GPT5")).toBeDefined();
      expect(screen.queryByText("Model Plan GPT6")).toBeNull();
      expect(screen.queryByText("Model Plan Claude")).toBeNull();
    });

    // Now select claude-3-7-sonnet as well (Multi-select!)
    fireEvent.click(claudeCheckbox);

    await waitFor(() => {
      expect(screen.getByText("Model Plan GPT5")).toBeDefined();
      expect(screen.getByText("Model Plan Claude")).toBeDefined();
      expect(screen.queryByText("Model Plan GPT6")).toBeNull();
    });

    // Check active model chip removal
    const removeGpt5Chip = screen.getByRole("button", { name: /Remove filter for gpt-5\.6-sol/i });
    fireEvent.click(removeGpt5Chip);

    await waitFor(() => {
      expect(screen.getByText("Model Plan Claude")).toBeDefined();
      expect(screen.queryByText("Model Plan GPT5")).toBeNull();
      expect(screen.queryByText("Model Plan GPT6")).toBeNull();
    });

    // Click "Reset" on active chips
    const resetChipsBtn = screen.getByRole("button", { name: /Reset/i });
    fireEvent.click(resetChipsBtn);

    await waitFor(() => {
      expect(screen.getByText("Model Plan GPT5")).toBeDefined();
      expect(screen.getByText("Model Plan GPT6")).toBeDefined();
      expect(screen.getByText("Model Plan Claude")).toBeDefined();
    });
  });

  it("combines status filter and multi-model filter with clear all filters button", async () => {
    const plansCombo: ClipboardItem[] = [
      {
        ...mockPlans[0]!,
        id: "clipboard:c1",
        title: "Planned GPT5",
        minimumModel: "gpt-5.6-sol",
        executionStatus: "PLANNED"
      },
      {
        ...mockPlans[1]!,
        id: "clipboard:c2",
        title: "InProgress GPT5",
        minimumModel: "gpt-5.6-sol",
        executionStatus: "IN_PROGRESS",
        progressPercentage: 50
      },
      {
        ...mockPlans[1]!,
        id: "clipboard:c3",
        title: "InProgress GPT6",
        minimumModel: "gpt-6.1-sol",
        executionStatus: "IN_PROGRESS",
        progressPercentage: 50
      }
    ];

    vi.mocked(api.clipboardItems).mockResolvedValue({
      data: plansCombo,
      pagination: {
        page: 1,
        pageSize: 100,
        totalItems: 3,
        totalPages: 1
      }
    });

    render(<CliPlansMenu active={true} disabled={false} onSelectPlan={vi.fn()} />);

    const openBtn = screen.getByRole("button", { name: /Open plans/i });
    fireEvent.click(openBtn);

    await waitFor(() => {
      expect(screen.getByText("Planned GPT5")).toBeDefined();
      expect(screen.getByText("InProgress GPT5")).toBeDefined();
      expect(screen.getByText("InProgress GPT6")).toBeDefined();
    });

    // Select "In Progress"
    const inProgressBtn = screen.getByRole("button", { name: /In Progress \(2\)/i });
    fireEvent.click(inProgressBtn);

    await waitFor(() => {
      expect(screen.queryByText("Planned GPT5")).toBeNull();
      expect(screen.getByText("InProgress GPT5")).toBeDefined();
      expect(screen.getByText("InProgress GPT6")).toBeDefined();
    });

    // Select model gpt-5.6-sol
    const modelsDropdownBtn = screen.getByRole("button", { name: /Filter plans by model/i });
    fireEvent.click(modelsDropdownBtn);
    const gpt5Checkbox = screen.getByLabelText(/gpt-5\.6-sol/i);
    fireEvent.click(gpt5Checkbox);

    // Only InProgress GPT5 matches both!
    await waitFor(() => {
      expect(screen.getByText("InProgress GPT5")).toBeDefined();
      expect(screen.queryByText("InProgress GPT6")).toBeNull();
      expect(screen.queryByText("Planned GPT5")).toBeNull();
    });

    // Now select "Not in Progress"
    const notInProgressBtn = screen.getByRole("button", { name: /Not in Progress \(1\)/i });
    fireEvent.click(notInProgressBtn);

    // Only Planned GPT5 matches Not in Progress + gpt-5.6-sol
    await waitFor(() => {
      expect(screen.getByText("Planned GPT5")).toBeDefined();
      expect(screen.queryByText("InProgress GPT5")).toBeNull();
    });

    // Change model to gpt-6.1-sol (which has 0 Not in Progress plans)
    fireEvent.click(gpt5Checkbox); // uncheck gpt5
    const gpt6Checkbox = screen.getByLabelText(/gpt-6\.1-sol/i);
    fireEvent.click(gpt6Checkbox); // check gpt6

    await waitFor(() => {
      expect(screen.getByText(/No plans match the selected filters/i)).toBeDefined();
      expect(screen.getByRole("button", { name: /Clear all filters/i })).toBeDefined();
    });

    // Click "Clear all filters"
    const clearAllBtn = screen.getByRole("button", { name: /Clear all filters/i });
    fireEvent.click(clearAllBtn);

    await waitFor(() => {
      expect(screen.getByText("Planned GPT5")).toBeDefined();
      expect(screen.getByText("InProgress GPT5")).toBeDefined();
      expect(screen.getByText("InProgress GPT6")).toBeDefined();
    });
  });

  it("renders active plan steps cleanly when agent descriptor is long", async () => {
    const pane = {
      id: "pane-long-agent-1",
      paneName: "Bob",
      title: "Bob"
    };

    const longAgentPlan: ClipboardItem = {
      id: "clipboard:long-agent-plan",
      text: "Multi-stage plan with long agent text",
      source: "PLAN",
      title: "Authentic T3 Code — DeepSeek Harness Integration",
      minimumModel: "gpt-6.1-sol",
      minimumReasoning: "high",
      isCompleted: false,
      executionStatus: "IN_PROGRESS",
      progressPercentage: 7,
      activeAgent: null,
      steps: [
        {
          id: "step-1",
          order: 1,
          title: "Audit and acceptance baseline",
          status: "COMPLETED",
          progress: 100,
          agent: "Codex /root (runtime model ID unavailable)",
          notes: null,
          proof: null,
          startedAt: null,
          completedAt: null
        },
        {
          id: "step-2",
          order: 2,
          title: "Upstream pin and integration contract [gpt-6-astra / high]",
          status: "IN_PROGRESS",
          progress: 50,
          agent: "Codex /root (operator changed model; exact runtime model ID unavailable)",
          notes: null,
          proof: null,
          startedAt: null,
          completedAt: null
        }
      ],
      lastProgressAt: null,
      roomId: null,
      paneId: "pane-long-agent-1",
      paneTitle: "Bob",
      occurrenceCount: 1,
      characterCount: 50,
      createdAt: "2026-10-08T10:00:00.000Z",
      lastUsedAt: "2026-10-08T10:00:00.000Z"
    };

    vi.mocked(api.clipboardItems).mockResolvedValue({
      data: [longAgentPlan],
      pagination: {
        page: 1,
        pageSize: 100,
        totalItems: 1,
        totalPages: 1
      }
    });

    render(<CliPlansMenu pane={pane} active={true} disabled={false} onSelectPlan={vi.fn()} />);

    let button!: HTMLElement;
    await waitFor(() => {
      button = screen.getByRole("button", { name: /Active plan: Authentic T3 Code/i });
      expect(button).toBeDefined();
    });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Active plan progress" })).toBeDefined();
    });

    // Check step 1 and step 2 are rendered with titles and agent descriptors
    expect(screen.getByText("Stage 1: Audit and acceptance baseline")).toBeDefined();
    expect(screen.getByText("Codex /root (runtime model ID unavailable)")).toBeDefined();
    expect(screen.getAllByText("Stage 2: Upstream pin and integration contract [gpt-6-astra / high]")).toHaveLength(2);
    expect(screen.getByText("Codex /root (operator changed model; exact runtime model ID unavailable)")).toBeDefined();

    // Verify assigned agent title attribute is present for hover accessibility
    const agentTag = screen.getByTitle("Assigned agent/model: Codex /root (operator changed model; exact runtime model ID unavailable)");
    expect(agentTag).toBeDefined();
    expect(agentTag.className).toContain("terminal-plan-step-agent-tag");

    // Verify designated model tag is rendered for each stage
    expect(screen.getAllByText("gpt-6.1-sol · high").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTitle("Designated model for stage: gpt-6-astra · high")).toBeDefined();
  });

  it("applies is-plan-active class and self-heals pane connection when active plan matches pane task metadata", async () => {
    const pane = {
      id: "pane-andy-1",
      title: "Andy",
      paneName: "Andy",
      roomId: "room-main-1",
      taskMetadata: {
        title: "Implement the “SpaceApp First Setup — implementation + 3-VM acceptance” plan",
        description: "Implement the SpaceApp First Setup plan",
        planId: "clipboard:PeKyBmhjRaNm"
      }
    } as any;

    const firstSetupPlan: ClipboardItem = {
      id: "clipboard:PeKyBmhjRaNm",
      text: "SpaceApp First Setup implementation details...",
      source: "PLAN",
      title: "SpaceApp First Setup — implementation + 3-VM acceptance",
      minimumModel: "opencode/deepseek-v4-flash-free",
      isCompleted: false,
      executionStatus: "IN_PROGRESS",
      progressPercentage: 86,
      activeAgent: "Andy",
      steps: [
        { id: "s1", order: 1, title: "Initial audit", status: "COMPLETED", progress: 100 },
        { id: "s2", order: 2, title: "Implementation", status: "IN_PROGRESS", progress: 75 }
      ] as any,
      lastProgressAt: "2026-10-09T08:00:00.000Z",
      roomId: null,
      paneId: null,
      paneTitle: null,
      occurrenceCount: 1,
      characterCount: 200,
      createdAt: "2026-10-08T10:00:00.000Z",
      lastUsedAt: "2026-10-08T10:00:00.000Z"
    };

    vi.mocked(api.clipboardItems).mockResolvedValue({
      data: [firstSetupPlan],
      pagination: {
        page: 1,
        pageSize: 100,
        totalItems: 1,
        totalPages: 1
      }
    });

    render(<CliPlansMenu pane={pane} active={true} disabled={false} onSelectPlan={vi.fn()} />);

    let button!: HTMLElement;
    await waitFor(() => {
      button = screen.getByRole("button", { name: /Active plan: SpaceApp First Setup/i });
      expect(button).toBeDefined();
    });

    // Check that is-plan-active class is applied to button (giving it the yellow border styling)
    expect(button.className).toContain("is-plan-active");
    expect(screen.getByText("86%")).toBeDefined();

    // Check that self-healing triggered api.updatePlanProgress to persist pane connection
    await waitFor(() => {
      expect(api.updatePlanProgress).toHaveBeenCalledWith(
        "clipboard:PeKyBmhjRaNm",
        expect.objectContaining({
          paneId: "pane-andy-1",
          roomId: "room-main-1",
          paneTitle: "Andy"
        })
      );
    });
  });

  // Pane-bound completed-plan lookups (query.paneId) are separate per pane;
  // only the open-plan list is shared across menus.
  const openPlanReads = () =>
    vi.mocked(api.clipboardItems).mock.calls.filter(([query]) => !(query as { paneId?: string } | undefined)?.paneId).length;

  it("shares one plans request across menus mounted together", async () => {
    render(
      <>
        <CliPlansMenu pane={{ id: "pane:a" }} active={true} disabled={false} onSelectPlan={vi.fn()} />
        <CliPlansMenu pane={{ id: "pane:b" }} active={true} disabled={false} onSelectPlan={vi.fn()} />
        <CliPlansMenu pane={{ id: "pane:c" }} active={true} disabled={false} onSelectPlan={vi.fn()} />
      </>
    );

    await waitFor(() => expect(screen.getAllByText("2")).toHaveLength(3));
    expect(openPlanReads()).toBe(1);
  });

  it("reloads once for every mounted menu after a clipboard update and on explicit refresh", async () => {
    render(
      <>
        <CliPlansMenu pane={{ id: "pane:a" }} active={true} disabled={false} onSelectPlan={vi.fn()} />
        <CliPlansMenu pane={{ id: "pane:b" }} active={true} disabled={false} onSelectPlan={vi.fn()} />
      </>
    );
    await waitFor(() => expect(screen.getAllByText("2")).toHaveLength(2));
    expect(openPlanReads()).toBe(1);

    vi.mocked(api.clipboardItems).mockResolvedValue({
      data: [mockPlans[1]!],
      pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
    });
    notifyClipboardUpdated();
    await waitFor(() => expect(screen.getAllByText("1")).toHaveLength(2));
    expect(openPlanReads()).toBe(2);

    // The explicit refresh button bypasses the short shared cache.
    fireEvent.click(screen.getAllByRole("button", { name: /Open plans/i })[0]!);
    const refresh = await screen.findByRole("button", { name: "Refresh plans" });
    const callsBeforeRefresh = openPlanReads();
    fireEvent.click(refresh);
    await waitFor(() => expect(openPlanReads()).toBe(callsBeforeRefresh + 1));
  });

  it("keeps focus and skips reloading when the model filter opens", async () => {
    render(<CliPlansMenu active={true} disabled={false} onSelectPlan={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Open plans/i }));
    await waitFor(() => expect(screen.getByText("Newer Plan")).toBeDefined());
    const callsBeforeFilter = vi.mocked(api.clipboardItems).mock.calls.length;

    const filter = screen.getByRole("button", { name: /Filter plans by model/i });
    filter.focus();
    fireEvent.click(filter);

    expect(screen.getByLabelText(/gpt-5\.6-sol/i)).toBeDefined();
    expect(document.activeElement).toBe(filter);
    expect(api.clipboardItems).toHaveBeenCalledTimes(callsBeforeFilter);
  });

  describe("pane whose own plan is completed", () => {
    const completedHandoff: ClipboardItem = {
      ...mockPlans[2]!,
      id: "clip-plan-claude-1791636542963-1oa1",
      title: "Handoff Plan: Claude Code Multi-Account Profiles",
      paneId: "pane:bob",
      paneTitle: "Bob",
      lastUsedAt: "2026-10-10T14:26:54.000Z"
    };
    const page = (data: ClipboardItem[]) => ({
      data,
      pagination: { page: 1, pageSize: 100, totalItems: data.length, totalPages: 1 }
    });
    const mockByQuery = (completedForPane: ClipboardItem[]) => {
      vi.mocked(api.clipboardItems).mockImplementation(async (query: any = {}) =>
        query.paneId ? page(completedForPane.filter((p) => p.paneId === query.paneId)) : page(mockPlans)
      );
    };

    it("keeps showing the pane's completed plan instead of the open-plan count", async () => {
      mockByQuery([completedHandoff]);
      render(<CliPlansMenu pane={{ id: "pane:bob", title: "Bob" }} active={true} disabled={false} onSelectPlan={vi.fn()} />);

      const button = await screen.findByRole("button", { name: /Completed plan: Handoff Plan/i });
      expect(button.className).toContain("is-plan-completed");
      expect(button.className).not.toContain("is-plan-active");
      expect(screen.getByText("✓ 100%")).toBeDefined();
      expect(api.clipboardItems).toHaveBeenCalledWith(
        expect.objectContaining({ source: "PLAN", includeCompleted: true, paneId: "pane:bob" })
      );

      fireEvent.click(button);
      await waitFor(() => {
        expect(screen.getByText("Handoff Plan: Claude Code Multi-Account Profiles")).toBeDefined();
        expect(screen.getByText("COMPLETED")).toBeDefined();
      });
      // A completed plan is display-only: the pane never re-binds it.
      expect(api.updatePlanProgress).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: /All plans/i }));
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Back to completed plan progress/i })).toBeDefined();
        expect(screen.getByText(/Completed:/)).toBeDefined();
      });
    });

    it("falls back to the open-plan count when the pane never owned a plan", async () => {
      mockByQuery([completedHandoff]);
      render(<CliPlansMenu pane={{ id: "pane:dana", title: "Claude Code CLI" }} active={true} disabled={false} onSelectPlan={vi.fn()} />);

      await waitFor(() => {
        expect(api.clipboardItems).toHaveBeenCalledWith(expect.objectContaining({ paneId: "pane:dana" }));
        expect(screen.getByText("2")).toBeDefined();
      });
      expect(screen.queryByText("✓ 100%")).toBeNull();
      expect(screen.getByRole("button", { name: /Open plans/i }).className).not.toContain("is-plan-completed");
    });

    it("prefers an open plan bound to the pane over its completed one", async () => {
      const openForBob = { ...mockPlans[1]!, paneId: "pane:bob" };
      vi.mocked(api.clipboardItems).mockImplementation(async (query: any = {}) =>
        query.paneId ? page([completedHandoff]) : page([mockPlans[0]!, openForBob])
      );
      render(<CliPlansMenu pane={{ id: "pane:bob", title: "Bob" }} active={true} disabled={false} onSelectPlan={vi.fn()} />);

      await screen.findByRole("button", { name: /Active plan: Newer Plan/i });
      expect(screen.getByText("50%")).toBeDefined();
      expect(screen.queryByText("✓ 100%")).toBeNull();
      expect(api.clipboardItems).not.toHaveBeenCalledWith(expect.objectContaining({ paneId: "pane:bob" }));
    });
  });
});
