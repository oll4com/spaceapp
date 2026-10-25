import type { CodexAppServerSocketModelOption } from "@space/codex-app-server";
import {
  cliModelIdentifierSchema,
  codexLbSpeedDefaultsResponseSchema,
  type CodexLbSpeedDefaultsResponse,
  type CodexLbSpeedTier
} from "@space/contracts";
import { SpaceConflictError } from "@space/runtime";

export type CodexLbSpeedModelId = CodexLbSpeedDefaultsResponse["models"][number]["modelId"];
type CodexLbSpeedCatalogProvider = () => Promise<CodexAppServerSocketModelOption[]>;

function safeDisplayName(value: string, fallback: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240)
    .trim();
  return normalized || fallback;
}

/** The speed map (standard or fast per Codex model) that Space Gateway applies to Codex requests. */
export interface CodexSpeedMapStore {
  read(): Promise<{ models: Record<string, "standard" | "fast">; updatedAt: string | null }>;
  set(modelId: string, tier: "standard" | "fast"): Promise<{ models: Record<string, "standard" | "fast">; updatedAt: string | null }>;
}

export function createCodexLbSpeedDefaultsService(options: {
  listModels?: CodexLbSpeedCatalogProvider;
  now?: () => Date;
  store: CodexSpeedMapStore;
}) {
  const listModels = options.listModels ?? (async () => {
    throw new Error("Codex model catalog is unavailable.");
  });
  const now = options.now ?? (() => new Date());

  async function currentCatalog() {
    try {
      const advertised = await listModels();
      const models = [];
      const seen = new Set<string>();
      for (const candidate of advertised) {
        const parsedId = cliModelIdentifierSchema.safeParse(candidate.id);
        if (!parsedId.success || seen.has(parsedId.data)) continue;
        models.push({
          modelId: parsedId.data,
          displayName: safeDisplayName(candidate.displayName, parsedId.data)
        });
        seen.add(parsedId.data);
        if (models.length >= 5_000) break;
      }
      if (!models.length) throw new Error("empty catalog");
      return models;
    } catch {
      throw new SpaceConflictError("Codex model catalog is unavailable.");
    }
  }

  type SpeedMap = Awaited<ReturnType<CodexSpeedMapStore["read"]>>;

  async function speedMap(change?: { modelId: string; tier: "standard" | "fast" }): Promise<SpeedMap> {
    try {
      return change ? await options.store.set(change.modelId, change.tier) : await options.store.read();
    } catch {
      throw new SpaceConflictError("Codex speed defaults are unavailable.");
    }
  }

  function response(
    catalog: Awaited<ReturnType<typeof currentCatalog>>,
    document: SpeedMap
  ): CodexLbSpeedDefaultsResponse {
    return codexLbSpeedDefaultsResponseSchema.parse({
      models: catalog.map(({ modelId, displayName }) => ({
        modelId,
        displayName,
        tier: document.models[modelId] === "fast" ? "FAST" : "STANDARD"
      })),
      updatedAt: document.updatedAt,
      checkedAt: now().toISOString()
    });
  }

  return {
    read: async () => {
      const [catalog, document] = await Promise.all([currentCatalog(), speedMap()]);
      return response(catalog, document);
    },
    update: async (modelId: CodexLbSpeedModelId, tier: CodexLbSpeedTier) => {
      const catalog = await currentCatalog();
      if (!catalog.some((model) => model.modelId === modelId)) {
        throw new SpaceConflictError("The selected model is not advertised by the current Codex catalog.");
      }
      const document = await speedMap({ modelId, tier: tier === "FAST" ? "fast" : "standard" });
      return response(catalog, document);
    }
  };
}
