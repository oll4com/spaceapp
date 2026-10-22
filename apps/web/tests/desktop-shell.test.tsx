import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Pane } from "@space/contracts";
import { App } from "../src/App.js";
import { createDemoRuntime } from "../src/demo/demo-runtime.js";
import { SpaceRuntimeProvider } from "../src/runtime/SpaceRuntime.js";
import { VoiceInputProvider } from "../src/features/voice-input/VoiceInputProvider.js";
import { workspaceAction } from "./responsive-shell-fixture.js";
import { SPACE_OPEN_PLAN_PANE_EVENT } from "../src/features/clipboard-dock/plan-assignee.js";

vi.mock("../src/features/terminal-pane/TerminalPane.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/features/terminal-pane/TerminalPane.js")>();
  return { ...original, TerminalPane: ({ pane }: { pane: Pane }) => <div data-test-terminal={pane.id}>Terminal</div> };
});
vi.mock("../src/features/browser-pane/BrowserPane.js", () => ({
  BrowserPane: () => <div>Browser</div>
}));
afterEach(() => { cleanup(); window.localStorage.clear(); window.sessionStorage.clear(); vi.restoreAllMocks(); });

it("keeps CLI management and Google accounts available to admins in desktop User mode", async () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  const bundle = createDemoRuntime();
  render(<SpaceRuntimeProvider runtime={bundle.runtime}><VoiceInputProvider><App /></VoiceInputProvider></SpaceRuntimeProvider>);
  const navigation = await screen.findByRole("navigation", { name: "Workspace navigation" });
  expect(document.querySelector(".space-shell")?.getAttribute("data-interface-mode")).toBe("user");
  // Workspace categories keep being reorganised (c5a09f4a97); the shared helper finds the action.
  fireEvent.click(await workspaceAction(/^(Open|Show) cli dock$/));
  const dock = await screen.findByLabelText("CLI dock", undefined, { timeout: 10_000 });
  expect(within(dock).queryByText(/ADMIN role can manage CLI runtimes/)).toBeNull();
  fireEvent.click(await within(dock).findByRole("button", { name: "CLI runtimes" }));
  const card = await within(dock).findByLabelText("CLI runtime visibility settings");
  const row = card.querySelector('[data-runtime-id="cli:opencode"]') as HTMLElement;
  expect(within(row).getAllByRole("switch")).toHaveLength(2);
  expect(within(row).getByRole("button", { name: "Restart OpenCode CLI" })).toBeTruthy();
  fireEvent.click(within(dock).getByRole("button", { name: "CLI runtime actions" }));
  expect(screen.getByRole("menuitem", { name: "Restart all CLI runtimes" })).toBeTruthy();
  fireEvent.click(within(dock).getByRole("button", { name: "CLI accounts" }));
  expect(await within(dock).findByLabelText("CLI account profile settings")).toBeTruthy();
  expect(within(dock).getByLabelText("Gemini account profiles")).toBeTruthy();
  expect(document.querySelector(".space-shell")?.getAttribute("data-interface-mode")).toBe("user");
});

it("keeps navigation and version visible and launches CLI directly from Create without replacing running panes", async () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  const bundle = createDemoRuntime();
  render(<SpaceRuntimeProvider runtime={bundle.runtime}><VoiceInputProvider><App /></VoiceInputProvider></SpaceRuntimeProvider>);
  const navigation = await screen.findByRole("navigation", { name: "Workspace navigation" });
  await waitFor(() => expect(document.querySelector("[data-test-terminal]")).toBeTruthy());
  const terminal = document.querySelector("[data-test-terminal]");
  expect(within(navigation).queryByRole("button", { name: "Rooms" })).toBeNull();
  expect(within(navigation).queryByRole("button", { name: "Maximize room" })).toBeNull();
  expect(within(navigation).queryByRole("link", { name: "v0.1.0 · demo" })).toBeNull();
  fireEvent.click(within(navigation).getByRole("button", { name: "Workspace" }));
  expect(screen.getByRole("link", { name: "v0.1.0 · demo" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
  expect(within(navigation).queryByRole("button", { name: "Admin" })).toBeNull();
  fireEvent.click(within(navigation).getByRole("button", { name: "Admin mode" }));
  fireEvent.click(await workspaceAction("Advanced settings"));
  expect(await screen.findByRole("button", { name: "Telegram notifications" })).toBeTruthy();
  expect(document.querySelector("[data-test-terminal]")).toBe(terminal);
  fireEvent.click(within(navigation).getByRole("button", { name: "Admin mode" }));
  expect(screen.queryByRole("button", { name: "Telegram notifications" })).toBeNull();
  expect(document.querySelector("[data-test-terminal]")).toBe(terminal);
  fireEvent.click(within(navigation).getByRole("button", { name: "Create" }));
  const create = screen.getByRole("dialog", { name: "Create" });
  expect(within(create).getByRole("button", { name: "Add chat pane" })).toBeTruthy();
  expect(within(create).getByRole("button", { name: "Open DeepSeek Harness" })).toBeTruthy();
  expect(within(create).queryByRole("button", { name: "Add CLI pane" })).toBeNull();
  const openCode = await within(create).findByRole("button", { name: /^Add OpenCode/ });
  expect(screen.queryByRole("menu", { name: "Add CLI pane" })).toBeNull();
  const count = document.querySelectorAll("[data-test-terminal]").length;
  fireEvent.click(openCode);
  await waitFor(() => expect(document.querySelectorAll("[data-test-terminal]").length).toBe(count + 1));
  expect(document.querySelector("[data-test-terminal]")).toBe(terminal);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Create" })).toBeNull());
});

it("creates chat on the first action and keeps the Rooms toggle beside the room title", async () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  const bundle = createDemoRuntime();
  const roomId = (await bundle.runtime.api.rooms()).data[0]!.id;
  const chatCount = (await bundle.runtime.api.panes(roomId)).data.filter(pane => pane.mode === "CHAT").length;
  render(<SpaceRuntimeProvider runtime={bundle.runtime}><VoiceInputProvider><App /></VoiceInputProvider></SpaceRuntimeProvider>);
  const navigation = await screen.findByRole("navigation", { name: "Workspace navigation" });
  const roomsToggle = document.querySelector<HTMLButtonElement>(".desktop-rooms-toggle")!;
  expect(roomsToggle.closest(".board-title-row")).toBeTruthy();
  fireEvent.click(roomsToggle);
  expect(roomsToggle.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(roomsToggle);
  expect(roomsToggle.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(within(navigation).getByRole("button", { name: "Create" }));
  fireEvent.click(screen.getByRole("button", { name: "Add chat pane" }));
  await waitFor(async () => expect((await bundle.runtime.api.panes(roomId)).data.filter(pane => pane.mode === "CHAT").length).toBe(chatCount + 1));
  expect(screen.queryByRole("menu", { name: "Chat" })).toBeNull();
});

it("opens the same Create choices from the collapsed right rail", async () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  const bundle = createDemoRuntime();
  render(<SpaceRuntimeProvider runtime={bundle.runtime}><VoiceInputProvider><App /></VoiceInputProvider></SpaceRuntimeProvider>);
  const navigation = await screen.findByRole("navigation", { name: "Workspace navigation" });
  fireEvent.click(within(navigation).getByRole("button", { name: "Create" }));
  await screen.findByRole("button", { name: /^Add OpenCode/ });
  const choices = () => Array.from(screen.getByRole("dialog", { name: "Create" }).querySelectorAll("button")).map(button => button.getAttribute("aria-label"));
  const topChoices = choices();
  fireEvent.keyDown(screen.getByRole("dialog", { name: "Create" }), { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Hide room toolbar" }));
  const rail = screen.getByRole("region", { name: "Room toolbar hidden" });
  const create = within(rail).getByRole("button", { name: "Create" });
  fireEvent.click(create);
  await screen.findByRole("button", { name: /^Add OpenCode/ });
  expect(choices()).toEqual(topChoices);
  expect(create.getAttribute("aria-expanded")).toBe("true");
  expect(screen.queryByRole("navigation", { name: "Workspace navigation" })).toBeNull();
  fireEvent.keyDown(screen.getByRole("dialog", { name: "Create" }), { key: "Escape" });
  expect(document.activeElement).toBe(create);
  expect(create.getAttribute("aria-expanded")).toBe("false");
});

it("opens Resources from resource indicators and retains panes through collapsed-toolbar maintenance", async () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  const bundle = createDemoRuntime();
  render(<SpaceRuntimeProvider runtime={bundle.runtime}><VoiceInputProvider><App /></VoiceInputProvider></SpaceRuntimeProvider>);
  await waitFor(() => expect(document.querySelector("[data-test-terminal]")).toBeTruthy());
  const terminal = document.querySelector("[data-test-terminal]");
  fireEvent.click(screen.getByRole("button", { name: "Hide room toolbar" }));
  fireEvent.click(screen.getByRole("button", { name: "Workspace tools" }));
  fireEvent.click(await screen.findByRole("button", { name: "Resource indicators" }));
  await screen.findByRole("navigation", { name: "Resource indicators" });
  fireEvent.click(screen.getByRole("button", { name: "Show room toolbar" }));
  expect(screen.queryByRole("navigation", { name: "Resource indicators" })).toBeNull();
  expect(document.querySelector(".space-shell")?.hasAttribute("data-workspace-rail")).toBe(false);
  expect(screen.queryByRole("button", { name: "Resources" })).toBeNull();
  expect(document.querySelector("[data-test-terminal]")).toBe(terminal);
  fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
  fireEvent.click(screen.getByRole("button", { name: "Resources" }));
  expect(await screen.findByRole("dialog", { name: "Resources" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close Resources" }));
  fireEvent.click(screen.getByRole("button", { name: "Hide room toolbar" }));
  expect(screen.getByRole("navigation", { name: "Resource indicators" })).toBeTruthy();
  expect(document.querySelector("[data-test-terminal]")).toBe(terminal);
  // The CPU indicator opens the unified Resources window directly on its performance view.
  fireEvent.click(within(screen.getByRole("navigation", { name: "Resource indicators" })).getByRole("button", { name: /^CPU:/ }));
  const resources = await screen.findByRole("dialog", { name: "Resources" });
  expect(document.querySelector("[data-test-terminal]")).toBe(terminal);
  const view = within(resources).getByRole("combobox", { name: "Resource view" }) as HTMLSelectElement;
  expect(view.value).toBe("performance");
  fireEvent.change(view, { target: { value: "ai" } });
  await waitFor(() => expect((within(resources).getByRole("combobox", { name: "Resource view" }) as HTMLSelectElement).value).toBe("ai"));
  expect(document.querySelector(".room-toolbar-collapsed")).toBeTruthy();
  expect(document.querySelector("[data-test-terminal]")).toBe(terminal);
});

it("opens a plan's room and focuses its pane from the plan's Open pane event", async () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  const bundle = createDemoRuntime();
  render(<SpaceRuntimeProvider runtime={bundle.runtime}><VoiceInputProvider><App /></VoiceInputProvider></SpaceRuntimeProvider>);
  await waitFor(() => expect(document.querySelector("[data-test-terminal]")).toBeTruthy());
  expect(bundle.runtime.platform.sessionStorage.getItem("space.selectedRoomId")).not.toBe("room:demo-ops");

  window.dispatchEvent(new CustomEvent(SPACE_OPEN_PLAN_PANE_EVENT, { detail: { roomId: "room:demo-ops", paneId: "pane:demo-ops-cli" } }));
  await waitFor(() => expect(bundle.runtime.platform.sessionStorage.getItem("space.selectedRoomId")).toBe("room:demo-ops"));
  await waitFor(() => expect(bundle.runtime.platform.sessionStorage.getItem("space.selectedPaneId")).toBe("pane:demo-ops-cli"));
  expect(await screen.findByText("Terminal", { selector: '[data-test-terminal="pane:demo-ops-cli"]' })).toBeTruthy();

  // A plan whose pane was closed says so instead of switching rooms.
  window.dispatchEvent(new CustomEvent(SPACE_OPEN_PLAN_PANE_EVENT, { detail: { roomId: "room:demo-launch", paneId: "pane:gone" } }));
  expect(await screen.findByText("The pane that ran this plan is closed.")).toBeTruthy();
  expect(bundle.runtime.platform.sessionStorage.getItem("space.selectedRoomId")).toBe("room:demo-ops");
});
