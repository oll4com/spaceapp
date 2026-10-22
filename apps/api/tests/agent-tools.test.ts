import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import {
  applyAgentTools,
  buildAgentToolsCatalog,
  hideNestedCodexSkills,
  parseTomlMcpServers,
  parseTomlSkills,
  rewriteManagedToml
} from "../src/agent-tools.js";

const codexConfigFixture = `
default_model = "gpt-5.6-sol"

[features]
memories = true

[mcp_servers.devtools]
command = "/var/lib/spaceapp-user/scripts/codex_mcp_devtools.sh"

[mcp_servers.olla]
command = "/var/lib/spaceapp-user/scripts/codex_mcp_olla.sh"

[notice]
hide_full_access_warning = true

[[skills.config]]
path = "/var/lib/spaceapp-user/.codex/skills/doubt-driven-development/SKILL.md"
enabled = false
`;

const kimiMcpFixture = {
  mcpServers: {
    capturelab: { command: "/var/lib/spaceapp-user/scripts/codex_mcp_capturelab.sh", args: [], timeout: 15000 },
    olla: { command: "/var/lib/spaceapp-user/scripts/codex_mcp_olla.sh", args: [], timeout: 15000 }
  }
};

const qwenSettingsFixture = {
  context: { fileName: "AGENTS.md" },
  skills: { enabled: true },
  mcp: { allowed: ["capturelab", "olla"] },
  mcpServers: {
    capturelab: { command: "/var/lib/spaceapp-user/scripts/codex_mcp_capturelab.sh", args: [] },
    olla: { command: "/var/lib/spaceapp-user/scripts/codex_mcp_olla.sh", args: [] }
  }
};

const autohandConfigFixture = {
  mcp: {
    enabled: true,
    servers: [
      { name: "olla", transport: "stdio", command: "/var/lib/spaceapp-user/scripts/codex_mcp_olla.sh", args: [], autoConnect: true }
    ]
  }
};

const opencodeConfigFixture = {
  $schema: "https://opencode.ai/config.json",
  provider: {
    legacy: {
      npm: "@ai-sdk/openai-compatible",
      name: "Legacy"
    }
  }
};

const copilotMcpFixture = {
  mcpServers: {
    space_browser: { command: "/opt/spaceapp/scripts/space-browser-mcp.mjs" }
  }
};

describe("agent-tools", () => {
  let baseRoot: string;
  let configHome: string;
  let skillsRoot: string;
  let canonicalRoot: string;
  let options: {
    baseRoot: string;
    configHome: string;
    skillsRoot: string;
    canonicalRoot: string;
  };

  beforeEach(async () => {
    baseRoot = await mkdtemp(join(tmpdir(), "agent-tools-"));
    configHome = join(baseRoot, ".config/opencode");
    skillsRoot = join(baseRoot, ".codex/skills");
    canonicalRoot = join(baseRoot, "space-bin");
    options = { baseRoot, configHome, skillsRoot, canonicalRoot };
    await mkdir(configHome, { recursive: true });
    await mkdir(skillsRoot, { recursive: true });
    await mkdir(canonicalRoot, { recursive: true });

    await writeFile(join(baseRoot, ".codex/config.toml"), codexConfigFixture, "utf8");
    await mkdir(join(skillsRoot, "doubt-driven-development"), { recursive: true });
    await writeFile(
      join(skillsRoot, "doubt-driven-development/SKILL.md"),
      "---\nname: doubt-driven-development\ndescription: \"Doubt-driven development: subjects every non-trivial decision to a fresh-context adversarial review.\"\n---\n\n# Doubt-Driven Development\n\nBody text.\n",
      "utf8"
    );
    await mkdir(join(baseRoot, ".codex/space-kimi"), { recursive: true });
    await writeFile(join(baseRoot, ".codex/space-kimi/mcp.json"), JSON.stringify(kimiMcpFixture, null, 2), "utf8");
    await mkdir(join(baseRoot, ".codex/space-qwen"), { recursive: true });
    await writeFile(join(baseRoot, ".codex/space-qwen/settings.json"), JSON.stringify(qwenSettingsFixture, null, 2), "utf8");
    await mkdir(join(baseRoot, ".codex/space-autohand"), { recursive: true });
    await writeFile(join(baseRoot, ".codex/space-autohand/config.json"), JSON.stringify(autohandConfigFixture, null, 2), "utf8");
    await writeFile(join(configHome, "opencode.json"), JSON.stringify(opencodeConfigFixture, null, 2), "utf8");
    await mkdir(join(baseRoot, ".codex/space-copilot"), { recursive: true });
    await writeFile(join(baseRoot, ".codex/space-copilot/mcp-config.json"), JSON.stringify(copilotMcpFixture, null, 2), "utf8");
  });

  afterEach(async () => {
    await rm(baseRoot, { recursive: true, force: true });
  });

  it("parses TOML MCP servers and skills from a codex config", () => {
    const servers = parseTomlMcpServers(codexConfigFixture);
    expect([...servers.keys()].sort()).toEqual(["devtools", "olla"]);
    expect(servers.get("devtools")).toEqual({
      transport: "stdio",
      command: "/var/lib/spaceapp-user/scripts/codex_mcp_devtools.sh",
      args: undefined,
      url: null,
      env: undefined
    });

    const skills = parseTomlSkills(codexConfigFixture);
    expect(skills).toEqual([{ path: "/var/lib/spaceapp-user/.codex/skills/doubt-driven-development/SKILL.md", enabled: false }]);
  });

  it("rewrites managed TOML regions while preserving operator sections", () => {
    const rebuilt = rewriteManagedToml(codexConfigFixture, new Map(), []);
    expect(rebuilt).toContain("default_model = \"gpt-5.6-sol\"");
    expect(rebuilt).toContain("[features]");
    expect(rebuilt).toContain("[notice]");
    expect(rebuilt).not.toContain("[mcp_servers.devtools]");
    expect(rebuilt).not.toContain("[[skills.config]]");

    const withServers = rewriteManagedToml(
      codexConfigFixture,
      new Map([["devtools", { transport: "stdio", command: "/usr/bin/devtools", args: ["--x"], url: null, env: { A: "1" } }]]),
      []
    );
    expect(withServers).toContain("[mcp_servers.devtools]");
    expect(withServers).toContain("command = \"/usr/bin/devtools\"");
    expect(withServers).toContain("args = [\"--x\"]");
    expect(withServers).toContain("A = \"1\"");
    expect(withServers).toContain("hide_full_access_warning = true");
  });

  it("builds the catalog from on-disk configs with writable and read-only runtimes", async () => {
    const store = new InMemorySpaceStore();
    const catalog = await buildAgentToolsCatalog(store, options);

    const devtools = catalog.entries.find((entry) => entry.toolId === "mcp:devtools");
    expect(devtools).toBeDefined();
    expect(devtools?.sourceRuntimeIds).toContain("cli:codex");
    expect(devtools?.mcp?.command).toBe("/var/lib/spaceapp-user/scripts/codex_mcp_devtools.sh");

    const olla = catalog.entries.find((entry) => entry.toolId === "mcp:olla");
    expect(olla?.sourceRuntimeIds.sort()).toEqual(["cli:autohand", "cli:codex", "cli:kimi", "cli:qwen"]);

    const skill = catalog.entries.find((entry) => entry.toolId === "skill:doubt-driven-development");
    expect(skill).toBeDefined();
    expect(skill?.kind).toBe("SKILL");
    expect(skill?.skillPath).toContain("doubt-driven-development/SKILL.md");
    // The frontmatter description, not the `---` fence or the heading.
    expect(skill?.description).toBe("Doubt-driven development: subjects every non-trivial decision to a fresh-context adversarial review.");

    expect(catalog.runtimes.find((runtime) => runtime.runtimeId === "cli:deepseek")?.readOnly).toBe(true);
    expect(catalog.runtimes.find((runtime) => runtime.runtimeId === "cli:cursor")?.readOnly).toBe(true);
    expect(catalog.writableRuntimeIds).toContain("cli:codex");
    expect(catalog.writableRuntimeIds).not.toContain("cli:deepseek");

    const ollaCodexState = catalog.states.find((state) => state.runtimeId === "cli:codex" && state.toolId === "mcp:olla");
    const devtoolsState = catalog.states.filter((state) => state.toolId === "mcp:devtools");
    expect(ollaCodexState?.enabled).toBe(true);
    expect(devtoolsState.length).toBeGreaterThan(0);
    expect(devtoolsState.find((state) => state.runtimeId === "cli:codex")?.enabled).toBe(true);
    expect(devtoolsState.find((state) => state.runtimeId === "cli:kimi")?.enabled).toBe(false);
  });

  it("reads canonical OpenCode command arrays and preserves their format when applying assignments", async () => {
    await rm(join(configHome, "opencode.json"));
    const dispatcher = { type: "local", command: ["/usr/bin/node", "/opt/dispatcher.mjs", "--stdio"], environment: { TEST_MODE: "1" }, enabled: true };
    await writeFile(join(canonicalRoot, "opencode-space.json"), JSON.stringify({ ...opencodeConfigFixture, mcp: { mcp_dispatcher: dispatcher } }));
    const store = new InMemorySpaceStore();
    const catalog = await buildAgentToolsCatalog(store, options);
    expect(catalog.entries.find((entry) => entry.toolId === "mcp:mcp_dispatcher")?.mcp).toEqual({
      transport: "stdio", command: "/usr/bin/node", args: ["/opt/dispatcher.mjs", "--stdio"], url: null, env: { TEST_MODE: "1" }
    });
    await applyAgentTools(store, [{ toolId: "mcp:mcp_dispatcher", kind: "MCP", scope: "SPECIFIC", runtimeIds: ["cli:opencode"] }], options);
    const written = JSON.parse(await readFile(join(canonicalRoot, "opencode-space.json"), "utf8"));
    expect(written.mcp.mcp_dispatcher).toEqual(dispatcher);
    expect(written.provider).toEqual(opencodeConfigFixture.provider);
    expect((await buildAgentToolsCatalog(store, options)).entries.some((entry) => entry.toolId === "mcp:mcp_dispatcher")).toBe(true);
  }, 15_000);

  it("applies a COMMON assignment to every writable runtime config with backups", async () => {
    const store = new InMemorySpaceStore();
    const input = {
      toolId: "mcp:devtools",
      kind: "MCP" as const,
      scope: "COMMON" as const,
      runtimeIds: []
    };
    const result = await applyAgentTools(store, [input], options);

    const codex = result.results.find((runtime) => runtime.runtimeId === "cli:codex");
    expect(codex?.status).toBe("OK");
    expect(codex?.enabledMcpIds).toContain("mcp:devtools");

    const codexConfig = await readFile(join(baseRoot, ".codex/config.toml"), "utf8");
    expect(codexConfig).toContain("[mcp_servers.devtools]");
    expect(codexConfig).toContain("codex_mcp_devtools.sh");

    const kimiConfig = JSON.parse(await readFile(join(baseRoot, ".codex/space-kimi/mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(kimiConfig.mcpServers.devtools).toBeDefined();
    expect(kimiConfig.mcpServers.olla).toBeDefined();

    const qwenConfig = JSON.parse(await readFile(join(baseRoot, ".codex/space-qwen/settings.json"), "utf8")) as {
      mcp: { allowed: string[] };
      mcpServers: Record<string, unknown>;
    };
    expect(qwenConfig.mcpServers.devtools).toBeDefined();
    expect(qwenConfig.mcp.allowed).toContain("devtools");

    const autohandConfig = JSON.parse(await readFile(join(baseRoot, ".codex/space-autohand/config.json"), "utf8")) as {
      mcp: { servers: Array<{ name: string }> };
    };
    expect(autohandConfig.mcp.servers.some((server) => server.name === "devtools")).toBe(true);
    expect(autohandConfig.mcp.servers.some((server) => server.name === "olla")).toBe(true);

    const opencodeConfig = JSON.parse(await readFile(join(configHome, "opencode.json"), "utf8")) as {
      mcp?: Record<string, unknown>;
    };
    expect(opencodeConfig.mcp?.devtools).toBeDefined();
    expect(opencodeConfig.mcp?.olla).toBeUndefined();

    const backups = await import("node:fs/promises").then((m) =>
      m.readdir(join(baseRoot, ".codex")).then((entries) => entries.filter((entry) => entry.includes(".bak-space-agent-tools-")))
    );
    expect(backups.length).toBeGreaterThan(0);
  });

  it("disables a previously enabled server when scope becomes NONE", async () => {
    const store = new InMemorySpaceStore();
    await applyAgentTools(store, [{ toolId: "mcp:olla", kind: "MCP", scope: "COMMON", runtimeIds: [] }], options);
    await applyAgentTools(store, [{ toolId: "mcp:olla", kind: "MCP", scope: "NONE", runtimeIds: [] }], options);

    const codexConfig = await readFile(join(baseRoot, ".codex/config.toml"), "utf8");
    expect(codexConfig).not.toContain("[mcp_servers.olla]");
    expect(codexConfig).toContain("[mcp_servers.devtools]");

    const kimiConfig = JSON.parse(await readFile(join(baseRoot, ".codex/space-kimi/mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(kimiConfig.mcpServers.olla).toBeUndefined();
    expect(kimiConfig.mcpServers.capturelab).toBeDefined();
  });

  it("preserves operator-custom servers outside the catalog", async () => {
    const store = new InMemorySpaceStore();
    const withCustom = `
[features]
memories = true

[mcp_servers.my_custom_tool]
command = "/opt/custom/server.sh"

[mcp_servers.devtools]
command = "/var/lib/spaceapp-user/scripts/codex_mcp_devtools.sh"
`;
    await writeFile(join(baseRoot, ".codex/config.toml"), withCustom, "utf8");
    await applyAgentTools(store, [{ toolId: "mcp:devtools", kind: "MCP", scope: "NONE", runtimeIds: [] }], options);

    const codexConfig = await readFile(join(baseRoot, ".codex/config.toml"), "utf8");
    expect(codexConfig).not.toContain("[mcp_servers.devtools]");
    expect(codexConfig).toContain("[mcp_servers.my_custom_tool]");
    expect(codexConfig).toContain("/opt/custom/server.sh");
  });

  it("applies a SPECIFIC assignment to only the listed runtimes", async () => {
    const store = new InMemorySpaceStore();
    await applyAgentTools(
      store,
      [{ toolId: "mcp:devtools", kind: "MCP", scope: "SPECIFIC", runtimeIds: ["cli:codex", "cli:kimi"] }],
      options
    );

    const codexConfig = await readFile(join(baseRoot, ".codex/config.toml"), "utf8");
    expect(codexConfig).toContain("[mcp_servers.devtools]");

    const opencodeConfig = JSON.parse(await readFile(join(configHome, "opencode.json"), "utf8")) as {
      mcp?: Record<string, unknown>;
    };
    expect(opencodeConfig.mcp?.devtools).toBeUndefined();

    const kimiConfig = JSON.parse(await readFile(join(baseRoot, ".codex/space-kimi/mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(kimiConfig.mcpServers.devtools).toBeDefined();
  });

  it("updates skill enabled state in the codex config", async () => {
    const store = new InMemorySpaceStore();
    await applyAgentTools(
      store,
      [{ toolId: "skill:doubt-driven-development", kind: "SKILL", scope: "COMMON", runtimeIds: [] }],
      options
    );

    const codexConfig = await readFile(join(baseRoot, ".codex/config.toml"), "utf8");
    expect(codexConfig).toContain("doubt-driven-development/SKILL.md");
    expect(codexConfig).not.toContain("doubt-driven-development/SKILL.md\"\nenabled = false");
  });

  it("disables nested bundle sub-skills for Codex once, keeps the operator's entries and survives an apply", async () => {
    const bundle = join(skillsRoot, "space-gstack");
    for (const dir of ["office-hours", "retro/deep", ".hidden/skip"]) await mkdir(join(bundle, dir), { recursive: true });
    await writeFile(join(bundle, "SKILL.md"), "---\nname: space-gstack\ndescription: Index.\n---\n");
    for (const dir of ["office-hours", "retro/deep", ".hidden/skip"]) await writeFile(join(bundle, dir, "SKILL.md"), `---\nname: ${dir.split("/").at(-1)}\ndescription: Sub.\n---\n`);
    const configPath = join(baseRoot, ".codex/config.toml");
    await writeFile(configPath, `${codexConfigFixture}\n[[skills.config]]\npath = "${join(bundle, "office-hours/SKILL.md")}"\nenabled = true\n`);

    expect(await hideNestedCodexSkills(options)).toBe(1);
    const skills = parseTomlSkills(await readFile(configPath, "utf8"));
    expect(skills.find((entry) => entry.path === join(bundle, "office-hours/SKILL.md"))?.enabled).toBe(true);
    expect(skills.find((entry) => entry.path === join(bundle, "retro/deep/SKILL.md"))?.enabled).toBe(false);
    expect(skills.some((entry) => entry.path.includes(".hidden") || entry.path === join(bundle, "SKILL.md"))).toBe(false);
    expect(await hideNestedCodexSkills(options)).toBe(0);

    await applyAgentTools(new InMemorySpaceStore(), [{ toolId: "skill:doubt-driven-development", kind: "SKILL", scope: "NONE", runtimeIds: [] }], options);
    const applied = parseTomlSkills(await readFile(configPath, "utf8"));
    expect(applied.find((entry) => entry.path === join(bundle, "retro/deep/SKILL.md"))?.enabled).toBe(false);
    expect(applied.find((entry) => entry.path === join(bundle, "office-hours/SKILL.md"))?.enabled).toBe(true);
  });

  it("disables an opencode skill with a permission.skill deny", async () => {
    const store = new InMemorySpaceStore();
    await applyAgentTools(
      store,
      [{ toolId: "skill:doubt-driven-development", kind: "SKILL", scope: "NONE", runtimeIds: [] }],
      options
    );

    const opencodeConfig = JSON.parse(await readFile(join(configHome, "opencode.json"), "utf8")) as {
      permission?: { skill?: Record<string, string> };
    };
    expect(opencodeConfig.permission?.skill?.["doubt-driven-development"]).toBe("deny");

    const codexConfig = await readFile(join(baseRoot, ".codex/config.toml"), "utf8");
    expect(codexConfig).toContain("doubt-driven-development/SKILL.md\"\nenabled = false");
  });

  it("re-enables an opencode skill by removing its permission.skill deny", async () => {
    const store = new InMemorySpaceStore();
    await applyAgentTools(
      store,
      [{ toolId: "skill:doubt-driven-development", kind: "SKILL", scope: "NONE", runtimeIds: [] }],
      options
    );
    await applyAgentTools(
      store,
      [{ toolId: "skill:doubt-driven-development", kind: "SKILL", scope: "COMMON", runtimeIds: [] }],
      options
    );

    const opencodeConfig = JSON.parse(await readFile(join(configHome, "opencode.json"), "utf8")) as {
      permission?: { skill?: Record<string, string> };
    };
    expect(opencodeConfig.permission?.skill?.["doubt-driven-development"]).toBeUndefined();

    const codexConfig = await readFile(join(baseRoot, ".codex/config.toml"), "utf8");
    expect(codexConfig).toContain("doubt-driven-development/SKILL.md");
    expect(codexConfig).not.toContain("doubt-driven-development/SKILL.md\"\nenabled = false");
  });

  it("reads Claude skill visibility from skillOverrides in the canonical --settings file", async () => {
    await writeFile(
      join(canonicalRoot, "claude-space-settings.json"),
      JSON.stringify({ effortLevel: "xhigh", skillOverrides: { "doubt-driven-development": "off" } }, null, 2),
      "utf8"
    );
    const catalog = await buildAgentToolsCatalog(new InMemorySpaceStore(), options);

    const state = catalog.states.find(
      (entry) => entry.runtimeId === "cli:claude" && entry.toolId === "skill:doubt-driven-development"
    );
    expect(state?.enabled).toBe(false);
  });

  it("toggles a Claude skill through skillOverrides like a Codex skills.config entry", async () => {
    const settingsPath = join(canonicalRoot, "claude-space-settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({ effortLevel: "xhigh", skillOverrides: { "external-skill": "name-only" } }, null, 2),
      "utf8"
    );
    const store = new InMemorySpaceStore();

    await applyAgentTools(
      store,
      [{ toolId: "skill:doubt-driven-development", kind: "SKILL", scope: "NONE", runtimeIds: [] }],
      options
    );
    let settings = JSON.parse(await readFile(settingsPath, "utf8")) as { effortLevel: string; skillOverrides: Record<string, string> };
    expect(settings.effortLevel).toBe("xhigh");
    expect(settings.skillOverrides).toEqual({ "doubt-driven-development": "off", "external-skill": "name-only" });
    expect(await readFile(join(baseRoot, ".codex/config.toml"), "utf8")).toContain("doubt-driven-development/SKILL.md\"\nenabled = false");

    await applyAgentTools(
      store,
      [{ toolId: "skill:doubt-driven-development", kind: "SKILL", scope: "SPECIFIC", runtimeIds: ["cli:codex", "cli:claude"] }],
      options
    );
    settings = JSON.parse(await readFile(settingsPath, "utf8")) as typeof settings;
    expect(settings.skillOverrides).toEqual({ "external-skill": "name-only" });

    await writeFile(settingsPath, JSON.stringify({ effortLevel: "xhigh" }, null, 2), "utf8");
    await applyAgentTools(
      store,
      [{ toolId: "skill:doubt-driven-development", kind: "SKILL", scope: "COMMON", runtimeIds: [] }],
      options
    );
    settings = JSON.parse(await readFile(settingsPath, "utf8")) as typeof settings;
    // An empty object still marks the set as Space-owned, so a deploy never re-seeds it.
    expect(settings.skillOverrides).toEqual({});
  });

  it("does not create Claude settings when the Claude runtime files are not installed", async () => {
    const result = await applyAgentTools(
      new InMemorySpaceStore(),
      [{ toolId: "skill:doubt-driven-development", kind: "SKILL", scope: "NONE", runtimeIds: [] }],
      options
    );

    await expect(readFile(join(canonicalRoot, "claude-space-settings.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const claude = result.results.find((entry) => entry.runtimeId === "cli:claude");
    expect(claude?.files.some((file) => file.path.endsWith("claude-space-settings.json"))).toBe(false);
  });

  it("treats opencode skills with a deny as disabled in the catalog", async () => {
    await writeFile(
      join(configHome, "opencode.json"),
      JSON.stringify(
        {
          ...opencodeConfigFixture,
          permission: { skill: { "doubt-driven-development": "deny" } }
        },
        null,
        2
      ),
      "utf8"
    );
    const store = new InMemorySpaceStore();
    const catalog = await buildAgentToolsCatalog(store, options);

    const state = catalog.states.find(
      (entry) => entry.runtimeId === "cli:opencode" && entry.toolId === "skill:doubt-driven-development"
    );
    expect(state?.enabled).toBe(false);
  });
});
