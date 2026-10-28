/**
 * What a headless Claude Code turn of Nous prints, read the same way wherever it runs: stable's worker (`/nous-turn`) and, on a
 * public install, the CLI container's credential agent (plan clipboard:1NF6u6gcCwtj, operator decision 2026-10-27).
 */

/** What a streamed turn reports while it runs: a new assistant message began (the draft starts over), or more of its text. */
export type NousTurnEvent = { start: true } | { text: string };

export interface NousTurnResult {
  text: string;
  isError: boolean;
  turns: number | null;
  /** What Claude Code reported the run cost (total_cost_usd) and used per model (modelUsage); null when absent. */
  costUsd: number | null;
  tokens: Record<string, unknown> | null;
}

const MAX_USAGE_JSON_CHARS = 8_192;
/** The longest answer kept, and the longest stream-json line read. */
export const NOUS_TURN_MAX_OUTPUT_BYTES = 256 * 1024;
/** How the launcher says the account is out of quota; the API pauses Nous on it. */
export const NOUS_QUOTA_STOP = /no available tokens\/quota/i;
const RESULT_LINE_HEAD = /"type"\s*:\s*"result"/;
const OVERSIZED_RESULT = "Claude Code's answer exceeded the output limit.";

/** Claude Code's `--output-format json` result: the answer, whether it is an error, and how many turns it took. */
export function parseNousTurnOutput(stdout: string): NousTurnResult {
  const line = stdout.trim().split("\n").reverse().find((entry) => entry.trim().startsWith("{"));
  if (!line) throw new Error(stdout.trim().slice(0, 180) || "Claude Code gave no answer.");
  const parsed = JSON.parse(line) as { result?: unknown; is_error?: unknown; num_turns?: unknown; subtype?: unknown; total_cost_usd?: unknown; modelUsage?: unknown };
  const text = typeof parsed.result === "string" ? parsed.result : "";
  const isError = parsed.is_error === true || (typeof parsed.subtype === "string" && parsed.subtype !== "success");
  const usage = parsed.modelUsage && typeof parsed.modelUsage === "object" && !Array.isArray(parsed.modelUsage) ? parsed.modelUsage as Record<string, unknown> : null;
  return { text: text || (isError ? `Claude Code stopped (${String(parsed.subtype ?? "error")}).` : ""), isError, turns: typeof parsed.num_turns === "number" ? parsed.num_turns : null,
    costUsd: typeof parsed.total_cost_usd === "number" && Number.isFinite(parsed.total_cost_usd) && parsed.total_cost_usd >= 0 ? parsed.total_cost_usd : null,
    tokens: usage && JSON.stringify(usage).length <= MAX_USAGE_JSON_CHARS ? usage : null };
}

/**
 * One line of Claude Code's stream-json output (--include-partial-messages): the start of an assistant message, a text delta,
 * the final result record, or nothing of interest (thinking and tool-input deltas, tool results, unknown shapes). A shape this
 * reader does not know only costs the dock its draft: the result line is still parsed at the end.
 */
export function readNousStreamLine(line: string): NousTurnEvent | { result: true } | null {
  let parsed: { type?: unknown; event?: { type?: unknown; delta?: { type?: unknown; text?: unknown } } };
  try { parsed = JSON.parse(line) as typeof parsed; } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.type === "result") return { result: true };
  if (parsed.type !== "stream_event" || !parsed.event || typeof parsed.event !== "object") return null;
  if (parsed.event.type === "message_start") return { start: true };
  if (parsed.event.type === "content_block_delta" && parsed.event.delta?.type === "text_delta" && typeof parsed.event.delta.text === "string") return { text: parsed.event.delta.text };
  return null;
}

/**
 * Splits streamed stdout into lines for `takeLine`. A line longer than `maxLineChars` is dropped unread, not buffered: stream-json
 * echoes every tool result whole, and an image a tool returns (an attachment view, a look) is base64 that can pass the limit on its
 * own (2026-10-24: a 249 KB screenshot view failed every turn that opened it). Only an oversized result record is an error, because
 * the answer is in it. `push` and `end` return that error's message, else null.
 */
export function splitNousStreamLines(maxLineChars: number, takeLine: (line: string) => void): { push(chunk: string): string | null; end(): string | null } {
  let pending = "";
  let skippedHead: string | null = null;
  const dropped = (head: string) => (RESULT_LINE_HEAD.test(head) ? OVERSIZED_RESULT : null);
  return {
    push(chunk) {
      let rest = chunk;
      while (rest) {
        const newline = rest.indexOf("\n");
        if (skippedHead !== null) {
          if (newline < 0) return null;
          const head = skippedHead;
          skippedHead = null;
          rest = rest.slice(newline + 1);
          if (dropped(head)) return OVERSIZED_RESULT;
          continue;
        }
        if (newline < 0) {
          pending += rest;
          if (pending.length > maxLineChars) { skippedHead = pending.slice(0, 512); pending = ""; }
          return null;
        }
        const line = pending + rest.slice(0, newline);
        pending = "";
        rest = rest.slice(newline + 1);
        if (line.length > maxLineChars) { if (dropped(line.slice(0, 512))) return OVERSIZED_RESULT; continue; }
        takeLine(line);
      }
      return null;
    },
    end() {
      if (skippedHead !== null) { const head = skippedHead; skippedHead = null; return dropped(head); }
      if (pending) { const line = pending; pending = ""; takeLine(line); }
      return null;
    }
  };
}

/**
 * Reads one turn's stdout as it arrives (`push` returns an error that ends the turn, else null) and gives its result once the
 * process ended (`finish` throws with the reason). Streamed, only the last JSON line (the result record) and a short tail are kept.
 */
export function createNousTurnReader(stream: boolean, onEvent?: (event: NousTurnEvent) => void) {
  let stdout = "";
  let lastJsonLine: string | null = null;
  let tail = "";
  const lines = splitNousStreamLines(NOUS_TURN_MAX_OUTPUT_BYTES, (line) => {
    if (!line.trim()) return;
    tail = (tail + line).slice(-2_048);
    if (line.trim().startsWith("{")) lastJsonLine = line;
    const event = readNousStreamLine(line);
    if (event && !("result" in event)) onEvent?.(event);
  });
  return {
    push(chunk: string): string | null {
      if (stream) return lines.push(chunk);
      stdout += chunk;
      return stdout.length > NOUS_TURN_MAX_OUTPUT_BYTES ? OVERSIZED_RESULT : null;
    },
    finish(code: number | null, stderr: string): NousTurnResult {
      const ended = stream ? lines.end() : null;
      if (ended) throw new Error(ended);
      // Streamed, the result record went through before the launcher's quota check: its message on stderr must still reach the API.
      if (code !== 0 && NOUS_QUOTA_STOP.test(stderr)) throw new Error(stderr.split("\n").map((value) => value.trim()).find((value) => NOUS_QUOTA_STOP.test(value))!.slice(0, 300));
      try {
        return parseNousTurnOutput(stream ? lastJsonLine ?? tail : stdout);
      } catch {
        // sudo's own warnings (its timestamp directory on a read-only /run) say nothing about the turn.
        const line = `${stderr}\n${stream ? tail : stdout}`.split("\n").map((value) => value.trim()).find((value) => value && !/^sudo: unable to (?:mkdir|open)/.test(value));
        throw new Error((line ?? `Claude Code exited with code ${code ?? "unknown"}.`).slice(0, 300));
      }
    }
  };
}
