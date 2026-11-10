import type { FastifyInstance } from "fastify";
import type { SpaceStore } from "@space/runtime";
import type { AppDiagnosticsService } from "./app-diagnostics.js";
import { sweepExpiredBrowserArtifacts } from "./artifact-storage.js";
import type { SpaceApiConfig } from "./config.js";

export interface DatabaseRetentionSweepResult {
  deletedChunks: number;
  batches: number;
  /** Copilot runs stopped because their pane is gone (DATA-001). */
  stoppedCopilotRuns: Array<{ table: string; id: string }>;
}

// Closed panes are never pruned here (Record Retention Invariant 2026-10-20): only POST /api/admin/panes/prune deletes them.
export async function runDatabaseRetentionSweep(input: {
  store: SpaceStore;
  olderThanDays?: number;
  batchLimit?: number;
  maxBatches?: number;
}): Promise<DatabaseRetentionSweepResult> {
  const olderThanDays = input.olderThanDays ?? 7;
  const batchLimit = input.batchLimit ?? 500;
  const maxBatches = input.maxBatches ?? 10;
  let totalDeletedChunks = 0;
  let totalBatches = 0;

  const pruneChunksFn = (input.store as {
    pruneExpiredCliTranscriptChunks?: (opts?: {
      olderThanDays?: number;
      batchSize?: number;
    }) => Promise<{ deletedChunks: number }> | { deletedChunks: number };
  }).pruneExpiredCliTranscriptChunks;

  if (typeof pruneChunksFn === "function") {
    let chunkBatches = 0;
    while (chunkBatches < maxBatches) {
      const result = await pruneChunksFn.call(input.store, {
        olderThanDays,
        batchSize: batchLimit
      });
      totalDeletedChunks += result.deletedChunks;
      chunkBatches += 1;
      if (result.deletedChunks < batchLimit) break;
    }
    totalBatches = Math.max(totalBatches, chunkBatches);
  }

  const stopOrphans = (input.store as { stopOrphanedCopilotRuns?: () => Promise<{ stopped: Array<{ table: string; id: string }> }> }).stopOrphanedCopilotRuns;
  const stoppedCopilotRuns = typeof stopOrphans === "function" ? (await stopOrphans.call(input.store)).stopped : [];

  return {
    deletedChunks: totalDeletedChunks,
    batches: totalBatches,
    stoppedCopilotRuns
  };
}

/**
 * The API's periodic retention sweeps (expired browser artifacts, app diagnostics, CLI transcript chunks), each skipped
 * while its previous run is still going. The onReady hook schedules them and onClose clears the timers.
 */
export function createRetentionSweeps(app: FastifyInstance, options: {
  config: SpaceApiConfig;
  store: SpaceStore;
  appDiagnosticsService: AppDiagnosticsService;
}) {
  const { config, store, appDiagnosticsService } = options;
  let artifactRetentionSweepRunning = false;
  let appDiagnosticsRetentionSweepRunning = false;
  let dbRetentionSweepRunning = false;

  async function runArtifactRetentionSweep() {
    if (artifactRetentionSweepRunning) return;
    artifactRetentionSweepRunning = true;
    try {
      const result = await sweepExpiredBrowserArtifacts({ store, artifactRoot: config.browserEvidenceArtifactRoot });
      if (result.softDeleted > 0 || result.fileErrors.length > 0) {
        app.log.info(
          {
            softDeleted: result.softDeleted,
            filesRemoved: result.filesRemoved,
            fileErrorCount: result.fileErrors.length,
            fileErrorArtifactIds: result.fileErrors.map((entry) => entry.artifactId)
          },
          "Browser artifact retention sweep completed."
        );
      }
    } catch (error) {
      app.log.error({ err: error }, "Browser artifact retention sweep failed.");
    } finally {
      artifactRetentionSweepRunning = false;
    }
  }

  async function runAppDiagnosticsRetentionSweep() {
    if (appDiagnosticsRetentionSweepRunning) return;
    appDiagnosticsRetentionSweepRunning = true;
    try {
      const result = await appDiagnosticsService.sweepExpired();
      if (result.segmentsDeleted > 0 || result.leasesDeleted > 0 || result.capturesDeleted > 0) {
        app.log.info(result, "App diagnostics retention sweep completed.");
      }
    } catch (error) {
      app.log.error({ err: error }, "App diagnostics retention sweep failed.");
    } finally {
      appDiagnosticsRetentionSweepRunning = false;
    }
  }

  async function executeDatabaseRetentionSweep() {
    if (!config.enableDbSweep) return;
    if (dbRetentionSweepRunning) return;
    dbRetentionSweepRunning = true;
    try {
      const result = await runDatabaseRetentionSweep({ store });
      if (result.deletedChunks > 0) {
        app.log.info(
          { deletedChunks: result.deletedChunks, batches: result.batches },
          "Database retention sweep completed."
        );
      }
      if (result.stoppedCopilotRuns.length > 0) {
        app.log.info({ stoppedCopilotRuns: result.stoppedCopilotRuns }, "Stopped copilot runs whose pane is gone.");
      }
    } catch (error) {
      app.log.error({ err: error }, "Database retention sweep failed.");
    } finally {
      dbRetentionSweepRunning = false;
    }
  }

  return { runArtifactRetentionSweep, runAppDiagnosticsRetentionSweep, executeDatabaseRetentionSweep };
}
