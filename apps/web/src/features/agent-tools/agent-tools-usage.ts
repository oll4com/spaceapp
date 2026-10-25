// Response of GET /api/agent-tools/usage. Kept in its own module so the API client
// (live-api.ts) does not import the card component that itself imports the API client.
export interface AgentToolsUsage {
  available: boolean;
  reason?: string;
  generatedAt?: string;
  windowDays?: number;
  complete?: boolean;
  skills?: Array<{ name: string; uses: number; failures: number; lastUsedAt: string | null; byRuntime: Record<string, number> }>;
  mcp?: Array<{ serverId: string; toolName: string; calls: number; errors: number; lastUsedAt: string | null; p95Ms: number | null }>;
  backends?: Array<{ id: string; name: string; description: string; toolCount: number | null; schemaBuiltAt: string | null; stale: boolean }>;
}
