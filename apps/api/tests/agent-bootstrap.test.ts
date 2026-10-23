import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BROWSER_HYGIENE_RULE,
  OPERATOR_HANDS_RULE,
  buildAppStudioPersonaMarkdown,
  buildCliAgentBootstrapMarkdown,
  buildDesignPersonaMarkdown,
  buildFreelanceCopilotPersonaMarkdown,
  buildJobCopilotPersonaMarkdown,
  buildMailCopilotPersonaMarkdown,
  buildMarketingCopilotPersonaMarkdown,
  buildSpaceAgentBootstrapPrompt
} from "../src/agent-bootstrap.js";

describe("Space agent bootstrap", () => {
  it("uses Space MCP policy without the retired Coder Rooms catalog", () => {
    const prompt = buildSpaceAgentBootstrapPrompt({ channel: "WEB_CHAT" });
    const cliMarkdown = buildCliAgentBootstrapMarkdown();

    expect(prompt).not.toContain("discover/use tools through Space MCP policy only");
    expect(prompt).not.toContain("space-mcp-actions");
    expect(prompt).not.toContain("space-skill-actions");
    expect(prompt).not.toContain("space-memory-actions");
    expect(prompt).not.toContain("gemini_session_coder_rooms");
    expect(cliMarkdown).not.toContain("gemini_session_coder_rooms");
  });

  it("includes only selected bridge instructions without starting tool discovery", () => {
    const prompt = buildSpaceAgentBootstrapPrompt({ channel: "WEB_CHAT", selectedToolIds: ["skills:read"] });
    expect(prompt).toContain("space-skill-actions");
    expect(prompt).not.toContain("space-mcp-actions");
    expect(prompt).not.toContain("space-memory-actions");
  });

  it("points source-stack bootstrap memory guidance at the configured owned root", () => {
    const previousRoot = process.env.SPACE_MEMORY_ROOT;
    process.env.SPACE_MEMORY_ROOT = "/tmp/source-stack-owned-memory";
    try {
      const prompt = buildSpaceAgentBootstrapPrompt({ channel: "WEB_CHAT" });
      expect(prompt).toContain("/tmp/source-stack-owned-memory/gemini.md");
      expect(prompt).toContain("/tmp/source-stack-owned-memory/gemini_history.md");
      expect(prompt).toContain("Treat Space Memory in /tmp/source-stack-owned-memory as canonical");
      expect(prompt).toContain("native filesystem tools");
      expect(prompt).toContain("do not use an installed-instance memory bridge");
      expect(prompt).toContain("current source checkout's CONTRIBUTING.md");
      expect(prompt).not.toContain("Treat Space Memory in /opt/spaceapp/docs as canonical");
      expect(prompt).not.toContain("/opt/spaceapp/bin/space-memory");
    } finally {
      if (previousRoot === undefined) delete process.env.SPACE_MEMORY_ROOT;
      else process.env.SPACE_MEMORY_ROOT = previousRoot;
    }
  });

  it("keeps source CLI instructions off installed workspaces and task scripts", () => {
    const previousRoot = process.env.SPACE_MEMORY_ROOT;
    process.env.SPACE_MEMORY_ROOT = "/tmp/source-cli-owned-memory";
    try {
      const markdown = buildCliAgentBootstrapMarkdown();
      expect(markdown).toContain("Use the current source checkout for Space source-code tasks");
      expect(markdown).toContain("Read or write canonical Space Memory directly under the configured source-stack memory root");
      expect(markdown).toContain("native filesystem tools");
      expect(markdown).toContain("/tmp/source-cli-owned-memory");
      expect(markdown).toContain("never use an installed-instance memory bridge");
      expect(markdown).toContain("use verified Space API task capabilities for the current source stack");
      expect(markdown).not.toContain("/opt/spaceapp");
      expect(markdown).not.toContain("Treat /etc as the default operational workspace");
    } finally {
      if (previousRoot === undefined) delete process.env.SPACE_MEMORY_ROOT;
      else process.env.SPACE_MEMORY_ROOT = previousRoot;
    }
  });

  it("requires CLI agents to publish final deliverables without leaking inputs or secrets", () => {
    const cliMarkdown = buildCliAgentBootstrapMarkdown();
    const webPrompt = buildSpaceAgentBootstrapPrompt({ channel: "WEB_CHAT" });

    expect(cliMarkdown).toContain("space-publish-file <absolute-path>");
    expect(cliMarkdown).toContain("space-publish-file --media <absolute-path>");
    expect(cliMarkdown).toContain("ONLY create and publish an Agent File if the user EXPLICITLY requested");
    expect(cliMarkdown).toContain("Publish only final deliverables");
    expect(cliMarkdown).toContain("Never publish credentials, secrets, user inputs, temporary files, caches, logs, or whole source trees");
    expect(cliMarkdown).toContain("Confirm the command returned an Agent Files artifact id");
    expect(webPrompt).not.toContain("space-publish-file <absolute-path>");
  });

  it("tells CLI agents to report their progress to Nous (plan clipboard:ot6-jLKOWDNC)", () => {
    expect(buildCliAgentBootstrapMarkdown()).toContain("node /opt/spaceapp/scripts/space-progress.mjs <started|progress|blocked|needs-decision|waiting|done|failed>");
    expect(buildSpaceAgentBootstrapPrompt({ channel: "WEB_CHAT" })).not.toContain("space-progress.mjs");
  });

  it("gives every CLI pane, the six copilot personas and the six copilot skills the operator's-hands and browser hygiene rules (plan clipboard:m_d48PryBLRg)", () => {
    expect(BROWSER_HYGIENE_RULE).toContain("at most 10 browsers for all panes together");
    for (const text of [buildCliAgentBootstrapMarkdown(), buildJobCopilotPersonaMarkdown(), buildMailCopilotPersonaMarkdown(),
      buildMarketingCopilotPersonaMarkdown(), buildFreelanceCopilotPersonaMarkdown(), buildDesignPersonaMarkdown(), buildAppStudioPersonaMarkdown()]) {
      expect(text).toContain(OPERATOR_HANDS_RULE);
      expect(text).toContain(BROWSER_HYGIENE_RULE);
    }
    for (const skill of ["space-job-applications", "space-mail-copilot", "space-marketing-copilot", "space-freelance-copilot", "space-design", "space-app-studio"]) {
      expect(readFileSync(new URL(`../../../agent-skills/${skill}/SKILL.md`, import.meta.url), "utf8"), skill).toContain(`**Browser hygiene (2026-10-20):** ${BROWSER_HYGIENE_RULE.replace("Browser hygiene: ", "")}`);
    }
  });

  it("tells every CLI pane, copilots included, how to have graphics made with the Studio's options", () => {
    for (const text of [buildSpaceAgentBootstrapPrompt({ channel: "CLI" }), buildJobCopilotPersonaMarkdown(), buildMailCopilotPersonaMarkdown(), buildFreelanceCopilotPersonaMarkdown(), buildAppStudioPersonaMarkdown()]) {
      expect(text).toContain("space_design_request (brief, formatIds");
      expect(text).toContain("templateId, params with the text and colours, brandKitId from space_design_brand_kits");
    }
  });

  it("gives an App Studio pane its loop, its project folder and its preview tool (plan clipboard:v7hyZ76ThCyv)", () => {
    const section = buildCliAgentBootstrapMarkdown({ paneMode: "APP_STUDIO" });
    expect(section).toContain("space_appstudio space_appstudio_next until it returns done=true");
    expect(section).toContain("space_appstudio_preview");
    const persona = buildAppStudioPersonaMarkdown({ paneId: "pane:apps0001", roomId: "room:apps0001", runtimeId: "cli:claude" });
    expect(persona).toContain("$HOME/agent-workspace/app-studio/pane_apps0001/app");
    expect(persona).toContain("Never publish to Google Play or the App Store");
    expect(buildCliAgentBootstrapMarkdown({ paneMode: "DESIGN" })).not.toContain("App Studio pane:");
  });
});
