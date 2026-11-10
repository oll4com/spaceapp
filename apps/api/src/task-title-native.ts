import { loadAutohandNativeSessionId } from "./autohand-native-session.js";
import { loadDroidNativeSessionId } from "./droid-native-session.js";
import { spawn } from "./safe-child-process.js";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { PaneCliSession } from "@space/contracts";
import { loadOmpNativeSessionId } from "./omp-native-model.js";
import { loadMuseNativeSessionId } from "./muse-native-session.js";
import { loadKimiNativeSessionId } from "./kimi-native-session.js";
import { SPACE_INSTALL_ROOT } from "@space/contracts";
const metadataSchema = z.object({
  nativeId: z.string().max(200).nullable(),
  title: z.string().max(160).nullable().optional(),
  manual: z.boolean().optional(),
  requests: z.array(z.string().max(3000)).max(12).optional(),
});
export type NativeTaskMetadata = z.infer<typeof metadataSchema>;
/** Qwen Code session ids (`qwen --resume <id>`); the wrapper and sudoers admit only this form. */
export const qwenNativeSessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Hermes session ids (`hermes --resume <id>`): 0.22's `local-<sha256>`, older `YYYYMMDD_HHMMSS_<hex6>`; sudoers admits only these. */
export const hermesNativeSessionIdPattern = /^(?:local-[0-9a-f]{64}|[0-9]{8}_[0-9]{6}_[0-9a-f]{6})$/;
const commands: Record<string, string> = {
  "cli:qwen": `${SPACE_INSTALL_ROOT}/bin/qwen-vscode-parity`,
  "cli:hermes": `${SPACE_INSTALL_ROOT}/bin/hermes-vscode-parity`,
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
    private ompSessionId: (session: PaneCliSession, rootPid: number) => Promise<string | null> = loadOmpNativeSessionId,
    private museSessionId: (session: PaneCliSession, rootPid: number) => Promise<string | null> = loadMuseNativeSessionId,
    private kimiSessionId: (session: PaneCliSession, rootPid: number) => Promise<string | null> = loadKimiNativeSessionId,
    private autohandSessionId: (session: PaneCliSession, rootPid: number) => Promise<string | null> = loadAutohandNativeSessionId,
    private droidSessionId: (session: PaneCliSession, rootPid: number) => Promise<string | null> = loadDroidNativeSessionId,
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
    if (session.runtimeId === "cli:omp" || session.runtimeId === "cli:muse" || session.runtimeId === "cli:kimi" || session.runtimeId === "cli:autohand" || session.runtimeId === "cli:droid") {
      // These runtimes keep no title Space syncs. Capture only a native identity bound to the pane's live process:
      // omp's breadcrumb, Muse's lock, Kimi's lease, Autohand's heartbeat or Droid's writable session descriptor.
      if (update) return null;
      const rootPid = await this.activePid(session);
      const read = session.runtimeId === "cli:omp" ? this.ompSessionId : session.runtimeId === "cli:muse" ? this.museSessionId : session.runtimeId === "cli:kimi" ? this.kimiSessionId : session.runtimeId === "cli:droid" ? this.droidSessionId : this.autohandSessionId;
      const nativeId = rootPid ? await read(session, rootPid) : null;
      return nativeId ? { nativeId } : null;
    }
    const command = commands[session.runtimeId];
    if (!command) return null;
    const rootPid = await this.activePid(session);
    if (!rootPid) return null;
    const rootIdentity = await nativeProcessIdentity(rootPid);
    // Hermes 0.22+ binds a pane's session through the Space session its TUI's client env carries (hermes-task-metadata.py).
    const request = JSON.stringify({ rootPid, rootIdentity, ...(session.runtimeId === "cli:hermes" ? { spaceSessionId: session.sessionId } : {}), ...update });
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
