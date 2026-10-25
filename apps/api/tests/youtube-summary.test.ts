import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { youtubeVideoText } from "../src/youtube-summary.js";

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

  it("names a missing key and the gateway's own error", async () => {
    const call = (response: Response, file: string | null = keyFile) => youtubeVideoText({ gatewayUrl: "http://gw.test", keyFile: file, model: "gemini-3.5-flash-lite",
      videoId: "jNQXAC9IVRw", kind: "summary", fetchImpl: (async () => response) as typeof fetch });
    await expect(call(json({ text: "x" }), join(root, "missing.key"))).rejects.toMatchObject({ errorCode: "YOUTUBE_SUMMARY_UNAVAILABLE" });
    await expect(call(json({ error: { code: "text_not_generated", message: "The model returned no text (SAFETY)." } }, 422))).rejects.toThrow("Gemini could not read the video: The model returned no text (SAFETY).");
  });
});
