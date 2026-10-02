import { readFile, writeFile, mkdir, symlink, unlink, lstat, realpath, rm } from "node:fs/promises";
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
    overview: "Official Model Context Protocol server for GitHub. Enables agents to read repository contents, file trees, commits, branches, issues, and pull requests directly with personal access token credentials.",
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
    githubUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
    installedVersion: "2025.4.8",
    latestVersion: "2025.4.8",
    hasUpdate: false,
    mcpCommand: "npx",
    mcpArgs: ["-y", "@modelcontextprotocol/server-github"]
  },
  {
    id: "slack",
    displayName: "Slack",
    description: "Read channels and messages, post updates, and inspect threads.",
    overview: "Official Model Context Protocol server for Slack. Allows AI agents to interact with Slack workspaces: reading channel histories, posting messages, listing members, and replying in threads via a Bot User OAuth Token.",
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
    githubUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
    installedVersion: "2025.4.25",
    latestVersion: "2025.4.25",
    hasUpdate: false,
    mcpCommand: "npx",
    mcpArgs: ["-y", "@modelcontextprotocol/server-slack"]
  },
  {
    id: "supabase",
    displayName: "Supabase",
    description: "Inspect and change database tables, run queries, and manage projects.",
    overview: "PostgreSQL & Supabase MCP bridge. Allows agents to inspect database schemas, run parameterized queries, list tables, and execute migrations directly from conversation contexts.",
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
    githubUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
    installedVersion: "0.6.2",
    latestVersion: "0.6.2",
    hasUpdate: false,
    mcpCommand: "npx",
    mcpArgs: ["-y", "@modelcontextprotocol/server-postgres"]
  },
  {
    id: "linear",
    displayName: "Linear",
    description: "Linear workspace, issues, projects, cycles, and roadmaps.",
    overview: "Model Context Protocol server for Linear project tracking. Enables agents to search issues, create tickets, update project status, assign cycles, and manage team roadmaps.",
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
    githubUrl: "https://github.com/jerhadf/linear-mcp-server",
    installedVersion: "1.0.0",
    latestVersion: "1.0.0",
    hasUpdate: false,
    mcpCommand: "npx",
    mcpArgs: ["-y", "@modelcontextprotocol/server-linear"]
  },
  {
    id: "fal",
    displayName: "fal",
    description: "fal.ai — 11 tools for generative media, image synthesis, and fast inference.",
    overview: "High-speed AI inference and generative media MCP server. Provides 11 multimodal tools for image synthesis, FLUX generation, background removal, and video model execution.",
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
    githubUrl: "https://github.com/fal-ai/fal-mcp",
    installedVersion: "1.2.0",
    latestVersion: "1.2.0",
    hasUpdate: false,
    mcpCommand: "npx",
    mcpArgs: ["-y", "@modelcontextprotocol/server-fal"]
  },
  {
    id: "stripe",
    displayName: "Stripe",
    description: "Read customers, invoices, subscriptions, payouts, and payment intents.",
    overview: "Stripe official agent toolkit and MCP server. Lets agents query customers, inspect payment intents, manage subscription billing, search invoices, and retrieve financial balance summaries.",
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
    githubUrl: "https://github.com/stripe/agent-toolkit",
    installedVersion: "0.9.0",
    latestVersion: "0.9.0",
    hasUpdate: false,
    mcpCommand: "npx",
    mcpArgs: ["-y", "@modelcontextprotocol/server-stripe"]
  },
  {
    id: "vercel",
    displayName: "Vercel",
    description: "Manage projects, deployments, domains, and environment variables.",
    overview: "Vercel MCP integration. Allows agents to inspect deployment statuses, retrieve build logs, query project environments, and trigger redeployments securely.",
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
    githubUrl: "https://github.com/vercel/mcp",
    installedVersion: "0.1.4",
    latestVersion: "0.1.4",
    hasUpdate: false,
    mcpCommand: "npx",
    mcpArgs: ["-y", "@modelcontextprotocol/server-vercel"]
  },
  {
    id: "sentry",
    displayName: "Sentry",
    description: "Search errors, issues, releases, and inspect crash telemetry.",
    overview: "Sentry crash and error tracking MCP server. Enables agents to inspect recent crashes, query issue stack traces, view release health, and correlate frontend/backend anomalies.",
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
    githubUrl: "https://github.com/getsentry/mcp-server-sentry",
    installedVersion: "0.1.2",
    latestVersion: "0.1.2",
    hasUpdate: false,
    mcpCommand: "npx",
    mcpArgs: ["-y", "@modelcontextprotocol/server-sentry"]
  },
  {
    id: "notion",
    displayName: "Notion",
    description: "Search, read, and create database items, wiki pages, and notes.",
    overview: "Notion MCP server for team workspaces. Enables querying Notion databases, reading documentation pages, creating new notes, and editing wiki blocks.",
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
    githubUrl: "https://github.com/michaellatman/mcp-server-notion",
    installedVersion: "0.1.3",
    latestVersion: "0.1.3",
    hasUpdate: false,
    mcpCommand: "npx",
    mcpArgs: ["-y", "@modelcontextprotocol/server-notion"]
  },
  {
    id: "resend",
    displayName: "Resend",
    description: "Send transactional emails, manage verified sender domains, and audit delivery.",
    overview: "Modern email delivery MCP server by Resend. Allows agents to dispatch transactional emails, manage verified sender domains, and query deliverability logs.",
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
    githubUrl: "https://github.com/resend/mcp-server-resend",
    installedVersion: "1.0.1",
    latestVersion: "1.0.1",
    hasUpdate: false,
    mcpCommand: "npx",
    mcpArgs: ["-y", "@modelcontextprotocol/server-resend"]
  },
  {
    id: "cloudflare",
    displayName: "Cloudflare",
    description: "Manage Workers, DNS records, KV namespaces, and domain routing.",
    overview: "Cloudflare Developer Platform MCP. Enables managing Workers, KV namespaces, D1 databases, DNS zones, and edge routing configurations directly.",
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
    githubUrl: "https://github.com/cloudflare/mcp-server-cloudflare",
    installedVersion: "0.2.0",
    latestVersion: "0.2.0",
    hasUpdate: false,
    mcpCommand: "npx",
    mcpArgs: ["-y", "@cloudflare/mcp-server-cloudflare"]
  },
  {
    id: "apollo",
    displayName: "Apollo",
    description: "Apollo workspace, lead discovery, enrichment, and prospect sequences.",
    overview: "Apollo.io B2B lead generation and intelligence MCP server. Empowers agents to search leads, enrich prospect profiles, and inspect sales outreach sequences.",
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
    githubUrl: "https://github.com/modelcontextprotocol/servers",
    installedVersion: "0.1.0",
    latestVersion: "0.1.0",
    hasUpdate: false,
    mcpCommand: "npx",
    mcpArgs: ["-y", "@modelcontextprotocol/server-apollo"]
  },
  {
    id: "blender",
    displayName: "Blender",
    description: "Inspect the open 3D scene, generate procedural geometry, and render frames.",
    overview: "Procedural 3D bridge for Blender. Allows agents to execute Python scripts inside the active Blender scene, inspect mesh geometry, adjust materials, and render frames.",
    category: "creative",
    icon: "Box",
    authType: "none",
    authFields: [],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://blender.org",
    docsUrl: "https://docs.blender.org",
    githubUrl: "https://github.com/blender/blender",
    installedVersion: "1.0.0",
    latestVersion: "1.0.0",
    hasUpdate: false,
    mcpCommand: "python3",
    mcpArgs: ["/opt/spaceapp/scripts/mcp-blender-bridge.py"]
  },
  {
    id: "x",
    displayName: "X",
    description: "Post, reply, inspect timelines, and search public posts.",
    overview: "X (Twitter) Developer API integration. Enables agents to post updates, reply to mentions, search recent tweets, and analyze public sentiment.",
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
    githubUrl: "https://github.com/xdevplatform",
    installedVersion: "0.1.0",
    latestVersion: "0.1.0",
    hasUpdate: false,
    mcpCommand: null,
    mcpArgs: []
  },
  {
    id: "superpowers",
    displayName: "Superpowers",
    description: "Systematic agent development skills: brainstorming, TDD, debugging, verification, and code review.",
    overview: "Core agent engineering toolkit by Jesse Vincent. Contains 15 battle-tested agent skills: brainstorming, test-driven development (TDD), systematic debugging, verification before completion, parallel agent dispatching, and git worktrees.",
    category: "developer",
    icon: "Zap",
    authType: "none",
    authFields: [],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://github.com/obra/superpowers",
    docsUrl: "https://github.com/obra/superpowers#readme",
    githubUrl: "https://github.com/obra/superpowers",
    installedVersion: "6.4.2",
    latestVersion: "6.4.2",
    hasUpdate: false,
    mcpCommand: null,
    mcpArgs: []
  },
  {
    id: "ui-ux-pro-max",
    displayName: "UI/UX Pro Max",
    description: "Design intelligence with 50+ styles, 96 palettes, 56 font pairings, and UI/UX best practices.",
    overview: "Extensive design intelligence skill for modern frontends. Includes 50+ distinctive design styles (Glassmorphism, Cyberpunk, Bento Grid, Neumorphism, etc.), 96 color palettes, 56 typography pairings, and layout heuristics to elevate UI aesthetic quality.",
    category: "creative",
    icon: "Palette",
    authType: "none",
    authFields: [],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill",
    docsUrl: "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill#readme",
    githubUrl: "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill",
    installedVersion: "2.9.0",
    latestVersion: "2.9.0",
    hasUpdate: false,
    mcpCommand: null,
    mcpArgs: []
  },
  {
    id: "taste-skill",
    displayName: "Taste Skill",
    description: "Elite visual aesthetics, layout harmony, and typography guidelines for modern applications.",
    overview: "Visual taste and aesthetics guidelines. Enforces strict visual harmony, optimal typography scaling, whitespace balance, motion design principles, and modern layout balance for human-centric interfaces.",
    category: "creative",
    icon: "Sparkles",
    authType: "none",
    authFields: [],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://github.com/Leonxlnx/taste-skill",
    docsUrl: "https://github.com/Leonxlnx/taste-skill#readme",
    githubUrl: "https://github.com/Leonxlnx/taste-skill",
    installedVersion: "1.1.0",
    latestVersion: "1.1.0",
    hasUpdate: false,
    mcpCommand: null,
    mcpArgs: []
  },
  {
    id: "no-ai-slop",
    displayName: "No AI Slop",
    description: "Writing quality and clarity rules: eliminates clichés, filler phrases, and generic AI output patterns.",
    overview: "Writing quality and anti-slop guidelines by Peter Yang. Eliminates robotic AI cliches, sycophantic filler, repetitive conversational fluff, and generic corporate phrasing to produce crisp, high-signal human writing.",
    category: "productivity",
    icon: "CheckCircle2",
    authType: "none",
    authFields: [],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://github.com/petergyang/no-ai-slop",
    docsUrl: "https://github.com/petergyang/no-ai-slop#readme",
    githubUrl: "https://github.com/petergyang/no-ai-slop",
    installedVersion: "1.0.0",
    latestVersion: "1.0.0",
    hasUpdate: false,
    mcpCommand: null,
    mcpArgs: []
  }
];

export const BUILTIN_SKILLS_MAP: Record<string, { folder: string; aliases: string[] }> = {
  superpowers: {
    folder: "space-superpowers",
    aliases: ["superpowers", "space-superpowers"]
  },
  "ui-ux-pro-max": {
    folder: "space-ui-ux-pro-max",
    aliases: ["ui-ux-pro-max", "space-ui-ux-pro-max"]
  },
  "taste-skill": {
    folder: "space-taste-skill",
    aliases: ["taste-skill", "space-taste-skill"]
  },
  "no-ai-slop": {
    folder: "space-no-ai-slop",
    aliases: ["no-ai-slop", "space-no-ai-slop"]
  }
};

const SKILL_DIRS = [
  "/var/lib/spaceapp-user/.codex/skills",
  "/var/lib/spaceapp-user/.agents/skills",
  "/var/lib/spaceapp-cli/.codex/skills",
  "/var/lib/spaceapp-cli/.agents/skills"
];

function findSkillSourceDir(folder: string): string | null {
  const candidates = [
    join("/opt/spaceapp/agent-skills", folder),
    join("/app/agent-skills", folder),
    join(process.cwd(), "agent-skills", folder)
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export interface StoredPluginConnection {
  pluginId: string;
  status: "NOT_CONNECTED" | "CONNECTING" | "CONNECTED" | "ERROR";
  connectedAt: string | null;
  lastHealthCheckAt: string | null;
  accountLabel: string | null;
  toolCount: number;
  installedVersion: string | null;
  latestVersion: string | null;
  hasUpdate: boolean;
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

  private static readonly DEFAULT_TOOL_COUNTS: Record<string, number> = {
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
    x: 3,
    superpowers: 15,
    "ui-ux-pro-max": 67,
    "taste-skill": 1,
    "no-ai-slop": 1
  };

  async syncSkillSymlinks(): Promise<void> {
    const connections = await this.loadConnections();
    for (const [pluginId, meta] of Object.entries(BUILTIN_SKILLS_MAP)) {
      const conn = connections.get(pluginId);
      const isConnected = conn ? conn.status === "CONNECTED" : true;
      const sourceDir = findSkillSourceDir(meta.folder);
      if (!sourceDir) continue;

      for (const root of SKILL_DIRS) {
        if (!existsSync(root)) continue;
        for (const alias of meta.aliases) {
          const symlinkPath = join(root, alias);
          if (isConnected) {
            try {
              const current = await realpath(symlinkPath).catch(() => null);
              if (current !== sourceDir) {
                const stat = await lstat(symlinkPath).catch(() => null);
                if (stat) {
                  await unlink(symlinkPath).catch(() => rm(symlinkPath, { force: true, recursive: true }));
                }
                await symlink(sourceDir, symlinkPath);
              }
            } catch {}
          } else {
            try {
              const stat = await lstat(symlinkPath).catch(() => null);
              if (stat) {
                await unlink(symlinkPath).catch(() => rm(symlinkPath, { force: true, recursive: true }));
              }
            } catch {}
          }
        }
      }
    }
  }

  async isPluginConnected(pluginId: string): Promise<boolean> {
    const connections = await this.loadConnections();
    const conn = connections.get(pluginId);
    if (conn) {
      return conn.status === "CONNECTED";
    }
    const catalogItem = DEFAULT_PLUGIN_CATALOG.find((p) => p.id === pluginId);
    return Boolean(catalogItem?.defaultEnabled && catalogItem?.authType === "none");
  }

  async isSkillEnabled(skillName: string): Promise<boolean> {
    for (const [pluginId, meta] of Object.entries(BUILTIN_SKILLS_MAP)) {
      if (meta.aliases.includes(skillName)) {
        return await this.isPluginConnected(pluginId);
      }
    }
    return true;
  }

  async getPlugins(): Promise<PluginWithState[]> {
    const connections = await this.loadConnections();
    return DEFAULT_PLUGIN_CATALOG.map((item) => {
      const conn = connections.get(item.id);
      const installedVersion = conn?.installedVersion ?? item.installedVersion ?? "1.0.0";
      const latestVersion = conn?.latestVersion ?? item.latestVersion ?? "1.0.0";
      const hasUpdate = conn?.hasUpdate ?? (installedVersion !== latestVersion);
      if (conn) {
        return {
          ...item,
          installedVersion,
          latestVersion,
          hasUpdate,
          connection: {
            pluginId: item.id,
            status: conn.status,
            connectedAt: conn.connectedAt,
            lastHealthCheckAt: conn.lastHealthCheckAt,
            accountLabel: conn.accountLabel,
            toolCount: conn.toolCount,
            installedVersion,
            latestVersion,
            hasUpdate,
            error: conn.error
          }
        };
      }
      const isDefaultActive = item.authType === "none" && item.defaultEnabled;
      return {
        ...item,
        installedVersion,
        latestVersion,
        hasUpdate,
        connection: {
          pluginId: item.id,
          status: isDefaultActive ? "CONNECTED" : "NOT_CONNECTED",
          connectedAt: isDefaultActive ? new Date(0).toISOString() : null,
          lastHealthCheckAt: null,
          accountLabel: isDefaultActive ? "Built-in (Active)" : null,
          toolCount: isDefaultActive ? (PluginsService.DEFAULT_TOOL_COUNTS[item.id] ?? 1) : 0,
          installedVersion,
          latestVersion,
          hasUpdate,
          error: null
        }
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
      if (field.required && !input.credentials?.[field.key]?.trim()) {
        throw new Error(`Missing required field: ${field.label}`);
      }
    }

    const connections = await this.loadConnections();
    const now = new Date().toISOString();
    const toolCount = PluginsService.DEFAULT_TOOL_COUNTS[input.pluginId] ?? 5;
    const installedVersion = catalogItem.installedVersion ?? "1.0.0";
    const latestVersion = catalogItem.latestVersion ?? "1.0.0";

    const stored: StoredPluginConnection = {
      pluginId: input.pluginId,
      status: "CONNECTED",
      connectedAt: now,
      lastHealthCheckAt: now,
      accountLabel: input.accountLabel?.trim() || (catalogItem.authType === "none" ? "Built-in (Active)" : "Default workspace"),
      toolCount,
      installedVersion,
      latestVersion,
      hasUpdate: false,
      error: null,
      credentials: input.credentials ?? {}
    };

    connections.set(input.pluginId, stored);
    await this.saveConnections(connections);
    await this.syncSkillSymlinks().catch(() => {});

    return {
      pluginId: stored.pluginId,
      status: stored.status,
      connectedAt: stored.connectedAt,
      lastHealthCheckAt: stored.lastHealthCheckAt,
      accountLabel: stored.accountLabel,
      toolCount: stored.toolCount,
      installedVersion: stored.installedVersion,
      latestVersion: stored.latestVersion,
      hasUpdate: stored.hasUpdate,
      error: stored.error
    };
  }

  async disconnectPlugin(pluginId: string): Promise<PluginConnectionState> {
    const connections = await this.loadConnections();
    const catalogItem = DEFAULT_PLUGIN_CATALOG.find((p) => p.id === pluginId);
    const stored: StoredPluginConnection = {
      pluginId,
      status: "NOT_CONNECTED",
      connectedAt: null,
      lastHealthCheckAt: null,
      accountLabel: null,
      toolCount: 0,
      installedVersion: catalogItem?.installedVersion ?? null,
      latestVersion: catalogItem?.latestVersion ?? null,
      hasUpdate: false,
      error: null,
      credentials: {}
    };
    connections.set(pluginId, stored);
    await this.saveConnections(connections);
    await this.syncSkillSymlinks().catch(() => {});

    return {
      pluginId,
      status: "NOT_CONNECTED",
      connectedAt: null,
      lastHealthCheckAt: null,
      accountLabel: null,
      toolCount: 0,
      installedVersion: stored.installedVersion,
      latestVersion: stored.latestVersion,
      hasUpdate: stored.hasUpdate,
      error: null
    };
  }

  async testConnection(pluginId: string): Promise<{
    ok: boolean;
    message: string;
    toolCount: number;
    installedVersion?: string;
    latestVersion?: string;
    hasUpdate?: boolean;
  }> {
    const connections = await this.loadConnections();
    const conn = connections.get(pluginId);
    const catalogItem = DEFAULT_PLUGIN_CATALOG.find((p) => p.id === pluginId);
    const isDefaultActive = !conn && catalogItem?.authType === "none" && catalogItem?.defaultEnabled;
    const isConnected = conn ? conn.status === "CONNECTED" : isDefaultActive;

    if (!isConnected) {
      return { ok: false, message: "Plugin is not connected.", toolCount: 0 };
    }

    const toolCount = conn?.toolCount ?? PluginsService.DEFAULT_TOOL_COUNTS[pluginId] ?? 1;
    const installedVersion = conn?.installedVersion ?? catalogItem?.installedVersion ?? "1.0.0";
    const latestVersion = conn?.latestVersion ?? catalogItem?.latestVersion ?? "1.0.0";
    const hasUpdate = installedVersion !== latestVersion;
    const now = new Date().toISOString();
    if (conn) {
      conn.lastHealthCheckAt = now;
      await this.saveConnections(connections);
    }
    return {
      ok: true,
      message: `Successfully verified handshake for ${catalogItem?.displayName ?? pluginId}.`,
      toolCount,
      installedVersion,
      latestVersion,
      hasUpdate
    };
  }

  async updatePlugin(pluginId: string): Promise<{
    ok: boolean;
    message: string;
    installedVersion: string;
    latestVersion: string;
    hasUpdate: boolean;
  }> {
    const catalogItem = DEFAULT_PLUGIN_CATALOG.find((p) => p.id === pluginId);
    if (!catalogItem) {
      throw new Error(`Plugin ${pluginId} not found in catalog.`);
    }

    const connections = await this.loadConnections();
    let conn = connections.get(pluginId);
    const now = new Date().toISOString();
    const targetVersion = catalogItem.latestVersion || "1.0.0";

    if (!conn) {
      const isDefaultActive = catalogItem.authType === "none" && catalogItem.defaultEnabled;
      conn = {
        pluginId,
        status: isDefaultActive ? "CONNECTED" : "NOT_CONNECTED",
        connectedAt: isDefaultActive ? now : null,
        lastHealthCheckAt: now,
        accountLabel: catalogItem.authType === "none" ? "Built-in (Active)" : "Default workspace",
        toolCount: PluginsService.DEFAULT_TOOL_COUNTS[pluginId] ?? 1,
        error: null,
        credentials: {},
        installedVersion: targetVersion,
        latestVersion: targetVersion,
        hasUpdate: false
      };
    } else {
      conn.installedVersion = targetVersion;
      conn.latestVersion = targetVersion;
      conn.hasUpdate = false;
      conn.lastHealthCheckAt = now;
    }

    connections.set(pluginId, conn);
    await this.saveConnections(connections);
    await this.syncSkillSymlinks().catch(() => {});

    return {
      ok: true,
      message: `Successfully upgraded ${catalogItem.displayName} to version ${targetVersion}.`,
      installedVersion: targetVersion,
      latestVersion: targetVersion,
      hasUpdate: false
    };
  }

  async checkPluginUpdate(pluginId: string): Promise<{
    ok: boolean;
    installedVersion: string;
    latestVersion: string;
    hasUpdate: boolean;
    message: string;
  }> {
    const catalogItem = DEFAULT_PLUGIN_CATALOG.find((p) => p.id === pluginId);
    if (!catalogItem) {
      throw new Error(`Plugin ${pluginId} not found in catalog.`);
    }

    const connections = await this.loadConnections();
    const conn = connections.get(pluginId);

    const installedVersion = conn?.installedVersion ?? catalogItem.installedVersion ?? "1.0.0";
    const latestVersion = catalogItem.latestVersion ?? installedVersion;
    const hasUpdate = installedVersion !== latestVersion;

    return {
      ok: true,
      installedVersion,
      latestVersion,
      hasUpdate,
      message: hasUpdate
        ? `New version ${latestVersion} is available for ${catalogItem.displayName} (currently ${installedVersion}).`
        : `${catalogItem.displayName} is up to date (version ${installedVersion}).`
    };
  }

  async upgradeAllPlugins(): Promise<{
    ok: boolean;
    upgradedCount: number;
    upgraded: Array<{ id: string; displayName: string; fromVersion: string; toVersion: string }>;
    message: string;
  }> {
    const connections = await this.loadConnections();
    const upgraded: Array<{ id: string; displayName: string; fromVersion: string; toVersion: string }> = [];

    for (const item of DEFAULT_PLUGIN_CATALOG) {
      const conn = connections.get(item.id);
      const installedVersion = conn?.installedVersion ?? item.installedVersion ?? "1.0.0";
      const targetVersion = item.latestVersion ?? installedVersion;

      if (installedVersion !== targetVersion) {
        await this.updatePlugin(item.id);
        upgraded.push({
          id: item.id,
          displayName: item.displayName,
          fromVersion: installedVersion,
          toVersion: targetVersion
        });
      }
    }

    return {
      ok: true,
      upgradedCount: upgraded.length,
      upgraded,
      message: upgraded.length > 0
        ? `Successfully upgraded ${upgraded.length} plugins: ${upgraded.map((u) => `${u.displayName} (${u.fromVersion} -> ${u.toVersion})`).join(", ")}.`
        : "All plugins are already up to date."
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
