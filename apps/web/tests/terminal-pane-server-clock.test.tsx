import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Pane } from "@space/contracts";
import { api } from "../src/live-api.js";
import { serverNow } from "../src/server-clock.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { SpaceRuntimeProvider } from "../src/runtime/SpaceRuntime.js";
import { TerminalPane } from "../src/features/terminal-pane/TerminalPane.js";
import { VoiceInputProvider } from "../src/features/voice-input/VoiceInputProvider.js";

// UX-004: a new pane's age is measured with the server's clock (the API's Date header), not the browser's.
const HOUR_MS = 60 * 60_000;

function json(body: unknown, headers: Record<string, string> = {}) {
  return { ok: true, status: 200, headers: new Headers(headers), json: async () => body };
}

function serverClockFetch(serverOffsetMs: number) {
  const posts: string[] = [];
  const sessionReads: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const date = { date: new Date(Date.now() + serverOffsetMs).toUTCString() };
    if (method === "GET" && url === "/api/cli/runtimes") {
      return json({
        data: [{
          id: "cli:codex",
          providerId: "codex",
          providerName: "Codex",
          agentId: "codex",
          agentName: "Codex CLI",
          displayName: "Codex CLI",
          capabilities: ["CLI"],
          adapterStatus: "ENABLED",
          authMode: "NONE",
          authState: "READY",
          authReason: "Runtime credentials are verified.",
          canStartLogin: false,
          status: "ENABLED",
          statusReason: "Codex CLI command and credential smoke are verified.",
          commandName: "codex",
          detectedCommandPath: "/opt/spaceapp/bin/codex",
          defaultModelId: null,
          supportedReasoningEfforts: ["medium", "high"],
          checkedAt: "2026-07-05T00:00:00.000Z"
        }],
        checkedAt: "2026-07-05T00:00:00.000Z"
      }, date);
    }
    if (method === "GET" && url.startsWith("/api/panes/pane%3Aclock/cli/session")) {
      sessionReads.push(url);
      return json(null, date);
    }
    if (method === "GET" && url === "/api/auth/csrf") {
      return json({ csrfToken: "csrf:test", headerName: "x-space-csrf-token" }, date);
    }
    if (method === "POST" && url === "/api/panes/pane%3Aclock/cli/session") {
      posts.push(String(init?.body ?? ""));
      return json({
        session: {
          sessionId: "cli_session:clock",
          paneId: "pane:clock",
          roomId: "room:cli",
          runtimeId: "cli:codex",
          providerId: "codex",
          agentId: "codex",
          modelId: null,
          reasoningEffort: "medium",
          cwd: "/opt/spaceapp/var/cli-workspaces/room_cli/pane_clock",
          status: "IDLE",
          statusReason: "CLI session allocated.",
          exitCode: null,
          isActive: true,
          codexThreadId: null,
          startedAt: "2026-07-05T00:00:00.000Z",
          updatedAt: "2026-07-05T00:00:00.000Z",
          endedAt: null
        },
        transcript: [],
        websocket: null
      }, date);
    }
    throw new Error(`Missing fixture for ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { posts, sessionReads };
}

function terminalPane(createdAt: string): Pane {
  return {
    id: "pane:clock",
    roomId: "room:cli",
    title: "Codex CLI",
    titleSource: "auto",
    mode: "TERMINAL",
    status: "IDLE",
    providerId: null,
    modelId: null,
    reasoningEffort: "medium",
    cwd: "/opt/spaceapp",
    terminalRuntimeId: null,
    order: 1,
    columnSpan: 1,
    isMaximized: false,
    isMinimized: false,
    isClosed: false,
    split: { parentId: null, direction: null, size: null },
    categoryColor: null,
    vncTarget: null,
    createdAt,
    updatedAt: createdAt
  };
}

function renderPane(pane: Pane) {
  return render(
    <SpaceRuntimeProvider runtime={liveRuntime}>
      <VoiceInputProvider><TerminalPane pane={pane} terminalFontSize={12} /></VoiceInputProvider>
    </SpaceRuntimeProvider>
  );
}

describe("new pane auto-start on the server's clock (UX-004)", () => {
  it("starts the CLI of a pane the server just created while the server's clock runs an hour behind the browser's", async () => {
    const calls = serverClockFetch(-HOUR_MS);
    const view = renderPane(terminalPane(new Date(Date.now() - HOUR_MS).toISOString()));
    try {
      await waitFor(() => expect(calls.posts.some((body) => body.includes("\"runtimeId\":\"cli:codex\""))).toBe(true), { timeout: 5000 });
    } finally {
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("does not start the CLI of a pane the server created two hours ago", async () => {
    const calls = serverClockFetch(-HOUR_MS);
    const view = renderPane(terminalPane(new Date(Date.now() - 3 * HOUR_MS).toISOString()));
    try {
      await waitFor(() => expect(calls.sessionReads.length).toBeGreaterThan(0), { timeout: 5000 });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(calls.posts).toEqual([]);
    } finally {
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("ignores the Date header of a cached response (Age header)", async () => {
    const answer = (headers: Record<string, string>) => vi.fn(async () => json({ data: [], checkedAt: "2026-07-05T00:00:00.000Z" }, headers));
    try {
      vi.stubGlobal("fetch", answer({ date: new Date(Date.now() - HOUR_MS).toUTCString() }));
      await api.cliModelSettings("pane:clock");
      const before = serverNow() - Date.now();
      expect(before).toBeLessThan(-HOUR_MS + 5_000);

      vi.stubGlobal("fetch", answer({ date: new Date(Date.now() - 5 * HOUR_MS).toUTCString(), age: "14400" }));
      await api.cliModelSettings("pane:clock");
      expect(Math.abs(serverNow() - Date.now() - before)).toBeLessThan(1_000);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
