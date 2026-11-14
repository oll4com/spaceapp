import { VIDEO_TTS_LANGUAGES, type VideoJobOp } from "@space/contracts";
import { SpaceConflictError } from "@space/runtime";
import { classifyLoad, createHostSwap, type HostSwapReader } from "../nous/server-load.js";
import { liveKitMeter, type LiveKitMeter } from "../livekit-meter.js";
import { spawn } from "../safe-child-process.js";

// The Video pane's engine runner (plan clipboard:-HpLbbtWKj53, Phase 3): one engine process per op, like the Design renderer,
// with JSON-lines progress instead of a base64 answer. Heavy work (ffmpeg, faster-whisper, PySceneDetect, Kokoro) runs in the
// API's own child processes, never in the CLI's throttled cgroup; the same path from src/video/ and dist/video/.
const runner = new URL("../../../../scripts/space-video-engine.mjs", import.meta.url).pathname;
/** Results are paths inside the job's work dir, never file bytes. */
const MAX_STDOUT_BYTES = 1024 * 1024;
/** How many engine processes the API runs at once, for every owner together. */
export const VIDEO_ENGINE_MAX_CONCURRENT = 2;
export const VIDEO_OP_TIMEOUT_MS: Record<VideoJobOp, number> = {
  probe: 10 * 60_000, fetch: 30 * 60_000, captions: 60_000, proxy: 10 * 60_000, transcribe: 20 * 60_000, analyze: 15 * 60_000, assemble: 30 * 60_000, tts: 5 * 60_000, music_search: 20_000, music_fetch: 60_000
};

export interface VideoEngineProgress { progress: number; message: string }
export type VideoEngineJob = { op: VideoJobOp; workDir: string; toolsDir: string } & Record<string, unknown>;
export type VideoEngineRun = (job: VideoEngineJob, onProgress?: (progress: VideoEngineProgress) => void) => Promise<Record<string, unknown>>;
export interface VideoEngineOptions {
  /** Test seam: runs the engine with the JSON job on stdin, feeds progress lines, and returns the final result line. */
  run?(request: string, timeoutMs: number, onProgress: (progress: VideoEngineProgress) => void): Promise<string>;
  /** Test seam: the server's load level; OVERLOADED refuses new jobs. */
  load?(): { level: string; reasons: string[] } | Promise<{ level: string; reasons: string[] }>;
  /** The physical host's swap (Nous's rule: only its swap past 90% is OVERLOADED); without it, this machine's. */
  hostSwap?: HostSwapReader;
  /** Test seam: the LiveKit Inference grant's meter and stop (livekit-meter.ts). */
  liveKit?: LiveKitMeter;
}

/** Today's default narration for the job's language (Kokoro, else Chatterbox), keeping the job's voice only when it is a Kokoro voice. */
export function localNarration(job: VideoEngineJob): VideoEngineJob {
  const base = String(job.language ?? "en").split("-")[0]!.toLowerCase();
  const engine = VIDEO_TTS_LANGUAGES[base]?.find((item) => item === "kokoro" || item === "chatterbox") ?? "kokoro";
  return { ...job, engine, voice: /^[a-z]{2}_[a-z]+$/.test(String(job.voice)) ? job.voice : undefined };
}

/** Runs the engine in its own process group so a timeout also ends the ffmpeg and Python it started. */
function runEngine(request: string, timeoutMs: number, onProgress: (progress: VideoEngineProgress) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    // ccMixter repeats its JSON answer in an X-JSON header (20 KB for "upbeat"): past fetch's 16 KB default every music search failed.
    const child = spawn(process.execPath, ["--max-http-header-size=1048576", runner, "--stdin"], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let size = 0;
    let pending = "";
    let result: string | null = null;
    let err = "";
    let failure: string | null = null;
    const kill = (reason: string) => { failure ??= reason; try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } };
    const timer = setTimeout(() => kill(`The video engine timed out after ${Math.round(timeoutMs / 60_000)} minutes.`), timeoutMs);
    const takeLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line) as { progress?: unknown; message?: unknown; result?: unknown };
        if (parsed.result !== undefined) result = line;
        else if (typeof parsed.progress === "number") onProgress({ progress: Math.max(0, Math.min(100, parsed.progress)), message: typeof parsed.message === "string" ? parsed.message.slice(0, 400) : "" });
      } catch { /* not a protocol line */ }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_STDOUT_BYTES) { kill("The video engine printed more than 1 MB."); return; }
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) takeLine(line);
    });
    child.stderr.on("data", (chunk: Buffer) => { err = (err + chunk.toString("utf8")).slice(-800); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      takeLine(pending);
      if (failure) reject(new SpaceConflictError(failure));
      else if (code === 0 && result) resolve(result);
      else reject(new SpaceConflictError(`The video engine failed: ${err.trim().split("\n").at(-1)?.slice(0, 400) || `exit ${code}`}`));
    });
    child.stdin.end(request);
  });
}

/**
 * The engine as the service calls it: at most two processes at once, none while the server is overloaded (the agent waits and
 * tries again), the op's own timeout, progress lines forwarded.
 */
export function createVideoEngine(options: VideoEngineOptions = {}): VideoEngineRun {
  let running = 0;
  const hostSwap = options.hostSwap ?? createHostSwap({});
  const currentLoad = async () => { const host = await hostSwap.read(); return classifyLoad({ swapPercent: host.percent, host: host.host }); };
  return async (job, onProgress) => {
    const load = await (options.load ?? currentLoad)();
    if (load.level === "OVERLOADED") throw new SpaceConflictError(`The server is overloaded (${load.reasons.join(", ")}); try the video job again in a few minutes.`);
    if (running >= VIDEO_ENGINE_MAX_CONCURRENT) throw new SpaceConflictError("Two video jobs are already running; try again when one ends.");
    const liveKit = options.liveKit ?? liveKitMeter;
    const speaks = job.op === "tts" || job.op === "transcribe";
    // Past 95% of the metered LiveKit grant (or its expiry) a LiveKit job runs on today's local default, never on LiveKit's card billing.
    if (speaks && job.engine === "livekit" && !(await liveKit.open())) job = job.op === "tts" ? localNarration(job) : { ...job, engine: "whisper" };
    running += 1;
    const run = async (current: VideoEngineJob) => {
      const stdout = await (options.run ?? runEngine)(JSON.stringify(current), VIDEO_OP_TIMEOUT_MS[current.op], onProgress ?? (() => undefined));
      const parsed = JSON.parse(stdout) as { result?: Record<string, unknown> };
      if (!parsed.result || typeof parsed.result !== "object") throw new SpaceConflictError("The video engine returned no result.");
      return parsed.result;
    };
    try {
      // Murf's credits are prepaid and Cartesia's overages are off (both refuse once the credits are spent, no card is billed): a failure falls back to the local voice.
      const result = await run(job).catch((error) => job.op === "tts" && (job.engine === "murf" || job.engine === "cartesia") ? run(localNarration(job)) : Promise.reject(error));
      if (speaks && job.engine === "livekit") {
        await liveKit.record(job.op === "tts" ? { source: "video", kind: "tts", model: "cartesia/sonic-3", characters: String(job.text ?? "").length }
          : { source: "video", kind: "stt", model: "deepgram/nova-3", seconds: Number(result.durationSec) || 0 })
          .catch((error) => console.warn("[video] LiveKit Inference use not metered", error));
      }
      return result;
    } finally {
      running -= 1;
    }
  };
}
