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

export const COPILOT_CONTROL_DESCRIPTION = "Control a copilot pane (Mail, Marketing, Freelance, Job, Design, App Studio, Security, Monitoring): start or stop its CLI agent, pause or resume the copilot, "
  + "start, pause or stop its run. Start the agent before a run; give Marketing, Freelance and App Studio their work as a brief first. "
  + "Sends to third parties stay behind the copilot's own reviews and autonomy.";

/** The owner's own API as Space Control calls it: a session for the owner, so each route checks and audits as for a click. */
export type CopilotInvoke = (owner: string, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => Promise<unknown>;

const routePrefix: Partial<Record<Pane["mode"], string>> = {
  JOB_APPLY: "job-apply", MAIL_COPILOT: "mail-copilot", MARKETING_COPILOT: "marketing-copilot", FREELANCE_COPILOT: "freelance-copilot", DESIGN: "design", APP_STUDIO: "app-studio", VIDEO: "video", SECURITY_COPILOT: "security-copilot", MONITORING_COPILOT: "monitoring-copilot"
};

export const runningCliSession = (session: PaneCliSession | null) =>
  Boolean(session && session.purpose === "NORMAL" && session.isActive && session.status !== "EXITED" && session.status !== "ERROR");
const running = runningCliSession;

/**
 * A rail-tab CLI pane's session as its terminal opens one (POST /api/panes/:id/cli/session as the owner: workspace, persona, account).
 * The copilot's account lives in its CLI session (never in the pane row): it starts on the one its last session used.
 */
export async function openPaneCliSession(deps: { invoke: CopilotInvoke; store: Pick<SpaceStore, "listPaneCliSessions">; gatewayAccount?: PaneCliStartDeps["gatewayAccount"] },
  owner: string, pane: Pane): Promise<string | null> {
  if (!pane.terminalRuntimeId) throw new Error(`${paneLabel(pane)} has no CLI agent chosen: the operator picks one in its Setup.`);
  // shortcut: a balanced CLI on Auto restarts on its last account (naming it ends Auto); pass accountMode if that matters.
  const last = (await deps.store.listPaneCliSessions(pane.id, 1))[0];
  // Operator P0 1/11 (Nous 03:20 BKK): the always-on Mail Copilot's start_agent came up on the API key; it starts on Space Gateway.
  const gateway = pane.mode === "MAIL_COPILOT" ? await deps.gatewayAccount?.(pane).catch(() => null) : null;
  const account = gateway ?? (last?.runtimeId === pane.terminalRuntimeId ? last.accountProfileId : null);
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
  /** The gateway profile a pane's CLI starts on: set while Space Gateway serves its CLI and the operator pinned no direct account there. */
  gatewayAccount?(pane: Pane): Promise<string | null>;
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

// Daily Nous errors 13/11 19:10 (Bob run_start in Dino): a route's unexpected 500 reached Nous only as this text; its cause is in the API log.
// 14/11: controlInvoke now names the 500's op and cause (`NOT CONFIRMED <op>: <cause>. It may have run in part…`, app.ts); the cause is kept.
const INTERNAL_ERROR = /^(?:The request could not be completed\.|Protected control failed \(HTTP 5\d\d\)\.|NOT CONFIRMED (\S+ \S+: [\s\S]*?)\. It may have run in part[\s\S]*)$/;

export function createCopilotControl(deps: { invoke: CopilotInvoke; store: Pick<SpaceStore, "getActivePaneCliSession" | "listPaneCliSessions">; start?: PaneCliStartDeps["start"]; hostRunning?: PaneCliStartDeps["hostRunning"]; gatewayAccount?: PaneCliStartDeps["gatewayAccount"] }) {
  const control = async (owner: string, pane: Pane, action: CopilotControlAction): Promise<string> => {
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
    // 18/11 (Design run_start, HTTP 404): Design and Video panes have no run; they work through their request queue.
    if (pane.mode === "DESIGN" || pane.mode === "VIDEO") throw new Error(`${name} (${pane.mode}) works on requests, not runs: ask it with space_${pane.mode.toLowerCase()}_request, or start its agent with start_agent.`);
    const view = await deps.invoke(owner, "POST", `${at}/${prefix}/run/${action.slice("run_".length)}`, {}) as { status?: string; kickoffSent?: boolean };
    if (action === "run_stop") return `Stopped ${name}'s run.`;
    return `${name}'s run is ${view.status ?? "unknown"}${view.kickoffSent ? "; its agent got the kickoff" : ""}.`;
  };
  return async (owner: string, pane: Pane, action: CopilotControlAction): Promise<string> => control(owner, pane, action).catch((error: unknown) => {
    const internal = error instanceof Error ? INTERNAL_ERROR.exec(error.message) : null;
    if (!internal) throw error;
    throw new Error(`${paneLabel(pane)} (${pane.mode}): ${action} hit an internal error in Space, not in the pane (${internal[1] ?? "the API log has its cause"}). `
      + `Read the copilot (space_copilot_state): if its agent is not running, start_agent first; otherwise try ${action} once more, `
      + "and if it fails again, tell the operator (space_ask_operator) with this error.");
  });
}
