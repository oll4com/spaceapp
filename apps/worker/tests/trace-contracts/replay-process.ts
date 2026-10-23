import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkflowBundle } from "@temporalio/worker";

export async function replayInChild(bundle: WorkflowBundle, directory: string, mode: "positive" | "negative", lane = 0) {
  const temp = await mkdtemp(join(tmpdir(), "spaceapp-trace-replay-"));
  try {
    const codePath = join(temp, "workflows.js");
    await writeFile(codePath, bundle.code);
    return await new Promise<any>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./replay-worker.ts", import.meta.url)),
        mode, codePath, directory, String(lane)], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "", errors = "";
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 45_000);
      child.stdout.on("data", chunk => { output = (output + chunk).slice(-256_000); });
      child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-64_000); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (timedOut) return reject(new Error(`Replay ${mode} lane ${lane} exceeded 45 seconds; its child process was killed.`));
        if (code !== 0) return reject(new Error(`Replay ${mode} lane ${lane} exited ${code ?? signal}: ${errors}`));
        const line = output.split("\n").find(value => value.startsWith("SPACEAPP_REPLAY_RESULT="));
        if (!line) return reject(new Error(`Replay child returned no result: ${errors}`));
        try { resolve(JSON.parse(line.slice("SPACEAPP_REPLAY_RESULT=".length))); }
        catch (error) { reject(error); }
      });
    });
  } finally { await rm(temp, { recursive: true, force: true }); }
}
