import { resolve, sep } from "node:path";
import { findCliRuntimeDescriptor } from "./cli-runtime-descriptors.js";

export const codexDirectParityRuntimeId = "cli:codex";
export const codexDirectParityCommand = "codex-vscode-parity";
export const claudeDirectParityRuntimeId = "cli:claude";
export const claudeDirectParityCommand = "claude-vscode-parity";
export const opencodeDirectParityRuntimeId = "cli:opencode";
export const opencodeDirectParityCommand = "opencode-vscode-parity";
export const kimiDirectParityRuntimeId = "cli:kimi";
export const kimiDirectParityCommand = "kimi-vscode-parity";
export const grokDirectParityRuntimeId = "cli:grok";
export const grokDirectParityCommand = "grok-vscode-parity";
export const geminiDirectParityRuntimeId = "cli:gemini";
export const geminiDirectParityCommand = "gemini-vscode-parity";
export const qwenDirectParityRuntimeId = "cli:qwen";
export const qwenDirectParityCommand = "qwen-vscode-parity";

export interface CliParityLayout {
  publicDistribution: boolean;
  cwd: string;
  home: string;
  codexHome: string;
  claudeRoot: string;
  opencodeRoot: string;
  kimiRoot: string;
  grokRoot: string;
  geminiRoot: string;
  qwenRoot: string;
  deepseekRoot: string;
}

export function resolveCliParityLayout(
  env: Record<string, string | undefined> = process.env
): CliParityLayout {
  const publicDistribution = env.SPACE_PUBLIC_DISTRIBUTION === "true";
  const home = publicDistribution ? "/var/lib/spaceapp-cli" : "/var/lib/spaceapp-user";
  const codexHome = publicDistribution ? `${home}/providers/codex` : `${home}/.codex`;
  const providerRoot = (key: string) =>
    publicDistribution ? `${home}/providers/${key}` : `${codexHome}/space-${key}`;
  return {
    publicDistribution,
    cwd: publicDistribution ? "/workspaces" : "/etc",
    home,
    codexHome,
    claudeRoot: providerRoot("claude"),
    opencodeRoot: providerRoot("opencode"),
    kimiRoot: providerRoot("kimi"),
    grokRoot: providerRoot("grok"),
    geminiRoot: providerRoot("gemini"),
    qwenRoot: providerRoot("qwen"),
    deepseekRoot: providerRoot("deepseek")
  };
}

const cliParityLayout = resolveCliParityLayout();

export const codexDirectParityCwd = cliParityLayout.cwd;
export const codexDirectParityHome = cliParityLayout.home;
export const codexDirectParityCodexHome = cliParityLayout.codexHome;
export const codexDirectParityTmp = `${cliParityLayout.codexHome}/tmp`;
export const claudeDirectParityRoot = cliParityLayout.claudeRoot;
export const claudeDirectParityTmp = `${claudeDirectParityRoot}/tmp`;
export const opencodeDirectParityRoot = cliParityLayout.opencodeRoot;
export const opencodeDirectParityTmp = `${opencodeDirectParityRoot}/tmp`;
export const kimiDirectParityRoot = cliParityLayout.kimiRoot;
export const kimiDirectParityTmp = `${kimiDirectParityRoot}/tmp`;
export const grokDirectParityRoot = cliParityLayout.grokRoot;
export const grokDirectParityTmp = `${grokDirectParityRoot}/tmp`;
export const geminiDirectParityRoot = cliParityLayout.geminiRoot;
export const geminiDirectParityTmp = `${geminiDirectParityRoot}/tmp`;
export const qwenDirectParityRoot = cliParityLayout.qwenRoot;
export const qwenDirectParityTmp = `${qwenDirectParityRoot}/tmp`;

export function isCodexDirectParityRuntime(runtimeId: string | null | undefined): boolean {
  return runtimeId === codexDirectParityRuntimeId;
}

export function isClaudeDirectParityRuntime(runtimeId: string | null | undefined): boolean {
  return runtimeId === claudeDirectParityRuntimeId;
}

export function isKimiDirectParityRuntime(runtimeId: string | null | undefined): boolean {
  return runtimeId === kimiDirectParityRuntimeId;
}

export function isGrokDirectParityRuntime(runtimeId: string | null | undefined): boolean {
  return runtimeId === grokDirectParityRuntimeId;
}

export function isDirectOperatorParityRuntime(runtimeId: string | null | undefined): boolean {
  return findCliRuntimeDescriptor(runtimeId) !== null;
}

export function pathInside(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${sep}`);
}

export function isLegacyCodexCliCwd(cwd: string | null | undefined, workspaceRoot: string): boolean {
  if (!cwd) return true;
  const resolved = resolve(cwd);
  return (
    resolved === "/opt/spaceapp" ||
    pathInside(workspaceRoot, resolved) ||
    (cliParityLayout.publicDistribution &&
      (resolved === "/etc" || pathInside("/var/lib/spaceapp-user", resolved)))
  );
}

export function resolveCodexDirectParityCwd(cwd: string | null | undefined, workspaceRoot: string): string {
  return isLegacyCodexCliCwd(cwd, workspaceRoot) ? codexDirectParityCwd : cwd ?? codexDirectParityCwd;
}

export function resolveDirectOperatorParityCwd(cwd: string | null | undefined, workspaceRoot: string): string {
  return isLegacyCodexCliCwd(cwd, workspaceRoot) ? codexDirectParityCwd : cwd ?? codexDirectParityCwd;
}
