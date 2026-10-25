// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { managedPlanExecutionSchema, type ManagedPlanExecution, type ClipboardItem, type PaneCliModelSettings } from "@space/contracts";
import { ManagedPlanClient, switchManagedStageModel, routePanePlanSelection, routePaneModelSwitch } from "../src/features/terminal-pane/managed-plan-client.js";
import { api } from "../src/api.js";
import { CliPlansMenu } from "../src/features/terminal-pane/CliPlansMenu.js";
import { CodexModelPicker } from "../src/features/codex-model-picker/CodexModelPicker.js";
import { ManagedPlanProgress } from "../src/features/terminal-pane/ManagedPlanProgress.js";
import { bridgePlanExecutionEvent } from "../src/features/terminal-pane/plan-execution-events.js";
import { useManagedPlanExecution } from "../src/features/terminal-pane/use-managed-plan-execution.js";

vi.mock("../src/api.js", () => ({ api: { clipboardItems: vi.fn(async () => ({ data: [] })), updatePlanProgress: vi.fn(async()=>({})) } }));

function execution(patch: Partial<ManagedPlanExecution> = {}): ManagedPlanExecution {
  return managedPlanExecutionSchema.parse({ id: "execution:1", ownerUserId: "user:1", planId: "plan:1", paneId: "pane:1", sessionId: "session:1", threadId: "thread:1", cwd: "/work", requestId: "request:1",
    snapshot: { title: "Managed plan", text: "Plan", stages: [1,2,3].map(n => ({ id: `stage-${n}`, order: n, title: `Work ${n}`, modelId: `model-${n}`, reasoningEffort: "high", instructions: "Do work", completionCriteria: ["Verified"] })) },
    status: "RUNNING", activeStageIndex: 0, revision: 1, overrides: {}, attempts: [], completedStageIds: [], checkpoint: null, correctionCount: 0, pendingCommand: null, interruptReason: null, nextRetryAt: null, retryCount: 0, statusReason: null, lease: null, createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z", ...patch });
}
const plan = { id: "plan:1", text: "# Stage 1: Work [model-1 / high]\nDo work\nChecks: Verified", steps: [] } as unknown as ClipboardItem;
function backend(initial = execution()) {
  let current = initial;
  return {
    panePlanExecution: vi.fn(async (): Promise<ManagedPlanExecution | null> => current), planExecution: vi.fn(async () => current),
    startPlanExecution: vi.fn(async (_pane: string, input: any) => { current = execution({ requestId: input.requestId }); return current; }),
    overridePlanExecutionStage: vi.fn(async (_id: string, stage: string, input: any, _pane: string) => { current = { ...current, revision: current.revision + 1, overrides: input.selection ? { ...current.overrides, [stage]: input.selection } : Object.fromEntries(Object.entries(current.overrides).filter(([id]) => id !== stage)) }; return current; }),
    controlPlanExecution: vi.fn(async (_id: string, input: any, _pane: string) => { current = { ...current, revision: current.revision + 1, status: input.action === "pause" ? "PAUSED" : "RESUMING_STAGE" }; return current; }),
    set(next: ManagedPlanExecution) { current = next; }
  };
}
const selection = { modelId: "model-3", reasoningEffort: "high" };
const settings: PaneCliModelSettings = { sessionId: "session:1", threadId: "thread:1", current: { modelId: "model-1", reasoningEffort: "high" }, controlMode: "DIRECT", isTurnActive: true,
  models: [1,2,3].map(n => ({ id: `model-${n}`, displayName: `Model ${n}`, isDefault: n === 1, defaultReasoningEffort: "high", supportedReasoningEfforts: ["low", "high"] })) };
afterEach(cleanup);

describe("managed plan browser client", () => {
  it("starts with exact identity and a stable idempotency key, retaining it after transport failure", async () => {
    const api = backend(); const client = new ManagedPlanClient(api, "pane:1", "session:1");
    api.startPlanExecution.mockRejectedValueOnce(new Error("Offline"));
    await expect(client.start(plan)).rejects.toThrow("Offline");
    await client.start(plan);
    expect(api.startPlanExecution.mock.calls[0]).toEqual(api.startPlanExecution.mock.calls[1]);
    expect(api.startPlanExecution.mock.calls[0]![0]).toBe("pane:1");
    expect(api.startPlanExecution.mock.calls[0]![1]).toMatchObject({ planId: "plan:1", expectedSessionId: "session:1" });
    expect(Object.keys(api.startPlanExecution.mock.calls[0]![1]).sort()).toEqual(["expectedSessionId", "planId", "requestId"]);
  });
  it("rejects incomplete preparation with explicit missing stage fields before sending", async () => {
    const api = backend(); const client = new ManagedPlanClient(api, "pane:1", "session:1");
    await expect(client.start({ ...plan, text: "# Stage 1: Work\nDo work" })).rejects.toThrow(/Complete.*Stage 1.*model/i);
    expect(api.startPlanExecution).not.toHaveBeenCalled();
  });
  it("deduplicates simultaneous starts and discovers completed state independently of PLAN lists", async () => {
    const api = backend(execution({ status: "COMPLETED", completedStageIds: ["stage-1", "stage-2", "stage-3"] }));
    const client = new ManagedPlanClient(api, "pane:1", "session:1"); await client.refresh();
    expect(client.current?.status).toBe("COMPLETED");
    await Promise.all([client.start(plan), client.start(plan)]); expect(api.startPlanExecution).toHaveBeenCalledTimes(1);
  });
  it("uses exact stage and revision for future overrides and null resets", async () => {
    const api = backend(); const client = new ManagedPlanClient(api, "pane:1", "session:1"); await client.refresh();
    await client.override("stage-3", selection); await client.override("stage-3", null);
    expect(api.overridePlanExecutionStage.mock.calls).toEqual([
      ["execution:1", "stage-3", { selection, revision: 1 }, "pane:1"], ["execution:1", "stage-3", { selection: null, revision: 2 }, "pane:1"]]);
    expect(client.current?.overrides).toEqual({});
  });
  it("refreshes a revision409 and retries the same intended stage with exact new revision", async () => {
    const api = backend(); const client = new ManagedPlanClient(api, "pane:1", "session:1"); await client.refresh();
    api.overridePlanExecutionStage.mockImplementationOnce(async () => { api.set(execution({ revision: 4 })); throw Object.assign(new Error("Execution revision is stale."), { status: 409 }); });
    await client.override("stage-1", selection);
    expect(api.planExecution).toHaveBeenCalledWith("execution:1");
    expect(api.overridePlanExecutionStage.mock.calls[1]).toEqual(["execution:1", "stage-1", { selection, revision: 4 }, "pane:1"]);
  });
  it("does not redirect a stale active-stage override to the successor", async () => {
    const api = backend(); const client = new ManagedPlanClient(api, "pane:1", "session:1"); await client.refresh();
    api.overridePlanExecutionStage.mockImplementationOnce(async () => { api.set(execution({ revision: 4, activeStageIndex: 1, completedStageIds: ["stage-1"] })); throw Object.assign(new Error("Execution revision is stale."), { status: 409 }); });
    await expect(client.override("stage-1", selection)).rejects.toThrow(/stage.*changed|completed/i);
    expect(api.overridePlanExecutionStage).toHaveBeenCalledTimes(1);
  });
  it("never retries an unavailable catalog rejection as a revision conflict", async () => {
    const api = backend(); const client = new ManagedPlanClient(api, "pane:1", "session:1"); await client.refresh();
    api.overridePlanExecutionStage.mockRejectedValue(Object.assign(new Error("The selected model and reasoning effort are not advertised by this runtime."), { status: 409 }));
    await expect(client.override("stage-1", selection)).rejects.toThrow(/not advertised/);
    expect(api.overridePlanExecutionStage).toHaveBeenCalledTimes(1);
  });
  it("pauses/resumes with current revisions and guards completed history", async () => {
    const api = backend(); const client = new ManagedPlanClient(api, "pane:1", "session:1"); await client.refresh(); await client.control("pause"); await client.control("resume");
    expect(api.controlPlanExecution.mock.calls.map(c => c[1])).toEqual([{ action: "pause", revision: 1 }, { action: "resume", revision: 2 }]);
    api.set(execution({ revision: 8, status: "COMPLETED", completedStageIds: ["stage-1", "stage-2", "stage-3"] })); await client.refresh();
    await expect(client.override("stage-1", selection)).rejects.toThrow(/completed|finished/i);
    expect(client.managed).toBe(false);
  });
  it("ignores late context responses and refuses session mismatch", async () => {
    const api = backend(); const client = new ManagedPlanClient(api, "pane:1", "session:1"); await client.refresh();
    let settle!: (e: ManagedPlanExecution) => void;
    api.overridePlanExecutionStage.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    const pending = client.override("stage-1", selection); await Promise.resolve(); client.dispose(); settle(execution({ revision: 2, overrides: { "stage-1": selection } }));
    await expect(pending).rejects.toThrow(/context.*changed/i); expect(client.current?.revision).toBe(1);
    const wrong = new ManagedPlanClient(backend(execution({ sessionId: "session:other" })), "pane:1", "session:1"); await expect(wrong.refresh()).rejects.toThrow(/session changed/); expect(wrong.managed).toBe(false);
  });
  it("returns confirmed native settings to the pane picker, never the queued override", async () => {
    const api = backend(); const client = new ManagedPlanClient(api, "pane:1", "session:1"); await client.refresh();
    const read = vi.fn(async () => settings); const result = await switchManagedStageModel(client, selection, read);
    expect(result.current).toEqual(settings.current); expect(result.current).not.toEqual(selection); expect(result.message).toMatch(/Pending native confirmation/); expect(result.pending).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("guards a picker read that outlives the selected active stage", async () => {
    const api = backend(); const client = new ManagedPlanClient(api, "pane:1", "session:1"); await client.refresh();
    const read = async () => { api.set(execution({ revision: 6, activeStageIndex: 1, completedStageIds: ["stage-1"] })); await client.refresh(); return settings; };
    await expect(switchManagedStageModel(client, selection, read)).rejects.toThrow(/stage.*changed|stage is completed/i);
  });
});

describe("managed Plan Progress", () => {
  function panel(e = execution(), catalog: PaneCliModelSettings | null = settings) {
    const onOverride = vi.fn(async () => undefined); const onControl = vi.fn(async () => undefined);
    render(<ManagedPlanProgress execution={e} settings={catalog} onOverride={onOverride} onControl={onControl} error={null} pending={false} canControl />);
    return { onOverride, onControl };
  }
  it("distinguishes planned, pending and override without calling requests Running model", () => {
    panel(execution({ overrides: { "stage-1": selection } }));
    expect(screen.getAllByText(/Planned model:/)).toHaveLength(3); expect(screen.getByText(/Stage override: model-3/)).toBeTruthy();
    expect(screen.getByText(/Running model: Pending native confirmation/)).toBeTruthy();
    expect(screen.getAllByRole("status")).toHaveLength(1); expect(screen.getByRole("status").getAttribute("aria-atomic")).toBe("true");
  });
  it("uses the per-session catalog for active and future stage choices and null reset", async () => {
    const { onOverride } = panel(execution({ overrides: { "stage-3": selection } }));
    fireEvent.click(screen.getByRole("button", { name: "Change model for stage 3" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Model for stage 3" }), { target: { value: "model-2" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Reasoning for stage 3" }), { target: { value: "low" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply model for stage 3" }));
    await waitFor(() => expect(onOverride).toHaveBeenCalledWith("stage-3", { modelId: "model-2", reasoningEffort: "low" }));
    fireEvent.click(screen.getByRole("button", { name: "Use plan model for stage 3" }));
    expect(onOverride).toHaveBeenCalledWith("stage-3", null);
  });
  it("renders immutable exact native closed-turn history with no mutable completed stage buttons", () => {
    const e = execution({ activeStageIndex: 1, completedStageIds: ["stage-1"], attempts: [{ id: "attempt:1", stageId: "stage-1", commandId: "command:1", turnId: "turn:1", modelId: "model-3", reasoningEffort: "high", status: "COMPLETED", startedAt: "2026-10-08T00:00:00Z", completedAt: "2026-10-08T00:01:00Z", result: { outcome: "COMPLETED", summary: "Verified work", evidence: [{ criterion: "Verified", result: "Test passed" }] }, actualSelection: { modelId: "model-3", reasoningEffort: "high", source: "NATIVE_ACCEPTED_TURN_CONFIGURATION", threadId: "thread:1", turnId: "turn:1", commandId: "command:1", observedAt: "2026-10-08T00:00:00Z", completedAt: "2026-10-08T00:01:00Z", transport: "CONTINUOUS_NATIVE_NOTIFICATIONS", providerTelemetry: false } }] });
    panel(e); expect(screen.queryByRole("button", { name: "Change model for stage 1" })).toBeNull();
    expect(screen.getByText(/Native accepted configuration: model-3/)).toBeTruthy(); expect(screen.getByText(/turn:1/)).toBeTruthy();
    expect(screen.queryByText(/Running model: model-3/)).toBeNull();
  });
  it.each(["SWITCHING_MODEL", "RESUMING_STAGE", "WAITING_FOR_MODEL", "WAITING_FOR_INPUT", "PAUSED", "BLOCKED"] as const)("announces contextual English %s and preserves focus", status => {
    panel(execution({ status, statusReason: "Review checkpoint", checkpoint: "Finished first check", retryCount: 2 }));
    const message = screen.getByRole("status"); expect(message.textContent).toMatch(/Stage 1.*0 of 3 stages completed/); expect(message.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByText("Review checkpoint")).toBeTruthy(); expect(screen.getByText("Finished first check")).toBeTruthy();
    const button = screen.getByRole("button", { name: status === "PAUSED" || status === "BLOCKED" ? "Resume plan" : "Pause plan" }); button.focus(); expect(document.activeElement).toBe(button);
  });
  it("disables model choices for an unavailable or wrong-session catalog", () => {
    panel(execution(), { ...settings, sessionId: "other" }); expect(screen.getByText(/Native session model catalog is unavailable/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Change model for stage 1" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("routes Pause and Resume buttons and preserves keyboard focus during server updates", async () => {
    const onControl = vi.fn(async () => undefined);
    const props = { settings, onOverride: vi.fn(async () => undefined), onControl, error: null, pending: false, canControl: true };
    const view = render(<ManagedPlanProgress {...props} execution={execution()} />);
    const pause = screen.getByRole("button", { name: "Pause plan" }); pause.focus(); fireEvent.click(pause);
    await waitFor(() => expect(onControl).toHaveBeenCalledWith("pause"));
    view.rerender(<ManagedPlanProgress {...props} execution={execution({ revision: 4, status: "PAUSED" })} />);
    const resume = screen.getByRole("button", { name: "Resume plan" });
    expect(document.activeElement).toBe(resume); fireEvent.click(resume);
    await waitFor(() => expect(onControl).toHaveBeenCalledWith("resume"));
    view.rerender(<ManagedPlanProgress {...props} execution={execution({ revision: 5, status: "WAITING_FOR_INPUT", statusReason: "Native input is required." })} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Pause plan" }));
  });
  it("keeps stage editor labels accessible and guards non-controller mutations", () => {
    const onOverride = vi.fn(async () => undefined);
    const view = render(<ManagedPlanProgress execution={execution()} settings={settings} onOverride={onOverride} onControl={vi.fn()} error={null} pending={false} canControl />);
    const change = screen.getByRole("button", { name: "Change model for stage 2" }); change.focus(); fireEvent.click(change);
    const model = screen.getByRole("combobox", { name: "Model for stage 2" }); model.focus(); expect(document.activeElement).toBe(model);
    expect(screen.getByRole("combobox", { name: "Reasoning for stage 2" })).toBeTruthy();
    view.rerender(<ManagedPlanProgress execution={execution({ revision: 3 })} settings={settings} onOverride={onOverride} onControl={vi.fn()} error={null} pending={false} canControl={false} />);
    expect((screen.getByRole("button", { name: "Apply model for stage 2" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Pause plan" }) as HTMLButtonElement).disabled).toBe(true);
    expect(view.container.querySelector('input[type="checkbox"]')).toBeNull();
  });
  it("shows preparation/control errors inline", () => {
    render(<ManagedPlanProgress execution={execution()} settings={settings} onOverride={vi.fn()} onControl={vi.fn()} error="Complete stage 2: instructions missing." pending={false} canControl />);
    expect(screen.getByRole("alert").textContent).toContain("instructions missing");
  });
});

describe("shared event updates", () => {
  it("refreshes with the panel closed; hidden panes do no work and no browser stage commands run", async () => {
    const api = backend();
    const { result, rerender } = renderHook(({ visible }) => useManagedPlanExecution({ api, paneId: "pane:1", sessionId: "session:1", enabled: visible }), { initialProps: { visible: true } });
    await waitFor(() => expect(result.current.execution?.revision).toBe(1));
    api.set(execution({ revision: 5, status: "WAITING_FOR_INPUT" }));
    act(() => bridgePlanExecutionEvent({ type: "PLAN_EXECUTION_UPDATED", paneId: "pane:1", payload: { executionId: "execution:1", revision: 5 } }));
    await waitFor(() => expect(result.current.execution?.revision).toBe(5));
    expect(api.startPlanExecution).not.toHaveBeenCalled(); expect(api.overridePlanExecutionStage).not.toHaveBeenCalled(); expect(api.controlPlanExecution).not.toHaveBeenCalled();
    rerender({ visible: false }); const calls = api.planExecution.mock.calls.length + api.panePlanExecution.mock.calls.length;
    act(() => bridgePlanExecutionEvent({ type: "PLAN_EXECUTION_UPDATED", paneId: "pane:1", payload: { executionId: "execution:1", revision: 6 } }));
    await act(async () => { await Promise.resolve(); }); expect(api.planExecution.mock.calls.length + api.panePlanExecution.mock.calls.length).toBe(calls);
  });
});

describe("pane managed integration", () => {
  it.each([true, false])("returns before legacy progress/upload/prompt on a managed start (success=%s)", async success => {
    const api = backend(); const client = new ManagedPlanClient(api, "pane:1", "session:1");
    const legacy = vi.fn();
    if (!success) api.startPlanExecution.mockRejectedValueOnce(new Error("Native control unavailable"));
    const request = routePanePlanSelection("cli:codex", () => client.start(plan), legacy);
    if (success) await request; else await expect(request).rejects.toThrow("Native control unavailable");
    expect(legacy).not.toHaveBeenCalled(); expect(api.startPlanExecution).toHaveBeenCalledTimes(1);
  });
  it.each(["cli:opencode", "cli:claude", undefined])("retains legacy selection for %s", async runtime => {
    const start = vi.fn(); const legacy = vi.fn(); await routePanePlanSelection(runtime, start, legacy);
    expect(start).not.toHaveBeenCalled(); expect(legacy).toHaveBeenCalledTimes(1);
  });
  // Plan clipboard:t_7CKCjc3C7r: Claude starts staged plans as managed executions; a plain plan keeps today's send.
  it("starts a staged plan as a managed execution on Claude and keeps the plain send for a stageless one", async () => {
    const plain = { ...plan, text: "1. Fix the voice prewarm\n2. Verify" } as ClipboardItem;
    for (const [runtime, selected, managed] of [["cli:claude", plan, true], ["cli:claude", plain, false], ["cli:codex", plain, true], ["cli:opencode", plan, false]] as const) {
      const start = vi.fn(); const legacy = vi.fn(); await routePanePlanSelection(runtime, start, legacy, selected);
      expect([start.mock.calls.length, legacy.mock.calls.length], `${runtime} ${selected.text}`).toEqual(managed ? [1, 0] : [0, 1]);
    }
  });
  it("routes the pane picker through the exact active stage, then permits ordinary settings after completion", async () => {
    const api = backend(); const client = new ManagedPlanClient(api, "pane:1", "session:1"); await client.refresh();
    const unmanaged = vi.fn(async () => ({ current: settings.current, message: null }));
    await routePaneModelSwitch(client, selection, async () => settings, unmanaged);
    expect(unmanaged).not.toHaveBeenCalled(); expect(api.overridePlanExecutionStage.mock.calls[0]?.[1]).toBe("stage-1");
    api.set(execution({ revision: 8, status: "COMPLETED", completedStageIds: ["stage-1", "stage-2", "stage-3"] })); await client.refresh();
    await routePaneModelSwitch(client, selection, async () => settings, unmanaged); expect(unmanaged).toHaveBeenCalledTimes(1);
  });
  it("preserves fixed proof selectors and recent completed history absent from the open PLAN list", async () => {
    const e = execution({ status: "COMPLETED", completedStageIds: ["stage-1", "stage-2", "stage-3"] });
    const view = render(<CliPlansMenu active pane={{ id: "pane:1" }} onSelectPlan={vi.fn()} managedExecution={e} managedSettings={settings} />);
    fireEvent.click(view.container.querySelector(".terminal-plans-button")!);
    const dialog = await screen.findByRole("dialog", { name: "Active plan progress" });
    expect(dialog.classList.contains("terminal-plans-popover")).toBe(true);
    expect(within(dialog).getByText("Managed plan")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Pause plan" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Active plan progress" })).toBeNull();
  });
  it("keeps the picker on actual settings with a pending response, including no current confirmation", async () => {
    const onSwitch = vi.fn(async () => ({ current: settings.current, message: "Stage override queued. Pending native confirmation", pending: true }));
    const view = render(<CodexModelPicker compact settings={settings} onSwitch={onSwitch} />);
    fireEvent.click(screen.getByRole("button", { name: /Change model and reasoning/ }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "model-3" } });
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Pending native confirmation/));
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("model-1");
    view.unmount();
    render(<CodexModelPicker compact allowSelectionWithoutCurrent settings={{ ...settings, current: null }} onSwitch={async () => ({ current: null, message: "Pending native confirmation", pending: true })} />);
    fireEvent.click(screen.getByRole("button", { name: "Select model and reasoning" }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "model-3" } });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Pending native confirmation"));
    expect(screen.getByRole("button", { name: "Select model and reasoning" })).toBeTruthy();
  });
  it("keeps only the latest rapid stage choice across a revision conflict", async () => {
    const api = backend(); const client = new ManagedPlanClient(api, "pane:1", "session:1"); await client.refresh();
    let reject!: (error: unknown) => void;
    api.overridePlanExecutionStage.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const first = client.override("stage-1", { modelId: "model-2", reasoningEffort: "high" });
    const observedFirst = first.catch(error => error); await Promise.resolve(); await Promise.resolve();
    const latest = client.override("stage-1", selection); api.set(execution({ revision: 4 }));
    reject(Object.assign(new Error("Execution revision is stale."), { status: 409 }));
    await observedFirst; await latest;
    expect(api.overridePlanExecutionStage).toHaveBeenCalledTimes(2);
    expect(api.overridePlanExecutionStage.mock.calls[1]?.[2]).toEqual({ selection, revision: 4 });
    expect(client.current?.overrides["stage-1"]).toEqual(selection);
  });
  it("coalesces event refreshes and prevents old revision responses from replacing current state", async () => {
    const api = backend(); const client = new ManagedPlanClient(api, "pane:1", "session:1"); await client.refresh();
    let settle!: (e: ManagedPlanExecution) => void;
    api.planExecution.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    const first = client.refresh("execution:1"); const second = client.refresh("execution:1"); const third = client.refresh("execution:1");
    api.set(execution({ revision: 9 })); settle(execution({ revision: 2 }));
    await Promise.all([first, second, third]); expect(api.planExecution).toHaveBeenCalledTimes(2); expect(client.current?.revision).toBe(9);
    api.set(execution({ revision: 3 })); await client.refresh("execution:1"); expect(client.current?.revision).toBe(9);
  });
});

describe("managed picker context fences", () => {
  it("does not let a late empty discovery erase a successful start", async () => {
    const api = backend(); const client = new ManagedPlanClient(api, "pane:1", "session:1");
    let settle!: (value: null) => void;
    api.panePlanExecution.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    const discovery = client.refresh(); await client.start(plan); settle(null); await discovery;
    expect(client.current?.id).toBe("execution:1"); expect(client.managed).toBe(true);
  });

  it("allows the current native settings to become an explicit stage override", async () => {
    const onSwitch = vi.fn(async () => ({ current: settings.current, message: "Pending native confirmation", pending: true }));
    render(<CodexModelPicker compact settings={settings} selectionScope="stage-2" onSwitch={onSwitch} />);
    fireEvent.click(screen.getByRole("button", { name: /Change model and reasoning/ }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "model-1" } });
    await waitFor(() => expect(onSwitch).toHaveBeenCalledExactlyOnceWith("model-1", "high", null));
  });

  it("keeps an uncertain start idempotency key across pane hide/return", async () => {
    const api = backend(); const first = new ManagedPlanClient(api, "pane:stable", "session:stable");
    api.startPlanExecution.mockRejectedValueOnce(new Error("Offline"));
    await expect(first.start(plan)).rejects.toThrow("Offline"); first.dispose();
    api.startPlanExecution.mockRejectedValueOnce(new Error("Offline"));
    await expect(new ManagedPlanClient(api, "pane:stable", "session:stable").start(plan)).rejects.toThrow("Offline");
    expect(api.startPlanExecution.mock.calls[0]).toEqual(api.startPlanExecution.mock.calls[1]);
  });
  it("never sends a queued click to the successor stage or confirms its stale response", async () => {
    let settle!: (value: { current: PaneCliModelSettings["current"]; message: string | null; pending: boolean }) => void;
    const onSwitch = vi.fn(() => new Promise<{ current: PaneCliModelSettings["current"]; message: string | null; pending: boolean }>(resolve => { settle = resolve; }));
    const view = render(<CodexModelPicker compact settings={settings} selectionScope="stage-1" onSwitch={onSwitch} />);
    fireEvent.click(screen.getByRole("button", { name: /Change model and reasoning/ }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "model-2" } });
    await waitFor(() => expect(onSwitch).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "model-3" } });
    view.rerender(<CodexModelPicker compact settings={settings} selectionScope="stage-2" onSwitch={onSwitch} />);
    await act(async () => { settle({ current: selection, message: "Pending native confirmation", pending: true }); });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/stage.*changed/i));
    expect(onSwitch).toHaveBeenCalledTimes(1); expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("model-1");
  });
});

describe("Stage4 review races", () => {
  it("drains the final COMPLETED invalidation arriving during the catch-up read without later activity", async () => {
    const api = backend(); const client = new ManagedPlanClient(api, "pane:1", "session:1"); await client.refresh();
    let first!: (record: ManagedPlanExecution) => void, second!: (record: ManagedPlanExecution) => void;
    api.planExecution.mockImplementationOnce(() => new Promise(resolve => { first = resolve; }));
    api.planExecution.mockImplementationOnce(() => new Promise(resolve => { second = resolve; }));
    const initial = client.refresh("execution:1"), catchUp = client.refresh("execution:1");
    first(execution({ revision: 2 }));
    await waitFor(() => expect(api.planExecution).toHaveBeenCalledTimes(2));
    api.set(execution({ revision: 4, status: "COMPLETED", completedStageIds: ["stage-1", "stage-2", "stage-3"] }));
    const finalEvent = client.refresh("execution:1");
    second(execution({ revision: 3 }));
    await Promise.all([initial, catchUp, finalEvent]);
    expect(api.planExecution).toHaveBeenCalledTimes(3);
    expect(client.current?.revision).toBe(4); expect(client.current?.status).toBe("COMPLETED");
    expect(api.startPlanExecution).not.toHaveBeenCalled(); expect(api.overridePlanExecutionStage).not.toHaveBeenCalled();
  });
  it("does not drain a retained invalidation after the visible pane context is disposed", async () => {
    const api = backend(); const client = new ManagedPlanClient(api, "pane:1", "session:1"); await client.refresh();
    let first!: (record: ManagedPlanExecution) => void, second!: (record: ManagedPlanExecution) => void;
    api.planExecution.mockImplementationOnce(() => new Promise(resolve => { first = resolve; }));
    api.planExecution.mockImplementationOnce(() => new Promise(resolve => { second = resolve; }));
    const initial = client.refresh("execution:1"), catchUp = client.refresh("execution:1");
    first(execution({ revision: 2 })); await waitFor(() => expect(api.planExecution).toHaveBeenCalledTimes(2));
    const finalEvent = client.refresh("execution:1"); client.dispose(); second(execution({ revision: 3 }));
    await Promise.all([initial, catchUp, finalEvent]);
    expect(api.planExecution).toHaveBeenCalledTimes(2); expect(client.current?.revision).toBe(2);
  });
  it("retains catch-up work while hidden and drains it only on visible refresh", async () => {
    const api = backend(); let visible = true;
    const client = new ManagedPlanClient(api, "pane:1", "session:1", () => {}, () => visible); await client.refresh();
    let first!: (record: ManagedPlanExecution) => void, second!: (record: ManagedPlanExecution) => void;
    api.planExecution.mockImplementationOnce(() => new Promise(resolve => { first = resolve; }));
    api.planExecution.mockImplementationOnce(() => new Promise(resolve => { second = resolve; }));
    const initial = client.refresh("execution:1"), catchUp = client.refresh("execution:1");
    first(execution({ revision: 2 })); await waitFor(() => expect(api.planExecution).toHaveBeenCalledTimes(2));
    const finalEvent = client.refresh("execution:1"); visible = false;
    api.set(execution({ revision: 4, status: "COMPLETED" })); second(execution({ revision: 3 }));
    await Promise.all([initial, catchUp, finalEvent]); expect(api.planExecution).toHaveBeenCalledTimes(2);
    await client.refresh("execution:1"); expect(api.planExecution).toHaveBeenCalledTimes(2);
    visible = true; await client.refresh("execution:1"); expect(client.current?.status).toBe("COMPLETED");
  });
  it("rejects an unbound picker click when delayed discovery finds an advanced managed stage; only a new click may PATCH", async () => {
    const api = backend(); const client = new ManagedPlanClient(api, "pane:1", "session:1");
    let discover!: (record: ManagedPlanExecution) => void;
    api.panePlanExecution.mockImplementationOnce(() => new Promise(resolve => { discover = resolve; }));
    const unmanaged = vi.fn(async () => ({ current: settings.current, message: null }));
    const read = vi.fn(async () => settings);
    const discovery = client.refresh();
    const click = routePaneModelSwitch(client, selection, read, unmanaged);
    const guardedClick = expect(click).rejects.toThrow(/discovered.*select.*again/i);
    const advanced = execution({ revision: 4, activeStageIndex: 1, completedStageIds: ["stage-1"] });
    api.set(advanced); discover(advanced);
    await discovery; await guardedClick;
    expect(api.overridePlanExecutionStage).not.toHaveBeenCalled(); expect(unmanaged).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
    // A queued click retains its original unbound scope even if discovery finished before dispatch.
    await expect(routePaneModelSwitch(client, selection, read, unmanaged, null)).rejects.toThrow(/discovered.*select.*again/i);
    expect(api.overridePlanExecutionStage).not.toHaveBeenCalled();
    await routePaneModelSwitch(client, selection, read, unmanaged);
    expect(api.overridePlanExecutionStage).toHaveBeenCalledExactlyOnceWith("execution:1", "stage-2", { selection, revision: 4 }, "pane:1");
  });
  it("retains the ordinary picker callback when unbound discovery finds no managed execution", async () => {
    const api = backend(); api.panePlanExecution.mockResolvedValue(null);
    const client = new ManagedPlanClient(api, "pane:1", "session:1");
    const unmanaged = vi.fn(async () => ({ current: settings.current, message: null }));
    await routePaneModelSwitch(client, selection, async () => settings, unmanaged);
    expect(unmanaged).toHaveBeenCalledTimes(1); expect(api.overridePlanExecutionStage).not.toHaveBeenCalled();
  });
});

it.each([true, false])("does not rebind an already bound PLAN through legacy progress (managed discovered: %s)", async discovered => {
  localStorage.removeItem("space_active_plan_pane:1");
  vi.mocked(api.updatePlanProgress).mockClear();
  vi.mocked(api.clipboardItems).mockResolvedValueOnce({data:[{...plan,source:"PLAN",title:"Managed plan",paneId:"pane:1",paneTitle:null,executionStatus:"IN_PROGRESS",isCompleted:false,progressPercentage:0,createdAt:"2026-10-08T00:00:00Z"}],pagination:{page:1,pageSize:100,totalItems:1,totalPages:1}} as any);
  render(<CliPlansMenu active pane={{id:"pane:1",title:"Changed title"}} onSelectPlan={vi.fn()} managedExecution={discovered ? execution() : null} />);
  await waitFor(()=>expect(localStorage.getItem("space_active_plan_pane:1")).toBe("plan:1"));
  expect(api.updatePlanProgress).not.toHaveBeenCalled();
});
