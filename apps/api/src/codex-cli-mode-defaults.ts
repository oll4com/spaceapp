import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  CodexAppServerSocketModelOption,
  CodexCollaborationModePreset
} from "@space/codex-app-server";
import {
  codexCliModeDefaultsProjectionSchema,
  codexCliModeDefaultsResponseSchema,
  updateCodexCliModeDefaultsInputSchema,
  type CodexCliModeDefaultPair,
  type CodexCliModeDefaults,
  type CodexCliModeDefaultsResponse,
  type UpdateCodexCliModeDefaultsInput
} from "@space/contracts";
import {
  SpaceConflictError,
  SpaceFeatureDisabledError,
  type SpaceStore
} from "@space/runtime";

export interface CodexCliModeDefaultsControl {
  listModels(): Promise<CodexAppServerSocketModelOption[]>;
  listCollaborationModes(): Promise<CodexCollaborationModePreset[]>;
}

export interface CodexCliModeDefaultsService {
  current(): Promise<CodexCliModeDefaults>;
  read(): Promise<CodexCliModeDefaultsResponse>;
  update(input: UpdateCodexCliModeDefaultsInput): Promise<CodexCliModeDefaultsResponse>;
}

export interface CodexCliModeDefaultsServiceOptions {
  store: SpaceStore;
  control: CodexCliModeDefaultsControl | null;
  legacyBuild: CodexCliModeDefaultPair | null;
  projectionPath: string | null;
}

// The projection contains no secrets and must be readable by per-session multiplexers running as an unprivileged user.
const runtimeProjectionMode = 0o644;

async function writeProjection(path: string | null, defaults: CodexCliModeDefaults): Promise<void> {
  if (!path) return;
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const projection = codexCliModeDefaultsProjectionSchema.parse({
    schemaVersion: "CodexCliModeDefaultsProjectionV1",
    revision: defaults.updatedAt,
    defaults
  });
  await mkdir(directory, { recursive: true, mode: 0o750 });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(projection)}\n`, { encoding: "utf8", mode: runtimeProjectionMode, flag: "wx" });
    await rename(temporaryPath, path);
    await chmod(path, runtimeProjectionMode);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function planPair(
  presets: CodexCollaborationModePreset[],
  fallback: CodexCliModeDefaultPair,
  models: CodexAppServerSocketModelOption[]
): CodexCliModeDefaultPair {
  const preset = presets.find((candidate) => candidate.mode === "plan");
  if (!preset?.model || !preset.reasoning_effort) return fallback;
  const advertised = models.find((candidate) => candidate.id === preset.model);
  if (!advertised?.supportedReasoningEfforts.includes(preset.reasoning_effort)) return fallback;
  return { modelId: preset.model, reasoningEffort: preset.reasoning_effort };
}

function advertisedPair(
  models: CodexAppServerSocketModelOption[],
  preferred: CodexCliModeDefaultPair | null
): CodexCliModeDefaultPair | null {
  if (preferred) {
    const advertised = models.find((candidate) => candidate.id === preferred.modelId);
    if (advertised?.supportedReasoningEfforts.includes(preferred.reasoningEffort)) return preferred;
  }
  const selected = models.find((candidate) => candidate.isDefault) ?? models[0];
  if (!selected) return null;
  const reasoningEffort = selected.supportedReasoningEfforts.includes(selected.defaultReasoningEffort)
    ? selected.defaultReasoningEffort
    : selected.supportedReasoningEfforts[0];
  return reasoningEffort ? { modelId: selected.id, reasoningEffort } : null;
}

function pairIsAdvertised(
  pair: CodexCliModeDefaultPair,
  models: CodexAppServerSocketModelOption[]
): boolean {
  const advertised = models.find((candidate) => candidate.id === pair.modelId);
  return advertised?.supportedReasoningEfforts.includes(pair.reasoningEffort) ?? false;
}

export function createCodexCliModeDefaultsService(
  options: CodexCliModeDefaultsServiceOptions
): CodexCliModeDefaultsService {
  let initializePromise: Promise<CodexCliModeDefaults> | null = null;
  let currentDefaults: CodexCliModeDefaults | null = null;
  let mutationTail: Promise<void> = Promise.resolve();

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  function initialize(): Promise<CodexCliModeDefaults> {
    if (initializePromise) return initializePromise;
    const attempt = (async () => {
      const models = options.control
        ? await options.control.listModels().catch(() => [])
        : [];
      const build = advertisedPair(models, options.legacyBuild);
      if (!build) {
        throw new SpaceFeatureDisabledError(
          "CLI_CODEX_DEFAULTS_UNRESOLVED",
          "Codex CLI launch defaults could not be resolved."
        );
      }
      const presets = options.control
        ? await options.control.listCollaborationModes().catch(() => [])
        : [];
      const desired = {
        build,
        plan: planPair(presets, build, models)
      };
      let defaults = await options.store.initializeCodexCliModeDefaults(desired);
      for (const mode of ["build", "plan"] as const) {
        if (pairIsAdvertised(defaults[mode], models)) continue;
        defaults = await options.store.updateCodexCliModeDefaults({
          mode,
          modelId: desired[mode].modelId,
          reasoningEffort: desired[mode].reasoningEffort
        });
      }
      currentDefaults = defaults;
      await writeProjection(options.projectionPath, defaults);
      return defaults;
    })();
    initializePromise = attempt;
    void attempt.catch(() => {
      if (initializePromise === attempt) initializePromise = null;
    });
    return attempt;
  }

  async function current(): Promise<CodexCliModeDefaults> {
    await initialize();
    if (!currentDefaults) throw new Error("Codex CLI mode defaults were not initialized.");
    return currentDefaults;
  }

  async function catalog() {
    if (!options.control) {
      return {
        status: "UNAVAILABLE" as const,
        models: [],
        error: "Codex model catalog is unavailable."
      };
    }
    try {
      const models = await options.control.listModels();
      if (!models.length) throw new Error("empty catalog");
      return { status: "AVAILABLE" as const, models, error: null };
    } catch {
      return {
        status: "UNAVAILABLE" as const,
        models: [],
        error: "Codex model catalog is unavailable."
      };
    }
  }

  async function read(): Promise<CodexCliModeDefaultsResponse> {
    const [defaults, currentCatalog] = await Promise.all([current(), catalog()]);
    return codexCliModeDefaultsResponseSchema.parse({ defaults, catalog: currentCatalog });
  }

  return {
    current,
    read,
    update: (input) => serialize(async () => {
      await initialize();
      const parsed = updateCodexCliModeDefaultsInputSchema.parse(input);
      const currentCatalog = await catalog();
      if (currentCatalog.status === "UNAVAILABLE") {
        throw new SpaceFeatureDisabledError(
          "CODEX_MODEL_CATALOG_UNAVAILABLE",
          currentCatalog.error
        );
      }
      const selectedModel = currentCatalog.models.find((candidate) => candidate.id === parsed.modelId);
      if (!selectedModel || !selectedModel.supportedReasoningEfforts.includes(parsed.reasoningEffort)) {
        throw new SpaceConflictError(
          "The selected model and reasoning effort are not advertised by the current Codex catalog."
        );
      }
      const defaults = await options.store.updateCodexCliModeDefaults(parsed);
      currentDefaults = defaults;
      await writeProjection(options.projectionPath, defaults);
      return codexCliModeDefaultsResponseSchema.parse({ defaults, catalog: currentCatalog });
    })
  };
}
