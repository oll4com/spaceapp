import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CliProviderSettingsResponse } from "@space/contracts";
import { CliProvidersSettingsCard } from "../src/features/cli-providers-settings/CliProvidersSettingsCard.js";
import { SettingsSections } from "../src/features/settings/SettingsDisclosure.js";

const mockResponse: CliProviderSettingsResponse = {
  providers: [
    {
      id: "opencode",
      name: "OpenCode Zen",
      description: "Free curated coding models",
      enabled: true,
      modelsCount: 10,
      isCustom: false
    },
    {
      id: "opencode-go",
      name: "OpenCode Go",
      description: "Official OpenCode Go subscription models",
      enabled: false,
      modelsCount: 29,
      isCustom: false
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      description: "Unified router across multiple AI model providers",
      enabled: true,
      modelsCount: 392,
      isCustom: false
    }
  ],
  disabledProviders: ["opencode-go"],
  checkedAt: "2026-10-03T10:00:00.000Z"
};

describe("CliProvidersSettingsCard", () => {
  it("renders disclosure and provider toggle switches", async () => {
    const client = {
      cliProviderSettings: vi.fn().mockResolvedValue(mockResponse)
    };

    render(
      <SettingsSections>
        <CliProvidersSettingsCard canManage={true} client={client} initialOpen={true} />
      </SettingsSections>
    );

    await waitFor(() => {
      expect(screen.getByRole("switch", { name: "Enable OpenCode Zen" })).toBeTruthy();
      expect(screen.getByRole("switch", { name: "Enable OpenCode Go" })).toBeTruthy();
      expect(screen.getByRole("switch", { name: "Enable OpenRouter" })).toBeTruthy();
    });

    const opencodeToggle = screen.getByRole("switch", { name: "Enable OpenCode Zen" }) as HTMLInputElement;
    expect(opencodeToggle.checked).toBe(true);

    const opencodeGoToggle = screen.getByRole("switch", { name: "Enable OpenCode Go" }) as HTMLInputElement;
    expect(opencodeGoToggle.checked).toBe(false);
  });

  it("handles toggling an individual provider", async () => {
    const updateSpy = vi.fn().mockResolvedValue({
      ...mockResponse,
      providers: mockResponse.providers.map((p) => (p.id === "opencode-go" ? { ...p, enabled: true } : p)),
      disabledProviders: []
    });
    const client = {
      cliProviderSettings: vi.fn().mockResolvedValue(mockResponse),
      updateCliProviderSetting: updateSpy
    };

    render(
      <SettingsSections>
        <CliProvidersSettingsCard canManage={true} client={client} initialOpen={true} />
      </SettingsSections>
    );

    await waitFor(() => {
      expect(screen.getByRole("switch", { name: "Enable OpenCode Go" })).toBeTruthy();
    });

    const toggle = screen.getByRole("switch", { name: "Enable OpenCode Go" });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith("opencode-go", true);
    });
  });

  it("handles enable all and disable all actions", async () => {
    const updateAllSpy = vi.fn().mockResolvedValue({
      ...mockResponse,
      providers: mockResponse.providers.map((p) => ({ ...p, enabled: false })),
      disabledProviders: ["opencode", "opencode-go", "openrouter"]
    });
    const client = {
      cliProviderSettings: vi.fn().mockResolvedValue(mockResponse),
      updateAllCliProviders: updateAllSpy
    };

    render(
      <SettingsSections>
        <CliProvidersSettingsCard canManage={true} client={client} initialOpen={true} />
      </SettingsSections>
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Disable all providers" })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Disable all providers" }));

    await waitFor(() => {
      expect(updateAllSpy).toHaveBeenCalledWith(false);
    });
  });

  it("shows a failed update as a dismissible notice and reloads the providers", async () => {
    const client = {
      cliProviderSettings: vi.fn().mockResolvedValue(mockResponse),
      updateCliProviderSetting: vi.fn().mockRejectedValue(new Error("OpenCode configuration is read-only."))
    };
    render(
      <SettingsSections>
        <CliProvidersSettingsCard canManage={true} client={client} initialOpen={true} />
      </SettingsSections>
    );
    fireEvent.click(await screen.findByRole("switch", { name: "Enable OpenCode Go" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("OpenCode configuration is read-only.");
    expect(document.querySelector(".validation-result")).toBeNull();
    await waitFor(() => expect(client.cliProviderSettings).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss message" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
