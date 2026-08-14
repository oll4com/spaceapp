import { mkdir, readdir, readFile, rename, writeFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  agentToolAssignmentSchema,
  agentToolsCatalogResponseSchema,
  type AgentToolApplyFile,
  type AgentToolApplyRuntimeResult,
  type AgentToolAssignment,
  type AgentToolCatalogEntry,
  type AgentToolEffectiveState,
  type AgentToolMcpDefinition,
  type AgentToolRuntimeCatalogInfo,
  type AgentToolsCatalogResponse,
  type ApplyAgentToolsResult
} from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import { cliRuntimeDescriptors } from "./cli-runtime-descriptors.js";

export interface AgentToolsOptions {
  baseRoot?: string;
  configHome?: string;
  skillsRoot?: string;
  canonicalRoot?: string;
  rootWriterCommand?: string | null;
}

const defaultOptions: Required<Pick<AgentToolsOptions, "baseRoot" | "configHome" | "skillsRoot" | "canonicalRoot">> = {
  baseRoot: "/var/lib/spaceapp-user",
  configHome: "/var/lib/spaceapp-user/.config/opencode",
  skillsRoot: "/var/lib/spaceapp-user/.codex/skills",
  canonicalRoot: "/opt/spaceapp/bin"
};

type EffectiveAgentToolsOptions = Required<
  Pick<AgentToolsOptions, "baseRoot" | "configHome" | "skillsRoot" | "canonicalRoot">
> & { rootWriterCommand: string | null };

function effectiveOptions(options: AgentToolsOptions = {}): EffectiveAgentToolsOptions {
  return { ...defaultOptions, ...options, rootWriterCommand: options.rootWriterCommand ?? null };
}

interface CanonicalSourceDescriptor {
  fileName: string;
  format: "object" | "array" | "toml";
  keyPath: string;
}

const CANONICAL_SOURCES: Record<string, CanonicalSourceDescriptor> = {
  "cli:claude": { fileName: "claude-legacy-space-mcp.json", format: "object", keyPath: "mcpServers" },
  "cli:opencode": { fileName: "opencode-space.json", format: "object", keyPath: "mcp" },
  "cli:autohand": { fileName: "autohand-space-mcp.json", format: "array", keyPath: "servers" },
  "cli:grok": { fileName: "grok-space-config.toml", format: "toml", keyPath: "" },
  "cli:kimi": { fileName: "kimi-space-mcp.json", format: "object", keyPath: "mcpServers" }
};

interface ResolvedRuntimeLayout {
  runtimeId: string;
  displayName: string;
  readOnly: boolean;
  reason: string | null;
  mcpConfigPath: string | null;
  mcpFormat: "object" | "array" | "toml" | "unsupported";
  skillsConfigPath: string | null;
  skillsFormat: "codex-toml" | "opencode-permission" | "unsupported";
}

function stateRootFor(runtimeId: string, options: AgentToolsOptions): string {
  const baseRoot = options.baseRoot ?? defaultOptions.baseRoot;
  const descriptor = cliRuntimeDescriptors.find((candidate) => candidate.id === runtimeId);
  if (!descriptor) return `${baseRoot}/.codex/${runtimeId.replace("cli:", "")}`;
  const relative = descriptor.stateRoot.replace(/^\/home\/spaceapp-user/, "");
  return `${baseRoot}${relative}`;
}

function resolveRuntimeLayout(runtimeId: string, options: AgentToolsOptions): ResolvedRuntimeLayout {
  const descriptor = cliRuntimeDescriptors.find((candidate) => candidate.id === runtimeId);
  const stateRoot = stateRootFor(runtimeId, options);
  const configHome = options.configHome ?? defaultOptions.configHome;
  const displayName = descriptor?.agentName ?? runtimeId;

  let mcpConfigPath: string | null = null;
  let mcpFormat: ResolvedRuntimeLayout["mcpFormat"] = "unsupported";
  let skillsConfigPath: string | null = null;
  let skillsFormat: ResolvedRuntimeLayout["skillsFormat"] = "unsupported";

  switch (runtimeId) {
    case "cli:codex":
      mcpConfigPath = `${stateRoot}/config.toml`;
      mcpFormat = "toml";
      skillsConfigPath = `${stateRoot}/config.toml`;
      skillsFormat = "codex-toml";
      break;
    case "cli:claude":
      mcpConfigPath = `${stateRoot}/settings.json`;
      mcpFormat = "object";
      break;
    case "cli:opencode":
      mcpConfigPath = `${configHome}/opencode.json`;
      mcpFormat = "object";
      skillsFormat = "opencode-permission";
      break;
    case "cli:autohand":
      mcpConfigPath = `${stateRoot}/config.json`;
      mcpFormat = "array";
      break;
    case "cli:qwen":
      mcpConfigPath = `${stateRoot}/settings.json`;
      mcpFormat = "object";
      break;
    case "cli:kimi":
      mcpConfigPath = `${stateRoot}/mcp.json`;
      mcpFormat = "object";
      break;
    case "cli:grok":
      mcpConfigPath = `${stateRoot}/config.toml`;
      mcpFormat = "toml";
      break;
    case "cli:copilot":
      mcpConfigPath = `${stateRoot}/mcp-config.json`;
      mcpFormat = "object";
      break;
    default:
      break;
  }

  const readOnly = mcpConfigPath === null && skillsConfigPath === null;
  const reason = readOnly ? "No managed config file is available for this CLI runtime." : null;

  return { runtimeId, displayName, readOnly, reason, mcpConfigPath, mcpFormat, skillsConfigPath, skillsFormat };
}

interface McpReadSource {
  path: string;
  format: "object" | "array" | "toml";
  keyPath: string;
}

async function isReadableFile(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveMcpReadSource(runtime: ResolvedRuntimeLayout, options: EffectiveAgentToolsOptions): Promise<McpReadSource | null> {
  if (!runtime.mcpConfigPath) return null;
  const primary: McpReadSource = {
    path: runtime.mcpConfigPath,
    format: runtime.mcpFormat === "array" ? "array" : runtime.mcpFormat === "toml" ? "toml" : "object",
    keyPath: runtime.mcpFormat === "array" ? "mcp.servers" : mcpObjectKey(runtime.runtimeId)
  };
  if (await isReadableFile(runtime.mcpConfigPath)) return primary;

  const canonical = CANONICAL_SOURCES[runtime.runtimeId];
  if (canonical && options.canonicalRoot) {
    const canonicalPath = join(options.canonicalRoot, canonical.fileName);
    if (await isReadableFile(canonicalPath)) {
      return { path: canonicalPath, format: canonical.format, keyPath: canonical.keyPath };
    }
  }
  return primary;
}

export interface DiscoveredMcpServer {
  name: string;
  definition: AgentToolMcpDefinition;
}

export interface DiscoveredSkill {
  name: string;
  path: string;
  enabled: boolean;
}

export interface DiscoveredRuntimeTools {
  runtimeId: string;
  mcpServers: DiscoveredMcpServer[];
  skillEntries: DiscoveredSkill[];
  skillPaths: string[];
}

export interface DiscoveredState {
  layout: ResolvedRuntimeLayout[];
  tools: DiscoveredRuntimeTools[];
  assignments: AgentToolAssignment[];
}

const tomlSectionHeader = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/;
const tomlArrayHeader = /^\s*\[\[\s*([^\]]+?)\s*\]\]\s*(?:#.*)?$/;

function parseTomlString(value: string): string | null {
  const match = value.trim().match(/^"(.*)"$/s);
  return match ? (match[1] ?? "").replace(/\\"/g, '"').replace(/\\\\/g, "\\") : null;
}

function parseTomlStringArray(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  const values: string[] = [];
  for (const match of trimmed.slice(1, -1).matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    values.push((match[1] ?? "").replace(/\\"/g, '"'));
  }
  return values;
}

function parseTomlInlineEnv(value: string): Record<string, string> | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  const env: Record<string, string> = {};
  for (const match of trimmed.slice(1, -1).matchAll(/([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/g)) {
    const key = match[1];
    const valueEntry = match[2];
    if (key) env[key] = valueEntry ?? "";
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

export function parseTomlMcpServers(raw: string): Map<string, AgentToolMcpDefinition> {
  const servers = new Map<string, AgentToolMcpDefinition>();
  const lines = raw.split(/\r?\n/);
  let current: { name: string; command: string | null; args: string[]; url: string | null; env: Record<string, string> } | null = null;

  const flush = () => {
    if (!current) return;
    const env = Object.keys(current.env).length > 0 ? current.env : undefined;
    servers.set(
      current.name,
      current.url
        ? { transport: "http", command: null, args: undefined, url: current.url, env }
        : { transport: "stdio", command: current.command, args: current.args.length > 0 ? current.args : undefined, url: null, env }
    );
    current = null;
  };

  for (const line of lines) {
    const header = line.match(tomlSectionHeader);
    if (header) {
      flush();
      const name = (header[1] ?? "").trim();
      if (!name.startsWith("mcp_servers.")) continue;
      const serverName = name.slice("mcp_servers.".length).replace(/^"|"$/g, "");
      if (serverName.length > 0 && !serverName.includes(".")) {
        current = { name: serverName, command: null, args: [], url: null, env: {} };
      }
      continue;
    }
    if (!current) continue;
    const commandMatch = line.match(/^\s*command\s*=\s*(.+)$/);
    const urlMatch = line.match(/^\s*url\s*=\s*(.+)$/);
    const argsMatch = line.match(/^\s*args\s*=\s*(.+)$/);
    const envMatch = line.match(/^\s*env\s*=\s*(.+)$/);
    if (commandMatch) current.command = parseTomlString(commandMatch[1] ?? "");
    else if (urlMatch) current.url = parseTomlString(urlMatch[1] ?? "");
    else if (argsMatch) current.args = parseTomlStringArray(argsMatch[1] ?? "");
    else if (envMatch) {
      const envLine = envMatch[1] ?? "";
      if (envLine.trim().startsWith("{")) {
        const env = parseTomlInlineEnv(envLine);
        if (env) Object.assign(current.env, env);
      } else {
        const key = envLine.split("=")[0]?.trim() ?? "";
        const value = parseTomlString(envLine);
        if (key && value) current.env[key] = value;
      }
    }
  }
  flush();
  return servers;
}

export interface TomlSkillEntry {
  path: string;
  enabled: boolean;
}

export function parseTomlSkills(raw: string): TomlSkillEntry[] {
  const entries: TomlSkillEntry[] = [];
  const lines = raw.split(/\r?\n/);
  let inSkillBlock = false;
  let current: TomlSkillEntry | null = null;

  const flush = () => {
    if (current) {
      entries.push(current);
      current = null;
    }
    inSkillBlock = false;
  };

  for (const line of lines) {
    const arrayHeader = line.match(tomlArrayHeader);
    if (arrayHeader) {
      flush();
      if ((arrayHeader[1] ?? "").trim() === "skills.config") {
        inSkillBlock = true;
        current = { path: "", enabled: true };
      }
      continue;
    }
    if (line.match(tomlSectionHeader)) {
      flush();
      continue;
    }
    if (!inSkillBlock || !current) continue;
    const pathMatch = line.match(/^\s*path\s*=\s*(.+)$/);
    const enabledMatch = line.match(/^\s*enabled\s*=\s*(true|false)\s*$/i);
    if (pathMatch) current.path = parseTomlString(pathMatch[1] ?? "") ?? "";
    else if (enabledMatch) current.enabled = (enabledMatch[1] ?? "true").toLowerCase() === "true";
  }
  flush();
  return entries.filter((entry) => entry.path.length > 0);
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value);
}

function renderTomlMcpSection(name: string, definition: AgentToolMcpDefinition): string[] {
  const lines = [`[mcp_servers.${tomlKey(name)}]`];
  if (definition.transport === "http") {
    lines.push(`url = ${tomlString(definition.url ?? "")}`);
  } else {
    lines.push(`command = ${tomlString(definition.command ?? "")}`);
    if (definition.args && definition.args.length > 0) {
      lines.push(`args = [${definition.args.map(tomlString).join(", ")}]`);
    }
    if (definition.env && Object.keys(definition.env).length > 0) {
      lines.push(
        `env = { ${Object.entries(definition.env)
          .map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`)
          .join(", ")} }`
      );
    }
  }
  return lines;
}

function renderTomlSkillBlock(path: string, enabled: boolean): string[] {
  return enabled ? [`[[skills.config]]`, `path = ${tomlString(path)}`] : [`[[skills.config]]`, `path = ${tomlString(path)}`, `enabled = false`];
}

function isTomlHeader(line: string): boolean {
  return tomlSectionHeader.test(line) || tomlArrayHeader.test(line);
}

function isTomlManagedHeader(line: string): boolean {
  const plain = line.match(tomlSectionHeader);
  const array = line.match(tomlArrayHeader);
  const name = (array?.[1] ?? plain?.[1] ?? "").trim();
  return name === "mcp_servers" || name.startsWith("mcp_servers.") || name === "skills.config";
}

export function rewriteManagedToml(
  raw: string,
  servers: Map<string, AgentToolMcpDefinition>,
  skills: Array<{ path: string; enabled: boolean }>
): string {
  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.trim() === "# space-agent-tools-managed") continue;
    const managed = isTomlManagedHeader(line);
    if (managed) {
      skipping = true;
      continue;
    }
    if (isTomlHeader(line)) skipping = false;
    if (!skipping) kept.push(line);
  }

  const rebuilt = [...kept];
  if (rebuilt.length > 0 && rebuilt[rebuilt.length - 1] !== "") rebuilt.push("");
  const writeSection = (label: string, body: string[]) => {
    rebuilt.push(`# space-agent-tools-managed`);
    rebuilt.push(...body);
  };
  for (const [name, definition] of servers) {
    rebuilt.push("");
    writeSection(name, renderTomlMcpSection(name, definition));
  }
  for (const skill of skills) {
    rebuilt.push("");
    writeSection(skill.path, renderTomlSkillBlock(skill.path, skill.enabled));
  }
  return `${rebuilt.join("\n").trimEnd()}\n`;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJsonFile(path: string): Promise<JsonObject | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getByKeyPath(root: JsonObject, keyPath: string): unknown {
  let current: unknown = root;
  for (const segment of keyPath.split(".")) {
    if (!isJsonObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function setByKeyPath(root: JsonObject, keyPath: string, value: unknown): void {
  const segments = keyPath.split(".");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (!isJsonObject(next)) {
      current[segment] = {};
    }
    current = current[segment] as JsonObject;
  }
  const lastSegment = segments[segments.length - 1];
  if (lastSegment) current[lastSegment] = value;
}

function jsonMcpEntry(value: JsonObject): AgentToolMcpDefinition {
  const command = typeof value.command === "string" && value.command.length > 0 ? value.command : null;
  const url = typeof value.url === "string" && value.url.length > 0 ? value.url : null;
  const args = Array.isArray(value.args) ? value.args.filter((arg): arg is string => typeof arg === "string") : [];
  const env: Record<string, string> = {};
  if (isJsonObject(value.env)) {
    for (const [key, valueEntry] of Object.entries(value.env)) {
      if (typeof valueEntry === "string") env[key] = valueEntry;
    }
  }
  return {
    transport: url ? "http" : "stdio",
    command: url ? null : command,
    args: args.length > 0 ? args : undefined,
    url: url ?? null,
    env: Object.keys(env).length > 0 ? env : undefined
  };
}

function mcpObjectKey(runtimeId: string): string {
  return runtimeId === "cli:opencode" ? "mcp" : "mcpServers";
}

async function readJsonObjectMcp(
  path: string,
  keyPath: string
): Promise<{ servers: Map<string, AgentToolMcpDefinition>; present: boolean }> {
  const config = await readJsonFile(path);
  const section = config ? getByKeyPath(config, keyPath) : undefined;
  const servers = new Map<string, AgentToolMcpDefinition>();
  if (isJsonObject(section)) {
    for (const [name, entry] of Object.entries(section)) {
      if (isJsonObject(entry)) servers.set(name, jsonMcpEntry(entry));
    }
    return { servers, present: true };
  }
  return { servers, present: false };
}

async function readJsonArrayMcp(
  path: string,
  keyPath: string,
  nameKey: string
): Promise<{ servers: Map<string, AgentToolMcpDefinition>; present: boolean }> {
  const config = await readJsonFile(path);
  const section = config ? getByKeyPath(config, keyPath) : undefined;
  const servers = new Map<string, AgentToolMcpDefinition>();
  if (Array.isArray(section)) {
    for (const item of section) {
      if (!isJsonObject(item)) continue;
      const name = typeof item[nameKey] === "string" ? item[nameKey] : null;
      if (!name) continue;
      const enabled = item.enabled !== false && item.autoConnect !== false;
      if (enabled) servers.set(name, jsonMcpEntry(item));
    }
    return { servers, present: true };
  }
  return { servers, present: false };
}

function jsonContent(value: JsonObject): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeBackedUpFileAtomic(path: string, content: string): Promise<{ createdBackup: boolean }> {
  const existing = await readFile(path, "utf8").catch(() => null);
  if (existing === content) return { createdBackup: false };
  let createdBackup = false;
  if (existing !== null) {
    const backupPath = `${path}.bak-space-agent-tools-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await writeFile(backupPath, existing, "utf8");
    createdBackup = true;
  }
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.space-agent-tools-${randomUUID()}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
  return { createdBackup };
}

interface RootWriterResult {
  ok: boolean;
  changed?: boolean;
  backupCreated?: boolean;
  path?: string;
  content?: string | null;
  code?: string;
  message?: string;
}

async function invokeRootWriter(
  rootWriterCommand: string | null,
  payload: { op: "read" | "write"; path: string; content?: string }
): Promise<RootWriterResult> {
  if (!rootWriterCommand) {
    throw new Error("Agent tools root writer is not configured.");
  }
  const output = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn("/usr/bin/sudo", ["-n", rootWriterCommand], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Agent tools root writer timed out for ${payload.path}.`));
    }, 20_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
  if (output.code !== 0 || !output.stdout.trim()) {
    const parsed = output.stderr.trim() ? (safeJsonParse(output.stderr.trim()) as RootWriterResult | null) : null;
    if (parsed?.message) throw new Error(`Agent tools root writer: ${parsed.message}`);
    throw new Error(`Agent tools root writer failed for ${payload.path} (exit ${String(output.code)}).`);
  }
  return JSON.parse(output.stdout.trim()) as RootWriterResult;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function rootReadFile(rootWriterCommand: string | null, path: string): Promise<string | null> {
  if (!rootWriterCommand) {
    return readFile(path, "utf8").catch(() => null);
  }
  const result = await invokeRootWriter(rootWriterCommand, { op: "read", path });
  if (!result.ok) {
    throw new Error(`Agent tools root writer read failed for ${path}.`);
  }
  return result.content ?? null;
}

async function rootReadJsonFile(rootWriterCommand: string | null, path: string): Promise<JsonObject | null> {
  const raw = await rootReadFile(rootWriterCommand, path);
  if (raw === null || raw.trim() === "") return null;
  return safeJsonParse(raw) as JsonObject | null;
}

async function rootWriteBackedUpFileAtomic(
  rootWriterCommand: string | null,
  path: string,
  content: string
): Promise<{ createdBackup: boolean; changed: boolean }> {
  if (!rootWriterCommand) {
    const existing = await readFile(path, "utf8").catch(() => null);
    if (existing === content) return { createdBackup: false, changed: false };
    const backup = await writeBackedUpFileAtomic(path, content);
    return { createdBackup: backup.createdBackup, changed: true };
  }
  const result = await invokeRootWriter(rootWriterCommand, { op: "write", path, content });
  if (!result.ok) {
    throw new Error(`Agent tools root writer failed for ${path}.`);
  }
  return {
    createdBackup: result.backupCreated === true,
    changed: result.changed !== false
  };
}

async function readSkillsFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => join(root, entry.name, "SKILL.md"));
  } catch {
    return [];
  }
}

export async function discoverAgentTools(store: SpaceStore, options: AgentToolsOptions = {}): Promise<DiscoveredState> {
  const effective = effectiveOptions(options);
  const layout = cliRuntimeDescriptors.map((descriptor) => resolveRuntimeLayout(descriptor.id, effective));
  const tools: DiscoveredRuntimeTools[] = [];

  for (const runtime of layout) {
    let mcpServers: DiscoveredMcpServer[] = [];
    let skillEntries: DiscoveredSkill[] = [];
    let skillPaths: string[] = [];

    if (runtime.mcpConfigPath) {
      const source = (await resolveMcpReadSource(runtime, effective)) ?? {
        path: runtime.mcpConfigPath,
        format: runtime.mcpFormat === "array" ? ("array" as const) : runtime.mcpFormat === "toml" ? ("toml" as const) : ("object" as const),
        keyPath: runtime.mcpFormat === "array" ? "mcp.servers" : mcpObjectKey(runtime.runtimeId)
      };
      if (source.format === "toml") {
        const raw = await readFile(source.path, "utf8").catch(() => "");
        mcpServers = [...parseTomlMcpServers(raw).entries()].map(([name, definition]) => ({ name, definition }));
      } else if (source.format === "array") {
        const parsed = await readJsonArrayMcp(source.path, source.keyPath, "name");
        mcpServers = [...parsed.servers.entries()].map(([name, definition]) => ({ name, definition }));
      } else {
        const parsed = await readJsonObjectMcp(source.path, source.keyPath);
        mcpServers = [...parsed.servers.entries()].map(([name, definition]) => ({ name, definition }));
      }
    }

    if (runtime.skillsConfigPath && runtime.skillsFormat === "codex-toml") {
      const raw = await readFile(runtime.skillsConfigPath, "utf8").catch(() => "");
      skillEntries = parseTomlSkills(raw).map((entry) => ({ name: skillDirName(entry.path), path: entry.path, enabled: entry.enabled }));
    }

    if (runtime.runtimeId === "cli:codex" || runtime.runtimeId === "cli:grok") {
      skillPaths = await readSkillsFiles(effective.skillsRoot);
    } else if (runtime.runtimeId === "cli:opencode") {
      skillPaths = await readSkillsFiles(effective.skillsRoot);
    }

    if (runtime.runtimeId === "cli:opencode" && skillPaths.length > 0) {
      const source = (await resolveMcpReadSource(runtime, effective)) ?? null;
      const config = source ? await readJsonFile(source.path) : null;
      const permission = isJsonObject(config) ? getByKeyPath(config, "permission") : undefined;
      const skillPermission = isJsonObject(permission) ? getByKeyPath(permission, "skill") : undefined;
      const deniedNames = new Set(
        isJsonObject(skillPermission)
          ? Object.entries(skillPermission)
              .filter(([, value]) => value === "deny")
              .map(([name]) => name)
          : []
      );
      for (const skillPath of skillPaths) {
        skillEntries.push({ name: skillDirName(skillPath), path: skillPath, enabled: !deniedNames.has(skillDirName(skillPath)) });
      }
    }

    if (skillPaths.length > 0) {
      for (const skillPath of skillPaths) {
        if (!skillEntries.some((entry) => entry.path === skillPath)) {
          skillEntries.push({ name: skillDirName(skillPath), path: skillPath, enabled: true });
        }
      }
    }

    tools.push({ runtimeId: runtime.runtimeId, mcpServers, skillEntries, skillPaths });
  }

  const assignments = await store.listAgentToolAssignments();
  return { layout, tools, assignments };
}

function skillDirName(path: string): string {
  return basename(dirname(path));
}

function skillToolName(path: string): string {
  const base = skillDirName(path);
  return base.replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase() || base;
}

function buildToolId(kind: "MCP" | "SKILL", name: string): string {
  return kind === "MCP" ? `mcp:${name}` : `skill:${skillToolName(name)}`;
}

async function readSkillDescription(path: string): Promise<string> {
  try {
    const raw = await readFile(path, "utf8");
    const first = raw.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
    return first.replace(/^#+\s*/, "").trim().slice(0, 500) || `Skill at ${path}`;
  } catch {
    return `Skill at ${path}`;
  }
}

function canonicalMcpDefinition(tools: DiscoveredRuntimeTools[], name: string): AgentToolMcpDefinition | null {
  const codex = tools.find((candidate) => candidate.runtimeId === "cli:codex");
  const codexMatch = codex?.mcpServers.find((server) => server.name === name);
  if (codexMatch) return codexMatch.definition;
  for (const runtime of tools) {
    const match = runtime.mcpServers.find((server) => server.name === name);
    if (match) return match.definition;
  }
  return null;
}

function assignmentEnabled(assignment: AgentToolAssignment | undefined, runtimeId: string): boolean | null {
  if (!assignment) return null;
  if (assignment.scope === "COMMON") return true;
  if (assignment.scope === "SPECIFIC") return assignment.runtimeIds.includes(runtimeId);
  return false;
}

async function onDiskToolEnabled(
  tools: DiscoveredRuntimeTools[],
  runtimeId: string,
  kind: "MCP" | "SKILL",
  name: string,
  skillPath?: string
): Promise<boolean> {
  const runtime = tools.find((candidate) => candidate.runtimeId === runtimeId);
  if (!runtime) return false;
  if (kind === "MCP") return runtime.mcpServers.some((server) => server.name === name);
  const entry = runtime.skillEntries.find((candidate) => (skillPath ? candidate.path === skillPath : candidate.name === name));
  return entry?.enabled ?? false;
}

export async function buildAgentToolsCatalog(store: SpaceStore, options: AgentToolsOptions = {}): Promise<AgentToolsCatalogResponse> {
  const { layout, tools, assignments } = await discoverAgentTools(store, options);

  const runtimes: AgentToolRuntimeCatalogInfo[] = layout.map((runtime) => ({
    runtimeId: runtime.runtimeId,
    displayName: runtime.displayName,
    supported: !runtime.readOnly,
    readOnly: runtime.readOnly,
    reason: runtime.reason
  }));

  const mcpEntries = new Map<string, AgentToolCatalogEntry>();
  for (const runtime of tools) {
    const runtimeLayout = layout.find((candidate) => candidate.runtimeId === runtime.runtimeId);
    for (const server of runtime.mcpServers) {
      const toolId = buildToolId("MCP", server.name);
      const definition = canonicalMcpDefinition(tools, server.name) ?? server.definition;
      const existing = mcpEntries.get(toolId);
      if (existing) {
        if (!existing.sourceRuntimeIds.includes(runtime.runtimeId)) existing.sourceRuntimeIds.push(runtime.runtimeId);
        if (runtimeLayout?.readOnly && !existing.readOnlyRuntimeIds?.includes(runtime.runtimeId)) {
          existing.readOnlyRuntimeIds = [...(existing.readOnlyRuntimeIds ?? []), runtime.runtimeId];
        }
        continue;
      }
      mcpEntries.set(toolId, {
        toolId,
        kind: "MCP",
        name: server.name,
        description: `MCP server ${server.name} (${definition.transport})`,
        sourceRuntimeIds: [runtime.runtimeId],
        mcp: definition,
        readOnlyRuntimeIds: runtimeLayout?.readOnly ? [runtime.runtimeId] : undefined
      });
    }
  }

  const skillEntries = new Map<string, AgentToolCatalogEntry>();
  for (const runtime of tools) {
    for (const skillPath of runtime.skillPaths) {
      const toolId = buildToolId("SKILL", skillPath);
      if (skillEntries.has(toolId)) continue;
      skillEntries.set(toolId, {
        toolId,
        kind: "SKILL",
        name: skillDirName(skillPath),
        description: await readSkillDescription(skillPath),
        sourceRuntimeIds: [runtime.runtimeId],
        skillPath,
        readOnlyRuntimeIds: [runtime.runtimeId]
      });
    }
  }

  const entries = [...mcpEntries.values(), ...skillEntries.values()].sort((left, right) =>
    left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind.localeCompare(right.kind)
  );

  const states: AgentToolEffectiveState[] = [];
  for (const entry of entries) {
    const assignment = assignments.find((candidate) => candidate.toolId === entry.toolId);
    const applicableLayouts = layout.filter((candidate) => {
      if (candidate.readOnly) return false;
      if (entry.kind === "MCP") return candidate.mcpFormat !== "unsupported";
      return candidate.skillsFormat !== "unsupported";
    });
    for (const runtimeLayout of applicableLayouts) {
      const derived = assignmentEnabled(assignment, runtimeLayout.runtimeId);
      const enabled =
        derived ??
        (await onDiskToolEnabled(tools, runtimeLayout.runtimeId, entry.kind, entry.name, entry.skillPath));
      states.push({ toolId: entry.toolId, runtimeId: runtimeLayout.runtimeId, enabled });
    }
  }

  const writableRuntimeIds = layout.filter((candidate) => !candidate.readOnly).map((candidate) => candidate.runtimeId);

  return agentToolsCatalogResponseSchema.parse({
    entries,
    runtimes,
    states,
    assignments: [...assignments].sort((left, right) => left.toolId.localeCompare(right.toolId)),
    writableRuntimeIds,
    appliedAt: null
  });
}

export interface AgentToolApplyInput {
  toolId: string;
  kind: "MCP" | "SKILL";
  scope: "COMMON" | "SPECIFIC" | "NONE";
  runtimeIds: string[];
}

function assignmentFor(assignments: AgentToolAssignment[], toolId: string): AgentToolAssignment | undefined {
  return assignments.find((candidate) => candidate.toolId === toolId);
}

function applyEnabled(assignment: AgentToolAssignment | undefined, runtimeId: string): boolean | null {
  if (!assignment) return null;
  return assignmentEnabled(assignment, runtimeId);
}

export async function applyAgentTools(
  store: SpaceStore,
  inputs: AgentToolApplyInput[],
  options: AgentToolsOptions = {}
): Promise<ApplyAgentToolsResult> {
  const effective = effectiveOptions(options);
  const assignments: AgentToolAssignment[] = inputs.map((input) =>
    agentToolAssignmentSchema.parse({
      toolId: input.toolId,
      kind: input.kind,
      scope: input.scope,
      runtimeIds: input.runtimeIds,
      updatedAt: new Date().toISOString(),
      updatedBy: "agent-tools"
    })
  );

  const { layout, tools } = await discoverAgentTools(store, effective);
  const catalog = await buildAgentToolsCatalog(store, effective);
  const catalogMcpByName = new Map<string, AgentToolCatalogEntry>(
    catalog.entries.filter((entry) => entry.kind === "MCP").map((entry) => [entry.name, entry])
  );
  const results: AgentToolApplyRuntimeResult[] = [];

  for (const runtimeLayout of layout) {
    if (runtimeLayout.readOnly) {
      results.push({
        runtimeId: runtimeLayout.runtimeId,
        status: "UNSUPPORTED",
        reason: runtimeLayout.reason ?? "CLI runtime has no managed config file.",
        files: [],
        enabledMcpIds: [],
        enabledSkillIds: []
      });
      continue;
    }

    const files: AgentToolApplyFile[] = [];
    const enabledMcpIds: string[] = [];
    const enabledSkillIds: string[] = [];

    if (runtimeLayout.mcpConfigPath) {
      const discovered = tools.find((candidate) => candidate.runtimeId === runtimeLayout.runtimeId);
      const knownServerNames = new Set(discovered?.mcpServers.map((server) => server.name) ?? []);
      const writeSource = (await resolveMcpReadSource(runtimeLayout, effective)) ?? {
        path: runtimeLayout.mcpConfigPath,
        format: runtimeLayout.mcpFormat === "array" ? ("array" as const) : runtimeLayout.mcpFormat === "toml" ? ("toml" as const) : ("object" as const),
        keyPath: runtimeLayout.mcpFormat === "array" ? "mcp.servers" : mcpObjectKey(runtimeLayout.runtimeId)
      };
      const writePath = writeSource.path;

      if (writeSource.format === "toml") {
        const raw = (await rootReadFile(effective.rootWriterCommand, writePath)) ?? "";
        const onDiskServers = parseTomlMcpServers(raw);
        const desiredServers = new Map<string, AgentToolMcpDefinition>();
        for (const [name, entry] of catalogMcpByName) {
          const assignment = assignmentFor(assignments, entry.toolId);
          if (!entry.mcp) continue;
          if (applyEnabled(assignment, runtimeLayout.runtimeId) ?? onDiskServers.has(name)) {
            desiredServers.set(name, entry.mcp);
            if (applyEnabled(assignment, runtimeLayout.runtimeId) === true) enabledMcpIds.push(entry.toolId);
          }
        }
        const desiredSkills: Array<{ path: string; enabled: boolean }> = [];
        for (const entry of catalog.entries.filter((candidate) => candidate.kind === "SKILL" && candidate.skillPath)) {
          if (runtimeLayout.skillsFormat === "codex-toml") {
            const assignment = assignmentFor(assignments, entry.toolId);
            const onDisk = parseTomlSkills(raw).find((candidate) => candidate.path === entry.skillPath);
            const skillEnabled = applyEnabled(assignment, runtimeLayout.runtimeId) ?? onDisk?.enabled ?? true;
            desiredSkills.push({ path: entry.skillPath ?? "", enabled: skillEnabled });
            if (applyEnabled(assignment, runtimeLayout.runtimeId) === true) enabledSkillIds.push(entry.toolId);
          }
        }
        const rebuilt = rewriteManagedToml(raw, desiredServers, desiredSkills);
        if (rebuilt !== raw) {
          const write = await rootWriteBackedUpFileAtomic(effective.rootWriterCommand, writePath, rebuilt);
          files.push({ path: writePath, action: write.createdBackup ? "BACKUP_CREATED" : "UPDATED", changed: write.changed });
        } else {
          files.push({ path: writePath, action: "UNCHANGED", changed: false });
        }
      } else if (writeSource.format === "array") {
        const config = (await rootReadJsonFile(effective.rootWriterCommand, writePath)) ?? {};
        const currentArray = Array.isArray(getByKeyPath(config, writeSource.keyPath)) ? (getByKeyPath(config, writeSource.keyPath) as JsonObject[]) : [];
        const keptCustom = currentArray.filter((item) => {
          const name = typeof item.name === "string" ? item.name : null;
          return !name || !knownServerNames.has(name);
        });
        const desiredItems: JsonObject[] = [];
        for (const [name, entry] of catalogMcpByName) {
          if (!entry.mcp) continue;
          const assignment = assignmentFor(assignments, entry.toolId);
          const onDisk = currentArray.some((item) => item.name === name);
          if (applyEnabled(assignment, runtimeLayout.runtimeId) ?? onDisk) {
            const def = entry.mcp;
            const existing = currentArray.find((item) => item.name === name);
            desiredItems.push({
              ...(existing ?? {}),
              name,
              transport: def.transport,
              command: def.command ?? undefined,
              args: def.args ?? [],
              autoConnect: true,
              ...(def.env ? { env: def.env } : {})
            });
            if (applyEnabled(assignment, runtimeLayout.runtimeId) === true) enabledMcpIds.push(entry.toolId);
          }
        }
        setByKeyPath(config, writeSource.keyPath, [...keptCustom, ...desiredItems]);
        const content = jsonContent(config);
        const currentContent = await rootReadFile(effective.rootWriterCommand, writePath);
        if (currentContent !== content) {
          const write = await rootWriteBackedUpFileAtomic(effective.rootWriterCommand, writePath, content);
          files.push({ path: writePath, action: write.createdBackup ? "BACKUP_CREATED" : "UPDATED", changed: write.changed });
        } else {
          files.push({ path: writePath, action: "UNCHANGED", changed: false });
        }
      } else {
        const config = (await rootReadJsonFile(effective.rootWriterCommand, writePath)) ?? {};
        const objectKey = writeSource.keyPath || mcpObjectKey(runtimeLayout.runtimeId);
        const currentObject = isJsonObject(getByKeyPath(config, objectKey)) ? (getByKeyPath(config, objectKey) as JsonObject) : {};
        const rebuiltObject: JsonObject = {};
        for (const [name, raw] of Object.entries(currentObject)) {
          if (!catalogMcpByName.has(name)) rebuiltObject[name] = raw;
        }
        for (const [name, entry] of catalogMcpByName) {
          if (!entry.mcp) continue;
          const assignment = assignmentFor(assignments, entry.toolId);
          const onDisk = isJsonObject(currentObject[name]);
          if (applyEnabled(assignment, runtimeLayout.runtimeId) ?? onDisk) {
            const existing = isJsonObject(currentObject[name]) ? (currentObject[name] as JsonObject) : {};
            rebuiltObject[name] = { ...existing, ...(entry.mcp.command ? { command: entry.mcp.command } : {}), ...(entry.mcp.args ? { args: entry.mcp.args } : {}) };
            if (applyEnabled(assignment, runtimeLayout.runtimeId) === true) enabledMcpIds.push(entry.toolId);
          }
        }
        setByKeyPath(config, objectKey, rebuiltObject);
        if (runtimeLayout.runtimeId === "cli:qwen") {
          const allowed = Object.keys(rebuiltObject).sort();
          const currentAllowed = getByKeyPath(config, "mcp.allowed");
          if (!Array.isArray(currentAllowed) || currentAllowed.join() !== allowed.join()) {
            setByKeyPath(config, "mcp.allowed", allowed);
          }
        }
        if (runtimeLayout.runtimeId === "cli:opencode") {
          const managedSkillNames = new Set(
            catalog.entries.filter((entry) => entry.kind === "SKILL" && entry.skillPath).map((entry) => entry.name)
          );
          const currentPermissionValue = getByKeyPath(config, "permission");
          const currentPermission = isJsonObject(currentPermissionValue) ? (currentPermissionValue as JsonObject) : {};
          const currentSkillPermission = isJsonObject(currentPermission.skill) ? (currentPermission.skill as JsonObject) : {};
          const skillPermission: JsonObject = {};
          for (const [name, value] of Object.entries(currentSkillPermission)) {
            if (!managedSkillNames.has(name)) skillPermission[name] = value;
          }
          for (const entry of catalog.entries.filter((candidate) => candidate.kind === "SKILL" && candidate.skillPath)) {
            const assignment = assignmentFor(assignments, entry.toolId);
            const onDisk = await onDiskToolEnabled(tools, runtimeLayout.runtimeId, "SKILL", entry.name, entry.skillPath);
            const skillEnabled = applyEnabled(assignment, runtimeLayout.runtimeId) ?? onDisk;
            if (skillEnabled) {
              delete skillPermission[entry.name];
              enabledSkillIds.push(entry.toolId);
            } else {
              skillPermission[entry.name] = "deny";
            }
          }
          if (Object.keys(skillPermission).length > 0) {
            setByKeyPath(config, "permission", { ...currentPermission, skill: skillPermission });
          } else if (isJsonObject(currentPermissionValue)) {
            const rebuiltPermission: JsonObject = {};
            for (const [key, value] of Object.entries(currentPermission)) {
              if (key !== "skill") rebuiltPermission[key] = value;
            }
            setByKeyPath(config, "permission", rebuiltPermission);
          }
        }
        const content = jsonContent(config);
        const currentContent = await rootReadFile(effective.rootWriterCommand, writePath);
        if (currentContent !== content) {
          const write = await rootWriteBackedUpFileAtomic(effective.rootWriterCommand, writePath, content);
          files.push({ path: writePath, action: write.createdBackup ? "BACKUP_CREATED" : "UPDATED", changed: write.changed });
        } else {
          files.push({ path: writePath, action: "UNCHANGED", changed: false });
        }
      }
    } else {
      files.push({ path: "", action: "UNCHANGED", changed: false });
    }

    results.push({
      runtimeId: runtimeLayout.runtimeId,
      status: "OK",
      reason: runtimeLayout.readOnly ? runtimeLayout.reason : null,
      files,
      enabledMcpIds: [...new Set(enabledMcpIds)],
      enabledSkillIds: [...new Set(enabledSkillIds)]
    });
  }

  return { results };
}
