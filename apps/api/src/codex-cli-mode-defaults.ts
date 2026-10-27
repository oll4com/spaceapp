import type {
  CodexAppServerSocketModelOption,
  CodexConfiguredModel
} from "@space/codex-app-server";
import {
  codexCliModeDefaultsResponseSchema,
  type CodexCliModeDefaultPair,
  type CodexCliModeDefaultsCatalog,
  type CodexCliModeDefaultsResponse
} from "@space/contracts";
import { SpaceFeatureDisabledError } from "@space/runtime";

export interface CodexCliModeDefaultsControl {
  listModels(): Promise<CodexAppServerSocketModelOption[]>;
  readConfiguredModel(): Promise<CodexConfiguredModel>;
}

export interface CodexCliModeDefaultsService {
  /** The model and reasoning effort a fresh Codex session starts with, resolved the way Codex resolves them. */
  build(): Promise<CodexCliModeDefaultPair>;
  read(): Promise<CodexCliModeDefaultsResponse>;
}

export interface CodexCliModeDefaultsServiceOptions {
  control: CodexCliModeDefaultsControl | null;
  refreshIntervalMs?: number;
  now?: () => number;
}

const defaultRefreshIntervalMs = 60_000;

/**
 * Public installs and the dev instance have no Codex app-server to ask for its defaults (dev's API runs without sudo, and the
 * app-server launcher must sudo to the CLI user): Codex resolves its configured model and effort itself at launch.
 */
export function codexChoosesDefaults(config: { publicDistribution?: boolean; instance?: string }): boolean {
  return config.publicDistribution === true || config.instance === "dev";
}

function unresolvedError(): SpaceFeatureDisabledError {
  return new SpaceFeatureDisabledError(
    "CLI_CODEX_DEFAULTS_UNRESOLVED",
    "Codex CLI launch defaults could not be resolved."
  );
}

// Codex starts on its configured model, else on its catalog default, and an unset effort is that model's default.
// Space chooses nothing itself: Plan mode and later switches stay with Codex.
export function codexDefaultPair(
  models: CodexAppServerSocketModelOption[],
  configured: CodexConfiguredModel | null
): CodexCliModeDefaultPair | null {
  const modelId = configured?.model ?? (models.find((candidate) => candidate.isDefault) ?? models[0])?.id;
  const reasoningEffort = configured?.reasoningEffort ??
    models.find((candidate) => candidate.id === modelId)?.defaultReasoningEffort;
  return modelId && reasoningEffort ? { modelId, reasoningEffort } : null;
}

async function readConfiguredModel(control: CodexCliModeDefaultsControl): Promise<CodexConfiguredModel | null> {
  try {
    return await control.readConfiguredModel();
  } catch {
    return null;
  }
}

export function createCodexCliModeDefaultsService(
  options: CodexCliModeDefaultsServiceOptions
): CodexCliModeDefaultsService {
  const refreshIntervalMs = options.refreshIntervalMs ?? defaultRefreshIntervalMs;
  const now = options.now ?? Date.now;
  let resolved: { pair: CodexCliModeDefaultPair; at: number } | null = null;
  let inFlight: Promise<CodexCliModeDefaultPair> | null = null;

  async function resolve(): Promise<CodexCliModeDefaultPair> {
    const control = options.control;
    if (!control) throw unresolvedError();
    const [models, configured] = await Promise.all([
      control.listModels().catch(() => []),
      readConfiguredModel(control)
    ]);
    const pair = codexDefaultPair(models, configured);
    if (!pair) throw unresolvedError();
    resolved = { pair, at: now() };
    return pair;
  }

  async function build(): Promise<CodexCliModeDefaultPair> {
    if (resolved && now() - resolved.at < refreshIntervalMs) return resolved.pair;
    const attempt = inFlight ?? resolve();
    if (!inFlight) {
      inFlight = attempt;
      void attempt.then(() => { inFlight = null; }, () => { inFlight = null; });
    }
    try {
      return await attempt;
    } catch (error) {
      // A Codex that cannot be asked right now keeps the last answer it gave.
      if (resolved) return resolved.pair;
      throw error;
    }
  }

  async function catalog(): Promise<CodexCliModeDefaultsCatalog> {
    try {
      const models = options.control ? await options.control.listModels() : [];
      if (!models.length) throw new Error("empty catalog");
      return { status: "AVAILABLE", models, error: null };
    } catch {
      return { status: "UNAVAILABLE", models: [], error: "Codex model catalog is unavailable." };
    }
  }

  async function read(): Promise<CodexCliModeDefaultsResponse> {
    const [defaultBuild, currentCatalog] = await Promise.all([build(), catalog()]);
    return codexCliModeDefaultsResponseSchema.parse({ defaults: { build: defaultBuild }, catalog: currentCatalog });
  }

  return { build, read };
}
