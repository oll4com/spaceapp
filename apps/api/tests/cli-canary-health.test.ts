import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cliCanaryHealth, cliHealthChecks } from "../src/cli-canary-health.js";

// ADAPTER-001: System Health shows each CLI's newest weekly canary verdict, so a BLOCKED or stale one is seen.
const now = Date.parse("2026-10-28T08:00:00Z");
const verdict = (cli: string, generatedAt: string, extra: Record<string, unknown> = {}) => ({
  schema: "space.cli-canary.verdict.v1", cli, generatedAt, verdict: "PASS", candidateVersion: "2.0.0", liveCurrentTarget: "1.0.0", ...extra
});

async function reportsDir(reports: unknown[]) {
  const dir = await mkdtemp(join(tmpdir(), "space-canary-health-"));
  await Promise.all(reports.map((report, index) => writeFile(join(dir, `${index}.json`), JSON.stringify(report))));
  return dir;
}

describe("CLI canary health check", () => {
  it("warns about a BLOCKED or stale CLI and lists every CLI's newest verdict", async () => {
    const dir = await reportsDir([
      verdict("codex", "2026-10-25T02:00:00Z"),
      verdict("qwen", "2026-10-18T02:00:00Z", { verdict: "BLOCKED", blockedReason: "PATCH_REBASE_REQUIRED" }),
      verdict("qwen", "2026-10-25T02:00:00Z", { verdict: "BLOCKED", blockedReason: "PATCH_REBASE_REQUIRED", candidateVersion: "0.26.1", liveCurrentTarget: "0.23.2-space.2" }),
      verdict("kimi", "2026-10-11T02:00:00Z")
    ]);
    try {
      const health = await cliCanaryHealth(dir, now);
      expect(health.status).toBe("warning");
      expect(health.detail).toBe("Needs review: kimi verdict 17 days old; qwen BLOCKED (PATCH_REBASE_REQUIRED)");
      expect(health.values).toEqual([
        { label: "Last run", value: "2026-10-25T02:00:00.000Z" },
        { label: "codex", value: "PASS 2.0.0 (runs 1.0.0)" },
        { label: "kimi", value: "PASS 2.0.0 (runs 1.0.0)" },
        { label: "qwen", value: "BLOCKED 0.26.1 (runs 0.23.2-space.2)" }
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is healthy when every newest verdict passed, unavailable with no verdicts or no folder", async () => {
    const passing = await reportsDir([verdict("codex", "2026-10-25T02:00:00Z"), { not: "a verdict" }]);
    const empty = await reportsDir([]);
    try {
      expect(await cliCanaryHealth(passing, now)).toMatchObject({ status: "healthy", detail: "Every CLI's newest canary verdict passed" });
      expect(await cliCanaryHealth(empty, now)).toMatchObject({ status: "unavailable" });
      expect(await cliCanaryHealth(join(empty, "missing"), now)).toMatchObject({ status: "unavailable" });
    } finally {
      await rm(passing, { recursive: true, force: true });
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("is disabled on a public installation, which runs no canary", async () => {
    const check = cliHealthChecks(true).find((entry) => entry.id === "cli-canary");
    expect(await check?.collect()).toEqual({ status: "disabled", detail: "Not used in public installations", values: [] });
    expect(cliHealthChecks(false).map((entry) => entry.id)).toEqual(["cli-resource-guard", "cli-canary"]);
  });
});
