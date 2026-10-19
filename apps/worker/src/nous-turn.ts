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
}

export interface NousTurnResult {
  text: string;
  isError: boolean;
  turns: number | null;
}

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
  if (typeof input.mcpUrl !== "string" || !MCP_URL_PATTERN.test(input.mcpUrl)) throw new NousTurnInputError("Invalid Nous tool endpoint.");
  if (typeof input.mcpToken !== "string" || !TOKEN_PATTERN.test(input.mcpToken)) throw new NousTurnInputError("Invalid Nous tool token.");
  const maxTurns = Math.round(Number(input.maxTurns));
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 99) throw new NousTurnInputError("Invalid turn limit.");
  return {
    model: input.model, effort: input.effort, claudeProfile, maxTurns,
    system: text(input.system, MAX_SYSTEM_CHARS, "system prompt", true),
    prompt: text(input.prompt, MAX_PROMPT_CHARS, "prompt"),
    mcpUrl: input.mcpUrl, mcpToken: input.mcpToken,
    timeoutMs: Math.max(10_000, Math.min(MAX_TIMEOUT_MS, Math.round(Number(input.timeoutMs)) || MAX_TIMEOUT_MS))
  };
}

/** Claude Code's `--output-format json` result: the answer, whether it is an error, and how many turns it took. */
export function parseNousTurnOutput(stdout: string): NousTurnResult {
  const line = stdout.trim().split("\n").reverse().find((entry) => entry.trim().startsWith("{"));
  if (!line) throw new Error(stdout.trim().slice(0, 180) || "Claude Code gave no answer.");
  const parsed = JSON.parse(line) as { result?: unknown; is_error?: unknown; num_turns?: unknown; subtype?: unknown };
  const text = typeof parsed.result === "string" ? parsed.result : "";
  const isError = parsed.is_error === true || (typeof parsed.subtype === "string" && parsed.subtype !== "success");
  return { text: text || (isError ? `Claude Code stopped (${String(parsed.subtype ?? "error")}).` : ""), isError, turns: typeof parsed.num_turns === "number" ? parsed.num_turns : null };
}

export async function runNousTurn(input: NousTurnInput, signal: AbortSignal): Promise<NousTurnResult> {
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
    let stdout = "";
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
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_BYTES) { stop(); finish(new Error("Claude Code's answer exceeded the output limit.")); }
    });
    child.stderr.on("data", (chunk: string) => { if (stderr.length < 8_192) stderr += chunk.slice(0, 8_192 - stderr.length); });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      try {
        finish(null, parseNousTurnOutput(stdout));
      } catch {
        // sudo's own warnings (its timestamp directory on a read-only /run) say nothing about the turn.
        const line = `${stderr}\n${stdout}`.split("\n").map((value) => value.trim()).find((value) => value && !/^sudo: unable to (?:mkdir|open)/.test(value));
        finish(new Error((line ?? `Claude Code exited with code ${code ?? "unknown"}.`).slice(0, 300)));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ prompt: input.prompt, system: input.system, mcpUrl: input.mcpUrl, mcpToken: input.mcpToken, maxTurns: input.maxTurns }));
  });
}
