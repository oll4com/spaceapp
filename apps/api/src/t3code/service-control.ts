import { execFile } from "../safe-child-process.js";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  restartT3CodeInputSchema,
  t3CodeAdminResultSchema,
  t3CodeAdminStatusSchema,
  updateT3CodeEnabledInputSchema,
  type T3CodeAdminStatus
} from "@space/contracts";
import { T3_GATEWAY_OWNER } from "./gateway-policy.js";
import { installedT3Version, T3Upstream } from "./upstream.js";

const execFileAsync = promisify(execFile);

// Fixed commands mirrored by deploy/space-t3code-control.sudoers. Nothing from
// a request selects a unit, verb or argument.
export const T3CODE_RESTART_COMMAND = {
  command: "/usr/bin/sudo",
  args: ["-n", "/usr/bin/systemctl", "restart", "space-t3code.service"]
} as const;
export const T3CODE_ENABLE_COMMAND = {
  command: "/usr/bin/sudo",
  args: ["-n", "/usr/bin/systemctl", "enable", "--now", "space-t3code.socket", "space-t3code.service"]
} as const;
export const T3CODE_DISABLE_COMMAND = {
  command: "/usr/bin/sudo",
  args: ["-n", "/usr/bin/systemctl", "disable", "--now", "space-t3code.socket", "space-t3code.service"]
} as const;
export const T3CODE_STATE_COMMAND = {
  command: "/usr/bin/systemctl",
  args: ["show", "space-t3code.service", "space-t3code.socket", "--property=Id,ActiveState,UnitFileState,MainPID"]
} as const;

export interface T3CodeUnitState { serviceEnabled: boolean; serviceActive: boolean; socketActive: boolean; pid: number | null }
export interface T3CodeServiceController {
  state(): Promise<T3CodeUnitState>;
  restart(): Promise<void>;
  setEnabled(enabled: boolean): Promise<void>;
}

export function parseT3CodeUnitState(output: string): T3CodeUnitState {
  const units = output.trim().split(/\n\s*\n/).map((block) => Object.fromEntries(block.split("\n").map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  })) as Record<string, string>);
  const service = units.find((unit) => unit.Id === "space-t3code.service") ?? {};
  const socket = units.find((unit) => unit.Id === "space-t3code.socket") ?? {};
  const pid = Number.parseInt(service.MainPID ?? "", 10);
  return {
    serviceEnabled: service.UnitFileState === "enabled" || socket.UnitFileState === "enabled",
    serviceActive: service.ActiveState === "active",
    socketActive: socket.ActiveState === "active",
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null
  };
}

export function createT3CodeServiceController(): T3CodeServiceController {
  const run = (command: { command: string; args: readonly string[] }, timeout: number) =>
    execFileAsync(command.command, [...command.args], { timeout, windowsHide: true });
  return {
    async state() {
      const { stdout } = await run(T3CODE_STATE_COMMAND, 5000);
      return parseT3CodeUnitState(stdout);
    },
    async restart() { await run(T3CODE_RESTART_COMMAND, 60_000); },
    async setEnabled(enabled) { await run(enabled ? T3CODE_ENABLE_COMMAND : T3CODE_DISABLE_COMMAND, 60_000); }
  };
}

export interface T3CodeAdminRoutesOptions {
  featureEnabled: boolean;
  controller: T3CodeServiceController;
  socketPath?: string;
  healthTimeoutMs?: number;
  upstream?: T3Upstream;
  readRuntime?: typeof installedT3Version;
  routeOptions?: Record<string, unknown>;
  audit(request: FastifyRequest, action: string, metadata: Record<string, unknown>): Promise<void>;
  // Waits for readiness after start/restart; injectable for tests.
  waitReady?: (read: () => Promise<boolean>) => Promise<boolean>;
}

// Read-only service identity for counting active runs. It never targets a pane
// route and receives only the bounded shell projection.
const SERVICE_SCOPE = {
  userId: T3_GATEWAY_OWNER,
  paneId: "pane:space-admin-status",
  sessionId: createHash("sha256").update("space-t3code-admin-status").digest("hex")
};

async function defaultWaitReady(read: () => Promise<boolean>) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (await read()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function adminError(reply: FastifyReply, status: number, code: string, message: string, details?: unknown) {
  return reply.code(status).header("cache-control", "no-store").send({ error: { code, message, details, requestId: reply.request.requestIdForSpace } });
}

export function registerT3CodeAdminRoutes(app: FastifyInstance, options: T3CodeAdminRoutesOptions) {
  const upstream = options.upstream ?? new T3Upstream(options.socketPath, options.healthTimeoutMs);
  const readRuntime = options.readRuntime ?? installedT3Version;
  const waitReady = options.waitReady ?? defaultWaitReady;
  let pending: string | null = null;

  const ready = async () => {
    try { await upstream.descriptor(SERVICE_SCOPE); return true; } catch { return false; }
  };
  const readStatus = async (): Promise<T3CodeAdminStatus> => {
    const [unit, runtime] = await Promise.all([
      options.controller.state().catch(() => ({ serviceEnabled: false, serviceActive: false, socketActive: false, pid: null })),
      readRuntime()
    ]);
    let serverVersion: string | null = null, activeRuns: number | null = null;
    if (unit.socketActive || unit.serviceActive) {
      try {
        serverVersion = (await upstream.descriptor(SERVICE_SCOPE)).serverVersion;
        activeRuns = await upstream.activeRuns(SERVICE_SCOPE);
      } catch { /* reported as not ready */ }
    }
    return t3CodeAdminStatusSchema.parse({
      version: 1, featureEnabled: options.featureEnabled, ...unit, ready: serverVersion !== null,
      serverVersion, runtime, activeRuns, checkedAt: new Date().toISOString()
    });
  };
  const requireAdmin = (request: FastifyRequest, reply: FastifyReply) => {
    if (request.user?.role === "ADMIN") return true;
    void adminError(reply, 403, "ADMIN_REQUIRED", "T3 Code service settings require the ADMIN role.");
    return false;
  };
  // One operation at a time: a second click while one runs is refused, never queued.
  const exclusive = async (reply: FastifyReply, name: string, work: () => Promise<unknown>) => {
    if (pending) return adminError(reply, 409, "T3_SERVICE_OPERATION_PENDING", "Another T3 Code service operation is still running.", { pending });
    pending = name;
    try { return await work(); } finally { pending = null; }
  };
  // An unreadable run count on a running service is treated as "may have runs".
  const confirmImpact = (reply: FastifyReply, status: T3CodeAdminStatus, confirmed: boolean | undefined) => {
    const unknown = status.activeRuns === null && (status.serviceActive || status.socketActive);
    if (confirmed === true || (!unknown && !status.activeRuns)) return true;
    void adminError(reply, 409, "T3_ACTIVE_RUNS", unknown
      ? "Active T3 Code runs could not be counted. Confirm to interrupt any that exist."
      : "T3 Code has active runs. Confirm to interrupt them.", { activeRuns: status.activeRuns });
    return false;
  };
  const requireFeature = (reply: FastifyReply) => {
    if (options.featureEnabled) return true;
    void adminError(reply, 409, "T3CODE_DISABLED", "T3 Code is turned off by SPACE_T3CODE_ENABLED on this installation.");
    return false;
  };
  const routeOptions = options.routeOptions ?? {};

  app.get("/api/admin/t3code/service", routeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    return reply.header("cache-control", "no-store").send(t3CodeAdminResultSchema.parse({ status: await readStatus() }));
  });

  app.patch("/api/admin/t3code/enabled", routeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const input = updateT3CodeEnabledInputSchema.safeParse(request.body ?? {});
    if (!input.success) return adminError(reply, 400, "VALIDATION_ERROR", "Invalid T3 Code service request.");
    if (input.data.enabled && !requireFeature(reply)) return reply;
    return exclusive(reply, input.data.enabled ? "enable" : "disable", async () => {
      const before = await readStatus();
      if (!input.data.enabled && !confirmImpact(reply, before, input.data.confirmActiveRuns)) return reply;
      try {
        await options.controller.setEnabled(input.data.enabled);
        if (input.data.enabled && !await waitReady(ready)) throw new Error("not ready");
      } catch {
        await options.audit(request, "t3code.service_change_failed", { enabled: input.data.enabled });
        return adminError(reply, 502, "T3_SERVICE_CONTROL_FAILED", "T3 Code service state could not be changed.");
      }
      const status = await readStatus();
      await options.audit(request, input.data.enabled ? "t3code.enabled" : "t3code.disabled",
        { serviceActive: status.serviceActive, ready: status.ready, interruptedRuns: input.data.enabled ? 0 : before.activeRuns ?? 0 });
      return reply.header("cache-control", "no-store").send(t3CodeAdminResultSchema.parse({ status }));
    });
  });

  app.post("/api/admin/t3code/restart", routeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const input = restartT3CodeInputSchema.safeParse(request.body ?? {});
    if (!input.success) return adminError(reply, 400, "VALIDATION_ERROR", "Invalid T3 Code restart request.");
    if (!requireFeature(reply)) return reply;
    return exclusive(reply, "restart", async () => {
      const before = await readStatus();
      if (!before.serviceEnabled && !before.socketActive) return adminError(reply, 409, "T3_SERVICE_DISABLED", "Enable T3 Code before restarting it.");
      if (!confirmImpact(reply, before, input.data.confirmActiveRuns)) return reply;
      try {
        await options.controller.restart();
        if (!await waitReady(ready)) throw new Error("not ready");
      } catch {
        await options.audit(request, "t3code.restart_failed", { interruptedRuns: before.activeRuns ?? 0 });
        return adminError(reply, 502, "T3_SERVICE_RESTART_FAILED", "T3 Code did not become ready after the restart.");
      }
      const status = await readStatus();
      await options.audit(request, "t3code.restart_requested", { ready: status.ready, interruptedRuns: before.activeRuns ?? 0 });
      return reply.header("cache-control", "no-store").send(t3CodeAdminResultSchema.parse({ status }));
    });
  });
}
