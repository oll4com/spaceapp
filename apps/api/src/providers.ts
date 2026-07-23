import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  modelSchema,
  providerValidationResultSchema,
  type Model,
  type Provider,
  type ProviderValidationResult
} from "@space/contracts";
import type { SpaceApiConfig } from "./config.js";

type FetchLike = typeof fetch;
const MAX_DISCOVERED_MODELS = 200;

export interface ProviderValidationOptions {
  fetchImpl?: FetchLike;
  readFileImpl?: (path: string) => Promise<string>;
}

function isProvider(value: Provider | ProviderValidationOptions | null | undefined): value is Provider {
  return Boolean(value && typeof value === "object" && "id" in value);
}

function checkedAt(): string {
  return new Date().toISOString();
}

function disabledResult(input: Omit<ProviderValidationResult, "checkedAt">): ProviderValidationResult {
  return providerValidationResultSchema.parse({ ...input, checkedAt: checkedAt() });
}

function credentialLabel(input: { keyFile: string | null; keyName?: string | null }): string | null {
  if (input.keyName) return input.keyName;
  if (input.keyFile) return basename(input.keyFile);
  return null;
}

function maskCredential(value: string): string {
  const compact = value.trim();
  if (compact.length <= 8) return "configured";
  return `${compact.slice(0, 4)}...${compact.slice(-4)}`;
}

function modelsUrl(baseUrl: string): string {
  const base = new URL(baseUrl);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("Codex-LB base URL must use http or https.");
  }
  const normalized = base.href.endsWith("/") ? base.href : `${base.href}/`;
  return new URL("models", normalized).toString();
}

function modelCount(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as { data?: unknown; models?: unknown };
  if (Array.isArray(record.data)) return record.data.length;
  if (Array.isArray(record.models)) return record.models.length;
  return null;
}

function modelList(payload: unknown): unknown[] | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as { data?: unknown; models?: unknown };
  if (Array.isArray(record.data)) return record.data;
  if (Array.isArray(record.models)) return record.models;
  return null;
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const compact = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!compact) return null;
  return compact.slice(0, maxLength);
}

function positiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.trunc(value);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function objectValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function candidateRecords(record: Record<string, unknown>): Record<string, unknown>[] {
  const metadata = objectRecord(record.metadata);
  return metadata ? [record, metadata] : [record];
}

function normalizedToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizedStrings(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((item): item is string => typeof item === "string").map(normalizedToken));
}

function capabilityAliases(keys: string[]): Set<string> {
  const aliases = new Set<string>();
  for (const key of keys) {
    const normalized = normalizedToken(key);
    aliases.add(normalized);
    aliases.add(normalized.replace(/^supports/, ""));
  }
  return aliases;
}

function booleanCapability(record: Record<string, unknown>, keys: string[]): boolean {
  const aliases = capabilityAliases(keys);
  for (const candidate of candidateRecords(record)) {
    const direct = objectValue(candidate, keys);
    if (typeof direct === "boolean") return direct;
    const capabilities = normalizedStrings(candidate.capabilities);
    if ([...aliases].some((alias) => capabilities.has(alias))) return true;
  }
  return false;
}

function modalityCapability(record: Record<string, unknown>, modalityKeys: string[], expected: string[]): boolean {
  const expectedModalities = new Set(expected.map(normalizedToken));
  for (const candidate of candidateRecords(record)) {
    const modalities = normalizedStrings(objectValue(candidate, modalityKeys));
    if ([...expectedModalities].some((modality) => modalities.has(modality))) return true;
  }
  return false;
}

function visionCapability(record: Record<string, unknown>): boolean {
  return (
    booleanCapability(record, ["supports_vision", "supportsVision", "vision"]) ||
    modalityCapability(
      record,
      ["input_modalities", "inputModalities", "modalities", "supported_modalities", "supportedModalities"],
      ["image", "images", "image_input", "image-input", "image_url", "vision", "visual"]
    )
  );
}

function parseProviderModel(providerId: string, item: unknown): Model | null {
  const record = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
  const id = boundedText(typeof item === "string" ? item : record ? objectValue(record, ["id", "name", "model"]) : null, 160);
  if (!id) return null;

  const displayName =
    boundedText(record ? objectValue(record, ["display_name", "displayName", "name"]) : null, 160) ?? id;
  const contextWindow = record
    ? positiveInt(objectValue(record, ["context_window", "contextWindow", "max_context_length", "maxContextLength"]))
    : null;

  const scopedId =
    providerId === "codex-lb" ? id : `${providerId}:${id}`.length <= 160 ? `${providerId}:${id}` : `${providerId}:${createHash("sha256").update(`${providerId}:${id}`).digest("hex").slice(0, 24)}`;
  const parsed = modelSchema.safeParse({
    id: scopedId,
    providerId,
    runtimeId: id,
    displayName,
    status: "VERIFIED",
    contextWindow,
    supportsTools: record ? booleanCapability(record, ["supports_tools", "supportsTools", "tools"]) : false,
    supportsVision: record ? visionCapability(record) : false,
    supportsRealtime: record ? booleanCapability(record, ["supports_realtime", "supportsRealtime", "realtime"]) : false,
    supportsReasoning: record ? booleanCapability(record, ["supports_reasoning", "supportsReasoning", "reasoning"]) : false,
    defaultReasoningEffort: null
  });
  return parsed.success ? parsed.data : null;
}

function parseProviderModels(providerId: string, payload: unknown): Model[] | null {
  const list = modelList(payload);
  if (!list) return null;
  const models: Model[] = [];
  const seenIds = new Set<string>();
  for (const item of list.slice(0, MAX_DISCOVERED_MODELS)) {
    const model = parseProviderModel(providerId, item);
    if (!model || seenIds.has(model.id)) continue;
    seenIds.add(model.id);
    models.push(model);
  }
  if (list.length > 0 && models.length === 0) return null;
  return models;
}

export async function validateProviderCredential(
  providerId: string,
  config: SpaceApiConfig,
  providerOrOptions?: Provider | ProviderValidationOptions | null,
  maybeOptions: ProviderValidationOptions = {}
): Promise<ProviderValidationResult> {
  let provider: Provider | null = null;
  let options: ProviderValidationOptions = maybeOptions;
  if (isProvider(providerOrOptions)) {
    provider = providerOrOptions;
  } else {
    options = (providerOrOptions ?? {}) as ProviderValidationOptions;
  }
  const backingProviderId = provider?.backingProviderId ?? providerId;
  const isCodexLbBacked = backingProviderId === "codex-lb" || provider?.type === "CODEX_LB";
  if (!isCodexLbBacked) {
    return disabledResult({
      providerId,
      status: "ERROR",
      code: "SMOKE_FAILED",
      statusReason: `Provider ${providerId} is not registered for Codex-LB validation.`,
      maskedKeyPrefix: null,
      credentialLabel: null,
      modelCount: null
    });
  }

  const baseUrl = provider?.baseUrl ?? config.codexLbBaseUrl;
  const credentialRef = provider?.credentialRef?.trim() || null;
  const keyFile = credentialRef?.startsWith("/") ? credentialRef : config.codexLbKeyFile;
  const label = credentialLabel({ keyFile, keyName: config.codexLbKeyName });
  if (!baseUrl || !keyFile) {
    return disabledResult({
      providerId,
      status: "DISABLED",
      code: "MISSING_CONFIG",
      statusReason: "A Codex-LB compatible base URL and key file are required before provider credential smoke.",
      maskedKeyPrefix: null,
      credentialLabel: label,
      modelCount: null
    });
  }

  if (!label?.startsWith("space-")) {
    return disabledResult({
      providerId,
      status: "ERROR",
      code: "KEY_NAME_NOT_DEDICATED",
      statusReason: "Codex-LB key label must start with space- before Space can validate it.",
      maskedKeyPrefix: null,
      credentialLabel: label,
      modelCount: null
    });
  }

  const readCredential = options.readFileImpl ?? ((path: string) => readFile(path, "utf8"));
  let credential: string;
  try {
    credential = (await readCredential(keyFile)).trim();
  } catch {
    return disabledResult({
      providerId,
      status: "ERROR",
      code: "KEY_FILE_UNREADABLE",
      statusReason: "Codex-LB key file could not be read.",
      maskedKeyPrefix: null,
      credentialLabel: label,
      modelCount: null
    });
  }

  if (!credential) {
    return disabledResult({
      providerId,
      status: "ERROR",
      code: "KEY_FILE_UNREADABLE",
      statusReason: "Codex-LB key file is empty.",
      maskedKeyPrefix: null,
      credentialLabel: label,
      modelCount: null
    });
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 5000);
  try {
    const response = await fetchImpl(modelsUrl(baseUrl), {
      method: "GET",
      headers: { Authorization: `Bearer ${credential}` },
      signal: abort.signal
    });
    if (!response.ok) {
      return disabledResult({
        providerId,
        status: "ERROR",
        code: "SMOKE_FAILED",
        statusReason: `Codex-LB /models smoke failed with HTTP ${response.status}.`,
        maskedKeyPrefix: maskCredential(credential),
        credentialLabel: label,
        modelCount: null
      });
    }
    const payload = await response.json();
    const models = parseProviderModels(providerId, payload);
    if (modelCount(payload) === null || models === null) {
      return disabledResult({
        providerId,
        status: "ERROR",
        code: "SMOKE_FAILED",
        statusReason: "Codex-LB /models smoke returned an unexpected model-list shape.",
        maskedKeyPrefix: maskCredential(credential),
        credentialLabel: label,
        modelCount: null
      });
    }
    return disabledResult({
      providerId,
      status: "VERIFIED",
      code: "VERIFIED",
      statusReason: "Codex-LB credential passed /models auth smoke. Runtime use still requires provider enablement gate.",
      maskedKeyPrefix: maskCredential(credential),
      credentialLabel: label,
      modelCount: models.length,
      models
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError" ? "timed out" : "failed";
    return disabledResult({
      providerId,
      status: "ERROR",
      code: "SMOKE_FAILED",
      statusReason: `Codex-LB /models smoke ${reason}.`,
      maskedKeyPrefix: maskCredential(credential),
      credentialLabel: label,
      modelCount: null
    });
  } finally {
    clearTimeout(timeout);
  }
}
