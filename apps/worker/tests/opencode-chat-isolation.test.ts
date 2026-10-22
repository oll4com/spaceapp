import { describe, expect, it } from "vitest";
import { openCodeSpaceChatStateRoot } from "@space/opencode-control";
import type { DummyTurnInput } from "@space/contracts";
import type { OpenCodeServerControl } from "@space/opencode-control";
import {
  classifyOpenCodeExecutorFailure,
  executeOpenCodeTurnPrompt,
  getOpenCodeAgentTurnActivityConfig,
  openCodeAgentTurnStateRoot
} from "../src/activities.js";

describe("OpenCode Chat state isolation", () => {
  it("uses the dedicated Chat root for agent sessions without falling back to CLI state", () => {
    const cliStateRoot = "/home/test/.codex/space-opencode/state";

    expect(openCodeAgentTurnStateRoot("agent_session:chat-one", cliStateRoot)).toBe(openCodeSpaceChatStateRoot);
    expect(openCodeAgentTurnStateRoot("agent_session:chat-two", cliStateRoot)).toBe(openCodeSpaceChatStateRoot);
    expect(openCodeAgentTurnStateRoot("cli_session:terminal-one", cliStateRoot)).toBe(cliStateRoot);
    expect(openCodeSpaceChatStateRoot).not.toBe(cliStateRoot);
  });

  it("fails a stuck provider turn within one minute by default", () => {
    expect(getOpenCodeAgentTurnActivityConfig({ SPACE_ENABLE_OPENCODE_TURNS: "true" }).messageTimeoutMs).toBe(60_000);
  });

  it("respects SPACE_OPENCODE_MESSAGE_TIMEOUT_MS when configured", () => {
    expect(getOpenCodeAgentTurnActivityConfig({ SPACE_ENABLE_OPENCODE_TURNS: "true", SPACE_OPENCODE_MESSAGE_TIMEOUT_MS: "900000" }).messageTimeoutMs).toBe(900_000);
  });

  it("classifies OpenCode executor timeout and failures accurately", () => {
    const timeoutFailure = classifyOpenCodeExecutorFailure(new Error("The operation was timed out"));
    expect(timeoutFailure.reasonCode).toBe("OPENCODE_TURN_TIMEOUT");
    expect(timeoutFailure.message).toContain("SPACE_OPENCODE_MESSAGE_TIMEOUT_MS");

    const genericFailure = classifyOpenCodeExecutorFailure(new Error("OpenCode message failed with HTTP 500."));
    expect(genericFailure.reasonCode).toBe("OPENCODE_EXECUTOR_FAILED");
    expect(genericFailure.message).toBe("OpenCode message failed with HTTP 500.");
  });

  it.each(["plan", "default"] as const)("sends %s to the native OpenCode agent selector", async collaborationMode => {
    const bodies: Record<string, unknown> = {};
    await executeOpenCodeTurnPrompt({ version: 1, spaceSessionId: "agent_session:test", nativeSessionId: "ses_test",
      serverPort: 47047, serverHost: "127.0.0.1", serverUsername: "test", serverPassword: "test", updatedAt: "2026-09-07T00:00:00Z" },
      { prompt: "test", collaborationMode } as DummyTurnInput,
      { enabled: true, stateRoot: "/unused", messageTimeoutMs: 1000 }, undefined,
      (async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (init?.body) bodies[path] = JSON.parse(String(init.body));
        return new Response(JSON.stringify(path.endsWith("/prompt") ? { data: { id: "msg_prompt" } } : { data: [] }));
      }) as typeof fetch);
    expect(bodies["/api/session/ses_test/agent"]).toEqual({ agent: collaborationMode === "plan" ? "plan" : "build" });
    expect(bodies["/api/session/ses_test/prompt"]).toEqual({ text: "test" });
  });

  it("aborts the isolated native session when the provider request fails", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      if (calls.length === 1) throw new Error("upstream failed");
      return new Response("true", { status: 200 });
    };
    const control: OpenCodeServerControl = {
      version: 1,
      spaceSessionId: "agent_session:test",
      nativeSessionId: "ses_chat_test",
      serverPort: 47047,
      serverHost: "10.254.240.13",
      serverUsername: "space",
      serverPassword: "secret",
      updatedAt: "2026-08-28T00:00:00.000Z"
    };
    const input = {
      roomId: "room:test",
      paneId: "pane:test",
      prompt: "test",
      providerId: "opencode",
      providerSessionId: "agent_session:test",
      modelId: "opencode/muse-spark-1.2-contributor-free",
      reasoningEffort: "medium",
      traceId: "trace:test"
    } as DummyTurnInput;

    await expect(executeOpenCodeTurnPrompt(
      control,
      input,
      { enabled: true, stateRoot: "/tmp/test", messageTimeoutMs: 60_000 },
      undefined,
      fetchImpl as typeof fetch
    )).rejects.toThrow("upstream failed");
    expect(calls).toEqual([
      { url: "http://10.254.240.13:47047/api/session/ses_chat_test/agent", method: "POST" },
      { url: "http://10.254.240.13:47047/api/session/ses_chat_test/interrupt", method: "POST" }
    ]);
  });
});
