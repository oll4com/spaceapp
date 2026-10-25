/**
 * Space capability inventory snapshot used by launch readiness and Space Control (moved verbatim from the composition
 * root).
 */
import { readFile } from "node:fs/promises";
import { type SpaceCapabilitySnapshot, spaceCapabilitySnapshotSchema } from "@space/contracts";
import { nowIso, type SpaceStore } from "@space/runtime";
import { discoverAgentRuntimes } from "./cli-runtimes.js";
import type { SpaceApiConfig } from "./config.js";

export type SpaceCapabilityInventoryCollector = (context: {
  store: SpaceStore;
  config: SpaceApiConfig;
}) => Promise<SpaceCapabilitySnapshot> | SpaceCapabilitySnapshot;

const spaceCapabilityInventorySnapshotPath = "/opt/spaceapp/var/inventory/space-capabilities.json";

async function readSpaceCapabilityInventorySnapshotFile(): Promise<SpaceCapabilitySnapshot | null> {
  try {
    const parsed = JSON.parse(await readFile(spaceCapabilityInventorySnapshotPath, "utf8"));
    return spaceCapabilitySnapshotSchema.parse(parsed);
  } catch {
    return null;
  }
}

export async function collectDefaultSpaceCapabilityInventory(context: {
  store: SpaceStore;
  config: SpaceApiConfig;
}): Promise<SpaceCapabilitySnapshot> {
  const fileSnapshot = await readSpaceCapabilityInventorySnapshotFile();
  if (fileSnapshot) return fileSnapshot;

  const [mcpServers, skills, cliRuntimes] = await Promise.all([
    context.store.listMcpServers(),
    context.store.listSkills(),
    discoverAgentRuntimes(context.config)
  ]);
  const generatedAt = nowIso();
  return spaceCapabilitySnapshotSchema.parse({
    id: "space-capability-snapshot",
    generatedAt,
    status: "VERIFIED",
    statusReason: "Inventory built from sanitized Space metadata; bounded Space helper snapshot is not present yet.",
    sources: [
      {
        id: "space-store",
        label: "Space store",
        status: "VERIFIED",
        statusReason: "Mediated Space registry metadata is readable.",
        lastCheckedAt: generatedAt
      },
      {
        id: "bounded-helper-snapshot",
        label: "Bounded Space helper snapshot",
        status: "DISABLED",
        statusReason: "No readable helper snapshot was found under /opt/spaceapp/var/inventory.",
        lastCheckedAt: generatedAt
      }
    ],
    mcpServers: mcpServers.map((server) => ({
      id: server.id,
      displayName: server.displayName,
      transport: server.transport,
      status: server.status,
      statusReason: server.statusReason
    })),
    skills: skills
      .filter((skill) => skill.source === "CODEX_SKILL")
      .slice(0, 300)
      .map((skill) => ({
        id: skill.id,
        displayName: skill.displayName,
        source: skill.source,
        status: skill.status,
        statusReason: skill.statusReason,
        contentHash: skill.contentHash
      })),
    memory: {
      canonicalIndexPath: context.config.spaceMemoryIndexPath,
      currentMonthPath: context.config.spaceMemoryMonthlyPath,
      status: "VERIFIED",
      statusReason: "Canonical Space Memory paths are the shared read/write memory plane; Space DB memory is cache/audit only."
    },
    vscode: {
      extensions: []
    },
    cliRuntimes: cliRuntimes.data.map((runtime) => ({
      id: runtime.id,
      displayName: runtime.displayName,
      status: runtime.status,
      statusReason: runtime.statusReason
    })),
    codexLbRoute: {
      status: "DISABLED",
      mode: null,
      selectedAt: null,
      activeUpstreams: []
    },
    gates: [
      {
        id: "mcp-execution",
        status: "WARN",
        statusReason: "MCP execution remains blocked unless discovery smoke, schema allowlist, and approval policy pass."
      },
      {
        id: "memory-save",
        status: "VERIFIED",
        statusReason: "Authenticated Space Memory saves append directly to the canonical monthly file with redaction and audit."
      }
    ]
  });
}
