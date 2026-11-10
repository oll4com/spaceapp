// What the weekly CLI canary last found, per CLI (ADAPTER-001): shared by scripts/space-cli-canary-status.mjs and the
// API's System Health check. Pure: callers read the verdict files scripts/cli-canary.mjs writes.
const DAY_MS = 86_400_000;

export interface CliCanaryRow {
  cli: string;
  verdict: string;
  candidateVersion: string | null;
  liveCurrentTarget: string | null;
  blockedReason: string | null;
  promotion: string | null;
  generatedAt: string;
  ageDays: number;
  stale: boolean;
  needsAttention: boolean;
}

export interface CliCanarySummary {
  checkedAt: string;
  canaryLastRanAt: string | null;
  rows: CliCanaryRow[];
  ok: boolean;
}

type VerdictReport = Record<string, unknown> & { cli: string; generatedAt: string };

/** Newest verdict per CLI from parsed verdict files; files of another schema or without a CLI are ignored. */
export function latestCliCanaryVerdicts(reports: readonly unknown[]): Map<string, { at: number; report: VerdictReport }> {
  const latest = new Map<string, { at: number; report: VerdictReport }>();
  for (const value of reports) {
    const report = value as Partial<VerdictReport> | null;
    if (report?.schema !== "space.cli-canary.verdict.v1" || typeof report.cli !== "string") continue;
    const at = Date.parse(String(report.generatedAt));
    if (!Number.isFinite(at)) continue;
    const current = latest.get(report.cli);
    if (!current || at > current.at) latest.set(report.cli, { at, report: report as VerdictReport });
  }
  return latest;
}

const text = (value: unknown) => (typeof value === "string" ? value : null);

export function summarizeCliCanary(
  reports: readonly unknown[],
  { now = Date.now(), maxAgeDays = 9 }: { now?: number; maxAgeDays?: number } = {}
): CliCanarySummary {
  const rows = [...latestCliCanaryVerdicts(reports)].map(([cli, { at, report }]) => {
    const ageDays = Math.floor((now - at) / DAY_MS);
    const stale = ageDays > maxAgeDays;
    const verdict = text(report.verdict) ?? "UNKNOWN";
    return {
      cli, verdict, candidateVersion: text(report.candidateVersion), liveCurrentTarget: text(report.liveCurrentTarget),
      blockedReason: text(report.blockedReason), promotion: text(report.promotion), generatedAt: report.generatedAt, ageDays, stale,
      needsAttention: verdict !== "PASS" || stale
    };
  }).sort((a, b) => a.cli.localeCompare(b.cli));
  const newest = rows.reduce((max, row) => Math.max(max, Date.parse(row.generatedAt)), 0);
  return { checkedAt: new Date(now).toISOString(), canaryLastRanAt: newest ? new Date(newest).toISOString() : null, rows,
    ok: rows.length > 0 && rows.every((row) => !row.needsAttention) };
}
