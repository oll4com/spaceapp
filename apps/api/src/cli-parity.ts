import { join, resolve, sep } from "node:path";
import { findCliRuntimeDescriptor } from "./cli-runtime-descriptors.js";
import { SPACE_AGENT_HOME, SPACE_INSTALL_ROOT } from "@space/contracts";

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
export const deepseekDirectParityRuntimeId = "cli:deepseek";
export const deepseekDirectParityCommand = "deepseek-vscode-parity";
export const codexDirectParityCwd = "/etc";
export const codexDirectParityHome = SPACE_AGENT_HOME;
// The Codex home of the install the pane runs in: a public install's CLI container (SPACE_CODEX_HOME in its compose
// file), so its turn state, plans and threads are found; stable and dev leave it unset.
export const codexDirectParityCodexHome = process.env.SPACE_CODEX_HOME?.trim() || `${SPACE_AGENT_HOME}/.codex`;
export const codexDirectParityTmp = `${SPACE_AGENT_HOME}/.codex/tmp`;
export const claudeDirectParityRoot = `${SPACE_AGENT_HOME}/.codex/space-claude`;
export const claudeDirectParityTmp = `${claudeDirectParityRoot}/tmp`;
export const opencodeDirectParityRoot = `${SPACE_AGENT_HOME}/.codex/space-opencode`;
export const opencodeDirectParityTmp = `${opencodeDirectParityRoot}/tmp`;
export const kimiDirectParityRoot = `${SPACE_AGENT_HOME}/.codex/space-kimi`;
export const kimiDirectParityTmp = `${kimiDirectParityRoot}/tmp`;
export const grokDirectParityRoot = `${SPACE_AGENT_HOME}/.codex/space-grok`;
export const grokDirectParityTmp = `${grokDirectParityRoot}/tmp`;
export const geminiDirectParityRoot = `${SPACE_AGENT_HOME}/.codex/space-gemini`;
export const geminiDirectParityTmp = `${geminiDirectParityRoot}/tmp`;
export const qwenDirectParityRoot = `${SPACE_AGENT_HOME}/.codex/space-qwen`;
export const hermesDirectParityRuntimeId = "cli:hermes";
export const hermesDirectParityCommand = "hermes-vscode-parity";
export const hermesDirectParityRoot = `${SPACE_AGENT_HOME}/.hermes`;
export const hermesDirectParityTmp = `${hermesDirectParityRoot}/tmp`;
export const qwenDirectParityTmp = `${qwenDirectParityRoot}/tmp`;

export function isCodexDirectParityRuntime(runtimeId: string | null | undefined): boolean {
  return runtimeId === codexDirectParityRuntimeId;
}

export function isClaudeDirectParityRuntime(runtimeId: string | null | undefined): boolean {
  return runtimeId === claudeDirectParityRuntimeId;
}

export function isOpenCodeDirectParityRuntime(runtimeId: string | null | undefined): boolean {
  return runtimeId === opencodeDirectParityRuntimeId;
}

export function isKimiDirectParityRuntime(runtimeId: string | null | undefined): boolean {
  return runtimeId === kimiDirectParityRuntimeId;
}

export function isGrokDirectParityRuntime(runtimeId: string | null | undefined): boolean {
  return runtimeId === grokDirectParityRuntimeId;
}

export function isDeepSeekDirectParityRuntime(runtimeId: string | null | undefined): boolean {
  return runtimeId === deepseekDirectParityRuntimeId;
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
  return resolved === resolve(workspaceRoot);
}

export function resolveCodexDirectParityCwd(cwd: string | null | undefined, workspaceRoot: string): string {
  return isLegacyCodexCliCwd(cwd, workspaceRoot) ? codexDirectParityCwd : cwd ?? codexDirectParityCwd;
}

/**
 * Folder of a room without a project in a public installation: CLIs there run as an
 * unprivileged user who cannot write the operator default (/etc), so each room gets
 * its own folder under the workspace root (a persistent volume).
 */
export function publicRoomWorkspacePath(workspaceRoot: string, roomId: string): string {
  return join(workspaceRoot, roomId.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "room");
}

/** A public install starts a pane that names no project of its own (none, the operator default /etc, the private checkout
 * <install root>) in its room's folder. One rule for the UI start and Space Control's (Nous's panes; 1.2.0 lab 2/11: they ran in /etc). */
export function publicPaneCwd(cwd: string | null | undefined, workspaceRoot: string, roomId: string): string {
  return !cwd || cwd === codexDirectParityCwd || cwd === SPACE_INSTALL_ROOT ? publicRoomWorkspacePath(workspaceRoot, roomId) : cwd;
}

export function resolveDirectOperatorParityCwd(cwd: string | null | undefined, workspaceRoot: string): string {
  return isLegacyCodexCliCwd(cwd, workspaceRoot) ? codexDirectParityCwd : cwd ?? codexDirectParityCwd;
}
