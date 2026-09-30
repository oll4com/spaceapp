/** Public SpaceApp facts only. No operator memory, runtime state or internal infrastructure. */
export interface PublicSpaceappFact {
  id: string;
  version: string;
  source: string;
  keywords: string[];
  answer: string;
}

export const PUBLIC_SPACEAPP_KNOWLEDGE: readonly PublicSpaceappFact[] = [
  {
    id: "overview", version: "1", source: "README.md#what-spaceapp-provides",
    keywords: ["spaceapp", "what", "about", "self-hosted", "workspace"],
    answer: "SpaceApp is a self-hosted workspace for running AI coding CLIs in isolated rooms. The owner connects provider accounts and explicitly registers workspaces."
  },
  {
    id: "install", version: "1", source: "README.md#one-command-installation",
    keywords: ["install", "setup", "linux", "macos", "windows", "requirements"],
    answer: "The public installer supports Linux, macOS and Windows 11. The documented command is npx --yes run-spaceapp@latest install. Node.js 20.11 or newer is required."
  },
  {
    id: "rooms", version: "1", source: "README.md#what-spaceapp-provides",
    keywords: ["room", "rooms", "pane", "panes", "session"],
    answer: "Rooms organize work; panes hold independent CLI or app sessions inside a room. SpaceApp keeps provider state and sessions persistent."
  },
  {
    id: "providers", version: "1", source: "README.md#what-spaceapp-provides",
    keywords: ["provider", "model", "opencode", "codex", "gemini", "claude"],
    answer: "SpaceApp offers OpenCode, Codex, Gemini, Qwen Code, Kimi Code, Grok Build and experimental DeepSeek CLI runtimes. Claude Code has a separate owner-initiated installation flow."
  },
  {
    id: "memory", version: "1", source: "README.md#what-spaceapp-provides",
    keywords: ["memory", "remember", "private"],
    answer: "SpaceApp has persistent owner memory. The public streaming assistant uses only its separate, operator-approved streaming memory and cannot read personal owner memory."
  },
  {
    id: "live", version: "1", source: "docs/live-control-upgrade-plan.md#summary",
    keywords: ["live", "voice", "talk", "audio"],
    answer: "The Live pane supports voice interaction with the owner. Public streaming use must be explicitly selected and receives a restricted public context."
  },
  {
    id: "streaming", version: "1", source: "packages/contracts/src/streaming.ts",
    keywords: ["streaming", "overlay", "metrics", "youtube", "twitch", "discord", "tiktok", "social"],
    answer: "The Streaming dock connects social accounts and displays available account metrics. Its overlay can show selected metrics. Chat and moderation capabilities depend on each platform's supported API and granted permissions."
  },
  {
    id: "limits", version: "1", source: "README.md#architecture",
    keywords: ["limit", "security", "host", "access", "docker"],
    answer: "SpaceApp is designed for one trusted owner on one self-hosted instance. Only host workspaces explicitly registered by the owner are mounted."
  },
  {
    id: "setup", version: "1", source: "README.md#one-command-installation",
    keywords: ["first", "setup", "owner", "token", "connect", "login"],
    answer: "After installation passes readiness checks, the owner uses a one-time setup token to create the first account, register chosen workspaces and connect providers through official login flows or masked credential input."
  },
  {
    id: "hardware", version: "1", source: "README.md#one-command-installation",
    keywords: ["cpu", "ram", "memory", "disk", "hardware", "requirements"],
    answer: "The public installer requires at least 4 CPUs, 8 GB RAM and 15 GiB free disk. The standard browser profile recommends 8 CPUs, 16 GB RAM and 25 GiB free disk."
  },
  {
    id: "profiles", version: "1", source: "README.md#one-command-installation",
    keywords: ["light", "standard", "profile", "browser", "chromium"],
    answer: "The default light profile includes the CLIs, PostgreSQL and Temporal but omits managed Chromium. The standard profile adds the managed browser container."
  },
  {
    id: "backups", version: "1", source: "README.md#architecture",
    keywords: ["backup", "restore", "portable", "data", "database"],
    answer: "SpaceApp supports portable, checksummed backups of application data, PostgreSQL and owner memory. Provider credentials, login state, host workspace contents and browser profiles are excluded."
  },
  {
    id: "containers", version: "1", source: "README.md#architecture",
    keywords: ["docker", "container", "architecture", "services", "postgres", "temporal"],
    answer: "The launcher manages the core API and web app, CLI runtimes, PostgreSQL and Temporal; the standard profile also starts a browser container."
  },
  {
    id: "workspace", version: "1", source: "README.md#what-spaceapp-provides",
    keywords: ["workspace", "folder", "host", "mount", "readonly", "register"],
    answer: "Host folders are available only after the owner explicitly registers them as workspaces. Read-only mounts are supported."
  },
  {
    id: "privacy", version: "1", source: "README.md#what-spaceapp-provides",
    keywords: ["privacy", "private", "security", "personal", "owner"],
    answer: "SpaceApp runs on a self-hosted instance for one trusted owner. The public streaming assistant has separate reviewed memory and cannot access the owner's private data or credentials."
  }
];

export function searchPublicSpaceappKnowledge(query: string, limit = 3): PublicSpaceappFact[] {
  const words = new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  if (words.size === 0) return [];
  return PUBLIC_SPACEAPP_KNOWLEDGE.map(fact => ({ fact, score: fact.keywords.filter(word => words.has(word)).length }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.fact.id.localeCompare(b.fact.id))
    .slice(0, Math.max(1, Math.min(limit, 8)))
    .map(item => item.fact);
}

export function publicSpaceappContext(query: string): string {
  return searchPublicSpaceappKnowledge(query).map(fact => `[${fact.id} v${fact.version}; ${fact.source}] ${fact.answer}`).join("\n");
}
