import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify, stripVTControlCharacters } from "node:util";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import { SPACE_INSTALL_ROOT } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import { readDeployQueue } from "./deploy-queue.js";
import { sendApiError } from "./http-errors.js";
import { childProcessEnv } from "./child-process-env.js";
import { recordAudit } from "./request-audit.js";
import { WorktreeService } from "./worktrees/worktree-service.js";

/** The host side of the Nous Settings Operations block (operator nous_msg:5249d11d): only existing guarded paths, injectable for tests. */
export interface ServerOpsRunner {
  /** Runs a fixed program; rejects on a non-zero exit (the error carries stderr). */
  run(file: string, args: string[]): Promise<string>;
  cleanWorktrees(excludePaths: string[]): Promise<{ cleaned: unknown[]; preserved: unknown[] }>;
}

const execFileAsync = promisify(execFile);
export const hostServerOpsRunner: ServerOpsRunner = {
  run: async (file, args) => (await execFileAsync(file, args, { env: childProcessEnv(), timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })).stdout,
  cleanWorktrees: (excludePaths) => new WorktreeService().cleanCompletedWorktrees(SPACE_INSTALL_ROOT, { excludePaths })
};

const SYSTEMCTL = "/usr/bin/systemctl";
const SUDO = ["/usr/bin/sudo", "-n", SYSTEMCTL] as const;
const CLEAN_DISK_UNIT = "space-retention.service";
const DEPLOY_REMOTES_UNIT = "space-deploy-remotes.service";
const DEPLOY_REMOTES_LOG = `${SPACE_INSTALL_ROOT}/var/deploy-remotes.log`;
const control = (script: string) => `${SPACE_INSTALL_ROOT}/scripts/${script}`;
/** Each service: its units and the guard each is restarted through, as the guarded restarts run today
 * (the Browser Host restarts with open pane browsers; a pane host refuses while any CLI session runs). */
const SERVICES = {
  "browser-host": { units: ["space-browser-host.service"], guards: [[control("space-browser-host-control.mjs"), "--allow-active-sessions"]] },
  "pane-hosts": {
    units: ["codex-pane-host.service", "space-admin-pane-host.service"],
    guards: [[control("codex-pane-host-control.mjs")], [control("codex-pane-host-control.mjs"), "--socket", "/run/space-admin-pane-host/pane-host.sock"]]
  }
} as const;
type ServiceId = keyof typeof SERVICES;

const iso = (stamp?: string) => /^@\d+$/.test(stamp ?? "") ? new Date(Number(stamp!.slice(1)) * 1000).toISOString() : null;

class OpRefusal extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}

export function registerServerOpsRoutes(app: FastifyInstance, deps: {
  store: Pick<SpaceStore, "upsertUser" | "recordAuditEvent" | "listRooms" | "listPanes">; managedHere: boolean; queueRoot: string; routeOptions: RouteShorthandOptions; runner?: ServerOpsRunner;
}) {
  const { store, managedHere, queueRoot, routeOptions, runner = hostServerOpsRunner } = deps;
  const unitState = async (unit: string) => {
    const out = await runner.run(SYSTEMCTL, ["show", unit, "--property=ActiveState,Result,ExecMainStartTimestamp,ExecMainExitTimestamp", "--timestamp=unix"]).catch(() => "");
    const props = Object.fromEntries(out.split("\n").map((line) => line.split("=", 2) as [string, string]).filter(([, v]) => v !== undefined));
    const running = props.ActiveState === "active" || props.ActiveState === "activating";
    return {
      state: running ? "running" : props.ActiveState ? "idle" : "unknown",
      result: running || !props.Result || !props.ExecMainExitTimestamp ? null : props.Result === "success" ? "success" : "failed",
      startedAt: iso(props.ExecMainStartTimestamp),
      finishedAt: running ? null : iso(props.ExecMainExitTimestamp)
    };
  };
  // A hotfix waiting for the operator's approval is not work in progress.
  const queueActive = async () => (await readDeployQueue(queueRoot)).active.some((ticket) => ticket.status !== "AWAITING_APPROVAL");
  // Only the ✓/❌ summary lines: stderr is not in the log and the lines name a remote and a branch, never a URL.
  const remoteLines = async () => stripVTControlCharacters(await readFile(DEPLOY_REMOTES_LOG, "utf8").catch(() => ""))
    .split("\n").map((line) => line.trim()).filter((line) => /^[✓❌]/u.test(line));

  const operation = (action: string, run: (request: FastifyRequest) => Promise<{ code: number; body: Record<string, unknown> }>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Server operations require ADMIN.");
      if (!managedHere) return sendApiError(reply, 409, "NOT_MANAGED_HERE", "Server operations run only on the stable instance.");
      try {
        if (await queueActive()) throw new OpRefusal(409, "QUEUE_BUSY", "The stable merge queue is busy; try again when it is idle.");
        const { code, body } = await run(request);
        await recordAudit(store, request, { action: `server_ops.${action}`, targetType: "server", targetId: action, metadata: { status: body.status, service: body.service } });
        return reply.code(code).send(body);
      } catch (error) {
        if (error instanceof OpRefusal) return sendApiError(reply, error.statusCode, error.code, error.message);
        request.log.error({ err: error }, `Server operation ${action} failed`);
        return sendApiError(reply, 502, "OPERATION_FAILED", `${action} failed; the API log has the cause.`);
      }
    };
  const startUnit = (action: string, unit: string, message: string) => operation(action, async () => {
    if ((await unitState(unit)).state === "running") throw new OpRefusal(409, "ALREADY_RUNNING", `${action} is already running.`);
    await runner.run(SUDO[0], [...SUDO.slice(1), "--no-block", "start", unit]);
    return { code: 202, body: { status: "STARTED", message } };
  });

  app.get("/api/admin/server-ops", routeOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Server operations require ADMIN.");
    const services = await Promise.all((Object.keys(SERVICES) as ServiceId[]).map(async (id) => ({
      id, state: (await Promise.all(SERVICES[id].units.map(unitState))).every((unit) => unit.state === "running") ? "running" : "not running"
    })));
    return {
      managedHere, queueActive: await queueActive().catch(() => false),
      cleanDisk: await unitState(CLEAN_DISK_UNIT), deployRemotes: { ...(await unitState(DEPLOY_REMOTES_UNIT)), lines: await remoteLines() }, services
    };
  });
  app.post("/api/admin/server-ops/clean-disk", routeOptions,
    startUnit("clean-disk", CLEAN_DISK_UNIT, "Disk cleanup started (the daily retention: logs, caches, orphan worktrees, superseded CLI versions)."));
  app.post("/api/admin/server-ops/deploy-remotes", routeOptions,
    startUnit("deploy-remotes", DEPLOY_REMOTES_UNIT, "Pushing verified main to GitHub and Gitea."));
  app.post("/api/admin/server-ops/clean-worktrees", routeOptions, operation("clean-worktrees", async () => {
    const cwds = (await Promise.all((await store.listRooms()).map((room) => store.listPanes(room.id, false)))).flat()
      .map((pane) => pane.cwd).filter((cwd): cwd is string => Boolean(cwd));
    const result = await runner.cleanWorktrees(cwds);
    return { code: 200, body: { status: "DONE", message: `Removed ${result.cleaned.length} worktrees, kept ${result.preserved.length}.`, ...result } };
  }));
  app.post("/api/admin/server-ops/restart", routeOptions, operation("restart", async (request) => {
    const parsed = z.object({ service: z.enum(Object.keys(SERVICES) as [ServiceId, ...ServiceId[]]) }).safeParse(request.body ?? {});
    if (!parsed.success) throw new OpRefusal(400, "INVALID_SERVICE", `service must be one of ${Object.keys(SERVICES).join(", ")}.`);
    const service = SERVICES[parsed.data.service];
    // The guard as it is today: any running session refuses the restart.
    for (const guard of service.guards) {
      await runner.run(process.execPath, [guard[0], "assert-restart-safe", "--timeout-ms", "5000", ...guard.slice(1)]).catch((error: { stderr?: string }) => {
        const count = /"activeSessionCount":(\d+)/.exec(String(error.stderr ?? ""))?.[1];
        throw new OpRefusal(409, "HOST_BUSY", count ? `Not restarted: ${count} sessions are running on it.` : "Not restarted: the host's restart guard refused.");
      });
    }
    for (const unit of service.units) await runner.run(SUDO[0], [...SUDO.slice(1), "restart", unit]);
    for (const guard of service.guards) await runner.run(process.execPath, [guard[0], "wait-ready", "--timeout-ms", "15000", ...guard.slice(1)]);
    return { code: 200, body: { status: "RESTARTED", service: parsed.data.service, message: `${parsed.data.service} restarted and ready.` } };
  }));
}
