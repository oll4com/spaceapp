import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { isolatedOpenCodeEnvironment, listFreeModels, openCodeExecutor, parseFreeModelCatalog, probeFreeModel } from "@space/opencode-control";
import { readVerifiedFreeModel } from "./verified-free-model.js";

const unavailable = () => new Error("The selected free Room Agent did not complete its bounded setup task.");

/**
 * The selected free model must still be free and complete a real tool call (operator rule 2026-10-11) in an OpenCode 2
 * standalone run with a throwaway home: it owns only that child and home, never an operator room, pane, CLI session or
 * the panes' OpenCode store.
 */
export function createSetupRoomAgentCheck(options: { memoryRoot?: string; scratchRoot: string; command?: string;
  /** A public install has no OpenCode in core (1.1.7 decision B): the catalog and the probe run in the CLI container. */
  openCodeModels?: (provider: string) => Promise<string>; checkFreeModel?: (modelId: string) => Promise<boolean> }) {
  const command = options.command ?? "/usr/local/bin/opencode";
  const selected = async () => {
    const modelId = await readVerifiedFreeModel(options.memoryRoot);
    if (!modelId) throw unavailable();
    return modelId;
  };
  return {
    fingerprint: async () => {
      const modelId = await selected();
      if (options.checkFreeModel) return createHash("sha256").update(JSON.stringify({ version: "room-agent-setup:v2-cli-container", modelId })).digest("hex");
      const binary = await stat(command);
      if (!binary.isFile()) throw unavailable();
      return createHash("sha256").update(JSON.stringify({ version: "room-agent-setup:v2", modelId,
        runtime: process.version, binarySize: binary.size, binaryModified: binary.mtimeMs })).digest("hex");
    },
    exercise: async () => {
      const modelId = await selected();
      if (options.checkFreeModel && options.openCodeModels) {
        const listed = parseFreeModelCatalog(await options.openCodeModels("opencode").catch(() => "")).includes(modelId);
        if (!listed || !await options.checkFreeModel(modelId) || await selected() !== modelId) throw unavailable();
        return;
      }
      await mkdir(options.scratchRoot, { recursive: true, mode: 0o700 });
      const { directory, env, work } = await isolatedOpenCodeEnvironment(options.scratchRoot);
      try {
        const execute = openCodeExecutor(command);
        if (!(await listFreeModels({ env, cwd: work, execute, timeoutMs: 10_000 })).includes(modelId)) throw unavailable();
        const probe = await probeFreeModel(modelId, { env, work, execute, timeoutMs: 45_000 });
        if (!probe.ok || await selected() !== modelId) throw unavailable();
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
  };
}
