import { demoHealthSnapshot } from "../src/demo/demo-health.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPaneSession, AgentRuntime, CliVpnRoutingStatus, Pane, PaneCliSessionResponse, Room } from "@space/contracts";
import {
  createCoalescedRefreshQueue,
  formatTerminalSessionClipboardText,
  formatTerminalSessionDebugInfo,
  paneHeaderNeedsSecondRow,
  roomRefreshCategoriesForEvent,
  roomToolbarNeedsSecondRow,
  shellVisiblePaneIds,
  shouldOpenAppEventStreams,
  shouldUseEventStreamFallback
} from "../src/App.js";
import { LiveSpaceApp as App } from "../src/live/LiveSpaceApp.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { CODE_RADIO_METADATA_URL, CODE_RADIO_PRIMARY_STREAM_URL } from "../src/features/vibe-music/VibeMusicPlayer.js";
import { readLifecycleDebugSnapshot } from "../src/lifecycle-debug.js";
import { publishCliVpnRoutingStatus, resetCliVpnRoutingStatusForTests } from "../src/cli-vpn-routing.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function paginated<T>(data: T[]) {
  return {
    data,
    pagination: { page: 1, pageSize: 100, totalItems: data.length, totalPages: data.length ? 1 : 0 }
  };
}

function isRoomCatalogRequest(request: { url: string; method: string }) {
  return request.method === "GET" && (request.url === "/api/rooms" || request.url.startsWith("/api/rooms?"));
}

const userLinks = [
  { id: "link:codex", title: "Codex LB", description: "Routing dashboard", url: "https://example.invalid:2455/", openMode: "EMBEDDED", category: "GENERAL", isQuick: true, sortOrder: 0, createdAt: "2026-07-16T08:00:00.000Z", updatedAt: "2026-07-16T08:00:00.000Z" },
  { id: "link:headroom", title: "Headroom", description: "Capacity dashboard", url: "https://example.invalid:8787/dashboard", openMode: "EMBEDDED", category: "GENERAL", isQuick: true, sortOrder: 1, createdAt: "2026-07-16T08:00:00.000Z", updatedAt: "2026-07-16T08:00:00.000Z" },
  { id: "link:status", title: "OpenAI Status", description: "Service status", url: "https://status.openai.com/", openMode: "NEW_TAB", category: "GENERAL", isQuick: false, sortOrder: 2, createdAt: "2026-07-16T08:00:00.000Z", updatedAt: "2026-07-16T08:00:00.000Z" }
];

function cliRuntime(
  id: string,
  displayName: string,
  capabilities: AgentRuntime["capabilities"] = ["CLI"]
): AgentRuntime {
  return {
    id,
    providerId: id.replace(/^(cli|web):/, ""),
    providerName: displayName,
    agentId: id.replace(/^(cli|web):/, ""),
    agentName: displayName,
    displayName,
    capabilities,
    adapterStatus: "ENABLED",
    authMode: "NONE",
    authState: "READY",
    authReason: `${displayName} is ready.`,
    canStartLogin: false,
    status: "ENABLED",
    statusReason: `${displayName} is ready.`,
    commandName: capabilities.includes("CLI") ? id.replace(/^cli:/, "") : null,
    detectedCommandPath: capabilities.includes("CLI") ? `/opt/spaceapp/bin/${id.replace(/^cli:/, "")}` : null,
    defaultModelId: null,
    supportedReasoningEfforts: [],
    checkedAt: "2026-07-18T00:00:00.000Z"
  };
}

function cliRuntimeRegistry(role: "ADMIN" | "OPERATOR") {
  return {
    data: [
      cliRuntime("web:codex-app-server", "Codex Web Chat", ["WEB_CHAT"]),
      cliRuntime("cli:codex", "Codex CLI"),
      cliRuntime("cli:claude", "Claude Code CLI"),
      cliRuntime("cli:gemini", "Gemini CLI"),
      cliRuntime("cli:opencode", "OpenCode CLI"),
      cliRuntime("cli:autohand", "Autohand Code CLI"),
      cliRuntime("cli:qwen", "Qwen Code CLI"),
      cliRuntime("cli:kimi", "Kimi Code CLI"),
      cliRuntime("cli:grok", "Grok Build CLI"),
      ...(role === "ADMIN" ? [cliRuntime("cli:root", "CLI ROOT")] : [])
    ],
    checkedAt: "2026-07-18T00:00:00.000Z"
  };
}

function roomPayload(
  id: string,
  name: string,
  order = 0,
  paneLayoutColumns: 0 | 1 | 2 | 3 | 4 | null = null,
  kind: Room["kind"] = "WORKSPACE"
) {
  return {
    id,
    name,
    description: null,
    kind,
    order,
    paneLayoutColumns,
    paneCap: 16,
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
    archivedAt: null,
    traceId: `req:${id}`
  };
}

function pane(input: {
  id: string;
  roomId: string;
  order: number;
  title: string;
  mode?: Pane["mode"];
  isMaximized?: boolean;
  isMinimized?: boolean;
  columnSpan?: number;
  terminalRuntimeId?: string | null;
}): Pane {
  return {
    id: input.id,
    roomId: input.roomId,
    title: input.title,
    titleSource: "auto",
    mode: input.mode ?? "REVIEW",
    status: "IDLE",
    providerId: null,
    modelId: null,
    reasoningEffort: "medium",
    cwd: "/opt/spaceapp",
    terminalRuntimeId: input.terminalRuntimeId ?? null,
    order: input.order,
    columnSpan: input.columnSpan ?? 1,
    isMaximized: input.isMaximized ?? false,
    isMinimized: input.isMinimized ?? false,
    isClosed: false,
    split: { parentId: null, direction: null, size: null },
    categoryColor: null,
    vncTarget: null,
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z"
  };
}

function reviewPanes(roomId: string, count: number) {
  return Array.from({ length: count }, (_, index) =>
    pane({
      id: `pane:${roomId}:${index + 1}`,
      roomId,
      order: index,
      title: `Review ${index + 1}`
    })
  );
}

function terminalPanes(roomId: string, count: number, maximizedIndex: number | null = null) {
  return Array.from({ length: count }, (_, index) =>
    pane({
      id: `pane:${roomId}:cli-${index + 1}`,
      roomId,
      order: index,
      title: `CLI ${index + 1}`,
      mode: "TERMINAL",
      isMaximized: maximizedIndex === index
    })
  );
}

function chatPanes(roomId: string, count: number) {
  return Array.from({ length: count }, (_, index) =>
    pane({
      id: `pane:${roomId}:chat-${index + 1}`,
      roomId,
      order: index,
      title: `Chat ${index + 1}`,
      mode: "CHAT"
    })
  );
}

function agentSession(paneId: string): AgentPaneSession {
  return {
    binding: {
      paneId,
      source: "SPACE",
      sessionId: `agent_session:${paneId}`,
      coderChatId: null,
      status: "READY",
      title: "Chat session",
      selectedModelConfigId: null,
      selectedProviderName: null,
      selectedModelName: null,
      selectedReasoningKey: null,
      selectedToolIds: [],
      lastSyncedAt: "2026-07-16T00:00:00.000Z"
    },
    threadId: null,
    messages: [],
    runStatus: "IDLE",
    statusReason: "Chat session is ready.",
    modelOptions: [{ id: "gpt-test:high", displayName: "GPT Test", providerId: "openai", providerName: "OpenAI",
      model: "gpt-test", reasoningKey: "high", reasoningLabel: "High", isDefault: true }],
    modelCatalog: [],
    modelProviders: [],
    selectedModelConfigId: null,
    toolOptions: [],
    selectedToolIds: [],
    permissionMode: null,
    collaborationMode: "default",
    permissionState: {
      mode: null,
      effectiveMode: "full_access",
      isInherited: true,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      reviewer: "user",
      statusReason: "Inherited runtime default."
    },
    permissionOptions: [],
    goal: null,
    history: [],
    capabilities: {
      canSend: true,
      canInterrupt: false,
      canSelectModel: false,
      canSelectTools: false,
      supportsTools: false
    }
  };
}

function setViewport(width: number, height = 900) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: height });
  window.dispatchEvent(new Event("resize"));
}

async function openDesktopMenu(group: "Create" | "Workspace" | "Help" | "Admin", admin = false) {
  const nav = await screen.findByRole("navigation", { name: "Workspace navigation" });
  if (admin) {
    const mode = within(nav).getByRole("button", { name: "Admin mode" });
    if (mode.getAttribute("aria-pressed") === "false") fireEvent.click(mode);
  }
  const trigger = within(nav).queryByRole("button", { name: group })
    ?? within(nav).getByRole("button", { name: "Workspace" });
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  return { trigger, menu: await screen.findByRole("dialog", { name: /^(Menu|Create|Workspace|Help|Admin)$/ }) };
}

async function workspaceAction(name: string | RegExp) {
  await waitFor(() => expect(document.querySelector(".space-shell[data-shell-mode]")).toBeTruthy());
  const label = String(name);
  const stableName = typeof name === "string" && /^(Show|Hide) CLI floats$/.test(name) ? "CLI controls"
    : typeof name === "string" && /^(Show|Hide) resource indicators$/.test(name) ? "Resource indicators"
    : typeof name === "string" && /^(Show|Hide) sensitive data$/.test(name) ? "Hide sensitive data" : name;
  if (/^(Open|Show|Hide) rooms$/.test(label)) return screen.getByRole("button", { name });
  const admin = /health dock|Server restart|settings dock|CLI ROOT/.test(label);
  const nav = await screen.findByRole("navigation", { name: "Workspace navigation" });
  if (admin) {
    const mode = within(nav).queryByRole("button", { name: "Admin mode" });
    if (mode?.getAttribute("aria-pressed") === "false") fireEvent.click(mode);
  }
  const group = /CLI ROOT|Server restart|health dock/.test(label) ? "Admin" : /^Add |DeepSeek Harness/.test(label) ? "Create" : name === "Help" ? "Help" : "Workspace";
  const trigger = within(nav).queryByRole("button", { name: group }) ?? within(nav).getByRole("button", { name: "Workspace" });
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  const menu = screen.getByRole("dialog", { name: /^(Create|Workspace|Help|Admin|Find an action)$/ });
  let found = within(menu).queryByRole("button", { name: stableName });
  if (found) return found;
  for (const category of ["Work", "View", "Tools", "Settings", "Utilities", "Docks", "Pane layout", "Input & media"]) {
    const tab = within(menu).queryByRole("tab", { name: category });
    if (!tab) continue;
    fireEvent.click(tab);
    found = within(menu).queryByRole("button", { name: stableName });
    if (found) return found;
  }
  const searchInput = within(menu).queryByRole("textbox", { name: /^(Find an action|Find a tool|Find a dock)$/ });
  if (searchInput && typeof stableName === "string") {
    fireEvent.change(searchInput, { target: { value: stableName } });
    found = within(menu).queryByRole("button", { name: stableName });
    if (found) return found;
  }
  return within(menu).getByRole("button", { name: stableName });
}

async function openSettingsSection(title: string) {
  const settings = await screen.findByLabelText("Settings dock");
  fireEvent.click(await within(settings).findByRole("button", { name: title }));
}

async function openCliDockSection(title: string) {
  const cli = await screen.findByLabelText("CLI dock");
  fireEvent.click(await within(cli).findByRole("button", { name: title }));
}

function setWarmRoomTelemetry(input: {
  hardwareConcurrency: number;
  usedBytes?: number;
  heapLimitBytes?: number;
  deviceMemoryGiB?: number;
}) {
  Object.defineProperty(navigator, "hardwareConcurrency", {
    configurable: true,
    value: input.hardwareConcurrency
  });
  Object.defineProperty(navigator, "deviceMemory", {
    configurable: true,
    value: input.deviceMemoryGiB
  });
  Object.defineProperty(performance, "memory", {
    configurable: true,
    value: input.usedBytes && input.heapLimitBytes
      ? {
          usedJSHeapSize: input.usedBytes,
          jsHeapSizeLimit: input.heapLimitBytes
        }
      : undefined
  });
  Object.defineProperty(performance, "measureUserAgentSpecificMemory", {
    configurable: true,
    value: undefined
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function installFetchFixture(input: {
  role?: "ADMIN" | "OPERATOR";
  sourceControlProvider?: "github" | "gitea";
  isCodexEnabled?: boolean;
  roomId?: string;
  roomName?: string;
  panes?: Pane[];
  panesByRoom?: Record<string, Pane[]>;
  failPaneCreate?: boolean;
  failPanePatchIds?: string[];
  failPaneLayout?: boolean;
  paneLayoutDeferred?: Promise<void>;
  paneRequestDeferredByRoom?: Record<string, Promise<void>>;
  requestDeferredByUrl?: Record<string, Promise<void>>;
  cliCountsByRoom?: Record<string, number>;
  cliRuntimeIdsByRoom?: Record<string, string[]>;
  cliSessionByPane?: Record<string, PaneCliSessionResponse>;
  cliVpnRoutingStatus?: CliVpnRoutingStatus;
  cliRuntimeSettings?: unknown;
  paneLayoutColumns?: 0 | 1 | 2 | 3 | 4 | null;
  defaultRoomPageSize?: number;
  storageWarning?: string;
  rooms?: Array<{
    id: string;
    name: string;
    kind?: Room["kind"];
    order?: number;
    paneLayoutColumns?: 0 | 1 | 2 | 3 | 4 | null;
  }>;
}) {
  const seededRooms =
    input.rooms?.length
      ? input.rooms.map((room, index) =>
          roomPayload(room.id, room.name, room.order ?? index, room.paneLayoutColumns ?? null, room.kind)
        )
      : [roomPayload(input.roomId ?? "room:responsive", input.roomName ?? "Responsive room", 0, input.paneLayoutColumns ?? null)];
  const roomId = seededRooms[0]?.id ?? "room:responsive";
  const initialRooms = [...seededRooms];
  const panesByRoom = new Map<string, Pane[]>(
    seededRooms.map((room, index) => [room.id, input.panesByRoom?.[room.id] ?? (index === 0 ? input.panes ?? [] : [])])
  );
  const createdRooms: Array<{ id: string; count: number }> = [];
  const requests: Array<{ url: string; method: string }> = [];
  const requestBodies: Array<{ url: string; body: string }> = [];
  const browserTargetByPane = new Map<string, string>();
  let roomCounter = 0;

  const browserSessionResponse = (paneId: string) => {
    const browserPane = [...panesByRoom.values()].flat().find((candidate) => candidate.id === paneId);
    if (!browserPane) throw new Error(`Missing browser pane fixture for ${paneId}`);
    const targetUrl = browserTargetByPane.get(paneId) ?? "http://127.0.0.1:3080/";
    const sessionId = `browser_session:${paneId}`;
    const page = {
      pageId: `browser_page:${paneId}`,
      kind: "PAGE" as const,
      url: targetUrl,
      title: "DeepSeek Harness",
      isActive: true,
      openerPageId: null,
      canGoBack: false,
      canGoForward: false
    };
    return {
      session: {
        sessionId,
        paneId,
        roomId: browserPane.roomId,
        ownerAgentId: null,
        agentNumber: 2,
        profileId: `profile:${paneId}`,
        profilePath: `/tmp/${paneId}`,
        viewport: "desktop" as const,
        targetUrl,
        currentUrl: targetUrl,
        title: "DeepSeek Harness",
        status: "READY" as const,
        statusReason: "DeepSeek Harness is ready.",
        lastFrameAt: null,
        streamMode: "SILENT" as const,
        resolvedStreamMode: "SILENT" as const,
        runtimeState: "READY" as const,
        capacityState: "AVAILABLE" as const,
        controlState: "UNCONTROLLED" as const,
        pages: [page],
        activePageId: page.pageId,
        workerHeartbeatAt: "2026-08-28T00:00:00.000Z",
        queuePosition: null,
        isActive: true,
        startedAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:00.000Z",
        endedAt: null
      },
      frame: null,
      websocket: null
    };
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof request === "string" ? request : request.toString();
      const method = init?.method ?? "GET";
      requests.push({ url, method });
      if (init?.body) requestBodies.push({ url, body: String(init.body) });
      await input.requestDeferredByUrl?.[url];

      if (input.cliRuntimeSettings && method === "GET" && url === "/api/cli/runtime-settings") {
        return {
          ok: true,
          status: 200,
          json: async () => input.cliRuntimeSettings
        };
      }
      if (input.cliVpnRoutingStatus && method === "GET" && url === "/api/cli/vpn/routing-status") {
        return {
          ok: true,
          status: 200,
          json: async () => input.cliVpnRoutingStatus
        };
      }

      if (method === "GET" && url === CODE_RADIO_METADATA_URL) {
        const body = JSON.stringify({ now_playing: { song: { artist: "Code Radio", title: "Responsive track" } } });
        const bytes = new TextEncoder().encode(body);
        return {
          ok: true,
          status: 200,
          headers: { get: (name: string) => name.toLowerCase() === "content-length" ? String(body.length) : null },
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            }
          }),
          text: async () => body
        };
      }

      if (
        method === "GET" &&
        (url.startsWith("/api/rooms?") || (url === "/api/rooms" && input.defaultRoomPageSize !== undefined))
      ) {
        const params = new URL(url, "http://space.local").searchParams;
        const page = Number(params.get("page") ?? "1");
        const pageSize = Number(params.get("pageSize") ?? input.defaultRoomPageSize ?? 100);
        const start = (page - 1) * pageSize;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: initialRooms.slice(start, start + pageSize),
            pagination: {
              page,
              pageSize,
              totalItems: initialRooms.length,
              totalPages: Math.ceil(initialRooms.length / pageSize)
            }
          })
        };
      }

      if (method === "GET" && url === "/api/admin/codex-lb-speed-defaults") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            models: [
              { modelId: "gpt-5.5", displayName: "GPT-5.5", tier: "STANDARD" },
              { modelId: "gpt-5.4", displayName: "GPT-5.4", tier: "FAST" }
            ],
            updatedAt: "2026-07-17T08:00:00.000Z",
            checkedAt: "2026-07-17T08:00:00.000Z"
          })
        };
      }

      if (method === "PATCH" && url === "/api/admin/codex-lb-speed-defaults/gpt-5.5") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { tier?: "STANDARD" | "FAST" };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            models: [
              { modelId: "gpt-5.5", displayName: "GPT-5.5", tier: body.tier ?? "STANDARD" },
              { modelId: "gpt-5.4", displayName: "GPT-5.4", tier: "FAST" }
            ],
            updatedAt: "2026-07-17T08:01:00.000Z",
            checkedAt: "2026-07-17T08:01:00.000Z"
          })
        };
      }

      if (method === "POST" && url === "/api/admin/codex-history-purge-previews") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "READY",
            previewId: "9943e22b-97a3-48b6-ae84-1a2cced6a353",
            candidates: { threads: 12, cliTasks: 7, indexEntries: 10, rolloutFiles: 11, shellSnapshots: 4 },
            protectedThreads: 3,
            expiresAt: "2026-07-17T08:05:00.000Z",
            checkedAt: "2026-07-17T08:00:00.000Z"
          })
        };
      }

      if (method === "POST" && url === "/api/admin/codex-history-purges") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "COMPLETED",
            previewId: "9943e22b-97a3-48b6-ae84-1a2cced6a353",
            backupId: "c3d866d1-9690-4db5-b44c-6294c07aa83e",
            purged: { threads: 12, cliTasks: 7, indexEntries: 10, rolloutFiles: 11, shellSnapshots: 4 },
            protectedThreads: 3,
            newlyProtectedThreads: 0,
            completedAt: "2026-07-17T08:01:00.000Z"
          })
        };
      }

      if (method === "POST" && url === "/api/rooms") {
        roomCounter += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string };
        const created = roomPayload(`room:new-${roomCounter}`, body.name ?? `Room ${roomCounter + 1}`, initialRooms.length);
        createdRooms.push({ id: created.id, count: 0 });
        panesByRoom.set(created.id, []);
        initialRooms.push(created);
        return { ok: true, status: 200, json: async () => created };
      }

      if (method === "POST" && url === "/api/rooms/reorder") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { roomIds?: string[] };
        const nextRooms = (body.roomIds ?? [])
          .map((roomId) => initialRooms.find((room) => room.id === roomId))
          .filter((room): room is ReturnType<typeof roomPayload> => Boolean(room))
          .map((room, index) => ({ ...room, order: index }));
        initialRooms.splice(0, initialRooms.length, ...nextRooms);
        return { ok: true, status: 200, json: async () => nextRooms };
      }

      if (method === "POST" && url.endsWith("/panes/reorder")) {
        const requestedRoomId = decodeURIComponent(url.split("/api/rooms/")[1]?.replace(/\/panes\/reorder$/, "") ?? roomId);
        const body = JSON.parse(String(init?.body ?? "{}")) as { paneIds?: string[] };
        const currentPanes = panesByRoom.get(requestedRoomId) ?? [];
        const nextPanes = (body.paneIds ?? [])
          .map((paneId) => currentPanes.find((p) => p.id === paneId))
          .filter((p): p is (typeof currentPanes)[number] => Boolean(p))
          .map((p, index) => ({ ...p, order: index }));
        panesByRoom.set(requestedRoomId, nextPanes);
        return { ok: true, status: 200, json: async () => nextPanes };
      }

      if (method === "POST" && url === "/api/panes") {
        if (input.failPaneCreate) {
          return {
            ok: false,
            status: 503,
            json: async () => ({
              error: { code: "PANE_CREATE_FAILED", message: "The pane could not be opened." }
            })
          };
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as { roomId?: string; title?: string; mode?: Pane["mode"] };
        const nextRoomId = body.roomId ?? roomId;
        const current = panesByRoom.get(nextRoomId) ?? [];
        const nextPane = pane({
          id: `pane:${nextRoomId}:${current.length + 1}`,
          roomId: nextRoomId,
          order: current.length,
          title: body.title ?? `Review ${current.length + 1}`,
          mode: body.mode ?? "REVIEW"
        });
        panesByRoom.set(nextRoomId, [...current, nextPane]);
        const createdRoom = createdRooms.find((room) => room.id === nextRoomId);
        if (createdRoom) createdRoom.count += 1;
        return { ok: true, status: 200, json: async () => nextPane };
      }

      if (method === "POST" && /^\/api\/panes\/[^/]+\/browser\/session$/.test(url)) {
        const paneId = decodeURIComponent(url.split("/api/panes/")[1]?.replace(/\/browser\/session$/, "") ?? "");
        const body = JSON.parse(String(init?.body ?? "{}")) as { targetUrl?: string };
        if (body.targetUrl) browserTargetByPane.set(paneId, body.targetUrl);
        return { ok: true, status: 200, json: async () => browserSessionResponse(paneId) };
      }

      if (method === "GET" && /^\/api\/panes\/[^/]+\/browser\/session$/.test(url)) {
        const paneId = decodeURIComponent(url.split("/api/panes/")[1]?.replace(/\/browser\/session$/, "") ?? "");
        return { ok: true, status: 200, json: async () => browserSessionResponse(paneId) };
      }

      if (method === "GET" && /^\/api\/panes\/[^/]+\/browser\/pages$/.test(url)) {
        const paneId = decodeURIComponent(url.split("/api/panes/")[1]?.replace(/\/browser\/pages$/, "") ?? "");
        const response = browserSessionResponse(paneId);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sessionId: response.session.sessionId,
            pages: response.session.pages,
            activePageId: response.session.activePageId
          })
        };
      }

      if (method === "PUT" && /^\/api\/rooms\/[^/]+\/pane-layout$/.test(url)) {
        await input.paneLayoutDeferred;
        if (input.failPaneLayout) {
          return {
            ok: false,
            status: 500,
            json: async () => ({ error: { code: "INTERNAL_ERROR", message: "Pane layout update failed" } })
          };
        }
        const requestedRoomId = decodeURIComponent(url.split("/api/rooms/")[1]?.replace(/\/pane-layout$/, "") ?? roomId);
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          paneLayoutColumns?: 1 | 2 | 3 | 4 | null;
          paneLayoutHeight?: 1 | 2 | 3 | 4;
        };
        const roomIndex = initialRooms.findIndex((room) => room.id === requestedRoomId);
        const currentRoom = initialRooms[roomIndex];
        if (!currentRoom) throw new Error(`Missing room fixture for ${requestedRoomId}`);
        const updatedRoom = {
          ...currentRoom,
          ...(body.paneLayoutColumns !== undefined ? { paneLayoutColumns: body.paneLayoutColumns } : null),
          ...(body.paneLayoutHeight !== undefined ? { paneLayoutHeight: body.paneLayoutHeight } : null),
          updatedAt: "2026-07-07T00:00:01.000Z"
        };
        initialRooms.splice(roomIndex, 1, updatedRoom);
        const updatedPanes = body.paneLayoutColumns !== undefined
          ? (panesByRoom.get(requestedRoomId) ?? []).map((currentPane) =>
              currentPane.isClosed
                ? currentPane
                : {
                    ...currentPane,
                    columnSpan: 1,
                    isMaximized: false,
                    updatedAt: "2026-07-07T00:00:01.000Z"
                  }
            )
          : (panesByRoom.get(requestedRoomId) ?? []);
        panesByRoom.set(requestedRoomId, updatedPanes);
        return { ok: true, status: 200, json: async () => ({ room: updatedRoom, panes: updatedPanes }) };
      }

      if (method === "POST" && url.startsWith("/api/panes/") && url.endsWith("/move")) {
        const paneId = decodeURIComponent(url.split("/api/panes/")[1]?.replace(/\/move$/, "") ?? "");
        const body = JSON.parse(String(init?.body ?? "{}")) as { targetRoomId?: string };
        const targetRoomId = body.targetRoomId ?? roomId;
        let sourcePane: Pane | null = null;
        let sourceRoomId: string | null = null;

        for (const [nextRoomId, roomPanes] of panesByRoom.entries()) {
          const paneIndex = roomPanes.findIndex((candidate) => candidate.id === paneId);
          if (paneIndex < 0) continue;
          sourcePane = roomPanes[paneIndex] ?? null;
          sourceRoomId = nextRoomId;
          const remaining = [...roomPanes];
          remaining.splice(paneIndex, 1);
          panesByRoom.set(nextRoomId, remaining);
          break;
        }

        if (!sourcePane || !sourceRoomId) {
          return {
            ok: false,
            status: 404,
            json: async () => ({ error: { code: "NOT_FOUND", message: `Pane ${paneId} was not found.` } })
          };
        }

        const targetPanes = panesByRoom.get(targetRoomId) ?? [];
        const targetPane: Pane = {
          ...sourcePane,
          roomId: targetRoomId,
          order: targetPanes.length,
          columnSpan: 1,
          isMaximized: false,
          isMinimized: false,
          isClosed: false,
          split: { parentId: null, direction: null, size: null },
          createdAt: sourcePane.createdAt,
          updatedAt: "2026-07-09T00:00:01.000Z"
        };
        panesByRoom.set(targetRoomId, [...targetPanes, targetPane]);

        return {
          ok: true,
          status: 200,
          json: async () => ({
            sourcePane,
            targetPane,
            sourceRoomId,
            targetRoomId
          })
        };
      }

      if (method === "GET" && url.startsWith("/api/panes?roomId=")) {
        const nextRoomId = decodeURIComponent(url.split("roomId=")[1] ?? roomId);
        await input.paneRequestDeferredByRoom?.[nextRoomId];
        return { ok: true, status: 200, json: async () => paginated(panesByRoom.get(nextRoomId) ?? []) };
      }

      if (method === "GET" && /^\/api\/panes\/[^/]+\/agent-session$/.test(url)) {
        const paneId = decodeURIComponent(url.split("/api/panes/")[1]?.replace(/\/agent-session$/, "") ?? "");
        return { ok: true, status: 200, json: async () => agentSession(paneId) };
      }

      if (method === "GET" && /^\/api\/panes\/[^/]+\/cli\/session\?includeTranscript=false$/.test(url)) {
        const paneId = decodeURIComponent(url.split("/api/panes/")[1]?.replace(/\/cli\/session\?includeTranscript=false$/, "") ?? "");
        const session = input.cliSessionByPane?.[paneId];
        if (session) return { ok: true, status: 200, json: async () => session };
      }

      if (method === "GET" && url.startsWith("/api/codex/history?")) {
        return { ok: true, status: 200, json: async () => paginated([]) };
      }

      if (method === "PATCH" && url.startsWith("/api/panes/")) {
        const paneId = decodeURIComponent(url.split("/api/panes/")[1] ?? "");
        if (input.failPanePatchIds?.includes(paneId)) {
          return {
            ok: false,
            status: 500,
            json: async () => ({ error: { code: "INTERNAL_ERROR", message: `Failed to update ${paneId}` } })
          };
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          title?: string;
          isMaximized?: boolean;
          isMinimized?: boolean;
          columnSpan?: number;
          categoryColor?: Pane["categoryColor"];
        };
        let updatedPane: Pane | null = null;
        for (const [nextRoomId, roomPanes] of panesByRoom.entries()) {
          const paneIndex = roomPanes.findIndex((candidate) => candidate.id === paneId);
          if (paneIndex < 0) continue;
          updatedPane = {
            ...roomPanes[paneIndex]!,
            title: body.title ?? roomPanes[paneIndex]!.title,
            isMaximized: body.isMinimized === true ? false : body.isMaximized ?? roomPanes[paneIndex]!.isMaximized,
            isMinimized: body.isMaximized === true ? false : body.isMinimized ?? roomPanes[paneIndex]!.isMinimized,
            columnSpan: body.columnSpan ?? roomPanes[paneIndex]!.columnSpan,
            categoryColor: body.categoryColor === undefined ? roomPanes[paneIndex]!.categoryColor : body.categoryColor,
            updatedAt: "2026-07-07T00:00:01.000Z"
          };
          const nextPanes = [...roomPanes];
          nextPanes.splice(paneIndex, 1, updatedPane);
          panesByRoom.set(nextRoomId, nextPanes);
          break;
        }
        if (!updatedPane) throw new Error(`Missing pane fixture for ${paneId}`);
        return { ok: true, status: 200, json: async () => updatedPane };
      }

      if (method === "GET" && url.startsWith("/api/swarm?roomId=")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tasks: [],
            locks: [],
            messages: [],
            reconciles: [],
            executionStatus: "DISABLED",
            statusReason: "Swarm execution is control-plane only."
          })
        };
      }

      if (method === "GET" && url.startsWith("/api/turns?roomId=")) {
        return { ok: true, status: 200, json: async () => paginated([]) };
      }

      if (method === "GET" && url.startsWith("/api/events?roomId=")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [], pagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 } })
        };
      }

      if (method === "GET" && url.startsWith("/api/artifacts?roomId=")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } })
        };
      }

      if (method === "POST" && url.startsWith("/api/artifacts/file-uploads?")) {
        const params = new URL(url, "http://space.local").searchParams;
        const uploadedPaneId = params.get("paneId");
        const source = params.get("source") ?? "USER_UPLOAD";
        return {
          ok: true,
          status: 200,
          json: async () => ({
            artifacts: [
              {
                id: `artifact:clip:${requests.length}`,
                roomId: params.get("roomId"),
                paneId: uploadedPaneId,
                turnId: null,
                workflowId: null,
                kind: "IMAGE",
                mimeType: "image/png",
                storageUri: `space-artifact://user-uploads/${encodeURIComponent(uploadedPaneId ?? "room")}/screen.png`,
                sha256: "0".repeat(64),
                byteSize: 4,
                metadata: { source, originalFilename: "screen.png" },
                expiresAt: null,
                pinnedAt: null,
                deletedAt: null,
                createdAt: "2026-07-17T00:00:00.000Z"
              }
            ]
          })
        };
      }

      if (method === "GET" && url.startsWith("/api/clipboard-items")) {
        return { ok: true, status: 200, json: async () => paginated([]) };
      }

      if (method === "GET" && url.startsWith("/api/links")) {
        const params = new URL(url, "http://space.local").searchParams;
        const data = params.get("isQuick") === "true" ? userLinks.filter((link) => link.isQuick) : userLinks;
        return { ok: true, status: 200, json: async () => ({ data, pagination: { page: 1, pageSize: 10, totalItems: data.length, totalPages: 1 } }) };
      }

      if (method === "GET" && /^\/api\/rooms\/[^/]+\/room-agent$/.test(url)) {
        const requestedRoomId = decodeURIComponent(url.split("/api/rooms/")[1]?.replace(/\/room-agent$/, "") ?? roomId);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            roomId: requestedRoomId,
            paneId: "pane:room-agent",
            sessionId: "agent_session:room-agent",
            threadId: null,
            status: "IDLE",
            statusReason: "Room Agent is ready to supervise this room.",
            modelId: "gpt-5.6-sol",
            reasoningEffort: "high",
            messages: [],
            activeMission: null,
            queuedMissionCount: 0,
            currentPaneId: null,
            capabilities: { canSend: true, canStop: false }
          })
        };
      }

      const payloads: Record<string, unknown> = {
        "/api/auth/me": {
          user: { id: "user:operator", email: "space@space.local", role: input.role ?? "ADMIN" },
          isAuthenticated: true,
          isSetupRequired: false
        },
        "/readyz": {
          ok: true,
          dependencies: {
            store: "postgres",
            runtimeStore: "postgres",
            eventBus: "in-process",
            temporal: "enabled",
            worker: "RUNNING",
            codexTurns: "enabled",
            codexLb: "configured"
          }
        },
        "/api/rooms": paginated(initialRooms),
        "/api/rooms/cli-activity": {
          data: initialRooms.map((room) => ({
            roomId: room.id,
            runningCliCount: input.cliCountsByRoom?.[room.id] ?? 0,
            paneCount: (panesByRoom.get(room.id) ?? []).filter((pane) => !pane.isClosed).length,
            runtimeIds: input.cliRuntimeIdsByRoom?.[room.id] ?? []
          })),
          sampledAt: "2026-07-20T12:00:00.000Z"
        },
        "/api/codex/environment": {
          codexHome: "/var/lib/spaceapp-user/.codex",
          stateDbPath: "/var/lib/spaceapp-user/.codex/state_5.sqlite",
          isCodexEnabled: input.isCodexEnabled ?? true,
          config: { modelProvider: "codex-lb", model: "gpt-5.5", reasoningEffort: "high" },
          mcpServers: [],
          skillCount: 0,
          pluginCount: 0,
          memories: { generateMemories: true, useMemories: true },
          features: { plugins: true, memories: true },
          checkedAt: "2026-07-16T00:00:00.000Z"
        },
        "/api/voice/transcription/settings": {
          enabled: false,
          statusReason: "Voice input is disabled in this fixture.",
          defaultModel: "gpt-live-transcribe",
          modelOptions: ["gpt-live-transcribe"],
          defaultLanguage: "auto",
          languageOptions: ["auto"],
          defaultDelay: "medium",
          delayOptions: ["medium"],
          maxBytes: 26214400,
          maxDurationMs: 300000,
          updatedAt: "2026-07-16T00:00:00.000Z"
        },
        "/api/providers": paginated([]),
        "/api/provider-settings": { defaultProviderId: "headroom-gateway", updatedAt: "2026-07-07T00:00:00.000Z" },
        "/api/models": paginated([]),
        "/api/cli/runtimes": cliRuntimeRegistry(input.role ?? "ADMIN"),
        "/api/skills": paginated([]),
        "/api/imports": { data: [], pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 } },
        "/api/admin": { status: "ok", mode: "dev", storageWarning: input.storageWarning ?? "" },
        "/api/auth/csrf": { csrfToken: "csrf:test", headerName: "x-space-csrf-token" },
        "/api/harness/healthz": { ok: true, status: 200, checkedAt: "2026-08-31T08:00:00.000Z", durationMs: 4 },
        "/api/mcp": {
          data: [],
          gateway: {
            id: "mcp-gateway",
            status: "DISABLED",
            statusReason: "MCP discovery metadata is not verified.",
            targetSpecVersion: "2025-11-25",
            approvalMode: "DISABLED",
            serverCount: 0,
            toolCount: 0,
            lastDiscoveryAt: null
          },
          servers: [],
          tools: [],
          pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 }
        },
        "/api/admin/mcp/discovery-smoke": { data: null },
        "/api/admin/memory/embedding-smoke": { data: null },
        "/api/admin/memory/vector-readiness": {
          data: {
            id: "memory-vector-readiness",
            status: "DISABLED",
            code: "VECTOR_STORE_NOT_POSTGRES",
            message: "Vector store is not ready.",
            runtimeStore: "postgres",
            extensionInstalled: false,
            extensionVersion: null,
            embeddingColumnReady: false,
            embeddingDimensions: null,
            expectedDimensions: 1536,
            vectorIndexReady: false,
            checkedAt: "2026-07-07T00:00:00.000Z"
          }
        },
        "/api/admin/codex-app-server": {
          id: "codex-app-server",
          status: "READY",
          reasonCode: "CONFIG_SAFE",
          statusReason: "Codex App Server config is safe.",
          transport: "stdio",
          command: "codex",
          socketPath: null,
          websocketUrl: null,
          schemasGenerated: true,
          schemaManifest: null,
          lastCheckedAt: "2026-07-07T00:00:00.000Z"
        },
        "/api/admin/codex-app-server/handshake": { data: null },
        "/api/admin/codex-app-server/turn-smoke": { data: null },
        "/api/admin/storage": {
          id: "space-storage",
          status: "VERIFIED",
          statusReason: "Storage ready.",
          root: { path: "/", deviceId: "100", sizeBytes: 1, availableBytes: 1, usedPercent: 0 },
          app: { path: "/opt/spaceapp", deviceId: "200", sizeBytes: 1, availableBytes: 1, usedPercent: 0 },
          dedicatedAppVolume: true,
          minimumRecommendedFreeBytes: 1,
          checkedAt: "2026-07-07T00:00:00.000Z"
        },
        "/api/admin/observability": {
          service: "space-api",
          generatedAt: "2026-07-07T00:00:00.000Z",
          runtime: {
            startedAt: "2026-07-07T00:00:00.000Z",
            uptimeSeconds: 1,
            nodeVersion: "v22.23.0",
            pid: 207,
            memory: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1, externalBytes: 0, arrayBuffersBytes: 0 }
          },
          totals: { requestCount: 1, errorCount: 0, errorRate: 0, p50Ms: 1, p95Ms: 1, p99Ms: 1 },
          endpoints: []
        },
        "/api/admin/system-analytics/health": demoHealthSnapshot(),
        "/api/admin/worker": {
          id: "space-worker",
          status: "RUNNING",
          statusReason: "Temporal worker pollers are visible.",
          address: "127.0.0.1:7233",
          namespace: "default",
          taskQueue: "space-agent-turns",
          reachable: true,
          workflowPollerCount: 1,
          activityPollerCount: 1,
          pollerCount: 2,
          pollerIdentities: ["space-worker@test"],
          lastPollerAccessAt: "2026-07-07T00:00:00.000Z",
          checkedAt: "2026-07-07T00:00:00.000Z"
        },
        "/api/admin/cli-maintenance/runs": { data: [] },
        "/api/admin/releases/runs": { data: [] },
        "/api/source-control/connections": input.sourceControlProvider ? [{ provider: input.sourceControlProvider, serverUrl: "http://192.0.2.4:3001", status: "CONNECTED", accountLogin: "oll4com", connectedAt: null, checkedAt: null, error: null }] : [],
        "/api/admin/source-control/connections": {
          data: [
            {
              provider: "gitea",
              repositoryOwner: "oll4com",
              repositoryName: "space",
              accountLogin: null,
              status: "DISCONNECTED",
              secretConfigured: false,
              lastVerifiedAt: null,
              lastVerificationCode: "NOT_VERIFIED",
              updatedAt: "2026-07-07T00:00:00.000Z"
            },
            {
              provider: "github",
              repositoryOwner: "oll4com",
              repositoryName: "space",
              accountLogin: null,
              status: "DISCONNECTED",
              secretConfigured: false,
              lastVerifiedAt: null,
              lastVerificationCode: "NOT_VERIFIED",
              updatedAt: "2026-07-07T00:00:00.000Z"
            }
          ]
        },
        "/api/integrations/telegram": {
          connectionStatus: "DISCONNECTED",
          isEnabled: false,
          botUsername: null,
          chatDisplayName: null,
          pairingId: null,
          pairingExpiresAt: null,
          pairedAt: null,
          enabledAt: null,
          disabledAt: null,
          lastTestedAt: null,
          lastDeliveredAt: null,
          errorCode: null,
          errorAt: null,
          updatedAt: "2026-07-07T00:00:00.000Z"
        }
      };

      if (!(url in payloads)) {
        throw new Error(`Missing fixture for ${method} ${url}`);
      }

      return { ok: true, status: 200, json: async () => payloads[url] };
    })
  );

  // App instances share the real client's 15s environment cache. Replacing
  // fetch alone does not replace that fixture state; refresh it through the
  // public client before mounting. Keep normal deduplication during each test.
  const environmentReady = liveRuntime.api.codexEnvironment(true);
  return {
    environmentReady,
    createdRooms,
    requests,
    requestBodies,
    addRoom(room: { id: string; name: string; kind?: Room["kind"]; order?: number }) {
      const added = roomPayload(room.id, room.name, room.order ?? initialRooms.length, null, room.kind);
      initialRooms.push(added);
      panesByRoom.set(added.id, []);
    }
  };
}

/**
 * The minimized panes bar is parked behind one float toggle on the pane board, so
 * tests that read or click the bar itself must reveal it first.
 */
async function showMinimizedBar(): Promise<void> {
  const toggle = await screen.findByRole("button", { name: /minimized panes bar/ });
  if (toggle.getAttribute("aria-expanded") === "false") fireEvent.click(toggle);
}


export { __dirname, paginated, isRoomCatalogRequest, userLinks, cliRuntime, cliRuntimeRegistry, roomPayload, pane, reviewPanes, terminalPanes, chatPanes, agentSession, setViewport, openDesktopMenu, workspaceAction, openSettingsSection, openCliDockSection, setWarmRoomTelemetry, deferred, installFetchFixture, showMinimizedBar };
