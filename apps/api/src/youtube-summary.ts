import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { YOUTUBE_SUMMARY_MODELS } from "@space/contracts";
import { SpaceConflictError, SpaceFeatureDisabledError } from "@space/runtime";
import { createVideoEngine, type VideoEngineRun } from "./video/engine.js";

export type YouTubeTextKind = "summary" | "transcript";

const PROMPTS: Record<YouTubeTextKind, string> = {
  summary: "Summarize this YouTube video for someone deciding whether to watch it. Start with two or three sentences on what it is about, "
    + "then up to eight key points, each on its own line starting with \"- \" and with its time (m:ss) where that helps. "
    + "Plain text only: no headings, bold or links. Write in English.",
  transcript: "Transcribe everything said in this video, word for word, in the language it is spoken. Start a new paragraph at each change of "
    + "speaker or topic, beginning with its time (m:ss). Plain text only: no headings, bold, notes or comments. "
    + "If nothing is said, write the text shown on screen instead."
};

const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
/** YouTube's json3 captions as paragraphs of at most 30 s (a new one after a pause), each starting with its time (m:ss). */
export function captionsText(json3: string): string {
  const events = (JSON.parse(json3) as { events?: Array<{ tStartMs?: number; dDurationMs?: number; segs?: Array<{ utf8?: string }> }> }).events ?? [];
  const paragraphs: string[] = [];
  let start = 0, end = 0, words: string[] = [];
  const flush = () => { if (words.length) paragraphs.push(`${clock(start)} ${words.join(" ")}`); words = []; };
  for (const event of events) {
    const text = (event.segs ?? []).map((seg) => seg.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const at = event.tStartMs ?? 0;
    if (words.length && (at - end > 1500 || at - start > 30_000)) flush();
    if (!words.length) start = at;
    words.push(text);
    end = at + (event.dDurationMs ?? 0);
  }
  flush();
  return paragraphs.join("\n\n");
}

let captionsEngine: VideoEngineRun | null = null;
/**
 * The video's own captions in the language it is spoken, as text, or null when it has none: the Video engine's captions op (yt-dlp,
 * through the CLI VPN routes when YouTube asks the server to sign in) in a work dir of its own under the Video work root.
 */
export async function youtubeCaptions(options: { workRoot: string; toolsDir: string; videoId: string; engine?: VideoEngineRun }): Promise<string | null> {
  await mkdir(options.workRoot, { recursive: true, mode: 0o750 });
  const workDir = await mkdtemp(join(options.workRoot, "youtube-text-"));
  try {
    const engine = options.engine ?? (captionsEngine ??= createVideoEngine());
    const result = await engine({ op: "captions", workDir, toolsDir: options.toolsDir, url: `https://www.youtube.com/watch?v=${options.videoId}` });
    return typeof result.path === "string" ? captionsText(await readFile(result.path, "utf8")) || null : null;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * The YouTube pane's "Summarize with AI" and "Full text" (operator requests 2026-10-20): the user's chosen Gemini model watches the public
 * video on Space Gateway's Antigravity accounts (`POST /gemini/v1/generate`) with the API's own gateway key, read on every call.
 * shortcut: a transcript takes about 5 s per minute of video (15 minutes: 77 s) and the gateway waits 240 s, so videos past ~40 minutes time out;
 * upgrade to streaming or chunked transcription if the operator needs long ones.
 * Full text reads the video's own captions first (exact and in seconds): Gemini answered word-for-word requests with no text (STOP) on
 * every video on 2026-10-21, so it only listens to videos without captions.
 */
export async function youtubeVideoText(options: { gatewayUrl: string; keyFile: string | null; model?: string; videoId: string; kind: YouTubeTextKind;
  fetchImpl?: typeof fetch; captions?: (videoId: string) => Promise<string | null> }): Promise<{ text: string; model: string }> {
  if (options.kind === "transcript" && options.captions) {
    const text = await options.captions(options.videoId).catch(() => null);
    if (text) return { text, model: "YouTube captions" };
  }
  const key = options.keyFile ? (await readFile(options.keyFile, "utf8").catch(() => "")).trim() : "";
  if (!key) throw new SpaceFeatureDisabledError("YOUTUBE_SUMMARY_UNAVAILABLE", "Video summaries need Space Gateway's key on this server (SPACE_GATEWAY_KEY_FILE).");
  const model = options.model ?? YOUTUBE_SUMMARY_MODELS[0].id;
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${options.gatewayUrl}/gemini/v1/generate`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: PROMPTS[options.kind], videoUrl: `https://www.youtube.com/watch?v=${options.videoId}` }),
      signal: AbortSignal.timeout(280_000)
    });
  } catch (error) {
    throw new SpaceFeatureDisabledError("YOUTUBE_SUMMARY_UNAVAILABLE", `Space Gateway did not answer: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
  }
  const body = await response.json().catch(() => null) as { text?: unknown; error?: { message?: string } | string } | null;
  if (response.ok && typeof body?.text === "string" && body.text.trim()) return { text: body.text.trim(), model };
  const message = typeof body?.error === "object" ? body.error.message : undefined;
  throw new SpaceConflictError(`Gemini could not read the video: ${message ?? `HTTP ${response.status}`}`.slice(0, 300));
}
