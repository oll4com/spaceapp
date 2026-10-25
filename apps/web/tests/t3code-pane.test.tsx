import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pane, T3CodeServiceStatus } from "@space/contracts";
import { T3CodePane, t3CodeAppPath } from "../src/features/t3code-pane/T3CodePane.js";

const apiMock = vi.hoisted(() => ({
  t3CodeStatus: vi.fn(),
  t3CodeBinding: vi.fn(),
  t3CodeSaveSelection: vi.fn()
}));
const lifecycleMock = vi.hoisted(() => ({ recordLifecycleDebugEvent: vi.fn() }));
vi.mock("../src/api.js", () => ({ api: apiMock }));
vi.mock("../src/lifecycle-debug.js", () => ({ recordLifecycleDebugEvent: lifecycleMock.recordLifecycleDebugEvent }));

const generation = "75578f14-5020-4576-bfdf-0cc0831ecda4";
const selection = { environmentId: "env-real", projectId: "project-real", threadId: null, draftId: "draft-one" };

function createMockPane(overrides: Partial<Pane> = {}): Pane {
  return {
    id: "pane:t3code-1", roomId: "room:t3code-test", title: "T3 Code 1", titleSource: "auto", mode: "T3CODE", status: "IDLE",
    providerId: null, modelId: null, reasoningEffort: "medium", cwd: null, order: 0, columnSpan: 1, isMaximized: false,
    isMinimized: false, isClosed: false, split: { parentId: null, direction: null, size: null }, categoryColor: null, vncTarget: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...overrides
  } as Pane;
}

function status(state: T3CodeServiceStatus["state"]): T3CodeServiceStatus {
  return {
    version: 1, enabled: state !== "disabled", state, environmentId: state === "ready" ? "env-real" : null, workspaceAllowed: true, checkedAt: new Date().toISOString(),
    runtime: { tag: "v0.0.45", commit: "6c8fed35dded9ff71c5b46807125457acbb76be6", packageVersion: "0.0.44", integrationRevision: 4, runtimeId: "v0.0.45-space.4-40b46afa8d98feff" },
    capabilities: { paneBindings: state === "ready", selectionMessages: state === "ready", draftIsolation: state === "ready", orchestration: state === "ready", serviceControl: false }
  };
}

function post(frame: HTMLIFrameElement, data: unknown, origin = window.location.origin) {
  window.dispatchEvent(new MessageEvent("message", { data, origin, source: frame.contentWindow }));
}

describe("T3CodePane", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { cleanup(); });

  it("hosts the authentic T3 Code app for exactly this pane, without the retired supervision dashboard", async () => {
    apiMock.t3CodeStatus.mockResolvedValue(status("ready"));
    render(<T3CodePane pane={createMockPane()} />);
    const frame = await screen.findByTitle("T3 Code T3 Code 1") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(t3CodeAppPath("pane:t3code-1"));
    expect(frame.getAttribute("src")).toBe("/api/t3code/panes/pane:t3code-1/app/");
    expect(screen.queryByText(/Seed Demo/i)).toBeNull();
    expect(screen.queryByText(/^Clear$/)).toBeNull();
    expect(document.querySelector("[data-t3code-state='ready']")).not.toBeNull();
    expect(apiMock.t3CodeStatus).toHaveBeenCalledTimes(1);
  });

  it("starts loading the app together with the service check, never after it", async () => {
    let answer: (value: T3CodeServiceStatus) => void = () => {};
    apiMock.t3CodeStatus.mockReturnValue(new Promise<T3CodeServiceStatus>((resolve) => { answer = resolve; }));
    const before = Date.now();
    render(<T3CodePane pane={createMockPane()} />);
    const frame = screen.getByTitle("T3 Code T3 Code 1") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe("/api/t3code/panes/pane:t3code-1/app/");
    const host = document.querySelector("[data-t3code-pane-id='pane:t3code-1']")!;
    expect(host.getAttribute("data-t3code-state")).toBe("checking");
    expect(Number(host.getAttribute("data-t3code-requested-at"))).toBeGreaterThanOrEqual(before);
    await act(async () => { answer(status("ready")); });
    // The same frame keeps loading; it is not replaced when the check passes.
    expect(screen.getByTitle("T3 Code T3 Code 1")).toBe(frame);
  });

  it("waits for the service check before loading a pane that has its own folder", async () => {
    apiMock.t3CodeStatus.mockReturnValue(new Promise(() => {}));
    render(<T3CodePane pane={createMockPane({ cwd: "/opt/spaceapp/var/t3code/workspace/projects/own" })} />);
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByText(/Connecting to T3 Code/)).toBeTruthy();
  });

  it("shows a real unavailable state with Retry and a disabled state without a dead button", async () => {
    apiMock.t3CodeStatus.mockResolvedValueOnce(status("unavailable")).mockResolvedValueOnce(status("ready"));
    render(<T3CodePane pane={createMockPane()} />);
    expect(await screen.findByText(/not responding/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByTitle("T3 Code T3 Code 1");
    cleanup();
    apiMock.t3CodeStatus.mockResolvedValue(status("disabled"));
    render(<T3CodePane pane={createMockPane()} />);
    expect(await screen.findByText(/turned off/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("explains a pane folder outside the T3 workspace instead of booting the app", async () => {
    apiMock.t3CodeStatus.mockResolvedValue({ ...status("ready"), workspaceAllowed: false });
    render(<T3CodePane pane={createMockPane({ cwd: "/etc" })} />);
    expect(await screen.findByText(/outside the T3 Code workspace/)).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector("[data-t3code-state='workspace']")).not.toBeNull();
  });

  it("does not load the app for a minimized pane until it is shown, then keeps it mounted", async () => {
    apiMock.t3CodeStatus.mockResolvedValue(status("ready"));
    const { rerender } = render(<T3CodePane pane={createMockPane({ isMinimized: true })} />);
    await act(async () => { await Promise.resolve(); });
    expect(apiMock.t3CodeStatus).not.toHaveBeenCalled();
    expect(document.querySelector("iframe")).toBeNull();
    rerender(<T3CodePane pane={createMockPane()} />);
    await screen.findByTitle("T3 Code T3 Code 1");
    rerender(<T3CodePane pane={createMockPane({ isMinimized: true })} isVisible={false} />);
    expect(document.querySelector("iframe")).not.toBeNull();
  });

  it("persists genuine navigation only from its own frame, pane and generation", async () => {
    apiMock.t3CodeStatus.mockResolvedValue(status("ready"));
    apiMock.t3CodeBinding.mockResolvedValue({ version: 1, paneId: "pane:t3code-1", metadata: { version: 1, revision: 2, generation, lastSequence: 4, selection } });
    apiMock.t3CodeSaveSelection.mockResolvedValue({});
    render(<T3CodePane pane={createMockPane()} />);
    const frame = await screen.findByTitle("T3 Code T3 Code 1") as HTMLIFrameElement;
    const base = { version: 1, paneId: "pane:t3code-1", generation, requestId: "75578f14-5020-4576-bfdf-0cc0831ecda5" };
    const changed = { ...base, type: "selection.changed", sequence: 1, payload: { ...selection, threadId: "thread-two", draftId: null } };
    post(frame, { ...base, type: "ready", sequence: 0, payload: selection });
    // Navigation while the binding is read is buffered, not dropped.
    post(frame, changed);
    await waitFor(() => expect(apiMock.t3CodeSaveSelection).toHaveBeenCalledTimes(1));
    expect(apiMock.t3CodeSaveSelection).toHaveBeenCalledWith("pane:t3code-1", expect.objectContaining({ version: 1, generation, sequence: 5,
      selection: { ...selection, threadId: "thread-two", draftId: null } }));
    post(frame, { ...changed, sequence: 2, paneId: "pane:other-pane" });
    post(frame, { ...changed, sequence: 3 }, "https://foreign.test");
    post(frame, { ...changed, sequence: 4, generation: "75578f14-5020-4576-bfdf-0cc0831ecda6" });
    window.dispatchEvent(new MessageEvent("message", { data: { ...changed, sequence: 5 }, origin: window.location.origin, source: window }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(apiMock.t3CodeSaveSelection).toHaveBeenCalledTimes(1);
  });

  it("tells the user when another tab replaced this pane's binding", async () => {
    apiMock.t3CodeStatus.mockResolvedValue(status("ready"));
    apiMock.t3CodeBinding.mockResolvedValue({ version: 1, paneId: "pane:t3code-1", metadata: { version: 1, revision: 3, generation: "75578f14-5020-4576-bfdf-0cc0831ecda9", lastSequence: 0, selection } });
    render(<T3CodePane pane={createMockPane()} />);
    const frame = await screen.findByTitle("T3 Code T3 Code 1") as HTMLIFrameElement;
    post(frame, { version: 1, paneId: "pane:t3code-1", generation, requestId: "75578f14-5020-4576-bfdf-0cc0831ecda5", type: "ready", sequence: 0, payload: selection });
    expect(await screen.findByText(/could not save its T3 Code selection/)).toBeTruthy();
    expect(apiMock.t3CodeSaveSelection).not.toHaveBeenCalled();
  });
});
