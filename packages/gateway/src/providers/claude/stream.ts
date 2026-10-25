/**
 * Watches an Anthropic Messages SSE stream (bytes go through unchanged): when content starts, the usage it
 * reports (input, cache read/creation, output) and failures before any content.
 */
export interface ClaudeUsageTokens {
  inputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  /** Part of the cache writes made with the 1-hour TTL. */
  cacheCreation1hInputTokens?: number | null;
  outputTokens: number | null;
  /** "fast" for fast mode. */
  speed?: string | null;
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : null);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null);

export class ClaudeStreamInspector {
  private buffer = "";
  private decoder = new TextDecoder();
  outputStarted = false;
  status: "success" | "failed" | "unterminated" = "unterminated";
  model: string | null = null;
  messageId: string | null = null;
  usage: ClaudeUsageTokens = { inputTokens: null, cacheReadInputTokens: null, cacheCreationInputTokens: null, outputTokens: null };
  errorType: string | null = null;
  errorMessage: string | null = null;

  /** Returns true for the chunk that carries the first content event. */
  push(chunk: Uint8Array): boolean {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let startedNow = false;
    for (;;) {
      const boundary = this.buffer.search(/\r?\n\r?\n/);
      if (boundary < 0) break;
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
      const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
      let event: Json | null = null;
      try { event = obj(JSON.parse(data)); } catch { continue; }
      if (event && this.handle(event) && !this.outputStarted) {
        this.outputStarted = true;
        startedNow = true;
      }
    }
    if (this.buffer.length > 8 * 1024 * 1024) this.buffer = this.buffer.slice(-1024 * 1024);
    return startedNow;
  }

  private handle(event: Json): boolean {
    const type = event.type;
    if (type === "message_start") {
      const message = obj(event.message);
      this.model = typeof message?.model === "string" ? message.model : this.model;
      this.messageId = typeof message?.id === "string" ? message.id : this.messageId;
      this.readUsage(obj(message?.usage));
      return false;
    }
    if (type === "message_delta") {
      this.readUsage(obj(event.usage));
      return false;
    }
    if (type === "message_stop") {
      this.status = this.status === "failed" ? "failed" : "success";
      return false;
    }
    if (type === "error") {
      const error = obj(event.error);
      this.status = "failed";
      this.errorType = typeof error?.type === "string" ? error.type : "api_error";
      this.errorMessage = typeof error?.message === "string" ? error.message : null;
      return false;
    }
    return type === "content_block_start" || type === "content_block_delta";
  }

  private readUsage(usage: Json | null) {
    if (!usage) return;
    this.usage = {
      inputTokens: count(usage.input_tokens) ?? this.usage.inputTokens,
      cacheReadInputTokens: count(usage.cache_read_input_tokens) ?? this.usage.cacheReadInputTokens,
      cacheCreationInputTokens: count(usage.cache_creation_input_tokens) ?? this.usage.cacheCreationInputTokens,
      cacheCreation1hInputTokens: count(obj(usage.cache_creation)?.ephemeral_1h_input_tokens) ?? this.usage.cacheCreation1hInputTokens ?? null,
      outputTokens: count(usage.output_tokens) ?? this.usage.outputTokens,
      speed: typeof usage.speed === "string" ? usage.speed : this.usage.speed ?? null
    };
  }
}

/** Usage of a non-streamed Messages response. */
export function claudeResponseUsage(body: unknown): ClaudeUsageTokens {
  const usage = obj(obj(body)?.usage);
  return {
    inputTokens: count(usage?.input_tokens), cacheReadInputTokens: count(usage?.cache_read_input_tokens),
    cacheCreationInputTokens: count(usage?.cache_creation_input_tokens),
    cacheCreation1hInputTokens: count(obj(usage?.cache_creation)?.ephemeral_1h_input_tokens), outputTokens: count(usage?.output_tokens),
    speed: typeof usage?.speed === "string" ? usage.speed : null
  };
}

/** Passive unified rate-limit headers: utilization (0..1) and reset (Unix seconds) per window. */
export function readClaudeRateLimitHeaders(headers: Headers): {
  fiveHourUsedPercent: number | null; fiveHourResetAt: string | null; weeklyUsedPercent: number | null; weeklyResetAt: string | null; rejected: boolean; resetAt: number | null;
} {
  const number = (name: string) => {
    const raw = headers.get(name);
    if (raw === null || raw.trim() === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  const percent = (value: number | null) => (value === null ? null : Math.max(0, Math.min(100, value * 100)));
  const iso = (value: number | null) => (value === null ? null : new Date(value * 1000).toISOString());
  return {
    fiveHourUsedPercent: percent(number("anthropic-ratelimit-unified-5h-utilization")),
    fiveHourResetAt: iso(number("anthropic-ratelimit-unified-5h-reset")),
    weeklyUsedPercent: percent(number("anthropic-ratelimit-unified-7d-utilization")),
    weeklyResetAt: iso(number("anthropic-ratelimit-unified-7d-reset")),
    rejected: headers.get("anthropic-ratelimit-unified-status") === "rejected",
    resetAt: number("anthropic-ratelimit-unified-reset")
  };
}
