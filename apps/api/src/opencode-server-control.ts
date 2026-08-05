import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { opencodeDirectParityRoot } from "./cli-parity.js";
import { opencodeNativeSessionIdPattern } from "./opencode-native-session.js";

export const opencodeServerControlMaxBytes = 8_192;
export const opencodeServerControlRequestTimeoutMs = 8_000;
export const opencodeServerControlHealthTimeoutMs = 1_500;

export interface OpenCodeServerControl {
  version: number;
  spaceSessionId: string;
  nativeSessionId: string;
  serverPort: number;
  serverHost?: string;
  serverUsername: string;
  serverPassword: string;
  updatedAt: string;
}

export interface OpenCodeModelDescriptor {
  providerId: string;
  modelId: string;
  displayName: string;
}

export const openCodeReasoningEfforts = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra"
] as const;

export const openCodeDefaultReasoningEffort = "medium" as const;

function safeSpaceSessionFileName(spaceSessionId: string): string {
  return spaceSessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
}

export function opencodeServerControlPath(
  spaceSessionId: string,
  stateRoot = join(opencodeDirectParityRoot, "state")
): string {
  return join(stateRoot, "opencode", "space-cli-control", `${safeSpaceSessionFileName(spaceSessionId)}.json`);
}

export async function readOpenCodeServerControl(
  spaceSessionId: string,
  stateRoot?: string
): Promise<OpenCodeServerControl | null> {
  const path = opencodeServerControlPath(spaceSessionId, stateRoot);
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > opencodeServerControlMaxBytes) return null;
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const control = parsed as Record<string, unknown>;
    const serverPort = typeof control.serverPort === "number" && Number.isSafeInteger(control.serverPort)
      ? control.serverPort
      : typeof control.serverPort === "string"
        ? Number.parseInt(control.serverPort, 10)
        : NaN;
    const nativeSessionId = typeof control.nativeSessionId === "string" ? control.nativeSessionId : "";
    const serverUsername = typeof control.serverUsername === "string" ? control.serverUsername : "";
    const serverPassword = typeof control.serverPassword === "string" ? control.serverPassword : "";
    const serverHost = typeof control.serverHost === "string" && control.serverHost.length > 0
      ? control.serverHost
      : "127.0.0.1";
    if (
      control.version !== 1 ||
      control.spaceSessionId !== spaceSessionId ||
      !opencodeNativeSessionIdPattern.test(nativeSessionId) ||
      !(Number.isSafeInteger(serverPort) && serverPort > 0 && serverPort < 65_536) ||
      serverUsername.length === 0 ||
      serverPassword.length === 0
    ) {
      return null;
    }
    return {
      version: 1,
      spaceSessionId,
      nativeSessionId,
      serverPort,
      serverHost,
      serverUsername,
      serverPassword,
      updatedAt: typeof control.updatedAt === "string" ? control.updatedAt : new Date(0).toISOString()
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    if (error && typeof error === "object" && "code" in error && error.code === "EACCES") return null;
    return null;
  }
}

export function openCodeServerBaseUrl(port: number, host = "127.0.0.1"): string {
  return `http://${host}:${port}`;
}

function openCodeServerAuthorization(control: OpenCodeServerControl): string {
  return `Basic ${Buffer.from(`${control.serverUsername}:${control.serverPassword}`).toString("base64")}`;
}

async function openCodeServerFetch(
  control: OpenCodeServerControl,
  path: string,
  init: RequestInit = {},
  timeoutMs = opencodeServerControlRequestTimeoutMs
): Promise<Response> {
  return fetch(`${openCodeServerBaseUrl(control.serverPort, control.serverHost)}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: openCodeServerAuthorization(control)
    },
    signal: init.signal ?? AbortSignal.timeout(timeoutMs)
  });
}

export async function openCodeServerIsHealthy(control: OpenCodeServerControl): Promise<boolean> {
  try {
    const response = await openCodeServerFetch(control, "/global/health", {}, opencodeServerControlHealthTimeoutMs);
    if (!response.ok) return false;
    const body = (await response.json()) as { healthy?: unknown };
    return body?.healthy === true;
  } catch {
    return false;
  }
}

interface OpenCodeProviderModel {
  id: string;
  providerID: string;
  name?: string;
  status?: string;
  enabled?: boolean;
}

interface OpenCodeModelCatalogPayload {
  data?: OpenCodeProviderModel[];
}

export async function fetchOpenCodeSessionModels(
  control: OpenCodeServerControl
): Promise<OpenCodeModelDescriptor[]> {
  const response = await openCodeServerFetch(control, "/api/model");
  if (!response.ok) {
    throw new Error(`OpenCode model catalog request failed with HTTP ${response.status}.`);
  }
  const payload = (await response.json()) as OpenCodeModelCatalogPayload;
  const models = Array.isArray(payload?.data) ? payload.data : [];
  const active = models.filter(
    (model) => typeof model?.id === "string" && model.id.length > 0 && model?.enabled !== false && model?.status === "active"
  );
  const usable = active.length > 0
    ? active
    : models.filter((model) => typeof model?.id === "string" && model.id.length > 0 && model?.enabled !== false && model?.status !== "deprecated");
  return usable.map((model) => ({
    providerId: typeof model.providerID === "string" && model.providerID.length > 0 ? model.providerID : "opencode",
    modelId: model.id,
    displayName: typeof model.name === "string" && model.name.length > 0 ? model.name : model.id
  }));
}

interface OpenCodeSessionModel {
  id: string;
  providerID: string;
  variant?: string | null;
}

interface OpenCodeSessionPayload {
  model?: OpenCodeSessionModel | null;
}

export async function fetchOpenCodeCurrentModel(
  control: OpenCodeServerControl,
  nativeSessionId: string
): Promise<OpenCodeSessionModel | null> {
  const response = await openCodeServerFetch(control, `/session/${encodeURIComponent(nativeSessionId)}`);
  if (!response.ok) return null;
  const session = (await response.json()) as OpenCodeSessionPayload;
  const model = session?.model;
  if (!model || typeof model.id !== "string" || model.id.length === 0) return null;
  return {
    id: model.id,
    providerID: typeof model.providerID === "string" && model.providerID.length > 0 ? model.providerID : "opencode",
    variant: typeof model.variant === "string" && model.variant.length > 0 ? model.variant : null
  };
}

type OpenCodeSessionStatus = { type: "idle" } | { type: "retry"; attempt: number } | { type: "busy" };

export async function fetchOpenCodeSessionIsTurnActive(
  control: OpenCodeServerControl,
  nativeSessionId: string
): Promise<boolean> {
  try {
    const response = await openCodeServerFetch(control, "/session/status");
    if (!response.ok) return false;
    const statuses = (await response.json()) as Record<string, OpenCodeSessionStatus>;
    const status = statuses?.[nativeSessionId];
    return status?.type === "busy" || status?.type === "retry";
  } catch {
    return false;
  }
}

export async function switchOpenCodeSessionModel(
  control: OpenCodeServerControl,
  nativeSessionId: string,
  providerId: string,
  modelId: string,
  variant?: string | null
): Promise<void> {
  const model: Record<string, string> = { id: modelId, providerID: providerId };
  if (typeof variant === "string" && variant.length > 0) {
    model.variant = variant;
  }
  const response = await openCodeServerFetch(control, `/api/session/${encodeURIComponent(nativeSessionId)}/model`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model })
  });
  if (!response.ok) {
    throw new Error(`OpenCode model switch failed with HTTP ${response.status}.`);
  }
}

export function parseOpenCodeCompositeModelId(compositeId: string): { providerId: string; modelId: string } | null {
  const separator = compositeId.indexOf("/");
  if (separator <= 0 || separator >= compositeId.length - 1) return null;
  const providerId = compositeId.slice(0, separator);
  const modelId = compositeId.slice(separator + 1);
  if (providerId.length === 0 || modelId.length === 0) return null;
  return { providerId, modelId };
}
