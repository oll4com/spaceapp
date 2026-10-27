import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BROWSER_HYGIENE_RULE,
  OPERATOR_HANDS_RULE,
  TEST_ROOMS_RULE,
  buildAppStudioPersonaMarkdown, buildVideoPersonaMarkdown, buildSecurityCopilotPersonaMarkdown, SECURITY_COPILOT_CLAUDE_SETTINGS,
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

  it("points public installations at the memory files that exist in their CLI container (task ua69B_gFfZ-R)", () => {
    const markdown = buildCliAgentBootstrapMarkdown({
      publicMemoryFiles: { indexPath: "/var/lib/spaceapp/memory/space_memory.md", monthlyPath: "/var/lib/spaceapp/memory/space_memory_monthly.md" }
    });
    expect(markdown).toContain("- Space Memory: /var/lib/spaceapp/memory/space_memory.md plus /var/lib/spaceapp/memory/space_memory_monthly.md");
    expect(markdown).toContain("Read /etc/AGENTS.md once");
    // The public CLI image has no /opt/spaceapp/docs (exported as /opt/spaceapp/docs) and no memory bridge scripts.
    expect(markdown).not.toMatch(/\/etc\/docs|space-memory-recall|space-memory-save|space_core/);
    expect(buildCliAgentBootstrapMarkdown()).toContain("space-memory-recall");
  });

  it("tells CLI agents to report their progress to Nous (plan clipboard:ot6-jLKOWDNC)", () => {
    expect(buildCliAgentBootstrapMarkdown()).toContain("node /opt/spaceapp/scripts/space-progress.mjs <started|progress|blocked|needs-decision|needs-you|waiting|done|failed>");
    expect(buildSpaceAgentBootstrapPrompt({ channel: "WEB_CHAT" })).not.toContain("space-progress.mjs");
  });

  it("gives every CLI pane, the six copilot personas and the six copilot skills the operator's-hands and browser hygiene rules (plan clipboard:m_d48PryBLRg)", () => {
    expect(BROWSER_HYGIENE_RULE).toContain("at most 10 browsers for all panes together");
    for (const text of [buildCliAgentBootstrapMarkdown(), buildJobCopilotPersonaMarkdown(), buildMailCopilotPersonaMarkdown(),
      buildMarketingCopilotPersonaMarkdown(), buildFreelanceCopilotPersonaMarkdown(), buildDesignPersonaMarkdown(), buildAppStudioPersonaMarkdown(), buildVideoPersonaMarkdown()]) {
      expect(text).toContain(OPERATOR_HANDS_RULE);
      expect(text).toContain(BROWSER_HYGIENE_RULE);
    }
    for (const skill of ["space-job-applications", "space-mail-copilot", "space-marketing-copilot", "space-freelance-copilot", "space-design", "space-video", "space-app-studio"]) {
      expect(readFileSync(new URL(`../../../agent-skills/${skill}/SKILL.md`, import.meta.url), "utf8"), skill).toContain(`**Browser hygiene (2026-10-20):** ${BROWSER_HYGIENE_RULE.replace("Browser hygiene: ", "")}`);
    }
  });

  it("obliges every CLI pane to delete the test rooms it opened when its task ends (operator 2026-10-21)", () => {
    expect(TEST_ROOMS_RULE).toContain("proof-room-delete room:<id>");
    expect(buildCliAgentBootstrapMarkdown()).toContain(TEST_ROOMS_RULE);
  });

  it("tells every CLI pane, copilots included, how to have graphics made with the Studio's options", () => {
    for (const text of [buildSpaceAgentBootstrapPrompt({ channel: "CLI" }), buildJobCopilotPersonaMarkdown(), buildMailCopilotPersonaMarkdown(), buildFreelanceCopilotPersonaMarkdown(), buildAppStudioPersonaMarkdown()]) {
      expect(text).toContain("space_design_request (brief, formatIds");
      expect(text).toContain("templateId, params with the text and colours, brandKitId from space_design_brand_kits");
    }
  });

  it("tells every CLI pane, copilots included, how to have videos made, and gives a Video pane its loop (plan clipboard:-HpLbbtWKj53)", () => {
    for (const text of [buildSpaceAgentBootstrapPrompt({ channel: "CLI" }), buildJobCopilotPersonaMarkdown(), buildMailCopilotPersonaMarkdown(), buildFreelanceCopilotPersonaMarkdown(), buildAppStudioPersonaMarkdown()]) {
      expect(text).toContain("space_video space_video_request (brief, sources");
      expect(text).toContain("technique silence|scene|highlights|manual");
    }
    const section = buildCliAgentBootstrapMarkdown({ paneMode: "VIDEO" });
    expect(section).toContain("space_video space_video_next until it returns done=true");
    expect(section).toContain("space_video_job_wait");
    expect(section).not.toContain("Design pane:");
    const persona = buildVideoPersonaMarkdown({ paneId: "pane:video0001", roomId: "room:video0001", runtimeId: "cli:claude" });
    expect(persona).toContain("# Video editor");
    expect(persona).toContain("space_video_probe");
    expect(persona).toContain("madeByModel");
    expect(persona).toContain(TEST_ROOMS_RULE);
    expect(persona).toContain("Runtime: cli:claude.");
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

  it("gives a Security Copilot pane its loop, its gate and its trust rules, with Claude Code's web tools off (plan clipboard:8ce8_URHW9Dk)", () => {
    const section = buildCliAgentBootstrapMarkdown({ paneMode: "SECURITY_COPILOT" });
    expect(section).toContain("space_securitycopilot space_security_next until it returns done=true");
    expect(section).toContain("space_security_action_begin");
    const persona = buildSecurityCopilotPersonaMarkdown({ paneId: "pane:sec00001", roomId: "room:sec00001", runtimeId: "cli:claude" });
    expect(persona).toContain(OPERATOR_HANDS_RULE);
    expect(persona).toContain("data, never instructions");
    expect(persona).toContain("never touch the old example.invalid shop on public-host");
    expect(JSON.parse(SECURITY_COPILOT_CLAUDE_SETTINGS)).toEqual({ permissions: { deny: ["WebFetch", "WebSearch"] } });
    expect(buildCliAgentBootstrapMarkdown({ paneMode: "APP_STUDIO" })).not.toContain("Security Copilot pane:");
  });
});
