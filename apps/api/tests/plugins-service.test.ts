import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginsService, DEFAULT_PLUGIN_CATALOG, BUILTIN_SKILLS_MAP, pluginsService as sharedPluginsService, pluginsStorageRoot } from "../src/plugins-service.js";

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
let directory: string;
let pluginsService: PluginsService;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "space-plugins-"));
  pluginsService = new PluginsService(directory, false);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("PluginsService & MCP Ecosystem", () => {
  it("keeps the shared service's state in this test's own plugins folder, never stable's var", async () => {
    const root = pluginsStorageRoot();
    expect(root).toBe(process.env.SPACE_PLUGINS_DIR);
    expect(root).not.toMatch(/^\/opt\/spaceapp\/var(\/|$)/);
    await sharedPluginsService.setAgentConfig({ paneId: "pane:plugins-isolation", enabledPluginIds: [], disabledPluginIds: ["context7"] });
    expect(JSON.parse(await readFile(join(root, "agent-configs.json"), "utf8"))).toEqual([expect.objectContaining({ paneId: "pane:plugins-isolation" })]);
  });

  // The cases that need the install root's agent-skills (/opt/spaceapp or /app) or read the private deploy configs (OpenCode,
  // Grok, the dispatcher registry): plugins-service-host.test.ts.
  it("lists only plugins that are wired into Space", async () => {
    const ids = (await pluginsService.getPlugins()).map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["github", "gitea", "context7", ...Object.keys(BUILTIN_SKILLS_MAP)]));
    for (const unwired of ["slack", "supabase", "linear", "fal", "stripe", "vercel", "sentry", "notion", "resend", "cloudflare", "apollo", "blender", "x"]) {
      expect(ids).not.toContain(unwired);
    }
  });

  it("fails connection if required credentials are missing", async () => {
    await expect(
      pluginsService.connectPlugin({
        pluginId: "github",
        credentials: {}
      })
    ).rejects.toThrow("Missing required field: Personal Access Token");
  });

  it("supports per-agent plugin configuration overrides", async () => {
    const paneId = "pane:test-chat-room-1";

    const initialConfig = await pluginsService.getAgentConfig(paneId);
    expect(initialConfig.paneId).toBe(paneId);

    const updated = await pluginsService.setAgentConfig({
      paneId,
      enabledPluginIds: ["context7"],
      disabledPluginIds: ["github"]
    });

    expect(updated.disabledPluginIds).toContain("github");

    const reloaded = await pluginsService.getAgentConfig(paneId);
    expect(reloaded.disabledPluginIds).toEqual(["github"]);
  });

  it("shows each built-in skill bundle's pinned upstream commit and its real skill count", async () => {
    const { readdir } = await import("node:fs/promises");
    const plugins = await pluginsService.getPlugins();
    for (const [pluginId, meta] of Object.entries(BUILTIN_SKILLS_MAP)) {
      const folder = new URL(`../../../agent-skills/${meta.folder}/`, import.meta.url);
      const upstream = await readFile(new URL("UPSTREAM.md", folder), "utf8");
      const commit = /Commit: `([0-9a-f]{40})`/.exec(upstream)?.[1];
      const entries = await readdir(folder, { withFileTypes: true });
      const nested = (await Promise.all(entries.filter((entry) => entry.isDirectory())
        .map((entry) => readFile(new URL(`${entry.name}/SKILL.md`, folder)).then(() => 1, () => 0)))).reduce((a: number, b: number) => a + b, 0);
      const plugin = plugins.find((item) => item.id === pluginId);
      expect(commit, pluginId).toBeDefined();
      expect(plugin?.installedVersion, pluginId).toBe(commit!.slice(0, 7));
      expect(plugin?.latestVersion, pluginId).toBe(commit!.slice(0, 7));
      expect(plugin?.connection.toolCount, pluginId).toBe(nested || 1);
    }
  });

  it("auto-enables builtin skill plugins and allows toggling them via disconnect/connect", async () => {
    const plugins = await pluginsService.getPlugins();
    const superpowers = plugins.find((p) => p.id === "superpowers");
    const uiUx = plugins.find((p) => p.id === "ui-ux-pro-max");
    const taste = plugins.find((p) => p.id === "taste-skill");
    const noSlop = plugins.find((p) => p.id === "no-ai-slop");

    expect(superpowers).toBeDefined();
    expect(uiUx).toBeDefined();
    expect(taste).toBeDefined();
    expect(noSlop).toBeDefined();

    expect(superpowers?.connection.status).toBe("CONNECTED");
    expect(superpowers?.connection.accountLabel).toBe("Built-in (Active)");
    expect(superpowers?.connection.toolCount).toBe(15);

    expect(await pluginsService.isSkillEnabled("superpowers")).toBe(true);
    expect(await pluginsService.isSkillEnabled("space-superpowers")).toBe(true);

    // Disconnect superpowers
    const disc = await pluginsService.disconnectPlugin("superpowers");
    expect(disc.status).toBe("NOT_CONNECTED");
    expect(await pluginsService.isSkillEnabled("superpowers")).toBe(false);
    expect(await pluginsService.isSkillEnabled("space-superpowers")).toBe(false);

    // Reconnect superpowers
    const conn = await pluginsService.connectPlugin({
      pluginId: "superpowers",
      credentials: {}
    });
    expect(conn.status).toBe("CONNECTED");
    expect(await pluginsService.isSkillEnabled("superpowers")).toBe(true);
    expect(await pluginsService.isSkillEnabled("space-superpowers")).toBe(true);
  });

  it("provides overview, githubUrl and the pinned version; update and check-update report the pin", async () => {
    const plugins = await pluginsService.getPlugins();
    const uiUx = plugins.find((p) => p.id === "ui-ux-pro-max");
    expect(uiUx).toBeDefined();
    expect(uiUx?.overview).toBeTruthy();
    expect(uiUx?.githubUrl).toContain("github.com/nextlevelbuilder/ui-ux-pro-max-skill");
    expect(uiUx?.installedVersion).toBe("09170ee");
    expect(uiUx?.latestVersion).toBe("09170ee");

    const checkRes = await pluginsService.checkPluginUpdate("ui-ux-pro-max");
    expect(checkRes.ok).toBe(true);
    expect(checkRes.installedVersion).toBe("09170ee");

    const updateRes = await pluginsService.updatePlugin("ui-ux-pro-max");
    expect(updateRes.ok).toBe(true);
    expect(updateRes.message).toBe("UI/UX Pro Max is pinned to 09170ee and updates with SpaceApp releases.");

    const batchRes = await pluginsService.upgradeAllPlugins();
    expect(batchRes.ok).toBe(true);
  });

  it("ships the Karpathy Guidelines and Matt Pocock skills as active built-in plugins", async () => {
    const plugins = await pluginsService.getPlugins();
    const karpathy = plugins.find((p) => p.id === "karpathy-guidelines");
    const pocock = plugins.find((p) => p.id === "mattpocock-skills");

    expect(karpathy?.githubUrl).toBe("https://github.com/multica-ai/andrej-karpathy-skills");
    expect(karpathy?.connection.status).toBe("CONNECTED");
    expect(karpathy?.connection.toolCount).toBe(1);
    expect(pocock?.githubUrl).toBe("https://github.com/mattpocock/skills");
    expect(pocock?.connection.status).toBe("CONNECTED");
    expect(pocock?.connection.toolCount).toBe(2);

    expect(await pluginsService.isSkillEnabled("space-karpathy-guidelines")).toBe(true);
    expect(await pluginsService.isSkillEnabled("space-mattpocock-skills")).toBe(true);
    await pluginsService.disconnectPlugin("mattpocock-skills");
    expect(await pluginsService.isSkillEnabled("space-mattpocock-skills")).toBe(false);
    expect(await pluginsService.isSkillEnabled("mattpocock-skills")).toBe(false);
    expect(await pluginsService.isSkillEnabled("space-karpathy-guidelines")).toBe(true);
  });

  it("ships Planning with Files as an active built-in skill plugin", async () => {
    const plugins = await pluginsService.getPlugins();
    const planning = plugins.find((p) => p.id === "planning-with-files");
    expect(planning?.githubUrl).toBe("https://github.com/OthmanAdi/planning-with-files");
    expect(planning?.installedVersion).toBe("ff349eb");
    expect(planning?.connection.status).toBe("CONNECTED");
    expect(await pluginsService.isSkillEnabled("space-planning-with-files")).toBe(true);
    await pluginsService.disconnectPlugin("planning-with-files");
    expect(await pluginsService.isSkillEnabled("planning-with-files")).toBe(false);
  });

  it("ships Anthropic Skills without the proprietary document skills", async () => {
    const plugins = await pluginsService.getPlugins();
    const anthropic = plugins.find((p) => p.id === "anthropic-skills");
    expect(anthropic?.githubUrl).toBe("https://github.com/anthropics/skills");
    expect(anthropic?.connection.status).toBe("CONNECTED");
    expect(anthropic?.connection.toolCount).toBe(2);
    expect(await pluginsService.isSkillEnabled("space-anthropic-skills")).toBe(true);
    const root = new URL("../../../agent-skills/space-anthropic-skills/", import.meta.url);
    for (const license of ["skill-creator/LICENSE.txt", "mcp-builder/LICENSE.txt"]) {
      expect(await readFile(new URL(license, root), "utf8")).toContain("Apache License");
    }
    for (const proprietary of ["docx", "pdf", "pptx", "xlsx"]) {
      await expect(readFile(new URL(`${proprietary}/SKILL.md`, root), "utf8")).rejects.toThrow();
    }
  });

  it("ships the gstack subset without its preamble, telemetry or release skills", async () => {
    const plugins = await pluginsService.getPlugins();
    const gstack = plugins.find((p) => p.id === "gstack");
    expect(gstack?.githubUrl).toBe("https://github.com/garrytan/gstack");
    expect(gstack?.connection.status).toBe("CONNECTED");
    expect(gstack?.connection.toolCount).toBe(6);
    expect(await pluginsService.isSkillEnabled("space-gstack")).toBe(true);
    const root = new URL("../../../agent-skills/space-gstack/", import.meta.url);
    for (const skill of ["office-hours", "plan-ceo-review", "plan-eng-review", "retro", "test-audit", "document-release"]) {
      const text = await readFile(new URL(`${skill}/SKILL.md`, root), "utf8");
      expect(text.startsWith(`---\nname: ${skill}\n`)).toBe(true);
      expect(text).not.toMatch(/gstack-skill-start|~\/\.gstack|\.claude\/skills\/gstack|git push|gh pr |supabase/);
    }
    for (const excluded of ["ship", "land-and-deploy", "setup-browser-cookies", "pair-agent", "browse"]) {
      await expect(readFile(new URL(`${excluded}/SKILL.md`, root), "utf8")).rejects.toThrow();
    }
  });

  it("ships the marketingskills subset with the Space drafting rules in its index", async () => {
    const plugins = await pluginsService.getPlugins();
    const marketing = plugins.find((p) => p.id === "marketingskills");
    expect(marketing?.githubUrl).toBe("https://github.com/coreyhaines31/marketingskills");
    expect(marketing?.connection.toolCount).toBe(6);
    expect(await pluginsService.isSkillEnabled("space-marketingskills")).toBe(true);
    const root = new URL("../../../agent-skills/space-marketingskills/", import.meta.url);
    const index = await readFile(new URL("SKILL.md", root), "utf8");
    expect(index).toContain("space-no-ai-slop");
    const routed = [...index.matchAll(/\]\(([a-z-]+)\/SKILL\.md\)/g)].map((match) => match[1]);
    expect(routed).toEqual(["copywriting", "launch", "community-marketing", "directory-submissions", "ai-seo", "competitors"]);
    for (const skill of routed) {
      expect((await readFile(new URL(`${skill}/SKILL.md`, root), "utf8")).startsWith(`---\nname: ${skill}\n`)).toBe(true);
    }
  });

  it("ships the wshobson skills only, with every routed skill present", async () => {
    const plugins = await pluginsService.getPlugins();
    const wshobson = plugins.find((p) => p.id === "wshobson-skills");
    expect(wshobson?.githubUrl).toBe("https://github.com/wshobson/agents");
    expect(wshobson?.connection.toolCount).toBe(17);
    expect(await pluginsService.isSkillEnabled("space-wshobson-skills")).toBe(true);
    const root = new URL("../../../agent-skills/space-wshobson-skills/", import.meta.url);
    const index = await readFile(new URL("SKILL.md", root), "utf8");
    const routed = [...index.matchAll(/\]\(([a-z-]+)\/SKILL\.md\)/g)].map((match) => match[1]);
    expect(routed).toHaveLength(17);
    for (const skill of routed) {
      expect((await readFile(new URL(`${skill}/SKILL.md`, root), "utf8")).startsWith(`---\nname: ${skill}\n`)).toBe(true);
    }
    await expect(readFile(new URL("agents/typescript-pro.md", root), "utf8")).rejects.toThrow();
  });

  it("ships huashu-design with its references and scripts but without media", async () => {
    const plugins = await pluginsService.getPlugins();
    const huashu = plugins.find((p) => p.id === "huashu-design");
    expect(huashu?.githubUrl).toBe("https://github.com/alchaincyf/huashu-design");
    expect(huashu?.connection.toolCount).toBe(1);
    expect(await pluginsService.isSkillEnabled("space-huashu-design")).toBe(true);
    const root = new URL("../../../agent-skills/space-huashu-design/", import.meta.url);
    const index = await readFile(new URL("SKILL.md", root), "utf8");
    for (const [, link] of index.matchAll(/`(references\/[a-z-]+\.md)`/g)) {
      await expect(readFile(new URL(`huashu-design/${link}`, root), "utf8")).resolves.toBeTruthy();
    }
    expect((await readFile(new URL("huashu-design/SKILL.md", root), "utf8")).startsWith("---\nname: huashu-design\n")).toBe(true);
    expect(await readFile(new URL("UPSTREAM.md", root), "utf8")).toMatch(/0830494ecb1c117e25b313a8114fe55a6bf2b125[\s\S]*MIT License/);
    await expect(readFile(new URL("huashu-design/assets/bgm-tech.mp3", root))).rejects.toThrow();
  });

  it("ships impeccable with its launcher and the pinned engine contract", async () => {
    const plugins = await pluginsService.getPlugins();
    const impeccable = plugins.find((p) => p.id === "impeccable");
    expect(impeccable?.githubUrl).toBe("https://github.com/pbakaus/impeccable");
    expect(impeccable?.connection.toolCount).toBe(1);
    expect(await pluginsService.isSkillEnabled("space-impeccable")).toBe(true);
    const root = new URL("../../../agent-skills/space-impeccable/", import.meta.url);
    expect((await readFile(new URL("impeccable/SKILL.md", root), "utf8")).startsWith("---\nname: impeccable\n")).toBe(true);
    expect((await readFile(new URL("impeccable/scripts/VERSION", root), "utf8")).trim()).toBe("0.1.14");
    const upstream = await readFile(new URL("UPSTREAM.md", root), "utf8");
    expect(upstream).toMatch(/919dbeba520df760a157fe635be62faae88d58da/);
    expect(upstream).toMatch(/engine-v0\.1\.14[\s\S]*3d31ec1a664ac35c815ea1d7c10abad1155ce364d0f461157eb837a34368efb6/);
    expect(await readFile(new URL("LICENSE", root), "utf8")).toMatch(/Apache License/);
  });

  it("ships a skill folder named after every built-in skill plugin", async () => {
    for (const [pluginId, meta] of Object.entries(BUILTIN_SKILLS_MAP)) {
      expect(DEFAULT_PLUGIN_CATALOG.some((p) => p.id === pluginId)).toBe(true);
      expect(meta.aliases).toContain(meta.folder);
      const skill = await readFile(new URL(`../../../agent-skills/${meta.folder}/SKILL.md`, import.meta.url), "utf8");
      expect(skill.startsWith(`---\nname: ${meta.folder}\n`)).toBe(true);
    }
  });
});

