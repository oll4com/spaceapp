import { spawn } from "../safe-child-process.js";
import { mkdir, readFile } from "node:fs/promises";
import { createDecisionsService } from "../decisions-service.js";
import { requestOpenRouterDoctrine } from "../openrouter-benchmark-models.js";
import { generateNativeOpenCodeTitle, resolveNativeOpenCodeRuntime } from "../task-title-opencode.js";
import type { SensorSnapshot } from "./protocol.js";
import { MANEUVERS } from "./protocol.js";

/**
 * Model adapters for the Asteroids Agent Arena. Every model is reached through
 * the path Space already uses for it, so the benchmark measures the model as
 * the operator would run it:
 *  - Space Gateway Codex chat completions (reasoning effort low),
 *  - Claude Code headless agent-chat (effort low) through the CLI broker,
 *  - Antigravity CLI and GitHub Copilot CLI headless agent-chat,
 *  - OpenRouter chat completions, OpenCode native runtime,
 *  - the Jev decisions API (structured choice questions).
 */

/**
 * Codex models come from Space Gateway, like Space's other internal Codex consumers: SPACE_GATEWAY_BASE_URL points
 * at its /v1 and SPACE_GATEWAY_KEY_FILE holds Space's gateway key (SPACE_CODEX_LB_* still work).
 */
export const CODEX_LB_BASE_URL = (process.env.SPACE_GATEWAY_BASE_URL?.trim() || process.env.SPACE_CODEX_LB_BASE_URL?.trim() || "http://127.0.0.1:4920/v1")
  .replace(/\/+$/, "").replace(/\/v1$/, "");
const CODEX_KEY_FILE = process.env.SPACE_GATEWAY_KEY_FILE || process.env.SPACE_CODEX_LB_KEY_FILE || "/opt/spaceapp/secrets/space-gateway-internal.key";
const BROKER = process.env.SPACE_CLI_VPN_BROKER || "/opt/spaceapp/bin/space-cli-vpn-broker";
const WRAPPER_ROOT = "/opt/spaceapp/bin";
/** Empty directory the CLIs start in, so a headless turn never sees a project tree. */
const AGENT_CHAT_WORKSPACE = process.env.SPACE_ASTEROIDS_CLI_WORKSPACE?.trim() || "/opt/spaceapp/var/asteroids-benchmark/workspace";
/** agent-chat refuses prompts above 12000 characters. */
export const AGENT_CHAT_PROMPT_LIMIT = 12_000;

export const JEV_MODEL_ID = "openrouter/typesafe/jev-1.13";
export const BASELINE_MODEL_ID = "baseline/scripted-pilot";

export const CLAUDE_BENCHMARK_MODELS = [
  { id: "claude/claude-opus-5-5", displayName: "Claude Opus 5.5" },
  { id: "claude/claude-sonnet-5-5", displayName: "Claude Sonnet 5.5" },
  { id: "claude/claude-haiku-5-5", displayName: "Claude Haiku 5.5" },
  { id: "claude/claude-fable-5-1", displayName: "Claude Fable 5.1" }
] as const;
const CLAUDE_MODEL_PATTERN = /^claude-(?:opus|sonnet|haiku|fable)-[0-9]+(?:-[0-9]+)?$/;
export const CLAUDE_ACCOUNT_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Run setting: pick the signed-in Claude account with the most quota left at each decision. */
export const CLAUDE_ACCOUNT_AUTO = "auto";

export type ArenaProviderId = "codex" | "claude" | "antigravity" | "openrouter" | "opencode" | "github" | "jev" | "baseline";

/** Requests in flight per provider (the Codex pool queues badly above 4, free tiers rate-limit sooner). */
export const PROVIDER_CONCURRENCY: Record<ArenaProviderId, number> = {
  codex: 4,
  claude: 4,
  antigravity: 2,
  openrouter: 2,
  opencode: 2,
  github: 2,
  jev: 4,
  baseline: 64
};

export function providerForModel(modelId: string): ArenaProviderId {
  if (modelId === BASELINE_MODEL_ID) return "baseline";
  if (modelId === JEV_MODEL_ID) return "jev";
  if (modelId.startsWith("codex/")) return "codex";
  if (modelId.startsWith("claude/")) return "claude";
  if (modelId.startsWith("antigravity/")) return "antigravity";
  if (modelId.startsWith("github/")) return "github";
  if (modelId.startsWith("openrouter/")) return "openrouter";
  return "opencode";
}

/** How the provider is reached, shown on the methodology panel. */
export const PROVIDER_PATHS: Record<ArenaProviderId, string> = {
  codex: "Space Gateway chat completions, reasoning effort low",
  claude: "Claude Code headless (agent-chat), effort low",
  antigravity: "Antigravity CLI headless (agent-chat)",
  openrouter: "OpenRouter chat completions",
  opencode: "OpenCode native runtime",
  github: "GitHub Copilot CLI headless (agent-chat)",
  jev: "Jev decisions API (structured choices)",
  baseline: "Scripted reference policy (no model)"
};

export type ProviderFailureKind = "error" | "quota" | "timeout";

export class ProviderFailure extends Error {
  constructor(readonly kind: ProviderFailureKind, message: string) {
    super(message);
  }
}

const QUOTA_PATTERN = /hit your (?:session|usage|weekly) limit|session limit|usage limit|quota|RESOURCE_EXHAUSTED|rate[ -]?limit|too many requests|\b429\b|credit balance|insufficient/i;

/** Provider notices (quota, login) arrive as plain text; they are not the model's answer. */
export function providerNoticeKind(text: string): ProviderFailureKind | null {
  if (text.includes("{")) return null;
  if (QUOTA_PATTERN.test(text)) return "quota";
  if (/log ?in (?:is )?required|not logged in|authentication|unauthori[sz]ed|login required/i.test(text)) return "error";
  return null;
}

export async function getCodexApiKey(): Promise<string | null> {
  try {
    const key = (await readFile(CODEX_KEY_FILE, "utf8")).trim();
    return key || null;
  } catch {
    return null;
  }
}

/** The gateway answers model listings only with a key. */
export async function codexAuthHeaders(): Promise<Record<string, string>> {
  const key = await getCodexApiKey();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

export interface AgentRequest {
  modelId: string;
  system: string;
  user: string;
  snapshot: SensorSnapshot;
  signal: AbortSignal;
  claudeAccount?: string;
}

export interface AgentReply {
  text: string;
  tokens?: number;
}

export type AgentRequester = (request: AgentRequest) => Promise<AgentReply>;

/** A plain text request (no game snapshot), with the arena's limits unless overridden. */
export type TextRequest = Omit<AgentRequest, "snapshot"> & { maxTokens?: number; reasoningEffort?: "low" | "medium" | "high"; timeoutMs?: number };

class Limiter {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const release = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          this.queue = this.queue.filter((entry) => entry !== release);
          reject(new ProviderFailure("timeout", "Timed out waiting for a provider slot."));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        this.queue.push(release);
      });
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

const limiters = new Map<ArenaProviderId, Limiter>();
function limiter(provider: ArenaProviderId): Limiter {
  let existing = limiters.get(provider);
  if (!existing) {
    existing = new Limiter(PROVIDER_CONCURRENCY[provider]);
    limiters.set(provider, existing);
  }
  return existing;
}

function abortReason(_signal: AbortSignal): ProviderFailure {
  return new ProviderFailure("timeout", "The decision deadline passed.");
}

async function requestCodex(request: TextRequest): Promise<AgentReply> {
  const apiKey = await getCodexApiKey();
  if (!apiKey) throw new ProviderFailure("error", "The Space Gateway key is unavailable.");
  let response: Response;
  try {
    response = await fetch(`${CODEX_LB_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: request.signal,
      body: JSON.stringify({
        model: request.modelId.slice("codex/".length),
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user }
        ],
        reasoning_effort: request.reasoningEffort ?? "low",
        max_tokens: request.maxTokens ?? 900
      })
    });
  } catch (error) {
    if (request.signal.aborted) throw abortReason(request.signal);
    throw new ProviderFailure("error", `Space Gateway unreachable: ${(error as Error).message}`.slice(0, 160));
  }
  if (!response.ok) {
    throw new ProviderFailure(response.status === 429 ? "quota" : "error", `Space Gateway HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }>; usage?: { total_tokens?: unknown } };
  const text = payload.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new ProviderFailure("error", "Space Gateway returned no text.");
  const tokens = Number(payload.usage?.total_tokens);
  return { text, ...(Number.isFinite(tokens) ? { tokens } : {}) };
}

async function requestOpenRouter(request: TextRequest): Promise<AgentReply> {
  const text = await requestOpenRouterDoctrine({
    modelId: request.modelId.slice("openrouter/".length),
    system: request.system,
    prompt: request.user,
    timeoutMs: request.timeoutMs ?? 60_000,
    maxTokens: request.maxTokens ?? 900,
    title: "Space Asteroids Agent Arena",
    signal: request.signal
  });
  if (request.signal.aborted) throw abortReason(request.signal);
  if (typeof text !== "string") throw new ProviderFailure("error", "OpenRouter returned no answer (provider error or rate limit).");
  return { text };
}

async function requestOpenCode(request: TextRequest): Promise<AgentReply> {
  const command = await resolveNativeOpenCodeRuntime();
  if (!command) throw new ProviderFailure("error", "Verified OpenCode runtime not found.");
  const modelId = request.modelId.startsWith("opencode/") ? request.modelId.slice("opencode/".length) : request.modelId;
  try {
    const text = await generateNativeOpenCodeTitle({ command, modelId, system: request.system, prompt: request.user, signal: request.signal });
    return { text };
  } catch (error) {
    if (request.signal.aborted) throw abortReason(request.signal);
    throw new ProviderFailure("error", `OpenCode failed: ${(error as Error).message}`.slice(0, 160));
  }
}

interface AgentChatTarget {
  runtimeId: "cli:claude" | "cli:gemini" | "cli:copilot";
  wrapper: string;
  env: Record<string, string>;
}

function agentChatTarget(request: AgentRequest): AgentChatTarget {
  const provider = providerForModel(request.modelId);
  if (provider === "claude") {
    const model = request.modelId.slice("claude/".length);
    if (!CLAUDE_MODEL_PATTERN.test(model)) throw new ProviderFailure("error", "Unsupported Claude model id.");
    const env: Record<string, string> = { SPACE_AGENT_CHAT_MODEL: model, SPACE_AGENT_CHAT_REASONING_EFFORT: "low" };
    if (request.claudeAccount && request.claudeAccount !== "main" && request.claudeAccount !== CLAUDE_ACCOUNT_AUTO && CLAUDE_ACCOUNT_PATTERN.test(request.claudeAccount)) {
      env.SPACE_CLAUDE_ACCOUNT_PROFILE = request.claudeAccount;
    }
    return { runtimeId: "cli:claude", wrapper: "claude-vscode-parity", env };
  }
  if (provider === "antigravity") {
    const model = request.modelId.slice("antigravity/".length);
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(model)) throw new ProviderFailure("error", "Unsupported Antigravity model id.");
    return { runtimeId: "cli:gemini", wrapper: "gemini-vscode-parity", env: { SPACE_AGENT_CHAT_MODEL: model } };
  }
  const model = request.modelId.slice("github/".length);
  return {
    runtimeId: "cli:copilot",
    wrapper: "copilot-vscode-parity",
    env: model && model !== "auto" && /^[A-Za-z0-9._-]{1,120}$/.test(model) ? { SPACE_AGENT_CHAT_MODEL: model } : {}
  };
}

/**
 * Headless CLI turn. The API goes through the CLI VPN broker exactly like Space
 * chat turns; SPACE_ASTEROIDS_AGENT_CHAT=direct calls the wrapper itself (the
 * headless runner uses it outside the host network namespace).
 */
function requestAgentChat(request: AgentRequest): Promise<AgentReply> {
  const target = agentChatTarget(request);
  const prompt = `${request.system}\n\n${request.user}`;
  if (prompt.length > AGENT_CHAT_PROMPT_LIMIT) {
    return Promise.reject(new ProviderFailure("error", "The prompt exceeds the CLI agent-chat limit."));
  }
  const direct = process.env.SPACE_ASTEROIDS_AGENT_CHAT === "direct";
  const [command, args] = direct
    ? [`${WRAPPER_ROOT}/${target.wrapper}`, ["agent-chat"]]
    : ["/usr/bin/sudo", ["-n", BROKER, "exec", target.runtimeId, "agent-chat"]];
  return mkdir(AGENT_CHAT_WORKSPACE, { recursive: true, mode: 0o755 }).catch(() => undefined).then(() => new Promise<AgentReply>((resolve, reject) => {
    if (request.signal.aborted) {
      reject(abortReason(request.signal));
      return;
    }
    const child = spawn(command, args, {
      cwd: AGENT_CHAT_WORKSPACE,
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", SPACE_CLI_WORKSPACE: AGENT_CHAT_WORKSPACE, ...target.env },
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error: ProviderFailure | null) => {
      if (settled) return;
      settled = true;
      request.signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve({ text: stdout });
    };
    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 3000).unref();
      finish(abortReason(request.signal));
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 64_000) stdout += chunk.slice(0, 64_000 - stdout.length);
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 8_000) stderr += chunk.slice(0, 8_000 - stderr.length);
    });
    child.on("error", (error) => finish(new ProviderFailure("error", `${target.runtimeId} could not start: ${error.message}`.slice(0, 160))));
    child.on("close", (code) => {
      if (code === 0 && stdout.trim()) {
        finish(null);
        return;
      }
      const detail = (stderr.trim() || stdout.trim() || `exit ${code ?? "unknown"}`).replace(/\s+/g, " ").slice(0, 200);
      finish(new ProviderFailure(QUOTA_PATTERN.test(detail) ? "quota" : "error", `${target.runtimeId}: ${detail}`));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(prompt);
  }));
}

/**
 * Jev answers structured choice questions rather than free text. It receives
 * the same snapshot and the same action space; its answers are mapped onto the
 * standard JSON command.
 */
async function requestJev(request: AgentRequest): Promise<AgentReply> {
  const snapshot = request.snapshot;
  const targets: Record<string, string> = {};
  for (const contact of snapshot.contacts.slice(0, 8)) {
    targets[contact.id] = `${contact.type} ${contact.dist}px bearing ${contact.bearing} tca ${contact.tca ?? "none"} miss ${contact.miss}`;
  }
  for (const pickup of snapshot.pickups) targets[pickup.id] = `${pickup.kind} pickup ${pickup.dist}px bearing ${pickup.bearing}`;
  if (Object.keys(targets).length < 2) targets.none = "No specific target";
  const maneuverCriteria: Record<string, string> = {
    attack: "Fly toward the target, aim with lead and shoot it",
    evade: "Steer and thrust away from the target's predicted path",
    orbit: "Circle the target at about 190 px",
    hold: "Stay put, rotate and snipe the target",
    collect: "Fly to the pickup chosen as target",
    brake: "Kill velocity"
  };
  const decisions = createDecisionsService({ timeoutMs: 20_000 });
  const result = await decisions.decide(
    {
      state: { ...snapshot, rules: request.system.slice(0, 1800) },
      questions: {
        maneuver: { type: "choice", instructions: "Choose the maneuver for the next 1.5 s to maximize the round score without taking damage.", criteria: maneuverCriteria },
        target: { type: "choice", instructions: "Choose the target id for the maneuver.", criteria: targets },
        fire: { type: "noul", instructions: "Should the guns fire whenever they line up?" },
        dash: { type: "noul", instructions: "Should the ship spend its dash now?" },
        bomb: { type: "noul", instructions: "Should the ship detonate its bomb now?" }
      }
    },
    { signal: request.signal, timeoutMs: 20_000 }
  );
  if (request.signal.aborted) throw abortReason(request.signal);
  if (!result.available) throw new ProviderFailure("error", result.reason);
  const answers = (result.answers ?? {}) as Record<string, { choice?: unknown; noul?: unknown }>;
  const yes = (key: string) => typeof answers[key]?.noul === "number" && (answers[key]!.noul as number) >= 0.5;
  const maneuver = String(answers.maneuver?.choice ?? "");
  const target = String(answers.target?.choice ?? "");
  return {
    text: JSON.stringify({
      maneuver: (MANEUVERS as readonly string[]).includes(maneuver) ? maneuver : maneuver || "invalid",
      target: target && target !== "none" ? target : null,
      fire: yes("fire"),
      dash: yes("dash"),
      bomb: yes("bomb"),
      note: "Jev decision"
    }),
    ...(typeof result.usage?.outputTokens === "number" && typeof result.usage?.inputTokens === "number"
      ? { tokens: result.usage.inputTokens + result.usage.outputTokens }
      : {})
  };
}

export const requestAgentReply: AgentRequester = (request) => {
  const provider = providerForModel(request.modelId);
  const task = (): Promise<AgentReply> => {
    switch (provider) {
      case "codex":
        return requestCodex(request);
      case "openrouter":
        return requestOpenRouter(request);
      case "opencode":
        return requestOpenCode(request);
      case "claude":
      case "antigravity":
      case "github":
        return requestAgentChat(request);
      case "jev":
        return requestJev(request);
      default:
        return Promise.reject(new ProviderFailure("error", "The scripted baseline is not a model."));
    }
  };
  return limiter(provider).run(task, request.signal);
};

/** Runs a task in the provider's shared slot (the arena and the Research Council share the same limits). */
export function runWithProviderSlot<T>(provider: ArenaProviderId, task: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return limiter(provider).run(task, signal);
}

/** Text from a gateway, OpenRouter or OpenCode model; CLI-backed models (claude/, antigravity/) run in the worker instead. */
export const requestModelText = (request: TextRequest): Promise<AgentReply> => {
  const provider = providerForModel(request.modelId);
  const task = (): Promise<AgentReply> => {
    switch (provider) {
      case "codex":
        return requestCodex(request);
      case "openrouter":
        return requestOpenRouter(request);
      case "opencode":
        return requestOpenCode(request);
      default:
        return Promise.reject(new ProviderFailure("error", `${request.modelId} is not a text model of the gateway, OpenRouter or OpenCode.`));
    }
  };
  return limiter(provider).run(task, request.signal);
};
