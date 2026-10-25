import { CLI_PANE_TYPES, type AgentRuntime, type AgentRuntimeRegistry, type CopilotLaunchSettings, type Pane } from "@space/contracts";
import { api } from "../../api.js";
import { isCliRuntimeTerminalLaunchable } from "../../cli-runtime-presentation.js";
import { hasCliAccountProfiles } from "../cli-accounts/cli-account-memory.js";
import type { CopilotKind } from "./copilot-kind.js";

export interface CopilotRuntimeOption {
  runtime: AgentRuntime;
  ready: boolean;
  recommended: boolean;
}

/** The agent a copilot pane opens with: its CLI and the account that CLI starts on (null: the CLI's own default). */
export interface CopilotAgentChoice {
  terminalRuntimeId: string;
  accountProfileId: string | null;
}

/** CLI runtimes in catalog order, the kind's preferred CLI flagged as the recommended agent. */
export function copilotRuntimeOptions(registry: AgentRuntimeRegistry | null, kind: CopilotKind): CopilotRuntimeOption[] {
  if (!registry) return [];
  const byId = new Map(registry.data.map((runtime) => [runtime.id, runtime]));
  return CLI_PANE_TYPES.flatMap((type) => {
    const runtime = byId.get(type.id);
    if (!runtime || !runtime.capabilities.includes("CLI")) return [];
    return [{ runtime, ready: isCliRuntimeTerminalLaunchable(runtime), recommended: runtime.id === kind.preferredRuntimeId }];
  });
}

/** The runtime a new copilot should start on: the recommended CLI when ready, else the first ready CLI. */
export function defaultCopilotRuntimeId(options: CopilotRuntimeOption[]): string | null {
  const preferred = options.find((option) => option.recommended && option.ready);
  return (preferred ?? options.find((option) => option.ready))?.runtime.id ?? null;
}

/** The catalog's short name of a CLI ("Claude Code"), for buttons and notices. */
export function copilotAgentLabel(runtimeId: string, runtime?: AgentRuntime | null): string {
  return CLI_PANE_TYPES.find((type) => type.id === runtimeId)?.shortLabel ?? runtime?.displayName ?? runtimeId;
}

/** Only CLIs with account profiles carry an account; every other CLI starts on its own sign-in (Codex: Space Gateway). */
export function copilotAccountFor(runtimeId: string, accountProfileId: string | null | undefined): string | null {
  return hasCliAccountProfiles(runtimeId) && accountProfileId ? accountProfileId : null;
}

/**
 * The account a copilot pane's CLI runs on now: its active CLI session's ("main" for the CLI's own sign-in), for
 * CLIs with account profiles. The pane row never holds it (the Browser Host parses pane rows with its start-up contracts).
 */
export async function loadPaneAccountProfileId(paneId: string, runtimeId: string | null | undefined): Promise<string | null> {
  if (!runtimeId || !hasCliAccountProfiles(runtimeId)) return null;
  const active = await api.activeCliSession(paneId, { includeTranscript: false }).catch(() => null);
  return active?.session.runtimeId === runtimeId ? active.session.accountProfileId ?? "main" : null;
}

export type CopilotLaunchDecision =
  | { open: true; choice: CopilotAgentChoice; label: string }
  | { open: false; preselect: CopilotLaunchSettings | null; notice: string | null };

/**
 * Whether a new copilot pane opens at once on the remembered agent, or the launch dialog asks first:
 * never chosen, "ask every time", or the remembered CLI is not ready (the dialog says why).
 */
export function copilotLaunchDecision(remembered: CopilotLaunchSettings | null | undefined, options: CopilotRuntimeOption[]): CopilotLaunchDecision {
  if (!remembered) return { open: false, preselect: null, notice: null };
  const option = options.find((entry) => entry.runtime.id === remembered.runtimeId);
  const label = copilotAgentLabel(remembered.runtimeId, option?.runtime);
  if (!option) return { open: false, preselect: null, notice: `Your default agent, ${label}, is not available. Choose another one.` };
  if (!option.ready) return { open: false, preselect: null, notice: `Your default agent, ${label}, is not ready: ${option.runtime.statusReason}` };
  if (remembered.askOnLaunch) return { open: false, preselect: remembered, notice: null };
  return { open: true, label, choice: { terminalRuntimeId: remembered.runtimeId, accountProfileId: copilotAccountFor(remembered.runtimeId, remembered.accountProfileId) } };
}

/** The launch decision from the user's saved default (server-side, so every device agrees) and the current CLIs. */
export async function resolveCopilotLaunch(kind: CopilotKind): Promise<CopilotLaunchDecision> {
  const [settings, registry] = await Promise.all([api.userSettings(), api.cliRuntimesSnapshot() ?? api.cliRuntimes()]);
  return copilotLaunchDecision(kind.remembered(settings), copilotRuntimeOptions(registry, kind));
}

/** Saves the default agent for new panes of this copilot; null forgets it, so the next pane asks. */
export async function saveCopilotLaunch(kind: CopilotKind, launch: CopilotLaunchSettings | null): Promise<void> {
  await api.updateUserSettings({ [kind.settingsKey]: launch });
}

/** Short model label for the agent chip; a pane without its own pick shows nothing. */
export function paneModelLabel(pane: Pick<Pane, "modelId">): string | null {
  if (!pane.modelId) return null;
  const tail = pane.modelId.split(":").at(-1) ?? pane.modelId;
  return tail.length > 28 ? `${tail.slice(0, 27)}…` : tail;
}
