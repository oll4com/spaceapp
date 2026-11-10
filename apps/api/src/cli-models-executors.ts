import { readFile, writeFile } from "node:fs/promises";
import { nativeCliCatalogBufferBytes } from "./cli-native-model-picker.js";
import { spawn } from "./safe-child-process.js";
import { SPACE_AGENT_USER, SPACE_INSTALL_ROOT } from "@space/contracts";

/**
 * Model catalogs of the CLIs a Chat pane and the Chess benchmark list: each runtime's `models` command through the CLI
 * VPN broker (DeepSeek through its parity wrapper), cached 10 minutes, retried once, kept on disk as the last good
 * answer for when the command fails. One executor per runtime for the app that creates them.
 */
export function createCliModelsExecutors() {
  const createCliModelsExecutor = (runtimeId: string) => {
    const modelsFile = `${SPACE_INSTALL_ROOT}/var/${runtimeId.replace("cli:", "")}-models.last-good.json`;
    let modelsCache: { raw: string; at: number } | null = null;
    const readModelsFile = async (): Promise<string | null> => {
      try {
        const parsed = JSON.parse(await readFile(modelsFile, "utf8")) as { models?: unknown };
        return typeof parsed.models === "string" && parsed.models.trim() ? parsed.models : null;
      } catch {
        return null;
      }
    };
    const runModels = (): Promise<string> => new Promise((resolve, reject) => {
      const isDeepSeek = runtimeId === "cli:deepseek";
      const child = isDeepSeek
        ? spawn("/usr/bin/sudo", [
            "-n", "-u", SPACE_AGENT_USER, "--",
            `${SPACE_INSTALL_ROOT}/bin/deepseek-vscode-parity`, "--run-inner", "models"
          ], {
            stdio: ["ignore", "pipe", "pipe"],
            env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" }
          })
        : spawn("/usr/bin/sudo", [
            "-n", `${SPACE_INSTALL_ROOT}/bin/space-cli-vpn-broker`, "exec", runtimeId, "models"
          ], {
            stdio: ["ignore", "pipe", "pipe"],
            env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" }
          });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`${runtimeId} model catalog request timed out.`));
      }, 60_000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        // A CLI advertises its whole catalog here (Reasonix returns 300+ rows);
        // the bound only guards against an unbounded stream, not against size.
        if (stdout.length > nativeCliCatalogBufferBytes) child.kill("SIGTERM");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0 || !stdout.trim()) {
          reject(new Error(stderr.trim() || `${runtimeId} model catalog command failed (exit ${code ?? "unknown"}).`));
          return;
        }
        resolve(stdout);
      });
    });
    return async (): Promise<string> => {
      if (modelsCache && Date.now() - modelsCache.at < 10 * 60_000) return modelsCache.raw;
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const stdout = await runModels();
          if (!stdout.trim()) throw new Error(`Empty ${runtimeId} model catalog.`);
          modelsCache = { raw: stdout, at: Date.now() };
          try {
            await writeFile(modelsFile, JSON.stringify({ models: stdout, at: new Date().toISOString() }), "utf8");
          } catch {
            // Best-effort persistence; the live catalog remains authoritative.
          }
          return stdout;
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
      if (modelsCache) return modelsCache.raw;
      const persisted = await readModelsFile();
      if (persisted) return persisted;
      throw new Error(lastError instanceof Error ? lastError.message : `${runtimeId} model catalog is unavailable.`);
    };
  };
  // One cached catalog per runtime, shared by Chat panes and the Chess benchmark.
  const cliModelsExecutors = new Map<string, () => Promise<string>>();
  const cliModelsExecutor = (runtimeId: string) => {
    let executor = cliModelsExecutors.get(runtimeId);
    if (!executor) {
      executor = createCliModelsExecutor(runtimeId);
      cliModelsExecutors.set(runtimeId, executor);
    }
    return executor;
  };
  return cliModelsExecutor;
}
