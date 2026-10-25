import { spawn } from "node:child_process";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";

/**
 * Chess benchmark moves from SpaceApp CLI runtimes: the same isolated agent-chat turn Chat panes
 * run (sudo -> space-cli-vpn-broker -> runtime namespace -> the wrapper as the operator).
 *
 * They run here, in the worker, because CLI processes must never live in the space-api cgroup
 * (scripts/space-live-guard.mjs). The API asks over a Unix socket only the `space` account can
 * open; closing the request stops the move. One Temporal workflow per move was tried first and
 * exhausted the workflow thread's memory, so moves stay outside Temporal.
 */

export interface ChessCliMoveInput {
  runtimeId: string;
  model: string | null;
  effort: string | null;
  /** Claude Code account profile (not "main"), passed as SPACE_CLAUDE_ACCOUNT_PROFILE. */
  claudeProfile: string | null;
  prompt: string;
  timeoutMs: number;
}

export const CHESS_MOVE_SOCKET = "/opt/spaceapp/var/chess-benchmark/worker.sock";
/** Empty directory the CLIs start in; the operator account can read it but not write to it. */
export const CHESS_CLI_WORKSPACE = "/opt/spaceapp/var/chess-benchmark/workspace";
const BROKER = "/opt/spaceapp/bin/space-cli-vpn-broker";
const PATH_ENV = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 32 * 1024;
const MAX_PROMPT_CHARS = 12_000;
const MAX_TIMEOUT_MS = 180_000;
const RUNTIME_PATTERN = /^cli:[a-z][a-z0-9-]{1,30}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,159}$/;
const EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,19}$/;
const CLAUDE_PROFILE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PROVIDER_FAILURE = /RESOURCE_EXHAUSTED|quota|rate.?limit|\b429\b|unauthori[sz]ed|authentication fail|invalid api key|no available tokens|insufficient balance/i;

export class ChessMoveInputError extends Error {}

function stripTerminalCodes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

/** First printable line of a CLI failure, short enough for a status note. */
export function cliFailureSummary(output: string, fallback: string): string {
  const line = stripTerminalCodes(output)
    .split("\n")
    .map((value) => value.replace(/[^\x20-\x7E]/g, " ").trim())
    .find((value) => value.length > 0);
  return (line ?? fallback).slice(0, 180);
}

export function validateChessCliMoveInput(raw: unknown): ChessCliMoveInput {
  const input = (raw ?? {}) as Partial<ChessCliMoveInput>;
  const optional = (value: unknown) => (value === undefined || value === null ? null : value);
  const model = optional(input.model);
  const effort = optional(input.effort);
  const claudeProfile = optional(input.claudeProfile);
  if (typeof input.runtimeId !== "string" || !RUNTIME_PATTERN.test(input.runtimeId)) throw new ChessMoveInputError("Invalid CLI runtime.");
  if (model !== null && (typeof model !== "string" || !MODEL_PATTERN.test(model))) throw new ChessMoveInputError("Invalid CLI model.");
  if (effort !== null && (typeof effort !== "string" || !EFFORT_PATTERN.test(effort))) throw new ChessMoveInputError("Invalid reasoning effort.");
  if (claudeProfile !== null && (typeof claudeProfile !== "string" || !CLAUDE_PROFILE_PATTERN.test(claudeProfile))) {
    throw new ChessMoveInputError("Invalid Claude account profile.");
  }
  if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > MAX_PROMPT_CHARS) {
    throw new ChessMoveInputError("Invalid chess prompt.");
  }
  const timeoutMs = Math.max(1_000, Math.min(MAX_TIMEOUT_MS, Math.round(Number(input.timeoutMs)) || MAX_TIMEOUT_MS));
  return { runtimeId: input.runtimeId, model, effort, claudeProfile, prompt: input.prompt, timeoutMs };
}

export function chessCliMoveEnvironment(input: ChessCliMoveInput): NodeJS.ProcessEnv {
  return {
    PATH: PATH_ENV,
    LANG: "C.UTF-8",
    SPACE_CLI_WORKSPACE: CHESS_CLI_WORKSPACE,
    ...(input.model ? { SPACE_AGENT_CHAT_MODEL: input.model } : {}),
    ...(input.effort ? { SPACE_AGENT_CHAT_REASONING_EFFORT: input.effort } : {}),
    ...(input.runtimeId === "cli:claude" && input.claudeProfile && input.claudeProfile !== "main"
      ? { SPACE_CLAUDE_ACCOUNT_PROFILE: input.claudeProfile }
      : {}),
  };
}

/** Runs one move and returns the CLI's answer; aborting stops the CLI. */
export async function runChessCliMove(input: ChessCliMoveInput, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  await mkdir(CHESS_CLI_WORKSPACE, { recursive: true, mode: 0o755 });
  return new Promise<string>((resolve, reject) => {
    const child = spawn("/usr/bin/sudo", ["-n", BROKER, "exec", input.runtimeId, "agent-chat"], {
      cwd: CHESS_CLI_WORKSPACE,
      stdio: ["pipe", "pipe", "pipe"],
      env: chessCliMoveEnvironment(input),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(stripTerminalCodes(stdout));
    };
    const stop = () => {
      try {
        child.kill("SIGTERM");
      } catch {}
    };
    const onAbort = () => {
      stop();
      finish(new Error("The move was cancelled."));
    };
    const deadline = setTimeout(() => {
      stop();
      finish(new Error(`No answer within ${Math.round(input.timeoutMs / 1000)} s.`));
    }, input.timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_BYTES) {
        stop();
        finish(new Error("CLI answer exceeded the output limit."));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 8_192) stderr += chunk.slice(0, 8_192 - stderr.length);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      // Some CLIs print the answer and then exit non-zero for terminal reasons; the answer still
      // counts, unless what they printed is a provider failure (quota, rate limit, sign-in).
      const printedFailure = stdout.trim() !== "" && PROVIDER_FAILURE.test(stdout);
      if (code === 0 || (stdout.trim() && !printedFailure)) finish(null);
      else finish(new Error(cliFailureSummary(printedFailure ? stdout : stderr, `${input.runtimeId} exited with code ${code ?? "unknown"}.`)));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input.prompt);
  });
}

type MoveRunner = (input: ChessCliMoveInput, signal: AbortSignal) => Promise<string>;

/** Another request on the same socket (Nous's turns): its own body limit; input errors answer 400, others 502. */
export interface WorkerSocketRoute {
  maxBodyBytes: number;
  isInputError(error: unknown): boolean;
  handle(body: unknown, signal: AbortSignal): Promise<unknown>;
}

/** POST /move {runtimeId, model, effort, claudeProfile, prompt, timeoutMs} -> 200 {text} | 400/502 {error}; plus `routes`. */
export async function startChessMoveServer(socketPath = CHESS_MOVE_SOCKET, run: MoveRunner = runChessCliMove,
  routes: Record<string, WorkerSocketRoute> = {}): Promise<Server> {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o755 });
  await rm(socketPath, { force: true });
  const server = createServer((request, response) => {
    const reply = (status: number, payload: unknown) => {
      if (response.writableEnded || response.destroyed) return;
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
    };
    const route = request.method === "POST" && request.url ? routes[request.url] : undefined;
    if (request.method !== "POST" || (request.url !== "/move" && !route)) {
      reply(404, { error: "Not found." });
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > (route?.maxBodyBytes ?? MAX_BODY_BYTES)) {
        reply(413, { error: "Request too large." });
        request.destroy();
      }
    });
    request.on("end", () => {
      if (route) {
        const controller = new AbortController();
        response.on("close", () => { if (!response.writableFinished) controller.abort(); });
        Promise.resolve().then(() => route.handle(JSON.parse(body), controller.signal)).then(
          (result) => reply(200, result),
          (error: unknown) => reply(route.isInputError(error) || error instanceof SyntaxError ? 400 : 502,
            { error: error instanceof Error ? error.message.slice(0, 300) : "The request failed." })
        );
        return;
      }
      let input: ChessCliMoveInput;
      try {
        input = validateChessCliMoveInput(JSON.parse(body));
      } catch (error) {
        reply(400, { error: error instanceof ChessMoveInputError ? error.message : "Invalid move request." });
        return;
      }
      // The API closes the request when the move clock runs out or the tournament stops.
      const controller = new AbortController();
      response.on("close", () => {
        if (!response.writableFinished) controller.abort();
      });
      run(input, controller.signal).then(
        (text) => reply(200, { text }),
        (error: unknown) => reply(502, { error: error instanceof Error ? error.message.slice(0, 180) : "The move failed." })
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  // Only the space account (API and worker) may ask for moves.
  await chmod(socketPath, 0o600);
  return server;
}
