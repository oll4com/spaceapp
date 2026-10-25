import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthMe, Provider, ProviderSettings } from "@space/contracts";

const api = vi.hoisted(() => ({ updateProviderSettings: vi.fn() }));
vi.mock("../src/api.js", () => ({ api }));
vi.mock("../src/features/voice-input/VoiceSettingsCard.js", () => ({
  VoiceSettingsCard: () => <div data-testid="voice-card" />
}));

import { AgentSettingsDock, type AgentSettingsCards } from "../src/features/settings/AgentSettingsDock.js";
import { WorkspaceSurface } from "../src/features/ui-theme/WorkspaceSurface.js";

function stubCard(name: string) {
  return function StubCard(props: object) {
    return <div data-testid={`card-${name}`} data-props={JSON.stringify(props, (_key, value) => typeof value === "function" ? "fn" : value)} />;
  };
}

const cardNames: (keyof AgentSettingsCards)[] = [
  "EnvironmentPreset", "GoogleAccount", "UiTheme", "Docks", "Panes", "Widgets", "DateTime", "AppDiagnostics", "Releases",
  "SourceControlPublishing", "TelegramIntegration", "Plugins", "AgentCapabilities", "KeyboardAutocorrect", "PromptVariables",
  "ConfigurationMigration", "JobCopilot"
];
const cards = Object.fromEntries(cardNames.map((name) => [name, stubCard(name)])) as unknown as AgentSettingsCards;

const providers = [
  { id: "provider:a", displayName: "Alpha", routeProfile: "default", backingProviderId: "openai", type: "OPENAI" },
  { id: "provider:b", displayName: "Bravo", routeProfile: null, backingProviderId: null, type: "ANTHROPIC" }
] as unknown as Provider[];
const providerSettings = { defaultProviderId: "provider:a" } as ProviderSettings;
const adminAuth = { isAuthenticated: true, user: { id: "user:admin", role: "ADMIN" } } as unknown as AuthMe;

const sectionTitles = [
  "Account & Google", "Appearance", "Docks", "Panes", "Widgets", "Date & time", "Diagnostics", "Releases", "Default provider",
  "GitHub & Gitea", "Telegram notifications", "Plugins", "Agent capabilities", "Voice input",
  "Keyboard autocorrection", "Prompt variables", "Notifications", "Backup & migration", "Job Copilot"
];

/** Sections mount their content on first open. */
function openSection(title: string) {
  fireEvent.click(screen.getByRole("button", { name: title }));
}

function renderDock(overrides: Partial<ComponentProps<typeof AgentSettingsDock>> = {}) {
  const props: ComponentProps<typeof AgentSettingsDock> = {
    cards,
    adminMode: true,
    onOpenSetup: vi.fn(),
    canManageCliRuntimes: true,
    canManageDiagnostics: true,
    canManageSourceControl: true,
    canManageTelegram: true,
    currentAppearance: "system",
    currentIconPack: "lucide",
    currentUiTheme: "modern",
    isCodexEnabled: true,
    suppressNotifications: false,
    providerSettings,
    providers,
    onUiThemeApply: vi.fn(),
    onSuppressNotificationsChange: vi.fn(),
    onProviderSettingsRefresh: vi.fn(),
    auth: adminAuth,
    ...overrides
  } as ComponentProps<typeof AgentSettingsDock>;
  return { props, view: render(<AgentSettingsDock {...props} />) };
}

describe("AgentSettingsDock", () => {
  beforeEach(() => {
    window.localStorage.clear();
    api.updateProviderSettings.mockReset();
  });
  afterEach(() => cleanup());

  it("renders the admin sections with the injected settings cards", () => {
    const { props } = renderDock();
    expect(screen.getByRole("searchbox", { name: "Search settings" })).toBeTruthy();
    for (const group of ["Workspace", "Personal", "Assistants & AI", "Accounts & connections", "Maintenance"]) {
      expect(screen.getByRole("heading", { name: group })).toBeTruthy();
    }
    // The Source Control dock shows the deploy queue and the CLI dock the worktree default and CLI pane controls.
    for (const title of ["Deploy queue", "Git worktrees", "CLI pane controls"]) expect(screen.queryByRole("button", { name: title })).toBeNull();
    // Codex chooses its own model and thinking depth: Settings has no Codex CLI defaults.
    expect(screen.queryByRole("button", { name: "Codex CLI defaults" })).toBeNull();
    for (const title of sectionTitles) openSection(title);
    for (const name of cardNames) expect(screen.getAllByTestId(`card-${name}`).length).toBe(1);
    expect(JSON.parse(screen.getByTestId("card-EnvironmentPreset").dataset.props!)).toEqual({
      isAdmin: true, canManageCliRuntimes: true, userId: "user:admin"
    });
    expect(screen.getByTestId("voice-card")).toBeTruthy();
    expect(screen.getByLabelText("Global provider settings").textContent).toContain("Route: default / openai");
    fireEvent.click(screen.getByRole("button", { name: "Open setup wizard" }));
    expect(props.onOpenSetup).toHaveBeenCalledTimes(1);
  });

  it("keeps everyday settings for users and hides installation cards", () => {
    renderDock({
      adminMode: false,
      canManageCliRuntimes: false,
      canManageDiagnostics: false,
      canManageSourceControl: false,
      canManageTelegram: false,
      auth: { isAuthenticated: true, user: { id: "user:b", role: "USER" } } as unknown as AuthMe
    });
    expect(screen.queryByRole("button", { name: "Open setup wizard" })).toBeNull();
    for (const title of ["Diagnostics", "Releases", "Default provider", "GitHub & Gitea", "Telegram notifications", "Agent capabilities"]) {
      expect(screen.queryByRole("button", { name: title })).toBeNull();
    }
    openSection("Plugins");
    for (const name of ["AppDiagnostics", "Releases", "SourceControlPublishing", "TelegramIntegration"] as const) {
      expect(screen.queryByTestId(`card-${name}`)).toBeNull();
    }
    expect(screen.queryByLabelText("Global provider settings")).toBeNull();
    expect(screen.getByTestId("card-Plugins")).toBeTruthy();
  });

  it("saves the default provider and reports failures", async () => {
    const updated = { defaultProviderId: "provider:b" } as ProviderSettings;
    api.updateProviderSettings.mockResolvedValueOnce(updated);
    const settingsEvents: Event[] = [];
    const listener = (event: Event) => settingsEvents.push(event);
    window.addEventListener("space:agent-pane-settings-updated", listener);
    const { props } = renderDock();
    openSection("Default provider");
    await act(async () => {
      fireEvent.change(screen.getByRole("combobox", { name: "Default provider" }), { target: { value: "provider:b" } });
    });
    expect(api.updateProviderSettings).toHaveBeenCalledWith({ defaultProviderId: "provider:b" });
    expect(props.onProviderSettingsRefresh).toHaveBeenCalledWith(updated);
    expect(settingsEvents).toHaveLength(1);
    window.removeEventListener("space:agent-pane-settings-updated", listener);
    api.updateProviderSettings.mockRejectedValueOnce(new Error("Provider offline"));
    await act(async () => {
      fireEvent.change(screen.getByRole("combobox", { name: "Default provider" }), { target: { value: "provider:b" } });
    });
    expect(screen.getByText(/Provider offline/).closest("[role=alert]")?.textContent).toBe("The default provider could not be changed: Provider offline");
  });

  it("shows a positive notifications switch that forwards the suppress setting", () => {
    const { props, view } = renderDock();
    openSection("Notifications");
    const show = screen.getByRole("switch", { name: "Show notifications" }) as HTMLInputElement;
    expect(show.checked).toBe(true);
    fireEvent.click(show);
    expect(props.onSuppressNotificationsChange).toHaveBeenCalledWith(true);
    view.rerender(<AgentSettingsDock {...props} suppressNotifications />);
    expect((screen.getByRole("switch", { name: "Show notifications" }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("Pop-up messages and alerts are hidden for your account.")).toBeTruthy();
  });

  it("explains each section in plain words and says who it affects", () => {
    renderDock();
    openSection("Appearance");
    const appearance = screen.getByRole("button", { name: "Appearance" }).closest("section")!;
    expect(appearance.querySelector(".settings-help")?.textContent).toMatch(/Change how Space looks/);
    expect(appearance.querySelector(".settings-scope")?.textContent).toBe("Affects: Only you");
    openSection("Backup & migration");
    const backup = screen.getByRole("button", { name: "Backup & migration" }).closest("section")!;
    expect(backup.querySelector(".settings-scope")?.textContent).toBe("Affects: Everyone on this Space");
  });

  it("finds sections by title, description, help and keywords", () => {
    const { view } = renderDock();
    const search = screen.getByRole("searchbox", { name: "Search settings" });
    const section = (title: string) => screen.getByRole("button", { name: title, hidden: true }).closest("section")!;
    fireEvent.change(search, { target: { value: "dark mode" } });
    expect(section("Appearance").hidden).toBe(false);
    expect(section("Telegram notifications").hidden).toBe(true);
    expect(view.container.querySelector(".agent-settings-dock")?.getAttribute("data-searching")).toBe("true");
    fireEvent.change(search, { target: { value: "phone" } });
    expect(section("Telegram notifications").hidden).toBe(false);
    expect(section("Appearance").hidden).toBe(true);
    // The featured environment card and the setup wizard row follow the search too.
    expect(screen.getByTestId("card-EnvironmentPreset").closest(".settings-searchable")?.hasAttribute("hidden")).toBe(true);
    fireEvent.change(search, { target: { value: "wizard" } });
    expect(screen.getByRole("button", { name: "Open setup wizard" }).closest(".settings-searchable")?.hasAttribute("hidden")).toBe(false);
    fireEvent.keyDown(search, { key: "Escape" });
    expect((search as HTMLInputElement).value).toBe("");
    expect(section("Telegram notifications").hidden).toBe(false);
    expect(screen.getByRole("status").textContent).toContain("No settings match");
  });

  it("opens fullscreen with a groups list and leaves it with Escape", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { view } = renderDock();
    const dock = view.container.querySelector(".agent-settings-dock")!;
    expect(screen.queryByRole("navigation", { name: "Settings groups" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open settings fullscreen" }));
    expect(dock.classList.contains("is-fullscreen")).toBe(true);
    expect(screen.getByRole("dialog", { name: "Settings" })).toBe(dock);
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Settings groups" });
    expect(within(nav).getAllByRole("button").map((button) => button.textContent))
      .toEqual(["Workspace", "Personal", "Assistants & AI", "Accounts & connections", "Maintenance"]);
    fireEvent.click(within(nav).getByRole("button", { name: "Maintenance" }));
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(dock.querySelector('[data-settings-group="maintenance"]'));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(dock.classList.contains("is-fullscreen")).toBe(false);
    expect(screen.getByRole("button", { name: "Open settings fullscreen" })).toBeTruthy();
  });

  it("offers no fullscreen inside the Workspace menu, which shows docks in place", () => {
    const { props } = renderDock();
    cleanup();
    render(<WorkspaceSurface><AgentSettingsDock {...props} /></WorkspaceSurface>);
    expect(screen.getByRole("searchbox", { name: "Search settings" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open settings fullscreen" })).toBeNull();
  });

  it("keeps an opened section's header in view", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    renderDock();
    openSection("Appearance");
    const header = screen.getByRole("button", { name: "Appearance" }).closest("h3");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(header);
    scrollIntoView.mockClear();
    openSection("Appearance");
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
