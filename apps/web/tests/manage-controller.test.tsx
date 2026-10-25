import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  restartCoreServices: vi.fn(),
  readyz: vi.fn(),
  codexEnvironment: vi.fn(),
  cliRuntimeRestartAll: vi.fn()
}));
const runtimeKind = vi.hoisted(() => ({ value: "live" as "live" | "demo" }));
vi.mock("../src/api.js", () => ({ api }));
vi.mock("../src/runtime/SpaceRuntime.js", () => ({
  DEMO_LOCAL_REPLY: "This action runs only in the local demo.",
  getSpaceRuntimeKind: () => runtimeKind.value
}));

import { useManageController, type ManageControllerContext } from "../src/features/server-actions/useManageController.js";
import { CliRuntimeRestartAllDialog, ServerRestartDialog } from "../src/features/server-actions/RestartDialogs.js";

function context(overrides: Partial<ManageControllerContext> = {}): ManageControllerContext {
  return { role: "ADMIN", onReadiness: vi.fn(), onEnvironment: vi.fn(), ...overrides };
}

const commandContext = { isCodexEnabled: true, anyCliEnabled: true, reclaimMemory: vi.fn(), openSystemAnalytics: vi.fn() };

describe("useManageController", () => {
  beforeEach(() => {
    runtimeKind.value = "live";
    for (const fn of Object.values(api)) fn.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("opens Manage from the space:manage event for admins only", () => {
    const { result, rerender } = renderHook((props: ManageControllerContext) => useManageController(props), { initialProps: context({ role: "USER" }) });
    act(() => { window.dispatchEvent(new CustomEvent("space:manage", { detail: { action: "system-services" } })); });
    expect(result.current.isServerActionsMenuOpen).toBe(false);

    rerender(context());
    act(() => { result.current.manageLoginPendingRef.current = true; result.current.setManageLoginPending(true); });
    act(() => { window.dispatchEvent(new CustomEvent("space:manage", { detail: { action: "system-services" } })); });
    expect(result.current.isServerActionsMenuOpen).toBe(true);
    expect(result.current.manageInitialAction).toBe("system-services");
    expect(result.current.manageLoginPending).toBe(false);
    expect(result.current.manageLoginPendingRef.current).toBe(false);
  });

  it("keeps the setup wizard mounted once shown and remembers a Workspace-menu host", () => {
    const { result } = renderHook(() => useManageController(context()));
    expect(result.current.setupConnectionsMounted.current).toBe(false);
    act(() => result.current.setIsSetupConnectionsOpen(true));
    expect(result.current.setupConnectionsMounted.current).toBe(true);
    act(() => result.current.setIsSetupConnectionsOpen(false));
    expect(result.current.setupConnectionsMounted.current).toBe(true);
    expect(result.current.setupFromWorkspace.current).toBe(false);
    act(() => result.current.setWorkspaceSetupHost(document.createElement("div")));
    expect(result.current.setupFromWorkspace.current).toBe(true);
  });

  it("restarts the server, reports readiness samples and the fresh environment", async () => {
    const onReadiness = vi.fn();
    const onEnvironment = vi.fn();
    api.restartCoreServices.mockResolvedValue({ apiStartedAt: "old" });
    api.readyz.mockResolvedValue({ ok: true, apiStartedAt: "new" });
    api.codexEnvironment.mockResolvedValue({ isCodexEnabled: true });
    const { result } = renderHook(() => useManageController(context({ onReadiness, onEnvironment })));

    act(() => result.current.serverRestart.open());
    expect(result.current.serverRestart.isOpen).toBe(true);
    await act(async () => { await result.current.serverRestart.confirm(); });

    expect(onReadiness).toHaveBeenCalledWith({ ok: true, apiStartedAt: "new" });
    expect(onEnvironment).toHaveBeenCalledWith({ isCodexEnabled: true });
    expect(result.current.serverRestart.message).toBe("Server restarted and ready.");
    expect(result.current.serverRestart.pending).toBe(false);
  });

  it("reports the demo reply instead of waiting for a restart in the demo runtime", async () => {
    runtimeKind.value = "demo";
    api.restartCoreServices.mockResolvedValue({ apiStartedAt: "old" });
    const { result } = renderHook(() => useManageController(context()));
    await act(async () => { await result.current.serverRestart.confirm(); });
    expect(result.current.serverRestart.message).toBe("This action runs only in the local demo.");
    expect(api.readyz).not.toHaveBeenCalled();
  });

  it("does not close a restart dialog while the restart is pending", async () => {
    let finish: (value: { apiStartedAt: string }) => void = () => undefined;
    api.restartCoreServices.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    api.readyz.mockResolvedValue({ ok: true, apiStartedAt: "new" });
    api.codexEnvironment.mockResolvedValue({});
    const { result } = renderHook(() => useManageController(context()));
    act(() => result.current.serverRestart.open());
    let confirmation: Promise<void> = Promise.resolve();
    act(() => { confirmation = result.current.serverRestart.confirm(); });
    expect(result.current.serverRestart.pending).toBe(true);
    act(() => result.current.serverRestart.close());
    expect(result.current.serverRestart.isOpen).toBe(true);
    await act(async () => { finish({ apiStartedAt: "old" }); await confirmation; });
    act(() => result.current.serverRestart.close());
    expect(result.current.serverRestart.isOpen).toBe(false);
  });

  it("summarizes a CLI restart-all and its failure", async () => {
    api.cliRuntimeRestartAll.mockResolvedValueOnce({ restartedSessionIds: ["a", "b"], failedSessionIds: ["c"], requestedRuntimes: ["cli:codex", "cli:gemini"] });
    const { result } = renderHook(() => useManageController(context()));
    await act(async () => { await result.current.cliRuntimeRestartAll.confirm(); });
    expect(result.current.cliRuntimeRestartAll.message).toBe("Restart requested: 2 sessions restarted across 2 runtimes, 1 failed.");

    api.cliRuntimeRestartAll.mockRejectedValueOnce(new Error("Pane host unavailable"));
    await act(async () => { await result.current.cliRuntimeRestartAll.confirm(); });
    expect(result.current.cliRuntimeRestartAll.message).toBeNull();
    expect(result.current.cliRuntimeRestartAll.error).toBe("Pane host unavailable");
  });

  it("dismisses restart notices automatically", async () => {
    vi.useFakeTimers();
    api.cliRuntimeRestartAll.mockResolvedValue({ restartedSessionIds: [], failedSessionIds: [], requestedRuntimes: [] });
    const { result } = renderHook(() => useManageController(context()));
    await act(async () => { await result.current.cliRuntimeRestartAll.confirm(); });
    expect(result.current.cliRuntimeRestartAll.message).not.toBeNull();
    act(() => { vi.advanceTimersByTime(6_000); });
    expect(result.current.cliRuntimeRestartAll.message).toBeNull();
  });

  it("builds the Manage commands for admins only", () => {
    const { result, rerender } = renderHook((props: ManageControllerContext) => useManageController(props), { initialProps: context({ role: "USER" }) });
    expect(result.current.buildCommands(commandContext)).toEqual([]);
    rerender(context());
    const commands = result.current.buildCommands({ ...commandContext, isCodexEnabled: false, anyCliEnabled: false });
    expect(commands.map((command) => command.id)).toEqual([
      "user-management", "setup-connections", "publish-space-release", "restart-server", "restart-all-cli-runtimes",
      "space-cli-maintenance", "codex-lb-speed-control", "cli-session-cleanup", "codex-history-purge",
      "reclaim-safe-memory", "system-analytics", "system-services", "cli-update-all"
    ]);
    const byId = new Map(commands.map((command) => [command.id, command]));
    expect(byId.get("codex-lb-speed-control")).toMatchObject({ disabled: true, title: "Enable Codex in Settings", description: "OFF · Enable Codex in Settings." });
    expect(byId.get("cli-session-cleanup")).toMatchObject({ disabled: true, title: "Enable a CLI in Settings" });

    const reclaimMemory = vi.fn();
    const openSystemAnalytics = vi.fn();
    const live = result.current.buildCommands({ ...commandContext, reclaimMemory, openSystemAnalytics });
    const anchor = document.createElement("button");
    result.current.serverActionsButtonRef.current = anchor;
    live.find((command) => command.id === "reclaim-safe-memory")!.onSelect();
    live.find((command) => command.id === "system-analytics")!.onSelect();
    expect(reclaimMemory).toHaveBeenCalledWith(anchor);
    expect(openSystemAnalytics).toHaveBeenCalledTimes(1);

    const manageEvents: Array<string | undefined> = [];
    const listener = (event: Event) => manageEvents.push((event as CustomEvent<{ action?: string }>).detail.action);
    window.addEventListener("space:manage", listener);
    live.find((command) => command.id === "publish-space-release")!.onSelect();
    window.removeEventListener("space:manage", listener);
    expect(manageEvents).toEqual(["publish-space-release"]);
    expect(result.current.adminOperationToolTriggerRef.current).toBe(anchor);
    act(() => live.find((command) => command.id === "restart-server")!.onSelect());
    expect(result.current.serverRestart.isOpen).toBe(true);
  });
});

describe("restart dialogs", () => {
  afterEach(() => cleanup());

  function controller(overrides = {}) {
    return {
      isOpen: true, pending: false, message: null, error: null,
      open: vi.fn(), close: vi.fn(), confirm: vi.fn(async () => undefined), dismissMessage: vi.fn(), dismissError: vi.fn(),
      ...overrides
    };
  }

  it("renders the server restart confirmation and closes on Escape and the backdrop", () => {
    const restart = controller({ message: "Requesting server restart..." });
    const { container } = render(<ServerRestartDialog controller={restart} />);
    const dialog = screen.getByRole("dialog", { name: "Restart Space server" });
    expect(dialog.querySelector(".server-restart-modal-icon.warning")).not.toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Requesting server restart...");
    fireEvent.click(screen.getByRole("button", { name: "Restart server" }));
    expect(restart.confirm).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.click(container.querySelector(".server-restart-modal")!);
    expect(restart.close).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss message" }));
    expect(restart.dismissMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps the CLI restart-all confirmation open on Escape while pending", () => {
    const restart = controller({ pending: true, error: "Pane host unavailable" });
    render(<CliRuntimeRestartAllDialog controller={restart} />);
    const dialog = screen.getByRole("dialog", { name: "Restart all CLI runtimes" });
    expect(dialog.querySelector(".server-restart-modal-icon.warning")).toBeNull();
    expect((screen.getByRole("button", { name: "Restarting..." }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Close Restart all CLI runtimes" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("Pane host unavailable");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(restart.close).not.toHaveBeenCalled();
  });
});
