import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOT_PROACTIVE_DEFAULTS, summarizeDotProactiveUsage, type DotProfile, type DotUserSettings } from "@space/contracts";
import { DotsSettingsCard, proactiveUsageText } from "../src/features/agent-pane/DotsSettingsCard.js";
import { DOTS_UPDATED_EVENT } from "../src/features/agent-pane/dot-home-events.js";
import { SettingsDisclosure, SettingsSections } from "../src/features/settings/SettingsDisclosure.js";
import { Bot } from "../src/features/ui-theme/app-icons.js";

const mock = vi.hoisted(() => ({ dots: vi.fn(), dotSettings: vi.fn(), updateDotSettings: vi.fn(), dotModels: vi.fn(), dotCollection: vi.fn(),
  connectors: vi.fn(), channels: vi.fn(), dotProactiveUsage: vi.fn(), dotMemories: vi.fn(), dotGoals: vi.fn(), dotSchedules: vi.fn(), updateDot: vi.fn() }));
vi.mock("../src/api.js", () => ({ api: mock }));

const dots = ["Orbit", "Nova", "Byte", "Comet", "Luna", "Cosmo"].map((name, i) => ({ dotId: `dot:${String(i + 1).repeat(32)}`, ownerUserId: "user:one",
  slot: i + 1, name, appearance: { character: (["astronaut", "star", "robot", "comet", "moon", "planet"] as const)[i]!, accent: "slate" as const },
  preferences: {}, permissions: { mode: "INHERIT_USER" as const }, workLimits: { maxConcurrentTasks: 1, dailyBudgetUsd: null },
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" })) as DotProfile[];
const settings: DotUserSettings = { defaultDotId: null, defaultModelConfigId: null, defaultPermissionMode: null, confirmExternalActions: true,
  proactive: DOT_PROACTIVE_DEFAULTS, updatedAt: null };

beforeEach(() => {
  vi.resetAllMocks();
  mock.dots.mockResolvedValue({ dots });
  mock.dotSettings.mockResolvedValue({ settings });
  mock.updateDotSettings.mockImplementation(async (patch: Partial<DotUserSettings>) => ({ settings: { ...settings, ...patch } }));
  mock.dotModels.mockResolvedValue({ providers: [{ providerId: "codex", providerName: "Codex (OpenAI)", statusReason: null, options: [
    { id: "codex-v1|gpt|high", displayName: "GPT", providerId: null, providerName: null, model: "gpt", reasoningKey: "high", reasoningLabel: "High reasoning", isDefault: true }] }] });
  mock.dotCollection.mockImplementation(async (dotId: string) => ({ dotId, items: [], limit: 50, offset: 0 }));
  mock.connectors.mockResolvedValue({ providers: [], accounts: [] });
  mock.channels.mockResolvedValue({ providers: [], identities: [], threads: [] });
  mock.dotProactiveUsage.mockResolvedValue(summarizeDotProactiveUsage([], 7));
  mock.dotMemories.mockImplementation(async (dotId: string) => ({ dotId, items: [] }));
  mock.dotGoals.mockImplementation(async (dotId: string) => ({ dotId, items: [] }));
  mock.dotSchedules.mockImplementation(async (dotId: string) => ({ dotId, items: [] }));
});
afterEach(cleanup);

describe("Settings → Dots", () => {
  it("sets the default Dot, approvals before email and events, and the default model for all Dots", async () => {
    const updated = vi.fn(); window.addEventListener(DOTS_UPDATED_EVENT, updated);
    render(<DotsSettingsCard roomId="room:1" isAdmin={false} />);
    const all = within(await screen.findByRole("region", { name: "All Dots" }));
    fireEvent.change(all.getByRole("combobox", { name: "Default Dot" }), { target: { value: dots[1]!.dotId } });
    await waitFor(() => expect(mock.updateDotSettings).toHaveBeenCalledWith({ defaultDotId: dots[1]!.dotId }));
    const confirm = all.getByRole("switch", { name: "Ask before sending email or creating events" }) as HTMLInputElement;
    expect(confirm.checked).toBe(true);
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() => expect(mock.updateDotSettings).toHaveBeenLastCalledWith({ confirmExternalActions: false }));
    await waitFor(() => expect((all.getByRole("combobox", { name: "Default model for Dots" }) as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(all.getByRole("combobox", { name: "Default model for Dots" }), { target: { value: "codex-v1|gpt|high" } });
    await waitFor(() => expect(mock.updateDotSettings).toHaveBeenLastCalledWith({ defaultModelConfigId: "codex-v1|gpt|high" }));
    expect(updated).toHaveBeenCalled();
    // The other parts fold into cards with a summary, and load only when opened.
    expect(screen.queryByRole("region", { name: "Connected accounts" })).toBeNull();
    expect(mock.connectors).not.toHaveBeenCalled();
    for (const part of ["Messages from your Dot", "Connected accounts", "Slack and Teams", "Each Dot"]) {
      const toggle = screen.getByRole("button", { name: new RegExp(`^${part}`) });
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(toggle);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
    }
    expect(screen.getByRole("button", { name: /^Messages from your Dot/ }).textContent).toContain("On: a Dot tells you about new email");
    expect(await screen.findByRole("region", { name: "Connected accounts" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Slack and Teams" })).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "Orbit settings" })).toBeTruthy();
    window.removeEventListener(DOTS_UPDATED_EVENT, updated);
  });
  it("opens the requested Dot and section, and keeps evaluation for administrators", async () => {
    const { rerender } = render(<DotsSettingsCard roomId="room:1" isAdmin={false} request={{ dotId: dots[1]!.dotId, section: "memory", nonce: 1 }} />);
    const tabs = within(await screen.findByRole("tablist", { name: "Nova settings" }));
    expect(tabs.getByRole("tab", { name: "Memory" }).getAttribute("aria-selected")).toBe("true");
    expect(tabs.queryByRole("tab", { name: "Evaluation" })).toBeNull();
    expect(screen.getByRole("button", { name: "Nova" }).getAttribute("aria-pressed")).toBe("true");
    rerender(<DotsSettingsCard roomId="room:1" isAdmin request={{ dotId: dots[0]!.dotId, section: "profile", nonce: 2 }} />);
    const orbitTabs = within(await screen.findByRole("tablist", { name: "Orbit settings" }));
    expect(orbitTabs.getByRole("tab", { name: "Evaluation" })).toBeTruthy();
    expect(screen.getByRole("form", { name: "Orbit profile" })).toBeTruthy();
    fireEvent.keyDown(orbitTabs.getByRole("tab", { name: "Profile" }), { key: "ArrowRight" });
    expect(orbitTabs.getByRole("tab", { name: "Personality" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "How Orbit answers your tone" })).toBeTruthy();
    expect(screen.getByText("Steady mission commander")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Orbit's expressions" })).getAllByRole("button")).toHaveLength(16);
    fireEvent.keyDown(orbitTabs.getByRole("tab", { name: "Personality" }), { key: "ArrowRight" });
    expect(orbitTabs.getByRole("tab", { name: "Reminders and goals" }).getAttribute("aria-selected")).toBe("true");
  });
  it("applies a request once, so reopening Settings does not jump back to it", async () => {
    const request = { dotId: dots[1]!.dotId, section: "memory" as const, nonce: 41 };
    const first = render(<DotsSettingsCard roomId="room:1" isAdmin={false} request={request} />);
    await screen.findByRole("tablist", { name: "Nova settings" });
    first.unmount();
    render(<DotsSettingsCard roomId="room:1" isAdmin={false} request={request} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Each Dot/ }));
    await screen.findByRole("tablist", { name: "Orbit settings" });
    expect(screen.getByRole("button", { name: "Nova" }).getAttribute("aria-pressed")).toBe("false");
  });
  it("sets the Dot's own messages: on by default, which Dot, sources, cadence, daily limit and quiet hours", async () => {
    let current = settings;
    mock.updateDotSettings.mockImplementation(async (patch: { proactive?: Partial<DotUserSettings["proactive"]> }) => {
      current = { ...current, proactive: { ...current.proactive, ...patch.proactive } }; return { settings: current };
    });
    render(<DotsSettingsCard roomId="room:1" isAdmin={false} request={{ section: "proactive", nonce: 1 }} />);
    const group = within(await screen.findByRole("region", { name: "Messages from your Dot" }));
    expect((group.getByRole("switch", { name: "Let a Dot message me about new email and upcoming events" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.change(group.getByRole("combobox", { name: "Dot that writes" }), { target: { value: dots[2]!.dotId } });
    await waitFor(() => expect(mock.updateDotSettings).toHaveBeenLastCalledWith({ proactive: { dotId: dots[2]!.dotId } }));
    await waitFor(() => expect((group.getByRole("combobox", { name: "Check every" }) as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(group.getByRole("combobox", { name: "Check every" }), { target: { value: "120" } });
    await waitFor(() => expect(mock.updateDotSettings).toHaveBeenLastCalledWith({ proactive: { intervalMinutes: 120 } }));
    await waitFor(() => expect((group.getByLabelText("Quiet hours from") as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(group.getByLabelText("Quiet hours from"), { target: { value: "22:30" } });
    await waitFor(() => expect(mock.updateDotSettings).toHaveBeenLastCalledWith({ proactive: { quietHours: { start: "22:30", end: "08:00" } } }));
    await waitFor(() => expect((group.getByRole("switch", { name: "New email" }) as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(group.getByRole("switch", { name: "Let a Dot message me about new email and upcoming events" }));
    await waitFor(() => expect(mock.updateDotSettings).toHaveBeenLastCalledWith({ proactive: { enabled: false } }));
    await waitFor(() => expect(group.queryByRole("combobox", { name: "Dot that writes" })).toBeNull());
  });
  it("sends the Dot's own messages to Slack too only once a Slack account is linked", async () => {
    let current = settings;
    mock.updateDotSettings.mockImplementation(async (patch: { proactive?: Partial<DotUserSettings["proactive"]> }) => {
      current = { ...current, proactive: { ...current.proactive, ...patch.proactive } }; return { settings: current };
    });
    // Space without a Slack app shows no Slack choice.
    const { unmount } = render(<DotsSettingsCard roomId="room:1" isAdmin={false} request={{ section: "proactive", nonce: 11 }} />);
    await screen.findByRole("region", { name: "Messages from your Dot" });
    await waitFor(() => expect(mock.channels).toHaveBeenCalled());
    expect(screen.queryByRole("switch", { name: "Also send to Slack" })).toBeNull();
    unmount();
    mock.channels.mockResolvedValue({ providers: [{ provider: "SLACK", configured: true, reason: null }], identities: [], threads: [] });
    const first = render(<DotsSettingsCard roomId="room:1" isAdmin={false} request={{ section: "proactive", nonce: 12 }} />);
    const unlinked = await screen.findByRole("switch", { name: "Also send to Slack" }) as HTMLInputElement;
    expect(unlinked.disabled).toBe(true);
    expect(screen.getByText("Link your Slack account under Slack and Teams first.")).toBeTruthy();
    first.unmount();
    mock.channels.mockResolvedValue({ providers: [{ provider: "SLACK", configured: true, reason: null }],
      identities: [{ identityId: `channel_identity:${"1".repeat(32)}`, provider: "SLACK", tenantId: "T1", displayName: null, linkedAt: "2026-10-13T00:00:00.000Z" }], threads: [] });
    render(<DotsSettingsCard roomId="room:1" isAdmin={false} request={{ section: "proactive", nonce: 13 }} />);
    await waitFor(() => expect((screen.getByRole("switch", { name: "Also send to Slack" }) as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("switch", { name: "Also send to Slack" }));
    await waitFor(() => expect(mock.updateDotSettings).toHaveBeenLastCalledWith({ proactive: { alsoSlack: true } }));
    expect(screen.getByText("The same message, as a direct message from the Space app.")).toBeTruthy();
  });
  it("shows what the Dot's own messages cost in model use, never a price it does not know", async () => {
    mock.dotProactiveUsage.mockResolvedValue({ ...summarizeDotProactiveUsage([], 7), calls: 12, failedCalls: 1, measuredCalls: 11, totalTokens: 48210,
      estimatedCostUsd: 0.0391, estimatedCalls: 11, unknownCostCalls: 1, unknownCostReason: "No usage was reported, so no price applies.", priceCatalogVersions: ["prices-2026-10"] });
    render(<DotsSettingsCard roomId="room:1" isAdmin={false} request={{ section: "proactive", nonce: 21 }} />);
    expect(await screen.findByText("Model use, last 7 days: 12 model calls (1 failed), 48,210 tokens (1 without a usage report), about $0.04 for 11 of them; "
      + "the others have no price (prices-2026-10).")).toBeTruthy();
    expect(mock.dotProactiveUsage).toHaveBeenCalledWith(7);
    const none = summarizeDotProactiveUsage([], 7);
    expect(proactiveUsageText(none)).toBe("Model use, last 7 days: no check needed the model.");
    expect(proactiveUsageText({ ...none, calls: 1, measuredCalls: 1, totalTokens: 900, unknownCostCalls: 1,
      unknownCostReason: "No price catalog is configured; 900 tokens were measured." }))
      .toBe("Model use, last 7 days: 1 model call, 900 tokens, cost unknown: No price catalog is configured; 900 tokens were measured.");
    expect(proactiveUsageText({ ...none, calls: 2, measuredCalls: 2, totalTokens: 1500, estimatedCostUsd: 0.0012, estimatedCalls: 2, priceCatalogVersions: ["p1"] }))
      .toBe("Model use, last 7 days: 2 model calls, 1,500 tokens, about $0.0012 (p1).");
  });
  it("says when model use cannot be read", async () => {
    mock.dotProactiveUsage.mockRejectedValue(Error("down"));
    render(<DotsSettingsCard roomId="room:1" isAdmin={false} request={{ section: "proactive", nonce: 22 }} />);
    expect(await screen.findByText("Model use is unavailable.")).toBeTruthy();
  });
  it("says when the Dots cannot load and retries", async () => {
    mock.dots.mockRejectedValueOnce(Error("down"));
    render(<DotsSettingsCard roomId={null} isAdmin={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("region", { name: "All Dots" })).toBeTruthy();
  });
  it("opens a settings section on request", () => {
    const { rerender } = render(<SettingsSections request={null}>
      <SettingsDisclosure sectionKey="dots" title="Dots" description="d" scope="Your account" icon={Bot}><p>Dots content</p></SettingsDisclosure>
    </SettingsSections>);
    expect(screen.queryByText("Dots content")).toBeNull();
    rerender(<SettingsSections request={{ key: "dots", nonce: 1 }}>
      <SettingsDisclosure sectionKey="dots" title="Dots" description="d" scope="Your account" icon={Bot}><p>Dots content</p></SettingsDisclosure>
    </SettingsSections>);
    expect(screen.getByText("Dots content")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dots" }).getAttribute("aria-expanded")).toBe("true");
  });
});
