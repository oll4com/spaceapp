import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { summarizeCliCanary } from "@space/runtime";
import type { SystemHealthService } from "@space/contracts";
import { cliResourceHealth } from "./cli-resource-health.js";
import type { SystemHealthCheck } from "./system-health-service.js";
import { SPACE_AGENT_HOME } from "@space/contracts";

// Where the weekly canary (deploy/space-cli-canary.service, scripts/cli-canary.mjs) writes its verdicts.
export const CLI_CANARY_REPORTS = `${SPACE_AGENT_HOME}/agent-workspace/reports/cli-canary`;
const CACHE_MS = 60_000;
let cached: { dir: string; at: number; value: Promise<Omit<SystemHealthService, "id" | "label" | "checkedAt">> } | null = null;

/** System Health's CLI checks: the resource guard and the weekly canary (none on a public installation, which has no canary). */
export function cliHealthChecks(publicDistribution: boolean): SystemHealthCheck[] {
  return [
    { id: "cli-resource-guard", label: "CLI resource protection", collect: () => cliResourceHealth() },
    { id: "cli-canary", label: "CLI canary", collect: async () => publicDistribution
      ? { status: "disabled", detail: "Not used in public installations", values: [] }
      : cliCanaryHealth() }
  ];
}

/** System Health's "CLI canary" check (ADAPTER-001): each CLI's newest canary verdict, so a BLOCKED or stale one shows. */
export function cliCanaryHealth(dir = CLI_CANARY_REPORTS, now = Date.now()) {
  if (!cached || cached.dir !== dir || now - cached.at > CACHE_MS) cached = { dir, at: now, value: collect(dir, now) };
  return cached.value;
}

/** "PASS · 2.1.323", or "PASS · 2.0.0 (runs 1.0.0)" when the tested version differs from the running one: only what the verdict knows. */
function canaryValue(row: { verdict: string; candidateVersion: string | null; liveCurrentTarget: string | null }) {
  const { candidateVersion: tested, liveCurrentTarget: runs } = row;
  const version = tested && runs && tested !== runs ? `${tested} (runs ${runs})` : tested ?? runs;
  return version ? `${row.verdict} · ${version}` : row.verdict;
}

async function collect(dir: string, now: number): Promise<Omit<SystemHealthService, "id" | "label" | "checkedAt">> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch {
    return { status: "unavailable", detail: "The CLI canary reports folder could not be read.", values: [] };
  }
  const reports = await Promise.all(names.map((name) => readFile(join(dir, name), "utf8").then((raw) => JSON.parse(raw) as unknown, () => null)));
  const summary = summarizeCliCanary(reports, { now });
  if (!summary.rows.length) return { status: "unavailable", detail: "No CLI canary verdicts yet: the weekly canary has not run.", values: [] };
  const attention = summary.rows.filter((row) => row.needsAttention);
  return {
    status: attention.length ? "warning" : "healthy",
    detail: (attention.length
      ? `Needs review: ${attention.map((row) => `${row.cli} ${row.stale ? `verdict ${row.ageDays} days old` : row.verdict}${row.blockedReason ? ` (${row.blockedReason})` : ""}`).join("; ")}`
      : "Every CLI's newest canary verdict passed").slice(0, 500),
    values: [
      { label: "Last run", value: summary.canaryLastRanAt ?? "Unavailable" },
      ...summary.rows.slice(0, 11).map((row) => ({
        label: row.cli.slice(0, 100),
        value: canaryValue(row).slice(0, 160)
      }))
    ]
  };
}
