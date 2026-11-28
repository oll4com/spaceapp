import { initNodeSentry, flushSentry } from "@space/contracts/sentry-node";
import { assertDevInstanceIsolated } from "@space/contracts";
import { hideNestedCodexSkills } from "./agent-tools.js";
import { createSpacePgPool } from "@space/db";
import { createApp } from "./app.js";
import { CELLS_TICK_MS, nousComputerFromEnv } from "./computer/provisioning.js";
import { getApiConfig } from "./config.js";
import { reportEventLoopLoad } from "./event-loop-report.js";
import { sampleApiMemory } from "./memory-sampler.js";
import { loadOwnerSetupBootstrap } from "./owner-setup.js";
import { pluginsService } from "./plugins-service.js";
import { seedStarterSpaceMemory } from "@space/runtime";
import { startExecHelper } from "./safe-child-process.js";
import { installProcessGuards } from "./process-guards.js";

assertDevInstanceIsolated(process.env, "api");
startExecHelper();
initNodeSentry("api");
const config = getApiConfig(process.env);
const setup = await loadOwnerSetupBootstrap(process.env);
// Nous Computer (plan clipboard:ZGz1LnD51ELH step 7): cells and the account lifecycle exist only headless, with SPACE_CELLS_* set.
const computer = config.headless && config.databaseUrl ? nousComputerFromEnv(process.env, createSpacePgPool(config.databaseUrl)) : null;
const app = await createApp({
  config,
  setup,
  agentToolsOptions: {
    rootWriterCommand: config.agentToolsWriterCommand
  },
  resumeChessTournament: config.instanceJobs["chess-tournament-resume"],
  accountLifecycle: computer?.lifecycle,
  accountAiKeys: computer?.aiKeys,
  nousComputer: computer?.turns
});
if (computer) {
  setInterval(() => void computer.cells.tick().then(({ errors }) => {
    for (const { tenantId, error } of errors) app.log.warn({ err: error, tenantId }, "Nous Computer cell tick failed for a tenant; retried next tick.");
  }, (error: unknown) => app.log.warn({ err: error }, "Nous Computer cell tick failed; retried next tick.")), CELLS_TICK_MS).unref();
}

installProcessGuards({ log: app.log, shutdown: async () => { await flushSentry(); await app.close(); } });
if (process.env.SPACE_DATABASE_POOL_MAX) {
  app.log.warn(`SPACE_DATABASE_POOL_MAX=${config.databasePoolMax} is ignored: every db module shares one pool per process, sized by SPACE_DATABASE_SHARED_POOL_MAX (default 20).`);
}

await app.listen({ host: config.host, port: config.port });
reportEventLoopLoad(app.log);
sampleApiMemory(app.log, app.server);
// Starter Space Memory (operator 27/11): a new public install (Nous Cloud) starts with generic help; never on the operator's own server.
if (config.publicDistribution) {
  void seedStarterSpaceMemory(config.spaceMemoryMonthlyPath).then(({ added }) => { if (added) app.log.info({ added }, "Starter Space Memory seeded."); },
    (error: unknown) => app.log.warn({ err: error }, "Starter Space Memory seeding failed; continuing."));
}
// Built-in skill plugins reach the CLIs only through these links, which live in stable's skill directories.
if (config.instanceJobs["plugin-skill-links"]) {
  // After each sync (start, connect, disconnect) Codex sees only the bundle indexes.
  pluginsService.onSkillsSynced = () => hideNestedCodexSkills({ rootWriterCommand: config.agentToolsWriterCommand })
    .catch((error: unknown) => app.log.warn({ err: error }, "Hiding nested bundle skills from Codex failed"));
  void pluginsService.syncSkillSymlinks().catch(() => {});
}
