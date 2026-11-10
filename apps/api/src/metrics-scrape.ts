import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { cpus, loadavg, totalmem } from "node:os";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DeployQueueReport } from "@space/contracts";
import { readDeployQueue } from "./deploy-queue.js";
import { classifyLoad, parseMeminfo, type HostSwap, type HostSwapReader, type NousLoadLevel } from "./nous/server-load.js";
import { headerString, requestIpForLog } from "./request-helpers.js";
import { sendApiError } from "./http-errors.js";

// The monitoring collector's scrape of Space (plan clipboard:xkCJ9CeYZq4D Phase 5). nginx sends only /api/* to the API, so the
// collector (CT 210) scrapes GET /api/metrics/scrape: the same aggregate metrics as /metrics plus the server's load, with a bearer
// token read from a root-provisioned file, and only from a private-network address (a token leaked to the internet opens nothing).

const TOKEN_CACHE_MS = 60_000;
const LOAD_LEVEL: Record<NousLoadLevel, number> = { CALM: 0, BUSY: 1, OVERLOADED: 2 };

/** 10/8, 172.16/12, 192.168/16 and their IPv4-mapped IPv6 forms. Loopback is not private here: /metrics already serves it. */
export function isPrivateNetworkAddress(ip: string | undefined): boolean {
  const v4 = (ip ?? "").replace(/^::ffff:/i, "");
  const parts = v4.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export { parseMeminfo } from "./nous/server-load.js";

/** The server's load as gauges: the level Nous uses (the physical host's swap); this VM's load, memory and swap are gauges only. */
export function renderLoadMetrics(input: { load5: number; cores: number; memAvailableBytes: number | null; memTotalBytes?: number; swapPercent: number | null; host: HostSwap | null }): string {
  const { level } = classifyLoad({ swapPercent: input.host?.percent ?? null });
  const lines = [
    "# HELP space_server_load_level The server's load as Nous classifies it: 0 calm, 1 busy, 2 overloaded.",
    "# TYPE space_server_load_level gauge",
    `space_server_load_level ${LOAD_LEVEL[level]}`,
    "# HELP space_server_load5 The 5-minute load average.",
    "# TYPE space_server_load5 gauge",
    `space_server_load5 ${input.load5}`,
    "# HELP space_server_cores CPU cores the load average compares against.",
    "# TYPE space_server_cores gauge",
    `space_server_cores ${input.cores}`
  ];
  if (input.memAvailableBytes !== null) lines.push("# HELP space_server_mem_available_bytes MemAvailable from /proc/meminfo.", "# TYPE space_server_mem_available_bytes gauge", `space_server_mem_available_bytes ${input.memAvailableBytes}`);
  if (input.swapPercent !== null) lines.push("# HELP space_server_swap_used_percent This VM's swap in use, percent.", "# TYPE space_server_swap_used_percent gauge", `space_server_swap_used_percent ${input.swapPercent}`);
  if (input.host?.percent != null) lines.push("# HELP space_host_swap_used_percent The physical host's swap in use, percent (it alone decides the level).", "# TYPE space_host_swap_used_percent gauge", `space_host_swap_used_percent ${input.host.percent}`);
  return `${lines.join("\n")}\n`;
}

type QueueReports = Array<{ name: string; report: DeployQueueReport | null }>;

/**
 * The merge queues and Space Gateway as gauges (plan clipboard:xkCJ9CeYZq4D Phase 5), for the collector's rules and the pane's charts.
 * A queue Space cannot read reports only `readable 0`; `gatewayUp` null (no gateway on this install) leaves the gateway out.
 */
export function renderSpaceMetrics(input: { queues: QueueReports; gatewayUp: boolean | null; now: number }): string {
  const lines: string[] = [];
  const gauge = (name: string, help: string, values: Array<[string, number]>) => {
    if (values.length) lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, ...values.map(([labels, value]) => `${name}${labels} ${value}`));
  };
  const readable = input.queues.map(({ name, report }) => ({ labels: `{queue="${name}"}`, report: report?.available ? report : null }));
  const each = (value: (report: DeployQueueReport) => number) => readable.flatMap(({ labels, report }) => (report ? [[labels, value(report)] as [string, number]] : []));
  gauge("space_merge_queue_readable", "1 when Space could read the merge queue's state, otherwise 0.", readable.map(({ labels, report }) => [labels, report ? 1 : 0]));
  gauge("space_merge_queue_daemon_up", "1 while the merge queue daemon's heartbeat is fresh or a batch is in progress.", each((report) => (report.daemonRunning ? 1 : 0)));
  gauge("space_merge_queue_paused", "1 while the merge queue is paused.", each((report) => (report.paused ? 1 : 0)));
  gauge("space_merge_queue_active_tickets", "Tickets queued or in progress.", each((report) => report.active.length));
  gauge("space_merge_queue_batch_phase_seconds", "Seconds the current batch has been in its phase, 0 with no batch.", each((report) => {
    const since = Date.parse(report.current?.phaseStartedAt ?? "");
    return Number.isFinite(since) ? Math.max(0, Math.round((input.now - since) / 1000)) : 0;
  }));
  if (input.gatewayUp !== null) gauge("space_gateway_up", "1 when Space Gateway's /health answered OK.", [["", input.gatewayUp ? 1 : 0]]);
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/** Reads what renderSpaceMetrics shows: each named queue root and Space Gateway's /health (5 s). */
export async function readSpaceMetrics(input: { queueRoots: Readonly<Record<string, string>>; gatewayUrl: string | null }): Promise<string> {
  const [queues, gatewayUp] = await Promise.all([
    Promise.all(Object.entries(input.queueRoots).map(async ([name, root]) => ({ name, report: await readDeployQueue(root).catch(() => null) }))),
    input.gatewayUrl ? fetch(`${input.gatewayUrl}/health`, { signal: AbortSignal.timeout(5_000) }).then((response) => response.ok, () => false) : Promise.resolve(null)
  ]);
  return renderSpaceMetrics({ queues, gatewayUp, now: Date.now() });
}

export function createScrapeAuth(input: { tokenFile: string; now?: () => number; read?: (path: string) => Promise<string> }) {
  const now = input.now ?? Date.now;
  const read = input.read ?? ((path: string) => readFile(path, "utf8"));
  let cache: { at: number; digest: Buffer | null } | null = null;
  async function expected(): Promise<Buffer | null> {
    if (cache && now() - cache.at < TOKEN_CACHE_MS) return cache.digest;
    // A missing or short file disables the scrape (nothing to compare against), it never opens it.
    const token = (await read(input.tokenFile).catch(() => "")).trim();
    cache = { at: now(), digest: token.length >= 32 ? createHash("sha256").update(token).digest() : null };
    return cache.digest;
  }
  return {
    async allows(request: FastifyRequest): Promise<boolean> {
      if (!isPrivateNetworkAddress(requestIpForLog(request))) return false;
      const header = headerString(request.headers.authorization);
      const submitted = header?.match(/^Bearer\s+(\S{32,256})$/)?.[1];
      const digest = await expected();
      if (!submitted || !digest) return false;
      return timingSafeEqual(createHash("sha256").update(submitted).digest(), digest);
    }
  };
}

/**
 * The workers' loopback /metrics ports, as their units set them (deploy/space-worker.service, space-memory-*-worker.service;
 * a test keeps them equal). The collector cannot reach public-host's loopback, so the API relays each one (OBS-001).
 */
export const WORKER_METRICS_TARGETS: Readonly<Record<string, number>> = {
  worker: 9469,
  "worker-temporal": 9464,
  "memory-maintenance": 9470,
  "memory-mutation": 9471
};
const TARGET_TIMEOUT_MS = 3_000;
const TARGET_MAX_BYTES = 4 * 1024 * 1024;

async function readLoopbackMetrics(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(TARGET_TIMEOUT_MS), redirect: "error" });
    const text = response.ok ? await response.text() : null;
    return text !== null && text.length <= TARGET_MAX_BYTES ? text : null;
  } catch {
    return null;
  }
}

/**
 * GET /api/metrics/scrape for the monitoring collector; `render` is the API's aggregate Prometheus text (the /metrics body).
 * GET /api/metrics/scrape/:target relays one worker's loopback metrics under the same token rule; `targets` is empty on dev,
 * whose loopback would answer with stable's workers.
 */
export function registerMetricsScrape(app: FastifyInstance, input: { tokenFile: string; render: () => string; routeOptions: Record<string, unknown>; space?: () => Promise<string>; meminfo?: () => Promise<string>; hostSwap?: HostSwapReader; targets?: Readonly<Record<string, number>>; readTarget?: (port: number) => Promise<string | null> }): void {
  const auth = createScrapeAuth({ tokenFile: input.tokenFile });
  const meminfo = input.meminfo ?? (() => readFile("/proc/meminfo", "utf8"));
  app.get("/api/metrics/scrape", input.routeOptions, async (request, reply) => {
    if (!(await auth.allows(request))) return sendApiError(reply, 403, "METRICS_FORBIDDEN", "Metrics scrapes need the collector's token from a private-network address.");
    const memory = parseMeminfo(await meminfo().catch(() => ""));
    reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    const space = await input.space?.().catch(() => "") ?? "";
    const host = await input.hostSwap?.read().catch(() => null) ?? null;
    return `${input.render()}${renderLoadMetrics({ load5: Math.round(loadavg()[1]! * 100) / 100, cores: cpus().length || 1, memTotalBytes: totalmem(), ...memory, host })}${space}`;
  });
  const targets = input.targets ?? {};
  const readTarget = input.readTarget ?? readLoopbackMetrics;
  app.get<{ Params: { target: string } }>("/api/metrics/scrape/:target", input.routeOptions, async (request, reply) => {
    if (!(await auth.allows(request))) return sendApiError(reply, 403, "METRICS_FORBIDDEN", "Metrics scrapes need the collector's token from a private-network address.");
    const port = Object.hasOwn(targets, request.params.target) ? targets[request.params.target] : undefined;
    if (port === undefined) return sendApiError(reply, 404, "METRICS_TARGET_UNKNOWN", "No such metrics target on this instance.");
    const text = await readTarget(port);
    if (text === null) return sendApiError(reply, 503, "METRICS_TARGET_DOWN", "The target's metrics endpoint did not answer.");
    reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return text;
  });
}
