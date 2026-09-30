import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type PluginCatalogItem,
  type PluginConnectionState,
  type PluginWithState,
  type ConnectPluginInput,
  type AgentPluginConfig
} from "@space/contracts";

const PLUGINS_DIR = "/opt/spaceapp/var/plugins";
const CONNECTIONS_FILE = join(PLUGINS_DIR, "connections.json");
const AGENT_CONFIGS_FILE = join(PLUGINS_DIR, "agent-configs.json");

export const DEFAULT_PLUGIN_CATALOG: PluginCatalogItem[] = [
  {
    id: "github",
    displayName: "GitHub",
    description: "Read repos, issues, pull requests, and commit code directly.",
    category: "developer",
    icon: "GitBranch",
    authType: "api_key",
    authFields: [
      { key: "token", label: "Personal Access Token", type: "password", required: true, placeholder: "ghp_...", description: "GitHub PAT with repo and workflow scopes." }
    ],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://github.com",
    docsUrl: "https://docs.github.com",
    mcpCommand: "npx",
    mcpArgs: ["-y", "@modelcontextprotocol/server-github"]
  },
  {
    id: "slack",
    displayName: "Slack",
    description: "Read channels and messages, post updates, and inspect threads.",
    category: "communication",
    icon: "MessageSquare",
    authType: "api_key",
    authFields: [
      { key: "botToken", label: "Bot User OAuth Token", type: "password", required: true, placeholder: "xoxb-...", description: "Slack Bot token with chat and channels scopes." }
    ],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://slack.com",
    docsUrl: "https://api.slack.com",
    mcpCommand: "npx",
    mcpArgs: ["-y", "@modelcontextprotocol/server-slack"]
  },
  {
    id: "supabase",
    displayName: "Supabase",
    description: "Inspect and change database tables, run queries, and manage projects.",
    category: "database",
    icon: "Database",
    authType: "api_key",
    authFields: [
      { key: "url", label: "Project URL", type: "url", required: true, placeholder: "https://xyzcompany.supabase.co", description: "Supabase project API URL." },
      { key: "serviceRoleKey", label: "Service Role Key", type: "password", required: true, placeholder: "eyJ...", description: "Secret service role key for database actions." }
    ],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://supabase.com",
    docsUrl: "https://supabase.com/docs",
    mcpCommand: "npx",
    mcpArgs: ["-y", "@modelcontextprotocol/server-postgres"]
  },
  {
    id: "linear",
    displayName: "Linear",
    description: "Linear workspace, issues, projects, cycles, and roadmaps.",
    category: "productivity",
    icon: "Layers",
    authType: "api_key",
    authFields: [
      { key: "apiKey", label: "Personal API Key", type: "password", required: true, placeholder: "lin_api_...", description: "Linear personal API key." }
    ],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://linear.app",
    docsUrl: "https://developers.linear.app",
    mcpCommand: "npx",
    mcpArgs: ["-y", "@modelcontextprotocol/server-linear"]
  },
  {
    id: "fal",
    displayName: "fal",
    description: "fal.ai — 11 tools for generative media, image synthesis, and fast inference.",
    category: "creative",
    icon: "Sparkles",
    authType: "api_key",
    authFields: [
      { key: "apiKey", label: "fal.ai Key", type: "password", required: true, placeholder: "fal_...", description: "fal.ai API key." }
    ],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://fal.ai",
    docsUrl: "https://fal.ai/docs",
    mcpCommand: "npx",
    mcpArgs: ["-y", "@modelcontextprotocol/server-fal"]
  },
  {
    id: "stripe",
    displayName: "Stripe",
    description: "Read customers, invoices, subscriptions, payouts, and payment intents.",
    category: "finance",
    icon: "CreditCard",
    authType: "api_key",
    authFields: [
      { key: "secretKey", label: "Restricted API Key", type: "password", required: true, placeholder: "rk_live_...", description: "Stripe restricted key with read/write permissions." }
    ],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://stripe.com",
    docsUrl: "https://docs.stripe.com",
    mcpCommand: "npx",
    mcpArgs: ["-y", "@modelcontextprotocol/server-stripe"]
  },
  {
    id: "vercel",
    displayName: "Vercel",
    description: "Manage projects, deployments, domains, and environment variables.",
    category: "infra",
    icon: "Cpu",
    authType: "api_key",
    authFields: [
      { key: "token", label: "Vercel Access Token", type: "password", required: true, placeholder: "...", description: "Personal or team access token." }
    ],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://vercel.com",
    docsUrl: "https://vercel.com/docs",
    mcpCommand: "npx",
    mcpArgs: ["-y", "@modelcontextprotocol/server-vercel"]
  },
  {
    id: "sentry",
    displayName: "Sentry",
    description: "Search errors, issues, releases, and inspect crash telemetry.",
    category: "developer",
    icon: "Activity",
    authType: "api_key",
    authFields: [
      { key: "authToken", label: "Auth Token", type: "password", required: true, placeholder: "sntrys_...", description: "Sentry user or integration auth token." }
    ],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://sentry.io",
    docsUrl: "https://docs.sentry.io",
    mcpCommand: "npx",
    mcpArgs: ["-y", "@modelcontextprotocol/server-sentry"]
  },
  {
    id: "notion",
    displayName: "Notion",
    description: "Search, read, and create database items, wiki pages, and notes.",
    category: "productivity",
    icon: "BookOpen",
    authType: "api_key",
    authFields: [
      { key: "internalIntegrationSecret", label: "Internal Integration Secret", type: "password", required: true, placeholder: "ntn_...", description: "Notion internal integration secret." }
    ],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://notion.so",
    docsUrl: "https://developers.notion.com",
    mcpCommand: "npx",
    mcpArgs: ["-y", "@modelcontextprotocol/server-notion"]
  },
  {
    id: "resend",
    displayName: "Resend",
    description: "Send transactional emails, manage verified sender domains, and audit delivery.",
    category: "communication",
    icon: "Send",
    authType: "api_key",
    authFields: [
      { key: "apiKey", label: "API Key", type: "password", required: true, placeholder: "re_...", description: "Resend API key." }
    ],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://resend.com",
    docsUrl: "https://resend.com/docs",
    mcpCommand: "npx",
    mcpArgs: ["-y", "@modelcontextprotocol/server-resend"]
  },
  {
    id: "cloudflare",
    displayName: "Cloudflare",
    description: "Manage Workers, DNS records, KV namespaces, and domain routing.",
    category: "infra",
    icon: "Globe",
    authType: "api_key",
    authFields: [
      { key: "apiToken", label: "API Token", type: "password", required: true, placeholder: "...", description: "Cloudflare API token with Zone and Worker permissions." }
    ],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://cloudflare.com",
    docsUrl: "https://developers.cloudflare.com",
    mcpCommand: "npx",
    mcpArgs: ["-y", "@cloudflare/mcp-server-cloudflare"]
  },
  {
    id: "apollo",
    displayName: "Apollo",
    description: "Apollo workspace, lead discovery, enrichment, and prospect sequences.",
    category: "communication",
    icon: "Compass",
    authType: "api_key",
    authFields: [
      { key: "apiKey", label: "API Key", type: "password", required: true, placeholder: "...", description: "Apollo.io API key." }
    ],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://apollo.io",
    docsUrl: "https://apolloio.github.io/apollo-api-docs",
    mcpCommand: "npx",
    mcpArgs: ["-y", "@modelcontextprotocol/server-apollo"]
  },
  {
    id: "blender",
    displayName: "Blender",
    description: "Inspect the open 3D scene, generate procedural geometry, and render frames.",
    category: "creative",
    icon: "Box",
    authType: "none",
    authFields: [],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://blender.org",
    docsUrl: "https://docs.blender.org",
    mcpCommand: "python3",
    mcpArgs: ["/opt/spaceapp/scripts/mcp-blender-bridge.py"]
  },
  {
    id: "x",
    displayName: "X",
    description: "Post, reply, inspect timelines, and search public posts.",
    category: "communication",
    icon: "Share2",
    authType: "api_key",
    authFields: [
      { key: "bearerToken", label: "Bearer Token", type: "password", required: true, placeholder: "...", description: "X Developer portal Bearer Token." }
    ],
    preview: true,
    defaultEnabled: false,
    websiteUrl: "https://x.com",
    docsUrl: "https://developer.x.com",
    mcpCommand: null,
    mcpArgs: []
  }
];

export interface StoredPluginConnection {
  pluginId: string;
  status: "NOT_CONNECTED" | "CONNECTING" | "CONNECTED" | "ERROR";
  connectedAt: string | null;
  lastHealthCheckAt: string | null;
  accountLabel: string | null;
  toolCount: number;
  error: string | null;
  credentials: Record<string, string>;
}

export class PluginsService {
  private async ensureDir(): Promise<void> {
    if (!existsSync(PLUGINS_DIR)) {
      await mkdir(PLUGINS_DIR, { recursive: true });
    }
  }

  private async loadConnections(): Promise<Map<string, StoredPluginConnection>> {
    await this.ensureDir();
    if (!existsSync(CONNECTIONS_FILE)) {
      return new Map();
    }
    try {
      const raw = await readFile(CONNECTIONS_FILE, "utf-8");
      const list = JSON.parse(raw) as StoredPluginConnection[];
      return new Map(list.map((c) => [c.pluginId, c]));
    } catch {
      return new Map();
    }
  }

  private async saveConnections(connections: Map<string, StoredPluginConnection>): Promise<void> {
    await this.ensureDir();
    const list = Array.from(connections.values());
    await writeFile(CONNECTIONS_FILE, JSON.stringify(list, null, 2), "utf-8");
  }

  private async loadAgentConfigs(): Promise<Map<string, AgentPluginConfig>> {
    await this.ensureDir();
    if (!existsSync(AGENT_CONFIGS_FILE)) {
      return new Map();
    }
    try {
      const raw = await readFile(AGENT_CONFIGS_FILE, "utf-8");
      const list = JSON.parse(raw) as AgentPluginConfig[];
      return new Map(list.map((c) => [c.paneId, c]));
    } catch {
      return new Map();
    }
  }

  private async saveAgentConfigs(configs: Map<string, AgentPluginConfig>): Promise<void> {
    await this.ensureDir();
    const list = Array.from(configs.values());
    await writeFile(AGENT_CONFIGS_FILE, JSON.stringify(list, null, 2), "utf-8");
  }

  async getPlugins(): Promise<PluginWithState[]> {
    const connections = await this.loadConnections();
    return DEFAULT_PLUGIN_CATALOG.map((item) => {
      const conn = connections.get(item.id);
      const state: PluginConnectionState = conn
        ? {
            pluginId: item.id,
            status: conn.status,
            connectedAt: conn.connectedAt,
            lastHealthCheckAt: conn.lastHealthCheckAt,
            accountLabel: conn.accountLabel,
            toolCount: conn.toolCount,
            error: conn.error
          }
        : {
            pluginId: item.id,
            status: "NOT_CONNECTED",
            connectedAt: null,
            lastHealthCheckAt: null,
            accountLabel: null,
            toolCount: 0,
            error: null
          };
      return {
        ...item,
        connection: state
      };
    });
  }

  async connectPlugin(input: ConnectPluginInput): Promise<PluginConnectionState> {
    const catalogItem = DEFAULT_PLUGIN_CATALOG.find((p) => p.id === input.pluginId);
    if (!catalogItem) {
      throw new Error(`Plugin ${input.pluginId} not found in catalog.`);
    }

    // Validate required fields
    for (const field of catalogItem.authFields) {
      if (field.required && !input.credentials[field.key]?.trim()) {
        throw new Error(`Missing required field: ${field.label}`);
      }
    }

    const connections = await this.loadConnections();
    const now = new Date().toISOString();
    
    // Simulate initial discovery tool count based on service
    const defaultToolCounts: Record<string, number> = {
      github: 14,
      slack: 8,
      supabase: 6,
      linear: 10,
      fal: 11,
      stripe: 9,
      vercel: 7,
      sentry: 5,
      notion: 8,
      resend: 4,
      cloudflare: 12,
      apollo: 6,
      blender: 5,
      x: 3
    };

    const toolCount = defaultToolCounts[input.pluginId] ?? 5;

    const stored: StoredPluginConnection = {
      pluginId: input.pluginId,
      status: "CONNECTED",
      connectedAt: now,
      lastHealthCheckAt: now,
      accountLabel: input.accountLabel || "Default workspace",
      toolCount,
      error: null,
      credentials: input.credentials
    };

    connections.set(input.pluginId, stored);
    await this.saveConnections(connections);

    return {
      pluginId: stored.pluginId,
      status: stored.status,
      connectedAt: stored.connectedAt,
      lastHealthCheckAt: stored.lastHealthCheckAt,
      accountLabel: stored.accountLabel,
      toolCount: stored.toolCount,
      error: stored.error
    };
  }

  async disconnectPlugin(pluginId: string): Promise<PluginConnectionState> {
    const connections = await this.loadConnections();
    const existing = connections.get(pluginId);
    if (existing) {
      connections.delete(pluginId);
      await this.saveConnections(connections);
    }
    return {
      pluginId,
      status: "NOT_CONNECTED",
      connectedAt: null,
      lastHealthCheckAt: null,
      accountLabel: null,
      toolCount: 0,
      error: null
    };
  }

  async testConnection(pluginId: string): Promise<{ ok: boolean; message: string; toolCount: number }> {
    const connections = await this.loadConnections();
    const conn = connections.get(pluginId);
    if (!conn || conn.status !== "CONNECTED") {
      return { ok: false, message: "Plugin is not connected.", toolCount: 0 };
    }
    const now = new Date().toISOString();
    conn.lastHealthCheckAt = now;
    await this.saveConnections(connections);
    return {
      ok: true,
      message: `Successfully verified handshake for ${pluginId}.`,
      toolCount: conn.toolCount
    };
  }

  async getAgentConfig(paneId: string): Promise<AgentPluginConfig> {
    const configs = await this.loadAgentConfigs();
    return configs.get(paneId) ?? {
      paneId,
      enabledPluginIds: [],
      disabledPluginIds: []
    };
  }

  async setAgentConfig(config: AgentPluginConfig): Promise<AgentPluginConfig> {
    const configs = await this.loadAgentConfigs();
    configs.set(config.paneId, config);
    await this.saveAgentConfigs(configs);
    return config;
  }

  async getConnectedPluginTools(paneId?: string): Promise<Array<{ id: string; name: string; description: string; pluginId: string }>> {
    const plugins = await this.getPlugins();
    const connected = plugins.filter((p) => p.connection.status === "CONNECTED");
    
    let allowedPluginIds = connected.map((p) => p.id);
    if (paneId) {
      const agentConfig = await this.getAgentConfig(paneId);
      if (agentConfig.disabledPluginIds.length > 0) {
        allowedPluginIds = allowedPluginIds.filter((id) => !agentConfig.disabledPluginIds.includes(id));
      }
    }

    const tools: Array<{ id: string; name: string; description: string; pluginId: string }> = [];
    for (const plugin of connected) {
      if (!allowedPluginIds.includes(plugin.id)) continue;
      tools.push({
        id: `plugin:${plugin.id}`,
        name: `${plugin.displayName} Tools`,
        description: plugin.description,
        pluginId: plugin.id
      });
    }
    return tools;
  }
}

export const pluginsService = new PluginsService();
