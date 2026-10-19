import { describe, expect, it } from "vitest";
import {
  buildCliAgentBootstrapMarkdown,
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

  it("tells CLI agents to report their progress to Nous (plan clipboard:ot6-jLKOWDNC)", () => {
    expect(buildCliAgentBootstrapMarkdown()).toContain("node /opt/spaceapp/scripts/space-progress.mjs <started|progress|blocked|needs-decision|waiting|done|failed>");
    expect(buildSpaceAgentBootstrapPrompt({ channel: "WEB_CHAT" })).not.toContain("space-progress.mjs");
  });
});
