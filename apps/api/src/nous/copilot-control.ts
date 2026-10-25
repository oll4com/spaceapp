import { z } from "zod";
import type { Pane, PaneCliSession } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import { paneLabel } from "./digest.js";

/**
 * space_copilot_control (plan clipboard:8s0ZNiO3q5ZT step 1): Nous starts and stops a copilot pane's CLI agent, pauses or
 * resumes the copilot and starts, pauses or stops its run. Each action is the route the pane's Setup and rail call, run as
 * the owner, so the routes' checks and audit and the copilots' review and autonomy gates stay exactly as they are.
 */

export const copilotControlActionSchema = z.enum(["start_agent", "stop_agent", "pause", "resume", "run_start", "run_pause", "run_stop"])
  .describe("start_agent/stop_agent: the pane's CLI agent. pause/resume: the copilot itself. run_start/run_pause/run_stop: its work run.");
export type CopilotControlAction = z.infer<typeof copilotControlActionSchema>;

export const COPILOT_CONTROL_DESCRIPTION = "Control a copilot pane (Mail, Marketing, Freelance, Job, Design, App Studio): start or stop its CLI agent, pause or resume the copilot, "
  + "start, pause or stop its run. Start the agent before a run; give Marketing, Freelance and App Studio their work as a brief first. "
  + "Sends to third parties stay behind the copilot's own reviews and autonomy.";

/** The owner's own API as Space Control calls it: a session for the owner, so each route checks and audits as for a click. */
export type CopilotInvoke = (owner: string, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => Promise<unknown>;

const routePrefix: Partial<Record<Pane["mode"], string>> = {
  JOB_APPLY: "job-apply", MAIL_COPILOT: "mail-copilot", MARKETING_COPILOT: "marketing-copilot", FREELANCE_COPILOT: "freelance-copilot", DESIGN: "design", APP_STUDIO: "app-studio"
};

const running = (session: PaneCliSession | null) =>
  Boolean(session && session.purpose === "NORMAL" && session.isActive && session.status !== "EXITED" && session.status !== "ERROR");

export function createCopilotControl(deps: { invoke: CopilotInvoke; store: Pick<SpaceStore, "getActivePaneCliSession" | "listPaneCliSessions"> }) {
  return async function control(owner: string, pane: Pane, action: CopilotControlAction): Promise<string> {
    const prefix = routePrefix[pane.mode];
    const name = paneLabel(pane);
    if (!prefix) throw new Error(`${name} is not a copilot pane: use space_stop_pane, space_restart_pane or space_send_to_pane.`);
    const at = `/api/panes/${encodeURIComponent(pane.id)}`;
    if (action === "start_agent" || action === "stop_agent") {
      const active = await deps.store.getActivePaneCliSession(pane.id);
      if (action === "stop_agent") {
        if (!running(active)) return `${name}'s agent is not running.`;
        await deps.invoke(owner, "POST", `${at}/cli/interrupt`, { reason: "Stopped by Nous." });
        return `Stopped ${name}'s agent.`;
      }
      if (running(active)) return `${name}'s agent is already running.`;
      if (!pane.terminalRuntimeId) throw new Error(`${name} has no CLI agent chosen: the operator picks one in its Setup.`);
      // The copilot's account lives in its CLI session (never in the pane row): start on the one its last session used.
      // shortcut: a balanced CLI on Auto restarts on its last account (naming it ends Auto); pass accountMode if that matters.
      const last = (await deps.store.listPaneCliSessions(pane.id, 1))[0];
      const account = last?.runtimeId === pane.terminalRuntimeId ? last.accountProfileId : null;
      await deps.invoke(owner, "POST", `${at}/cli/session`, { runtimeId: pane.terminalRuntimeId, includeTranscript: false, ...(account ? { accountProfileId: account } : {}) });
      return `Started ${name}'s agent (${pane.terminalRuntimeId}${account ? `, account ${account}` : ""}).`;
    }
    if (action === "pause" || action === "resume") {
      const { metadata } = await deps.invoke(owner, "GET", `${at}/${prefix}/settings`) as { metadata: { settings: { paused: boolean } } };
      const paused = action === "pause";
      if (metadata.settings.paused === paused) return `${name} is already ${paused ? "paused" : "on"}.`;
      await deps.invoke(owner, "PUT", `${at}/${prefix}/settings`, { ...metadata, settings: { ...metadata.settings, paused } });
      return `${paused ? "Paused" : "Resumed"} ${name}.`;
    }
    const view = await deps.invoke(owner, "POST", `${at}/${prefix}/run/${action.slice("run_".length)}`, {}) as { status?: string; kickoffSent?: boolean };
    if (action === "run_stop") return `Stopped ${name}'s run.`;
    return `${name}'s run is ${view.status ?? "unknown"}${view.kickoffSent ? "; its agent got the kickoff" : ""}.`;
  };
}
