import { workspaceAction } from "./workspace-navigation.js";
import { act, configure, fireEvent, getConfig, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cliToggleRuntimeIds, pickNextAvailableRoomName } from "@space/contracts";
import { DemoSpaceApp } from "../src/demo/DemoSpaceApp.js";
import { DEMO_LOCAL_REPLY, DEMO_WARNING } from "../src/demo/DemoStore.js";
import { demoRuntimeBundle } from "../src/demo/demo-runtime.js";

vi.mock("../src/features/terminal-pane/index.js", () => ({
  createTerminalBootstrapBarrier: () => ({
    join: () => ({ arrive: async () => undefined }),
    waitForTerminalSetupTask: async () => undefined
  }),
  TerminalPane: ({ pane }: { pane: { title: string } }) => (
    <section aria-label={`CLI pane ${pane.title}`}>Local demo terminal fixture</section>
  )
}));

vi.mock("../src/features/memory-workspace/DesktopMemoryGraph.js", () => ({
  default: ({
    nodes,
    edges,
    onSelectNode
  }: {
    nodes: Array<{ id: string; label: string }>;
    edges: unknown[];
    onSelectNode: (nodeId: string) => void;
  }) => (
    <section aria-label="Interactive memory map">
      {nodes.length} local nodes · {edges.length} local relationships
      {nodes.map((node) => <button key={node.id} type="button" onClick={() => onSelectNode(node.id)}>Open memory node {node.label}</button>)}
    </section>
  )
}));

function expectIdentifiedFormControls(container: HTMLElement) {
  const unidentified = Array.from(container.querySelectorAll("input, select, textarea"))
    .filter((control) => !control.id && !control.getAttribute("name"))
    .map((control) => control.getAttribute("aria-label") ?? control.tagName.toLocaleLowerCase());
  expect(unidentified).toEqual([]);
}

// The demo renders the full shared App shell with lazily loaded surfaces, so
// allow for slow first renders when the suite runs alongside other work.
vi.setConfig({ testTimeout: 120_000 });

async function openWorkspaceMenu() {
  const navigation = await screen.findByRole("navigation", { name: "Workspace navigation" });
  const open = screen.queryByRole("dialog", { name: "Workspace" });
  if (open) fireEvent.click(within(open).getByRole("button", { name: "Close menu" }));
  fireEvent.click(within(navigation).getByRole("button", { name: "Workspace" }));
  return screen.findByRole("dialog", { name: "Workspace" });
}

async function openWorkspaceTab(tab: string) {
  const workspace = await openWorkspaceMenu();
  fireEvent.click(within(workspace).getByRole("tab", { name: tab }));
  return workspace;
}

async function openWorkspaceDock(dock: string | RegExp) {
  const workspace = await openWorkspaceTab("Docks");
  fireEvent.click(await within(workspace).findByRole("button", { name: dock }));
  return workspace;
}

async function openManageAction(group: string, action: string) {
  await enableAdminMode();
  const workspace = await openWorkspaceTab("Utilities");
  fireEvent.click(within(workspace).getByRole("button", { name: "Manage" }));
  const manage = await screen.findByRole("dialog", { name: "Manage" });
  fireEvent.click(within(manage).getByRole("button", { name: group }));
  fireEvent.click(await within(manage).findByRole("button", { name: action }));
  return manage;
}

async function runCollapsedRailTool(tool: string) {
  fireEvent.click(await screen.findByRole("button", { name: "Hide room toolbar" }));
  fireEvent.click(await screen.findByRole("button", { name: "Workspace tools" }));
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Workspace tools" })).getByRole("button", { name: tool }));
}

async function openRailDock(dock: string | RegExp) {
  fireEvent.click(await screen.findByRole("button", { name: "Hide room toolbar" }));
  fireEvent.click(await screen.findByRole("button", { name: "Show docks" }));
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Docks" })).getByRole("button", { name: dock }));
}

// Admin-only tools (Manage, installation settings, metric actions) need Admin mode on desktop.
async function enableAdminMode() {
  const navigation = await screen.findByRole("navigation", { name: "Workspace navigation" });
  const adminMode = within(navigation).getByRole("button", { name: "Admin mode" });
  if (adminMode.getAttribute("aria-pressed") !== "true") fireEvent.click(adminMode);
  await waitFor(() => expect(adminMode.getAttribute("aria-pressed")).toBe("true"));
}

// Chat transcripts render their own <main>, and the auth bootstrap renders one
// before the shell, so pick the Space shell explicitly.
async function findAppShell() {
  let shell: HTMLElement | undefined;
  await waitFor(() => {
    shell = screen.getAllByRole("main").find((main) => main.classList.contains("space-shell"));
    expect(shell).toBeTruthy();
  });
  return shell!;
}

async function openResourcesView(view: string) {
  const workspace = await openWorkspaceMenu();
  fireEvent.click(within(workspace).getByRole("button", { name: "Resources" }));
  const resources = await screen.findByRole("dialog", { name: "Resources" });
  fireEvent.click(within(resources).getByRole("button", { name: /^System/ }));
  fireEvent.change(await within(resources).findByRole("combobox", { name: "Resource view" }), { target: { value: view } });
  return resources;
}

describe("Space public demo app", () => {
  let previousAsyncUtilTimeout: number;
  let previousUrl: string;
  const viewportDescriptors = {
    innerWidth: Object.getOwnPropertyDescriptor(window, "innerWidth"),
    innerHeight: Object.getOwnPropertyDescriptor(window, "innerHeight")
  };
  beforeAll(() => {
    previousAsyncUtilTimeout = getConfig().asyncUtilTimeout;
    configure({ asyncUtilTimeout: 30_000 });
    // The demo is only served under /demoappnew/ (vite.mock.config.ts). The shared App schedules
    // a native T3 Code bundle prefetch for ADMIN users 8 s after the first render unless the page
    // is under that path, so rendering the demo at "/" lets that timer fire a real fetch inside
    // whichever later test is running, including the no-native-transport assertions.
    previousUrl = window.location.pathname + window.location.search + window.location.hash;
    window.history.replaceState({}, "", "/demoappnew/");
  });
  afterAll(() => {
    configure({ asyncUtilTimeout: previousAsyncUtilTimeout });
    window.history.replaceState({}, "", previousUrl);
  });

  afterEach(() => {
    demoRuntimeBundle.runtime.reset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    // Tests resize the window without restoring it; later tests must not inherit that viewport.
    for (const [key, descriptor] of Object.entries(viewportDescriptors)) {
      if (descriptor) Object.defineProperty(window, key, descriptor);
      else Reflect.deleteProperty(window, key);
    }
  });

  it("keeps demo CLI VPN settings contract-complete and direct", async () => {
    const response = await demoRuntimeBundle.runtime.api.cliRuntimeSettings();

    expect(response.vpnSupported).toBe(true);
    expect(response.vpnConnection?.status).toBe("NOT_CONFIGURED");
    expect(response.settings).toHaveLength(16);
    expect(response.settings.map((setting) => setting.runtimeId)).toEqual([...cliToggleRuntimeIds]);
    expect(response.settings.every((setting) => setting.vpnEnabled === false)).toBe(true);
    expect(response.vpnApplications).toHaveLength(16);
    expect(response.vpnApplications.map((application) => application.runtimeId)).toEqual([...cliToggleRuntimeIds]);
    expect(response.vpnApplications.every((application) => application.effectiveMode === "DIRECT")).toBe(true);
  });

  it("creates one selected empty room, keeps the compact Rooms drawer open, and quick-adds one pane", async () => {
    const previousInnerWidth = window.innerWidth;
    const previousInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1024 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 900 });
    try {
      const existingRooms = await demoRuntimeBundle.runtime.api.rooms();
      const expectedName = pickNextAvailableRoomName(existingRooms.data.map((room) => room.name));

      render(<DemoSpaceApp />);
      fireEvent.click(await screen.findByRole("button", { name: "Open rooms" }));
      const drawer = await screen.findByRole("dialog", { name: "Rooms" });
      const newRoomButton = within(drawer).getByRole("button", { name: "New room" });

      expect(within(drawer).queryByTitle("Create 2-pane room")).toBeNull();
      expect(within(drawer).queryByTitle("Create 16-pane room")).toBeNull();
      fireEvent.click(newRoomButton);
      fireEvent.click(newRoomButton);

      const roomButton = await within(drawer).findByRole("button", { name: `Open ${expectedName}` });
      expect(roomButton.querySelector(".room-cli-badge")?.textContent).toBe("Panes 0");
      expect(within(roomButton).queryByText(/(?:Pane target|Select for panes|16 cap)/)).toBeNull();
      expect(await within(drawer).findByText(`Add panes to ${expectedName}`)).toBeTruthy();
      expect(screen.getByRole("dialog", { name: "Rooms" })).toBeTruthy();
      // Add panes re-collapses in a passive effect when its target room changes. Flush that effect
      // first; otherwise it can run after the Expand click and collapse the composer again.
      await act(async () => {});
      fireEvent.click(within(drawer).getByRole("button", { name: /^Add panes to /, expanded: false }));
      fireEvent.click(await within(drawer).findByRole("button", { name: "Increase Codex panes" }));
      const apply = within(drawer).getByRole("button", { name: "Add 1 pane" });
      expect(apply).toHaveProperty("disabled", false);
      fireEvent.click(apply);

      const roomsAfter = await demoRuntimeBundle.runtime.api.rooms();
      expect(roomsAfter.data).toHaveLength(existingRooms.data.length + 1);
      await waitFor(async () => {
        const createdPanes = (await demoRuntimeBundle.runtime.api.panes(roomsAfter.data.at(-1)!.id)).data;
        expect(createdPanes).toHaveLength(1);
        expect(createdPanes[0]?.terminalRuntimeId).toBe("cli:codex");
      });
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: previousInnerWidth });
      Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: previousInnerHeight });
    }
  });

  it("keeps DeepSeek text-only controls honest while preserving history, stop, copy, and reconnect", async () => {
    const rooms = await demoRuntimeBundle.runtime.api.rooms();
    const targetRoom = rooms.data[0]!;
    const created = await demoRuntimeBundle.runtime.api.createRoomPanes(targetRoom.id, {
      panes: [{ mode: "TERMINAL", terminalRuntimeId: "cli:deepseek" }]
    });
    const deepseekPane = created.data[0]!;

    render(<DemoSpaceApp />);
    const terminal = await screen.findByLabelText(`CLI pane ${deepseekPane.title}`);
    const card = terminal.closest("article") as HTMLElement;
    expect(card).toBeTruthy();
    expect(within(card).queryByLabelText(`Import files ${deepseekPane.title}`)).toBeNull();
    expect(within(card).queryByLabelText(`Enable Plan mode ${deepseekPane.title}`)).toBeNull();
    expect(within(card).queryByLabelText(`Resume ${deepseekPane.title}`)).toBeNull();
    expect(within(card).queryByLabelText(`Stop ${deepseekPane.title}`)).toBeNull();
    expect(within(card).queryByLabelText(`Copy CLI contents ${deepseekPane.title}`)).toBeNull();
    expect(within(card).queryByLabelText(`Reconnect CLI ${deepseekPane.title}`)).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: `More pane actions ${deepseekPane.title}` }));
    const sheet = await screen.findByRole("menu", { name: `Pane actions ${deepseekPane.title}` });
    expect(within(sheet).getByRole("menuitem", { name: `Resume ${deepseekPane.title}` })).toBeTruthy();
    expect(within(sheet).getByRole("menuitem", { name: `Stop ${deepseekPane.title}` })).toBeTruthy();
    expect(within(sheet).getByRole("menuitem", { name: `Copy CLI contents ${deepseekPane.title}` })).toBeTruthy();
    expect(within(sheet).getByRole("menuitem", { name: `Reconnect CLI ${deepseekPane.title}` })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu", { name: `Pane actions ${deepseekPane.title}` })).toBeNull());
  });

  it("renders the shared workspace without native network transports", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1365 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 900 });
    const fetchSpy = vi.fn(async () => { throw new TypeError("Native fetch is forbidden in demo tests."); });
    const eventSourceSpy = vi.fn(() => { throw new TypeError("Native EventSource is forbidden in demo tests."); });
    const webSocketSpy = vi.fn(() => { throw new TypeError("Native WebSocket is forbidden in demo tests."); });
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("EventSource", eventSourceSpy);
    vi.stubGlobal("WebSocket", webSocketSpy);

    render(<DemoSpaceApp />);

    expect(await screen.findByText(DEMO_WARNING)).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Launch Control" })).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(eventSourceSpy).not.toHaveBeenCalled();
    expect(webSocketSpy).not.toHaveBeenCalled();
  });

  it("supports local sign-out/sign-in without native network transports", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1365 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 900 });
    const fetchSpy = vi.fn(async () => { throw new TypeError("Native fetch is forbidden in demo tests."); });
    const eventSourceSpy = vi.fn(() => { throw new TypeError("Native EventSource is forbidden in demo tests."); });
    const webSocketSpy = vi.fn(() => { throw new TypeError("Native WebSocket is forbidden in demo tests."); });
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("EventSource", eventSourceSpy);
    vi.stubGlobal("WebSocket", webSocketSpy);
    render(<DemoSpaceApp />);
    expect(await screen.findByText(DEMO_WARNING)).toBeTruthy();

    // Sign out lives in the Workspace menu footer, outside every category tab.
    fireEvent.click(within(await openWorkspaceMenu()).getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("Sign in to Space")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "demo@spaceapp.dev" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "local-demo" } });
    fireEvent.click(screen.getByRole("button", { name: "Enter" }));

    await waitFor(() => expect(screen.getByText(DEMO_WARNING)).toBeTruthy());
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(eventSourceSpy).not.toHaveBeenCalled();
    expect(webSocketSpy).not.toHaveBeenCalled();
  });

  it("writes settings only to demo memory and restores the Graphite fixture after reset", async () => {
    const previousNativeTheme = window.localStorage.getItem("space.room.theme");
    const nativeThemeSentinel = "native-theme-must-not-change";
    window.localStorage.setItem("space.room.theme", nativeThemeSentinel);
    demoRuntimeBundle.runtime.reset();

    try {
      const firstRender = render(<DemoSpaceApp />);
      const firstShell = await findAppShell();
      await waitFor(() => expect(firstShell.getAttribute("data-room-theme")).toBe("graphite"));

      const roomTab = await openWorkspaceTab("Room");
      fireEvent.click(within(await within(roomTab).findByRole("group", { name: "Room settings" })).getByRole("button", { name: "Room theme" }));
      fireEvent.click(within(await screen.findByRole("menu", { name: "Room theme options" })).getByRole("menuitemradio", { name: "Forest" }));

      await waitFor(() => expect(firstShell.getAttribute("data-room-theme")).toBe("forest"));
      expect(demoRuntimeBundle.runtime.platform.localStorage.getItem("space.room.theme")).toBe("forest");
      expect(window.localStorage.getItem("space.room.theme")).toBe(nativeThemeSentinel);

      firstRender.unmount();
      demoRuntimeBundle.runtime.reset();
      render(<DemoSpaceApp />);

      const resetShell = await findAppShell();
      await waitFor(() => expect(resetShell.getAttribute("data-room-theme")).toBe("graphite"));
      expect(demoRuntimeBundle.runtime.platform.localStorage.getItem("space.room.theme")).toBe("graphite");
      expect(window.localStorage.getItem("space.room.theme")).toBe(nativeThemeSentinel);
    } finally {
      if (previousNativeTheme === null) window.localStorage.removeItem("space.room.theme");
      else window.localStorage.setItem("space.room.theme", previousNativeTheme);
    }
  });

  it("blocks screen capture from the embedded desktop demo tool", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1365 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 900 });
    const nativePrint = vi.spyOn(window, "print").mockImplementation(() => undefined);
    const nativeDisplayCapture = vi.fn(async () => { throw new DOMException("Native capture must stay unused.", "NotAllowedError"); });
    const priorMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia: nativeDisplayCapture }
    });

    try {
      render(<DemoSpaceApp />);
      // The "Print window" toolbar action was removed in 6fa32d43da; the native print
      // dialog must still never be reached.
      // The Workspace Clip Tool opens the embedded Snip Tool, whose capture is blocked.
      fireEvent.click(await workspaceAction("Clip Tool", "Utilities"));
      // The Snip Tool chunk is lazy-loaded inside the Workspace detail view (the
      // suite-wide 30s lookup wait covers it); its compact capsule (9aea89bc6f)
      // captures the full screen from its own button.
      const snipTool = await screen.findByRole("region", { name: "Snip Tool" });
      fireEvent.click(within(snipTool).getByRole("button", { name: /^Capture full screen/ }));
      expect(await screen.findByText("Screen capture is disabled in demo mode.")).toBeTruthy();

      // The collapsed-rail Clip Tool reports the local demo reply instead of capturing.
      await runCollapsedRailTool("Clip Tool");
      // Notices keep their text in a span beside a dismiss button (fec28ab249).
      expect((await screen.findByText(DEMO_LOCAL_REPLY, { selector: '[role="status"] span' })).closest('[role="status"]')?.textContent).toContain(DEMO_LOCAL_REPLY);
      expect(nativePrint).not.toHaveBeenCalled();
      expect(nativeDisplayCapture).not.toHaveBeenCalled();
    } finally {
      if (priorMediaDevices) Object.defineProperty(navigator, "mediaDevices", priorMediaDevices);
      else Reflect.deleteProperty(navigator, "mediaDevices");
    }
  }, 20_000);

  it("copies Chat content locally and shows the exact demo disclosure", async () => {
    const priorClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const priorExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
    const nativeWriteText = vi.fn(async () => undefined);
    const execCommand = vi.fn(() => true);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: nativeWriteText } });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });

    try {
      await demoRuntimeBundle.runtime.api.sendAgentMessage("pane:demo-chat", "Review the public launch workspace.");
      render(<DemoSpaceApp />);
      const chat = await screen.findByRole("article", { name: "Product Copilot agent 1" });
      await act(async () => { await vi.dynamicImportSettled(); });
      await within(chat).findByText("Review the public launch workspace.");
      fireEvent.click(await screen.findByRole("button", { name: "More pane actions Product Copilot" }));
      fireEvent.click(within(await screen.findByRole("menu", { name: "Pane actions Product Copilot" })).getByRole("menuitem", { name: "Copy Chat contents Product Copilot" }));

      const disclosure = await screen.findByText(DEMO_LOCAL_REPLY, { selector: ".codex-notification span" });
      expect(disclosure.closest('[role="status"]')).toBeTruthy();
      expect(nativeWriteText).not.toHaveBeenCalled();
      expect(execCommand).not.toHaveBeenCalled();
    } finally {
      if (priorClipboard) Object.defineProperty(navigator, "clipboard", priorClipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
      if (priorExecCommand) Object.defineProperty(document, "execCommand", priorExecCommand);
      else Reflect.deleteProperty(document, "execCommand");
    }
  });

  it("blocks native screen capture from the embedded tablet demo tool", async () => {
    const priorInnerWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
    const priorInnerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
    const nativeImagePicker = vi.spyOn(HTMLInputElement.prototype, "click");
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 834 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 1112 });

    try {
      render(<DemoSpaceApp />);
      fireEvent.click(await workspaceAction("Clip Tool", "Utilities"));
      // The Snip Tool chunk is lazy-loaded inside the Workspace detail view (the
      // suite-wide 30s lookup wait covers it); its compact capsule (9aea89bc6f)
      // captures the full screen from its own button.
      const snipTool = await screen.findByRole("region", { name: "Snip Tool" });
      fireEvent.click(within(snipTool).getByRole("button", { name: /^Capture full screen/ }));

      expect(await screen.findByText("Screen capture is disabled in demo mode.")).toBeTruthy();
      await screen.findByRole("region", { name: "Pane board" });
      expect(screen.getByText("Screen capture is disabled in demo mode.")).toBeTruthy();

      await runCollapsedRailTool("Clip Tool");

      expect(await screen.findByText(DEMO_LOCAL_REPLY, { selector: '[role="status"] span' })).toBeTruthy();
      await screen.findByRole("region", { name: "Pane board" });
      expect(screen.getByText(DEMO_LOCAL_REPLY, { selector: '[role="status"] span' })).toBeTruthy();
      expect(nativeImagePicker).not.toHaveBeenCalled();
    } finally {
      if (priorInnerWidth) Object.defineProperty(window, "innerWidth", priorInnerWidth);
      if (priorInnerHeight) Object.defineProperty(window, "innerHeight", priorInnerHeight);
    }
  }, 20_000);

  it("opens shared Resources with contract-valid local service readiness", async () => {
    render(<DemoSpaceApp />);

    // Health is part of the unified Resources window for admins (ecc0af72fb).
    await enableAdminMode();
    const resources = await openResourcesView("services");

    expect(await within(resources).findByRole("heading", { name: "Services & infrastructure" })).toBeTruthy();
    const serviceCard = (name: string) => within(resources).getByRole("heading", { name }).closest("article") as HTMLElement;
    await waitFor(() => expect(serviceCard("Storage readiness").textContent).toContain("Healthy"));
    expect(serviceCard("Storage readiness").textContent).toContain("Demo service readiness");
    expect(serviceCard("Storage readiness").classList.contains("is-healthy")).toBe(true);
    await waitFor(() => expect(serviceCard("Version").textContent).toContain("v0.1.0"));
    expect(await within(resources).findByRole("heading", { name: "Space API" })).toBeTruthy();
  });

  it("keeps every currently reachable production pane mode on the shared pane renderer", async () => {
    // Room switching uses the desktop Rooms rail; the jsdom default 1024px width is a tablet shell.
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1365 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 900 });
    render(<DemoSpaceApp />);

    for (const title of ["Release Review", "Launch Swarm", "Design Notes"]) {
      expect(await screen.findByText(title)).toBeTruthy();
    }

    fireEvent.click(screen.getByRole("button", { name: "Open Research Lab" }));

    expect(await screen.findByText("Research Code")).toBeTruthy();
    expect(screen.getAllByText("No turns yet").length).toBeGreaterThan(0);
  });

  it("uses contract-valid local telemetry and the Space Gateway provider view in shared Resources", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1365 });
    render(<DemoSpaceApp />);
    // Toolbar metrics moved into the unified Resources window and Manage (ecc0af72fb);
    // changes there are gated behind Admin mode on desktop.
    fireEvent.click(await workspaceAction("Resources", "Utilities", true));
    const resources = await screen.findByRole("dialog", { name: "Resources" });
    const connection = await within(resources).findByRole("button", { name: /^Connection/ });
    await waitFor(() => expect(connection.textContent).toMatch(/Latency & API traffic\d+ ms$/));
    const aiUsage = within(resources).getByRole("button", { name: /^AI usage/ });
    await waitFor(() => expect(aiUsage.textContent).toContain("91%"));
    fireEvent.click(aiUsage);
    expect(await within(resources).findByText("Demo account")).toBeTruthy();
    await waitFor(() => {
      const codexUsage = within(resources).getByText("Codex usage").closest(".toolbar-metric-provider-section");
      expect(codexUsage?.textContent).toContain("Routing capacity · all accounts84%");
      expect(codexUsage?.textContent).toContain("Demo account");
    });

    const view = within(resources).getByRole("combobox", { name: "Resource view" });
    fireEvent.change(view, { target: { value: "sessions" } });
    await waitFor(() => expect(within(resources).getByText("Space CLI sessions").closest(".resources-embedded-metric")?.textContent).toContain("Cleanup eligible"));
    expect(within(resources).getByText("Running").parentElement?.textContent).toBe("Running3");

    fireEvent.change(view, { target: { value: "connection" } });
    expect(await within(resources).findByText("42 ms")).toBeTruthy();
    expect(within(resources).getByText("HTTP 5xx errors").parentElement?.textContent).toBe("HTTP 5xx errors0");

    fireEvent.change(view, { target: { value: "provider" } });
    // codex-lb and its routes are retired: the provider view names Space Gateway and offers no switch.
    expect(await within(resources).findByText(/Codex runs through Space Gateway/)).toBeTruthy();
    expect(within(resources).queryByRole("menu", { name: "Provider quick switch" })).toBeNull();
  });

  it("confirms safe memory reclaim as a local no-op through Manage", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1365 });
    render(<DemoSpaceApp />);
    await openManageAction("Maintenance", "Reclaim safe memory");
    const memoryDialog = await screen.findByRole("dialog", { name: "Reclaim safe memory" });
    fireEvent.click(within(memoryDialog).getByRole("button", { name: "Confirm memory reclaim" }));
    await waitFor(() => expect(memoryDialog.isConnected).toBe(false));
    expect(await screen.findByText(/Memory reclaim made no changes/)).toBeTruthy();
  });

  it("shows Resets 2 and redeems only the deterministic local demo credit", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1365 });
    render(<DemoSpaceApp />);
    await enableAdminMode();

    const resources = await openResourcesView("ai");
    const usage = (await within(resources).findByText("Codex usage")).closest(".toolbar-metric-provider-section") as HTMLElement;
    const reset = await within(usage).findByRole("button", { name: "Resets 2" });
    fireEvent.click(reset);

    expect(await within(usage).findByRole("button", { name: "Resets 1" })).toBeTruthy();
    expect(within(usage).getByRole("status").textContent).toBe(DEMO_LOCAL_REPLY);
  });

  it("simulates Codex Off locally and enabling it does not reopen closed panes", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1365 });
    render(<DemoSpaceApp />);

    // CLI runtime switches moved from the Settings dock to the CLI dock (9ed515d993).
    const findCodexToggle = async () => {
      await enableAdminMode();
      const workspace = await openWorkspaceDock(/^(Open|Show) cli dock$/);
      const dock = await within(workspace).findByRole("region", { name: "CLI dock" });
      fireEvent.click(await within(dock).findByRole("button", { name: "CLI runtimes" }));
      await act(async () => { await vi.dynamicImportSettled(); });
      return await within(dock).findByRole("switch", { name: "Enable Codex CLI" }) as HTMLInputElement;
    };
    // The ALL and Provider toolbar badges now live in the Resources window (ecc0af72fb).
    const findProviderRouting = async (accountUsage: string) => {
      const workspace = await openWorkspaceMenu();
      fireEvent.click(within(workspace).getByRole("button", { name: "Resources" }));
      const resources = await screen.findByRole("dialog", { name: "Resources" });
      const aiUsage = await within(resources).findByRole("button", { name: /^AI usage/ });
      await waitFor(() => expect(aiUsage.textContent).toContain(accountUsage));
      fireEvent.click(aiUsage);
      const view = await within(resources).findByRole("combobox", { name: "Resource view" }) as HTMLSelectElement;
      fireEvent.change(view, { target: { value: "provider" } });
      await waitFor(() => expect(view.value).toBe("provider"));
      return resources;
    };
    const findAddChatPane = async () => {
      const navigation = await screen.findByRole("navigation", { name: "Workspace navigation" });
      fireEvent.click(within(navigation).getByRole("button", { name: "Create" }));
      return within(await screen.findByRole("dialog", { name: "Create" })).getByRole("button", { name: "Add chat pane" });
    };

    const codexToggle = await findCodexToggle();
    await waitFor(() => expect(codexToggle.disabled).toBe(false));
    fireEvent.click(codexToggle);
    const dialog = await screen.findByRole("dialog", { name: "Disable Codex CLI?" });
    expect(dialog.textContent).toContain("1 active Codex CLI session");
    expect(dialog.textContent).toContain("2 open Chat panes");
    // Closing open panes needs an explicit acknowledgement first (910450e67a).
    fireEvent.click(within(dialog).getByRole("switch", { name: /^(Close \d+ open panes? and stop their work|Stop \d+ active tasks?)$/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Disable Codex CLI" }));

    await waitFor(() => expect(codexToggle.checked).toBe(false));
    expect(codexToggle.disabled).toBe(false);
    expect((await demoRuntimeBundle.runtime.api.panes("room:demo-launch")).data.some((pane) =>
      pane.mode === "CHAT" || pane.terminalRuntimeId === "codex" || pane.terminalRuntimeId === "cli:codex"
    )).toBe(false);
    const offResources = await findProviderRouting("OFF");
    expect(within(offResources).queryByText(/Codex runs through Space Gateway/)).toBeNull();
    expect(await findAddChatPane()).toHaveProperty("disabled", true);

    // Resources and Create replaced the dock view, so reopen the CLI dock to re-enable.
    const enableToggle = await findCodexToggle();
    fireEvent.click(enableToggle);
    await waitFor(() => expect(enableToggle.checked).toBe(true));
    expect((await demoRuntimeBundle.runtime.api.cliRuntimeSettings()).settings.find(setting => setting.runtimeId === "cli:codex")?.enabled).toBe(true);
    const onResources = await findProviderRouting("91%");
    expect(await within(onResources).findByText(/Codex runs through Space Gateway/)).toBeTruthy();
    expect(await findAddChatPane()).toHaveProperty("disabled", false);
    expect((await demoRuntimeBundle.runtime.api.panes("room:demo-launch")).data.some((pane) =>
      pane.mode === "CHAT" || pane.terminalRuntimeId === "codex" || pane.terminalRuntimeId === "cli:codex"
    )).toBe(false);
  });

  it("keeps server restart behind the shared confirmation and reports a local no-op", async () => {
    render(<DemoSpaceApp />);

    // Server actions now live in the Workspace "Manage" window (ecc0af72fb).
    await openManageAction("Services", "Restart server");
    const dialog = await screen.findByRole("dialog", { name: "Restart Space server" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialog.isConnected).toBe(false));

    await openManageAction("Services", "Restart server");
    const confirmDialog = await screen.findByRole("dialog", { name: "Restart Space server" });
    fireEvent.click(within(confirmDialog).getByRole("button", { name: "Restart server" }));

    expect(await within(confirmDialog).findByText(DEMO_LOCAL_REPLY)).toBeTruthy();
    expect(within(confirmDialog).queryByText("Server restarted and ready.")).toBeNull();
  });

  it("previews admin history purge and completes it without removing demo history", async () => {
    render(<DemoSpaceApp />);

    const manage = await openManageAction("Maintenance", "Purge inactive history");
    const dialog = await within(manage).findByRole("region", { name: "Purge history" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview history purge" }));

    expect(await within(dialog).findByText("Removable history")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Type PURGE HISTORY to confirm"), {
      target: { value: "PURGE HISTORY" }
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Purge history" }));

    expect(await within(dialog).findByText("No history was removed.")).toBeTruthy();
    expect((await screen.findAllByText("Launch Control")).length).toBeGreaterThan(0);
  });

  it("keeps Codex-LB speed defaults unchanged and reports the local simulation", async () => {
    render(<DemoSpaceApp />);

    const manage = await openManageAction("Connections", "Codex speed defaults");
    const dialog = await within(manage).findByRole("region", { name: "Codex speed defaults" });
    const standard = await within(dialog).findByRole("button", { name: "Set GPT-5.5 to Standard" });
    expect(standard.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(within(dialog).getByRole("button", { name: "Set GPT-5.5 to Fast" }));

    expect(await within(dialog).findByText(DEMO_LOCAL_REPLY)).toBeTruthy();
    expect(standard.getAttribute("aria-pressed")).toBe("true");
    expect(within(dialog).queryByText("GPT-5.5 now uses Fast.")).toBeNull();
  });

  it("opens the shared search-only Memory atlas with local data", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1365 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 900 });
    render(<DemoSpaceApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Workspace" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Find an action" }), { target: { value: "memory" } });
    fireEvent.click(await screen.findByRole("button", { name: "Open memory workspace" }));
    const workspace = await screen.findByRole("region", { name: "Memory workspace" });
    // The workspace opens on the Calendar view since f93ec979ee; the Atlas is one click away.
    const atlas = within(workspace).getByRole("button", { name: "Atlas" });
    fireEvent.click(atlas);
    await waitFor(() => expect(atlas.getAttribute("aria-pressed")).toBe("true"));
    expect(within(workspace).getByRole("heading", { name: "Memory" })).toBeTruthy();
    expect(within(workspace).getAllByRole("searchbox")).toHaveLength(1);
    expect(within(workspace).queryByRole("combobox")).toBeNull();
    expect(within(workspace).queryByRole("tablist")).toBeNull();
    expectIdentifiedFormControls(workspace);
    fireEvent.click(await within(workspace).findByRole("button", { name: "Open memory node Public launch workspace" }));
    const nodeDetail = await within(workspace).findByRole("complementary", { name: "Memory node detail" });
    expect(await within(nodeDetail).findByText(/Sanitized fixture content/)).toBeTruthy();
    fireEvent.click(within(nodeDetail).getByRole("button", { name: "Close memory node detail" }));
    expect(within(workspace).queryByRole("complementary", { name: "Memory node detail" })).toBeNull();
  });

  it("uses the shared Links, Quick Links, and Clipboard surfaces with session-only local data", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1365 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 900 });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const nativeClipboardWrite = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: nativeClipboardWrite }
    });
    render(<DemoSpaceApp />);

    await openWorkspaceDock("Show links");
    const links = await screen.findByRole("region", { name: "Links library" });
    expect(within(links).getByText("Space Guide")).toBeTruthy();
    expect(links.querySelector(".link-favicon img")).toBeNull();

    fireEvent.click(within(links).getByRole("button", { name: "Add link" }));
    const addLink = within(links).getByRole("form", { name: "Add link" });
    fireEvent.change(within(addLink).getByLabelText("Title"), { target: { value: "Demo runbook" } });
    fireEvent.change(within(addLink).getByLabelText("URL"), { target: { value: "https://demo.invalid/runbook" } });
    fireEvent.click(within(addLink).getByRole("button", { name: "Save link" }));
    expect(await within(links).findByText("Demo runbook")).toBeTruthy();

    // The Workspace Utilities Quick Links entry opens the same session-only library.
    fireEvent.click(await workspaceAction("Quick Links", "Utilities"));
    const quickLinksLibrary = await screen.findByRole("region", { name: "Links library" });
    expect(within(quickLinksLibrary).getByText("Space Guide")).toBeTruthy();
    expect(within(quickLinksLibrary).getByText("Demo runbook")).toBeTruthy();

    // The Quick Links dialog is opened from the collapsed room toolbar rail.
    fireEvent.click(within(screen.getByRole("dialog", { name: "Workspace" })).getByRole("button", { name: "Close menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide room toolbar" }));
    fireEvent.click(await screen.findByRole("button", { name: "Quick Links" }));
    const quickLinks = await screen.findByRole("dialog", { name: "Quick Links" });
    expect(within(quickLinks).getByText("Space Guide")).toBeTruthy();
    fireEvent.click(within(quickLinks).getByRole("button", { name: "Close Quick Links" }));
    fireEvent.click(screen.getByRole("button", { name: "Show room toolbar" }));

    await openWorkspaceDock("Show clipboard");
    const clipboard = await screen.findByRole("region", { name: "Clipboard history" });
    expect(await within(clipboard).findByText(/No production credential or customer data/)).toBeTruthy();
    // The demo clipboard now also holds a plan clip, so copy the safety note explicitly.
    const safetyCopy = within(clipboard).getAllByRole("button", { name: "Copy clip text" })
      .find((button) => button.textContent?.includes("No production credential or customer data"));
    expect(safetyCopy).toBeTruthy();
    fireEvent.click(safetyCopy!);
    expect(await within(clipboard).findByText(DEMO_LOCAL_REPLY, { selector: '[role="status"]' })).toBeTruthy();
    expect(nativeClipboardWrite).not.toHaveBeenCalled();
    fireEvent.click(within(clipboard).getByRole("button", { name: "Add clipboard note" }));
    fireEvent.change(within(clipboard).getByRole("textbox", { name: "Manual clipboard note" }), {
      target: { value: "Local clipboard demo note" }
    });
    fireEvent.click(within(clipboard).getByRole("button", { name: "Save note" }));
    expect(await within(clipboard).findByText("Local clipboard demo note")).toBeTruthy();

    fireEvent.click(within(clipboard).getByRole("button", { name: "Clear all clipboard items" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Clear all clipboard history?" })).getByRole("button", { name: "Clear all" }));
    expect(window.confirm).not.toHaveBeenCalled();
    expect(await within(clipboard).findByText("Local clipboard demo note")).toBeTruthy();
  });

  it("uses the shared Media dock with inline local previews and a no-op room clear", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1365 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 900 });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const nativeOpen = vi.spyOn(window, "open").mockReturnValue(null);
    render(<DemoSpaceApp />);

    await openWorkspaceDock("Show media dock");
    const media = await screen.findByRole("list", { name: "Room media" });
    const photo = within(media).getByRole("button", { name: "Open launch-preview.png" });
    expect((within(media).getByAltText("launch-preview.png") as HTMLImageElement).src).toMatch(/^data:image\/svg\+xml,/);

    fireEvent.click(photo);
    const viewer = await screen.findByRole("dialog", { name: "launch-preview.png full resolution" });
    expect(within(viewer).getByAltText("launch-preview.png full resolution")).toBeTruthy();
    fireEvent.click(within(viewer).getByRole("button", { name: "Close media viewer" }));

    fireEvent.click(within(media).getByRole("button", { name: "Open launch-notes.txt" }));
    expect(await screen.findByText(DEMO_LOCAL_REPLY, { selector: '[role="status"] .dock-kit-notice-text' })).toBeTruthy();
    expect(nativeOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Clear all media" }));
    const clearDialog = screen.getByRole("alertdialog", { name: "Clear all media?" });
    expect(clearDialog.textContent).toContain("including older media");
    fireEvent.click(within(clearDialog).getByRole("button", { name: "Clear all" }));
    expect(await within(media).findByRole("button", { name: "Open launch-preview.png" })).toBeTruthy();
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("uses typed local provider, Telegram, and voice settings", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1365 });
    render(<DemoSpaceApp />);

    // Installation settings show only in Admin mode, inside collapsed sections (9e0ba4b9c6).
    // The Workspace "Docks" tab copy of the settings dock loads the provider catalog (5c4b25eb16).
    fireEvent.click(await workspaceAction(/^(Open|Show) settings dock$/, "Docks", true));
    const settings = await screen.findByRole("region", { name: "Settings dock" });
    const unidentifiedControls = "input:not([id]):not([name]), select:not([id]):not([name]), textarea:not([id]):not([name])";
    expect(settings.querySelectorAll(unidentifiedControls)).toHaveLength(0);
    fireEvent.click(within(settings).getByRole("button", { name: "Default provider" }));
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(settings.querySelectorAll(unidentifiedControls)).toHaveLength(0);
    const provider = await within(settings).findByRole("combobox", { name: "Default provider" }) as HTMLSelectElement;
    await waitFor(() => expect(provider.disabled).toBe(false));
    fireEvent.change(provider, { target: { value: "demo-direct" } });
    await waitFor(() => expect(
      (within(settings).getByRole("combobox", { name: "Default provider" }) as HTMLSelectElement).value
    ).toBe("demo-direct"));

    fireEvent.click(within(settings).getByRole("button", { name: "Telegram notifications" }));
    await act(async () => { await vi.dynamicImportSettled(); });
    const telegram = await within(settings).findByRole("region", { name: "Telegram notifications" });
    expect(await within(telegram).findByText("Connected")).toBeTruthy();
    expect(within(telegram).getByText("@space_demo_bot")).toBeTruthy();
    fireEvent.click(within(telegram).getByRole("button", { name: "Telegram notification actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Send test message" }));
    expect(await within(telegram).findByText(DEMO_LOCAL_REPLY)).toBeTruthy();
    fireEvent.click(within(telegram).getByRole("button", { name: "Telegram notification actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Disconnect Telegram" }));
    fireEvent.click(within(telegram).getByRole("button", { name: "Confirm Telegram disconnect" }));
    await waitFor(() => expect(within(telegram).queryByRole("alertdialog", { name: "Confirm Telegram disconnect" })).toBeNull());
    await waitFor(() => expect(within(telegram).queryByLabelText("Telegram bot token")).toBeNull());
    expect(within(telegram).getByText("Connected")).toBeTruthy();
    fireEvent.click(within(telegram).getByRole("button", { name: "Telegram notification actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Reconnect bot" }));
    expect(within(telegram).getByRole("link", { name: "Open BotFather" }).getAttribute("href")).toBe("#");
    fireEvent.change(within(telegram).getByLabelText("Telegram bot token"), { target: { value: "123456:demo_token_value_000000000" } });
    fireEvent.submit(within(telegram).getByRole("form", { name: "Connect Telegram bot" }));
    expect((await within(telegram).findByRole("link", { name: "Open private Telegram pairing" })).getAttribute("href")).toBe("#");

    fireEvent.click(within(settings).getByRole("button", { name: "Voice input" }));
    const voice = await within(settings).findByRole("region", { name: "Voice input settings" });
    expect(within(voice).getByText("Microphone capture stays disabled in the public demo.")).toBeTruthy();
    expect(settings.querySelectorAll(unidentifiedControls)).toHaveLength(0);

    // The side-surface settings dock shares its aside with previously opened docks,
    // which stay mounted but hidden (444deb00ef), so check its own slot.
    fireEvent.click(within(screen.getByRole("dialog", { name: "Workspace" })).getByRole("button", { name: "Close menu" }));
    await openRailDock("Show settings dock");
    const sideSettings = await screen.findByRole("complementary", { name: "Settings dock" });
    const settingsSlot = sideSettings.querySelector('[data-dock-id="settings"]') as HTMLElement;
    expect(settingsSlot.getAttribute("aria-hidden")).toBe("false");
    expect(settingsSlot.querySelectorAll(unidentifiedControls)).toHaveLength(0);
  });

  it("persists local agent-tool selection without native transport", async () => {
    const nativeFetch = vi.fn(async () => { throw new Error("Native fetch is forbidden in demo tests."); });
    vi.stubGlobal("fetch", nativeFetch);
    const client = demoRuntimeBundle.runtime.api;
    const panes = (await client.panes("room:demo-launch")).data;
    const chat = panes.find(pane => pane.mode === "CHAT")!;
    const before = await client.agentSession(chat.id);
    expect(before.selectedToolIds).toEqual(["space-readonly:space_status"]);
    expect(before.toolOptions).toHaveLength(2);
    await client.updateAgentSettings(chat.id, { selectedToolIds: [] });
    expect((await client.agentSession(chat.id)).selectedToolIds).toEqual([]);
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it("keeps legacy local CLI cleanup a no-op without native transport", async () => {
    const nativeFetch = vi.fn(async () => { throw new Error("Native fetch is forbidden in demo tests."); });
    vi.stubGlobal("fetch", nativeFetch);
    const client = demoRuntimeBundle.runtime.api;
    const before = (await client.panes("room:demo-launch")).data;
    expect(await client.reapToolbarCliSessions()).toMatchObject({
      status: "NOOP", killedSessionIds: [], estimatedReclaimedBytes: 0
    });
    expect((await client.panes("room:demo-launch")).data).toEqual(before);
    expect(nativeFetch).not.toHaveBeenCalled();
  });

});
