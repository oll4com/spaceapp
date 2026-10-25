import { access, constants } from "node:fs/promises";
import { request } from "node:http";

/**
 * SpaceApp CLI runtimes as chess players. One move is one `agent-chat` turn,
 * run by the worker (apps/worker/src/chess-cli-move.ts, over its Unix socket) on the same isolated
 * path Chat panes use, with the model and reasoning effort passed through
 * SPACE_AGENT_CHAT_MODEL and SPACE_AGENT_CHAT_REASONING_EFFORT. Catalogs come
 * from each wrapper's `models` action (TSV: id, name, efforts, default effort).
 */

export interface ChessCliProviderSpec {
  id: string;
  runtimeId: string;
  name: string;
  /** Effort levels the wrapper's agent-chat really applies; null = provider default only. */
  efforts: "tsv" | readonly string[] | null;
  /** The OpenCode wrapper has no `models` action; its free models come from the runtime itself. */
  catalog: "tsv" | "opencode";
  /** Catalog entries another provider already covers (or that the account cannot use). */
  excludeModelPrefixes?: readonly string[];
  /** Only these entries are the provider's own models; the rest are gateways other providers cover. */
  includeModelPrefixes?: readonly string[];
}

/**
 * Runtimes with an agent-chat one-shot mode. Codex plays through Space Gateway.
 * Muse (no sign-in) and Droid (no subscription) cannot answer yet and have no
 * agent-chat mode.
 */
export const CHESS_CLI_PROVIDERS: readonly ChessCliProviderSpec[] = [
  { id: "claude", runtimeId: "cli:claude", name: "Claude Code", efforts: ["low", "medium", "high", "xhigh", "max"], catalog: "tsv" },
  { id: "gemini", runtimeId: "cli:gemini", name: "Gemini", efforts: "tsv", catalog: "tsv" },
  // Reasonix also lists the OpenRouter, Vercel and Codex-LB gateways; DeepSeek's own models are deepseek-*.
  { id: "deepseek", runtimeId: "cli:deepseek", name: "DeepSeek", efforts: "tsv", catalog: "tsv", includeModelPrefixes: ["deepseek-"] },
  { id: "copilot", runtimeId: "cli:copilot", name: "GitHub Copilot", efforts: "tsv", catalog: "tsv" },
  { id: "grok", runtimeId: "cli:grok", name: "Grok", efforts: null, catalog: "tsv" },
  { id: "cursor", runtimeId: "cli:cursor", name: "Cursor", efforts: null, catalog: "tsv" },
  { id: "qwen", runtimeId: "cli:qwen", name: "Qwen Code", efforts: null, catalog: "tsv" },
  { id: "hermes", runtimeId: "cli:hermes", name: "Hermes", efforts: null, catalog: "tsv" },
  // Oh My Pi also lists the whole OpenRouter catalog; OpenRouter plays as its own provider with verified models.
  { id: "omp", runtimeId: "cli:omp", name: "Oh My Pi", efforts: "tsv", catalog: "tsv", excludeModelPrefixes: ["openrouter/"] },
  { id: "qoder", runtimeId: "cli:qoder", name: "Qoder", efforts: null, catalog: "tsv" },
  { id: "kimi", runtimeId: "cli:kimi", name: "Kimi Code", efforts: null, catalog: "tsv" },
  { id: "autohand", runtimeId: "cli:autohand", name: "Autohand", efforts: null, catalog: "tsv" },
  { id: "opencode", runtimeId: "cli:opencode", name: "OpenCode", efforts: null, catalog: "opencode" },
];

export const CLI_PROVIDER_IDS = new Set(CHESS_CLI_PROVIDERS.map((provider) => provider.id));

export interface ChessCliModel {
  id: string;
  name: string;
  efforts: string[];
}

// Contestant ids are `${provider}/${model}@${effort}`: model ids with "@" or "~" are left out.
const CLI_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,159}$/;
const EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,19}$/;

/** Parses a wrapper `models` TSV; "none" alone means the provider decides. */
export function parseCliModelCatalog(raw: string): ChessCliModel[] {
  const seen = new Set<string>();
  const models: ChessCliModel[] = [];
  for (const line of raw.split("\n")) {
    const columns = line.replace(/\r$/, "").split("\t");
    const id = (columns[0] ?? "").trim();
    if (!id || !CLI_MODEL_ID_PATTERN.test(id) || seen.has(id)) continue;
    seen.add(id);
    const efforts = (columns[2] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => EFFORT_PATTERN.test(value) && value !== "none");
    models.push({ id, name: (columns[1] ?? "").trim() || id, efforts: [...new Set(efforts)] });
  }
  return models;
}

export function cliModelEfforts(spec: ChessCliProviderSpec, model: ChessCliModel): string[] {
  if (spec.efforts === "tsv") return model.efforts.length > 0 ? model.efforts : ["default"];
  if (Array.isArray(spec.efforts)) return [...spec.efforts];
  return ["default"];
}

const OPENCODE_CURRENT = "/opt/spaceapp/var/cli-versions/opencode/current/node_modules/.bin/opencode";
/** The worker's own limit for one move; the tournament's move clock aborts sooner. */
const WORKER_MOVE_TIMEOUT_MS = 180_000;

/** The current OpenCode runtime, used only to list its free models. */
export async function currentOpenCodeBinary(): Promise<string | null> {
  try {
    await access(OPENCODE_CURRENT, constants.X_OK);
    return OPENCODE_CURRENT;
  } catch {
    return null;
  }
}

export interface CliAgentChatInput {
  runtimeId: string;
  model: string | null;
  effort: string | null;
  /** Claude Code account profile (not "main"); the wrapper selects it through SPACE_CLAUDE_ACCOUNT_PROFILE. */
  claudeProfile?: string | null;
  prompt: string;
  signal: AbortSignal;
}

/** Runs one CLI move and returns the answer text. */
export type CliMoveRunner = (input: CliAgentChatInput) => Promise<string>;

/** Where the worker takes chess moves (apps/worker/src/chess-cli-move.ts). */
export const CHESS_MOVE_SOCKET = "/opt/spaceapp/var/chess-benchmark/worker.sock";

/**
 * CLI moves run in the worker: CLI processes must never live in the space-api cgroup. The worker
 * listens on a Unix socket only the space account can open; aborting a move closes the request,
 * which stops the CLI there.
 */
export function createWorkerCliMoveRunner(socketPath = CHESS_MOVE_SOCKET): CliMoveRunner {
  return (input) =>
    new Promise<string>((resolve, reject) => {
      if (input.signal.aborted) {
        reject(new DOMException("The move was aborted.", "AbortError"));
        return;
      }
      const body = JSON.stringify({
        runtimeId: input.runtimeId,
        model: input.model,
        effort: input.effort,
        claudeProfile: input.claudeProfile ?? null,
        prompt: input.prompt,
        timeoutMs: WORKER_MOVE_TIMEOUT_MS,
      });
      let settled = false;
      const finish = (error: Error | null, text?: string) => {
        if (settled) return;
        settled = true;
        input.signal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(text ?? "");
      };
      const call = request(
        { socketPath, path: "/move", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
        (response) => {
          let data = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            data += chunk;
          });
          response.on("end", () => {
            let payload: { text?: unknown; error?: unknown } = {};
            try {
              payload = JSON.parse(data) as typeof payload;
            } catch {}
            if (response.statusCode === 200 && typeof payload.text === "string") finish(null, payload.text);
            else finish(new Error(typeof payload.error === "string" ? payload.error : `Worker answered HTTP ${response.statusCode ?? 0}.`));
          });
        }
      );
      const onAbort = () => {
        call.destroy();
        finish(new DOMException("The move was aborted.", "AbortError"));
      };
      input.signal.addEventListener("abort", onAbort, { once: true });
      call.on("error", (error) => finish(input.signal.aborted ? new DOMException("The move was aborted.", "AbortError") : new Error(`Space worker unavailable: ${error.message}`)));
      call.end(body);
    });
}
