/**
 * Watches a Code Assist `streamGenerateContent?alt=sse` stream, or a `generateContent` JSON body (bytes pass through
 * unchanged): when content starts, the usage it reports and an error reported inside the stream before any content.
 */
export interface GeminiUsage {
  promptTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  thoughtsTokens: number | null;
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : null);
/** An image body (base64) can be large; past this its usage is not read. */
const MAX_JSON_CHARS = 96 * 1024 * 1024;
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null);

export function readGeminiUsage(response: Json | null): GeminiUsage | null {
  const usage = obj(response?.usageMetadata);
  if (!usage) return null;
  return { promptTokens: count(usage.promptTokenCount), cachedTokens: count(usage.cachedContentTokenCount),
    outputTokens: count(usage.candidatesTokenCount), thoughtsTokens: count(usage.thoughtsTokenCount) };
}

export class CodeAssistStreamInspector {
  private buffer = "";
  private decoder = new TextDecoder();
  outputStarted = false;
  model: string | null = null;
  usage: GeminiUsage | null = null;
  finished = false;
  errorStatus: number | null = null;
  errorMessage: string | null = null;
  /** Null until the first bytes show whether the body is SSE or one JSON document. */
  private json: boolean | null = null;
  private skipped = false;

  /** Returns true for the chunk that carries the first content. */
  push(chunk: Uint8Array): boolean {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    // A non-stream call (`generateContent`, e.g. an image) answers one JSON body: it is read whole by end().
    if (this.json === null && this.buffer.trimStart()) this.json = /^[[{]/.test(this.buffer.trimStart());
    if (this.json) {
      if (this.buffer.length > MAX_JSON_CHARS) { this.buffer = ""; this.json = false; this.skipped = true; }
      return false;
    }
    if (this.skipped) return false;
    let startedNow = false;
    for (;;) {
      const boundary = this.buffer.search(/\r?\n\r?\n/);
      if (boundary < 0) break;
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
      const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
      let event: Json | null = null;
      try { event = obj(JSON.parse(data)); } catch { continue; }
      if (event && this.read(event)) startedNow = true;
    }
    if (this.buffer.length > 8 * 1024 * 1024) this.buffer = this.buffer.slice(-1024 * 1024);
    return startedNow;
  }

  /** The end of the body: a non-stream JSON body is read here. */
  end(): void {
    if (!this.json) return;
    this.json = false;
    try {
      // `generateContent` answers one object; `streamGenerateContent` without `alt=sse` an array of them.
      const parsed: unknown = JSON.parse(this.buffer);
      for (const event of (Array.isArray(parsed) ? parsed : [parsed]).map(obj)) if (event) this.read(event);
    } catch { /* not JSON after all */ }
    this.buffer = "";
  }

  /** One response (an SSE event or the whole JSON body); returns true when it carries the first content. */
  private read(event: Json): boolean {
    const error = obj(event.error);
    if (error) {
      this.errorStatus = count(error.code) ?? 500;
      this.errorMessage = typeof error.message === "string" ? error.message : null;
      return false;
    }
    const response = obj(event.response) ?? event;
    if (typeof response.modelVersion === "string") this.model = response.modelVersion;
    this.usage = readGeminiUsage(response) ?? this.usage;
    const candidates = Array.isArray(response.candidates) ? response.candidates.map(obj) : [];
    if (candidates.some((candidate) => typeof candidate?.finishReason === "string")) this.finished = true;
    const hasContent = candidates.some((candidate) => Array.isArray(obj(candidate?.content)?.parts) && (obj(candidate?.content)!.parts as unknown[]).length > 0);
    if (!hasContent || this.outputStarted) return false;
    this.outputStarted = true;
    return true;
  }
}

/** "Individual quota reached ... Resets in 4h3m17s." -> seconds until the quota resets. */
export function parseResetsIn(message: string | null | undefined): number | null {
  const match = /resets? in ((?:\d+\s*[hms]\s*)+)/i.exec(message ?? "");
  if (!match) return null;
  let seconds = 0;
  for (const part of match[1]!.matchAll(/(\d+)\s*([hms])/gi)) {
    seconds += Number(part[1]) * (part[2]!.toLowerCase() === "h" ? 3600 : part[2]!.toLowerCase() === "m" ? 60 : 1);
  }
  return seconds > 0 ? seconds : null;
}
