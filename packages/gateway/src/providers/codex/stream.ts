/**
 * Server-sent-event inspection for Responses streams. The gateway forwards bytes unchanged; this only watches
 * event types to learn when output starts (after which a failed request can no longer move to another account)
 * and to read the token usage the terminal event reports. Ported behavior from codex-lb `app/core/clients/proxy.py`
 * (MIT, Soju06/codex-lb).
 */
import { codexLoneWeek } from "./usage.js";

export interface ResponseUsage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
}

export interface StreamOutcome {
  /** "success" for response.completed; otherwise the failure kind. */
  status: "success" | "failed" | "incomplete" | "unterminated";
  model: string | null;
  serviceTier: string | null;
  responseId: string | null;
  usage: ResponseUsage | null;
  errorCode: string | null;
  errorMessage: string | null;
}

const terminalTypes = new Set(["response.completed", "response.failed", "response.incomplete"]);
/** Events that carry content the client acts on; once one is forwarded the request is visible downstream. */
const preOutputTypes = new Set(["response.created", "response.in_progress", "codex.rate_limits", "keepalive", "ping"]);

type JsonObject = Record<string, unknown>;
const obj = (value: unknown): JsonObject | null => (value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null);
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/** Reads usage exactly as reported (cached is a subset of input, reasoning a subset of output); missing stays null. */
export function readResponseUsage(response: JsonObject | null): ResponseUsage | null {
  const usage = obj(response?.usage);
  if (!usage) return null;
  return {
    inputTokens: count(usage.input_tokens),
    cachedInputTokens: count(obj(usage.input_tokens_details)?.cached_tokens),
    outputTokens: count(usage.output_tokens),
    reasoningTokens: count(obj(usage.output_tokens_details)?.reasoning_tokens)
  };
}

export class ResponseStreamInspector {
  private buffer = "";
  private decoder = new TextDecoder();
  outputStarted = false;
  /** The `response` object of the terminal event, for clients that asked for a non-streamed reply. */
  finalResponse: JsonObject | null = null;
  outcome: StreamOutcome = { status: "unterminated", model: null, serviceTier: null, responseId: null, usage: null, errorCode: null, errorMessage: null };

  /** Feeds raw bytes; returns true when this chunk contains the first client-visible output event. */
  push(chunk: Uint8Array): boolean {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let startedNow = false;
    for (;;) {
      const boundary = this.buffer.search(/\r?\n\r?\n/);
      if (boundary < 0) break;
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
      if (this.handleBlock(block) && !this.outputStarted) {
        this.outputStarted = true;
        startedNow = true;
      }
    }
    // A single event can be large (tool output); bound the unparsed tail.
    if (this.buffer.length > 8 * 1024 * 1024) this.buffer = this.buffer.slice(-1024 * 1024);
    return startedNow;
  }

  private handleBlock(block: string): boolean {
    let eventName: string | null = null;
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    const data = dataLines.join("\n");
    let payload: JsonObject | null = null;
    if (data && data !== "[DONE]") {
      try { payload = obj(JSON.parse(data)); } catch { payload = null; }
    }
    return this.handleEvent(str(payload?.type) ?? eventName, payload);
  }

  /** Feeds one already-parsed event (a WebSocket frame); returns true when it is the first client-visible output. */
  pushEvent(payload: JsonObject): boolean {
    if (this.handleEvent(str(payload.type), payload) && !this.outputStarted) {
      this.outputStarted = true;
      return true;
    }
    return false;
  }

  private handleEvent(type: string | null, payload: JsonObject | null): boolean {
    if (!type) return false;
    if (terminalTypes.has(type)) this.recordTerminal(type, payload);
    else if (type === "response.created" || type === "response.in_progress") this.recordResponse(obj(payload?.response));
    else if (type === "error") {
      const error = obj(payload?.error) ?? payload;
      this.outcome.status = "failed";
      this.outcome.errorCode = str(error?.code) ?? str(error?.type) ?? "upstream_error";
      this.outcome.errorMessage = str(error?.message);
      return false;
    }
    // A failure before any output stays invisible to the client, so the request can still move accounts.
    return !preOutputTypes.has(type) && type !== "error" && type !== "response.failed" && type !== "response.incomplete";
  }

  private recordResponse(response: JsonObject | null) {
    if (!response) return;
    this.outcome.model = str(response.model) ?? this.outcome.model;
    this.outcome.serviceTier = str(response.service_tier) ?? this.outcome.serviceTier;
    this.outcome.responseId = str(response.id) ?? this.outcome.responseId;
  }

  private recordTerminal(type: string, payload: JsonObject | null) {
    const response = obj(payload?.response);
    this.finalResponse = response;
    this.recordResponse(response);
    this.outcome.usage = readResponseUsage(response) ?? this.outcome.usage;
    if (type === "response.completed") {
      this.outcome.status = "success";
      return;
    }
    this.outcome.status = type === "response.failed" ? "failed" : "incomplete";
    const error = obj(response?.error);
    this.outcome.errorCode = str(error?.code) ?? str(obj(response?.incomplete_details)?.reason) ?? type.replace("response.", "");
    this.outcome.errorMessage = str(error?.message);
  }
}

/** Whether an event ends the response (a terminal response event or an `error`). */
export const isTerminalEvent = (type: unknown) => typeof type === "string" && (terminalTypes.has(type) || type === "error");

/**
 * Passive usage from a `codex.rate_limits` event (Codex over WebSocket carries no `x-codex-*` headers), after
 * codex-lb `live_snapshots.py`: events for limits other than "codex" are ignored.
 */
export function readCodexRateLimitEvent(payload: JsonObject, nowSeconds: number): { primaryUsedPercent: number | null; secondaryUsedPercent: number | null;
  primaryResetAfterSeconds: number | null; secondaryResetAfterSeconds: number | null; primaryWindowMinutes: number | null; secondaryWindowMinutes: number | null } | null {
  for (const field of ["limit_id", "limit_name", "metered_limit_name"]) {
    const value = payload[field];
    if (typeof value === "string" && value !== "codex") return null;
  }
  const limits = obj(payload.rate_limits);
  if (!limits) return null;
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const window = (raw: unknown) => {
    const entry = obj(raw);
    const resetAt = number(entry?.reset_at) ?? number(entry?.resets_at);
    if (number(entry?.window_minutes) === 0) return { used: null, minutes: null, resetAfter: null };
    return { used: number(entry?.used_percent), minutes: number(entry?.window_minutes), resetAfter: resetAt === null ? null : Math.max(0, resetAt - nowSeconds) };
  };
  const primary = window(limits.primary);
  const secondary = window(limits.secondary);
  return inWeeklySlot({ primaryUsedPercent: primary.used, secondaryUsedPercent: secondary.used, primaryResetAfterSeconds: primary.resetAfter,
    secondaryResetAfterSeconds: secondary.resetAfter, primaryWindowMinutes: primary.minutes, secondaryWindowMinutes: secondary.minutes });
}

type PassiveWindows = { primaryUsedPercent: number | null; secondaryUsedPercent: number | null; primaryResetAfterSeconds: number | null;
  secondaryResetAfterSeconds: number | null; primaryWindowMinutes: number | null; secondaryWindowMinutes: number | null };
/** A weekly-only plan's week, reported as the primary window, moves to the weekly slot (see `codexLoneWeek`). */
function inWeeklySlot(read: PassiveWindows): PassiveWindows {
  if (!codexLoneWeek(read.primaryWindowMinutes, read.secondaryUsedPercent !== null)) return read;
  return { primaryUsedPercent: null, secondaryUsedPercent: read.primaryUsedPercent, primaryResetAfterSeconds: null,
    secondaryResetAfterSeconds: read.primaryResetAfterSeconds, primaryWindowMinutes: null, secondaryWindowMinutes: read.primaryWindowMinutes };
}

/**
 * Passive usage from `x-codex-*` response headers (percent used and reset seconds per window). Codex reports a window the
 * plan lacks (Prolite's 5-hour one, 2026-10-18) as 0 minutes, 0% and reset 0; it is read as absent, as in the WebSocket event.
 */
export function readCodexRateLimitHeaders(headers: Headers): { primaryUsedPercent: number | null; secondaryUsedPercent: number | null;
  primaryResetAfterSeconds: number | null; secondaryResetAfterSeconds: number | null; primaryWindowMinutes: number | null; secondaryWindowMinutes: number | null } {
  const read = (name: string) => {
    const raw = headers.get(name);
    if (raw === null || raw.trim() === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  const windowRead = (window: "primary" | "secondary", name: string) =>
    (read(`x-codex-${window}-window-minutes`) === 0 ? null : read(`x-codex-${window}-${name}`));
  return inWeeklySlot({
    primaryUsedPercent: windowRead("primary", "used-percent"),
    secondaryUsedPercent: windowRead("secondary", "used-percent"),
    primaryResetAfterSeconds: windowRead("primary", "reset-after-seconds"),
    secondaryResetAfterSeconds: windowRead("secondary", "reset-after-seconds"),
    primaryWindowMinutes: windowRead("primary", "window-minutes"),
    secondaryWindowMinutes: windowRead("secondary", "window-minutes")
  });
}
