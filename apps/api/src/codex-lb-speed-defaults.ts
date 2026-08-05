import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CodexAppServerSocketModelOption } from "@space/codex-app-server";
import {
  cliModelIdentifierSchema,
  codexLbSpeedDefaultsResponseSchema,
  type CodexLbSpeedDefaultsResponse,
  type CodexLbSpeedTier
} from "@space/contracts";
import { SpaceConflictError } from "@space/runtime";

const execFileAsync = promisify(execFile);
const defaultCommand = "/opt/spaceapp/bin/codex-vscode-parity";

export type CodexLbSpeedModelId = CodexLbSpeedDefaultsResponse["models"][number]["modelId"];
export type CodexLbSpeedCommandRunner = (command: string, args: string[]) => Promise<string>;
type CodexLbSpeedCatalogProvider = () => Promise<CodexAppServerSocketModelOption[]>;

interface CodexLbSpeedMapDocument {
  version: 1;
  updated_at: string | null;
  models: Record<string, "standard" | "fast">;
}

async function runFixedCommand(command: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    timeout: 10_000,
    maxBuffer: 32_000
  });
  return String(stdout);
}

function parseMapDocument(value: unknown): CodexLbSpeedMapDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid document");
  const source = value as Record<string, unknown>;
  const rawModels = source.models;
  if (source.version !== 1 || !rawModels || typeof rawModels !== "object" || Array.isArray(rawModels)) {
    throw new Error("invalid document");
  }
  const updatedAt = source.updated_at;
  if (
    updatedAt !== null &&
    (typeof updatedAt !== "string" ||
      !Number.isFinite(Date.parse(updatedAt)) ||
      new Date(updatedAt).toISOString() !== updatedAt)
  ) {
    throw new Error("invalid document");
  }
  const models: Record<string, "standard" | "fast"> = {};
  for (const [modelId, tier] of Object.entries(rawModels)) {
    if (!cliModelIdentifierSchema.safeParse(modelId).success || (tier !== "standard" && tier !== "fast")) {
      throw new Error("invalid document");
    }
    models[modelId] = tier;
    if (Object.keys(models).length > 5_000) throw new Error("invalid document");
  }
  return { version: 1, updated_at: updatedAt, models };
}

function safeDisplayName(value: string, fallback: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240)
    .trim();
  return normalized || fallback;
}

export function createCodexLbSpeedDefaultsService(options: {
  command?: string;
  listModels?: CodexLbSpeedCatalogProvider;
  now?: () => Date;
  runCommand?: CodexLbSpeedCommandRunner;
} = {}) {
  const command = options.command ?? defaultCommand;
  const listModels = options.listModels ?? (async () => {
    throw new Error("Codex model catalog is unavailable.");
  });
  const now = options.now ?? (() => new Date());
  const runCommand = options.runCommand ?? runFixedCommand;

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

  async function runMap(args: string[]): Promise<CodexLbSpeedMapDocument> {
    try {
      return parseMapDocument(JSON.parse(await runCommand(command, args)));
    } catch {
      throw new SpaceConflictError("Codex-LB speed defaults are unavailable.");
    }
  }

  function response(
    catalog: Awaited<ReturnType<typeof currentCatalog>>,
    document: CodexLbSpeedMapDocument
  ): CodexLbSpeedDefaultsResponse {
    return codexLbSpeedDefaultsResponseSchema.parse({
      models: catalog.map(({ modelId, displayName }) => ({
        modelId,
        displayName,
        tier: document.models[modelId] === "fast" ? "FAST" : "STANDARD"
      })),
      updatedAt: document.updated_at,
      checkedAt: now().toISOString()
    });
  }

  return {
    read: async () => {
      const [catalog, document] = await Promise.all([currentCatalog(), runMap(["speed-status"])]);
      return response(catalog, document);
    },
    update: async (modelId: CodexLbSpeedModelId, tier: CodexLbSpeedTier) => {
      const catalog = await currentCatalog();
      if (!catalog.some((model) => model.modelId === modelId)) {
        throw new SpaceConflictError("The selected model is not advertised by the current Codex catalog.");
      }
      const document = await runMap(["speed-set", modelId, tier.toLowerCase()]);
      return response(catalog, document);
    }
  };
}
