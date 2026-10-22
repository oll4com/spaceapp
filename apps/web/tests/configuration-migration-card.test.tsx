import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigurationMigrationCard } from "../src/features/settings/ConfigurationMigrationCard.js";
import { createDemoRuntime } from "../src/demo/demo-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("ConfigurationMigrationCard", () => {
  it("renders export and import sections with default mode", () => {
    render(<ConfigurationMigrationCard canManageInstallation />);

    expect(screen.getByText("Save a backup")).toBeDefined();
    expect(screen.getByText("Restore from a backup")).toBeDefined();
    expect(screen.getByText("Download backup file")).toBeDefined();

    const replaceRadio = screen.getByRole("radio", { name: /Replace/i }) as HTMLInputElement;
    const mergeRadio = screen.getByRole("radio", { name: /Merge/i }) as HTMLInputElement;

    // Merge is the default; Replace deletes and must be chosen (Record Retention Invariant).
    expect(replaceRadio.checked).toBe(false);
    expect(mergeRadio.checked).toBe(true);

    fireEvent.click(replaceRadio);
    expect(replaceRadio.checked).toBe(true);
    expect(mergeRadio.checked).toBe(false);

    const apiKeysSwitch = screen.getByRole("switch", { name: /Include Provider API Keys/i }) as HTMLInputElement;
    const credsSwitch = screen.getByRole("switch", { name: /Include CLI logins/i }) as HTMLInputElement;

    expect(apiKeysSwitch.checked).toBe(false);
    expect(credsSwitch.checked).toBe(false);

    fireEvent.click(apiKeysSwitch);
    expect(apiKeysSwitch.checked).toBe(true);

    fireEvent.click(credsSwitch);
    expect(credsSwitch.checked).toBe(true);
  });

  it("offers ordinary exports without installation import or secret controls by default", () => {
    render(<ConfigurationMigrationCard />);
    expect(screen.getByRole("button", { name: "Download backup file" })).toBeTruthy();
    expect(screen.queryByText("Restore from a backup")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /API Keys/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Credentials/ })).toBeNull();
  });

  it("routes export through the selected runtime without contacting native fetch", async () => {
    const { runtime } = createDemoRuntime();
    const exportConfiguration = vi.fn().mockRejectedValue(new Error("Selected runtime handles configuration locally"));
    installSpaceRuntime({ ...runtime, api: { ...runtime.api, exportConfiguration } });
    const fetch = vi.fn().mockRejectedValue(new Error("Unexpected native fetch"));
    vi.stubGlobal("fetch", fetch);
    render(<ConfigurationMigrationCard />);
    fireEvent.click(screen.getByRole("button", { name: "Download backup file" }));
    await waitFor(() => expect(exportConfiguration).toHaveBeenCalledExactlyOnceWith({ includeApiKeys: false, includeCredentials: false }));
    expect(await screen.findByText("Selected runtime handles configuration locally")).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("exports secrets only with a confirmed passphrase of at least 12 characters", async () => {
    const { runtime } = createDemoRuntime();
    const exportConfiguration = vi.fn().mockResolvedValue({ source: { instance: "vm207" }, encrypted: {}, sections: {} });
    installSpaceRuntime({ ...runtime, api: { ...runtime.api, exportConfiguration } });
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:test", revokeObjectURL: () => undefined }));
    render(<ConfigurationMigrationCard canManageInstallation />);
    fireEvent.click(screen.getByRole("switch", { name: /Include Provider API Keys/i }));
    fireEvent.click(screen.getByRole("button", { name: "Download backup file" }));
    expect(await screen.findByText("Enter a passphrase of at least 12 characters.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Passphrase/), { target: { value: "twelve chars ok" } });
    fireEvent.change(screen.getByLabelText("Confirm passphrase"), { target: { value: "twelve chars no" } });
    fireEvent.click(screen.getByRole("button", { name: "Download backup file" }));
    expect(await screen.findByText("The two passphrases do not match.")).toBeTruthy();
    expect(exportConfiguration).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Confirm passphrase"), { target: { value: "twelve chars ok" } });
    fireEvent.click(screen.getByRole("button", { name: "Download backup file" }));
    await waitFor(() => expect(exportConfiguration).toHaveBeenCalledExactlyOnceWith({ includeApiKeys: true, includeCredentials: false, passphrase: "twelve chars ok" }));
  });

  it.each(["exportConfiguration", "inspectConfiguration", "importConfiguration"] as const)("reports unsupported demo %s without claiming success", async (method) => {
    const { runtime } = createDemoRuntime();
    const fetch = vi.fn().mockRejectedValue(new Error("Unexpected native fetch"));
    vi.stubGlobal("fetch", fetch);
    await expect(Reflect.apply(runtime.api[method], runtime.api, [{}])).rejects.toMatchObject({ code: "DEMO_UNSUPPORTED" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("imports with Merge by default and asks before a Replace deletes anything (Record Retention Invariant)", async () => {
    const { runtime } = createDemoRuntime();
    const inspectConfiguration = vi.fn().mockResolvedValue({ valid: true, version: "1.1.0", exportedAt: "2026-10-20T00:00:00.000Z", source: { instance: "stable", exportedBy: "user:operator" },
      summary: { roomsCount: 1, panesCount: 1, hasUserSettings: false, userLinksCount: 0, clipboardItemsCount: 0, taskItemsCount: 0, providersCount: 0, cliRuntimeSettingsCount: 0, apiKeysCount: 0, credentialsCount: 0 },
      secrets: { encrypted: false, cliAuthRuntimes: [] }, warnings: [], missingProjectRoots: [] });
    const importConfiguration = vi.fn().mockResolvedValue({ success: true, targetUserId: "user:operator", mode: "merge", stats: { roomsImported: 1, panesImported: 1, linksImported: 0, clipboardImported: 0, tasksImported: 0 }, warnings: [] });
    installSpaceRuntime({ ...runtime, api: { ...runtime.api, inspectConfiguration, importConfiguration } });
    const { container } = render(<ConfigurationMigrationCard canManageInstallation />);
    const json = JSON.stringify({ format: "spaceapp-configuration-bundle" });
    const file = Object.assign(new File([json], "backup.spaceapp", { type: "application/json" }), { text: async () => json });
    fireEvent.change(container.querySelector("input[type=file]")!, { target: { files: [file] } });

    fireEvent.click(await screen.findByRole("button", { name: /Apply & Import \(MERGE\)/ }));
    await waitFor(() => expect(importConfiguration).toHaveBeenCalledTimes(1));
    expect(importConfiguration.mock.calls[0]![0]).toMatchObject({ mode: "merge" });
    expect(importConfiguration.mock.calls[0]![0]).not.toHaveProperty("confirmReplace");

    fireEvent.change(container.querySelector("input[type=file]")!, { target: { files: [file] } });
    fireEvent.click(screen.getByRole("radio", { name: /Replace/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Apply & Import \(REPLACE\)/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(importConfiguration).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /Apply & Import \(REPLACE\)/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace everything" }));
    await waitFor(() => expect(importConfiguration).toHaveBeenCalledTimes(2));
    expect(importConfiguration.mock.calls[1]![0]).toMatchObject({ mode: "replace", confirmReplace: true });
  });
});
