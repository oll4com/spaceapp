import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, AgentRuntimeRegistry } from "@space/contracts";
import {
  CLI_LAUNCHER_MENU_ID,
  CliLauncherMenu
} from "../src/features/cli-launcher/CliLauncherMenu.js";
import { CLI_RUNTIME_VISIBILITY_EVENT } from "../src/cli-runtime-visibility-events.js";

const defaultCliRuntimes = vi.hoisted(() => vi.fn<() => Promise<AgentRuntimeRegistry>>());
const cliRuntimesSnapshot = vi.hoisted(() => vi.fn<() => AgentRuntimeRegistry | null>());
const invalidateCliRuntimes = vi.hoisted(() => vi.fn());

vi.mock("../src/api.js", () => ({
  api: {
    cliRuntimes: defaultCliRuntimes,
    cliRuntimesSnapshot,
    invalidateCliRuntimes
  }
}));

const checkedAt = "2026-07-18T00:00:00.000Z";

function runtime(
  id: string,
  displayName: string,
  options: {
    adapterStatus?: AgentRuntime["adapterStatus"];
    authMode?: AgentRuntime["authMode"];
    authState?: AgentRuntime["authState"];
    canStartLogin?: boolean;
    capabilities?: AgentRuntime["capabilities"];
    status?: AgentRuntime["status"];
    statusReason?: string;
  } = {}
): AgentRuntime {
  return {
    id,
    providerId: id.replace(/^cli:/, ""),
    providerName: displayName,
    agentId: id.replace(/^cli:/, ""),
    agentName: displayName,
    displayName,
    capabilities: options.capabilities ?? ["CLI"],
    adapterStatus: options.adapterStatus ?? "ENABLED",
    authMode: options.authMode ?? "NONE",
    authState: options.authState ?? "READY",
    authReason: options.statusReason ?? `${displayName} is ready.`,
    canStartLogin: options.canStartLogin ?? false,
    status: options.status ?? "ENABLED",
    statusReason: options.statusReason ?? `${displayName} is ready.`,
    commandName: id.startsWith("cli:") ? id.replace(/^cli:/, "") : null,
    detectedCommandPath: id.startsWith("cli:") ? `/opt/spaceapp/bin/${id.replace(/^cli:/, "")}` : null,
    defaultModelId: null,
    supportedReasoningEfforts: [],
    checkedAt
  };
}

const orderedRegistry: AgentRuntimeRegistry = {
  data: [
    runtime("cli:kimi", "Kimi Code CLI"),
    runtime("cli:grok", "Grok Build CLI"),
    runtime("cli:qwen", "Qwen Code CLI", {
      status: "NOT_CONNECTED",
      authMode: "API_KEY",
      authState: "SETUP_REQUIRED",
      canStartLogin: true,
      statusReason: "Qwen Code provider setup is required. Open its terminal and use the official /auth menu."
    }),
    runtime("web:codex-app-server", "Codex Web Chat", { capabilities: ["WEB_CHAT"] }),
    runtime("cli:root", "CLI ROOT"),
    runtime("cli:opencode", "OpenCode CLI", {
      adapterStatus: "ERROR",
      authState: "UNAVAILABLE",
      status: "ERROR",
      statusReason: "OpenCode wrapper is not executable on this host."
    }),
    runtime("cli:autohand", "Autohand Code CLI", {
      status: "NOT_CONNECTED",
      authMode: "API_KEY",
      authState: "SETUP_REQUIRED",
      canStartLogin: true,
      statusReason: "Autohand account and OpenRouter API key setup are required."
    }),
    runtime("cli:codex", "Codex CLI"),
    runtime("cli:claude", "Claude Code CLI"),
    runtime("cli:gemini", "Gemini CLI", {
      status: "ENABLED",
      authMode: "NONE",
      authState: "READY",
      canStartLogin: false,
      statusReason: "Authentication is handled natively by Antigravity."
    }),
    runtime("cli:deepseek", "DeepSeek CLI", {
      status: "NOT_CONNECTED",
      authMode: "API_KEY",
      authState: "SETUP_REQUIRED",
      canStartLogin: true,
      statusReason: "DeepSeek API key setup is required."
    }),
    runtime("cli:cursor", "Cursor CLI", {
      status: "NOT_CONNECTED",
      authMode: "BROWSER_OAUTH",
      authState: "LOGIN_REQUIRED",
      canStartLogin: true,
      statusReason: "Cursor CLI OAuth login is required."
    }),
    runtime("cli:copilot", "GitHub Copilot CLI", {
      status: "NOT_CONNECTED",
      authMode: "DEVICE_CODE",
      authState: "LOGIN_REQUIRED",
      canStartLogin: true,
      statusReason: "GitHub Copilot CLI login is required."
    })
  ],
  checkedAt
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function Harness({
  atPaneCap = false,
  isCodexEnabled = true,
  loadRuntimes,
  mobile = false,
  onCreate = async () => undefined,
  onLogin = async () => undefined,
  onOpenSettings,
  refreshOnOpen
}: {
  atPaneCap?: boolean;
  isCodexEnabled?: boolean;
  loadRuntimes?: () => Promise<AgentRuntimeRegistry>;
  mobile?: boolean;
  onCreate?: (selectedRuntime: AgentRuntime) => Promise<void>;
  onLogin?: (selectedRuntime: AgentRuntime) => Promise<void>;
  onOpenSettings?: () => void;
  refreshOnOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <div>
      <button
        ref={triggerRef}
        type="button"
        aria-controls={CLI_LAUNCHER_MENU_ID}
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        Add CLI pane
      </button>
      {open ? (
        <CliLauncherMenu
          atPaneCap={atPaneCap}
          isCodexEnabled={isCodexEnabled}
          loadRuntimes={loadRuntimes}
          mobile={mobile}
          onClose={() => setOpen(false)}
          onCreate={onCreate}
          onLogin={onLogin}
          onOpenSettings={onOpenSettings}
          triggerRef={triggerRef}
          refreshOnOpen={refreshOnOpen}
        />
      ) : null}
      <button type="button">Outside target</button>
    </div>
  );
}

beforeEach(() => {
  defaultCliRuntimes.mockReset();
  cliRuntimesSnapshot.mockReset().mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CliLauncherMenu", () => {
  it("uses the available desktop viewport before introducing a scrollbar", () => {
    const styles = readFileSync("src/styles.css", "utf8");
    const menuRule = styles.match(/\.cli-launcher-menu\.icon-overflow-menu\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(menuRule).toContain("max-height: calc(100dvh - 1rem)");
    expect(menuRule).not.toContain("min(34rem");
  });

  it("loads the default runtime registry once without entering a render loop", async () => {
    defaultCliRuntimes.mockResolvedValue(orderedRegistry);

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Add CLI pane" }));

    expect(await screen.findByRole("menuitem", { name: "Add Codex CLI" })).toBeTruthy();
    await waitFor(() => expect(defaultCliRuntimes).toHaveBeenCalledTimes(1));
    expect(defaultCliRuntimes).toHaveBeenCalledWith();
  });

  it("renders the last-known runtime snapshot within 100 ms while fresh discovery stays in the background", () => {
    const freshDiscovery = deferred<AgentRuntimeRegistry>();
    cliRuntimesSnapshot.mockReturnValue(orderedRegistry);
    defaultCliRuntimes.mockReturnValue(freshDiscovery.promise);

    // The snapshot path renders synchronously: the options are there right after the call, with
    // no loading text (a regression to waiting on discovery fails those checks at any speed).
    // The time bound is a jsdom bound, not the browser's 100 ms target: in full runs with four
    // workers on the shared VM the best of three renders took 109-121 ms (2026-10-13).
    const jsdomRenderBudgetMs = 250;
    let best = Number.POSITIVE_INFINITY;
    let attempts = 0;
    while (attempts < 3 && best >= jsdomRenderBudgetMs) {
      cleanup();
      attempts += 1;
      render(<Harness />);
      const startedAt = performance.now();
      fireEvent.click(screen.getByRole("button", { name: "Add CLI pane" }));
      expect(document.querySelector('[role="menuitem"][aria-label="Add Codex CLI"]')).toBeTruthy();
      best = Math.min(best, performance.now() - startedAt);
      expect(screen.queryByText("Loading CLI runtimes…")).toBeNull();
    }
    expect(best).toBeLessThan(jsdomRenderBudgetMs);
    expect(defaultCliRuntimes).toHaveBeenCalledTimes(attempts);
  });

  it("does not refresh runtimes on open when refreshOnOpen is false and snapshot is pre-cached", () => {
    cliRuntimesSnapshot.mockReturnValue(orderedRegistry);

    render(<Harness refreshOnOpen={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Add CLI pane" }));

    expect(document.querySelector('[role="menuitem"][aria-label="Add Codex CLI"]')).toBeTruthy();
    expect(screen.queryByText("Loading CLI runtimes…")).toBeNull();
    expect(defaultCliRuntimes).not.toHaveBeenCalled();
  });

  it("orders only non-root CLI runtimes, uses official brand icons, exposes real disabled reasons, and restores desktop focus", async () => {
    render(<Harness loadRuntimes={async () => orderedRegistry} />);
    const trigger = screen.getByRole("button", { name: "Add CLI pane" });
    fireEvent.click(trigger);

    const menu = await screen.findByRole("menu", { name: "Add CLI pane" });
    const options = within(menu).getAllByRole("menuitem");
    expect(options.map((option) => option.getAttribute("aria-label"))).toEqual([
      "Add OpenCode CLI",
      "Add Codex CLI",
      "Add Claude Code CLI",
      "Add Gemini CLI",
      "Setup Autohand Code CLI",
      "Setup Qwen Code CLI",
      "Add Kimi Code CLI",
      "Add Grok Build CLI",
      "Setup DeepSeek CLI",
      "Login Cursor CLI",
      "Login GitHub Copilot CLI"
    ]);
    expect(menu.querySelectorAll(".cli-launcher-option img[data-terminal-runtime-brand]")).toHaveLength(11);
    expect(menu.querySelectorAll(".cli-launcher-option .lucide-terminal")).toHaveLength(0);
    expect(within(menu).queryByText("CLI ROOT")).toBeNull();
    expect(within(menu).queryByText("Codex Web Chat")).toBeNull();

    const openCode = within(menu).getByRole("menuitem", { name: "Add OpenCode CLI" });
    expect(openCode).toHaveProperty("disabled", true);
    const disabledReason = within(openCode).getByText("OpenCode wrapper is not executable on this host.");
    expect(disabledReason).toBeTruthy();
    expect(openCode.getAttribute("aria-describedby")).toBe(disabledReason.id);

    const codex = within(menu).getByRole("menuitem", { name: "Add Codex CLI" });
    const claude = within(menu).getByRole("menuitem", { name: "Add Claude Code CLI" });
    const gemini = within(menu).getByRole("menuitem", { name: "Add Gemini CLI" });
    const autohand = within(menu).getByRole("menuitem", { name: "Setup Autohand Code CLI" });
    const qwen = within(menu).getByRole("menuitem", { name: "Setup Qwen Code CLI" });
    const copilot = within(menu).getByRole("menuitem", { name: "Login GitHub Copilot CLI" });
    expect(gemini).toHaveProperty("disabled", false);
    expect(autohand).toHaveProperty("disabled", false);
    expect(qwen).toHaveProperty("disabled", false);
    expect(within(gemini).queryByText("Available")).toBeNull();
    expect(gemini.querySelector(".cli-launcher-status")).toBeNull();
    expect(within(autohand).getByText("Setup")).toBeTruthy();
    expect(within(qwen).getByText("Setup")).toBeTruthy();
    expect(within(openCode).getByText("Error")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(codex));
    fireEvent.keyDown(codex, { key: "ArrowDown" });
    expect(document.activeElement).toBe(claude);
    fireEvent.keyDown(claude, { key: "End" });
    expect(document.activeElement).toBe(copilot);
    fireEvent.keyDown(copilot, { key: "Home" });
    expect(document.activeElement).toBe(codex);
    fireEvent.keyDown(codex, { key: "Escape" });

    expect(screen.queryByRole("menu", { name: "Add CLI pane" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("opens Gemini as a normal native-authenticated CLI pane", async () => {
    const creation = deferred<void>();
    const onCreate = vi.fn(() => creation.promise);
    render(<Harness loadRuntimes={async () => orderedRegistry} onCreate={onCreate} />);
    fireEvent.click(screen.getByRole("button", { name: "Add CLI pane" }));
    const gemini = await screen.findByRole("menuitem", { name: "Add Gemini CLI" });

    fireEvent.click(gemini);
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ id: "cli:gemini", authMode: "NONE" }));
    expect((await screen.findByRole("status")).textContent).toContain("Creating Gemini CLI");
    await act(async () => creation.resolve());
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Add CLI pane" })).toBeNull());
  });

  it("opens the fixed Qwen /auth setup flow from the Setup row", async () => {
    const login = deferred<void>();
    const onLogin = vi.fn(() => login.promise);
    render(<Harness loadRuntimes={async () => orderedRegistry} onLogin={onLogin} />);
    fireEvent.click(screen.getByRole("button", { name: "Add CLI pane" }));
    const qwen = await screen.findByRole("menuitem", { name: "Setup Qwen Code CLI" });

    fireEvent.click(qwen);
    expect(onLogin).toHaveBeenCalledWith(expect.objectContaining({ id: "cli:qwen", authState: "SETUP_REQUIRED" }));
    expect((await screen.findByRole("status")).textContent).toContain("Opening Qwen Code CLI setup");
    await act(async () => login.resolve());
  });

  it("keeps login retry available at the pane cap while disabling new normal panes", async () => {
    const onCreate = vi.fn(async () => undefined);
    const onLogin = vi.fn(async () => undefined);
    render(
      <Harness
        atPaneCap
        loadRuntimes={async () => orderedRegistry}
        onCreate={onCreate}
        onLogin={onLogin}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Add CLI pane" }));

    const codex = await screen.findByRole("menuitem", { name: "Add Codex CLI" });
    const gemini = screen.getByRole("menuitem", { name: "Add Gemini CLI" });
    expect(codex).toHaveProperty("disabled", true);
    expect(gemini).toHaveProperty("disabled", true);

    fireEvent.click(gemini);
    expect(onLogin).not.toHaveBeenCalled();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("renders a mobile bottom sheet with a trapped focus loop and outside dismissal", async () => {
    render(<Harness loadRuntimes={async () => orderedRegistry} mobile />);
    const trigger = screen.getByRole("button", { name: "Add CLI pane" });
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Add CLI pane" });
    const codex = within(dialog).getByRole("button", { name: "Add Codex CLI" });
    const copilot = within(dialog).getByRole("button", { name: "Login GitHub Copilot CLI" });
    const close = within(dialog).getByRole("button", { name: "Close Add CLI pane" });
    await waitFor(() => expect(document.activeElement).toBe(codex));

    copilot.focus();
    fireEvent.keyDown(copilot, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(copilot);

    fireEvent.click(dialog.parentElement as HTMLElement);
    expect(screen.queryByRole("dialog", { name: "Add CLI pane" })).toBeNull();
    expect(document.activeElement).toBe(trigger);

  });

  it("shows bounded loading, empty, and retry states", async () => {
    const firstLoad = deferred<AgentRuntimeRegistry>();
    const loadRuntimes = vi
      .fn<() => Promise<AgentRuntimeRegistry>>()
      .mockImplementationOnce(() => firstLoad.promise)
      .mockRejectedValueOnce(new Error("Runtime registry is temporarily unavailable."))
      .mockResolvedValueOnce(orderedRegistry);

    const first = render(<Harness loadRuntimes={loadRuntimes} />);
    fireEvent.click(screen.getByRole("button", { name: "Add CLI pane" }));
    expect((await screen.findByRole("status")).textContent).toContain("Loading CLI runtimes");
    expect(screen.queryByRole("menuitem")).toBeNull();
    await act(async () => firstLoad.resolve({ data: [], checkedAt }));
    expect(await screen.findByText("All CLI runtimes are disabled.")).toBeTruthy();
    first.unmount();

    render(<Harness loadRuntimes={loadRuntimes} />);
    fireEvent.click(screen.getByRole("button", { name: "Add CLI pane" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Runtime registry is temporarily unavailable.");
    fireEvent.click(screen.getByRole("button", { name: "Retry CLI runtimes" }));
    expect(await screen.findByRole("menuitem", { name: "Add Codex CLI" })).toBeTruthy();
    expect(loadRuntimes).toHaveBeenCalledTimes(3);
  });

  it("removes a disabled runtime immediately, refreshes the registry, and links the all-disabled state to Settings", async () => {
    let currentRegistry: AgentRuntimeRegistry = {
      data: [runtime("cli:deepseek", "DeepSeek CLI")],
      checkedAt
    };
    const loadRuntimes = vi.fn(async () => currentRegistry);
    const onOpenSettings = vi.fn();
    render(<Harness loadRuntimes={loadRuntimes} onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByRole("button", { name: "Add CLI pane" }));
    expect(await screen.findByRole("menuitem", { name: "Add DeepSeek CLI" })).toBeTruthy();

    currentRegistry = { data: [], checkedAt };
    act(() => {
      window.dispatchEvent(new CustomEvent(CLI_RUNTIME_VISIBILITY_EVENT, {
        detail: { runtimeId: "cli:deepseek", enabled: false, source: "settings-card" }
      }));
    });
    expect(await screen.findByText("All CLI runtimes are disabled.")).toBeTruthy();
    await waitFor(() => expect(loadRuntimes).toHaveBeenCalledTimes(2));
    expect(invalidateCliRuntimes).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu", { name: "Add CLI pane" })).toBeNull();
  });

  it("keeps Codex visible but OFF while other CLI runtimes remain usable", async () => {
    const onCreate = vi.fn(async () => undefined);
    render(<Harness isCodexEnabled={false} loadRuntimes={async () => orderedRegistry} onCreate={onCreate} />);
    fireEvent.click(screen.getByRole("button", { name: "Add CLI pane" }));

    const codex = await screen.findByRole("menuitem", { name: "Add Codex CLI" });
    const claude = screen.getByRole("menuitem", { name: "Add Claude Code CLI" });
    expect(codex).toHaveProperty("disabled", true);
    expect(codex.getAttribute("title")).toBe("Enable Codex in Settings");
    expect(within(codex).getByText("OFF")).toBeTruthy();
    expect(claude).toHaveProperty("disabled", false);

    fireEvent.click(codex);
    expect(onCreate).not.toHaveBeenCalled();
    fireEvent.click(claude);
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ id: "cli:claude" })));
  });

  it("embeds searchable direct choices without taking search focus and keeps login available at the pane cap", async () => {
    const onLogin = vi.fn(async () => undefined);
    const onClose = vi.fn();
    render(<><input aria-label="Find a tool" autoFocus /><CliLauncherMenu embedded query="cursor" mobile={false}
      atPaneCap loadRuntimes={async () => orderedRegistry} triggerRef={{ current: null }}
      onCreate={vi.fn()} onLogin={onLogin} onClose={onClose} /></>);
    const cursor = await screen.findByRole("button", { name: "Login Cursor CLI" });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Find a tool" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add Codex CLI" })).toBeNull();
    expect(cursor).toHaveProperty("disabled", false);
    fireEvent.click(cursor);
    await waitFor(() => expect(onLogin).toHaveBeenCalledWith(expect.objectContaining({ id: "cli:cursor" })));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("keeps creation pending visible and prevents duplicate pane requests", async () => {
    const creation = deferred<void>();
    const onCreate = vi.fn(() => creation.promise);
    render(<Harness loadRuntimes={async () => orderedRegistry} onCreate={onCreate} />);
    fireEvent.click(screen.getByRole("button", { name: "Add CLI pane" }));
    const kimi = await screen.findByRole("menuitem", { name: "Add Kimi Code CLI" });

    fireEvent.click(kimi);
    fireEvent.click(kimi);
    expect(onCreate).toHaveBeenCalledTimes(1);
    await act(async () => creation.resolve());
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Add CLI pane" })).toBeNull());
  });

  it("safely reorders runtimes via pointer events without native HTML5 drag and persists to localStorage", async () => {
    render(<Harness loadRuntimes={async () => orderedRegistry} />);
    fireEvent.click(screen.getByRole("button", { name: "Add CLI pane" }));

    const codex = await screen.findByRole("menuitem", { name: "Add Codex CLI" });
    const claude = await screen.findByRole("menuitem", { name: "Add Claude Code CLI" });

    // Mock document.elementFromPoint to point to Claude when dragged over
    const originalElementFromPoint = document.elementFromPoint;
    document.elementFromPoint = vi.fn().mockImplementation((x, y) => claude);

    // Pointer down on Codex
    fireEvent.pointerDown(codex, { clientX: 100, clientY: 100, button: 0 });
    // Move pointer beyond 6px threshold over Claude
    fireEvent.pointerMove(window, { clientX: 100, clientY: 140 });
    // Release pointer to drop
    fireEvent.pointerUp(window, { clientX: 100, clientY: 140 });

    document.elementFromPoint = originalElementFromPoint;

    const savedOrder = JSON.parse(window.localStorage.getItem("space:create-menu-cli-order") || "[]");
    expect(savedOrder.indexOf("cli:codex")).toBeGreaterThanOrEqual(0);
    expect(savedOrder.indexOf("cli:claude")).toBeGreaterThanOrEqual(0);
    expect(savedOrder.indexOf("cli:codex")).toBe(savedOrder.indexOf("cli:claude") + 1);
  });

  it("renders a count stepper next to CLI tools header and creates multiple panes when count > 1", async () => {
    const onCreate = vi.fn(async () => undefined);
    const onClose = vi.fn();
    render(
      <CliLauncherMenu
        embedded
        mobile={false}
        loadRuntimes={async () => orderedRegistry}
        triggerRef={{ current: null }}
        onCreate={onCreate}
        onLogin={vi.fn()}
        onClose={onClose}
      />
    );

    expect(await screen.findByText("CLI tools")).toBeTruthy();
    const minusBtn = screen.getByRole("button", { name: "Decrease pane count" });
    const plusBtn = screen.getByRole("button", { name: "Increase pane count" });
    const stepper = screen.getByRole("spinbutton", { name: "Panes count to open" });

    // Initial state: count 1, minus disabled
    expect(screen.getByText("1")).toBeTruthy();
    expect(minusBtn).toHaveProperty("disabled", true);
    expect(plusBtn).toHaveProperty("disabled", false);

    // Click plus twice -> count becomes 3
    fireEvent.click(plusBtn);
    expect(screen.getByText("2")).toBeTruthy();
    expect(minusBtn).toHaveProperty("disabled", false);

    fireEvent.click(plusBtn);
    expect(screen.getByText("3")).toBeTruthy();

    // Wheel event test on stepper
    fireEvent.wheel(stepper, { deltaY: -100 }); // scroll up -> 4
    expect(screen.getByText("4")).toBeTruthy();

    fireEvent.wheel(stepper, { deltaY: 100 }); // scroll down -> 3
    expect(screen.getByText("3")).toBeTruthy();

    // Click Claude CLI to open 3 panes
    const claude = await screen.findByRole("button", { name: "Add Claude Code CLI" });
    fireEvent.click(claude);

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ id: "cli:claude" }), 3);
    });
    // Resets back to 1
    expect(screen.getByText("1")).toBeTruthy();
  });

  it("bounds stepper by availablePanes when fewer than 6 panes are available in the room", async () => {
    const onCreate = vi.fn(async () => undefined);
    render(
      <CliLauncherMenu
        embedded
        mobile={false}
        availablePanes={2}
        loadRuntimes={async () => orderedRegistry}
        triggerRef={{ current: null }}
        onCreate={onCreate}
        onLogin={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(await screen.findByText("CLI tools")).toBeTruthy();
    const minusBtn = screen.getByRole("button", { name: "Decrease pane count" });
    const plusBtn = screen.getByRole("button", { name: "Increase pane count" });
    const stepper = screen.getByRole("spinbutton", { name: "Panes count to open" });

    // Initial state: count 1, minus disabled, plus enabled
    expect(screen.getByText("1")).toBeTruthy();
    expect(minusBtn).toHaveProperty("disabled", true);
    expect(plusBtn).toHaveProperty("disabled", false);

    // Increase to 2 -> reaches max (2)
    fireEvent.click(plusBtn);
    expect(screen.getByText("2")).toBeTruthy();
    expect(minusBtn).toHaveProperty("disabled", false);
    expect(plusBtn).toHaveProperty("disabled", true);

    // Clicking plus or wheel up cannot exceed availablePanes (2)
    fireEvent.click(plusBtn);
    expect(screen.getByText("2")).toBeTruthy();
    fireEvent.wheel(stepper, { deltaY: -100 });
    expect(screen.getByText("2")).toBeTruthy();

    // Click Claude CLI to open 2 panes
    const claude = await screen.findByRole("button", { name: "Add Claude Code CLI" });
    fireEvent.click(claude);

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ id: "cli:claude" }), 2);
    });
  });

  it("shows count 0 with disabled stepper and marks options Full when room has 0 available panes", async () => {
    render(
      <CliLauncherMenu
        embedded
        mobile={false}
        availablePanes={0}
        loadRuntimes={async () => orderedRegistry}
        triggerRef={{ current: null }}
        onCreate={vi.fn()}
        onLogin={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(await screen.findByText("CLI tools")).toBeTruthy();
    const minusBtn = screen.getByRole("button", { name: "Decrease pane count" });
    const plusBtn = screen.getByRole("button", { name: "Increase pane count" });
    const stepper = screen.getByRole("spinbutton", { name: "Panes count to open" });

    // Count is 0, both buttons disabled
    expect(screen.getByText("0")).toBeTruthy();
    expect(minusBtn).toHaveProperty("disabled", true);
    expect(plusBtn).toHaveProperty("disabled", true);
    expect(stepper).toHaveProperty("title", "Room is full (0 available panes)");

    // Normal launchable runtimes are marked Full and disabled
    const gemini = await screen.findByRole("button", { name: "Add Gemini CLI" });
    expect(gemini).toHaveProperty("disabled", true);
    expect(gemini.textContent).toContain("Full");
  });
});

