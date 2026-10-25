import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Model, Provider } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp, type CreateAppOptions } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { extractGenericPaneTitleCandidate, generateOpenCodePaneTitle, generateTerminalPaneTitle } from "../src/pane-title-generator.js";

const csrfHeaderName = "x-space-csrf-token";

// Isolate app-level tests from any live OpenCode controls on this host so the
// shared-server title fallback stays deterministic (codex fallback expected).
const opencodeTestStateRoot = await mkdtemp(join(tmpdir(), "space-opencode-state-"));
afterAll(async () => {
  await rm(opencodeTestStateRoot, { recursive: true, force: true });
});

function providerFixture(): Provider {
  return {
    id: "codex-lb",
    displayName: "Codex-LB",
    type: "CODEX_LB",
    status: "VERIFIED",
    statusReason: "Credential smoke passed.",
    maskedKeyPrefix: "sk-t...est",
    baseUrl: "https://codex.example/v1",
    healthCheckedAt: "2026-07-08T00:00:00.000Z",
    routeProfile: "custom",
    backingProviderId: null,
    credentialRef: null,
    isBuiltIn: true
  };
}

function modelFixture(): Model {
  return {
    id: "codex-lb:gpt-5.4-mini",
    providerId: "codex-lb",
    runtimeId: "gpt-5.4-mini",
    displayName: "GPT-5.4 Mini",
    status: "VERIFIED",
    contextWindow: 128000,
    supportsTools: false,
    supportsVision: false,
    supportsRealtime: false,
    supportsReasoning: true,
    defaultReasoningEffort: "low"
  };
}

async function authedApp(
  configOverrides: NodeJS.ProcessEnv,
  store: InMemorySpaceStore,
  appOverrides: Omit<CreateAppOptions, "store" | "config" | "auth"> = {}
) {
  const app = await createApp({
    opencodeStateRoot: opencodeTestStateRoot,
    ...appOverrides,
    store,
    config: getApiConfig({
      SPACE_AGENT_PANE_ENABLED: "true",
      SPACE_ENABLE_CODEX_TURNS: "true",
      SPACE_CODEX_APP_SERVER_ENABLED: "true",
      SPACE_CODEX_LB_BASE_URL: "https://codex.example/v1",
      SPACE_CODEX_LB_KEY_NAME: "space-test-title-generator",
      ...configOverrides
    }),
    auth: {
      sessionSecret: "test-secret-with-enough-length",
      devLogin: true,
      secureCookies: false
    }
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "space@space.local", password: "space-dev" }
  });
  const cookieHeader = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
  const csrf = await app.inject({
    method: "GET",
    url: "/api/auth/csrf",
    headers: { cookie: cookieHeader }
  });
  return { app, cookie: cookieHeader, csrfToken: csrf.json().csrfToken as string };
}

describe("terminal pane title generation", () => {
  it("builds a concise sanitized title from recent CLI transcript", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string; input?: unknown };
        expect(body.model).toBe("gpt-5.4-mini");
        expect(JSON.stringify(body.input ?? "")).toContain("Investigate deployment rollback");
        return {
          output_text: '  "Summarize deployment rollback blockers."  '
        };
      }
    }));

    const result = await generateTerminalPaneTitle(
      {
        config: {
          codexLbBaseUrl: "https://codex.example/v1",
          codexLbKeyFile: "/tmp/space-title-key",
          codexLbKeyName: "space-test-title-generator"
        },
        provider: providerFixture(),
        model: modelFixture(),
        currentTitle: "CLI 2",
        cwd: "/opt/spaceapp",
        reasoningEffort: "minimal",
        transcript: [
          { stream: "stdout", content: "Investigate deployment rollback and nginx 502 errors" },
          { stream: "stderr", content: "build failed after deploy" }
        ]
      },
      {
        fetchImpl: fetchImpl as typeof fetch,
        readFileImpl: async () => "sk-test-title-key"
      }
    );

    expect(result).toMatchObject({
      title: "Summarize deployment rollback blockers",
      providerId: "codex-lb",
      modelId: "codex-lb:gpt-5.4-mini"
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("generates titles through a provider of the SPACE_GATEWAY type", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ output_text: "Review gateway retirement" }) }));
    const result = await generateTerminalPaneTitle(
      {
        config: { codexLbBaseUrl: "http://127.0.0.1:4920/v1", codexLbKeyFile: "/tmp/space-title-key", codexLbKeyName: "space-gateway-internal" },
        provider: { ...providerFixture(), displayName: "Space Gateway", type: "SPACE_GATEWAY", baseUrl: "http://127.0.0.1:4920/v1" },
        model: modelFixture(),
        currentTitle: "CLI 2",
        cwd: "/opt/spaceapp",
        reasoningEffort: "minimal",
        transcript: [{ stream: "stdout", content: "Retire codex-lb and Headroom" }]
      },
      { fetchImpl: fetchImpl as typeof fetch, readFileImpl: async () => "sk-test-title-key" }
    );

    expect(result).toMatchObject({ title: "Review gateway retirement", providerId: "codex-lb" });
    expect(String((fetchImpl.mock.calls[0] as unknown[] | undefined)?.[0])).toContain("127.0.0.1:4920");
  });

  it("keeps the primary stdin task request even when recent transcript tail is dominated by cleanup noise", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { input?: Array<{ content?: Array<{ text?: string }> }> };
        const promptText = JSON.stringify(body.input ?? "");
        expect(promptText).toContain("Primary task request:");
        expect(promptText).toContain("Fix the Space CLI pane title generation");
        expect(promptText).toContain("Recent CLI activity:");
        return {
          output_text: "Fix Space CLI pane titles"
        };
      }
    }));

    const noisyTranscript = [
      {
        stream: "stdin" as const,
        content:
          "Fix the Space CLI pane title generation so it summarizes the real task request instead of recent cleanup output."
      },
      ...Array.from({ length: 18 }, (_, index) => ({
        stream: "stdout" as const,
        content: `etc cleanup complete ${index} / cache cleanup complete ${index} / verify complete ${index}`
      }))
    ];

    const result = await generateTerminalPaneTitle(
      {
        config: {
          codexLbBaseUrl: "https://codex.example/v1",
          codexLbKeyFile: "/tmp/space-title-key",
          codexLbKeyName: "space-test-title-generator"
        },
        provider: providerFixture(),
        model: modelFixture(),
        currentTitle: "CLI 7",
        cwd: "/opt/spaceapp",
        primaryTaskRequest:
          "Fix the Space CLI pane title generation so it summarizes the real task request instead of recent cleanup output.",
        reasoningEffort: "minimal",
        transcript: noisyTranscript
      },
      {
        fetchImpl: fetchImpl as typeof fetch,
        readFileImpl: async () => "sk-test-title-key"
      }
    );

    expect(result.title).toBe("Fix Space CLI pane titles");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("prefers the Codex first user request when the pane has no stdin transcript", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { input?: Array<{ content?: Array<{ text?: string }> }> };
        const promptText = JSON.stringify(body.input ?? "");
        expect(promptText).toContain("Primary task request:");
        expect(promptText).toContain("θέλω στο σημείο της φωτο 2 να εμφανίζεται ο τίτλος του task");
        expect(promptText).toContain("Recent CLI activity:");
        expect(promptText).toContain("etc cleanup complete");
        return {
          output_text: "CLI pane τίτλος και AI auto-update"
        };
      }
    }));

    const result = await generateTerminalPaneTitle(
      {
        config: {
          codexLbBaseUrl: "https://codex.example/v1",
          codexLbKeyFile: "/tmp/space-title-key",
          codexLbKeyName: "space-test-title-generator"
        },
        provider: providerFixture(),
        model: modelFixture(),
        currentTitle: "etc cleanup complete",
        cwd: "/etc",
        primaryTaskRequest:
          "θέλω στο σημείο της φωτο 2 να εμφανίζεται ο τίτλος του task και να έχει μολύβι για διόρθωση και AI icon για autoupdate",
        reasoningEffort: "minimal",
        transcript: [
          { stream: "stdout", content: "etc cleanup complete / verify complete / cache cleanup complete" },
          { stream: "stdout", content: "readyz ok / version ok / /etc" }
        ]
      },
      {
        fetchImpl: fetchImpl as typeof fetch,
        readFileImpl: async () => "sk-test-title-key"
      }
    );

    expect(result.title).toBe("CLI pane τίτλος και AI auto-update");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to the local Codex-LB proxy when the selected provider endpoint is unreachable", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.startsWith("https://example.invalid:8787/")) {
        throw new TypeError("fetch failed");
      }
      expect(href).toBe("http://127.0.0.1:2458/v1/responses");
      return {
        ok: true,
        status: 200,
        json: async () => ({ output_text: "Use local Codex LB proxy" })
      };
    });

    const result = await generateTerminalPaneTitle(
      {
        config: {
          codexLbBaseUrl: "http://127.0.0.1:2458/v1",
          codexLbKeyFile: "/tmp/space-title-key",
          codexLbKeyName: "space-test-title-generator"
        },
        provider: {
          ...providerFixture(),
          baseUrl: "https://example.invalid:8787/v1"
        },
        model: modelFixture(),
        currentTitle: "CLI 3",
        cwd: "/opt/spaceapp",
        reasoningEffort: "minimal",
        transcript: [{ stream: "stdout", content: "Generate a concise CLI pane title for the active Space task" }]
      },
      {
        fetchImpl: fetchImpl as typeof fetch,
        readFileImpl: async () => "sk-test-title-key"
      }
    );

    expect(result).toMatchObject({
      title: "Use local Codex LB proxy",
      providerId: "codex-lb"
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  // Queued API generation, native binding, and failure recovery live in task-title-routes/service tests.

});

describe("generateOpenCodePaneTitle", () => {
  it("creates a temp session, prompts the opencode model, extracts the assistant title, and deletes the session", async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      const urlString = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url: urlString, method, body: typeof init?.body === "string" ? init.body : undefined });
      if (urlString.endsWith("/session/ses_native_test_1") && method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ model: { id: "qwen3-coder-free", providerID: "opencode" } })
        } as Response;
      }
      if (urlString.includes("/session?directory=") && method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "ses_title_test_1" })
        } as Response;
      }
      if (urlString.endsWith("/session/ses_title_test_1/message") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          model?: { providerID?: string; modelID?: string };
          parts?: Array<{ text?: string }>;
        };
        expect(body.model).toEqual({ providerID: "opencode", modelID: "qwen3-coder-free" });
        expect(JSON.stringify(body.parts ?? "")).toContain("Investigate deployment rollback");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            parts: [
              { type: "text", text: "Deployment rollback blockers" },
              { type: "text", text: "  \"Final pane title here.\"  " }
            ]
          })
        } as Response;
      }
      if (urlString.endsWith("/session/ses_title_test_1") && method === "DELETE") {
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }
      throw new Error(`unexpected call: ${method} ${urlString}`);
    });

    const result = await generateOpenCodePaneTitle(
      {
        control: {
          version: 1,
          spaceSessionId: "cli_session:opencode-test",
          nativeSessionId: "ses_native_test_1",
          serverPort: 47047,
          serverHost: "127.0.0.1",
          serverUsername: "space-opencode",
          serverPassword: "secret-password"
        },
        currentTitle: "CLI 2",
        cwd: "/opt/spaceapp",
        primaryTaskRequest: "Investigate deployment rollback",
        transcript: [
          { stream: "stdout", content: "Investigate deployment rollback and nginx 502 errors" }
        ]
      },
      { fetchImpl: fetchImpl as typeof fetch }
    );

    expect(result).toEqual({
      title: "Final pane title here",
      providerId: "opencode",
      modelId: "qwen3-coder-free"
    });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET http://127.0.0.1:47047/session/ses_native_test_1",
      `POST http://127.0.0.1:47047/session?directory=${encodeURIComponent("/opt/spaceapp")}`,
      "POST http://127.0.0.1:47047/session/ses_title_test_1/message",
      "DELETE http://127.0.0.1:47047/session/ses_title_test_1"
    ]);
    const messageCall = calls[2]!;
    expect(messageCall.body).toBeTruthy();
    expect(JSON.parse(messageCall.body ?? "{}")).toMatchObject({
      model: { providerID: "opencode", modelID: "qwen3-coder-free" },
      tools: {}
    });
  });

  it("cleans up the temp session even when the prompt fails", async () => {
    const deleted: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      const urlString = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (urlString.endsWith("/session/ses_native_test_1") && method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ model: { id: "qwen3-coder-free", providerID: "opencode" } })
        } as Response;
      }
      if (urlString.includes("/session?directory=") && method === "POST") {
        return { ok: true, status: 200, json: async () => ({ id: "ses_title_test_2" }) } as Response;
      }
      if (urlString.endsWith("/message")) {
        return { ok: false, status: 500, json: async () => ({}) } as Response;
      }
      if (method === "DELETE") {
        deleted.push(urlString);
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }
      throw new Error(`unexpected call: ${method} ${urlString}`);
    });

    await expect(
      generateOpenCodePaneTitle(
        {
          control: {
            version: 1,
            spaceSessionId: "cli_session:opencode-test",
            nativeSessionId: "ses_native_test_1",
            serverPort: 47047,
            serverHost: "127.0.0.1",
            serverUsername: "space-opencode",
            serverPassword: "secret-password"
          },
          currentTitle: "CLI 2",
          cwd: null,
          primaryTaskRequest: null,
          transcript: [{ stream: "stdout", content: "Investigate deployment rollback" }]
        },
        { fetchImpl: fetchImpl as typeof fetch }
      )
    ).rejects.toThrow("OpenCode title prompt failed with HTTP 500.");
    expect(deleted).toEqual(["http://127.0.0.1:47047/session/ses_title_test_2"]);
  });

  it("falls back to the native session first user message when the pane context is empty", async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      const urlString = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url: urlString, method, body: typeof init?.body === "string" ? init.body : undefined });
      if (urlString.includes("/session/ses_native_test_1/message?directory=") && method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { info: { role: "user" }, parts: [{ type: "text", text: "  Native first user message  " }] },
            { info: { role: "assistant" }, parts: [{ type: "text", text: "reply" }] }
          ]
        } as Response;
      }
      if (urlString.endsWith("/session/ses_native_test_1") && method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ model: { id: "qwen3-coder-free", providerID: "opencode" } })
        } as Response;
      }
      if (urlString.includes("/session?directory=") && method === "POST") {
        return { ok: true, status: 200, json: async () => ({ id: "ses_title_test_3" }) } as Response;
      }
      if (urlString.endsWith("/session/ses_title_test_3/message") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { parts?: Array<{ text?: string }> };
        expect(JSON.stringify(body.parts ?? "")).toContain("Native first user message");
        expect(JSON.stringify(body.parts ?? "")).not.toContain("Primary task request: unavailable");
        return {
          ok: true,
          status: 200,
          json: async () => ({ parts: [{ type: "text", text: "\"Native title result\"" }] })
        } as Response;
      }
      if (urlString.endsWith("/session/ses_title_test_3") && method === "DELETE") {
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }
      throw new Error(`unexpected call: ${method} ${urlString}`);
    });

    const result = await generateOpenCodePaneTitle(
      {
        control: {
          version: 1,
          spaceSessionId: "cli_session:opencode-test",
          nativeSessionId: "ses_native_test_1",
          serverPort: 47047,
          serverHost: "127.0.0.1",
          serverUsername: "space-opencode",
          serverPassword: "secret-password"
        },
        currentTitle: "CLI 2",
        cwd: "/opt/spaceapp",
        primaryTaskRequest: null,
        transcript: []
      },
      { fetchImpl: fetchImpl as typeof fetch }
    );

    expect(result).toEqual({
      title: "Native title result",
      providerId: "opencode",
      modelId: "qwen3-coder-free"
    });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET http://127.0.0.1:47047/session/ses_native_test_1",
      `GET http://127.0.0.1:47047/session/ses_native_test_1/message?directory=${encodeURIComponent("/opt/spaceapp")}&limit=50`,
      `POST http://127.0.0.1:47047/session?directory=${encodeURIComponent("/opt/spaceapp")}`,
      "POST http://127.0.0.1:47047/session/ses_title_test_3/message",
      "DELETE http://127.0.0.1:47047/session/ses_title_test_3"
    ]);
  });

  it("skips placeholder native titles and still prompts with the pane context", async () => {
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      const urlString = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (urlString.includes("/session/ses_native_test_1/message?directory=") && method === "GET") {
        return { ok: true, status: 200, json: async () => [] } as Response;
      }
      if (urlString.endsWith("/session/ses_native_test_1") && method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            title: "New session - 2026-08-12T08:11:40.492Z",
            time: { updated: 1 },
            model: { id: "qwen3-coder-free", providerID: "opencode" }
          })
        } as Response;
      }
      if (urlString.includes("/session?directory=") && method === "POST") {
        return { ok: true, status: 200, json: async () => ({ id: "ses_title_test_4" }) } as Response;
      }
      if (urlString.endsWith("/session/ses_title_test_4/message") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { parts?: Array<{ text?: string }> };
        const content = JSON.stringify(body.parts ?? "");
        expect(content).toContain("Current title: CLI 2");
        expect(content).toContain("Primary task request: unavailable");
        expect(content).not.toContain("New session - 2026-08-12");
        return {
          ok: true,
          status: 200,
          json: async () => ({ parts: [{ type: "text", text: "Placeholder fallback title" }] })
        } as Response;
      }
      if (urlString.endsWith("/session/ses_title_test_4") && method === "DELETE") {
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }
      throw new Error(`unexpected call: ${method} ${urlString}`);
    });

    const result = await generateOpenCodePaneTitle(
      {
        control: {
          version: 1,
          spaceSessionId: "cli_session:opencode-test",
          nativeSessionId: "ses_native_test_1",
          serverPort: 47047,
          serverHost: "127.0.0.1",
          serverUsername: "space-opencode",
          serverPassword: "secret-password"
        },
        currentTitle: "CLI 2",
        cwd: "/opt/spaceapp",
        primaryTaskRequest: null,
        transcript: []
      },
      { fetchImpl: fetchImpl as typeof fetch }
    );

    expect(result).toEqual({
      title: "Placeholder fallback title",
      providerId: "opencode",
      modelId: "qwen3-coder-free"
    });
  });

  it("skips native session context entirely when skipNativeContext is true", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      const urlString = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push(`${method} ${urlString}`);
      if (urlString.endsWith("/session/ses_native_other_pane") && method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ model: { id: "qwen3-coder-free", providerID: "opencode" } })
        } as Response;
      }
      if (urlString.includes("/session?directory=") && method === "POST") {
        return { ok: true, status: 200, json: async () => ({ id: "ses_title_test_5" }) } as Response;
      }
      if (urlString.endsWith("/session/ses_title_test_5/message") && method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ parts: [{ type: "text", text: "Fallback generated title" }] })
        } as Response;
      }
      if (urlString.endsWith("/session/ses_title_test_5") && method === "DELETE") {
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }
      throw new Error(`unexpected call: ${method} ${urlString}`);
    });

    const result = await generateOpenCodePaneTitle(
      {
        control: {
          version: 1,
          spaceSessionId: "cli_session:opencode-test",
          nativeSessionId: "ses_native_other_pane",
          serverPort: 47047,
          serverHost: "127.0.0.1",
          serverUsername: "space-opencode",
          serverPassword: "secret-password"
        },
        currentTitle: "DeepSeek CLI 23",
        cwd: "/etc",
        primaryTaskRequest: null,
        transcript: [],
        skipNativeContext: true
      },
      { fetchImpl: fetchImpl as typeof fetch }
    );

    expect(result).toEqual({
      title: "Fallback generated title",
      providerId: "opencode",
      modelId: "qwen3-coder-free"
    });
    expect(calls.some((call) => call.includes("/session/ses_native_other_pane/message"))).toBe(false);
    expect(calls.map((call) => call.split("?")[0])).toEqual([
      "GET http://127.0.0.1:47047/session/ses_native_other_pane",
      "POST http://127.0.0.1:47047/session",
      "POST http://127.0.0.1:47047/session/ses_title_test_5/message",
      "DELETE http://127.0.0.1:47047/session/ses_title_test_5"
    ]);
  });

  it("fails closed without creating a temp session when no last-used model is available", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      const urlString = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push(`${method} ${urlString}`);
      if (urlString.endsWith("/session/ses_native_none") && method === "GET") {
        return { ok: false, status: 404, json: async () => ({}) } as Response;
      }
      throw new Error(`unexpected call: ${method} ${urlString}`);
    });

    await expect(
      generateOpenCodePaneTitle(
        {
          control: {
            version: 1,
            spaceSessionId: "cli_session:opencode-test",
            nativeSessionId: "ses_native_none",
            serverPort: 47047,
            serverHost: "127.0.0.1",
            serverUsername: "space-opencode",
            serverPassword: "secret-password"
          },
          currentTitle: "CLI 2",
          cwd: null,
          primaryTaskRequest: "Investigate deployment rollback",
          transcript: []
        },
        { fetchImpl: fetchImpl as typeof fetch }
      )
    ).rejects.toThrow("No last-used OpenCode model is available for pane title generation.");
    expect(calls.map((call) => call.split("?")[0])).toEqual([
      "GET http://127.0.0.1:47047/session/ses_native_none"
    ]);
  });
});

describe("extractGenericPaneTitleCandidate", () => {
  it("prefers the first user message when it is meaningful", () => {
    const candidate = extractGenericPaneTitleCandidate("Διόρθωση bug τίτλων στο Opencode για όλα τα panes", []);
    expect(candidate).toBe("Διόρθωση bug τίτλων στο Opencode για όλα τα panes");
  });

  it("rejects raw terminal escape sequences and falls back to the transcript stdin", () => {
    const candidate = extractGenericPaneTitleCandidate("\u001b[<0;24;10M", [
      { stream: "stdout", content: "setup: running install for spaceapp" },
      { stream: "stdin", content: "Ενημέρωσε το setup του spaceapp και τρέξε έλεγχο έκδοσης" }
    ]);
    expect(candidate).toBe("Ενημέρωσε το setup του spaceapp και τρέξε έλεγχο έκδοσης");
  });

  it("returns empty when neither source is meaningful", () => {
    expect(extractGenericPaneTitleCandidate(null, [{ stream: "stdout", content: "done" }])).toBe("");
  });
});
