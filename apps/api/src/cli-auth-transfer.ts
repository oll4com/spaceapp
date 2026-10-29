import { execFile } from "./safe-child-process.js";
import { createConnection } from "node:net";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { createNousTurnReader, type AgentRuntime, type ImportConfigResult, type NousTurnEvent, type NousTurnResult } from "@space/contracts";
import type { CliAuthCapture } from "@space/runtime";
import { parseCredentialStatus, type CliCredentialCommandExecutor, type CliCredentialStatusReader } from "./cli-runtimes.js";
import type { SpaceApiConfig } from "./config.js";
import { openCodeRunAnswer } from "./room-agent-model-resolver.js";

const execFileAsync = promisify(execFile);
const maxFileBytes = 64 * 1024;

// inspect-env lists a wrapper's operations; select-free-model applies an owner's free OpenCode model pick (1.1.8).
type CredentialAction = "credential-status" | "credential-install" | "credential-smoke" | "credential-observation" | "opencode-text" | "opencode-models" |
  "inspect-env" | "select-free-model" | "check-free-model" | "agent-tools" | "agent-chat";
interface CredentialActionResult { exitCode: number; stdout: string }
// argument: the one checked value of select-free-model (the agent refuses it on every other action).
interface CredentialRequestOptions { timeoutMs?: number; signal?: AbortSignal; argument?: string }
// The public core image has no OpenCode (decision B, 1.1.7): these run the CLI container's `opencode --standalone`.
const openCodeWrapper = "opencode-vscode-parity";
// Nor Claude Code: Nous's turns run the CLI container's, on the owner's own login (operator decision 2026-10-27, B+C3).
export const CLAUDE_CLI_WRAPPER = "claude-vscode-parity";
const NOUS_AGENT_TURN_MS = 21 * 60_000;

/** One Nous turn for the CLI container's Claude Code (deploy/docker/claude-agent.mjs checks it again). */
export interface NousAgentRequest {
  model: string;
  effort: string;
  system: string;
  prompt: string;
  mcpUrl: string;
  mcpToken: string;
  maxTurns: number;
  shell: boolean;
  stream: boolean;
  fallbackModel?: string | null;
}

/** Runs a wrapper's fixed credential action where the CLIs and their logins live. */
export interface CredentialHost {
  run(commandPath: string, action: CredentialAction, input?: string, options?: CredentialRequestOptions): Promise<CredentialActionResult>;
  /** The badge probe: the wrapper's `credential-status`, read in the CLI container. */
  status: CliCredentialStatusReader;
  /** The wrapper's `credential-smoke` or `credential-observation` in the CLI container, shaped like the local executor. */
  execute: CliCredentialCommandExecutor;
  /** `runOpenCodeText` in the CLI container (throwaway home, never the panes' store). */
  openCodeText(modelId: string, prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<string | null>;
  /** OpenCode 2's `/api/model` answer for one provider, read in the CLI container. */
  openCodeModels(provider: string): Promise<string>;
  /** One Nous turn: headless Claude Code with Nous's tools only, its draft streamed to `onEvent` (the wrapper's `agent-tools`). */
  claudeAgentTools(request: NousAgentRequest, signal: AbortSignal, onEvent?: (event: NousTurnEvent) => void): Promise<NousTurnResult>;
  /** One answer with no tool (the pane board; the wrapper's `agent-chat`). */
  claudeAgentChat(input: { model: string; effort: string; prompt: string }, signal?: AbortSignal): Promise<string>;
  close(): Promise<void>;
}

/** One request per connection: a JSON line in, a JSON line out. */
function credentialAgentRequest(socketPath: string, body: Record<string, string>, options: CredentialRequestOptions = {}): Promise<CredentialActionResult> {
  return new Promise((resolve, reject) => {
    let answer = "";
    const socket = createConnection(socketPath, () => socket.end(`${JSON.stringify(body)}\n`));
    const onAbort = () => socket.destroy(new Error("The CLI credential agent request was aborted."));
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    socket.setEncoding("utf8");
    socket.setTimeout(options.timeoutMs ?? 130_000, () => socket.destroy(new Error("The CLI credential agent did not answer.")));
    socket.on("data", (chunk: string) => {
      answer += chunk;
      // A model list or an OpenCode answer is larger than a credential line.
      if (answer.length > 4 * 1024 * 1024) socket.destroy(new Error("The CLI credential agent answer is too large."));
    });
    socket.on("error", reject);
    socket.on("close", () => {
      options.signal?.removeEventListener("abort", onAbort);
      try {
        const result = JSON.parse(answer) as CredentialActionResult;
        if (typeof result.exitCode === "number" && typeof result.stdout === "string") resolve(result);
        else reject(new Error("The CLI credential agent answer is invalid."));
      } catch (error) {
        reject(error);
      }
    });
  });
}

/**
 * A streamed action: the request line goes out and our side stays open (ending it stops the action); the wrapper's stdout comes
 * back as it is written, then RS (\x1e) and the end record {exitCode, stderr}. `onChunk` returns an error that ends the action.
 */
function credentialAgentStream(socketPath: string, body: Record<string, string>, options: { timeoutMs: number; signal: AbortSignal },
  onChunk: (chunk: string) => string | null): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    let trailer: string | null = null;
    let head = "";
    let failure: Error | null = null;
    const socket = createConnection(socketPath, () => socket.write(`${JSON.stringify(body)}\n`));
    const fail = (error: Error) => { failure ??= error; socket.destroy(); };
    const onAbort = () => fail(new Error("The turn was stopped."));
    if (options.signal.aborted) onAbort();
    options.signal.addEventListener("abort", onAbort, { once: true });
    socket.setEncoding("utf8");
    socket.setTimeout(options.timeoutMs, () => fail(new Error("The CLI container gave no answer in time.")));
    socket.on("data", (chunk: string) => {
      if (trailer !== null) { trailer += chunk; return; }
      if (head.length < 512) head += chunk.slice(0, 512 - head.length);
      // The wrapper's stdout is JSON lines: a raw RS starts the end record.
      const end = chunk.indexOf("\x1e");
      const error = onChunk(end < 0 ? chunk : chunk.slice(0, end));
      if (error) fail(new Error(error));
      else if (end >= 0) trailer = chunk.slice(end + 1);
    });
    socket.on("error", (error) => { failure ??= error; });
    socket.on("close", () => {
      options.signal.removeEventListener("abort", onAbort);
      if (failure) { reject(failure); return; }
      try {
        const record = JSON.parse(trailer ?? head) as { exitCode?: unknown; stderr?: unknown; stdout?: unknown };
        if (typeof record.exitCode !== "number") throw new Error("invalid");
        // No end record: the agent refused the request (busy, bad request) before it started.
        if (trailer === null) reject(new Error(`The CLI container could not start the turn (${String(record.stdout ?? "").trim() || `exit ${record.exitCode}`}).`));
        else resolve({ exitCode: record.exitCode, stderr: typeof record.stderr === "string" ? record.stderr : "" });
      } catch {
        reject(new Error("The CLI credential agent answer is invalid."));
      }
    });
  });
}

/**
 * Public installs keep CLI logins only in the CLI container, which this API container cannot see (and the
 * persistent pane host must not serve credential checks). The public CLI container runs a credential agent
 * next to its pane host socket (deploy/docker/credential-agent.mjs in the public repository).
 */
export function createPublicCredentialHost(config: Pick<SpaceApiConfig, "publicDistribution" | "cliEnabled" | "cliHostSocketPath">): CredentialHost | null {
  if (!config.publicDistribution || !config.cliEnabled) return null;
  const socketPath = join(dirname(config.cliHostSocketPath), "credentials.sock");
  const run = (commandPath: string, action: CredentialAction, input?: string, options?: CredentialRequestOptions) =>
    credentialAgentRequest(socketPath, { command: basename(commandPath), action, ...(input === undefined ? {} : { input }),
      ...(options?.argument === undefined ? {} : { argument: options.argument }) }, options);
  return {
    run,
    status: async (commandPath) => {
      const answer = await run(commandPath, "credential-status").catch(() => null);
      return answer?.exitCode === 0 ? parseCredentialStatus(answer.stdout) : null;
    },
    execute: async (commandPath, args, options) => {
      const action = args.length === 1 && (args[0] === "credential-smoke" || args[0] === "credential-observation") ? args[0] : null;
      if (!action) throw new Error("Only credential-smoke and credential-observation run through the CLI credential agent.");
      // The agent's own limit stops the wrapper; ours only has to outlast it.
      const answer = await run(commandPath, action, undefined, { timeoutMs: options.timeout + 10_000 });
      if (answer.exitCode !== 0) throw Object.assign(new Error(`${action} failed in the CLI container.`), { code: answer.exitCode });
      return { stdout: answer.stdout.slice(0, options.maxBuffer) };
    },
    openCodeText: async (modelId, prompt, timeoutMs, signal) => {
      const answer = await run(openCodeWrapper, "opencode-text", JSON.stringify({ modelId, prompt, timeoutMs }), { timeoutMs: timeoutMs + 10_000, signal }).catch(() => null);
      return answer ? openCodeRunAnswer(answer.stdout) : null;
    },
    openCodeModels: async (provider) => {
      const answer = await run(openCodeWrapper, "opencode-models", JSON.stringify({ provider }));
      if (answer.exitCode !== 0) throw new Error("The CLI container could not list OpenCode models.");
      return answer.stdout;
    },
    claudeAgentTools: async (request, signal, onEvent) => {
      const reader = createNousTurnReader(request.stream, onEvent);
      const { fallbackModel, ...rest } = request;
      const input = JSON.stringify({ ...rest, ...(fallbackModel ? { fallbackModel } : {}) });
      const end = await credentialAgentStream(socketPath, { command: CLAUDE_CLI_WRAPPER, action: "agent-tools", input }, { timeoutMs: NOUS_AGENT_TURN_MS + 30_000, signal }, (chunk) => reader.push(chunk));
      return reader.finish(end.exitCode, end.stderr);
    },
    claudeAgentChat: async (input, signal) => {
      const answer = await run(CLAUDE_CLI_WRAPPER, "agent-chat", JSON.stringify(input), { timeoutMs: 620_000, signal });
      if (answer.exitCode !== 0 || !answer.stdout.trim()) throw new Error("Claude Code in the CLI container gave no answer.");
      return answer.stdout.trim();
    },
    close: async () => undefined
  };
}

/**
 * CLIs whose login is a file that another host's same CLI accepts as is; every other CLI needs a fresh
 * sign-in. The names are a second allowlist: the target's wrapper decides where they go. On an operator
 * host (public-host) logins are read through the wrapper's `credential-export` as the CLI user (Codex and Claude
 * Code); on a public install they are written by the wrapper's `credential-install` in the CLI container.
 */
const adapters: Record<string, { files: readonly string[]; operatorExport: boolean; rotatesRefreshToken: boolean }> = {
  "cli:codex": { files: ["auth.json"], operatorExport: true, rotatesRefreshToken: true },
  "cli:claude": { files: [".credentials.json"], operatorExport: true, rotatesRefreshToken: true },
  "cli:gemini": { files: ["oauth_creds.json", "google_accounts.json"], operatorExport: false, rotatesRefreshToken: false },
  "cli:opencode": { files: ["auth.json"], operatorExport: false, rotatesRefreshToken: false }
};

export interface CliLoginStatus {
  runtimeId: string;
  displayName: string;
  exportable: boolean;
  loggedIn: boolean;
  rotatesRefreshToken: boolean;
}

type CliAuthReport = NonNullable<ImportConfigResult["cliAuth"]>;

function decodeLoginFile(name: string, base64: string): Buffer | null {
  const content = Buffer.from(base64, "base64");
  if (!content.length || content.length > maxFileBytes) return null;
  if (name.endsWith(".json")) {
    try { JSON.parse(content.toString("utf8")); } catch { return null; }
  }
  return content;
}

/** The installer's one-line answer: `IMPORTED [backup=<path>]`, `SKIPPED <reason>` or `FAILED <reason>`. */
function installAnswer(runtimeId: string, answer: CredentialActionResult | null): CliAuthReport[number] {
  const match = answer?.stdout.match(/^(IMPORTED|SKIPPED|FAILED)(?: (backup=\S+|[a-z-]+))?\r?\n?$/);
  if (!match) return { runtimeId, result: "failed", reason: "write-failed" };
  if (match[1] === "IMPORTED") return { runtimeId, result: "imported", ...(match[2]?.startsWith("backup=") ? { backup: match[2].slice(7) } : {}) };
  return { runtimeId, result: match[1] === "SKIPPED" ? "skipped" : "failed", reason: match[2] ?? "write-failed" };
}

export function createCliAuthTransfer(options: {
  publicDistribution: boolean;
  readRuntimes(): Promise<AgentRuntime[]>;
  invalidateRuntimes(): void;
  warn(message: string): void;
  credentialHost?: Pick<CredentialHost, "run"> | null;
  /** Operator hosts: runs `<wrapper> credential-export` and returns its stdout. */
  exportThroughWrapper?(commandPath: string): Promise<string>;
}) {
  const exportThroughWrapper = options.exportThroughWrapper ?? (async (commandPath: string) =>
    (await execFileAsync(commandPath, ["credential-export"], { encoding: "utf8", timeout: 15_000, maxBuffer: 2 * maxFileBytes, env: { PATH: "/usr/local/bin:/usr/bin:/bin" } })).stdout);
  // Public installs cannot read logins from this container; they import them through the CLI host.
  const exportable = (runtimeId: string) => !options.publicDistribution && Boolean(adapters[runtimeId]?.operatorExport);

  async function detect(runtimeIds: string[]): Promise<Map<string, "logged-in" | "missing" | "unknown">> {
    options.invalidateRuntimes();
    const runtimes = await options.readRuntimes().catch(() => [] as AgentRuntime[]);
    return new Map(runtimeIds.map((id) => {
      const runtime = runtimes.find((candidate) => candidate.id === id);
      return [id, !runtime ? "unknown" : runtime.authState === "READY" ? "logged-in" : "missing"];
    }));
  }

  return {
    async list(): Promise<CliLoginStatus[]> {
      const runtimes = await options.readRuntimes();
      return runtimes
        .filter((runtime) => runtime.id.startsWith("cli:") && runtime.detectedCommandPath)
        .map((runtime) => ({
          runtimeId: runtime.id,
          displayName: runtime.displayName,
          exportable: exportable(runtime.id),
          loggedIn: runtime.authState === "READY",
          rotatesRefreshToken: adapters[runtime.id]?.rotatesRefreshToken ?? false
        }));
    },

    /** Login files of the chosen CLIs, base64, straight into the caller's encryption; contents are never logged. */
    async capture(runtimeIds: string[]): Promise<{ captured: Record<string, CliAuthCapture>; skipped: Array<{ runtimeId: string; reason: string }> }> {
      const captured: Record<string, CliAuthCapture> = {};
      const skipped: Array<{ runtimeId: string; reason: string }> = [];
      const runtimes = await options.readRuntimes();
      for (const runtimeId of new Set(runtimeIds)) {
        if (!exportable(runtimeId)) {
          skipped.push({ runtimeId, reason: "not-exportable" });
          continue;
        }
        const commandPath = runtimes.find((runtime) => runtime.id === runtimeId)?.detectedCommandPath;
        const base64 = commandPath ? (await exportThroughWrapper(commandPath).catch(() => "")).trim() : "";
        const name = adapters[runtimeId]!.files[0]!;
        if (base64 && decodeLoginFile(name, base64)) {
          captured[runtimeId] = { files: { [name]: base64 }, capturedAt: new Date().toISOString(), sourcePlatform: process.platform };
        } else {
          skipped.push({ runtimeId, reason: "not-logged-in" });
        }
      }
      return { captured, skipped };
    },

    /** Hands each login to the target's wrapper, which writes it as the CLI user, atomically, 0600, with a backup. */
    async apply(
      cliAuth: Record<string, CliAuthCapture>,
      choice: { runtimeIds?: string[]; conflict: "backup-and-replace" | "skip-if-logged-in" }
    ): Promise<CliAuthReport> {
      const report: CliAuthReport = [];
      const runtimes = await options.readRuntimes().catch(() => [] as AgentRuntime[]);
      for (const [runtimeId, capture] of Object.entries(cliAuth)) {
        if (choice.runtimeIds && !choice.runtimeIds.includes(runtimeId)) {
          report.push({ runtimeId, result: "skipped", reason: "not-selected" });
          continue;
        }
        const adapter = adapters[runtimeId];
        if (!adapter) {
          report.push({ runtimeId, result: "skipped", reason: "not-supported-on-target" });
          continue;
        }
        const names = Object.keys(capture?.files ?? {});
        if (!names.length || names.some((name) => !adapter.files.includes(name))) {
          options.warn(`security: rejected CLI login file name for ${runtimeId}`);
          report.push({ runtimeId, result: "failed", reason: "rejected-file-name" });
          continue;
        }
        if (!options.publicDistribution) {
          // Operator hosts run CLIs as another user with owner checks; the API cannot write as that user.
          report.push({ runtimeId, result: "failed", reason: "cannot-write-as-runtime-user" });
          continue;
        }
        if (names.some((name) => !decodeLoginFile(name, capture.files[name]!))) {
          report.push({ runtimeId, result: "failed", reason: "unreadable-login-file" });
          continue;
        }
        const commandPath = runtimes.find((runtime) => runtime.id === runtimeId)?.detectedCommandPath;
        if (!options.credentialHost || !commandPath) {
          report.push({ runtimeId, result: "failed", reason: "cli-home-not-reachable" });
          continue;
        }
        const answer = await options.credentialHost
          .run(commandPath, "credential-install", JSON.stringify({ files: capture.files, conflict: choice.conflict }))
          .catch(() => null);
        report.push(answer ? installAnswer(runtimeId, answer) : { runtimeId, result: "failed", reason: "cli-home-not-reachable" });
      }
      const detected = await detect(report.filter((entry) => entry.result === "imported").map((entry) => entry.runtimeId));
      return report.map((entry) => detected.has(entry.runtimeId) ? { ...entry, detect: detected.get(entry.runtimeId)! } : entry);
    }
  };
}

export type CliAuthTransfer = ReturnType<typeof createCliAuthTransfer>;
