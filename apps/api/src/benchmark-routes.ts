import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";

/**
 * Benchmark results API — read-only views over the published
 * space-model-benchmark results directory.
 *
 * Data source: directory of JSON files produced by
 * `space-model-benchmark.sh --publish` (leaderboard.json + <runId>.json).
 * Default location is /opt/spaceapp/var/space-model-benchmark; override with
 * SPACE_BENCHMARK_RESULTS_DIR. The routes are guarded by the global /api/*
 * authentication hook, so they only serve authenticated users.
 */

const DEFAULT_RESULTS_DIR = "/opt/spaceapp/var/space-model-benchmark";
const MAX_RUN_FILES = 50;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const RUN_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export interface BenchmarkTaskResult {
  taskId: string;
  category: string;
  title: string;
  durationMs?: number;
  turnStatus?: string;
  tokens?: { total?: number; input?: number; output?: number } | null;
  deterministic?: { score: number; checks: Array<{ id: string; pass: boolean }> };
  judge?: { score: number | null; skipped?: boolean; criteria: Array<{ criterion: string; score: number | null }> };
  finalScore: number | null;
  error?: string;
}

export interface BenchmarkRunRecord {
  runTs: string;
  runId: string;
  model: string;
  runtime: string;
  judgeModel?: string | null;
  noJudge?: boolean;
  tasks: BenchmarkTaskResult[];
}

export interface BenchmarkLeaderboardResponse {
  available: boolean;
  resultsDir: string;
  generatedAt: string;
  runs: BenchmarkRunRecord[];
}

function resultsDir(): string {
  const configured = process.env.SPACE_BENCHMARK_RESULTS_DIR;
  return configured && configured.trim() ? configured.trim() : DEFAULT_RESULTS_DIR;
}

async function loadRunFiles(dir: string): Promise<Array<{ runId: string; record: BenchmarkRunRecord }>> {
  const entries = await readdir(dir);
  const jsonFiles = entries
    .filter((name) => name.endsWith(".json") && name !== "leaderboard.json")
    .sort()
    .slice(0, MAX_RUN_FILES);
  const runs: Array<{ runId: string; record: BenchmarkRunRecord }> = [];
  for (const name of jsonFiles) {
    const fullPath = join(dir, name);
    const info = await stat(fullPath).catch(() => null);
    if (!info || !info.isFile() || info.size > MAX_FILE_BYTES) continue;
    const text = await readFile(fullPath, "utf8");
    let record: unknown;
    try {
      record = JSON.parse(text);
    } catch {
      continue;
    }
    const candidate = record as Partial<BenchmarkRunRecord> | null;
    if (!candidate || typeof candidate.runId !== "string" || typeof candidate.model !== "string") continue;
    runs.push({ runId: candidate.runId, record: candidate as BenchmarkRunRecord });
  }
  runs.sort((left, right) => right.record.runTs.localeCompare(left.record.runTs));
  return runs;
}

export function registerBenchmarkRoutes(app: FastifyInstance, rateLimitOptions: RouteShorthandOptions): void {
  app.get("/api/benchmark/leaderboard", rateLimitOptions, async () => {
    const dir = resultsDir();
    let runs: Array<{ runId: string; record: BenchmarkRunRecord }> = [];
    let available = false;
    try {
      runs = await loadRunFiles(dir);
      available = true;
    } catch {
      available = false;
    }
    return {
      available,
      resultsDir: dir,
      generatedAt: new Date().toISOString(),
      runs: runs.map((entry) => entry.record)
    } satisfies BenchmarkLeaderboardResponse;
  });

  app.get<{ Params: { runId: string } }>("/api/benchmark/runs/:runId", rateLimitOptions, async (request, reply) => {
    const runId = request.params?.runId ?? "";
    if (!RUN_ID_PATTERN.test(runId) || runId.includes("..")) {
      return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "Invalid run id." } });
    }
    const dir = resultsDir();
    const fullPath = join(dir, `${runId}.json`);
    try {
      const info = await stat(fullPath);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Benchmark run not found." } });
      }
      const text = await readFile(fullPath, "utf8");
      return JSON.parse(text) as BenchmarkRunRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Benchmark run not found." } });
      }
      return reply.code(500).send({ error: { code: "INTERNAL", message: "Benchmark results could not be read." } });
    }
  });
}
