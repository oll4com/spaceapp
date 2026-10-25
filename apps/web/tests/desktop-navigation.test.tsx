import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRoomSettings } from "../src/features/ui-theme/WorkspaceRoomSettings.js";
import { DesktopNavigation } from "../src/features/ui-theme/DesktopNavigation.js";
import { desktopActionGroup } from "../src/features/ui-theme/desktop-navigation.js";
import { Terminal } from "../src/features/ui-theme/app-icons.js";
import { writeHiddenWidgetIds } from "../src/features/desktop-widgets/index.js";
import type { IconToolbarAction } from "../src/icon-toolbar.js";

afterEach(cleanup);
afterEach(() => {
  localStorage.removeItem("space:workspace-menu-category:v1");
  localStorage.removeItem("space:workspace-quick-actions:v1");
});
vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return {
    ...actual,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>
  };
});
const action = (id: string, label: string): IconToolbarAction => ({
  id, label, ariaLabel: label, title: label, icon: Terminal, onClick: vi.fn()
});
describe("Desktop navigation", () => {
  it("shows the menu at full opacity on the first render and removes it immediately on close", () => {
    render(<DesktopNavigation toolsOnly actions={[action("memory-workspace", "Open memory workspace")]}
      adminMode={false} canAdmin={false} onModeChange={vi.fn()} onAction={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Workspace tools" }));
    const menu = screen.getByRole("dialog", { name: "Workspace tools" });
    expect(getComputedStyle(menu).opacity).not.toBe("0");
    expect(menu.style.transform).not.toContain("scale(0.97)");
    fireEvent.click(screen.getByRole("button", { name: "Workspace tools" }));
    expect(menu.isConnected).toBe(false);
  });
  it("shows title-only mobile actions and omits empty slots", () => {
    const actions = [action("surface-tasks", "Tasks"), action("add-empty-slots", "Empty slots")];
    render(<div data-shell-mode="mobile"><DesktopNavigation actions={actions} adminMode={false} canAdmin onModeChange={vi.fn()} onAction={vi.fn()} /></div>);
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByText("Empty slots")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Tasks" })).toBeTruthy();
    expect(dialog.querySelector(".desktop-menu-action small")).toBeNull();
  });
  it("keeps actions searchable regardless of group and passes a stable submenu anchor", () => {
    const actions = [action("add-cli", "Add CLI pane"), action("surface-media", "Media")];
    const onAction = vi.fn();
    render(<DesktopNavigation actions={actions} adminMode={false} canAdmin onModeChange={vi.fn()} onAction={onAction} />);
    const trigger = screen.getByRole("button", { name: "Create" });
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Find an action" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "recordings" } });
    fireEvent.click(screen.getByRole("button", { name: "Media" }));
    expect(onAction).toHaveBeenCalledWith(actions[1], trigger);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger.isConnected).toBe(true);
    expect(desktopActionGroup("add-vnc")).toBe("create");
  });
  it("requires Admin mode to reveal admin actions and offers no mode switch to regular users", () => {
    const actions = [
      action("server-restart", "Server actions"),
      action("token-usage", "Token usage"),
      action("demo-mode", "Demo mode"),
      action("add-root-admin-cli", "Add CLI ROOT"),
      action("add-cli", "Add CLI pane"),
      action("surface-tasks", "Tasks")
    ];
    const props = { actions, onModeChange: vi.fn(), onAction: vi.fn() };
    const view = render(<DesktopNavigation {...props} canAdmin adminMode={false} />);
    expect(screen.queryByRole("button", { name: "Admin" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    fireEvent.click(screen.getByRole("tab", { name: "Utilities" }));
    expect(screen.queryByRole("button", { name: "Server actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Token usage" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Demo mode" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.queryByRole("button", { name: "Add CLI ROOT" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));

    view.rerender(<DesktopNavigation {...props} canAdmin adminMode />);
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    fireEvent.click(screen.getByRole("tab", { name: "Utilities" }));
    expect(screen.getByRole("button", { name: "Server actions" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Token usage" })).toBeNull();
    expect(screen.getByRole("button", { name: "Demo mode" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Workspace" }));

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByRole("button", { name: "Add CLI ROOT" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));

    view.rerender(<DesktopNavigation {...props} canAdmin={false} adminMode={false} />);
    expect(screen.queryByRole("button", { name: "Admin mode" })).toBeNull();
  });
  it("keeps Rooms searchable in Workspace and makes maximize available in View", () => {
    const focus = action("room-focus", "Maximize room");
    const onAction = vi.fn();
    render(<DesktopNavigation actions={[focus, action("surface-rooms", "Hide rooms"), action("add-chat", "Add chat pane")]}
      adminMode={false} canAdmin={false} onModeChange={vi.fn()} onAction={onAction} footer={<span>v2026.09.05.2</span>} />);
    expect(screen.queryByRole("button", { name: "Rooms" })).toBeNull();
    const trigger = screen.getByRole("button", { name: "Workspace" });
    fireEvent.click(trigger);
    expect(screen.getByText("v2026.09.05.2")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "maximize" } });
    fireEvent.click(screen.getByRole("button", { name: "Maximize room" }));
    expect(onAction).toHaveBeenCalledWith(focus, trigger);
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "rooms" } });
    fireEvent.click(screen.getByRole("button", { name: "Hide rooms" }));
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ id: "surface-rooms" }), screen.getByRole("button", { name: "Create" }));
  });
  it("places former help options inside Workspace and displays the footer inside the Workspace menu", () => {
    const helpActions = [
      action("reload-room", "Reload window"),
      action("benchmark", "Asteroids benchmark"),
      action("help", "Help"),
      action("sign-out", "Sign out"),
      action("setup-connections", "Setup wizard")
    ];
    render(
      <DesktopNavigation
        actions={helpActions}
        adminMode={false}
        canAdmin={false}
        onModeChange={vi.fn()}
        onAction={vi.fn()}
        footer={<div data-testid="workspace-footer">v1.0.2 footer</div>}
      />
    );
    expect(screen.queryByRole("button", { name: "Help" })).toBeNull();
    expect(screen.queryByTestId("workspace-footer")).toBeNull();
    const trigger = screen.getByRole("button", { name: "Workspace" });
    fireEvent.click(trigger);
    expect(screen.getByTestId("workspace-footer")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Utilities" }));
    expect(screen.getByRole("button", { name: "Help" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload window" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Asteroids benchmark" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Setup wizard" })).toBeNull();
    const footer = screen.getByRole("dialog").querySelector(".desktop-menu-footer") as HTMLElement;
    expect(within(footer).getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(within(screen.getByRole("tabpanel")).queryByRole("button", { name: "Sign out" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Input & media" }));
    expect(within(screen.getByRole("tabpanel")).queryByRole("button", { name: "Sign out" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "sign out" } });
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });
});

it.each([
  { shell: "desktop", hidden: ["sticky", "quick-links"], adminMode: false },
  { shell: "desktop", hidden: ["sticky", "keyboard", "music", "quick-links"], adminMode: true },
  { shell: "desktop", hidden: [], adminMode: false },
  { shell: "mobile", hidden: ["sticky", "quick-links"], adminMode: false }
])("matches rail Tools membership, order, sections and states in $shell (hidden: $hidden, admin: $adminMode)", ({ shell, hidden, adminMode }) => {
  const widgets = ["widget-clock", "widget-countdown-timer", "widget-pushup-reminder", "widget-spaceapp-promo", "widget-ai-quota"];
  const toggles = ["debug-mode", "resource-indicators", "cli-floats", "sensitive-data", "browser-fullscreen"];
  const middle = ["toggle-admin-mode", "memory-workspace", ...(adminMode ? ["demo-mode"] : []), "resources", "benchmark", ...(adminMode ? ["server-restart"] : []), "help", "font-down", "vpn-city", "reload-room", "clip-tool"];
  const ids = [...widgets, ...(shell === "desktop" ? ["sticky-note"] : []), "quick-links", "osk-keyboard", "vibe-music", ...middle, ...toggles, "surface-tasks", "sign-out", "setup-connections"];
  const actions = ids.map((id, index) => ({ ...action(id, id), ariaPressed: id === "cli-floats" ? false : index % 2 === 0 })).reverse();
  const onAction = vi.fn();
  const props = { actions, adminMode, canAdmin: true, hiddenRailIds: hidden, onModeChange: vi.fn(), onAction };
  const snapshot = (container: Element) => Array.from(container.querySelectorAll(".desktop-tools-widgets-header, .desktop-menu-action")).filter(node => !node.closest(".workspace-tools-icons")).map(node => ({
    id: node.getAttribute("data-action-id"),
    label: (node.querySelector("strong") ?? node.querySelector("span"))?.textContent,
    pressed: node.getAttribute("aria-pressed"),
    status: node.querySelector(".desktop-action-status")?.textContent ?? null
  }));
  const view = render(<div data-shell-mode={shell}><DesktopNavigation {...props} toolsOnly /></div>);
  fireEvent.click(screen.getByRole("button", { name: "Workspace tools" }));
  const railTools = snapshot(screen.getByRole("dialog").querySelector(".desktop-menu-actions")!);
  const hiddenIds = [
    ...(shell === "desktop" && hidden.includes("sticky") ? ["sticky-note"] : []),
    ...(hidden.includes("keyboard") ? ["osk-keyboard"] : []),
    ...(hidden.includes("music") ? ["vibe-music"] : []),
    ...(hidden.includes("quick-links") ? ["quick-links"] : [])
  ];
  expect(railTools.map(row => row.id ?? row.label)).toEqual([
    ...(shell === "desktop" ? ["Desktop widgets", ...widgets] : []),
    ...(hiddenIds.length ? ["Hidden from rail", ...hiddenIds] : []),
    "Utilities", ...middle, "Quick toggles", ...toggles
  ]);
  expect(within(screen.getByRole("dialog")).getByRole("button", { name: "CLI controls" }).getAttribute("aria-pressed")).toBe("true");
  view.unmount();

  const view2 = render(<div data-shell-mode={shell}><DesktopNavigation {...props}
    workspaceDetailActionIds={["resources"]} renderWorkspaceAction={() => <div data-testid="inline-resources">Resources content</div>} /></div>);
  fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
  fireEvent.click(screen.getByRole("tab", { name: "Desktop widgets" }));
  const workspace = screen.getByRole("dialog", { name: "Workspace" });
  const panel = within(workspace).getByRole("tabpanel", { name: "Desktop widgets" });
  expect(within(screen.getByRole("tab", { name: "Desktop widgets" })).getByText(String(panel.querySelectorAll(".desktop-menu-action").length))).toBeTruthy();
  fireEvent.click(within(workspace).getByRole("button", { name: "resources" }));
  expect(within(workspace).getByTestId("inline-resources")).toBeTruthy();
  expect(onAction).not.toHaveBeenCalled();
  fireEvent.click(within(workspace).getByRole("button", { name: "Back to workspace actions" }));
  view2.unmount();
});

it("adds Room to Quick access and keeps its settings, state and nested Back inside Workspace", () => {
  const cli = { ...action("cli-floats", "Hide CLI controls"), ariaPressed: false };
  const actions = [action("pane-layout", "Pane layout"), action("font-down", "Text size"), action("resources", "Resources"),
    action("workspace-room", "Room"), { ...action("rename-room", "Rename room"), disabledReason: "Choose a room first" }, action("theme", "Room theme"), cli,
    { ...action("previous-room", "Previous room"), disabled: true, disabledReason: "This is the first room" },
    { ...action("resource-indicators", "Resource indicators"), ariaPressed: true }, action("room-toolbar", "Room toolbar")];
  const details = ["workspace-room", "rename-room", "theme"];
  const onAction = vi.fn();
  render(<DesktopNavigation actions={actions} workspaceDetailActionIds={details} adminMode={false} canAdmin={false}
    onModeChange={vi.fn()} onAction={onAction} renderWorkspaceAction={(id, { onNavigate }) => id === "workspace-room"
      ? <WorkspaceRoomSettings actions={actions} detailActionIds={details} onNavigate={onNavigate} /> : <div>Page {id}</div>} />);
  fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
  const workspace = screen.getByRole("dialog", { name: "Workspace" });
  const quick = workspace.querySelector(".workspace-quick-actions") as HTMLElement;
  expect(within(quick).getAllByRole("button").map(node => node.textContent)).toEqual(["Pane layout", "Text size", "Resources", "Room"]);
  fireEvent.click(within(quick).getByRole("button", { name: "Room" }));
  // Room is a tab now; the quick shortcut selects it instead of opening a second copy.
  expect(screen.getByRole("tab", { name: "Room" }).getAttribute("aria-selected")).toBe("true");
  expect(within(quick).getByRole("button", { name: "Room" }).getAttribute("data-current")).toBe("true");
  const settings = within(workspace).getByRole("group", { name: "Room settings" });
  expect(within(settings).queryByText("Choose a room first")).toBeNull();
  expect(within(settings).getByText("Change the name of this room.")).toBeTruthy();
  expect(within(settings).queryByText("Choose which room controls are visible.")).toBeNull();
  expect(within(settings).queryByText("Change how much screen space this room uses.")).toBeNull();
  expect(within(settings).queryByText("Show panes with a selected category color.")).toBeNull();
  expect(within(settings).getByText("This is the first room")).toBeTruthy();
  expect(within(settings).getByRole("button", { name: "CLI controls" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(within(settings).getByRole("button", { name: "CLI controls" }));
  expect(cli.onClick).toHaveBeenCalledOnce();
  expect(onAction).not.toHaveBeenCalled();
  fireEvent.click(within(settings).getByRole("button", { name: "Room theme" }));
  expect(within(workspace).getByText("Page theme")).toBeTruthy();
  fireEvent.click(within(workspace).getByRole("button", { name: "Back to workspace actions" }));
  expect(within(workspace).getByRole("group", { name: "Room settings" })).toBeTruthy();
  expect(within(workspace).queryByRole("button", { name: "Back to workspace actions" })).toBeNull();
  expect(workspace.querySelector(".workspace-quick-actions")).toBeTruthy();
});

it("includes Rooms in the collapsed toolbar docks menu", () => {
  const rooms = action("surface-rooms", "Show rooms");
  const media = action("surface-media", "Media");
  const onAction = vi.fn();
  render(<DesktopNavigation docksOnly actions={[rooms, media]} adminMode={false} canAdmin={false} onModeChange={vi.fn()} onAction={onAction} />);
  const trigger = screen.getByRole("button", { name: "Show docks" });
  fireEvent.click(trigger);
  expect(screen.getByText("Rooms")).toBeTruthy();
  expect(screen.getByText("Media")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show rooms" }));
  expect(onAction).toHaveBeenCalledWith(rooms, trigger);
});

it("displays asteroids benchmark, token usage, server actions and other tools in toolsOnly rail menu without duplicate docks or links", () => {
  const allActions = [
    action("surface-health", "Health"),
    action("surface-cli", "CLI tools"),
    action("surface-links", "Links"),
    action("benchmark", "Asteroids Benchmark"),
    action("token-usage", "Token usage"),
    action("server-restart", "Server actions"),
    action("system-analytics", "System analytics"),
    action("system-services", "System services"),
    action("quick-links", "Quick Links"),
    action("reload-room", "Reload window"),
    action("clip-tool", "Clip Tool")
  ];
  const onAction = vi.fn();
  render(
    <DesktopNavigation
      toolsOnly
      actions={allActions}
      adminMode={true}
      canAdmin={true}
      onModeChange={vi.fn()}
      onAction={onAction}
    />
  );
  const trigger = screen.getByRole("button", { name: "Workspace tools" });
  fireEvent.click(trigger);
  // Docks must never leak into toolsOnly
  expect(screen.queryByRole("button", { name: "Health" })).toBeNull();
  expect(screen.queryByRole("button", { name: "CLI tools" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Links" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Quick Links" })).toBeNull();
  // Legitimate workspace tools must be present
  expect(screen.getByRole("button", { name: "Asteroids Benchmark" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Token usage" })).toBeNull();
  expect(screen.getByRole("button", { name: "Server actions" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "System analytics" })).toBeNull();
  expect(screen.queryByRole("button", { name: "System services" })).toBeNull();
  expect(screen.getByRole("button", { name: "Reload window" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Clip Tool" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Asteroids Benchmark" }));
  expect(onAction).toHaveBeenCalledWith(allActions[3], trigger);
});

it("keeps all docks in docksOnly without leaking non-dock tools", () => {
  const allActions = [
    action("surface-health", "Health"),
    action("surface-cli", "CLI tools"),
    action("surface-links", "Links"),
    action("surface-media", "Media"),
    action("benchmark", "Asteroids Benchmark"),
    action("reload-room", "Reload window"),
    action("clip-tool", "Clip Tool")
  ];
  const onAction = vi.fn();
  render(
    <DesktopNavigation
      docksOnly
      actions={allActions}
      adminMode={true}
      canAdmin={true}
      onModeChange={vi.fn()}
      onAction={onAction}
    />
  );
  const trigger = screen.getByRole("button", { name: "Show docks" });
  fireEvent.click(trigger);
  // All docks must be present in docksOnly
  expect(screen.queryByRole("button", { name: "Health" })).toBeNull();
  expect(screen.getByRole("button", { name: "CLI tools" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Links" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Media" })).toBeTruthy();
  // Non-dock tools must not be in docksOnly
  expect(screen.queryByRole("button", { name: "Asteroids Benchmark" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Reload window" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Clip Tool" })).toBeNull();
});

it("opens wheel-selected action on scroll button (middle click / button 1)", () => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const media = action("surface-media", "Media");
  const clipboard = action("surface-clipboard", "Clipboard");
  const onAction = vi.fn();
  render(<DesktopNavigation docksOnly actions={[media, clipboard]} adminMode={false} canAdmin={false} onModeChange={vi.fn()} onAction={onAction} />);
  const trigger = screen.getByRole("button", { name: "Show docks" });
  fireEvent.click(trigger);
  expect(screen.getByRole("button", { name: "Media" })).toBeTruthy();
  fireEvent.wheel(document.body, { deltaY: 100 });
  const clipBtn = screen.getByRole("button", { name: "Clipboard" });
  expect(clipBtn.getAttribute("data-wheel-selected")).toBe("true");
  expect(onAction).not.toHaveBeenCalled();
  fireEvent.mouseUp(document.body, { button: 1 });
  expect(onAction).toHaveBeenCalledWith(clipboard, trigger);
});

it("uses available viewport height without 520px cap when opened from the rail", () => {
  const container = document.createElement("div");
  container.className = "room-toolbar-floating-controls";
  document.body.appendChild(container);

  const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("room-toolbar-floating-controls")) {
      return { top: 600, bottom: 1072, left: 1850, right: 1910, width: 60, height: 472 } as DOMRect;
    }
    return { top: 0, bottom: 0, left: 0, right: 0, width: 360, height: 600 } as DOMRect;
  });

  const originalInnerHeight = window.innerHeight;
  window.innerHeight = 1080;

  const media = action("surface-media", "Media");
  const view = render(
    <DesktopNavigation docksOnly actions={[media]} adminMode={false} canAdmin={false} onModeChange={vi.fn()} onAction={vi.fn()} />,
    { container }
  );

  const trigger = screen.getByRole("button", { name: "Show docks" });
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog");
  expect(parseInt(dialog.style.maxHeight, 10)).toBe(1064);

  spy.mockRestore();
  window.innerHeight = originalInnerHeight;
  view.unmount();
  container.remove();
});


describe("Workspace interaction", () => {
  const props = { adminMode: false, canAdmin: false, onModeChange: vi.fn() };
  it("keeps the quick actions visible across categories, searches all categories, and explains unavailable actions", () => {
    const layout = action("pane-layout", "Pane layout");
    const width = { ...action("pane-span-all", "All panes width"), disabled: true, disabledReason: "Requires at least two visible panes" };
    const onAction = vi.fn();
    render(<DesktopNavigation {...props} onAction={onAction} actions={[layout, action("font-down", "Workspace text size"), action("resources", "Resources"), action("surface-tasks", "Tasks"), action("clip-tool", "Clip Tool"), width]} />);
    const trigger = screen.getByRole("button", { name: "Workspace" });
    fireEvent.click(trigger);
    expect(screen.getByRole("button", { name: "Tasks" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clip Tool" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Pane layout" }));
    expect(screen.getByText(width.disabledReason)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pane layout" })).toBeTruthy();
    const search = screen.getByRole("textbox", { name: "Find an action" });
    fireEvent.change(search, { target: { value: "capture" } });
    expect(screen.getByRole("button", { name: "Clip Tool" })).toBeTruthy();
    fireEvent.change(search, { target: { value: "layout" } });
    fireEvent.click(screen.getByRole("button", { name: "Pane layout" }));
    expect(onAction).toHaveBeenCalledWith(layout, trigger);
    expect(trigger.isConnected).toBe(true);
  });
  it("describes toggles with stable labels and their actual visible state", () => {
    const cli = { ...action("cli-floats", "Hide CLI floats"), ariaPressed: false };
    const view = render(<DesktopNavigation {...props} onAction={vi.fn()} actions={[cli]} />);
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "CLI controls" } });
    expect(within(screen.getByRole("button", { name: "CLI controls" })).getByText("On")).toBeTruthy();
    view.rerender(<DesktopNavigation {...props} onAction={vi.fn()} actions={[{ ...cli, ariaPressed: true }]} />);
    expect(within(screen.getByRole("button", { name: "CLI controls" })).getByText("Off")).toBeTruthy();
  });
  it("opens only one navigation panel and returns focus when closed", () => {
    render(<><DesktopNavigation {...props} onAction={vi.fn()} actions={[action("surface-tasks", "Tasks")]} />
      <DesktopNavigation {...props} workspaceOnly onAction={vi.fn()} actions={[action("surface-tasks", "Tasks")]} /></>);
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    const more = screen.getByRole("button", { name: "More workspace actions" });
    fireEvent.click(more);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    expect(document.activeElement).toBe(more);
  });
  it("keeps Create separate on mobile and moves focus between category tabs", () => {
    const original = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    render(<DesktopNavigation {...props} onAction={vi.fn()} actions={[action("surface-tasks", "Tasks"), action("add-chat", "Add chat pane"), action("surface-settings", "Settings")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    expect(screen.getByRole("dialog").getAttribute("aria-modal")).toBe("true");
    expect(screen.queryByRole("button", { name: "Add chat pane" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Docks" }), { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Quick toggles" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByRole("button", { name: "Add chat pane" })).toBeTruthy();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: original });
  });
});

it("closes on the same trigger after the browser transfers focus out of the menu", () => {
  render(<DesktopNavigation docksOnly actions={[action("surface-media", "Media")]} adminMode={false} canAdmin={false} onModeChange={vi.fn()} onAction={vi.fn()} />);
  const trigger = screen.getByRole("button", { name: "Show docks" });
  fireEvent.click(trigger);
  fireEvent.pointerDown(trigger);
  fireEvent.blur(screen.getByRole("textbox"), { relatedTarget: trigger });
  fireEvent.click(trigger);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("restores memory-workspace, help, and setup-connections in toolsOnly and excludes memory from docksOnly", () => {
  const memory = action("memory-workspace", "Open memory workspace");
  const help = action("help", "Help");
  const setup = action("setup-connections", "Setup wizard");
  const media = action("surface-media", "Media");
  const onAction = vi.fn();

  // Test in toolsOnly
  const view = render(
    <DesktopNavigation
      toolsOnly
      actions={[memory, help, setup]}
      adminMode={false}
      canAdmin={false}
      onModeChange={vi.fn()}
      onAction={onAction}
    />
  );
  const toolsTrigger = screen.getByRole("button", { name: "Workspace tools" });
  fireEvent.click(toolsTrigger);
  const memBtn = screen.getByRole("button", { name: "Open memory workspace" });
  expect(memBtn).toBeTruthy();
  expect(within(memBtn).getByText("Memory")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Help" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Setup wizard" })).toBeNull();
  fireEvent.click(memBtn);
  expect(onAction).toHaveBeenCalledWith(memory, toolsTrigger);
  view.unmount();

  // Test in docksOnly (memory is NOT a dock, so it must not appear in docks)
  const docksView = render(
    <DesktopNavigation
      docksOnly
      actions={[media, memory]}
      adminMode={false}
      canAdmin={false}
      onModeChange={vi.fn()}
      onAction={onAction}
    />
  );
  const docksTrigger = screen.getByRole("button", { name: "Show docks" });
  fireEvent.click(docksTrigger);
  expect(screen.getByRole("button", { name: "Media" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Open memory workspace" })).toBeNull();
  expect(screen.queryByText("Memory")).toBeNull();
  docksView.unmount();
});

it("applies is-docks and is-tools classes to desktop navigation menu", () => {
  const media = action("surface-media", "Media");
  const help = action("help", "Help");

  const docksView = render(
    <DesktopNavigation
      docksOnly
      actions={[media]}
      adminMode={false}
      canAdmin={false}
      onModeChange={vi.fn()}
      onAction={vi.fn()}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: "Show docks" }));
  const docksDialog = screen.getByRole("dialog");
  expect(docksDialog.classList.contains("is-docks")).toBe(true);
  docksView.unmount();

  const toolsView = render(
    <DesktopNavigation
      toolsOnly
      actions={[help]}
      adminMode={false}
      canAdmin={false}
      onModeChange={vi.fn()}
      onAction={vi.fn()}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: "Workspace tools" }));
  const toolsDialog = screen.getByRole("dialog");
  expect(toolsDialog.classList.contains("is-tools")).toBe(true);
  toolsView.unmount();
});

it("automatically displays hidden lower rail items inside toolsOnly and excludes them when not hidden", () => {
  const keyboard = action("osk-keyboard", "On-screen keyboard");
  const music = action("vibe-music", "Music");
  const rooms = action("surface-rooms", "Rooms");
  const layout = action("pane-layout", "Pane layout");
  const help = action("help", "Help");
  const benchmark = action("benchmark", "Asteroids Benchmark");
  const onAction = vi.fn();

  const allActions = [benchmark, help, keyboard, music, rooms, layout];

  // When hiddenRailIds is empty, hidden rail items do not appear in toolsOnly
  const view1 = render(
    <DesktopNavigation
      toolsOnly
      actions={allActions}
      adminMode={false}
      canAdmin={false}
      onModeChange={vi.fn()}
      onAction={onAction}
      hiddenRailIds={[]}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: "Workspace tools" }));
  expect(screen.getByRole("button", { name: "Asteroids Benchmark" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Help" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "On-screen keyboard" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Music" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Rooms" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Pane layout" })).toBeNull();
  view1.unmount();

  // When keyboard and music are hidden from the rail (as in Image #1), they appear in Tools!
  const view2 = render(
    <DesktopNavigation
      toolsOnly
      actions={allActions}
      adminMode={false}
      canAdmin={false}
      onModeChange={vi.fn()}
      onAction={onAction}
      hiddenRailIds={["keyboard", "music"]}
    />
  );
  const trigger = screen.getByRole("button", { name: "Workspace tools" });
  fireEvent.click(trigger);
  expect(screen.getByRole("button", { name: "Asteroids Benchmark" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Help" })).toBeTruthy();
  const keyboardBtn = screen.getByRole("button", { name: "On-screen keyboard" });
  const musicBtn = screen.getByRole("button", { name: "Music" });
  expect(keyboardBtn).toBeTruthy();
  expect(musicBtn).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Rooms" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Pane layout" })).toBeNull();

  // Clicking a hidden rail item inside tools triggers onAction
  fireEvent.click(keyboardBtn);
  expect(onAction).toHaveBeenCalledWith(keyboard, trigger);
  view2.unmount();
});

it("prioritizes hidden rail items at the top of toolsOnly in rail order", () => {
  const keyboard = action("osk-keyboard", "On-screen keyboard");
  const music = action("vibe-music", "Music");
  const rooms = action("surface-rooms", "Rooms");
  const layout = action("pane-layout", "Pane layout");
  const benchmark = action("benchmark", "Asteroids Benchmark");
  const clipTool = action("clip-tool", "Clip Tool");

  const allActions = [music, keyboard, layout, rooms, clipTool, benchmark];

  render(
    <DesktopNavigation
      toolsOnly
      actions={allActions}
      adminMode={false}
      canAdmin={false}
      onModeChange={vi.fn()}
      onAction={vi.fn()}
      hiddenRailIds={["rooms", "layout", "keyboard", "music"]}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: "Workspace tools" }));
  const buttons = screen.getAllByRole("button").map(b => b.textContent?.trim());
  
  // Hidden rail items appear FIRST at the top in rail order
  const roomsIdx = buttons.findIndex(t => t?.includes("Rooms"));
  const layoutIdx = buttons.findIndex(t => t?.includes("Pane layout"));
  const keyboardIdx = buttons.findIndex(t => t?.includes("On-screen keyboard"));
  const musicIdx = buttons.findIndex(t => t?.includes("Music"));
  const benchmarkIdx = buttons.findIndex(t => t?.includes("Asteroids Benchmark"));
  const clipToolIdx = buttons.findIndex(t => t?.includes("Clip Tool"));

  expect(roomsIdx).toBeLessThan(layoutIdx);
  expect(layoutIdx).toBeLessThan(keyboardIdx);
  expect(keyboardIdx).toBeLessThan(musicIdx);
  expect(musicIdx).toBeLessThan(benchmarkIdx);
  expect(benchmarkIdx).toBeLessThan(clipToolIdx);
});

it("safely reorders create actions via pointer events and persists order to localStorage", () => {
  const chat = action("add-chat", "Add chat pane");
  const browser = action("add-browser", "Add browser pane");
  const files = action("add-files", "File Manager");

  render(
    <DesktopNavigation
      createOnly
      actions={[chat, browser, files]}
      adminMode={false}
      canAdmin={false}
      onModeChange={vi.fn()}
      onAction={vi.fn()}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  const chatBtn = screen.getByRole("button", { name: /Add chat pane/ });
  const filesBtn = screen.getByRole("button", { name: /File Manager/ });

  const originalElementFromPoint = document.elementFromPoint;
  document.elementFromPoint = vi.fn().mockImplementation(() => filesBtn);

  fireEvent.pointerDown(chatBtn, { clientX: 100, clientY: 100, button: 0 });
  fireEvent.pointerMove(window, { clientX: 100, clientY: 180 });
  fireEvent.pointerUp(window, { clientX: 100, clientY: 180 });

  document.elementFromPoint = originalElementFromPoint;

  const savedOrder = JSON.parse(window.localStorage.getItem("space:create-menu-top-order") || "[]");
  expect(savedOrder.indexOf("add-chat")).toBeGreaterThanOrEqual(0);
  expect(savedOrder.indexOf("add-files")).toBeGreaterThanOrEqual(0);
  expect(savedOrder.indexOf("add-chat")).toBe(savedOrder.indexOf("add-files") + 1);
});

it("passes paneCount to onAction when greater than 1 and resets to 1", () => {
  const browser = action("add-browser", "Add browser pane");
  const onAction = vi.fn();

  render(
    <DesktopNavigation
      createOnly
      actions={[browser]}
      adminMode={false}
      canAdmin={false}
      onModeChange={vi.fn()}
      onAction={onAction}
      renderCreateTools={({ paneCount, onPaneCountChange }) => (
        <button
          type="button"
          data-testid="set-count-3"
          onClick={() => onPaneCountChange?.(3)}
        >
          Count: {paneCount}
        </button>
      )}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  const countBtn = screen.getByTestId("set-count-3");
  expect(countBtn.textContent).toContain("Count: 1");

  // Set count to 3
  fireEvent.click(countBtn);
  expect(countBtn.textContent).toContain("Count: 3");

  // Click Add browser pane
  const browserBtn = screen.getByRole("button", { name: /Add browser pane/ });
  fireEvent.click(browserBtn);

  // Verifies onAction was called with count = 3
  expect(onAction).toHaveBeenCalledWith(browser, expect.any(HTMLElement), 3);
});

it("clamps paneCount to availablePanes in DesktopNavigation", () => {
  const browser = action("add-browser", "Add browser pane");
  const onAction = vi.fn();

  render(
    <DesktopNavigation
      createOnly
      actions={[browser]}
      availablePanes={2}
      adminMode={false}
      canAdmin={false}
      onModeChange={vi.fn()}
      onAction={onAction}
      renderCreateTools={({ paneCount, onPaneCountChange, availablePanes }) => (
        <button
          type="button"
          data-testid="set-count-5"
          onClick={() => onPaneCountChange?.(5)}
        >
          Count: {paneCount}, Avail: {availablePanes}
        </button>
      )}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  const countBtn = screen.getByTestId("set-count-5");
  expect(countBtn.textContent).toContain("Count: 1, Avail: 2");

  // Attempt to set count to 5 -> should clamp to 2
  fireEvent.click(countBtn);
  expect(countBtn.textContent).toContain("Count: 2, Avail: 2");

  // Click Add browser pane
  const browserBtn = screen.getByRole("button", { name: /Add browser pane/ });
  fireEvent.click(browserBtn);

  // Verifies onAction was called with clamped count = 2
  expect(onAction).toHaveBeenCalledWith(browser, expect.any(HTMLElement), 2);
});

it("separates Desktop widgets at top, Utilities in the middle, and Quick toggles at bottom in toolsOnly", () => {
  const clock = action("widget-clock", "Clock widget");
  const timer = action("widget-countdown-timer", "Countdown timer");
  const benchmark = action("benchmark", "Asteroids Benchmark");
  const reload = action("reload-room", "Reload window");
  const textSize = action("font-down", "Text size");
  const indicators: IconToolbarAction = { ...action("resource-indicators", "Resource indicators"), ariaPressed: true };
  const cliFloats: IconToolbarAction = { ...action("cli-floats", "CLI controls"), ariaPressed: false };
  const sensitiveData: IconToolbarAction = { ...action("sensitive-data", "Hide sensitive data"), ariaPressed: false };
  const fullscreen: IconToolbarAction = { ...action("browser-fullscreen", "Full screen browser"), ariaPressed: false };
  const debugMode: IconToolbarAction = { ...action("debug-mode", "Debug (App diagnostics)"), ariaPressed: false };

  const allActions = [clock, timer, benchmark, reload, textSize, indicators, cliFloats, sensitiveData, fullscreen, debugMode];

  const view = render(
    <DesktopNavigation
      toolsOnly
      actions={allActions}
      adminMode={false}
      canAdmin={false}
      onModeChange={vi.fn()}
      onAction={vi.fn()}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Workspace tools" }));

  // Section headers use the Workspace category names
  expect(screen.getByText("Desktop widgets")).toBeTruthy();
  expect(screen.getByText("Utilities")).toBeTruthy();
  expect(screen.getByText("Quick toggles")).toBeTruthy();

  const sections = document.querySelectorAll(".desktop-tools-widgets-section");
  expect(sections).toHaveLength(3);

  // Top section is Desktop widgets
  const topSection = sections[0]!;
  expect(within(topSection as HTMLElement).getByText("Desktop widgets")).toBeTruthy();
  expect(within(topSection as HTMLElement).getByRole("button", { name: /Clock widget/ })).toBeTruthy();
  expect(within(topSection as HTMLElement).getByRole("button", { name: /Countdown timer/ })).toBeTruthy();

  // Bottom section is Quick toggles
  const bottomSection = sections[2]!;
  expect(within(bottomSection as HTMLElement).getByText("Quick toggles")).toBeTruthy();
  expect(within(bottomSection as HTMLElement).getByRole("button", { name: /Debug \(App diagnostics\)/ })).toBeTruthy();
  expect(within(bottomSection as HTMLElement).getByRole("button", { name: /Resource indicators/ })).toBeTruthy();
  expect(within(bottomSection as HTMLElement).getByRole("button", { name: /CLI controls/ })).toBeTruthy();
  expect(within(bottomSection as HTMLElement).getByRole("button", { name: /Hide sensitive data/ })).toBeTruthy();
  expect(within(bottomSection as HTMLElement).getByRole("button", { name: /Full screen browser/ })).toBeTruthy();

  // Middle tools sit in the Utilities section
  const benchmarkBtn = screen.getByRole("button", { name: /Asteroids Benchmark/ });
  expect(sections[1]!.contains(benchmarkBtn)).toBe(true);
  expect(within(sections[1] as HTMLElement).getByText("Utilities")).toBeTruthy();
  expect(topSection.contains(benchmarkBtn)).toBe(false);
  expect(bottomSection.contains(benchmarkBtn)).toBe(false);

  const textSizeBtn = screen.getByRole("button", { name: /Text size/ });
  expect(topSection.contains(textSizeBtn)).toBe(false);
  expect(bottomSection.contains(textSizeBtn)).toBe(false);
});




it("splits Tools into subcategories including Desktop widgets and Utilities and excludes duplicate room actions", () => {
  render(<DesktopNavigation adminMode={false} canAdmin={false} onModeChange={vi.fn()} onAction={vi.fn()} actions={[
    action("surface-cli", "CLI tools"), action("sticky-note", "Sticky note"),
    action("widget-clock", "Clock"), action("vibe-music", "Music"), action("desktop-displays", "Displays"),
    action("osk-keyboard", "On-screen keyboard"), action("live-model", "Live voice"),
    action("clip-tool", "Clip Tool"), action("snip-tool", "Snip Tool"), action("room-toolbar", "Room toolbar"),
    action("browser-fullscreen", "Full screen browser"), action("quick-links", "Quick Links"), action("docks", "Docks"),
    action("widget-streaming-metrics", "Streaming metrics")
  ]} />);
  fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
  expect(screen.getAllByRole("tab").map(tab => tab.getAttribute("aria-label"))).toEqual(["Create", "Pane layout", "Docks", "Input & media", "Desktop widgets", "Utilities", "Quick toggles"]);
  expect(screen.getByRole("button", { name: "CLI tools" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Docks" })).toBeNull();

  // Input & media tab
  fireEvent.click(screen.getByRole("tab", { name: "Input & media" }));
  for (const label of ["Music", "Displays", "On-screen keyboard", "Live voice model"]) {
    expect(screen.getAllByRole("button", { name: label })).toHaveLength(1);
  }
  expect(screen.queryByRole("button", { name: "Room toolbar" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Snip Tool" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Streaming metrics" })).toBeNull();
  expect(screen.getByRole("button", { name: "Music" }).querySelector("svg")).toBeTruthy();

  // Desktop widgets tab
  fireEvent.click(screen.getByRole("tab", { name: "Desktop widgets" }));
  for (const label of ["Clock widget", "Sticky note", "Streaming metrics"]) {
    expect(screen.getAllByRole("button", { name: label })).toHaveLength(1);
  }
  expect(screen.queryByRole("button", { name: "Quick Links" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Clip Tool" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Room toolbar" })).toBeNull();

  // Utilities tab
  fireEvent.click(screen.getByRole("tab", { name: "Utilities" }));
  for (const label of ["Clip Tool", "Quick Links"]) {
    expect(screen.getAllByRole("button", { name: label })).toHaveLength(1);
  }
  expect(screen.queryByRole("button", { name: "Room toolbar" })).toBeNull();

  // Quick toggles tab
  fireEvent.click(screen.getByRole("tab", { name: "Quick toggles" }));
  expect(screen.getAllByRole("button", { name: "Full screen browser" })).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Room toolbar" })).toBeNull();

  fireEvent.keyDown(screen.getByRole("tab", { name: "Quick toggles" }), { key: "ArrowDown" });
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Create" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "special keys" } });
  expect(screen.getByRole("button", { name: "On-screen keyboard" })).toBeTruthy();
  expect(screen.queryByRole("tablist")).toBeNull();
});


it("opens tools inside Workspace and preserves the search when returning", () => {
  const onAction = vi.fn();
  const font = action("font-down", "Workspace text size");
  const renderWorkspaceAction = vi.fn((_id, { onBack }) => <div><button onClick={onBack}>Return from tool</button><input aria-label="Tool field" /></div>);
  render(<DesktopNavigation actions={[font, action("surface-tasks", "Tasks")]} adminMode={false} canAdmin={false}
    onModeChange={vi.fn()} onAction={onAction} renderWorkspaceAction={renderWorkspaceAction} workspaceDetailActionIds={["font-down"]} />);
  fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
  const workspace = screen.getByRole("dialog", { name: "Workspace" });
  const search = screen.getByRole("textbox", { name: "Find an action" });
  fireEvent.change(search, { target: { value: "text size" } });
  fireEvent.click(screen.getByRole("button", { name: "Workspace text size" }));
  expect(within(workspace).getByRole("textbox", { name: "Tool field" })).toBeTruthy();
  expect(onAction).not.toHaveBeenCalled();
  fireEvent.blur(workspace, { relatedTarget: document.body });
  expect(screen.getByRole("dialog", { name: "Workspace" })).toBe(workspace);
  fireEvent.keyDown(workspace, { key: "Escape" });
  expect(screen.queryByRole("textbox", { name: "Tool field" })).toBeNull();
  expect((search as HTMLInputElement).value).toBe("text size");
  expect(screen.getByRole("button", { name: "Workspace text size" })).toBeTruthy();
  fireEvent.keyDown(workspace, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("keeps Workspace open for toggles and uses categories independently of rail order", () => {
  const key = "space:room-rail-order:v1";
  const previous = localStorage.getItem(key);
  localStorage.setItem(key, JSON.stringify(["music", "docks", "create", "layout", "tools", "expand"]));
  try {
    const onAction = vi.fn();
    render(<DesktopNavigation actions={[action("vibe-music", "Music"), { ...action("widget-clock", "Clock"), ariaPressed: false }]}
      adminMode={false} canAdmin={false} onModeChange={vi.fn()} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    expect(screen.getAllByRole("tab").map(tab => tab.getAttribute("aria-label"))).toEqual(["Create", "Pane layout", "Docks", "Input & media", "Desktop widgets", "Utilities", "Quick toggles"]);
    expect(localStorage.getItem(key)).toBe(JSON.stringify(["music", "docks", "create", "layout", "tools", "expand"]));
    fireEvent.click(screen.getByRole("tab", { name: "Desktop widgets" }));
    fireEvent.click(screen.getByRole("button", { name: "Clock widget" }));
    expect(onAction).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog", { name: "Workspace" })).toBeTruthy();
  } finally {
    if (previous === null) localStorage.removeItem(key); else localStorage.setItem(key, previous);
  }
});

it("keeps launcher settings and nested pages inside Workspace and resets history when browsing", () => {
  render(<DesktopNavigation actions={[action("surface-settings", "Settings"), action("font-down", "Text size")]}
    adminMode={false} canAdmin={false} onModeChange={vi.fn()} onAction={vi.fn()}
    renderCreateTools={({ onNavigate }) => <button onClick={() => onNavigate?.("surface-settings")}>Launcher settings</button>}
    workspaceDetailActionIds={["surface-settings", "font-down"]}
    renderWorkspaceAction={(id, { onNavigate }) => <div><span>Page {id}</span><button onClick={() => onNavigate("setup-connections")}>Connections</button></div>} />);
  fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
  fireEvent.click(screen.getByRole("tab", { name: "Create" }));
  fireEvent.click(screen.getByRole("button", { name: "Launcher settings" }));
  const workspace = screen.getByRole("dialog", { name: "Workspace" });
  expect(within(workspace).getByText("Page surface-settings")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Connections" }));
  expect(within(workspace).getByText("Page setup-connections")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Back to workspace actions" }));
  expect(within(workspace).getByText("Page surface-settings")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Connections" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Find an action" }), { target: { value: "text size" } });
  fireEvent.click(screen.getByRole("button", { name: "Text size" }));
  fireEvent.click(screen.getByRole("button", { name: "Back to workspace actions" }));
  expect(screen.queryByText("Page surface-settings")).toBeNull();
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("text size");
});

it("renders Pane layout options directly without a list badge and opens on-screen keyboard as a float", () => {
  const onAction = vi.fn();
  const oskAction = action("osk-keyboard", "On-screen keyboard");
  const layoutAction = action("pane-layout", "Pane layout");
  const renderWorkspaceAction = vi.fn((id: string) => (
    <div data-testid={`inline-${id}`}>
      <span>Automatic</span>
      <span>Fullscreen</span>
      <span>1 column</span>
      <span>2 columns</span>
      <span>3 columns</span>
    </div>
  ));

  render(
    <DesktopNavigation
      actions={[layoutAction, oskAction, action("surface-tasks", "Tasks")]}
      adminMode={false}
      canAdmin={false}
      onModeChange={vi.fn()}
      onAction={onAction}
      renderWorkspaceAction={renderWorkspaceAction}
      workspaceDetailActionIds={["pane-layout"]}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
  const layoutTab = screen.getByRole("tab", { name: "Pane layout" });
  expect(layoutTab.querySelector("small")).toBeNull();

  fireEvent.click(layoutTab);
  expect(renderWorkspaceAction).toHaveBeenCalledWith("pane-layout", expect.any(Object));
  expect(screen.getByTestId("inline-pane-layout")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Back to workspace actions" })).toBeNull();

  // Test opening on-screen keyboard: should close workspace and trigger onAction
  fireEvent.click(screen.getByRole("tab", { name: "Input & media" }));
  const oskBtn = screen.getByRole("button", { name: "On-screen keyboard" });
  fireEvent.click(oskBtn);
  expect(onAction).toHaveBeenCalledWith(oskAction, expect.any(HTMLElement));
  expect(screen.queryByRole("dialog", { name: "Workspace" })).toBeNull();
});

it("hides disabled widgets from tools menu and search when marked hidden", () => {
  localStorage.clear();
  const widgetClock = action("widget-clock", "Clock widget");
  const widgetTimer = action("widget-countdown-timer", "Countdown timer");
  const actions = [widgetClock, widgetTimer];

  // Initially both appear in tools menu
  const { unmount } = render(
    <DesktopNavigation toolsOnly actions={actions} adminMode={false} canAdmin={false} onModeChange={vi.fn()} onAction={vi.fn()} />
  );
  fireEvent.click(screen.getByRole("button", { name: "Workspace tools" }));
  expect(screen.getByRole("button", { name: /Clock widget/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /Countdown timer/ })).toBeTruthy();
  unmount();

  // Now hide clock widget
  writeHiddenWidgetIds(["clock"], localStorage);
  render(
    <DesktopNavigation toolsOnly actions={actions} adminMode={false} canAdmin={false} onModeChange={vi.fn()} onAction={vi.fn()} />
  );
  fireEvent.click(screen.getByRole("button", { name: "Workspace tools" }));
  expect(screen.queryByRole("button", { name: /Clock widget/ })).toBeNull();
  expect(screen.getByRole("button", { name: /Countdown timer/ })).toBeTruthy();
});


it("orders docks the same way in Workspace and the rail Docks menu, with Settings last", () => {
  const ids = ["surface-settings", "surface-media", "surface-cli", "surface-rooms", "surface-clipboard", "surface-agent-files", "surface-room-agent", "surface-links", "surface-source-control"];
  const actions = ids.map(id => action(id, id));
  const expected = ["surface-rooms", "surface-room-agent", "surface-agent-files", "surface-media", "surface-clipboard", "surface-links", "surface-cli", "surface-source-control", "surface-settings"];
  const order = () => Array.from(screen.getByRole("dialog").querySelectorAll(".desktop-menu-action")).map(node => node.getAttribute("data-action-id"));
  const view = render(<DesktopNavigation docksOnly actions={actions} adminMode={false} canAdmin={false} onModeChange={vi.fn()} onAction={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Show docks" }));
  expect(order()).toEqual(expected);
  view.unmount();
  render(<DesktopNavigation actions={actions} adminMode={false} canAdmin={false} onModeChange={vi.fn()} onAction={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
  expect(order()).toEqual(expected);
  expect(screen.getByText("Rooms, files, clipboard and connections.")).toBeTruthy();
});

it("keeps rail icon colors for rail actions and groups agents dashboard with Utilities", () => {
  render(<DesktopNavigation adminMode={false} canAdmin={false} onModeChange={vi.fn()} onAction={vi.fn()} actions={[
    action("surface-rooms", "Rooms"), action("surface-media", "Media"), action("sticky-note", "Sticky note"),
    action("agents-dashboard", "Agents dashboard"), action("osk-keyboard", "On-screen keyboard"), action("vibe-music", "Music"),
    action("live-model", "Live voice"), action("desktop-displays", "Displays"), action("sign-out", "Sign out")
  ]} />);
  fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
  const color = (name: string) => screen.getByRole("button", { name }).style.getPropertyValue("--workspace-category-color");
  expect(color("Rooms")).toContain("--rail-rooms-color");
  expect(color("Media")).toBe("#f59e0b");
  fireEvent.click(screen.getByRole("tab", { name: "Desktop widgets" }));
  expect(color("Sticky note")).toContain("--rail-sticky-color");
  fireEvent.click(screen.getByRole("tab", { name: "Input & media" }));
  const panel = screen.getByRole("tabpanel");
  expect(Array.from(panel.querySelectorAll(".desktop-menu-action")).map(node => node.getAttribute("data-action-id")))
    .toEqual(["osk-keyboard", "vibe-music", "live-model", "desktop-displays"]);
  fireEvent.click(screen.getByRole("tab", { name: "Utilities" }));
  expect(within(screen.getByRole("tabpanel")).getByRole("button", { name: "Agents dashboard" })).toBeTruthy();
});

it("drops the filler heading, counts actions in the search field and marks open, toggled and rail-hidden items", () => {
  render(<DesktopNavigation adminMode={false} canAdmin={false} onModeChange={vi.fn()} onAction={vi.fn()} hiddenRailIds={["music"]} actions={[
    { ...action("surface-media", "Media"), ariaPressed: true }, action("surface-links", "Links"),
    action("vibe-music", "Music"), action("osk-keyboard", "On-screen keyboard"), { ...action("debug-mode", "Debug"), ariaPressed: true }
  ]} />);
  fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
  const dialog = screen.getByRole("dialog", { name: "Workspace" });
  expect(within(dialog).queryByText("Everything you need, in one place")).toBeNull();
  expect(within(dialog).queryByText("Browse by category")).toBeNull();
  const search = screen.getByRole("textbox", { name: "Find an action" }) as HTMLInputElement;
  expect(search.placeholder).toBe("Search 5 actions…");
  const media = screen.getByRole("button", { name: "Media" });
  expect(media.getAttribute("data-state")).toBe("open");
  expect(within(media).getByText("Open")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Links" }).hasAttribute("data-state")).toBe(false);
  fireEvent.click(screen.getByRole("tab", { name: "Input & media" }));
  expect(within(screen.getByRole("button", { name: "Music" })).getByText("Hidden from rail")).toBeTruthy();
  expect(within(screen.getByRole("button", { name: "On-screen keyboard" })).queryByText("Hidden from rail")).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Quick toggles" }));
  expect(within(screen.getByRole("button", { name: "Debug (App diagnostics)" })).getByText("On").getAttribute("data-on")).toBe("true");
  fireEvent.change(search, { target: { value: "music" } });
  expect(within(dialog).getByText("1 result")).toBeTruthy();
});

describe("Workspace Quick access, memory and keyboard", () => {
  const base = { adminMode: false, canAdmin: false, onModeChange: vi.fn() };
  const actions = () => [
    action("pane-layout", "Pane layout"), action("font-down", "Text size"), action("resources", "Resources"),
    action("surface-media", "Media"), action("surface-links", "Links"), action("surface-clipboard", "Clipboard"),
    action("help", "Help"), action("reload-room", "Reload window"), action("vibe-music", "Music")
  ];
  const quickIds = () => Array.from(document.querySelectorAll(".workspace-quick-actions .desktop-menu-action")).map(node => node.getAttribute("data-action-id"));

  it("pins, unpins, limits and reorders Quick access in Customize mode and persists the result", () => {
    render(<DesktopNavigation {...base} actions={actions()} onAction={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    expect(quickIds()).toEqual(["pane-layout", "font-down", "resources"]);
    fireEvent.click(screen.getByRole("button", { name: "Customize Quick access" }));
    expect(screen.getByRole("status").textContent).toContain("Pick up to 4 actions");
    fireEvent.click(screen.getByRole("button", { name: "Remove Text size from Quick access" }));
    expect(quickIds()).toEqual(["pane-layout", "resources"]);
    fireEvent.click(screen.getByRole("button", { name: "Pin Media to Quick access" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin Links to Quick access" }));
    expect(quickIds()).toEqual(["pane-layout", "resources", "surface-media", "surface-links"]);
    fireEvent.click(screen.getByRole("button", { name: "Pin Clipboard to Quick access" }));
    expect(screen.getByRole("status").textContent).toBe("Quick access holds 4 actions. Remove one first.");
    expect(quickIds()).toHaveLength(4);
    fireEvent.keyDown(screen.getByRole("button", { name: "Remove Links from Quick access" }), { key: "ArrowLeft" });
    expect(quickIds()).toEqual(["pane-layout", "resources", "surface-links", "surface-media"]);
    expect(JSON.parse(localStorage.getItem("space:workspace-quick-actions:v1")!)).toEqual(["pane-layout", "resources", "surface-links", "surface-media"]);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Finish customizing Quick access" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Workspace" })).toBeTruthy();
    expect(within(screen.getByRole("tabpanel")).queryByRole("button", { name: "Media" })).toBeNull();
    expect(within(screen.getByRole("tabpanel")).getByRole("button", { name: "Clipboard" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    expect(quickIds()).toEqual(["pane-layout", "resources", "surface-links", "surface-media"]);
  });

  it("remembers the last category between openings", () => {
    render(<DesktopNavigation {...base} actions={actions()} onAction={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    expect(screen.getByRole("tab", { name: "Docks" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Utilities" }));
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    expect(screen.getByRole("tab", { name: "Utilities" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "Help" })).toBeTruthy();
  });

  it("opens Workspace with Ctrl+K except inside terminals and text fields, and Enter runs the first grouped result", () => {
    const onAction = vi.fn();
    const list = actions();
    render(<><div className="xterm"><textarea aria-label="Terminal input" /></div><input aria-label="Note" />
      <DesktopNavigation {...base} actions={list} onAction={onAction} /></>);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Terminal input" }), { key: "k", ctrlKey: true });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Note" }), { key: "k", ctrlKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "Workspace" })).toBeTruthy();
    const search = screen.getByRole("textbox", { name: "Find an action" });
    expect(document.activeElement).toBe(search);
    // Proof tooling locates the trigger by title="Workspace", so the shortcut lives in aria-keyshortcuts and a visible hint.
    const trigger = screen.getByRole("button", { name: "Workspace" });
    expect(trigger.getAttribute("title")).toBe("Workspace");
    expect(trigger.getAttribute("aria-keyshortcuts")).toBe("Control+K Meta+K");
    expect(screen.getByRole("dialog").querySelector(".desktop-menu-shortcut")?.textContent).toMatch(/^(Ctrl\+K|⌘K)$/);
    fireEvent.change(search, { target: { value: "li" } });
    const groups = Array.from(document.querySelectorAll(".workspace-search-group")).map(node => node.getAttribute("data-category"));
    expect(groups).toEqual(["docks", "tools", "utilities"]);
    expect(screen.getByRole("button", { name: "Links" }).getAttribute("data-search-first")).toBe("true");
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onAction).toHaveBeenCalledWith(list[4], screen.getByRole("button", { name: "Workspace" }));
  });
});
