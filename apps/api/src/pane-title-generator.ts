import { basename } from "node:path";
import type { Model, Pane, PaneCliTranscriptChunk, Provider, ProviderSettings } from "@space/contracts";
import type { SpaceApiConfig } from "./config.js";
import { fetchOpenCodeSessionTitle, openCodeServerBaseUrl, type OpenCodeServerControl } from "@space/opencode-control";

type FetchLike = typeof fetch;
type ReadFileLike = (path: string) => Promise<string>;

export const openCodeTitleProviderId = "opencode";
export const openCodeTitleModelId = "deepseek-v4-flash-free";

export interface TerminalPaneTitleGenerationSelection {
  provider: Provider;
  model: Model;
  reasoningEffort: ProviderSettings["titleGenerationReasoningEffort"];
}

export interface GenerateTerminalPaneTitleInput {
  config: Pick<SpaceApiConfig, "codexLbBaseUrl" | "codexLbKeyFile" | "codexLbKeyName">;
  provider: Provider;
  model: Model;
  currentTitle: string;
  cwd: string | null;
  primaryTaskRequest?: string | null;
  trustPrimaryTaskRequest?: boolean;
  reasoningEffort: Pane["reasoningEffort"];
  transcript: Array<Pick<PaneCliTranscriptChunk, "stream" | "content">>;
}

export interface GenerateOpenCodePaneTitleInput {
  control: OpenCodeServerControl;
  currentTitle: string;
  cwd: string | null;
  primaryTaskRequest?: string | null;
  transcript: Array<Pick<PaneCliTranscriptChunk, "stream" | "content">>;
  modelId?: string;
  providerId?: string;
  /**
   * When true, the native session referenced by the control is NOT used for
   * context (first user message / native title fallback). Use for controls
   * that belong to a different pane or to the shared server fallback.
   */
  skipNativeContext?: boolean;
  /** Timeout for the title prompt request; defaults to 120 seconds. */
  promptTimeoutMs?: number;
}

export interface GenerateTerminalPaneTitleResult {
  title: string;
  providerId: string;
  modelId: string;
}

export interface TerminalPaneTitleGenerationOptions {
  fetchImpl?: FetchLike;
  readFileImpl?: ReadFileLike;
}

function boundedText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function titleModelTokens(model: Model): string {
  return `${model.runtimeId ?? ""} ${model.displayName} ${model.id}`.toLowerCase();
}

function titleModelScore(model: Model): number {
  const tokens = titleModelTokens(model);
  let score = 0;
  if (/\b(nano|mini|haiku|flash|small|lite|fast)\b/.test(tokens)) score += 50;
  if (model.supportsReasoning) score += 10;
  if (typeof model.contextWindow === "number") {
    score += Math.max(0, 200_000 - Math.min(model.contextWindow, 200_000)) / 20_000;
  }
  return score;
}

function backedByCodexLb(provider: Provider): boolean {
  return provider.type === "CODEX_LB" || provider.backingProviderId === "codex-lb";
}

export function selectTerminalPaneTitleGeneration(
  providers: Provider[],
  models: Model[],
  settings: ProviderSettings
): TerminalPaneTitleGenerationSelection {
  const verifiedProviders = providers.filter((provider) => provider.status === "VERIFIED" && backedByCodexLb(provider));
  const providerById = new Map(verifiedProviders.map((provider) => [provider.id, provider]));
  const verifiedModels = models.filter((model) => model.status === "VERIFIED");
  const configuredModel = settings.titleGenerationModelId
    ? verifiedModels.find((model) => model.id === settings.titleGenerationModelId) ?? null
    : null;
  const selectedProvider =
    (configuredModel ? providerById.get(configuredModel.providerId) : null) ??
    providerById.get(settings.defaultProviderId) ??
    verifiedProviders[0] ??
    null;

  if (!selectedProvider) {
    throw new Error("No verified Codex-LB provider is available for CLI title generation.");
  }

  const selectedModel =
    configuredModel && configuredModel.providerId === selectedProvider.id
      ? configuredModel
      : [...verifiedModels]
          .filter((model) => model.providerId === selectedProvider.id)
          .sort((left, right) => titleModelScore(right) - titleModelScore(left) || left.displayName.localeCompare(right.displayName))[0] ?? null;

  if (!selectedModel) {
    throw new Error(`No verified model is available for provider ${selectedProvider.displayName}.`);
  }

  return {
    provider: selectedProvider,
    model: selectedModel,
    reasoningEffort: settings.titleGenerationReasoningEffort ?? selectedModel.defaultReasoningEffort ?? "low"
  };
}

function extractResponseText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as { output_text?: unknown; output?: unknown; choices?: unknown };
  if (typeof record.output_text === "string") return record.output_text;
  if (Array.isArray(record.output)) {
    for (const item of record.output) {
      if (!item || typeof item !== "object") continue;
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const text = (part as { text?: unknown; type?: unknown }).text;
        if (typeof text === "string") return text;
      }
    }
  }
  if (Array.isArray(record.choices)) {
    const choice = record.choices[0];
    if (!choice || typeof choice !== "object") return "";
    const message = (choice as { message?: unknown }).message;
    if (!message || typeof message !== "object") return "";
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (!part || typeof part !== "object") return "";
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        })
        .filter(Boolean)
        .join(" ");
    }
  }
  return "";
}

function normalizeBaseUrl(baseUrl: string): URL {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("CLI title generation base URL must use http or https.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("CLI title generation base URL must not include credentials.");
  }
  return new URL(parsed.href.endsWith("/") ? parsed.href : `${parsed.href}/`);
}

const shellCommandPrefixes = new Set([
  "cat",
  "cd",
  "chmod",
  "chown",
  "clear",
  "cp",
  "curl",
  "docker",
  "echo",
  "exit",
  "find",
  "git",
  "grep",
  "head",
  "kill",
  "less",
  "ln",
  "ls",
  "make",
  "mkdir",
  "more",
  "move",
  "mv",
  "node",
  "npm",
  "npx",
  "patch",
  "pnpm",
  "ps",
  "pwd",
  "python",
  "python3",
  "pytest",
  "rg",
  "rm",
  "rsync",
  "sed",
  "sh",
  "ssh",
  "sudo",
  "systemctl",
  "tail",
  "touch",
  "vim",
  "yarn"
]);

function transcriptSegments(value: string): string[] {
  const collapsed = boundedText(value, 1200);
  if (!collapsed) return [];
  const parts = collapsed
    .split(/\s+(?:->|--+)\s+|(?:\r?\n){2,}/u)
    .map((item) => boundedText(item, 400))
    .filter(Boolean);
  return parts.length ? parts : [collapsed];
}

function looksLikeShellCommand(value: string): boolean {
  const trimmed = boundedText(value, 200);
  if (!trimmed) return true;
  if (/^[/$]/u.test(trimmed)) return true;
  const firstToken = trimmed.split(/\s+/u)[0]?.toLowerCase() ?? "";
  if (!firstToken) return true;
  if (shellCommandPrefixes.has(firstToken)) return true;
  if (/^[A-Z_][A-Z0-9_]*=/.test(firstToken)) return true;
  if (/^[./~]/u.test(firstToken)) return true;
  return false;
}

function looksLikeMeaningfulTaskRequest(value: string): boolean {
  const trimmed = boundedText(value, 400);
  if (!trimmed) return false;
  if (trimmed.length < 24) return false;
  if (looksLikeShellCommand(trimmed)) return false;
  if (trimmed.split(/\s+/u).length < 4) return false;
  return true;
}

function extractTaskRequestCandidate(value: string): string {
  const text = boundedText(value, 1200);
  if (!text) return "";
  const promptMatch = /(?:^|\s)user prompt:\s*(.+)$/iu.exec(text);
  return boundedText(promptMatch?.[1] ?? text, 1200);
}

function selectMeaningfulTaskRequest(value: string): string {
  const candidate = extractTaskRequestCandidate(value);
  if (!candidate) return "";
  const segments = transcriptSegments(candidate);
  for (const segment of segments) {
    if (looksLikeMeaningfulTaskRequest(segment)) {
      return boundedText(segment, 500);
    }
  }
  const fallback = boundedText(candidate, 500);
  if (fallback && !looksLikeShellCommand(fallback) && fallback.split(/\s+/u).length >= 3) {
    return fallback;
  }
  return "";
}

function findPrimaryTaskRequest(
  transcript: Array<Pick<PaneCliTranscriptChunk, "stream" | "content">>,
  preferredRequest?: string | null,
  trustPreferredRequest = false
): string {
  if (trustPreferredRequest) {
    const trustedPreferred = boundedText(preferredRequest ?? "", 500);
    if (trustedPreferred) return trustedPreferred;
  }
  const preferred = selectMeaningfulTaskRequest(preferredRequest ?? "");
  if (preferred) return preferred;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const chunk = transcript[index];
    if (!chunk || chunk.stream !== "stdin") continue;
    const selected = selectMeaningfulTaskRequest(chunk.content);
    if (selected) return selected;
  }
  return "";
}

function buildRecentCliActivity(transcript: Array<Pick<PaneCliTranscriptChunk, "stream" | "content">>, maxLength = 1800): string {
  const lines = transcript
    .filter((chunk) => chunk.stream !== "stdin")
    .map((chunk) => {
      const content = boundedText(chunk.content, 320);
      return content ? `${chunk.stream.toUpperCase()}: ${content}` : "";
    })
    .filter(Boolean);
  const joined = lines.join("\n");
  return joined.length <= maxLength ? joined : joined.slice(joined.length - maxLength);
}

/**
 * Derives a pane-title candidate for CLI runtimes that have no dedicated
 * native title poller (everything except cli:opencode and cli:codex).
 * Prefers the captured first user message of the task revision; falls back to
 * the meaningful stdin request found in the recent pane transcript. Returns
 * "" when nothing meaningful exists (e.g. raw terminal escape sequences).
 */
export function extractGenericPaneTitleCandidate(
  firstUserMessage: string | null | undefined,
  transcript: Array<Pick<PaneCliTranscriptChunk, "stream" | "content">> = []
): string {
  const fromFirstUserMessage = selectMeaningfulTaskRequest(firstUserMessage ?? "");
  if (fromFirstUserMessage) return boundedText(fromFirstUserMessage, 120);
  const fromTranscript = findPrimaryTaskRequest(transcript);
  return boundedText(fromTranscript, 120);
}

interface PaneTitleMessageSource {
  currentTitle: string;
  cwd: string | null;
  primaryTaskRequest?: string | null;
  trustPrimaryTaskRequest?: boolean;
  transcript: Array<Pick<PaneCliTranscriptChunk, "stream" | "content">>;
}

function buildMessages(input: PaneTitleMessageSource, options?: { allowEmpty?: boolean }) {
  const primaryTaskRequest = findPrimaryTaskRequest(
    input.transcript,
    input.primaryTaskRequest,
    input.trustPrimaryTaskRequest === true
  );
  const recentActivity = buildRecentCliActivity(input.transcript);
  if (!primaryTaskRequest && !recentActivity && options?.allowEmpty !== true) {
    throw new Error("No recent CLI transcript is available for title generation.");
  }
  return [
    {
      role: "system" as const,
      content:
        "Create a concise Space CLI pane title. Prefer the primary task request over recent progress output. Use recent CLI activity only to refine the task if it clearly changed. Ignore routine cleanup, status, verification, and completion noise. Return title text only. Use 2 to 6 words, no quotes, no markdown, no prefixes, no trailing period."
    },
    {
      role: "user" as const,
      content: [
        `Current title: ${boundedText(input.currentTitle, 120) || "CLI"}`,
        `Working directory: ${boundedText(input.cwd ?? "", 240) || "unknown"}`,
        primaryTaskRequest ? `Primary task request:\n${primaryTaskRequest}` : "Primary task request: unavailable",
        recentActivity ? `Recent CLI activity:\n${recentActivity}` : "Recent CLI activity: unavailable"
      ].join("\n")
    }
  ];
}

export function sanitizeGeneratedPaneTitle(value: string, fallback = "CLI"): string {
  const firstLine = boundedText(value.split(/\r?\n/u).find((line) => line.trim()) ?? "", 160);
  const stripped = firstLine
    .replace(/^(title|suggested title)\s*[:\-]\s*/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.!?;:,]+$/g, "")
    .trim();
  return boundedText(stripped || fallback, 120) || fallback;
}

async function requestResponses(
  endpoint: URL,
  credential: string,
  input: GenerateTerminalPaneTitleInput,
  fetchImpl: FetchLike
): Promise<string> {
  const response = await fetchImpl(new URL("responses", endpoint), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: input.model.runtimeId ?? input.model.id,
      input: buildMessages(input).map((message) => ({
        role: message.role,
        content: [{ type: "input_text", text: message.content }]
      })),
      reasoning: input.reasoningEffort === "none" ? undefined : { effort: input.reasoningEffort },
      max_output_tokens: 32
    })
  });
  if (!response.ok) {
    throw new Error(`responses:${response.status}`);
  }
  return extractResponseText(await response.json());
}

async function requestChatCompletions(
  endpoint: URL,
  credential: string,
  input: GenerateTerminalPaneTitleInput,
  fetchImpl: FetchLike
): Promise<string> {
  const response = await fetchImpl(new URL("chat/completions", endpoint), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: input.model.runtimeId ?? input.model.id,
      messages: buildMessages(input),
      max_tokens: 32
    })
  });
  if (!response.ok) {
    throw new Error(`chat:${response.status}`);
  }
  return extractResponseText(await response.json());
}

function requestCandidateBaseUrls(input: GenerateTerminalPaneTitleInput): URL[] {
  const rawCandidates = [input.provider.baseUrl, input.config.codexLbBaseUrl]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  const unique = new Set<string>();
  const endpoints: URL[] = [];
  for (const raw of rawCandidates) {
    const normalized = normalizeBaseUrl(raw);
    const key = normalized.href;
    if (unique.has(key)) continue;
    unique.add(key);
    endpoints.push(normalized);
  }
  return endpoints;
}

export async function generateTerminalPaneTitle(
  input: GenerateTerminalPaneTitleInput,
  options: TerminalPaneTitleGenerationOptions = {}
): Promise<GenerateTerminalPaneTitleResult> {
  const providerBaseUrl = input.provider.baseUrl ?? input.config.codexLbBaseUrl;
  if (!providerBaseUrl || !backedByCodexLb(input.provider)) {
    throw new Error("CLI title generation requires a verified Codex-LB-backed provider.");
  }
  const keyPath = input.provider.credentialRef?.startsWith("/") ? input.provider.credentialRef : input.config.codexLbKeyFile;
  const keyLabel = input.config.codexLbKeyName ?? (keyPath ? basename(keyPath) : null);
  if (!keyPath || !keyLabel?.startsWith("space-")) {
    throw new Error("Dedicated Space Codex-LB credentials are required for CLI title generation.");
  }
  const readFileImpl = options.readFileImpl ?? ((path: string) => import("node:fs/promises").then((module) => module.readFile(path, "utf8")));
  const credential = (await readFileImpl(keyPath)).trim();
  if (!credential) {
    throw new Error("CLI title generation credential file is empty.");
  }
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const endpoints = requestCandidateBaseUrls(input);

  let rawTitle = "";
  let lastError: unknown = null;
  for (const endpoint of endpoints) {
    try {
      rawTitle = await requestResponses(endpoint, credential, input, fetchImpl);
      lastError = null;
      break;
    } catch (responsesError) {
      try {
        rawTitle = await requestChatCompletions(endpoint, credential, input, fetchImpl);
        lastError = null;
        break;
      } catch (chatError) {
        lastError = chatError ?? responsesError;
      }
    }
  }
  if (lastError) {
    throw lastError instanceof Error ? lastError : new Error("CLI title generation failed.");
  }

  return {
    title: sanitizeGeneratedPaneTitle(rawTitle, input.currentTitle || "CLI"),
    providerId: input.provider.id,
    modelId: input.model.id
  };
}

function openCodeAuthorization(control: OpenCodeServerControl): string {
  return `Basic ${Buffer.from(`${control.serverUsername}:${control.serverPassword}`).toString("base64")}`;
}

function extractOpenCodeAssistantText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  const texts: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; text?: unknown; ignored?: unknown; synthetic?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") continue;
    if (record.ignored === true || record.synthetic === true) continue;
    const text = record.text.trim();
    if (text) texts.push(text);
  }
  return texts[texts.length - 1] ?? "";
}

export const openCodePlaceholderTitlePattern =
  /^(New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

async function fetchOpenCodeFirstUserMessage(
  baseUrl: string,
  authorization: string,
  nativeSessionId: string,
  directory: string,
  fetchImpl: FetchLike
): Promise<string> {
  const response = await fetchImpl(
    `${baseUrl}/session/${encodeURIComponent(nativeSessionId)}/message?directory=${encodeURIComponent(directory)}&limit=50`,
    {
      headers: { authorization },
      signal: AbortSignal.timeout(10_000)
    }
  );
  if (!response.ok) return "";
  const messages = (await response.json()) as unknown;
  if (!Array.isArray(messages)) return "";
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const info = (message as { info?: unknown }).info as Record<string, unknown> | null | undefined;
    if (!info || info.role !== "user") continue;
    const parts = (message as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const record = part as { type?: unknown; text?: unknown };
      if (record.type !== "text" || typeof record.text !== "string") continue;
      const text = record.text.trim();
      if (text) return text.slice(0, 2_000);
    }
  }
  return "";
}

export async function generateOpenCodePaneTitle(
  input: GenerateOpenCodePaneTitleInput,
  options: TerminalPaneTitleGenerationOptions = {}
): Promise<GenerateTerminalPaneTitleResult> {
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const baseUrl = openCodeServerBaseUrl(input.control.serverPort, input.control.serverHost);
  const authorization = openCodeAuthorization(input.control);
  const providerId = input.providerId ?? openCodeTitleProviderId;
  const modelId = input.modelId ?? openCodeTitleModelId;
  const directory = input.cwd?.trim() || "/etc";

  let primaryTaskRequest = input.primaryTaskRequest?.trim() ?? "";
  let trustPrimaryTaskRequest = false;
  if (!primaryTaskRequest && input.skipNativeContext !== true) {
    try {
      const nativeUserMessage = await fetchOpenCodeFirstUserMessage(
        baseUrl,
        authorization,
        input.control.nativeSessionId,
        directory,
        fetchImpl
      );
      if (nativeUserMessage) {
        primaryTaskRequest = nativeUserMessage;
        trustPrimaryTaskRequest = true;
      }
    } catch {
      // The native session may be unreachable; fall back to the remaining context below.
    }
  }
  if (!primaryTaskRequest && input.skipNativeContext !== true) {
    try {
      const info = await fetchOpenCodeSessionTitle(input.control, input.control.nativeSessionId);
      if (info && !openCodePlaceholderTitlePattern.test(info.title.trim())) {
        primaryTaskRequest = info.title.trim();
        trustPrimaryTaskRequest = true;
      }
    } catch {
      // Fall back to the pane context below.
    }
  }
  const messages = buildMessages(
    {
      currentTitle: input.currentTitle,
      cwd: input.cwd,
      primaryTaskRequest: primaryTaskRequest || null,
      trustPrimaryTaskRequest,
      transcript: input.transcript
    },
    { allowEmpty: true }
  );

  const createResponse = await fetchImpl(
    `${baseUrl}/session?directory=${encodeURIComponent(directory)}`,
    {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json"
      },
      body: JSON.stringify({ title: "Space pane title generation" }),
      signal: AbortSignal.timeout(15_000)
    }
  );
  if (!createResponse.ok) {
    throw new Error(`OpenCode title session create failed with HTTP ${createResponse.status}.`);
  }
  const created = (await createResponse.json()) as { id?: unknown };
  const sessionId = typeof created.id === "string" && created.id.length > 0 ? created.id : null;
  if (!sessionId) {
    throw new Error("OpenCode title session create returned no session id.");
  }
  try {
    const promptResponse = await fetchImpl(`${baseUrl}/session/${encodeURIComponent(sessionId)}/message`, {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        parts: [{ type: "text", text: messages[1]?.content ?? "" }],
        model: { providerID: providerId, modelID: modelId },
        system: messages[0]?.content,
        tools: {}
      }),
      signal: AbortSignal.timeout(input.promptTimeoutMs ?? 120_000)
    });
    if (!promptResponse.ok) {
      throw new Error(`OpenCode title prompt failed with HTTP ${promptResponse.status}.`);
    }
    const payload = (await promptResponse.json()) as { parts?: unknown };
    const rawTitle = extractOpenCodeAssistantText(payload.parts);
    return {
      title: sanitizeGeneratedPaneTitle(rawTitle, input.currentTitle || "CLI"),
      providerId,
      modelId
    };
  } finally {
    try {
      await fetchImpl(`${baseUrl}/session/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
        headers: { authorization },
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      // Best-effort cleanup; the temp session may remain as an orphan on failure.
    }
  }
}
