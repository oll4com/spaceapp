import { readFile, readdir, writeFile, mkdir, symlink, unlink, lstat, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import {
  instanceBackgroundJobEnabled,
  type PluginCatalogItem,
  type PluginConnectionState,
  type PluginWithState,
  type ConnectPluginInput,
  type AgentPluginConfig
} from "@space/contracts";
import { parseSkillFrontmatter } from "@space/runtime";
import { instanceStorageDirectory } from "./instance-storage.js";

export const DEFAULT_PLUGIN_CATALOG: PluginCatalogItem[] = [
  {
    id: "gitea", displayName: "Gitea", description: "Connect your Gitea account and manage project source control.",
    overview: "Personal Gitea connection for repository discovery, diffs, staging, commits and synchronization.",
    category: "developer", icon: "GitBranch", authType: "api_key",
    authFields: [
      { key: "serverUrl", label: "Server URL", type: "url", required: false, placeholder: "https://example.invalid", description: "The Gitea server for your account." },
      { key: "token", label: "Personal Access Token", type: "password", required: true, placeholder: "", description: "Token with repository access. Permissions are checked for each selected repository." }
    ],
    preview: false, defaultEnabled: true, websiteUrl: "https://about.gitea.com", docsUrl: "https://docs.gitea.com", githubUrl: null,
    installedVersion: "1.0.0", latestVersion: "1.0.0", hasUpdate: false, mcpCommand: null, mcpArgs: []
  },
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
    installedVersion: "f5f6953",
    latestVersion: "f5f6953",
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
    installedVersion: "09170ee",
    latestVersion: "09170ee",
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
    installedVersion: "ce26fc2",
    latestVersion: "ce26fc2",
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
    installedVersion: "000650b",
    latestVersion: "000650b",
    hasUpdate: false,
    mcpCommand: null,
    mcpArgs: []
  },
  {
    id: "karpathy-guidelines",
    displayName: "Karpathy Guidelines",
    description: "Four coding principles: think before coding, simplicity first, surgical changes, and goal-driven execution.",
    overview: "Behavioral guidelines derived from Andrej Karpathy's observations on LLM coding pitfalls. Agents state assumptions before coding, write the minimum code that solves the problem, change only what the request needs, and turn tasks into verifiable success criteria.",
    category: "developer",
    icon: "Compass",
    authType: "none",
    authFields: [],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://github.com/multica-ai/andrej-karpathy-skills",
    docsUrl: "https://github.com/multica-ai/andrej-karpathy-skills#readme",
    githubUrl: "https://github.com/multica-ai/andrej-karpathy-skills",
    installedVersion: "2c60614",
    latestVersion: "2c60614",
    hasUpdate: false,
    mcpCommand: null,
    mcpArgs: []
  },
  {
    id: "mattpocock-skills",
    displayName: "Matt Pocock Skills",
    description: "Handoff documents between agents and CLIs, and Claude Code hooks that block destructive git commands.",
    overview: "Two skills by Matt Pocock. Handoff compacts the current work into a document another agent, pane, or CLI can continue from. Git Guardrails installs a Claude Code hook that blocks git push, reset --hard, clean, branch -D, and checkout/restore of the whole tree.",
    category: "productivity",
    icon: "Send",
    authType: "none",
    authFields: [],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://github.com/mattpocock/skills",
    docsUrl: "https://github.com/mattpocock/skills#readme",
    githubUrl: "https://github.com/mattpocock/skills",
    installedVersion: "49dd158",
    latestVersion: "49dd158",
    hasUpdate: false,
    mcpCommand: null,
    mcpArgs: []
  },
  {
    id: "context7",
    displayName: "Context7",
    description: "Current, version-specific library documentation and code examples for every CLI agent, on demand.",
    overview: "Upstash Context7 MCP server (resolve-library-id, query-docs) behind the Space MCP dispatcher. It starts only when a task needs library documentation and stops when idle. Queries go to the Context7 cloud, so agents send library names and questions only, never secrets or private code. Turning the plugin off blocks Context7 calls from every CLI.",
    category: "developer",
    icon: "BookOpen",
    authType: "none",
    authFields: [],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://context7.com",
    docsUrl: "https://github.com/upstash/context7#readme",
    githubUrl: "https://github.com/upstash/context7",
    installedVersion: "4.3.0",
    latestVersion: "4.3.0",
    hasUpdate: false,
    mcpCommand: "npx",
    mcpArgs: ["-y", "@upstash/context7-mcp@4.3.0"]
  },
  {
    id: "planning-with-files",
    displayName: "Planning with Files",
    description: "Persistent task_plan.md, findings.md and progress.md so a restarted CLI or another agent can pick up the work.",
    overview: "Manus-style working memory on disk by Ahmad Adi. Agents keep the plan, findings, errors and progress in three files and re-read them before decisions. In Space the files live in the task's scratch directory, never in the repository, and recover the task after a CLI restart, a pane-host restart or a handoff.",
    category: "productivity",
    icon: "Layers",
    authType: "none",
    authFields: [],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://github.com/OthmanAdi/planning-with-files",
    docsUrl: "https://github.com/OthmanAdi/planning-with-files#readme",
    githubUrl: "https://github.com/OthmanAdi/planning-with-files",
    installedVersion: "ff349eb",
    latestVersion: "ff349eb",
    hasUpdate: false,
    mcpCommand: null,
    mcpArgs: []
  },
  {
    id: "anthropic-skills",
    displayName: "Anthropic Skills",
    description: "Skill Creator for building, evaluating and tuning skills, and MCP Builder for well-designed MCP servers.",
    overview: "Two Apache-2.0 skills from Anthropic. Skill Creator drafts a skill, runs test prompts with and without it, grades and benchmarks the results, and tunes the description so the skill triggers reliably. MCP Builder guides tool design, schemas, pagination, errors and evaluations for MCP servers in TypeScript or Python.",
    category: "developer",
    icon: "Cpu",
    authType: "none",
    authFields: [],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://github.com/anthropics/skills",
    docsUrl: "https://github.com/anthropics/skills#readme",
    githubUrl: "https://github.com/anthropics/skills",
    installedVersion: "dbd4588",
    latestVersion: "dbd4588",
    hasUpdate: false,
    mcpCommand: null,
    mcpArgs: []
  },
  {
    id: "gstack",
    displayName: "gstack",
    description: "Garry Tan's office hours, CEO and engineering plan reviews, weekly retro, test-suite audit and release documentation audit.",
    overview: "Six workflow skills from gstack: office hours before any code, CEO-level and engineering plan reviews, a weekly engineering retrospective, a test value audit and a release documentation audit. Space ships them without gstack's preamble, telemetry, update checks or browser tools; outputs go to the reports directory and nothing commits, pushes or deploys on its own.",
    category: "developer",
    icon: "Activity",
    authType: "none",
    authFields: [],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://github.com/garrytan/gstack",
    docsUrl: "https://github.com/garrytan/gstack#readme",
    githubUrl: "https://github.com/garrytan/gstack",
    installedVersion: "e23f7b8",
    latestVersion: "e23f7b8",
    hasUpdate: false,
    mcpCommand: null,
    mcpArgs: []
  },
  {
    id: "wshobson-skills",
    displayName: "wshobson Skills",
    description: "Specialist skills for TypeScript and Node.js, threat modeling and SAST, incident runbooks and postmortems, and observability.",
    overview: "Seventeen skills from four wshobson/agents plugins: javascript-typescript (advanced types, modern patterns, Node.js backends, testing), security-scanning (STRIDE, attack trees, security requirements, mitigations, SAST setup), incident-response (runbooks, on-call handoffs, postmortems, connectivity triage) and observability-monitoring (Prometheus, Grafana, tracing, SLOs). Skills only; the plugins' agents and commands are not installed.",
    category: "developer",
    icon: "Box",
    authType: "none",
    authFields: [],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://github.com/wshobson/agents",
    docsUrl: "https://github.com/wshobson/agents#readme",
    githubUrl: "https://github.com/wshobson/agents",
    installedVersion: "46891e7",
    latestVersion: "46891e7",
    hasUpdate: false,
    mcpCommand: null,
    mcpArgs: []
  },
  {
    id: "huashu-design",
    displayName: "Huashu Design",
    description: "High-fidelity HTML prototypes, slide decks, motion design and design critique, starting from three design directions.",
    overview: "The huashu-design skill: clickable app prototypes and mockups, slide decks with PDF/PPTX export, motion design with MP4/GIF export, infographics and a five-dimension design critique. Every new design starts with three directions to choose from. Space ships it without its audio and showcase media; its ByteDance cloud helpers (video review, TTS) run only with the operator's consent and keys.",
    category: "creative",
    icon: "Palette",
    authType: "none",
    authFields: [],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://github.com/alchaincyf/huashu-design",
    docsUrl: "https://github.com/alchaincyf/huashu-design#readme",
    githubUrl: "https://github.com/alchaincyf/huashu-design",
    installedVersion: "0830494",
    latestVersion: "0830494",
    hasUpdate: false,
    mcpCommand: null,
    mcpArgs: []
  },
  {
    id: "impeccable",
    displayName: "Impeccable",
    description: "Frontend design quality: shaping, critique and audits, polish, typography, color, layout, motion, UX copy and live browser iteration.",
    overview: "The impeccable skill (version 4.5.2) with its pinned 0.1.14 engine: new-surface shaping, redesigns, critique and audits, polish, typography, color, layout, motion, UX copy, hardening and accessibility, plus live browser iteration on UI elements. Space preinstalls the engine with telemetry and update checks off; hooks and installers stay off without operator consent.",
    category: "creative",
    icon: "Palette",
    authType: "none",
    authFields: [],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://impeccable.style",
    docsUrl: "https://github.com/pbakaus/impeccable#readme",
    githubUrl: "https://github.com/pbakaus/impeccable",
    // The pinned upstream commit, like every built-in bundle (agent-skills/space-impeccable/UPSTREAM.md); the overview names the skill version.
    installedVersion: "919dbeb",
    latestVersion: "919dbeb",
    hasUpdate: false,
    mcpCommand: null,
    mcpArgs: []
  },
  {
    id: "google-workspace",
    displayName: "Google Workspace CLI",
    description: "Gmail, Drive, Calendar, Sheets, Docs, Slides, Chat, Meet and more through the gws CLI, with recipes and personas.",
    overview: "The googleworkspace/cli skills (95: one per service and helper, plus workflow recipes and personas) for the pinned gws 0.22.5 CLI installed on the host. The operator signs in once with gws; agents never run its auth commands or read its credentials, and sending, sharing or deleting needs the operator's approval of that exact action.",
    category: "productivity",
    icon: "Layers",
    authType: "none",
    authFields: [],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://github.com/googleworkspace/cli",
    docsUrl: "https://github.com/googleworkspace/cli#readme",
    githubUrl: "https://github.com/googleworkspace/cli",
    installedVersion: "a3768d0",
    latestVersion: "a3768d0",
    hasUpdate: false,
    mcpCommand: null,
    mcpArgs: []
  },
  {
    id: "hyperframes",
    displayName: "HyperFrames",
    description: "Video written as HTML: compositions, animation, captions, audio and slideshows rendered to MP4.",
    overview: "HeyGen's HyperFrames skills (21) for the pinned hyperframes 0.8.156 CLI installed on the host, rendering with the host's Chrome and ffmpeg. Telemetry, update checks, self-install and skill mirroring stay off; cloud providers, publishing and optional local models run only with the operator's consent.",
    category: "creative",
    icon: "Sparkles",
    authType: "none",
    authFields: [],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://hyperframes.heygen.com",
    docsUrl: "https://github.com/heygen-com/hyperframes#readme",
    githubUrl: "https://github.com/heygen-com/hyperframes",
    installedVersion: "d9edffa",
    latestVersion: "d9edffa",
    hasUpdate: false,
    mcpCommand: null,
    mcpArgs: []
  },
  {
    id: "claude-security",
    displayName: "Claude Security Review",
    description: "Anthropic's focused security review of the pending changes on a branch, with false-positive filtering.",
    overview: "The security review prompt from anthropics/claude-code-security-review (the /security-review command) for every CLI: injection, authentication and authorization, crypto and secrets, code execution and data exposure in the branch diff, keeping only high-confidence findings. Read-only: findings are reported in the conversation. The GitHub Action itself is not included.",
    category: "developer",
    icon: "CheckCircle2",
    authType: "none",
    authFields: [],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://github.com/anthropics/claude-code-security-review",
    docsUrl: "https://github.com/anthropics/claude-code-security-review#readme",
    githubUrl: "https://github.com/anthropics/claude-code-security-review",
    installedVersion: "0c6a49f",
    latestVersion: "0c6a49f",
    hasUpdate: false,
    mcpCommand: null,
    mcpArgs: []
  },
  {
    id: "openseo",
    displayName: "OpenSEO",
    description: "SEO workflows: keyword research, competitors, site audits, backlinks, local SEO, AI visibility and reports.",
    overview: "The OpenSEO plugin skills (12) from every-app/open-seo. Their data comes from the hosted OpenSEO MCP server, which the operator connects in their own CLI with an OpenSEO account; Space stores no OpenSEO credentials. Without that connection the skills stop and say so, and tools that spend credits ask first.",
    category: "analytics",
    icon: "Globe",
    authType: "none",
    authFields: [],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://openseo.so",
    docsUrl: "https://openseo.so/docs/mcp",
    githubUrl: "https://github.com/every-app/open-seo",
    installedVersion: "89e5a00",
    latestVersion: "89e5a00",
    hasUpdate: false,
    mcpCommand: null,
    mcpArgs: []
  },
  {
    id: "stripe-best-practices",
    displayName: "Stripe Best Practices",
    description: "Stripe's official guidance for planning, building and reviewing Stripe integrations.",
    overview: "The stripe-best-practices skill from stripe/ai: sandboxes and test mode, Checkout Sessions or PaymentIntents, Connect, Billing, Tax, Treasury, API migrations and key and webhook security. Space ships no Stripe MCP server and stores no Stripe key; live-mode actions need the operator's approval.",
    category: "finance",
    icon: "CreditCard",
    authType: "none",
    authFields: [],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://docs.stripe.com",
    docsUrl: "https://github.com/stripe/ai/tree/main/skills/stripe-best-practices",
    githubUrl: "https://github.com/stripe/ai",
    installedVersion: "789ef5e",
    latestVersion: "789ef5e",
    hasUpdate: false,
    mcpCommand: null,
    mcpArgs: []
  }
];

// One skill folder name per bundle (its frontmatter name). retiredAliases are the
// unprefixed names earlier releases also linked; the sync removes those links.
export const BUILTIN_SKILLS_MAP: Record<string, { folder: string; aliases: string[]; retiredAliases?: string[] }> = {
  superpowers: {
    folder: "space-superpowers",
    aliases: ["space-superpowers"],
    retiredAliases: ["superpowers"]
  },
  "ui-ux-pro-max": {
    folder: "space-ui-ux-pro-max",
    aliases: ["space-ui-ux-pro-max"],
    retiredAliases: ["ui-ux-pro-max"]
  },
  "taste-skill": {
    folder: "space-taste-skill",
    aliases: ["space-taste-skill"],
    retiredAliases: ["taste-skill"]
  },
  "no-ai-slop": {
    folder: "space-no-ai-slop",
    aliases: ["space-no-ai-slop"],
    retiredAliases: ["no-ai-slop"]
  },
  "karpathy-guidelines": {
    folder: "space-karpathy-guidelines",
    aliases: ["space-karpathy-guidelines"],
    retiredAliases: ["karpathy-guidelines"]
  },
  "mattpocock-skills": {
    folder: "space-mattpocock-skills",
    aliases: ["space-mattpocock-skills"],
    retiredAliases: ["mattpocock-skills"]
  },
  "planning-with-files": {
    folder: "space-planning-with-files",
    aliases: ["space-planning-with-files"],
    retiredAliases: ["planning-with-files"]
  },
  "anthropic-skills": {
    folder: "space-anthropic-skills",
    aliases: ["space-anthropic-skills"],
    retiredAliases: ["anthropic-skills"]
  },
  gstack: {
    folder: "space-gstack",
    aliases: ["space-gstack"],
    retiredAliases: ["gstack"]
  },
  "wshobson-skills": {
    folder: "space-wshobson-skills",
    aliases: ["space-wshobson-skills"],
    retiredAliases: ["wshobson-skills"]
  },
  "huashu-design": {
    folder: "space-huashu-design",
    aliases: ["space-huashu-design"]
  },
  impeccable: {
    folder: "space-impeccable",
    aliases: ["space-impeccable"]
  },
  "google-workspace": {
    folder: "space-google-workspace",
    aliases: ["space-google-workspace"]
  },
  hyperframes: {
    folder: "space-hyperframes",
    aliases: ["space-hyperframes"]
  },
  "claude-security": {
    folder: "space-claude-security",
    aliases: ["space-claude-security"]
  },
  openseo: {
    folder: "space-openseo",
    aliases: ["space-openseo"]
  },
  "stripe-best-practices": {
    folder: "space-stripe-best-practices",
    aliases: ["space-stripe-best-practices"]
  }
};

/**
 * Sub-skills below each bundle's index, as seen under one skill root. Codex and OpenCode
 * list every nested SKILL.md they find; Space keeps their catalogs to the bundle indexes.
 */
export async function nestedBundleSkills(root: string): Promise<Array<{ path: string; name: string }>> {
  const found: Array<{ path: string; name: string }> = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      // Codex scans six levels below a skill root.
      if (entry.isDirectory() && depth < 5) await walk(path, depth + 1);
      else if (entry.isFile() && entry.name === "SKILL.md" && depth > 0) {
        found.push({ path, name: parseSkillFrontmatter(await readFile(path, "utf8")).name || basename(dir) });
      }
    }
  };
  for (const { folder } of Object.values(BUILTIN_SKILLS_MAP)) await walk(join(root, folder), 0);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

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
  error: string | null;
  // Fields below exist only in files written by earlier releases; they are ignored and dropped on save.
  toolCount?: number;
  installedVersion?: string | null;
  latestVersion?: string | null;
  hasUpdate?: boolean;
  credentials?: Record<string, string>;
}

export class PluginsService {
  constructor(
    private readonly storageDirectory = instanceStorageDirectory("plugins"),
    private readonly syncSkills = instanceBackgroundJobEnabled(process.env, "plugin-skill-links"),
    private readonly skillDirs: readonly string[] = SKILL_DIRS
  ) {}
  private get connectionsFile() { return join(this.storageDirectory, "connections.json"); }
  private get agentConfigsFile() { return join(this.storageDirectory, "agent-configs.json"); }
  private async ensureDir(): Promise<void> {
    if (!existsSync(this.storageDirectory)) {
      await mkdir(this.storageDirectory, { recursive: true });
    }
  }

  private async loadConnections(): Promise<Map<string, StoredPluginConnection>> {
    await this.ensureDir();
    if (!existsSync(this.connectionsFile)) {
      return new Map();
    }
    try {
      const raw = await readFile(this.connectionsFile, "utf-8");
      const list = JSON.parse(raw) as StoredPluginConnection[];
      return new Map(list.map((c) => [c.pluginId, c]));
    } catch {
      return new Map();
    }
  }

  private async saveConnections(connections: Map<string, StoredPluginConnection>): Promise<void> {
    await this.ensureDir();
    const list = Array.from(connections.values()).map(({ pluginId, status, connectedAt, lastHealthCheckAt, accountLabel, error }) =>
      ({ pluginId, status, connectedAt, lastHealthCheckAt, accountLabel, error }));
    await writeFile(this.connectionsFile, JSON.stringify(list, null, 2), "utf-8");
  }

  private async loadAgentConfigs(): Promise<Map<string, AgentPluginConfig>> {
    await this.ensureDir();
    if (!existsSync(this.agentConfigsFile)) {
      return new Map();
    }
    try {
      const raw = await readFile(this.agentConfigsFile, "utf-8");
      const list = JSON.parse(raw) as AgentPluginConfig[];
      return new Map(list.map((c) => [c.paneId, c]));
    } catch {
      return new Map();
    }
  }

  private async saveAgentConfigs(configs: Map<string, AgentPluginConfig>): Promise<void> {
    await this.ensureDir();
    const list = Array.from(configs.values());
    await writeFile(this.agentConfigsFile, JSON.stringify(list, null, 2), "utf-8");
  }

  private static readonly DEFAULT_TOOL_COUNTS: Record<string, number> = {
    superpowers: 15,
    "ui-ux-pro-max": 1,
    "taste-skill": 13,
    "no-ai-slop": 1,
    "karpathy-guidelines": 1,
    "mattpocock-skills": 2,
    context7: 2,
    "planning-with-files": 1,
    "anthropic-skills": 2,
    gstack: 6,
    "wshobson-skills": 17,
    "huashu-design": 1,
    impeccable: 1,
    "google-workspace": 95,
    hyperframes: 21,
    "claude-security": 1,
    openseo: 12,
    "stripe-best-practices": 1
  };

  async syncSkillSymlinks(): Promise<void> {
    if (!this.syncSkills) return;
    const connections = await this.loadConnections();
    for (const [pluginId, meta] of Object.entries(BUILTIN_SKILLS_MAP)) {
      const conn = connections.get(pluginId);
      // Without a stored choice a bundle follows its catalog default (some start off).
      const isConnected = conn ? conn.status === "CONNECTED" : DEFAULT_PLUGIN_CATALOG.some((p) => p.id === pluginId && p.defaultEnabled);
      const sourceDir = findSkillSourceDir(meta.folder);
      if (!sourceDir) continue;

      for (const root of this.skillDirs) {
        if (!existsSync(root)) continue;
        for (const alias of meta.aliases) {
          const symlinkPath = join(root, alias);
          try {
            const stat = await lstat(symlinkPath).catch(() => null);
            // Only symbolic links are managed here. A real directory or file under an
            // alias name belongs to someone else and is never removed.
            if (stat && !stat.isSymbolicLink()) continue;
            const current = stat ? await realpath(symlinkPath).catch(() => null) : null;
            if (isConnected) {
              if (current === sourceDir) continue;
              if (stat) await unlink(symlinkPath);
              await symlink(sourceDir, symlinkPath);
            } else if (stat && (current === null || current === sourceDir)) {
              await unlink(symlinkPath);
            }
          } catch {}
        }
        for (const retired of meta.retiredAliases ?? []) {
          const retiredPath = join(root, retired);
          try {
            const stat = await lstat(retiredPath).catch(() => null);
            if (!stat?.isSymbolicLink()) continue;
            const current = await realpath(retiredPath).catch(() => null);
            if (current === null || current === sourceDir) await unlink(retiredPath);
          } catch {}
        }
      }
    }
    await this.onSkillsSynced?.();
  }

  /** Runs after every link sync; the stable API sets it to hide nested sub-skills from Codex. */
  onSkillsSynced?: () => Promise<unknown>;

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
      if (meta.aliases.includes(skillName) || meta.retiredAliases?.includes(skillName)) {
        return await this.isPluginConnected(pluginId);
      }
    }
    return true;
  }

  /** Version (pinned upstream commit) and skill count always come from the catalog, never from stored state. */
  private catalogFacts(item: PluginCatalogItem) {
    const version = item.installedVersion ?? null;
    return { installedVersion: version, latestVersion: version, hasUpdate: false, toolCount: PluginsService.DEFAULT_TOOL_COUNTS[item.id] ?? 1 };
  }

  private connectionState(item: PluginCatalogItem, conn: StoredPluginConnection | undefined): PluginConnectionState {
    const facts = this.catalogFacts(item);
    const isDefaultActive = item.authType === "none" && item.defaultEnabled;
    const connected = conn ? conn.status === "CONNECTED" : isDefaultActive;
    return {
      pluginId: item.id,
      status: conn ? conn.status : connected ? "CONNECTED" : "NOT_CONNECTED",
      connectedAt: conn ? conn.connectedAt : connected ? new Date(0).toISOString() : null,
      lastHealthCheckAt: conn?.lastHealthCheckAt ?? null,
      accountLabel: conn ? conn.accountLabel : connected ? "Built-in (Active)" : null,
      toolCount: connected ? facts.toolCount : 0,
      installedVersion: facts.installedVersion,
      latestVersion: facts.latestVersion,
      hasUpdate: false,
      error: conn?.error ?? null
    };
  }

  async getPlugins(): Promise<PluginWithState[]> {
    const connections = await this.loadConnections();
    return DEFAULT_PLUGIN_CATALOG.map((item) => {
      const conn = item.id === "github" || item.id === "gitea" ? undefined : connections.get(item.id);
      const facts = this.catalogFacts(item);
      return { ...item, installedVersion: facts.installedVersion ?? undefined, latestVersion: facts.latestVersion ?? undefined, hasUpdate: false,
        connection: this.connectionState(item, conn) };
    });
  }

  async connectPlugin(input: ConnectPluginInput): Promise<PluginConnectionState> {
    const catalogItem = DEFAULT_PLUGIN_CATALOG.find((p) => p.id === input.pluginId);
    if (!catalogItem) {
      throw new Error(`Plugin ${input.pluginId} not found in catalog.`);
    }
    for (const field of catalogItem.authFields) {
      if (field.required && !input.credentials?.[field.key]?.trim()) {
        throw new Error(`Missing required field: ${field.label}`);
      }
    }
    const connections = await this.loadConnections();
    const now = new Date().toISOString();
    // Credentials are never stored here: no installation plugin uses them, and
    // personal repository providers keep theirs in the source-control broker.
    connections.set(input.pluginId, {
      pluginId: input.pluginId,
      status: "CONNECTED",
      connectedAt: now,
      lastHealthCheckAt: now,
      accountLabel: input.accountLabel?.trim() || (catalogItem.authType === "none" ? "Built-in (Active)" : "Default workspace"),
      error: null
    });
    await this.saveConnections(connections);
    await this.syncSkillSymlinks().catch(() => {});
    return this.connectionState(catalogItem, connections.get(input.pluginId));
  }

  async disconnectPlugin(pluginId: string): Promise<PluginConnectionState> {
    const connections = await this.loadConnections();
    const catalogItem = DEFAULT_PLUGIN_CATALOG.find((p) => p.id === pluginId);
    connections.set(pluginId, { pluginId, status: "NOT_CONNECTED", connectedAt: null, lastHealthCheckAt: null, accountLabel: null, error: null });
    await this.saveConnections(connections);
    await this.syncSkillSymlinks().catch(() => {});
    if (!catalogItem) {
      return { pluginId, status: "NOT_CONNECTED", connectedAt: null, lastHealthCheckAt: null, accountLabel: null, toolCount: 0,
        installedVersion: null, latestVersion: null, hasUpdate: false, error: null };
    }
    return this.connectionState(catalogItem, connections.get(pluginId));
  }

  /** A real local check: a skill bundle's files, or the dispatcher backend's registration. */
  async testConnection(pluginId: string): Promise<{
    ok: boolean;
    message: string;
    toolCount: number;
    installedVersion?: string;
    latestVersion?: string;
    hasUpdate?: boolean;
  }> {
    const connections = await this.loadConnections();
    const catalogItem = DEFAULT_PLUGIN_CATALOG.find((p) => p.id === pluginId);
    if (!catalogItem) return { ok: false, message: "Plugin is not in the catalog.", toolCount: 0 };
    const state = this.connectionState(catalogItem, connections.get(pluginId));
    if (state.status !== "CONNECTED") return { ok: false, message: "Plugin is not connected.", toolCount: 0 };
    const version = state.installedVersion ?? undefined;
    const meta = BUILTIN_SKILLS_MAP[pluginId];
    let ok = true;
    let message = `${catalogItem.displayName} is enabled.`;
    if (meta) {
      const sourceDir = findSkillSourceDir(meta.folder);
      ok = Boolean(sourceDir && existsSync(join(sourceDir, "SKILL.md")));
      message = ok
        ? `${catalogItem.displayName}: ${state.toolCount} skill${state.toolCount === 1 ? "" : "s"} installed from ${sourceDir}${version ? `, upstream ${version}` : ""}.`
        : `${catalogItem.displayName}: the skill bundle ${meta.folder} is missing from this installation.`;
    } else if (pluginId === "context7") {
      message = "Context7 is enabled for agents. It starts on demand through the MCP dispatcher; this check does not contact the Context7 service.";
    }
    const conn = connections.get(pluginId);
    if (conn) {
      conn.lastHealthCheckAt = new Date().toISOString();
      await this.saveConnections(connections);
    }
    return { ok, message, toolCount: state.toolCount, installedVersion: version, latestVersion: version, hasUpdate: false };
  }

  private pinnedMessage(item: PluginCatalogItem | undefined): string {
    return item?.installedVersion
      ? `${item.displayName} is pinned to ${item.installedVersion} and updates with SpaceApp releases.`
      : `${item?.displayName ?? "This plugin"} updates with SpaceApp releases.`;
  }

  // Built-in plugins are pinned in the repository; there is nothing to update from here.
  async updatePlugin(pluginId: string): Promise<{
    ok: boolean;
    message: string;
    installedVersion: string;
    latestVersion: string;
    hasUpdate: boolean;
  }> {
    const item = DEFAULT_PLUGIN_CATALOG.find((p) => p.id === pluginId);
    if (!item) throw new Error(`Plugin ${pluginId} not found in catalog.`);
    const version = item.installedVersion ?? "";
    return { ok: true, message: this.pinnedMessage(item), installedVersion: version, latestVersion: version, hasUpdate: false };
  }

  async checkPluginUpdate(pluginId: string): Promise<{
    ok: boolean;
    installedVersion: string;
    latestVersion: string;
    hasUpdate: boolean;
    message: string;
  }> {
    const item = DEFAULT_PLUGIN_CATALOG.find((p) => p.id === pluginId);
    if (!item) throw new Error(`Plugin ${pluginId} not found in catalog.`);
    const version = item.installedVersion ?? "";
    return { ok: true, installedVersion: version, latestVersion: version, hasUpdate: false, message: this.pinnedMessage(item) };
  }

  async upgradeAllPlugins(): Promise<{
    ok: boolean;
    upgradedCount: number;
    upgraded: Array<{ id: string; displayName: string; fromVersion: string; toVersion: string }>;
    message: string;
  }> {
    return { ok: true, upgradedCount: 0, upgraded: [], message: "Built-in plugins are pinned and update with SpaceApp releases." };
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
