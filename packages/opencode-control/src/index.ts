import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export const opencodeDirectParityRoot = "/var/lib/spaceapp-user/.codex/space-opencode";
export const openCodeSpaceChatStateRoot = "/opt/spaceapp/var/opencode-chat-state";
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
  directory?: string;
  updatedAt: string;
}

export interface OpenCodeModelDescriptor {
  providerId: string;
  providerName?: string;
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
    // netns and must use the runtime's static bridge address instead, unless
    // the launcher recorded that its server runs in the host network.
    const serverHost = isOpenCodeLoopbackHost(rawServerHost) && control.serverNetwork !== "host"
      ? openCodeSharedServerHost
      : rawServerHost;
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
    const directory = typeof control.directory === "string" && control.directory.trim().length > 0
      ? control.directory.trim()
      : undefined;
    return {
      version: 1,
      spaceSessionId,
      nativeSessionId,
      serverPort,
      serverHost,
      serverUsername,
      serverPassword,
      directory,
      updatedAt: typeof control.updatedAt === "string" ? control.updatedAt : new Date(0).toISOString()
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    if (error && typeof error === "object" && "code" in error && error.code === "EACCES") return null;
    return null;
  }
}

export function opencodeServerMappingPath(
  spaceSessionId: string,
  stateRoot = join(opencodeDirectParityRoot, "state")
): string {
  return join(stateRoot, "opencode", "space-cli-sessions", `${safeSpaceSessionFileName(spaceSessionId)}.json`);
}

export async function readOpenCodeServerControlFromMapping(
  spaceSessionId: string,
  stateRoot?: string
): Promise<OpenCodeServerControl | null> {
  const resolvedStateRoot = stateRoot ?? join(opencodeDirectParityRoot, "state");
  const mappingPath = opencodeServerMappingPath(spaceSessionId, resolvedStateRoot);
  try {
    const metadata = await stat(mappingPath);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > opencodeServerControlMaxBytes) return null;
    const parsed = JSON.parse(await readFile(mappingPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const mapping = parsed as Record<string, unknown>;
    const nativeSessionId = typeof mapping.nativeSessionId === "string" ? mapping.nativeSessionId : "";
    if (!opencodeNativeSessionIdPattern.test(nativeSessionId)) return null;

    const fallback = await resolveOpenCodeTitleFallbackControl(resolvedStateRoot);
    if (!fallback) return null;

    return {
      ...fallback,
      spaceSessionId,
      nativeSessionId,
      updatedAt: typeof mapping.updatedAt === "string" ? mapping.updatedAt : fallback.updatedAt
    };
  } catch {
    return null;
  }
}

export function openCodeServerBaseUrl(port: number, host = "127.0.0.1"): string {
  return `http://${host}:${port}`;
}

// OpenCode 2 (@opencode/cli) serves its API under /api and accepts only this Basic auth user name. OpenCode 1 and its
// v1 REST API were retired (operator decision 2026-10-18, plan clipboard:kJ1BIeylJRLG).
const openCodeV2Username = "opencode";

export function openCodeV2Authorization(control: OpenCodeServerControl): string {
  return `Basic ${Buffer.from(`${openCodeV2Username}:${control.serverPassword}`).toString("base64")}`;
}

async function openCodeV2Fetch(
  control: OpenCodeServerControl,
  path: string,
  init: RequestInit = {},
  timeoutMs = opencodeServerControlRequestTimeoutMs
): Promise<Response> {
  return fetch(`${openCodeServerBaseUrl(control.serverPort, control.serverHost)}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: openCodeV2Authorization(control) },
    signal: init.signal ?? AbortSignal.timeout(timeoutMs)
  });
}

function openCodeLocationQuery(directory: string): string {
  return `location%5Bdirectory%5D=${encodeURIComponent(directory)}`;
}

type JsonRecord = Record<string, unknown>;
const jsonRecord = (value: unknown): JsonRecord => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};

/** OpenCode 2 messages (oldest first) in the v1 {info, parts} shape Space reads; an answer's parentID is the user turn before it. */
export function openCodeV2MessagesAsV1(messages: unknown[]): Array<{ info: JsonRecord; parts: JsonRecord[] }> {
  const result: Array<{ info: JsonRecord; parts: JsonRecord[] }> = [];
  let parentID: unknown;
  for (const message of messages.map(jsonRecord)) {
    const time = jsonRecord(message.time);
    if (message.type === "user") {
      parentID = message.id;
      const files = Array.isArray(message.files) ? message.files.map(jsonRecord) : [];
      result.push({ info: { id: message.id, role: "user", time: { created: time.created } },
        parts: [{ type: "text", text: message.text ?? "" }, ...files.map((file) => ({ type: "file", url: file.uri }))] });
    } else if (message.type === "assistant") {
      const model = jsonRecord(message.model), error = jsonRecord(message.error);
      result.push({
        info: { id: message.id, role: "assistant", parentID, time: { created: time.created, completed: time.completed },
          modelID: model.id, providerID: model.providerID, variant: model.variant, mode: message.agent, finish: message.finish,
          cost: message.cost, tokens: message.tokens,
          ...(message.error ? { error: { name: error.type === "aborted" ? "MessageAbortedError" : String(error.type ?? "Error"), data: { message: error.message } } } : {}) },
        parts: (Array.isArray(message.content) ? message.content : []).map(jsonRecord).map((content) => content.type === "tool"
          ? { type: "tool", tool: content.name, callID: content.id, state: content.state }
          : { type: content.type, text: content.text })
      });
    }
  }
  return result;
}

/** The session's last `limit` messages, oldest first, in the {info, parts} shape Space reads. */
export async function fetchOpenCodeSessionMessages(
  control: OpenCodeServerControl,
  nativeSessionId: string,
  limit: number
): Promise<unknown[]> {
  const response = await openCodeV2Fetch(control, `/api/session/${encodeURIComponent(nativeSessionId)}/message?limit=${limit}&order=desc`);
  if (!response.ok) throw new Error(`OpenCode message list failed with HTTP ${response.status}.`);
  const data = jsonRecord(await response.json()).data;
  return openCodeV2MessagesAsV1(Array.isArray(data) ? [...data].reverse() : []);
}

/** Queues a user prompt without waiting for the turn; false when the server refused it. */
export async function sendOpenCodePrompt(control: OpenCodeServerControl, nativeSessionId: string, text: string): Promise<boolean> {
  const response = await openCodeV2Fetch(control, `/api/session/${encodeURIComponent(nativeSessionId)}/prompt`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  return response.ok;
}

/** Names of the visible primary agents (modes) the session can switch between. */
export async function fetchOpenCodeAgentNames(control: OpenCodeServerControl, directory = control.directory ?? "/etc"): Promise<string[]> {
  const response = await openCodeV2Fetch(control, `/api/agent?${openCodeLocationQuery(directory)}`);
  if (!response.ok) return [];
  // OpenCode 2 names agents for display ("Build"); its id is the mode ("build").
  const agents = jsonRecord(await response.json().catch(() => null)).data as Array<{ id?: string; name?: string; mode?: string; hidden?: boolean }> | undefined;
  return Array.isArray(agents)
    ? agents.flatMap((agent) => !agent.hidden && agent.mode !== "subagent" && (agent.id ?? agent.name) ? [(agent.id ?? agent.name)!] : [])
    : [];
}

export async function openCodeServerIsHealthy(control: OpenCodeServerControl): Promise<boolean> {
  try {
    return (await openCodeV2Fetch(control, "/api/info", {}, opencodeServerControlHealthTimeoutMs)).ok;
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
  request?: { variant?: unknown };
}

interface OpenCodeModelCatalogPayload {
  data?: OpenCodeProviderModel[];
}

function parseOpenCodeModelVariants(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.flatMap((entry) => {
    const id = typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? entry.id : null;
    return typeof id === 'string' && id.length > 0 ? [id] : [];
  }))];
}

export async function fetchOpenCodeSessionModels(
  control: OpenCodeServerControl,
  directory = '/etc'
): Promise<OpenCodeModelDescriptor[]> {

  const response = await openCodeV2Fetch(control, `/api/model?${openCodeLocationQuery(directory)}`);
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
    defaultVariant: typeof model.defaultVariant === "string" && model.defaultVariant.length > 0 ? model.defaultVariant
      : typeof model.request?.variant === 'string' && model.request.variant.length > 0 ? model.request.variant : null
  }));
}

interface OpenCodeSessionModel {
  id: string;
  providerID: string;
  variant?: string | null;
}

interface OpenCodeSessionPayload {
  data?: { model?: OpenCodeSessionModel | null };
}

export async function fetchOpenCodeCurrentModel(
  control: OpenCodeServerControl,
  nativeSessionId: string
): Promise<OpenCodeSessionModel | null> {
  const response = await openCodeV2Fetch(control, `/api/session/${encodeURIComponent(nativeSessionId)}`);
  if (!response.ok) return null;
  const model = ((await response.json()) as OpenCodeSessionPayload)?.data?.model;
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
  const response = await openCodeV2Fetch(control, `/api/session/${encodeURIComponent(nativeSessionId)}`);
  if (!response.ok) return null;
  const session = jsonRecord(jsonRecord(await response.json()).data) as { title?: unknown; time?: { updated?: unknown } };
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
  const response = await openCodeV2Fetch(control, `/api/session/${encodeURIComponent(nativeSessionId)}`,
    { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
  if (!response.ok) {
    throw new Error(`OpenCode session title update failed with HTTP ${response.status}.`);
  }
}

/**
 * true while a turn runs, false when idle, null when the server gave no status. Callers that start work
 * (prompt injection, model switch, worker turns) must treat null as busy.
 */
export async function readOpenCodeSessionTurnActive(
  control: OpenCodeServerControl,
  nativeSessionId: string,
  _directory?: string
): Promise<boolean | null> {
  try {
    // OpenCode 2 lists only the sessions that are running.
    const response = await openCodeV2Fetch(control, "/api/session/active");
    if (!response.ok) return null;
    return Object.hasOwn(jsonRecord(jsonRecord(await response.json()).data), nativeSessionId);
  } catch {
    return null;
  }
}

/** Display-only busy flag: an unknown state reads as idle. Guards use readOpenCodeSessionTurnActive. */
export async function fetchOpenCodeSessionIsTurnActive(
  control: OpenCodeServerControl,
  nativeSessionId: string,
  directory?: string
): Promise<boolean> {
  return (await readOpenCodeSessionTurnActive(control, nativeSessionId, directory)) === true;
}

export async function abortOpenCodeSession(
  control: OpenCodeServerControl,
  nativeSessionId: string
): Promise<boolean> {
  const response = await openCodeV2Fetch(control, `/api/session/${encodeURIComponent(nativeSessionId)}/interrupt`, { method: "POST" });
  if (!response.ok) {
    throw new Error(`OpenCode session abort failed with HTTP ${response.status}.`);
  }
  return jsonRecord(await response.json()).interrupted === true;
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
  // The server accepts the pseudo-effort "default" as an explicit variant and
  // round-trips it; omitting it instead would keep a stale variant, making a
  // requested Default unsatisfiable once any variant was set.
  if (namedVariant !== null && (namedVariant === "default" || (advertisedVariants ?? []).includes(namedVariant))) {
    model.variant = namedVariant;
  }
  const path = `/api/session/${encodeURIComponent(nativeSessionId)}/model`;
  const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) };
  const response = await openCodeV2Fetch(control, path, init);
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


/**
 * Creates a new OpenCode session on the shared server. Returns the native
 * session id (ses_...) or null when the server rejects the request.
 */
export async function createOpenCodeSession(
  control: OpenCodeServerControl,
  title: string,
  directory = "/etc"
): Promise<string | null> {
  try {
    const response = await openCodeV2Fetch(control, "/api/session",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, location: { directory } }) }, 15_000);
    if (!response.ok) return null;
    const id = jsonRecord(((await response.json()) as { data?: unknown }).data).id;
    if (typeof id !== "string" || id.length === 0) return null;
    await waitForOpenCodeV2Mcp(control, directory);
    return id;
  } catch {
    return null;
  }
}

/**
 * OpenCode 2 connects a directory's MCP servers on first use, and a prompt sent before they connect runs without
 * their tools (2.0.32). A TUI starts them when it opens; a session that only the API prompts waits here instead.
 */
async function waitForOpenCodeV2Mcp(control: OpenCodeServerControl, directory: string): Promise<void> {
  // shortcut: a server with no MCP servers configured waits the whole 5 s once per new session; read /api/config if
  // such servers become common.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await openCodeV2Fetch(control, `/api/mcp?${openCodeLocationQuery(directory)}`);
      if (!response.ok) return;
      const servers = jsonRecord(await response.json()).data;
      if (Array.isArray(servers) && servers.length > 0
        && servers.every((server) => jsonRecord(jsonRecord(server).status).status !== "pending")) return;
    } catch {
      return; // Best effort: the session exists, and a later prompt gets the tools.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Returns true when the OpenCode server still knows this native session.
 */
export async function openCodeSessionExists(
  control: OpenCodeServerControl,
  nativeSessionId: string
): Promise<boolean> {
  if (!nativeSessionId) return false;
  try {
    return (await openCodeV2Fetch(control, `/api/session/${encodeURIComponent(nativeSessionId)}`, {}, opencodeServerControlHealthTimeoutMs)).ok;
  } catch {
    return false;
  }
}

export function openCodeSpaceChatControlPath(): string {
  return "/opt/spaceapp/var/opencode-space-chat-control.json";
}

/**
 * Reads the Space-chat OpenCode control written by the API next to its own
 * state root (usable without an active OpenCode CLI pane).
 */
export async function readOpenCodeSpaceChatControl(): Promise<OpenCodeServerControl | null> {
  const path = openCodeSpaceChatControlPath();
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
      : openCodeSharedServerHost;
    if (
      control.version !== 1 ||
      control.spaceSessionId !== "space-chat" ||
      !opencodeNativeSessionIdPattern.test(nativeSessionId) ||
      !(Number.isSafeInteger(serverPort) && serverPort > 0 && serverPort < 65_536) ||
      serverUsername.length === 0 ||
      serverPassword.length === 0
    ) {
      return null;
    }
    return {
      version: 1,
      spaceSessionId: "space-chat",
      nativeSessionId,
      serverPort,
      serverHost: isOpenCodeLoopbackHost(rawServerHost) ? openCodeSharedServerHost : rawServerHost,
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
