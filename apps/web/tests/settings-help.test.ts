/* @vitest-environment node */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { uiText } from "../src/features/ui-language/ui-language.js";

/**
 * Every Settings entry has its ⓘ help in English and Greek (Nous request nous_msg:1b58b47e20e441ca9c6898fe): a row's label is a
 * SettingsLabel, a switch has `help`, and every label and help literal has its Greek in the EL table. A new Settings card joins
 * SETTINGS_FILES.
 */
const SETTINGS_FILES = [
  "agent-files/SignatureLibrary.tsx",
  "agent-pane/DotsSettingsCard.tsx",
  "agent-tools/AgentCapabilitiesCard.tsx",
  "app-diagnostics/AppDiagnosticsSettingsCard.tsx",
  "auth/AppDevicesManager.tsx",
  "auth/GoogleAccountSettingsCard.tsx",
  "auth/GoogleAccountsManager.tsx",
  "auth/InstanceLinksManager.tsx",
  "auth/MobileAppManager.tsx",
  "browser-pane/YouTubeSummarySettingsCard.tsx",
  "cli-accounts/CliAccountsPanel.tsx",
  "cli-dock/CliDock.tsx",
  "cli-providers-settings/CliProvidersSettingsCard.tsx",
  "cli-runtime-settings/CliRuntimeSettingsCard.tsx",
  "copilot-kit/CopilotSettingsCard.tsx",
  "date-time-settings/DateTimeSettingsCard.tsx",
  "history-period/HistoryPeriodSettingsCard.tsx",
  "job-apply-pane/JobCopilotSettingsCard.tsx",
  "keyboard-autocorrect/KeyboardAutocorrectSettingsCard.tsx",
  "notifications/NotificationSettingsCard.tsx",
  "nous/NousServerOperations.tsx",
  "nous/NousSettingsCard.tsx",
  "nous/NousSharedMemory.tsx",
  "pane-hibernate/PaneHibernateSettingsCard.tsx",
  "plugins/PluginsSettingsCard.tsx",
  "prompt-variables/PromptVariablesSettingsCard.tsx",
  "releases/ReleasesSettingsCard.tsx",
  "rooms-dock/RoomLimitSettingsCard.tsx",
  "settings/AgentSettingsDock.tsx",
  "settings/ConfigurationMigrationCard.tsx",
  "settings/DocksSettingsCard.tsx",
  "settings/EnvironmentPresetCard.tsx",
  "settings/LoginPasswordSettingsCard.tsx",
  "settings/PanesSettingsCard.tsx",
  "settings/TransferSettingsCard.tsx",
  "settings/WidgetsSettingsCard.tsx",
  "settings/WireGuardFileSettingsCard.tsx",
  "source-control-publishing/SourceControlPublishingCard.tsx",
  "t3code-settings/T3CodeServiceSettingsCard.tsx",
  "telegram-integration/TelegramIntegrationCard.tsx",
  "ui-language/UiLanguageSettingsCard.tsx",
  "ui-theme/UiThemeSettingsCard.tsx",
  "voice-input/CliPaneControlsSettingsCard.tsx",
  "voice-input/VoiceSettingsCard.tsx"
];

/** Product names a label shows as written in every language. */
const NAMES = new Set(["Liquid Glass"]);
const features = fileURLToPath(new URL("../src/features/", import.meta.url));
const read = (file: string) => readFileSync(join(features, file), "utf8");
const all = (source: string, pattern: RegExp) => [...source.matchAll(pattern)].map((match) => match[1]!);
/**
 * A component's attributes: a SpaceToggle up to its `/>` (it takes no children), a SettingsLabel up to the end of its opening tag
 * (its literal attributes hold no `>`), a SettingsDisclosure up to the `>` ending its line.
 */
const elements = (source: string, tag: string) =>
  all(source, tag === "SettingsDisclosure" ? /<SettingsDisclosure\b([\s\S]*?)["}]>\s*\n/g
    : tag === "SettingsLabel" ? /<SettingsLabel\b([^>]*)>/g : new RegExp(`<${tag}\\b([\\s\\S]*?)/>`, "g"));

describe("Settings help (ⓘ) in English and Greek", () => {
  it("every label and help literal has its Greek", () => {
    const missing: string[] = [];
    for (const file of SETTINGS_FILES) {
      const source = read(file);
      const literals = [
        ...all(source, /\bhelp="([^"]+)"/g),
        ...all(source, /\bhelp: "((?:[^"\\]|\\.)+)"/g).map((text) => JSON.parse(`"${text}"`) as string),
        ...all(source, /\blabel: "([^"]+)", help:/g),
        ...elements(source, "SettingsLabel").flatMap((attributes) => all(attributes, /\blabel="([^"]+)"/g)),
        ...all(source, /<InfoTip text=\{t\("((?:[^"\\]|\\.)+)"\)\}/g).map((text) => JSON.parse(`"${text}"`) as string)
      ];
      for (const text of literals) if (!NAMES.has(text) && uiText("el", text) === text) missing.push(`${file}: ${text}`);
    }
    expect(missing).toEqual([]);
  });

  it("every switch and every section has help, and no row label is written without its ⓘ", () => {
    const bare: string[] = [];
    for (const file of SETTINGS_FILES) {
      const source = read(file);
      for (const attributes of elements(source, "SpaceToggle")) if (!/\bhelp=/.test(attributes)) bare.push(`${file}: SpaceToggle ${attributes.slice(0, 80).replace(/\s+/g, " ")}`);
      for (const attributes of elements(source, "SettingsDisclosure")) if (!/\bhelp=/.test(attributes)) bare.push(`${file}: SettingsDisclosure ${attributes.slice(0, 80).replace(/\s+/g, " ")}`);
      // A static row label (`<strong>Engine</strong>` or `<strong>{t("Engine")}</strong>`) goes through SettingsLabel.
      for (const row of all(source, /settings-flat-row-copy"[^>]*>\s*(<strong>(?:[A-Z]|\{t\(")[^<]*)/g)) bare.push(`${file}: ${row}`);
    }
    expect(bare).toEqual([]);
  });

  it("finds what it guards", () => {
    expect(elements(`<SpaceToggle label="A" help="B" />`, "SpaceToggle")[0]).toMatch(/help=/);
    expect(all(`<span className="settings-flat-row-copy"><strong>Engine</strong>`, /settings-flat-row-copy"[^>]*>\s*(<strong>(?:[A-Z]|\{t\(")[^<]*)/g)).toHaveLength(1);
    expect(elements(`<SettingsLabel label="A" help="B">{x ? <b aria-label="C" /> : null}</SettingsLabel>`, "SettingsLabel")).toEqual([' label="A" help="B"']);
    expect(uiText("el", "About {label}", { label: "X" })).not.toBe("About X");
  });
});
