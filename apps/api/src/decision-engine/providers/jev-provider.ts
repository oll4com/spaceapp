import { readFile } from "node:fs/promises";
import type { JevDecideInput, JevDecideResult } from "@space/contracts";
import {
  createRoomDecisionsClient,
  resolveJevConfig,
  type JevResolvedConfig
} from "../../room-decisions.js";
import type { DecisionProvider } from "../types.js";

export interface JevDecisionProviderOptions {
  baseUrl?: string | null;
  apiKey?: string | null;
  tokenFile?: string | null;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  readFileImpl?: (path: string) => Promise<string>;
}

export class JevDecisionProvider implements DecisionProvider {
  readonly id = "jev";
  readonly name = "Jev AI Neural Supervisor (TypeSafe Jev 1.13)";

  private readonly options: JevDecisionProviderOptions;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly readFileImpl: (path: string) => Promise<string>;

  constructor(options: JevDecisionProviderOptions = {}) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.readFileImpl = options.readFileImpl ?? ((path: string) => readFile(path, "utf8"));
  }

  private async getConfig(): Promise<JevResolvedConfig> {
    return resolveJevConfig({
      apiKey: this.options.apiKey,
      baseUrl: this.options.baseUrl,
      tokenFile: this.options.tokenFile,
      readFileImpl: this.readFileImpl
    });
  }

  async isAvailable(): Promise<boolean> {
    const config = await this.getConfig();
    return Boolean(config.apiKey);
  }

  async decide(request: JevDecideInput): Promise<JevDecideResult> {
    const config = await this.getConfig();
    if (!config.apiKey) {
      return {
        available: false,
        reason: "Jev decisions are not configured; continuing without them.",
        degraded: true
      };
    }
    try {
      const client = createRoomDecisionsClient({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        fetch: this.fetchImpl,
        timeoutMs: this.timeoutMs
      });
      const result = await client.decide(request);
      return {
        available: true,
        answers: result.answers,
        model: result.model,
        usage: result.usage,
        latencyMs: result.latencyMs
      };
    } catch {
      return {
        available: false,
        reason: "Jev decisions provider failed; continuing without them.",
        degraded: true
      };
    }
  }
}
