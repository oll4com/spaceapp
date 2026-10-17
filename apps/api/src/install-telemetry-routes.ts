import type {} from "./request-context.js";
import { readFile, stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { systemAnalyticsInstallsResponseSchema, type SystemAnalyticsInstall, type SystemAnalyticsInstallsResponse } from "@space/contracts";
import { sendApiError } from "./http-errors.js";
import { browserFromUserAgent, INSTALL_TELEMETRY_FIELDS, type InstallTelemetryFields } from "./install-telemetry.js";

/** What the browser adds to the daily active event: only what the server cannot know. */
const installActivitySchema = z.object({
  screen: z.string().regex(INSTALL_TELEMETRY_FIELDS.screen).optional(),
  dpr: z.string().regex(INSTALL_TELEMETRY_FIELDS.dpr).optional(),
  lang: z.string().regex(INSTALL_TELEMETRY_FIELDS.lang).optional()
}).strict();

/** Where a host job copies the collector's log; only the operator's own instance has it. */
export const INSTALL_PINGS_PATH = "/opt/spaceapp/var/inventory/install-pings.log";

type Ping = Record<string, unknown> & { t: string; uid: string; event?: string };

const text = (value: unknown) => typeof value === "string" && value !== "" ? value.slice(0, 64) : null;
const integer = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

/**
 * One row per installation from the collector's JSON lines (spaceapp.dev install-pings.log). Events of
 * launchers with an install id are linked by it; an older launcher's single "install" ping is its own
 * completed row, and an unlinked first_answer only counts in the summary. Rows from the project's own
 * addresses (the collector's "internal" flag: lab VMs, servers) are listed but left out of the summary counts.
 */
export function summarizeInstallPings(log: string, now = Date.now()): Omit<SystemAnalyticsInstallsResponse, "available" | "updatedAt"> {
  const rows = new Map<string, SystemAnalyticsInstall>();
  const activeDays = new Map<string, Set<string>>();
  let unlinkedFirstAnswers = 0;
  const pings = log.split("\n").flatMap((line) => {
    try {
      const ping = JSON.parse(line) as Ping;
      return ping && typeof ping.uid === "string" && typeof ping.t === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(ping.t) ? [ping] : [];
    } catch {
      return [];
    }
  }).sort((a, b) => a.t.localeCompare(b.t));
  for (const ping of pings) {
    const event = ping.event ?? "install";
    const installId = text(ping.install_id);
    if (!installId && event === "first_answer") { if (ping.internal !== true) unlinkedFirstAnswers += 1; continue; }
    if (!installId && event !== "install") continue;
    const key = installId ?? ping.uid;
    const row = rows.get(key) ?? {
      installId: key.slice(0, 64), linked: installId !== null, internal: false, firstSeenAt: ping.t, lastSeenAt: ping.t, status: "STARTED",
      failedStage: null, durationSeconds: null, country: null, os: null, osVersion: null, arch: null, cpus: null, ramGb: null,
      profile: null, access: null, version: null, screen: null, dpr: null, browser: null, lang: null, firstCli: null,
      setupCompletedAt: null, firstAnswerAt: null, lastActiveAt: null, activeDays: 0
    } satisfies SystemAnalyticsInstall;
    rows.set(key, row);
    row.lastSeenAt = ping.t;
    if (ping.internal === true) row.internal = true;
    // The latest value wins; runtime events report os "unknown", which never hides the launcher's OS.
    if (ping.os !== "unknown") row.os = text(ping.os) ?? row.os;
    row.arch = text(ping.arch) ?? row.arch;
    row.version = text(ping.version) ?? row.version;
    for (const field of ["country", "profile", "access", "screen", "dpr", "browser", "lang"] as const) row[field] = text(ping[field]) ?? row[field];
    row.osVersion = text(ping.os_version) ?? row.osVersion;
    row.cpus = integer(ping.cpus) ?? row.cpus;
    row.ramGb = integer(ping.ram_gb) ?? row.ramGb;
    if (event === "install" || event === "install_completed") {
      row.status = "COMPLETED";
      row.failedStage = null;
      row.durationSeconds = integer(ping.duration_s) ?? row.durationSeconds;
    } else if (event === "install_failed" && row.status !== "COMPLETED") {
      row.status = "FAILED";
      row.failedStage = text(ping.stage);
      row.durationSeconds = integer(ping.duration_s) ?? row.durationSeconds;
    } else if (event === "setup_completed" || event === "first_cli" || event === "first_answer" || event === "active") {
      // Reaching the app means the installation finished even if its completion ping was lost.
      if (row.status === "STARTED") row.status = "COMPLETED";
      if (event === "setup_completed") row.setupCompletedAt ??= ping.t;
      if (event === "first_cli") row.firstCli ??= text(ping.cli) ?? "unknown";
      if (event === "first_answer") row.firstAnswerAt ??= ping.t;
      if (event === "active") {
        row.lastActiveAt = ping.t;
        const days = activeDays.get(key) ?? new Set<string>();
        days.add(ping.t.slice(0, 10));
        activeDays.set(key, days);
        row.activeDays = days.size;
      }
    }
  }
  const installs = [...rows.values()].sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt));
  const external = installs.filter((row) => !row.internal);
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  return {
    summary: {
      installs: external.length,
      completed: external.filter((row) => row.status === "COMPLETED").length,
      failed: external.filter((row) => row.status === "FAILED").length,
      setupCompleted: external.filter((row) => row.setupCompletedAt).length,
      firstCli: external.filter((row) => row.firstCli).length,
      firstAnswer: external.filter((row) => row.firstAnswerAt).length + unlinkedFirstAnswers,
      active7d: external.filter((row) => row.lastActiveAt && Date.parse(row.lastActiveAt) >= weekAgo).length,
      internal: installs.length - external.length
    },
    installs: installs.slice(0, 1000)
  };
}

/**
 * The daily active event of public installations (authenticated users; the parent installs authentication and
 * CSRF) and the ADMIN view of the install pings that a host job copies from spaceapp.dev.
 */
export function registerInstallTelemetryRoutes(app: FastifyInstance, options: {
  onActive: (fields: InstallTelemetryFields) => void;
  installPingsPath?: string;
}) {
  const installPingsPath = options.installPingsPath ?? INSTALL_PINGS_PATH;
  app.post("/api/telemetry/active", { bodyLimit: 1024, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = installActivitySchema.parse(request.body ?? {});
    options.onActive({ ...body, browser: browserFromUserAgent(request.headers["user-agent"]) });
    return reply.code(204).send();
  });
  app.get("/api/admin/system-analytics/installs", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "System analytics require the ADMIN role.");
    }
    const [log, info] = await Promise.all([readFile(installPingsPath, "utf8").catch(() => null), stat(installPingsPath).catch(() => null)]);
    if (log === null) {
      return systemAnalyticsInstallsResponseSchema.parse({ available: false, updatedAt: null, ...summarizeInstallPings("") });
    }
    return systemAnalyticsInstallsResponseSchema.parse({ available: true, updatedAt: info?.mtime.toISOString() ?? null, ...summarizeInstallPings(log) });
  });
}
