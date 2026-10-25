import { assertDevInstanceIsolated } from "@space/contracts";
import { hideNestedCodexSkills } from "./agent-tools.js";
import { createApp } from "./app.js";
import { getApiConfig } from "./config.js";
import { reportEventLoopLoad } from "./event-loop-report.js";
import { loadOwnerSetupBootstrap } from "./owner-setup.js";
import { pluginsService } from "./plugins-service.js";
import { installProcessGuards } from "./process-guards.js";

assertDevInstanceIsolated(process.env, "api");
const config = getApiConfig(process.env);
const setup = await loadOwnerSetupBootstrap(process.env);
const app = await createApp({
  config,
  setup,
  agentToolsOptions: {
    rootWriterCommand: config.agentToolsWriterCommand
  },
  resumeChessTournament: config.instanceJobs["chess-tournament-resume"]
});

installProcessGuards({ log: app.log, shutdown: () => app.close() });
if (process.env.SPACE_DATABASE_POOL_MAX) {
  app.log.warn(`SPACE_DATABASE_POOL_MAX=${config.databasePoolMax} is ignored: every db module shares one pool per process, sized by SPACE_DATABASE_SHARED_POOL_MAX (default 20).`);
}

await app.listen({ host: config.host, port: config.port });
reportEventLoopLoad(app.log);
// Built-in skill plugins reach the CLIs only through these links, which live in stable's skill directories.
if (config.instanceJobs["plugin-skill-links"]) {
  // After each sync (start, connect, disconnect) Codex sees only the bundle indexes.
  pluginsService.onSkillsSynced = () => hideNestedCodexSkills({ rootWriterCommand: config.agentToolsWriterCommand })
    .catch((error: unknown) => app.log.warn({ err: error }, "Hiding nested bundle skills from Codex failed"));
  void pluginsService.syncSkillSymlinks().catch(() => {});
}
