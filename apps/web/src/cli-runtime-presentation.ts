import { CLI_PANE_TYPES, isAgentRuntimeReady, type AgentRuntime } from "@space/contracts";
import autohandIconUrl from "./assets/autohand-icon.png";
import claudeLogoUrl from "./assets/claude-logo.svg";
import codexLogoUrl from "./assets/codex-logo.svg";
import copilotLogoUrl from "./assets/copilot-logo.svg";
import cursorLogoUrl from "./assets/cursor-logo.svg";
import deepseekLogoUrl from "./assets/deepseek-logo.svg";
import geminiLogoUrl from "./assets/gemini-logo.svg";
import grokLogoUrl from "./assets/grok-logo.svg";
import hermesLogoUrl from "./assets/hermes-agent.png";
import kimiLogoUrl from "./assets/kimi-logo.svg";
import openCodeLogoUrl from "./assets/opencode-logo-dark-square.svg";
import qwenCodeLogoUrl from "./assets/qwen-code-logo.svg";

export interface CliRuntimePresentation {
  brand: string;
  displayName: string;
  iconSrc: string;
  id: string;
  shortLabel: string;
}

const cliIcons = {
  opencode: openCodeLogoUrl, codex: codexLogoUrl, claude: claudeLogoUrl, gemini: geminiLogoUrl,
  autohand: autohandIconUrl, qwen: qwenCodeLogoUrl, kimi: kimiLogoUrl, grok: grokLogoUrl,
  deepseek: deepseekLogoUrl, cursor: cursorLogoUrl, copilot: copilotLogoUrl, hermes: hermesLogoUrl
};
export const CLI_RUNTIME_PRESENTATIONS = Object.freeze(CLI_PANE_TYPES.map(type => ({
  ...type, iconSrc: cliIcons[type.brand]
})) satisfies readonly CliRuntimePresentation[]);

export const HARNESS_MAINTENANCE_PRESENTATION = Object.freeze({
  id: "cli:harness",
  brand: "harness",
  displayName: "DeepSeek Harness",
  shortLabel: "Harness",
  iconSrc: deepseekLogoUrl
} as const satisfies CliRuntimePresentation);

export const CLI_MAINTENANCE_PRESENTATIONS = Object.freeze([
  ...CLI_RUNTIME_PRESENTATIONS,
  HARNESS_MAINTENANCE_PRESENTATION
] as const satisfies readonly CliRuntimePresentation[]);

const runtimePresentationById = new Map(
  CLI_MAINTENANCE_PRESENTATIONS.flatMap((presentation) => [
    [presentation.id, presentation] as const,
    [presentation.id.replace(/^cli:/, ""), presentation] as const
  ])
);
const runtimeOrderById = new Map<string, number>(
  CLI_MAINTENANCE_PRESENTATIONS.map((presentation, index) => [presentation.id, index])
);

export function cliRuntimePresentation(runtimeId: string | null | undefined): CliRuntimePresentation | undefined {
  if (!runtimeId) return undefined;
  return runtimePresentationById.get(runtimeId);
}

export function cliRuntimeLabel(runtimeId: string | null | undefined): string | undefined {
  return cliRuntimePresentation(runtimeId)?.displayName;
}

export function compareCliRuntimes(
  left: Pick<CliRuntimePresentation, "id" | "displayName">,
  right: Pick<CliRuntimePresentation, "id" | "displayName">
): number {
  const leftOrder = runtimeOrderById.get(left.id) ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = runtimeOrderById.get(right.id) ?? Number.MAX_SAFE_INTEGER;
  return leftOrder - rightOrder || left.displayName.localeCompare(right.displayName);
}

export function isCliRuntimeTerminalLaunchable(
  runtime: Pick<AgentRuntime, "adapterStatus" | "authState" | "status">
): boolean {
  return isAgentRuntimeReady(runtime);
}
