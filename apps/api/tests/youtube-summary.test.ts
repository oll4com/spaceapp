import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { captionsText, youtubeCaptions, youtubeVideoText } from "../src/youtube-summary.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("YouTube summary", () => {
  let root = "";
  let keyFile = "";
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "youtube-summary-")); keyFile = join(root, "gateway.key"); await writeFile(keyFile, "sk-sgw-test\n"); });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it("asks Space Gateway's Gemini route to watch the video with the default model, the kind's prompt and the key from its file", async () => {
    const fetchImpl = vi.fn(async () => json({ text: "  A man at the zoo.\n- 0:05 elephants  ", model: "gemini-3.8-flash-tiered" }));
    expect(await youtubeVideoText({ gatewayUrl: "http://gw.test", keyFile, videoId: "jNQXAC9IVRw", kind: "summary", fetchImpl: fetchImpl as unknown as typeof fetch }))
      .toEqual({ text: "A man at the zoo.\n- 0:05 elephants", model: "gemini-3.8-flash-tiered" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://gw.test/gemini/v1/generate");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-sgw-test");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "gemini-3.8-flash-tiered", videoUrl: "https://www.youtube.com/watch?v=jNQXAC9IVRw", prompt: expect.stringMatching(/^Summarize/) });
    await youtubeVideoText({ gatewayUrl: "http://gw.test", keyFile, videoId: "jNQXAC9IVRw", kind: "transcript", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(JSON.parse(String((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body)).prompt).toMatch(/^Transcribe everything said/);
  });

  it("gives Full text from the video's own captions and asks Gemini only for videos without them", async () => {
    const fetchImpl = vi.fn(async () => json({ text: "0:00 Gemini heard this." }));
    const captions = vi.fn(async (videoId: string) => videoId === "2rBRIhFPaYQ" ? "0:00 Καλή Τετάρτη σε όλους." : null);
    const call = (videoId: string, kind: "summary" | "transcript" = "transcript") => youtubeVideoText({ gatewayUrl: "http://gw.test", keyFile, videoId, kind, captions, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await call("2rBRIhFPaYQ")).toEqual({ text: "0:00 Καλή Τετάρτη σε όλους.", model: "YouTube captions" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await call("jNQXAC9IVRw")).toEqual({ text: "0:00 Gemini heard this.", model: "gemini-3.8-flash-tiered" });
    captions.mockRejectedValueOnce(new Error("yt-dlp failed"));
    expect((await call("2rBRIhFPaYQ")).model).toBe("gemini-3.8-flash-tiered");
    await call("2rBRIhFPaYQ", "summary");
    expect(captions).toHaveBeenCalledTimes(3);
  });

  it("turns json3 captions into timed paragraphs and runs the engine's captions op in a work dir it removes", async () => {
    const event = (tStartMs: number, dDurationMs: number, words: string[]) => ({ tStartMs, dDurationMs, segs: words.map((utf8) => ({ utf8 })) });
    const json3 = JSON.stringify({ events: [event(80, 1900, ["Καλή", " Τετάρτη"]), { tStartMs: 1990, segs: [{ utf8: "\n" }] }, event(2000, 3000, ["σε ", "όλους."]),
      event(9000, 2000, ["After", " a pause"]), event(11_000, 2000, ["goes", " on"]), event(45_000, 1000, ["later"]), event(3_725_000, 1000, ["an hour in"])] });
    expect(captionsText(json3)).toBe("0:00 Καλή Τετάρτη σε όλους.\n\n0:09 After a pause goes on\n\n0:45 later\n\n62:05 an hour in");
    expect(captionsText(JSON.stringify({ events: [] }))).toBe("");
    const workRoot = join(root, "video-work");
    const engine = vi.fn(async (job: Record<string, unknown>) => { const path = join(String(job.workDir), "captions.el-orig.json3"); await writeFile(path, json3); return { path }; });
    expect(await youtubeCaptions({ workRoot, toolsDir: "/tools", videoId: "2rBRIhFPaYQ", engine: engine as never })).toMatch(/^0:00 Καλή Τετάρτη/);
    expect(engine.mock.calls[0]![0]).toMatchObject({ op: "captions", toolsDir: "/tools", url: "https://www.youtube.com/watch?v=2rBRIhFPaYQ", workDir: expect.stringContaining(join(workRoot, "youtube-text-")) });
    expect(await readdir(workRoot)).toEqual([]);
    expect(await youtubeCaptions({ workRoot, toolsDir: "/tools", videoId: "jNQXAC9IVRw", engine: (async () => ({ path: null })) as never })).toBeNull();
  });

  it("names a missing key and the gateway's own error", async () => {
    const call = (response: Response, file: string | null = keyFile) => youtubeVideoText({ gatewayUrl: "http://gw.test", keyFile: file, model: "gemini-3.5-flash-lite",
      videoId: "jNQXAC9IVRw", kind: "summary", fetchImpl: (async () => response) as typeof fetch });
    await expect(call(json({ text: "x" }), join(root, "missing.key"))).rejects.toMatchObject({ errorCode: "YOUTUBE_SUMMARY_UNAVAILABLE" });
    await expect(call(json({ error: { code: "text_not_generated", message: "The model returned no text (SAFETY)." } }, 422))).rejects.toThrow("Gemini could not read the video: The model returned no text (SAFETY).");
  });
});
