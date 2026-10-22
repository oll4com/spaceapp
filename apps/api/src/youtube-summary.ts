import { readFile } from "node:fs/promises";
import { YOUTUBE_SUMMARY_MODELS } from "@space/contracts";
import { SpaceConflictError, SpaceFeatureDisabledError } from "@space/runtime";

export type YouTubeTextKind = "summary" | "transcript";

const PROMPTS: Record<YouTubeTextKind, string> = {
  summary: "Summarize this YouTube video for someone deciding whether to watch it. Start with two or three sentences on what it is about, "
    + "then up to eight key points, each on its own line starting with \"- \" and with its time (m:ss) where that helps. "
    + "Plain text only: no headings, bold or links. Write in English.",
  transcript: "Transcribe everything said in this video, word for word, in the language it is spoken. Start a new paragraph at each change of "
    + "speaker or topic, beginning with its time (m:ss). Plain text only: no headings, bold, notes or comments. "
    + "If nothing is said, write the text shown on screen instead."
};

/**
 * The YouTube pane's "Summarize with AI" and "Full text" (operator requests 2026-10-20): the user's chosen Gemini model watches the public
 * video on Space Gateway's Antigravity accounts (`POST /gemini/v1/generate`) with the API's own gateway key, read on every call.
 * shortcut: a transcript takes about 5 s per minute of video (15 minutes: 77 s) and the gateway waits 240 s, so videos past ~40 minutes time out;
 * upgrade to streaming or chunked transcription if the operator needs long ones.
 */
export async function youtubeVideoText(options: { gatewayUrl: string; keyFile: string | null; model?: string; videoId: string; kind: YouTubeTextKind;
  fetchImpl?: typeof fetch }): Promise<{ text: string; model: string }> {
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
