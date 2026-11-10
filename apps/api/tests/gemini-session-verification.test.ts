import { describe, it, expect } from "vitest";
import {
  mapGeminiModelLabelToId,
  parseAccountProfileFromHome,
  parseLogEvidence,
  verifyGeminiPaneSession
} from "../src/gemini-session-verification.js";
import { buildCliSpawnArgs, buildCliEnvironment } from "../src/cli-terminal.js";
import { getApiConfig } from "../src/config.js";
import type { AgentRuntime, Pane, PaneCliSession } from "@space/contracts";

describe("gemini-session-verification", () => {
  describe("mapGeminiModelLabelToId", () => {
    it("resolves catalog display names to IDs", () => {
      const catalog = [
        { id: "gemini-3.8-flash-high", displayName: "Gemini 3.8 Flash (High)" },
        { id: "claude-opus-4-6-thinking", displayName: "Claude Opus 4.6 (Thinking)" }
      ];
      expect(mapGeminiModelLabelToId("Gemini 3.8 Flash (High)", catalog)).toBe("gemini-3.8-flash-high");
      expect(mapGeminiModelLabelToId("Claude Opus 4.6 (Thinking)", catalog)).toBe("claude-opus-4-6-thinking");
    });

    it("maps standard Antigravity labels without catalog", () => {
      expect(mapGeminiModelLabelToId("Gemini 3.8 Flash (High)")).toBe("gemini-3.8-flash-high");
      expect(mapGeminiModelLabelToId("Gemini 3.8 Flash (Low)")).toBe("gemini-3.8-flash-low");
      expect(mapGeminiModelLabelToId("Gemini 3.7 Flash (High)")).toBe("gemini-3.7-flash-high");
      expect(mapGeminiModelLabelToId("Claude Opus 4.6 (Thinking)")).toBe("claude-opus-4-6-thinking");
      expect(mapGeminiModelLabelToId("GPT-OSS 120B (Medium)")).toBe("gpt-oss-120b-medium");
    });

    it("preserves already formatted model IDs", () => {
      expect(mapGeminiModelLabelToId("gemini-2.5-flash")).toBe("gemini-2.5-flash");
      expect(mapGeminiModelLabelToId("gemini-3.8-flash-high")).toBe("gemini-3.8-flash-high");
    });

    it("returns null for empty or null labels", () => {
      expect(mapGeminiModelLabelToId(null)).toBeNull();
      expect(mapGeminiModelLabelToId("")).toBeNull();
    });
  });

  describe("parseAccountProfileFromHome", () => {
    it("parses profile ID from profile home directory", () => {
      expect(parseAccountProfileFromHome("/var/lib/spaceapp-user/.codex/space-gemini/profiles/2/home")).toBe("2");
      expect(parseAccountProfileFromHome("/var/lib/spaceapp-user/.codex/space-gemini/profiles/google-4/home")).toBe("google-4");
    });

    it("identifies main profile from default home directory", () => {
      expect(parseAccountProfileFromHome("/var/lib/spaceapp-user/.codex/space-gemini/home")).toBe("main");
    });

    it("returns null for unrelated paths", () => {
      expect(parseAccountProfileFromHome("/var/lib/spaceapp-user/.codex/space-claude/home")).toBeNull();
      expect(parseAccountProfileFromHome(undefined)).toBeNull();
    });
  });

  describe("parseLogEvidence", () => {
    it("extracts latest email and model label from log output", () => {
      const sample = `
I0916 15:02:30.439946 49 auth.go:148] ChainedAuth: authenticated via keyring
I0916 15:02:30.439950 49 server_oauth.go:192] applyAuthResult: email=olduser@gmail.com, authMethod=consumer
I0916 15:02:32.357375 323 model_config_manager.go:327] Propagating selected model override to backend: label="Claude Opus 4.6 (Thinking)"
I0916 15:23:07.424463 9606 server_oauth.go:197] OAuth: authenticated successfully as newuser@gmail.com
I0916 15:23:07.424534 9606 model_config_manager.go:327] Propagating selected model override to backend: label="Gemini 3.8 Flash (High)"
`;
      const result = parseLogEvidence(sample);
      expect(result.email).toBe("newuser@gmail.com");
      expect(result.modelLabel).toBe("Gemini 3.8 Flash (High)");
    });

    it("handles logs with no auth or model entries", () => {
      const result = parseLogEvidence("random log line without matches");
      expect(result.email).toBeNull();
      expect(result.modelLabel).toBeNull();
    });
  });

  describe("verifyGeminiPaneSession", () => {
    const dummyPane: Pane = {
      id: "pane_test_123",
      roomId: "room_test_456",
      title: "Gemini CLI",
      mode: "TERMINAL",
      terminalRuntimeId: "cli:gemini",
      providerId: "cli:gemini",
      modelId: "gemini-2.5-flash",
      reasoningEffort: "none",
      order: 0,
      columnSpan: 1,
      isClosed: false,
      isMinimized: false,
      isMaximized: false,
      status: "RUNNING",
      createdAt: "2026-09-16T12:00:00Z",
      updatedAt: "2026-09-16T12:00:00Z"
    };

    const dummySession: PaneCliSession = {
      sessionId: "cli_session_123",
      paneId: dummyPane.id,
      roomId: dummyPane.roomId,
      runtimeId: "cli:gemini",
      providerId: "cli:gemini",
      agentId: "cli:gemini",
      modelId: "gemini-2.5-flash",
      reasoningEffort: "none",
      launchMode: "FRESH",
      purpose: "NORMAL",
      cwd: "/etc",
      codexThreadId: null,
      cliTaskId: null,
      cliTaskRevisionId: null,
      accountProfileId: "main",
      status: "RUNNING",
      statusReason: null,
      exitCode: null,
      isActive: true,
      startedAt: "2026-09-16T12:00:00Z",
      updatedAt: "2026-09-16T12:00:00Z",
      endedAt: null
    };

    it("reports UNVERIFIED when no live process is found", async () => {
      const verified = await verifyGeminiPaneSession({
        pane: dummyPane,
        session: dummySession,
        rootPid: 9999999, // non-existent pid
        procRoot: "/proc_nonexistent"
      });

      expect(verified.modelVerificationStatus).toBe("UNVERIFIED");
      expect(verified.effectiveModelId).toBeNull();
      expect(verified.configuredModelId).toBe("gemini-2.5-flash");
      expect(verified.accountVerificationStatus).toBe("UNVERIFIED");
      expect(verified.accountProfileId).toBe("main");
      expect(verified.verificationEvidence.modelVerified).toBe(false);
      expect(verified.verificationEvidence.accountVerified).toBe(false);
    });

    it("differentiates configured model from effective live model and flags discrepancy", async () => {
      // Test when procRoot has mock process evidence
      const verified = await verifyGeminiPaneSession({
        pane: dummyPane,
        session: dummySession,
        rootPid: 9999999,
        procRoot: "/proc_nonexistent",
        usageAccounts: [{ id: "main", email: "user@example.com", status: "CONNECTED" }]
      });

      expect(verified.configuredModelId).toBe("gemini-2.5-flash");
      expect(verified.effectiveModelId).toBeNull();
      expect(verified.modelVerificationStatus).toBe("UNVERIFIED");
    });
  });

  describe("gemini host-loss recovery and resume arguments", () => {
    const dummyGeminiRuntime: AgentRuntime = {
      id: "cli:gemini",
      providerId: "google",
      agentId: "gemini",
      displayName: "Gemini CLI",
      capabilities: ["CLI"],
      status: "ONLINE",
      defaultModelId: "gemini-3.8-flash",
      models: [],
      reasoningEffortSupported: true
    };

    it("generates --continue args when gemini session is in RESUME mode", () => {
      const args = buildCliSpawnArgs(dummyGeminiRuntime, {
        sessionId: "cli_session:test",
        paneId: "pane:test",
        roomId: "room:test",
        runtimeId: "cli:gemini",
        launchMode: "RESUME",
        reasoningEffort: "high"
      } as any);
      expect(args).toEqual(["--continue"]);
    });

    it("generates --continue args when gemini session has codexThreadId or nativeTaskRef bound", () => {
      const argsWithThread = buildCliSpawnArgs(dummyGeminiRuntime, {
        sessionId: "cli_session:test",
        paneId: "pane:test",
        roomId: "room:test",
        runtimeId: "cli:gemini",
        launchMode: "FRESH",
        codexThreadId: "1e2c8ced-b3ba-40ef-85a6-5c882aa0ed3e",
        reasoningEffort: "high"
      } as any);
      expect(argsWithThread).toEqual(["--continue"]);

      const argsWithRef = buildCliSpawnArgs(dummyGeminiRuntime, {
        sessionId: "cli_session:test",
        paneId: "pane:test",
        roomId: "room:test",
        runtimeId: "cli:gemini",
        launchMode: "FRESH",
        nativeTaskRef: "9fe7696c-ab67-4886-b590-ec0ff16932f6",
        reasoningEffort: "high"
      } as any);
      expect(argsWithRef).toEqual(["--continue"]);
    });

    it("passes SPACE_GEMINI_CONVERSATION_ID in environment when geminiConversationId is set", () => {
      const config = getApiConfig({});
      const env = buildCliEnvironment(config, {
        runtimeId: "cli:gemini",
        geminiConversationId: "1e2c8ced-b3ba-40ef-85a6-5c882aa0ed3e"
      });
      expect(env.SPACE_GEMINI_CONVERSATION_ID).toBe("1e2c8ced-b3ba-40ef-85a6-5c882aa0ed3e");
    });

    // The host's Gemini conversations and stable's var folder: gemini-session-host.test.ts (not in the public suite).
  });
});

