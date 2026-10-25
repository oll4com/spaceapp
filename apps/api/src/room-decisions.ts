import { readFile } from "node:fs/promises";
import { z } from "zod";

export const JEV_MODEL_ID = "typesafe/jev-1.13";
export const JEV_DIRECT_MODEL_ID = "jev-1.13.0";
export const JEV_OPENROUTER_MODEL_ID = "typesafe/jev-1.13";
export const JEV_DECISIONS_PATH = "/api/alpha/decisions";
export const JEV_DIRECT_DECISIONS_PATH = "/api/v1/decide";
export const JEV_DIRECT_BASE_URL = "https://jevtypesafeai.com";
export const JEV_OPENROUTER_BASE_URL = "https://openrouter.ai";

const noulQuestionSchema = z.object({
  type: z.literal("noul"),
  instructions: z.string().trim().min(1).max(2000),
  criteria: z.object({
    true: z.string().trim().min(1).max(500),
    false: z.string().trim().min(1).max(500)
  }).strict().optional()
}).strict();

const choiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: z.string().trim().min(1).max(2000),
  criteria: z.record(z.string().trim().min(1).max(120), z.string().trim().min(1).max(500))
}).strict();

const scoreQuestionSchema = z.object({
  type: z.literal("score"),
  instructions: z.string().trim().min(1).max(2000),
  criteria: z.array(z.string().trim().min(1).max(500)).min(2).max(16)
}).strict();

export const jevQuestionSchema = z.union([noulQuestionSchema, choiceQuestionSchema, scoreQuestionSchema]);
export type JevQuestion = z.infer<typeof jevQuestionSchema>;
export type JevQuestions = Record<string, JevQuestion>;

const answersSchema = z.record(z.string(), z.unknown());
const usageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cost: z.number().optional(),
  cost_usd: z.number().optional(),
  credits_remaining_usd: z.number().optional()
}).passthrough().optional();

const decisionsResponseSchema = z.object({
  model: z.string().optional(),
  answers: answersSchema,
  usage: usageSchema,
  id: z.string().optional(),
  provider: z.string().optional()
}).passthrough();

export type JevDecisionsResponse = z.infer<typeof decisionsResponseSchema>;

export interface JevDecideInput {
  state: unknown;
  questions: JevQuestions;
}

export interface JevDecideResult {
  answers: Record<string, unknown>;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cost: number | null;
    creditsRemaining?: number | null;
  };
  model: string | null;
  latencyMs: number;
}

export function jevDecisionsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  if (trimmed.endsWith("/api/v1/decide")) return trimmed;
  if (trimmed.includes("jevtypesafeai.com")) {
    if (trimmed.endsWith("/api/v1")) return `${trimmed}/decide`;
    return `${trimmed}${JEV_DIRECT_DECISIONS_PATH}`;
  }
  if (trimmed.endsWith("/api/v1")) {
    return `${trimmed.slice(0, -"/api/v1".length)}${JEV_DECISIONS_PATH}`;
  }
  if (trimmed.endsWith("/api/alpha/decisions")) return trimmed;
  return `${trimmed}${JEV_DECISIONS_PATH}`;
}

export const DEFAULT_JEV_TOKEN_FILES = [
  "/opt/spaceapp/secrets/space-jev.key",
  "/opt/spaceapp/secrets/space-jevtypesafe.key",
  "/var/lib/spaceapp-user/.config/opencode/jev.token",
  "/opt/spaceapp/secrets/space-openrouter.key",
  "/var/lib/spaceapp-user/.config/opencode/openrouter.token"
] as const;

export interface JevResolvedConfig {
  apiKey: string | null;
  baseUrl: string;
  model: string;
  source: string | null;
}

export async function resolveJevConfig(options: {
  apiKey?: string | null;
  baseUrl?: string | null;
  tokenFile?: string | null;
  readFileImpl?: (path: string) => Promise<string>;
} = {}): Promise<JevResolvedConfig> {
  const readFileFn = options.readFileImpl ?? ((path: string) => readFile(path, "utf8"));
  let apiKey = options.apiKey ?? null;
  let source: string | null = apiKey ? "explicit-option" : null;

  if (!apiKey && process.env.SPACE_JEV_API_KEY) {
    apiKey = process.env.SPACE_JEV_API_KEY.trim();
    source = "SPACE_JEV_API_KEY";
  } else if (!apiKey && process.env.JEV_API_KEY) {
    apiKey = process.env.JEV_API_KEY.trim();
    source = "JEV_API_KEY";
  }

  if (!apiKey) {
    const explicitFile = options.tokenFile ?? process.env.SPACE_JEV_TOKEN_FILE;
    const candidateFiles = explicitFile ? [explicitFile] : DEFAULT_JEV_TOKEN_FILES;

    for (const file of candidateFiles) {
      try {
        const raw = await readFileFn(file);
        const val = raw.trim();
        if (val) {
          apiKey = val;
          source = file;
          break;
        }
      } catch {}
    }
  }

  const isDirectJev = Boolean(
    apiKey?.startsWith("jv_live_") ||
    (source && (source.includes("jev") || source.includes("space-jev")))
  );

  let baseUrl = options.baseUrl ?? process.env.SPACE_JEV_BASE_URL ?? (
    isDirectJev ? JEV_DIRECT_BASE_URL : (apiKey?.startsWith("sk-or-") || source?.includes("openrouter")) ? JEV_OPENROUTER_BASE_URL : JEV_DIRECT_BASE_URL
  );

  const model = baseUrl.includes("jevtypesafeai.com") ? JEV_DIRECT_MODEL_ID : JEV_OPENROUTER_MODEL_ID;

  return { apiKey, baseUrl, model, source };
}

export function createRoomDecisionsClient(options: {
  baseUrl: string | null;
  apiKey: string | null;
  model?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}) {
  const request = options.fetch ?? globalThis.fetch;
  const endpoint = options.baseUrl ? jevDecisionsEndpoint(options.baseUrl) : null;
  const isDirectJev = Boolean(
    endpoint?.includes("jevtypesafeai.com") ||
    options.apiKey?.startsWith("jv_live_")
  );
  let model = options.model;
  if (!model) {
    model = isDirectJev ? JEV_DIRECT_MODEL_ID : JEV_OPENROUTER_MODEL_ID;
  } else if (isDirectJev && (model === "typesafe/jev-1.13" || model === "openrouter/typesafe/jev-1.13")) {
    model = JEV_DIRECT_MODEL_ID;
  }
  return {
    model,
    endpoint,
    async decide(input: JevDecideInput): Promise<JevDecideResult> {
      if (!options.baseUrl || !options.apiKey) {
        throw new Error("Jev decisions client is not configured (baseUrl/apiKey missing).");
      }
      const questions = z.record(z.string().trim().min(1).max(120), jevQuestionSchema).parse(input.questions);
      const started = performance.now();
      const response = await request(endpoint!, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
          "HTTP-Referer": "http://127.0.0.1:4911",
          "X-Title": "space-jevs"
        },
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 15_000)]) : AbortSignal.timeout(options.timeoutMs ?? 15_000),
        body: JSON.stringify({ model, state: input.state, questions })
      });
      if (!response.ok) {
        throw new Error(`Jev decisions request failed with HTTP ${response.status}.`);
      }
      const payload = decisionsResponseSchema.parse(await response.json());
      const usage = payload.usage ?? {};
      const cost = typeof usage.cost === "number" ? usage.cost : typeof usage.cost_usd === "number" ? usage.cost_usd : null;
      const creditsRemaining = typeof usage.credits_remaining_usd === "number" ? usage.credits_remaining_usd : null;
      if (typeof creditsRemaining === "number") {
        setLastKnownJevCredits(creditsRemaining);
      }
      return {
        answers: payload.answers,
        usage: {
          inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
          outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : null,
          cost,
          creditsRemaining
        },
        model: payload.model ?? null,
        latencyMs: performance.now() - started
      };
    }
  };
}

let lastKnownJevCredits: number | null = null;
export function getLastKnownJevCredits(): number | null {
  return lastKnownJevCredits;
}
export function setLastKnownJevCredits(c: number) {
  lastKnownJevCredits = c;
}
