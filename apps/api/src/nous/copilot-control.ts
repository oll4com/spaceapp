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

export const COPILOT_CONTROL_DESCRIPTION = "Control a copilot pane (Mail, Marketing, Freelance, Job, Design, App Studio, Security): start or stop its CLI agent, pause or resume the copilot, "
  + "start, pause or stop its run. Start the agent before a run; give Marketing, Freelance and App Studio their work as a brief first. "
  + "Sends to third parties stay behind the copilot's own reviews and autonomy.";

/** The owner's own API as Space Control calls it: a session for the owner, so each route checks and audits as for a click. */
export type CopilotInvoke = (owner: string, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => Promise<unknown>;

const routePrefix: Partial<Record<Pane["mode"], string>> = {
  JOB_APPLY: "job-apply", MAIL_COPILOT: "mail-copilot", MARKETING_COPILOT: "marketing-copilot", FREELANCE_COPILOT: "freelance-copilot", DESIGN: "design", APP_STUDIO: "app-studio", VIDEO: "video", SECURITY_COPILOT: "security-copilot"
};

export const runningCliSession = (session: PaneCliSession | null) =>
  Boolean(session && session.purpose === "NORMAL" && session.isActive && session.status !== "EXITED" && session.status !== "ERROR");
const running = runningCliSession;

/**
 * A rail-tab CLI pane's session as its terminal opens one (POST /api/panes/:id/cli/session as the owner: workspace, persona, account).
 * The copilot's account lives in its CLI session (never in the pane row): it starts on the one its last session used.
 */
export async function openPaneCliSession(deps: { invoke: CopilotInvoke; store: Pick<SpaceStore, "listPaneCliSessions"> }, owner: string, pane: Pane): Promise<string | null> {
  if (!pane.terminalRuntimeId) throw new Error(`${paneLabel(pane)} has no CLI agent chosen: the operator picks one in its Setup.`);
  // shortcut: a balanced CLI on Auto restarts on its last account (naming it ends Auto); pass accountMode if that matters.
  const last = (await deps.store.listPaneCliSessions(pane.id, 1))[0];
  const account = last?.runtimeId === pane.terminalRuntimeId ? last.accountProfileId : null;
  await deps.invoke(owner, "POST", `/api/panes/${encodeURIComponent(pane.id)}/cli/session`, { runtimeId: pane.terminalRuntimeId, includeTranscript: false, ...(account ? { accountProfileId: account } : {}) });
  return account;
}

export interface PaneCliStartDeps {
  invoke: CopilotInvoke;
  store: Pick<SpaceStore, "getActivePaneCliSession" | "listPaneCliSessions">;
  /** Starts the pane's CLI process headless (Space Control's start; it spawns an allocated session record). */
  start(pane: Pane): Promise<unknown>;
  /** Whether the CLI host runs a process for this session record. */
  hostRunning(session: PaneCliSession): Promise<boolean>;
}

/**
 * Starts a rail-tab CLI pane's CLI the way its terminal does, with nobody at the pane (App Studio 23, 2026-10-23: an allocated session
 * record with no process behind it read as running, so starts answered "already active" and kickoffs waited for a screen that never
 * came). A record whose host process runs is left alone; a record without one is started as it is; without a record the session
 * route opens one first (workspace, persona, account).
 */
export async function startPaneCli(deps: PaneCliStartDeps, owner: string, pane: Pane): Promise<{ status: "COMPLETED"; detail: string } | unknown> {
  const active = await deps.store.getActivePaneCliSession(pane.id);
  if (running(active) && await deps.hostRunning(active!)) return { status: "COMPLETED", detail: "Pane session is already active." };
  if (!running(active)) await openPaneCliSession(deps, owner, pane);
  return deps.start(pane);
}

export function createCopilotControl(deps: { invoke: CopilotInvoke; store: Pick<SpaceStore, "getActivePaneCliSession" | "listPaneCliSessions">; start?: PaneCliStartDeps["start"]; hostRunning?: PaneCliStartDeps["hostRunning"] }) {
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
      // With the headless start wired in, a record without a process is started too, never left waiting for a terminal.
      if (deps.start && deps.hostRunning) {
        if (running(active) && await deps.hostRunning(active!)) return `${name}'s agent is already running.`;
        await startPaneCli({ ...deps, start: deps.start, hostRunning: deps.hostRunning }, owner, pane);
        return `Started ${name}'s agent (${pane.terminalRuntimeId}).`;
      }
      if (running(active)) return `${name}'s agent is already running.`;
      const account = await openPaneCliSession(deps, owner, pane);
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
