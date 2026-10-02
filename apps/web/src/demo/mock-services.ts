import { SpaceApiError } from "../runtime/SpaceRuntime.js";
import type { DemoFixture } from "./demo-fixture.js";
import { mockProjectCatalog } from "./mock-project-catalog.js";

const now = () => new Date().toISOString();
const base = import.meta.env.BASE_URL;
const media = (name: string) => `${base}demo/media/${name}`;
const workspace = "/opt/spaceapp";
type FileRecord = { directory: boolean; content: string };

export class MockServices {
  private sequence = 0;
  private messages: Record<string, unknown>[] = [];
  private sessions = ["Codex", "OpenCode", "Gemini"].map((name, index) => ({
    id: `history:demo-${index}`, kind: "codex", threadId: `thread:demo-${index}`, taskId: null,
    title: `${name} workspace review`, preview: "Review the Space interface and controls.",
    providerLabel: name, model: "gpt-6.1-sol", modelProvider: "demo", cwd: workspace,
    source: "demo", threadSource: `cli:${name.toLowerCase()}`, firstUserMessage: "Review the workspace",
    archived: false, updatedAt: now(), recencyAt: now(), status: "completed", isCompleted: true
  }));
  private files = new Map<string, FileRecord>([
    [workspace, { directory: true, content: "" }],
    [workspace + "/docs", { directory: true, content: "" }],
    [workspace + "/README.md", { directory: false, content: "# Space workspace\n\nOne workspace. Every tool.\n\nThese files are local demo examples.\n" }],
    [workspace + "/docs/launch-brief.md", { directory: false, content: "# Launch brief\n\nReview rooms, panes, docks and settings.\n" }]
  ]);
  private selection = { projectId: "project-1-salesforce-crm", variantId: "javascript-react-node", mode: "SAMPLE" };
  private run: Record<string, unknown> | null = null;
  private modelSettings = new Map<string, { modelId: string; reasoningEffort: string }>();
  private liveItems: any[] = [];
  private epochs: Record<string, number> = {};
  private browserStates = new Map<string, any>();
  private bookmarks = new Map<string, any[]>();
  private roomMessages = new Map<string, any[]>();
  private playback = new Map<string, any>();

  constructor(private readonly fixture: () => DemoFixture) {}
  snapshot() { return { sequence: this.sequence, selection: this.selection, run: this.run, messages: this.messages, files: [...this.files], sessions: this.sessions, models: [...this.modelSettings],
    liveItems: this.liveItems, epochs: this.epochs, browsers: [...this.browserStates], bookmarks: [...this.bookmarks], roomMessages: [...this.roomMessages], playback: [...this.playback] }; }
  restore(value: any) {
    if (!value || typeof value !== "object") return;
    if (Number.isSafeInteger(value.sequence) && value.sequence >= 0) this.sequence = value.sequence;
    if (value.selection && typeof value.selection.projectId === "string" && typeof value.selection.variantId === "string") this.selection = value.selection;
    if (value.run?.id) this.run = value.run;
    if (Array.isArray(value.messages)) this.messages = value.messages;
    if (Array.isArray(value.sessions)) this.sessions = value.sessions;
    if (Array.isArray(value.liveItems)) this.liveItems = value.liveItems;
    if (value.epochs && typeof value.epochs === "object") this.epochs = value.epochs;
    for (const [key, name] of [["files", "files"], ["models", "modelSettings"], ["browsers", "browserStates"], ["bookmarks", "bookmarks"], ["roomMessages", "roomMessages"], ["playback", "playback"]] as const) {
      if (Array.isArray(value[key]) && value[key].every((row: any) => Array.isArray(row) && row.length === 2 && typeof row[0] === "string")) (this as any)[name] = new Map(value[key]);
    }
  }
  private id(prefix: string) { return `${prefix}:mock-${++this.sequence}`; }
  private path(value: unknown) {
    const path = String(value ?? workspace).replace(/\/+$/, "") || workspace;
    if (!path.startsWith(workspace + "/") && path !== workspace) throw new SpaceApiError("Choose a file inside the demo workspace.", { status: 403, code: "FORBIDDEN" });
    if (path.split("/").includes("..")) throw new SpaceApiError("Invalid workspace path.", { status: 400, code: "INVALID_PATH" });
    return path;
  }
  private file(path: string) {
    const file = this.files.get(path);
    if (!file) throw new SpaceApiError("File not found.", { status: 404, code: "NOT_FOUND" });
    return { name: path.split("/").at(-1)!, path, isDirectory: file.directory, isSymbolicLink: false, size: file.content.length,
      mtime: now(), mode: file.directory ? 493 : 420, permissions: file.directory ? "rwxr-xr-x" : "rw-r--r--", octalPermissions: file.directory ? "0755" : "0644", owner: "demo", mimeType: "text/plain" };
  }
  private demoState() {
    return { catalog: structuredClone(mockProjectCatalog), selection: { ...this.selection }, run: this.run, connections: [], sheets: { spreadsheetId: null, spreadsheetUrl: null, title: null, tab: null, verified: false, headerPresent: false, verifiedAt: null }, liveReady: false };
  }
  private browser(paneId: string) {
    let state = this.browserStates.get(paneId);
    if (state) return state;
    const roomId = this.fixture().panes.find(p => p.id === paneId)?.roomId ?? this.fixture().rooms[0]!.id;
    const url = "https://spaceapp.dev/";
    const pageId = this.id("browser_page");
    const pages = [{ pageId, kind: "PAGE", url, title: "Discover Space", isActive: true, openerPageId: null, canGoBack: false, canGoForward: false }];
    const sessionId = `browser_session:${paneId}`;
    state = { session: { sessionId, paneId, roomId, ownerAgentId: "agent:demo", agentNumber: 3, profileId: "profile:demo", profilePath: "/demo/browser-profile", viewport: "desktop", targetUrl: url, currentUrl: url, title: "Discover Space", status: "READY", statusReason: "Local browser preview", lastFrameAt: now(), streamMode: "PREVIEW", resolvedStreamMode: "PREVIEW", runtimeState: "READY", capacityState: "AVAILABLE", controlState: "UNCONTROLLED", pages, activePageId: pageId, workerHeartbeatAt: now(), queuePosition: null, isActive: true, startedAt: now(), updatedAt: now(), endedAt: null }, frame: { sessionId, paneId, roomId, status: "READY", viewport: "desktop", currentUrl: url, title: "Discover Space", screenshotDataUrl: media("browser-preview.svg"), capturedAt: now() }, websocket: { paneId, sessionId, token: "mock-browser-only", expiresAt: "2099-01-01T00:00:00.000Z" } };
    this.browserStates.set(paneId, state); return state;
  }
  private pagePayload(paneId: string) { const { session } = this.browser(paneId); return { sessionId: session.sessionId, pages: session.pages, activePageId: session.activePageId }; }
  invoke(method: string, args: unknown[]): { handled: boolean; value?: unknown } {
    const input = (args[0] ?? {}) as any;
    let value: unknown;
    switch (method) {
      case "artifactFileUrl": case "agentFilePreviewUrl": case "agentFileDownloadUrl": {
        const artifact = this.fixture().artifacts.find(row => row.id === args[0]);
        value = artifact?.metadata.mockDataUrl ?? media(String(artifact?.metadata.mockFile ?? (artifact?.kind === "IMAGE" ? "homepage-demo.svg" : "launch-brief.md"))); break;
      }
      case "deleteArtifact": {
        this.fixture().artifacts = this.fixture().artifacts.filter(row => row.id !== args[0]); value = { ok: true, artifactId: args[0] }; break;
      }
      case "deleteRoomAgentFiles": case "deleteRoomMedia": {
        const ids = this.fixture().artifacts.filter(row => row.roomId === args[0] && (row.storageUri.startsWith("space-artifact://agent-files/") === (method === "deleteRoomAgentFiles"))).map(row => row.id);
        this.fixture().artifacts = this.fixture().artifacts.filter(row => !ids.includes(row.id));
        value = { ok: true, roomId: args[0], matchedCount: ids.length, deletedCount: ids.length, failedCount: 0, failedArtifactIds: [] }; break;
      }
      case "uploadAgentFiles": case "uploadPaneFiles": case "uploadImages": {
        return { handled: true, value: Promise.all((input.files as File[]).map(async file => {
          if (file.size > 5_000_000) throw new SpaceApiError("Choose a demo file smaller than 5 MB.", { status: 413, code: "UPLOAD_TOO_LARGE" });
          const bytes = new Uint8Array(await file.arrayBuffer()); let binary = "";
          for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          const artifact = { id: this.id("artifact"), roomId: input.roomId, paneId: input.paneId ?? null, turnId: null, workflowId: null,
            kind: file.type.startsWith("image/") ? "IMAGE" : "EXPORT", mimeType: file.type || "text/plain", storageUri: `space-artifact://agent-files/${encodeURIComponent(file.name)}`,
            sha256: "0".repeat(64), byteSize: file.size, metadata: { originalFilename: file.name, source: "USER_UPLOAD", mockDataUrl: `data:${file.type || "text/plain"};base64,${btoa(binary)}` },
            createdAt: now(), expiresAt: null, pinnedAt: null, deletedAt: null };
          this.fixture().artifacts.push(artifact as any); return artifact;
        })).then(artifacts => ({ artifacts })) };
      }
      case "getLiveHistory": value = { ownerId: "user:demo-user", items: this.liveItems, epochs: this.epochs }; break;
      case "getLivePersonalMemory": value = { items: [], revision: 0 }; break;
      case "openAiModels": value = { models: ["gpt-live-1.0", "gemini-3.8-live"] }; break;
      case "getPendingWatches": value = []; break;
      case "ackWatch": value = { ok: true }; break;
      case "getLiveRoomContext": case "getLiveRoomActivity": {
        const roomId = String(args[0]), room = this.fixture().rooms.find(r => r.id === roomId);
        value = { roomId, name: room?.name ?? "Demo room", description: null, objective: null,
          revision: "mock-context-v1", checkedAt: now(), panes: this.fixture().panes.filter(p => p.roomId === roomId && !p.isClosed).map(p => ({ id: p.id, title: p.title, mode: p.mode, runtimeId: p.terminalRuntimeId ?? null, status: p.status, configuredModelId: null, effectiveModelId: null, reasoningEffort: null, modelVerification: "SIMULATED", task: null })) }; break;
      }
      case "clearVoiceRealtimeLogs": {
        const roomId = String(args[0]); this.epochs[roomId] = (this.epochs[roomId] ?? 0) + 1;
        this.liveItems = this.liveItems.filter(item => item.roomId !== roomId);
        value = { ok: true, clearedRoomId: roomId, epoch: this.epochs[roomId] }; break;
      }
      case "reportLiveVoiceLog": value = { ok: true }; break;
      case "getVoiceRealtimeHistory": value = { ok: true, roomId: args[0], items: [] }; break;
      case "bindHarnessTitleSession": value = { ok: true }; break;
      case "saveLiveHistory": value = { receipts: (args[0] as any[]).map(({ item, epoch }) => {
        const accepted = args[1] === "user:demo-user" && epoch === (this.epochs[item.roomId] ?? 0);
        if (accepted) this.liveItems = [...this.liveItems.filter(row => row.id !== item.id), item];
        return { id: item.id, sessionId: item.sessionId, accepted };
      }) }; break;
      case "filesUpload": {
        const form = args[0] as FormData, dir = this.path(form.get("targetDir"));
        return { handled: true, value: Promise.all(form.getAll("files").map(async file => {
          if (!(file instanceof File)) return "";
          const path = this.path(`${dir}/${file.name.replaceAll("/", "_")}`); this.files.set(path, { directory: false, content: await file.text() }); return path;
        })).then(files => ({ ok: true, uploadedCount: files.length, files })) };
      }
      case "roomAgentHistory": value = { data: [], pagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 } }; break;
      case "roomAgent": case "sendRoomAgentMessage": case "clearRoomAgentTranscript": case "stopRoomAgent": case "controlRoomAgent": case "acknowledgeRoomAgentCommand": {
        const roomId = String(args[0]); let messages = this.roomMessages.get(roomId) ?? [];
        if (method === "sendRoomAgentMessage") messages = [...messages, { id: this.id("room_message"), role: "user", content: String(args[1]), status: "COMPLETED", createdAt: now() }, { id: this.id("room_message"), role: "assistant", content: "Your request is recorded in this local demo. Use Create and Workspace to explore the available tools.", status: "COMPLETED", createdAt: now() }];
        if (method === "clearRoomAgentTranscript") messages = [];
        this.roomMessages.set(roomId, messages);
        value = { roomId, paneId: null, sessionId: `room_agent:demo:${roomId}`, threadId: `thread:demo:${roomId}`, status: "IDLE", statusReason: "Local demo conversation", modelId: "gpt-6.1-sol", reasoningEffort: "high", messages, activeMission: null, queuedMissionCount: 0, currentPaneId: null, activePaneIds: [], progress: { totalSteps: 0, completedSteps: 0, runningSteps: 0, queuedSteps: 0, blockedSteps: 0, peakConcurrency: 0, elapsedMs: 0 }, capabilities: { canSend: true, canPause: false, canResume: false, canStop: false, canClear: true } }; break;
      }
      case "sharedChatMessages": value = { data: this.messages, nextCursor: null }; break;
      case "sendSharedChatMessage": {
        const message = { id: this.id("message"), senderType: "user", senderId: "user:demo-user", senderLabel: "Demo user", roomId: input.roomId ?? null, kind: "message", content: String(input.content), metadata: {}, replyToId: null, createdAt: now() };
        this.messages.push(message);
        this.messages.push({ ...message, id: this.id("message"), senderType: "agent", senderId: "agent:demo", senderLabel: "Space assistant", content: `I received your message: ${input.content}. This conversation stays in the demo.` });
        value = message; break;
      }
      case "clearSharedChat": value = { deletedCount: this.messages.length }; this.messages = []; break;
      case "agentSessions": {
        const rows = this.sessions.filter(s => (input.includeArchived || !s.archived) && (!input.q || s.title.toLowerCase().includes(String(input.q).toLowerCase())));
        value = { data: rows, totalItems: rows.length, visibleItems: rows.length, checkedAt: now() }; break;
      }
      case "agentSessionRename": case "agentSessionArchive": {
        const row = this.sessions.find(s => s.threadId === args[0]);
        if (!row) throw new SpaceApiError("Session not found.", { status: 404, code: "NOT_FOUND" });
        if (method === "agentSessionRename") row.title = String(args[1]); else row.archived = true;
        value = { ...row }; break;
      }
      case "filesList": {
        const path = this.path(input.path);
        const entries = [...this.files.keys()].filter(p => p !== path && p.slice(0, p.lastIndexOf("/")) === path).map(p => this.file(p));
        value = { currentPath: path, parentPath: path === workspace ? null : path.slice(0, path.lastIndexOf("/")), workspaceRoot: workspace, isAdminMode: false, canGoUp: path !== workspace, entries, totalCount: entries.length }; break;
      }
      case "filesRead": {
        const path = this.path(input.path); const entry = this.file(path);
        value = { path, name: entry.name, size: entry.size, mimeType: "text/plain", isBinary: false, content: this.files.get(path)!.content, permissions: entry.permissions, octalPermissions: entry.octalPermissions, mtime: now(), editable: true }; break;
      }
      case "filesCreate": this.files.set(this.path(input.path), { directory: input.type === "directory", content: "" }); value = { ok: true, path: input.path }; break;
      case "filesWrite": this.files.set(this.path(input.path), { directory: false, content: String(input.content ?? "") }); value = { ok: true, path: input.path }; break;
      case "filesRename": {
        const old = this.path(input.oldPath), next = this.path(input.newPath);
        for (const [path, record] of [...this.files]) if (path === old || path.startsWith(old + "/")) { this.files.delete(path); this.files.set(next + path.slice(old.length), record); }
        value = { ok: true, oldPath: old, newPath: next }; break;
      }
      case "filesDelete": {
        const path = this.path(input.path); for (const p of [...this.files.keys()]) if (p === path || p.startsWith(path + "/")) this.files.delete(p);
        value = { ok: true, path }; break;
      }
      case "filesSearch": {
        const results = [...this.files.keys()].filter(p => p.includes(String(input.query ?? ""))).map(p => this.file(p)); value = { query: input.query, results, totalCount: results.length }; break;
      }
      case "filesDiskUsage": value = { ok: true, disk: { totalBytes: 104857600, usedBytes: 20971520, freeBytes: 83886080, usedPercent: 20, totalFormatted: "100 MB", usedFormatted: "20 MB", freeFormatted: "80 MB", updatedAt: now() }, lastUpdated: now() }; break;
      case "filesDownloadUrl": case "filesRawUrl": value = "data:text/plain," + encodeURIComponent(this.files.get(this.path(input.path ?? input))?.content ?? ""); break;
      case "filesChmod": value = { ok: true }; break;
      case "youtubePlayback": value = { playback: this.playback.get(String(args[0])) ?? { videoId: "SpacePromo1", playlistId: null, index: 0, seconds: 0, title: "Discover Space", updatedAt: Date.now() } }; break;
      case "saveYouTubePlayback": this.playback.set(String(args[0]), args[1]); value = { ok: true }; break;
      case "watchYouTube": value = { currentUrl: "https://www.youtube.com/watch?v=SpacePromo1" }; break;
      case "stopBrowserSession": value = { ok: true }; break;
      case "browserAccounts": case "youtubeAccounts": value = { selectedProfileId: "profile:demo", profiles: [{ profileId: "profile:demo", displayName: "Demo profile" }] }; break;
      case "selectBrowserAccount": case "selectYouTubeAccount": value = { selectedProfileId: args[1], targetUrl: "https://spaceapp.dev/" }; break;
      case "vncPresets": value = { presets: [{ id: "demo-desktop", name: "Demo desktop", host: "demo.local", port: 5900 }] }; break;
      case "vncStreamWebSocketUrl": value = "demo-vnc://local"; break;
      case "browserSession": case "startBrowserSession": case "updateBrowserSession": case "navigateBrowser": case "setBrowserViewport": case "browserInput": {
        const paneId = String(args[0]), state = this.browser(paneId);
        const changes = typeof args[1] === "object" ? args[1] as any : {};
        const url = method === "navigateBrowser" ? String(args[1]) : changes.targetUrl;
        if (url) { state.session.currentUrl = state.session.targetUrl = state.frame.currentUrl = url; const active = state.session.pages.find((p: any) => p.pageId === state.session.activePageId); if (active) { active.url = url; active.title = url; } }
        if (changes.viewport || method === "setBrowserViewport") state.session.viewport = state.frame.viewport = changes.viewport ?? args[1];
        if (changes.streamMode) state.session.streamMode = changes.streamMode;
        value = state; break;
      }
      case "browserFrame": value = this.browser(String(args[0])).frame; break;
      case "browserStreamTicket": value = { websocket: this.browser(String(args[0])).websocket }; break;
      case "browserFrameWebSocketUrl": value = `demo-browser://local/${encodeURIComponent((args[0] as any).paneId)}`; break;
      case "browserStreamWebSocketUrl": value = null; break;
      case "browserPages": value = this.pagePayload(String(args[0])); break;
      case "createBrowserPage": case "activateBrowserPage": case "closeBrowserPage": {
        const paneId = String(args[0]), state = this.browser(paneId);
        if (method === "createBrowserPage") { const page = { pageId: this.id("browser_page"), kind: "PAGE", url: (args[1] as any)?.url ?? "about:blank", title: "New tab", isActive: true, openerPageId: null, canGoBack: false, canGoForward: false }; state.session.pages.push(page); state.session.activePageId = page.pageId; }
        if (method === "activateBrowserPage") state.session.activePageId = String(args[1]);
        if (method === "closeBrowserPage") { state.session.pages = state.session.pages.filter((p: any) => p.pageId !== args[1]); state.session.activePageId = state.session.pages[0]?.pageId ?? null; }
        for (const p of state.session.pages) p.isActive = p.pageId === state.session.activePageId;
        const active = state.session.pages.find((p: any) => p.isActive); if (active) state.session.currentUrl = state.frame.currentUrl = active.url;
        value = this.pagePayload(paneId); break;
      }
      case "browserBookmarks": case "addBrowserBookmark": {
        const paneId = String(args[0]), { session } = this.browser(paneId), rows = this.bookmarks.get(paneId) ?? [];
        if (method === "addBrowserBookmark") rows.push({ id: this.id("bookmark"), title: (args[1] as any)?.title ?? session.currentUrl, url: (args[1] as any)?.url ?? session.currentUrl, createdAt: now() });
        this.bookmarks.set(paneId, rows); value = { sessionId: session.sessionId, paneId, roomId: session.roomId, bookmarks: rows }; break;
      }
      case "openBrowserBookmark": { const state = this.browser(String(args[0])), row = this.bookmarks.get(String(args[0]))?.find(b => b.id === args[1]); if (row) state.session.currentUrl = state.frame.currentUrl = row.url; value = state; break; }
      case "browserBookmarksExportUrl": value = "data:application/json," + encodeURIComponent(JSON.stringify({ bookmarks: this.bookmarks.get(String(args[0])) ?? [] })); break;
      case "browserAction": value = { ok: true, frame: this.browser(String(args[0])).frame, text: "Space local browser preview" }; break;
      case "harnessHealth": value = { ok: true, status: 200 }; break;
      case "demoState": value = this.demoState(); break;
      case "demoCatalog": value = structuredClone(mockProjectCatalog); break;
      case "demoSaveSelection": this.selection = { ...this.selection, ...input }; value = this.demoState(); break;
      case "demoStartRun": case "demoRestartRun": this.run = { id: "demo_run:local", ...this.selection, status: "RUNNING", port: null, previewPath: media("demo-projects-preview.html"), health: { ok: true, checkedAt: now(), latencyMs: 1, detail: "Local sample preview" }, startedAt: now(), stoppedAt: null, lastError: null, logEntries: 1 }; value = this.demoState(); break;
      case "demoStopRun": if (this.run) this.run = { ...this.run, status: "STOPPED", stoppedAt: now() }; value = this.demoState(); break;
      case "demoOperations": value = { data: [], pending: 0, failed: 0 }; break;
      case "demoAccounts": value = { data: [], totalItems: 0, page: 1, pageSize: 10, source: "sample", refreshedAt: now() }; break;
      case "demoTests": case "demoTestRuns": value = { data: [], lastRun: null }; break;
      case "demoRunLogs": value = { runId: "demo_run:local", entries: [{ seq: 1, at: now(), stream: "system", line: "Local preview is ready." }], nextSeq: 1, dropped: false }; break;
      case "demoVariantFiles": value = { variantId: this.selection.variantId, files: [{ path: "README.md", bytes: 30, group: "docs", lines: 2 }], workspacePath: workspace }; break;
      case "demoVariantFile": value = { path: String(args[1] ?? "README.md"), content: "# Space example\nLocal demo preview.\n", truncated: false }; break;
      case "demoRunTests": value = { testRun: { id: "demo_test:local", projectId: this.selection.projectId, variantId: this.selection.variantId, mode: "SAMPLE", status: "PASSED", startedAt: now(), finishedAt: now(), steps: [{ key: "local-preview", label: "Local preview fixture", status: "PASSED", detail: "Simulated example check. No child service or backend test was run.", durationMs: 1 }] } }; break;
      case "cliModelSettingsStatus": {
        const current = this.modelSettings.get(String(args[0])) ?? { modelId: "gpt-6.1-sol", reasoningEffort: "high" };
        value = { status: "AVAILABLE", settings: { sessionId: `cli_session:${args[0]}`, threadId: null, current, models: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"].map(id => ({ id, displayName: id, isDefault: id === current.modelId, defaultReasoningEffort: "high", supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] })), controlMode: "DIRECT", isTurnActive: false } }; break;
      }
      case "updateCliModelSettings": this.modelSettings.set(String(args[0]), args[1] as any); value = { current: args[1], message: "Model selection saved in the demo." }; break;
      default: return { handled: false };
    }
    return { handled: true, value: structuredClone(value) };
  }
}
