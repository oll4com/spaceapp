import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { PaneCliSession } from "@space/contracts";
const metadataSchema = z.object({
  nativeId: z.string().max(200).nullable(),
  title: z.string().max(160).nullable().optional(),
  manual: z.boolean().optional(),
  requests: z.array(z.string().max(3000)).max(12).optional(),
});
export type NativeTaskMetadata = z.infer<typeof metadataSchema>;
const commands: Record<string, string> = {
  "cli:qwen": "/opt/spaceapp/bin/qwen-vscode-parity",
  "cli:hermes": "/opt/spaceapp/bin/hermes-vscode-parity",
};
/** The helper has its own process group; cancellation never targets the task PID. */
export async function runNativeMetadataCommand(
  command: string,
  args: string[],
  request: string,
  signal?: AbortSignal,
  timeoutMs = 5000,
  maxOutputBytes = 64000,
  execution?: { env: NodeJS.ProcessEnv; cwd: string },
): Promise<string> {
  signal?.throwIfAborted();
  if (Buffer.byteLength(request) > 4096)
    throw Error("Oversized native metadata request.");
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      ...execution,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "",
      failed = false;
    const stop = () => {
      failed = true;
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    };
    const timeout = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data) => {
      stdout += data;
      if (Buffer.byteLength(stdout) > maxOutputBytes) stop();
    });
    child.stdin.on("error", () => {});
    child.once("error", () => {
      failed = true;
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", stop);
      if (failed || code !== 0)
        reject(Error("Native task metadata unavailable."));
      else resolve(stdout);
    });
    if (signal?.aborted) stop();
    else child.stdin.end(request);
  });
}
export async function nativeProcessIdentity(pid: number): Promise<string> {
  const [stat, boot] = await Promise.all([
    readFile(`/proc/${pid}/stat`, "utf8"),
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
  ]);
  const ticks = stat
    .slice(stat.lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/)[19];
  if (!/^\d+$/.test(ticks ?? ""))
    throw Error("Native process identity unavailable.");
  return `linux:${boot.trim()}:${ticks}`;
}
export class NativeTaskTitles {
  constructor(
    private activePid: (session: PaneCliSession) => Promise<number | null>,
  ) {}
  async metadata(
    session: PaneCliSession,
    update?: {
      nativeId: string;
      title: string;
      manual: boolean;
      resetManual?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<NativeTaskMetadata | null> {
    const command = commands[session.runtimeId];
    if (!command) return null;
    const rootPid = await this.activePid(session);
    if (!rootPid) return null;
    const rootIdentity = await nativeProcessIdentity(rootPid);
    const request = JSON.stringify({ rootPid, rootIdentity, ...update });
    const output = await runNativeMetadataCommand(
      command,
      ["task-metadata"],
      request,
      signal,
    );
    if ((await nativeProcessIdentity(rootPid)) !== rootIdentity)
      throw Error("Native task process changed.");
    return metadataSchema.parse(JSON.parse(output));
  }
}
