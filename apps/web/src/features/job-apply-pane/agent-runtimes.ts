import { type AgentRuntimeRegistry, type JobCopilotLaunchSettings } from "@space/contracts";
import { JOB_COPILOT_KIND } from "../copilot-kit/copilot-kind.js";
import {
  copilotAccountFor, copilotAgentLabel, copilotLaunchDecision, copilotRuntimeOptions, defaultCopilotRuntimeId, resolveCopilotLaunch, saveCopilotLaunch,
  type CopilotAgentChoice, type CopilotLaunchDecision, type CopilotRuntimeOption
} from "../copilot-kit/copilot-runtimes.js";

// Job Copilot's agent helpers are the copilot kit's, bound to the Job Copilot kind (Claude Code first, settings.jobCopilot).
export { loadPaneAccountProfileId, paneModelLabel } from "../copilot-kit/copilot-runtimes.js";

/** Claude Code first: long, tool-heavy application loops (native MCP, skills, account profiles). */
export const JOB_COPILOT_PREFERRED_RUNTIME_ID = JOB_COPILOT_KIND.preferredRuntimeId;

export type JobCopilotRuntimeOption = CopilotRuntimeOption;
export type JobCopilotAgentChoice = CopilotAgentChoice;
export type JobCopilotLaunchDecision = CopilotLaunchDecision;

/** CLI runtimes in catalog order, Claude Code flagged as the recommended copilot agent. */
export function jobCopilotRuntimeOptions(registry: AgentRuntimeRegistry | null): JobCopilotRuntimeOption[] {
  return copilotRuntimeOptions(registry, JOB_COPILOT_KIND);
}

/** The runtime a new copilot should start on: Claude Code when ready, else the first ready CLI. */
export const defaultJobCopilotRuntimeId = defaultCopilotRuntimeId;

/** The catalog's short name of a CLI ("Claude Code"), for buttons and notices. */
export const jobCopilotAgentLabel = copilotAgentLabel;

/** Only CLIs with account profiles carry an account; every other CLI starts on its own sign-in (Codex: Space Gateway). */
export const jobCopilotAccountFor = copilotAccountFor;

/**
 * Whether a new Job Copilot pane opens at once on the remembered agent, or the launch dialog asks first:
 * never chosen, "ask every time", or the remembered CLI is not ready (the dialog says why).
 */
export function jobCopilotLaunchDecision(remembered: JobCopilotLaunchSettings | null | undefined, options: JobCopilotRuntimeOption[]): JobCopilotLaunchDecision {
  return copilotLaunchDecision(remembered, options);
}

/** The launch decision from the user's saved default (server-side, so every device agrees) and the current CLIs. */
export function resolveJobCopilotLaunch(): Promise<JobCopilotLaunchDecision> {
  return resolveCopilotLaunch(JOB_COPILOT_KIND);
}

/** Saves the default agent for new Job Copilot panes; null forgets it, so the next pane asks. */
export function saveJobCopilotLaunch(launch: JobCopilotLaunchSettings | null): Promise<void> {
  return saveCopilotLaunch(JOB_COPILOT_KIND, launch);
}
