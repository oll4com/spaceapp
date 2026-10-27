import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { CHESS_CLI_WORKSPACE } from "./chess-cli-move.js";

/**
 * Nous, the mind of SpaceApp (operator decision 2026-10-17): one turn of headless Claude Code (Opus 5.5, xhigh) whose
 * only tools are Nous's, served by the API over HTTP MCP with a token for that turn. It runs here, not in the API,
 * because CLI processes must never live in the space-api cgroup; the path is the chess moves' (sudo -> CLI broker ->
 * runtime namespace -> the Claude wrapper as the operator), in the wrapper's agent-tools mode.
 */
export interface NousTurnInput {
  model: string;
  effort: string;
  /** Claude Code account profile (not "main"), passed as SPACE_CLAUDE_ACCOUNT_PROFILE. */
  claudeProfile: string | null;
  system: string;
  prompt: string;
  mcpUrl: string;
  mcpToken: string;
  maxTurns: number;
  timeoutMs: number;
  /** Bash in the turn, without privilege gain (operator order 2026-10-24: the operator's Nous setting "Shell"). */
  shell: boolean;
  /** Claude Code's --fallback-model when the main model is overloaded or unavailable; null unless the operator chose one (off by default). */
  fallbackModel: string | null;
  /** Stream the answer's text as it is written (stream-json with partial messages); the API shows it in the dock as a draft. */
  stream: boolean;
}

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

const BROKER = "/opt/spaceapp/bin/space-cli-vpn-broker";
const PATH_ENV = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
export const NOUS_TURN_MAX_BODY_BYTES = 640 * 1024;
const MAX_PROMPT_CHARS = 400_000;
const MAX_SYSTEM_CHARS = 20_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_TIMEOUT_MS = 20 * 60_000;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,159}$/;
const EFFORT_PATTERN = /^(?:low|medium|high|xhigh|max)$/;
const CLAUDE_PROFILE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MCP_URL_PATTERN = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/api\/cli\/nous\/mcp$/;
const TOKEN_PATTERN = /^[A-Za-z0-9._-]{20,512}$/;

export class NousTurnInputError extends Error {}

export function validateNousTurnInput(raw: unknown): NousTurnInput {
  const input = (raw ?? {}) as Partial<NousTurnInput>;
  const text = (value: unknown, max: number, label: string, allowEmpty = false) => {
    if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > max) throw new NousTurnInputError(`Invalid ${label}.`);
    return value;
  };
  if (typeof input.model !== "string" || !MODEL_PATTERN.test(input.model)) throw new NousTurnInputError("Invalid model.");
  if (typeof input.effort !== "string" || !EFFORT_PATTERN.test(input.effort)) throw new NousTurnInputError("Invalid reasoning effort.");
  const claudeProfile = input.claudeProfile ?? null;
  if (claudeProfile !== null && (typeof claudeProfile !== "string" || !CLAUDE_PROFILE_PATTERN.test(claudeProfile))) throw new NousTurnInputError("Invalid Claude account profile.");
  const fallbackModel = input.fallbackModel ?? null;
  if (fallbackModel !== null && (typeof fallbackModel !== "string" || !MODEL_PATTERN.test(fallbackModel))) throw new NousTurnInputError("Invalid fallback model.");
  if (typeof input.mcpUrl !== "string" || !MCP_URL_PATTERN.test(input.mcpUrl)) throw new NousTurnInputError("Invalid Nous tool endpoint.");
  if (typeof input.mcpToken !== "string" || !TOKEN_PATTERN.test(input.mcpToken)) throw new NousTurnInputError("Invalid Nous tool token.");
  const maxTurns = Math.round(Number(input.maxTurns));
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 99) throw new NousTurnInputError("Invalid turn limit.");
  return {
    model: input.model, effort: input.effort, claudeProfile, maxTurns,
    system: text(input.system, MAX_SYSTEM_CHARS, "system prompt", true),
    prompt: text(input.prompt, MAX_PROMPT_CHARS, "prompt"),
    mcpUrl: input.mcpUrl, mcpToken: input.mcpToken, shell: input.shell === true, fallbackModel, stream: input.stream === true,
    timeoutMs: Math.max(10_000, Math.min(MAX_TIMEOUT_MS, Math.round(Number(input.timeoutMs)) || MAX_TIMEOUT_MS))
  };
}

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

const QUOTA_STOP = /no available tokens\/quota/i;
const RESULT_LINE_HEAD = /"type"\s*:\s*"result"/;
const OVERSIZED_RESULT = "Claude Code's answer exceeded the output limit.";

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

export async function runNousTurn(input: NousTurnInput, signal: AbortSignal, onEvent?: (event: NousTurnEvent) => void): Promise<NousTurnResult> {
  signal.throwIfAborted();
  await mkdir(CHESS_CLI_WORKSPACE, { recursive: true, mode: 0o755 });
  return new Promise<NousTurnResult>((resolve, reject) => {
    const child = spawn("/usr/bin/sudo", ["-n", BROKER, "exec", "cli:claude", "agent-tools"], {
      cwd: CHESS_CLI_WORKSPACE,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: PATH_ENV, LANG: "C.UTF-8", SPACE_CLI_WORKSPACE: CHESS_CLI_WORKSPACE,
        SPACE_AGENT_CHAT_MODEL: input.model, SPACE_AGENT_CHAT_REASONING_EFFORT: input.effort,
        ...(input.claudeProfile && input.claudeProfile !== "main" ? { SPACE_CLAUDE_ACCOUNT_PROFILE: input.claudeProfile } : {})
      }
    });
    // Streamed: the lines pass through as they arrive; only the last JSON line (the result record) and a short tail are kept.
    let stdout = "";
    let lastJsonLine: string | null = null;
    let tail = "";
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, result?: NousTurnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result!);
    };
    const stop = () => { try { child.kill("SIGTERM"); } catch { /* already gone */ } };
    const onAbort = () => { stop(); finish(new Error("The turn was stopped.")); };
    const deadline = setTimeout(() => { stop(); finish(new Error(`No answer within ${Math.round(input.timeoutMs / 60_000)} minutes.`)); }, input.timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const takeLine = (line: string) => {
      if (!line.trim()) return;
      tail = (tail + line).slice(-2_048);
      if (line.trim().startsWith("{")) lastJsonLine = line;
      const event = readNousStreamLine(line);
      if (event && !("result" in event)) onEvent?.(event);
    };
    const lines = splitNousStreamLines(MAX_OUTPUT_BYTES, takeLine);
    child.stdout.on("data", (chunk: string) => {
      if (!input.stream) {
        stdout += chunk;
        if (stdout.length > MAX_OUTPUT_BYTES) { stop(); finish(new Error("Claude Code's answer exceeded the output limit.")); }
        return;
      }
      const error = lines.push(chunk);
      if (error) { stop(); finish(new Error(error)); }
    });
    child.stderr.on("data", (chunk: string) => { if (stderr.length < 8_192) stderr += chunk.slice(0, 8_192 - stderr.length); });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      const ended = input.stream ? lines.end() : null;
      if (ended) { finish(new Error(ended)); return; }
      // Streamed, the result record went through before the wrapper's quota check: its message on stderr must still reach the API.
      if (code !== 0 && QUOTA_STOP.test(stderr)) { finish(new Error(stderr.split("\n").map((value) => value.trim()).find((value) => QUOTA_STOP.test(value))!.slice(0, 300))); return; }
      try {
        finish(null, parseNousTurnOutput(input.stream ? lastJsonLine ?? tail : stdout));
      } catch {
        // sudo's own warnings (its timestamp directory on a read-only /run) say nothing about the turn.
        const line = `${stderr}\n${input.stream ? tail : stdout}`.split("\n").map((value) => value.trim()).find((value) => value && !/^sudo: unable to (?:mkdir|open)/.test(value));
        finish(new Error((line ?? `Claude Code exited with code ${code ?? "unknown"}.`).slice(0, 300)));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ prompt: input.prompt, system: input.system, mcpUrl: input.mcpUrl, mcpToken: input.mcpToken, maxTurns: input.maxTurns, shell: input.shell,
      ...(input.fallbackModel ? { fallbackModel: input.fallbackModel } : {}), ...(input.stream ? { stream: true } : {}) }));
  });
}
