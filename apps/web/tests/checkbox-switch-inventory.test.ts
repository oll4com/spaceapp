import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith(".tsx") ? [path] : [];
  });
}

describe("Space checkbox switch inventory", () => {
  it("routes every native checkbox through SpaceToggle", () => {
    const matches = sourceFiles("src").flatMap((path) => {
      const count = readFileSync(path, "utf8").match(/type="checkbox"/g)?.length ?? 0;
      return Array.from({ length: count }, () => relative("src", path));
    }).sort();

    // On/off settings use SpaceToggle. Native checkboxes are kept only where a checkbox is the right
    // control: picking several items from a list, or acknowledging a destructive action. A new
    // checkbox anywhere else has to be a SpaceToggle or be added here with its reason.
    // The Gateway filters, key efforts/accounts and the CLI disable acknowledgement use SpaceToggle since 9c5fc521df.
    const allowed = [
      "features/nous/NousDock.tsx", // Nous's On/Off power switch (role="switch", operator request 2026-10-17)
      "features/vault/VaultDock.tsx", // select all dead sites for the bulk delete (picking several items from a list, 599dc90542)
      "features/vault/VaultDock.tsx", // select one dead site for the bulk delete
      "features/ui-controls/SpaceToggle.tsx"
    ].sort();
    expect(matches).toEqual(allowed);

    // The CLI runtime VPN and on/off switches and the CLI shortcut list use the shared switch too.
    const runtimeCard = readFileSync("src/features/cli-runtime-settings/CliRuntimeSettingsCard.tsx", "utf8");
    expect(runtimeCard).toContain("cli-runtime-vpn-switch");
    expect(runtimeCard).toContain("cli-runtime-enabled-switch");
    // VPN, on/off and (since 9c5fc521df) the acknowledgement before closing panes to disable a CLI.
    expect(runtimeCard.match(/<SpaceToggle\b/g)).toHaveLength(3);
    expect(readFileSync("src/features/terminal-pane/CliShortcutVisibilitySettings.tsx", "utf8")).toContain("<SpaceToggle");
  });

  it("does not let legacy voice-checkbox CSS override the shared switch grid", () => {
    const styles = readFileSync("src/styles.css", "utf8");
    const flatSettings = readFileSync("src/features/settings/flat-settings.css", "utf8");
    const voiceToggleBlock = styles.match(/\.voice-toggle\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(voiceToggleBlock).not.toMatch(/display\s*:\s*inline-flex/);
    expect(voiceToggleBlock).not.toMatch(/align-items\s*:/);
    expect(styles).not.toMatch(/\.voice-toggle\s+input\s*\{/);
    expect(flatSettings).toMatch(/\.settings-flat-card,[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(flatSettings).toMatch(/\.settings-flat-card \.settings-flat-heading strong,[\s\S]*?overflow-wrap:\s*anywhere/);
    expect(flatSettings).toMatch(/\.settings-flat-card \.empty-mini[\s\S]*?overflow-wrap:\s*anywhere/);
  });
});
