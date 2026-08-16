import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export const opencodeDirectParityRoot = "/var/lib/spaceapp-user/.codex/space-opencode";
export const opencodeNativeSessionIdPattern = /^ses_[A-Za-z0-9]+$/;

export const opencodeServerControlMaxBytes = 8_192;
export const opencodeServerControlRequestTimeoutMs = 8_000;
export const opencodeServerControlHealthTimeoutMs = 1_500;

/**
 * Static bridge address of the cli:opencode runtime netns, assigned by the
 * `runtimes` table in `/opt/spaceapp/bin/space-cli-vpn-broker`
 * (`{ id: "cli:opencode", key: "opencode", address: "10.254.240.13" }`).
 * The shared OpenCode server binds 0.0.0.0:47047 inside that netns, so the
 * Space API (root netns) can only reach it via this address — never via the
 * loopback hosts that fast-path wrapper control files write.
 */
export const openCodeSharedServerHost = "10.254.240.13";
export const openCodeSharedServerPort = 47047;

const openCodeLoopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);

export function isOpenCodeLoopbackHost(host: string | undefined): boolean {
  return typeof host === "string" && openCodeLoopbackHosts.has(host.trim().toLowerCase());
}

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
  variants: string[];
  defaultVariant: string | null;
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
    const rawServerHost = typeof control.serverHost === "string" && control.serverHost.length > 0
      ? control.serverHost
      : "127.0.0.1";
    // Fast-path wrapper control files write the loopback host, which is only
    // reachable from inside the runtime netns. The Space API runs in the root
    // netns and must use the runtime's static bridge address instead.
    const serverHost = isOpenCodeLoopbackHost(rawServerHost) ? openCodeSharedServerHost : rawServerHost;
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
  timeoutMs = opencodeServerControlRequestTimeoutMs,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  return fetchImpl(`${openCodeServerBaseUrl(control.serverPort, control.serverHost)}${path}`, {
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
  variants?: unknown;
  defaultVariant?: unknown;
}

interface OpenCodeModelCatalogPayload {
  data?: OpenCodeProviderModel[];
}

function parseOpenCodeModelVariants(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
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
    displayName: typeof model.name === "string" && model.name.length > 0 ? model.name : model.id,
    variants: parseOpenCodeModelVariants(model.variants),
    defaultVariant: typeof model.defaultVariant === "string" && model.defaultVariant.length > 0 ? model.defaultVariant : null
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

export interface OpenCodeSessionTitleInfo {
  title: string;
  updatedAt: number;
}

export async function fetchOpenCodeSessionTitle(
  control: OpenCodeServerControl,
  nativeSessionId: string
): Promise<OpenCodeSessionTitleInfo | null> {
  const response = await openCodeServerFetch(control, `/session/${encodeURIComponent(nativeSessionId)}`);
  if (!response.ok) return null;
  const session = (await response.json()) as { title?: unknown; time?: { updated?: unknown } };
  const title = typeof session.title === "string" && session.title.length > 0 ? session.title : null;
  const updatedAt = typeof session.time?.updated === "number" ? session.time.updated : 0;
  if (!title) return null;
  return { title, updatedAt };
}

export async function updateOpenCodeSessionTitle(
  control: OpenCodeServerControl,
  nativeSessionId: string,
  title: string
): Promise<void> {
  const response = await openCodeServerFetch(control, `/session/${encodeURIComponent(nativeSessionId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title })
  });
  if (!response.ok) {
    throw new Error(`OpenCode session title update failed with HTTP ${response.status}.`);
  }
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

export async function abortOpenCodeSession(
  control: OpenCodeServerControl,
  nativeSessionId: string
): Promise<boolean> {
  const response = await openCodeServerFetch(control, `/session/${encodeURIComponent(nativeSessionId)}/abort`, {
    method: "POST"
  });
  if (!response.ok) {
    throw new Error(`OpenCode session abort failed with HTTP ${response.status}.`);
  }
  return (await response.json()) === true;
}

export interface OpenCodeZeroTokenUnknownCompletion {
  id: string;
  sessionID: string;
  parentID: string;
  role: "assistant";
  finish: "unknown";
  time: { completed: number };
  tokens: {
    total?: number;
    input: 0;
    output: 0;
    reasoning: 0;
    cache: { read: 0; write: 0 };
  };
  error?: null;
}

function isZeroTokenCounter(value: unknown): value is 0 {
  return typeof value === "number" && Number.isFinite(value) && value === 0;
}

export function isOpenCodeZeroTokenUnknownCompletion(
  value: unknown
): value is OpenCodeZeroTokenUnknownCompletion {
  if (!value || typeof value !== "object") return false;
  const info = value as Record<string, unknown>;
  const time = info.time && typeof info.time === "object" ? info.time as Record<string, unknown> : null;
  const tokens = info.tokens && typeof info.tokens === "object" ? info.tokens as Record<string, unknown> : null;
  const cache = tokens?.cache && typeof tokens.cache === "object"
    ? tokens.cache as Record<string, unknown>
    : null;
  return (
    typeof info.id === "string" &&
    info.id.startsWith("msg") &&
    typeof info.sessionID === "string" &&
    opencodeNativeSessionIdPattern.test(info.sessionID) &&
    typeof info.parentID === "string" &&
    info.parentID.startsWith("msg") &&
    info.role === "assistant" &&
    info.finish === "unknown" &&
    info.error == null &&
    typeof time?.completed === "number" &&
    Number.isFinite(time.completed) &&
    time.completed > 0 &&
    isZeroTokenCounter(tokens?.input) &&
    isZeroTokenCounter(tokens?.output) &&
    isZeroTokenCounter(tokens?.reasoning) &&
    isZeroTokenCounter(cache?.read) &&
    isZeroTokenCounter(cache?.write) &&
    (tokens?.total === undefined || isZeroTokenCounter(tokens.total))
  );
}

interface OpenCodeMessageWithParts {
  info: Record<string, unknown>;
  parts: Array<Record<string, unknown>>;
}

export type OpenCodeSilentStopRecoveryOutcome =
  | "ignored"
  | "stale"
  | "recovered"
  | "exhausted"
  | "failed";

export interface OpenCodeSilentStopRecoveryResult {
  outcome: OpenCodeSilentStopRecoveryOutcome;
  sessionID?: string;
  messageID?: string;
  parentID?: string;
  detail?: string;
}

export interface OpenCodeSilentStopRecoveryOptions {
  control: OpenCodeServerControl;
  directory: string;
  maxRetriesPerTurn?: number;
  idlePollAttempts?: number;
  idlePollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  onNotice?: (message: string) => void;
}

function eventMessageInfo(event: unknown): unknown {
  if (!event || typeof event !== "object") return null;
  const outer = event as Record<string, unknown>;
  const payload = outer.payload && typeof outer.payload === "object"
    ? outer.payload as Record<string, unknown>
    : outer;
  if (payload.type !== "message.updated") return null;
  const properties = payload.properties && typeof payload.properties === "object"
    ? payload.properties as Record<string, unknown>
    : null;
  return properties?.info ?? null;
}

function recoveryQuery(directory: string): string {
  return `?directory=${encodeURIComponent(directory)}`;
}

function recoveryPartInput(part: Record<string, unknown>): Record<string, unknown> | null {
  if (!["text", "file", "agent", "subtask"].includes(String(part.type))) return null;
  const { sessionID: _sessionID, messageID: _messageID, ...input } = part;
  return input;
}

export class OpenCodeSilentStopRecovery {
  private readonly control: OpenCodeServerControl;
  private readonly directory: string;
  private readonly maxRetriesPerTurn: number;
  private readonly idlePollAttempts: number;
  private readonly idlePollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly onNotice: (message: string) => void;
  private readonly attemptsByParent = new Map<string, number>();
  private readonly handledMessages = new Set<string>();

  constructor(options: OpenCodeSilentStopRecoveryOptions) {
    this.control = options.control;
    this.directory = options.directory;
    this.maxRetriesPerTurn = Math.max(0, options.maxRetriesPerTurn ?? 1);
    this.idlePollAttempts = Math.max(1, options.idlePollAttempts ?? 40);
    this.idlePollIntervalMs = Math.max(0, options.idlePollIntervalMs ?? 50);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.onNotice = options.onNotice ?? (() => undefined);
  }

  async handleEvent(event: unknown): Promise<OpenCodeSilentStopRecoveryResult> {
    const candidate = eventMessageInfo(event);
    if (!isOpenCodeZeroTokenUnknownCompletion(candidate)) return { outcome: "ignored" };
    if (candidate.sessionID !== this.control.nativeSessionId) return { outcome: "ignored" };
    if (this.handledMessages.has(candidate.id)) return { outcome: "ignored" };
    this.handledMessages.add(candidate.id);
    this.trimTrackedState();

    const base = {
      sessionID: candidate.sessionID,
      messageID: candidate.id,
      parentID: candidate.parentID
    };
    try {
      if (!(await this.waitForIdle(candidate.sessionID))) {
        await this.publishFailureNotice(candidate, "the native session did not become idle");
        return { outcome: "failed", ...base, detail: "session remained busy" };
      }
      const latest = await this.fetchLatestMessage(candidate.sessionID);
      if (
        !latest ||
        latest.info.id !== candidate.id ||
        !isOpenCodeZeroTokenUnknownCompletion(latest.info) ||
        !latest.parts.every((part) => part.type === "step-start" || part.type === "step-finish")
      ) {
        return { outcome: "stale", ...base };
      }

      const attempts = this.attemptsByParent.get(candidate.parentID) ?? 0;
      if (attempts >= this.maxRetriesPerTurn) {
        await this.publishFailureNotice(candidate, "the single automatic retry also returned an empty completion");
        return { outcome: "exhausted", ...base };
      }

      const parent = await this.fetchMessage(candidate.sessionID, candidate.parentID);
      const prompt = this.sameTurnPrompt(parent, candidate);
      this.attemptsByParent.set(candidate.parentID, attempts + 1);
      await this.deleteMessage(candidate.sessionID, candidate.id);
      await this.resumeSameTurn(candidate.sessionID, prompt);
      this.onNotice(`Recovered OpenCode turn ${candidate.parentID} after an empty provider completion.`);
      return { outcome: "recovered", ...base };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const noticePublished = await this.publishFailureNotice(candidate, detail).then(
        () => true,
        () => false
      );
      if (!noticePublished) this.onNotice(`OpenCode automatic recovery failed: ${detail}`);
      return { outcome: "failed", ...base, detail };
    }
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    return openCodeServerFetch(
      this.control,
      path,
      init,
      opencodeServerControlRequestTimeoutMs,
      this.fetchImpl
    );
  }

  private async waitForIdle(sessionID: string): Promise<boolean> {
    for (let attempt = 0; attempt < this.idlePollAttempts; attempt += 1) {
      const response = await this.request("/session/status");
      if (!response.ok) throw new Error(`OpenCode session status failed with HTTP ${response.status}.`);
      const statuses = await response.json() as Record<string, OpenCodeSessionStatus>;
      const status = statuses?.[sessionID];
      if (!status || status.type === "idle") return true;
      if (attempt + 1 < this.idlePollAttempts) await this.sleep(this.idlePollIntervalMs);
    }
    return false;
  }

  private async fetchLatestMessage(sessionID: string): Promise<OpenCodeMessageWithParts | null> {
    const response = await this.request(
      `/session/${encodeURIComponent(sessionID)}/message${recoveryQuery(this.directory)}&limit=1`
    );
    if (!response.ok) throw new Error(`OpenCode latest-message lookup failed with HTTP ${response.status}.`);
    const messages = await response.json() as unknown;
    if (!Array.isArray(messages) || messages.length === 0) return null;
    return this.parseMessage(messages.at(-1));
  }

  private async fetchMessage(sessionID: string, messageID: string): Promise<OpenCodeMessageWithParts | null> {
    const response = await this.request(
      `/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(messageID)}${recoveryQuery(this.directory)}`
    );
    if (!response.ok) return null;
    return this.parseMessage(await response.json());
  }

  private parseMessage(value: unknown): OpenCodeMessageWithParts | null {
    if (!value || typeof value !== "object") return null;
    const message = value as Record<string, unknown>;
    if (!message.info || typeof message.info !== "object" || !Array.isArray(message.parts)) return null;
    const parts = message.parts.filter(
      (part): part is Record<string, unknown> => Boolean(part && typeof part === "object")
    );
    if (parts.length !== message.parts.length) return null;
    return { info: message.info as Record<string, unknown>, parts };
  }

  private sameTurnPrompt(
    parent: OpenCodeMessageWithParts | null,
    candidate: OpenCodeZeroTokenUnknownCompletion
  ): Record<string, unknown> {
    if (!parent || parent.info.id !== candidate.parentID || parent.info.role !== "user") {
      throw new Error("OpenCode recovery could not verify the parent user message.");
    }
    const model = parent.info.model;
    if (!model || typeof model !== "object") {
      throw new Error("OpenCode recovery could not verify the parent message model.");
    }
    const rawModel = model as Record<string, unknown>;
    if (typeof rawModel.providerID !== "string" || typeof rawModel.modelID !== "string") {
      throw new Error("OpenCode recovery found an invalid parent message model.");
    }
    if (typeof parent.info.agent !== "string" || parent.info.agent.length === 0) {
      throw new Error("OpenCode recovery found an invalid parent message agent.");
    }
    const parts = parent.parts.map(recoveryPartInput);
    if (parts.some((part) => part === null)) {
      throw new Error("OpenCode recovery found an unsupported parent message part.");
    }
    const prompt: Record<string, unknown> = {
      messageID: candidate.parentID,
      model: { providerID: rawModel.providerID, modelID: rawModel.modelID },
      agent: parent.info.agent,
      parts
    };
    for (const field of ["format", "system", "tools"] as const) {
      if (parent.info[field] !== undefined) prompt[field] = parent.info[field];
    }
    if (typeof rawModel.variant === "string" && rawModel.variant.length > 0) {
      prompt.variant = rawModel.variant;
    }
    return prompt;
  }

  private async deleteMessage(sessionID: string, messageID: string): Promise<void> {
    const response = await this.request(
      `/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(messageID)}${recoveryQuery(this.directory)}`,
      { method: "DELETE" }
    );
    if (!response.ok || (await response.json()) !== true) {
      throw new Error(`OpenCode empty-message removal failed with HTTP ${response.status}.`);
    }
  }

  private async resumeSameTurn(sessionID: string, prompt: Record<string, unknown>): Promise<void> {
    const response = await this.request(
      `/session/${encodeURIComponent(sessionID)}/prompt_async${recoveryQuery(this.directory)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(prompt)
      }
    );
    if (!response.ok) {
      throw new Error(`OpenCode same-turn resume failed with HTTP ${response.status}.`);
    }
  }

  private async publishFailureNotice(
    candidate: OpenCodeZeroTokenUnknownCompletion,
    reason: string
  ): Promise<void> {
    const partID = `prt_space_recovery_${candidate.id.replace(/[^A-Za-z0-9]/g, "").slice(-24)}`;
    const text = `[Space recovery] OpenCode returned an empty completion. Automatic recovery stopped: ${reason}. Send “continue” to resume this turn.`;
    const response = await this.request(
      `/session/${encodeURIComponent(candidate.sessionID)}/message/${encodeURIComponent(candidate.id)}/part/${encodeURIComponent(partID)}${recoveryQuery(this.directory)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: partID,
          sessionID: candidate.sessionID,
          messageID: candidate.id,
          type: "text",
          text
        })
      }
    );
    if (!response.ok) {
      throw new Error(`OpenCode recovery notice failed with HTTP ${response.status}.`);
    }
  }

  private trimTrackedState(): void {
    while (this.handledMessages.size > 128) {
      const oldest = this.handledMessages.values().next().value as string | undefined;
      if (!oldest) break;
      this.handledMessages.delete(oldest);
    }
    while (this.attemptsByParent.size > 64) {
      const oldest = this.attemptsByParent.keys().next().value as string | undefined;
      if (!oldest) break;
      this.attemptsByParent.delete(oldest);
    }
  }
}

export async function switchOpenCodeSessionModel(
  control: OpenCodeServerControl,
  nativeSessionId: string,
  providerId: string,
  modelId: string,
  variant?: string | null,
  advertisedVariants?: readonly string[] | null
): Promise<void> {
  const model: Record<string, string> = { id: modelId, providerID: providerId };
  const namedVariant = typeof variant === "string" && variant.length > 0 ? variant : null;
  if (namedVariant !== null && (advertisedVariants ?? []).includes(namedVariant)) {
    model.variant = namedVariant;
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

export async function listOpenCodeServerControls(stateRoot?: string): Promise<OpenCodeServerControl[]> {
  const directory = join(stateRoot ?? opencodeDirectParityRoot, "opencode", "space-cli-control");
  let entries;
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }
  const controls: OpenCodeServerControl[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(directory, entry), "utf8"));
    } catch {
      continue;
    }
    const spaceSessionId = typeof raw === "object" && raw !== null && typeof (raw as { spaceSessionId?: unknown }).spaceSessionId === "string"
      ? (raw as { spaceSessionId: string }).spaceSessionId
      : "";
    if (!spaceSessionId) continue;
    const control = await readOpenCodeServerControl(spaceSessionId, stateRoot);
    if (control) controls.push(control);
  }
  return controls.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

export async function resolveLatestOpenCodeControl(stateRoot?: string): Promise<OpenCodeServerControl | null> {
  const controls = await listOpenCodeServerControls(stateRoot);
  return controls[0] ?? null;
}

/**
 * Resolves an OpenCode server control usable for pane-title generation from
 * the Space API (root netns), in priority order:
 *  1. the most recently updated live control of any OpenCode pane; or
 *  2. a control built from the shared OpenCode server env file
 *     (`<stateRoot>/opencode/space-shared-server.env`), which holds the
 *     server credentials the fast-path wrapper writes into per-pane controls.
 * The returned control may reference a native session that is not the
 * caller's — callers must not use its `nativeSessionId` for context.
 */
export async function resolveOpenCodeTitleFallbackControl(
  stateRoot?: string
): Promise<OpenCodeServerControl | null> {
  const resolvedStateRoot = stateRoot ?? join(opencodeDirectParityRoot, "state");
  const controls = await listOpenCodeServerControls(resolvedStateRoot);
  for (const control of controls) {
    if (control.serverUsername && control.serverPassword) return control;
  }
  const sharedEnvPath = join(resolvedStateRoot, "opencode", "space-shared-server.env");
  let username = "";
  let password = "";
  try {
    const text = await readFile(sharedEnvPath, "utf8");
    for (const line of text.split("\n")) {
      const match = /^(OPENCODE_SERVER_USERNAME|OPENCODE_SERVER_PASSWORD)=(.*)$/.exec(line.trim());
      if (!match) continue;
      if (match[1] === "OPENCODE_SERVER_USERNAME") username = match[2]?.trim() ?? "";
      else password = match[2]?.trim() ?? "";
    }
  } catch {
    return null;
  }
  if (!username || !password) return null;
  return {
    version: 1,
    spaceSessionId: "space-shared",
    nativeSessionId: "",
    serverPort: openCodeSharedServerPort,
    serverHost: openCodeSharedServerHost,
    serverUsername: username,
    serverPassword: password,
    updatedAt: new Date(0).toISOString()
  };
}
