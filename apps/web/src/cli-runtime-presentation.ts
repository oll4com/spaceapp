import { isAgentRuntimeReady, type AgentRuntime } from "@space/contracts";
import claudeLogoUrl from "./assets/claude-logo.svg";
import codexLogoUrl from "./assets/codex-logo.svg";
import deepseekLogoUrl from "./assets/deepseek-logo.svg";
import geminiLogoUrl from "./assets/gemini-logo.svg";
import grokLogoUrl from "./assets/grok-logo.svg";
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

export const CLI_RUNTIME_PRESENTATIONS = Object.freeze([
  { id: "cli:codex", brand: "codex", displayName: "Codex CLI", shortLabel: "Codex", iconSrc: codexLogoUrl },
  { id: "cli:claude", brand: "claude", displayName: "Claude Code CLI", shortLabel: "Claude Code", iconSrc: claudeLogoUrl },
  { id: "cli:gemini", brand: "gemini", displayName: "Gemini CLI", shortLabel: "Gemini", iconSrc: geminiLogoUrl },
  { id: "cli:opencode", brand: "opencode", displayName: "OpenCode CLI", shortLabel: "OpenCode", iconSrc: openCodeLogoUrl },
  { id: "cli:qwen", brand: "qwen", displayName: "Qwen Code CLI", shortLabel: "Qwen Code", iconSrc: qwenCodeLogoUrl },
  { id: "cli:kimi", brand: "kimi", displayName: "Kimi Code CLI", shortLabel: "Kimi Code", iconSrc: kimiLogoUrl },
  { id: "cli:grok", brand: "grok", displayName: "Grok Build CLI", shortLabel: "Grok Build", iconSrc: grokLogoUrl },
  { id: "cli:deepseek", brand: "deepseek", displayName: "DeepSeek CLI", shortLabel: "DeepSeek", iconSrc: deepseekLogoUrl }
] as const satisfies readonly CliRuntimePresentation[]);

const runtimePresentationById = new Map(
  CLI_RUNTIME_PRESENTATIONS.flatMap((presentation) => [
    [presentation.id, presentation] as const,
    [presentation.id.replace(/^cli:/, ""), presentation] as const
  ])
);
const runtimeOrderById = new Map<string, number>(
  CLI_RUNTIME_PRESENTATIONS.map((presentation, index) => [presentation.id, index])
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
