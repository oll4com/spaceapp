import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { cpus, loadavg } from "node:os";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { classifyLoad, type NousLoadLevel } from "./nous/server-load.js";
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

/** /proc/meminfo's MemAvailable and swap use, null where the file cannot be read. */
export function parseMeminfo(text: string): { memAvailableBytes: number | null; swapPercent: number | null } {
  const field = (name: string) => { const match = new RegExp(`^${name}:\\s+(\\d+) kB`, "m").exec(text); return match ? Number(match[1]) * 1024 : null; };
  const available = field("MemAvailable");
  const swapTotal = field("SwapTotal");
  const swapFree = field("SwapFree");
  return { memAvailableBytes: available, swapPercent: swapTotal && swapFree !== null ? Math.round(((swapTotal - swapFree) / swapTotal) * 1000) / 10 : swapTotal === 0 ? 0 : null };
}

/** The server's load as gauges, from the same thresholds Nous uses (classifyLoad on the 5-minute load average and memory). */
export function renderLoadMetrics(input: { load5: number; cores: number; memAvailableBytes: number | null; swapPercent: number | null }): string {
  const { level } = classifyLoad({ cpuPercent: null, load5: input.load5, cores: input.cores, memAvailableBytes: input.memAvailableBytes, swapPercent: input.swapPercent });
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
  if (input.swapPercent !== null) lines.push("# HELP space_server_swap_used_percent Swap in use, percent.", "# TYPE space_server_swap_used_percent gauge", `space_server_swap_used_percent ${input.swapPercent}`);
  return `${lines.join("\n")}\n`;
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

/** GET /api/metrics/scrape for the monitoring collector; `render` is the API's aggregate Prometheus text (the /metrics body). */
export function registerMetricsScrape(app: FastifyInstance, input: { tokenFile: string; render: () => string; routeOptions: Record<string, unknown>; meminfo?: () => Promise<string> }): void {
  const auth = createScrapeAuth({ tokenFile: input.tokenFile });
  const meminfo = input.meminfo ?? (() => readFile("/proc/meminfo", "utf8"));
  app.get("/api/metrics/scrape", input.routeOptions, async (request, reply) => {
    if (!(await auth.allows(request))) return sendApiError(reply, 403, "METRICS_FORBIDDEN", "Metrics scrapes need the collector's token from a private-network address.");
    const memory = parseMeminfo(await meminfo().catch(() => ""));
    reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return `${input.render()}${renderLoadMetrics({ load5: Math.round(loadavg()[1]! * 100) / 100, cores: cpus().length || 1, ...memory })}`;
  });
}
