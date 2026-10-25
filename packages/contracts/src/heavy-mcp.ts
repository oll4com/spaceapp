import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const jsonRecordSchema = z.record(z.string(), z.unknown());
const namedCatalogRecordSchema = z.object({
  name: z.string().min(1).max(160)
}).catchall(z.unknown());

export const mcpCatalogManifestV1Schema = z.object({
  contract: z.literal("McpCatalogManifestV1"),
  schemaVersion: z.literal(1),
  serverId: z.string().min(1).max(80).regex(/^[a-z0-9_]+$/),
  generatedAt: z.string().datetime({ offset: true }),
  upstream: z.object({
    command: z.string().min(1).max(320).startsWith("/"),
    args: z.array(z.string().max(320)).max(20),
    fingerprintInputs: z.array(z.object({
      path: z.string().min(1).max(500).startsWith("/"),
      bytes: z.number().int().nonnegative().max(100 * 1024 * 1024),
      sha256: sha256Schema
    }).strict()).min(1).max(32),
    fingerprint: sha256Schema
  }).strict(),
  initialize: z.object({
    protocolVersion: z.string().min(1).max(40),
    serverInfo: jsonRecordSchema,
    instructions: z.string().max(100_000).nullable(),
    capabilities: jsonRecordSchema
  }).strict(),
  catalog: z.object({
    tools: z.array(namedCatalogRecordSchema).max(2_000),
    resources: z.array(jsonRecordSchema).max(2_000),
    resourceTemplates: z.array(jsonRecordSchema).max(2_000),
    prompts: z.array(namedCatalogRecordSchema).max(2_000)
  }).strict(),
  schemaHashes: z.object({
    tools: z.record(z.string().min(1).max(160), sha256Schema),
    resources: sha256Schema,
    resourceTemplates: sha256Schema,
    prompts: z.record(z.string().min(1).max(160), sha256Schema)
  }).strict(),
  catalogHash: sha256Schema
}).strict();

export const heavyMcpUpstreamStateSchema = z.enum(["IDLE", "STARTING", "READY", "FAILED"]);

const heavyMcpGatewayServerReadyV2Schema = z.object({
  endpoint: z.string().url().regex(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[a-z0-9_]+$/),
  catalogHash: sha256Schema.nullable(),
  catalogMode: z.enum(["LAZY_MANIFEST", "EAGER_FALLBACK"]),
  upstreamState: heavyMcpUpstreamStateSchema,
  fallbackReason: z.string().min(1).max(120).nullable()
}).strict();

export const heavyMcpGatewayReadyV2Schema = z.object({
  contract: z.literal("HeavyMcpGatewayReadyV2"),
  schemaVersion: z.literal(2),
  ok: z.boolean(),
  pid: z.number().int().positive(),
  listenerState: z.enum(["STARTING", "LISTENING"]),
  catalogReady: z.boolean(),
  host: z.literal("127.0.0.1"),
  port: z.number().int().min(1).max(65_535),
  catalogHash: sha256Schema.nullable(),
  servers: z.object({
    capturelab: heavyMcpGatewayServerReadyV2Schema,
    devtools: heavyMcpGatewayServerReadyV2Schema
  }).strict(),
  startedAt: z.string().datetime({ offset: true }),
  startedMonotonicNs: z.string().regex(/^\d+$/)
}).strict();

export type McpCatalogManifestV1 = z.infer<typeof mcpCatalogManifestV1Schema>;
export type HeavyMcpGatewayReadyV2 = z.infer<typeof heavyMcpGatewayReadyV2Schema>;
