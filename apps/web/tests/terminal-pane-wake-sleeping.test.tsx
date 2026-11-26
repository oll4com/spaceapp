import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Pane } from "@space/contracts";
import { liveRuntime } from "../src/live/live-runtime.js";
import { SpaceRuntimeProvider } from "../src/runtime/SpaceRuntime.js";
import { TerminalPane } from "../src/features/terminal-pane/TerminalPane.js";
import { VoiceInputProvider } from "../src/features/voice-input/VoiceInputProvider.js";

// 15/11 (operator nous_msg:5295e5b7, Warm approved by Nous): a sleeping pane resumes when the operator focuses it, without Start or a restart.
const OLD = new Date(Date.now() - 3 * 60 * 60_000).toISOString();

function json(body: unknown, headers: Record<string, string> = {}) {
  return { ok: true, status: 200, headers: new Headers(headers), json: async () => body };
}

function sleepingPaneFetch(wakes: boolean, resumedElsewhere = false) {
  const serverOffsetMs = 0;
  let awake = false;
  const wakeCalls: string[] = [];
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
      return json(awake ? { session: { sessionId: "cli_session:clock", paneId: "pane:clock", roomId: "room:cli", runtimeId: "cli:codex", providerId: "codex",
        agentId: "codex", modelId: null, reasoningEffort: "medium", cwd: "/opt/spaceapp", status: "IDLE", statusReason: "Resumed.", exitCode: null, isActive: true,
        codexThreadId: null, startedAt: "2026-07-05T00:00:00.000Z", updatedAt: "2026-07-05T00:00:00.000Z", endedAt: null, purpose: "NORMAL" }, transcript: [], websocket: null } : null, date);
    }
    if (method === "GET" && url === "/api/auth/csrf") {
      return json({ csrfToken: "csrf:test", headerName: "x-space-csrf-token" }, date);
    }
    if (method === "POST" && url === "/api/panes/pane%3Aclock/cli/wake") {
      wakeCalls.push(url);
      awake = wakes || resumedElsewhere;
      return json({ woke: wakes }, date);
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
  return { posts, sessionReads, wakeCalls };
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

function paneTree(pane: Pane, isVisible = true) {
  return (
    <SpaceRuntimeProvider runtime={liveRuntime}>
      <VoiceInputProvider><TerminalPane pane={pane} terminalFontSize={12} isVisible={isVisible} /></VoiceInputProvider>
    </SpaceRuntimeProvider>
  );
}

function renderPane(pane: Pane, isVisible = true) {
  return render(paneTree(pane, isVisible));
}

describe("a sleeping pane wakes when the operator focuses it", () => {
  it("asks the API to wake the pane on focus and attaches the resumed session, starting no new CLI", async () => {
    const calls = sleepingPaneFetch(true);
    const view = renderPane(terminalPane(OLD), false);
    try {
      const section = view.container.querySelector("section.terminal-pane")!;
      await waitFor(() => expect(section.getAttribute("data-terminal-loading")).toBe("false"), { timeout: 5000 });
      expect(calls.wakeCalls).toEqual([]);
      fireEvent.pointerDown(section);
      await waitFor(() => expect(section.getAttribute("data-terminal-has-session")).toBe("true"), { timeout: 5000 });
      expect(calls.wakeCalls).toHaveLength(1);
      expect(calls.posts).toEqual([]);
    } finally {
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  // 26/11 (operator approved): opening the room wakes it too, with no click.
  it("wakes a sleeping pane when it becomes visible, starting no new CLI", async () => {
    const calls = sleepingPaneFetch(true);
    const view = renderPane(terminalPane(OLD), false);
    try {
      const section = view.container.querySelector("section.terminal-pane")!;
      await waitFor(() => expect(section.getAttribute("data-terminal-loading")).toBe("false"), { timeout: 5000 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(calls.wakeCalls).toEqual([]);
      view.rerender(paneTree(terminalPane(OLD), true));
      await waitFor(() => expect(section.getAttribute("data-terminal-has-session")).toBe("true"), { timeout: 5000 });
      expect(calls.wakeCalls).toHaveLength(1);
      expect(calls.posts).toEqual([]);
    } finally {
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  // 26/11 (Zoe/Emma): Nous or the scheduler resumed the pane before the room opened, so wake answers false; the pane follows the new session.
  it("attaches the session the server already resumed when the pane becomes visible", async () => {
    const calls = sleepingPaneFetch(false, true);
    const view = renderPane(terminalPane(OLD), false);
    try {
      const section = view.container.querySelector("section.terminal-pane")!;
      await waitFor(() => expect(section.getAttribute("data-terminal-loading")).toBe("false"), { timeout: 5000 });
      view.rerender(paneTree(terminalPane(OLD), true));
      await waitFor(() => expect(section.getAttribute("data-terminal-has-session")).toBe("true"), { timeout: 5000 });
      expect(calls.wakeCalls).toHaveLength(1);
      expect(calls.posts).toEqual([]);
    } finally {
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("asks once for a pane that is not asleep, and starts nothing", async () => {
    const calls = sleepingPaneFetch(false);
    const view = renderPane(terminalPane(OLD));
    try {
      const section = view.container.querySelector("section.terminal-pane")!;
      await waitFor(() => expect(section.getAttribute("data-terminal-loading")).toBe("false"), { timeout: 5000 });
      fireEvent.focus(section);
      fireEvent.pointerDown(section);
      await waitFor(() => expect(calls.wakeCalls).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(calls.wakeCalls).toHaveLength(1);
      expect(calls.posts).toEqual([]);
      expect(section.getAttribute("data-terminal-has-session")).toBe("false");
    } finally {
      view.unmount();
      vi.unstubAllGlobals();
    }
  });
});
