import { Writable } from "node:stream";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserHostHealth } from "@space/browser-host";
import { launchReadinessSchema, observabilitySnapshotSchema, type BrowserCaptureJob, type BrowserFrame, type BrowserPageSummary, type BrowserSessionViewport, type BrowserToolActionInput, type DummyTurnInput, type Pane, type PaneBrowserSessionResponse } from "@space/contracts";
import { storageReadinessSchema, workerReadinessSchema } from "@space/contracts";
import { InMemoryAppDiagnosticsRepository } from "@space/db";
import { InMemorySpaceStore, SpaceFeatureDisabledError, createCanonicalSpaceMemoryBridge, hashMcpSchema } from "@space/runtime";
import { createApp as createApiApp, redactRequestUrlForLog, sweepExpiredBrowserArtifacts, type CreateAppOptions } from "../src/app.js";
import { AppDiagnosticsService } from "../src/app-diagnostics.js";
import { createCsrfToken, hashPassword, signSession, signSessionWithTtl } from "../src/auth.js";
import type { BrowserSessionManager } from "../src/browser-sessions.js";
import { cliBrowserBridgeTokenHeader, issueCliBrowserBridgeToken } from "../src/cli-browser-bridge.js";
import { getApiConfig } from "../src/config.js";
import { fetchPublicUrl } from "../src/public-url-fetch.js";
import type { SpaceAgentControl } from "../src/space-agent.js";

vi.mock("../src/public-url-fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/public-url-fetch.js")>();
  return { ...actual, fetchPublicUrl: vi.fn(actual.fetchPublicUrl) };
});

// These readiness checks need the postgres runtime flag but never touch a
// database. t3-env (fa4e165e7c) rejects SPACE_RUNTIME_STORE=postgres without a
// URL, so set the flag on the parsed config instead of inventing a URL that
// would make createApp build real Postgres repositories.
function postgresBackedConfig(env: Record<string, string>) {
  return { ...getApiConfig(env), runtimeStore: "postgres" as const };
}

// Always close owned app fixtures, including tests that fail before app.close().
// Otherwise background collectors and host clients leak into subsequent tests.
const ownedApps = new Set<Awaited<ReturnType<typeof createApiApp>>>();
async function createApp(options: CreateAppOptions = {}) {
  const app = await createApiApp(options);
  ownedApps.add(app);
  app.addHook("onClose", async () => { ownedApps.delete(app); });
  return app;
}
afterEach(async () => {
  const closing = [...ownedApps];
  ownedApps.clear();
  await Promise.all(closing.map((app) => app.close()));
});

const csrfHeaderName = "x-space-csrf-token";
const execFileAsync = promisify(execFile);
const fixturePath = fileURLToPath(new URL("./fixtures/stdio-mcp-server.mjs", import.meta.url));
const fixtureToolInputSchema = {
  type: "object",
  properties: {
    path: { type: "string" }
  },
  required: ["path"],
  additionalProperties: false
};
const fixtureToolSchemaHash = hashMcpSchema(fixtureToolInputSchema);
const pngImage = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d
]);

function multipartImagePayload(parts: Array<{ field?: string; filename?: string; mimeType?: string; body?: Buffer }>) {
  const boundary = "space-api-test-boundary";
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${part.field ?? "file"}"; filename="${part.filename ?? "image.png"}"\r\n` +
          `Content-Type: ${part.mimeType ?? "image/png"}\r\n\r\n`
      )
    );
    chunks.push(part.body ?? pngImage);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

const immediateTurnStarter = {
  plan(input: DummyTurnInput) {
    return {
      workflowId: `workflow:dummy:${input.roomId}:${input.paneId}:${input.traceId}`,
      runId: null,
      roomId: input.roomId,
      paneId: input.paneId,
      traceId: input.traceId,
      status: "QUEUED" as const,
      runtime: "DUMMY_TEMPORAL" as const,
      artifactIds: input.artifactIds
    };
  },
  async start(input: DummyTurnInput) {
    return {
      workflowId: `workflow:dummy:${input.roomId}:${input.paneId}:${input.traceId}`,
      runId: "run:test-turn",
      roomId: input.roomId,
      paneId: input.paneId,
      traceId: input.traceId,
      status: "QUEUED" as const,
      runtime: "DUMMY_TEMPORAL" as const,
      artifactIds: input.artifactIds
    };
  }
};

const readyCodexAgentControl = {
  async readConfigRequirements() {
    return {
      allowedApprovalPolicies: ["on-request", "never"],
      allowedApprovalsReviewers: ["user", "guardian_subagent"],
      allowedSandboxModes: ["workspace-write", "danger-full-access"],
      defaultPermissions: null
    };
  },
  async listModels() {
    return [
      {
        id: "gpt-5.4-mini",
        displayName: "gpt-5.4-mini",
        description: "Deterministic API test model.",
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["medium"]
      }
    ];
  },
  async listCollaborationModes() {
    return [{ name: "Default", mode: "default" as const, model: null, reasoning_effort: null }];
  },
  async setGoal() {
    throw new Error("Goal control is not used by this API test.");
  },
  async clearGoal() {
    throw new Error("Goal control is not used by this API test.");
  }
} satisfies SpaceAgentControl;

function fakeBrowserSessionManager(options: { enabled?: boolean; defaultUrl?: string } = {}): BrowserSessionManager {
  const enabled = options.enabled ?? true;
  const defaultUrl = options.defaultUrl ?? "https://www.google.com/";
  const sessionFor = (pane: Pane, viewport: BrowserSessionViewport = "desktop", currentUrl = defaultUrl): PaneBrowserSessionResponse => {
    const timestamp = "2026-07-05T00:00:00.000Z";
    const session = {
      sessionId: `browser_session:${pane.id.replace(/[^A-Za-z0-9_-]/g, "_")}`,
      paneId: pane.id,
      roomId: pane.roomId,
      ownerAgentId: "agent:1",
      agentNumber: 1,
      profileId: `profile:${pane.id}`,
      profilePath: `/opt/spaceapp/var/artifacts/browser-profiles/${pane.id}`,
      viewport,
      targetUrl: currentUrl,
      currentUrl,
      title: "Olla",
      status: "READY" as const,
      statusReason: "Page ready.",
      lastFrameAt: timestamp,
      streamMode,
      resolvedStreamMode: streamMode === "AUTO" ? ("INTERACTIVE" as const) : streamMode,
      runtimeState: "READY" as const,
      capacityState: "AVAILABLE" as const,
      controlState: controlLease?.status === "ACTIVE" ? controlLease.holderType : ("UNCONTROLLED" as const),
      pages,
      activePageId,
      workerHeartbeatAt: timestamp,
      queuePosition: null,
      isActive: true,
      startedAt: timestamp,
      updatedAt: timestamp,
      endedAt: null
    };
    const frame: BrowserFrame = {
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: pane.roomId,
      status: "READY",
      viewport,
      currentUrl,
      title: "Olla",
      screenshotDataUrl: "data:image/png;base64,aGVsbG8=",
      capturedAt: timestamp
    };
    return {
      session,
      frame,
      websocket: {
        paneId: pane.id,
        sessionId: session.sessionId,
        token: "browser-frame-ticket-test-value",
        expiresAt: "2026-07-05T00:01:00.000Z"
      }
    };
  };
  let lastPane: Pane | null = null;
  let lastViewport: BrowserSessionViewport = "desktop";
  let lastUrl = defaultUrl;
  let streamMode: "AUTO" | "SILENT" | "PREVIEW" | "INTERACTIVE" | "REALTIME" = "AUTO";
  let activePageId: string | null = "page:main";
  let pages: BrowserPageSummary[] = [
    {
      pageId: activePageId,
      kind: "PAGE" as const,
      url: defaultUrl,
      title: "Olla",
      isActive: true,
      openerPageId: null,
      canGoBack: false,
      canGoForward: false
    }
  ];
  let controlLease: {
    leaseId: string;
    sessionId: string;
    paneId: string;
    roomId: string;
    holderType: "AGENT" | "OPERATOR";
    holderId: string;
    status: "ACTIVE" | "RELEASED";
    reason: string | null;
    acquiredAt: string;
    heartbeatAt: string;
    expiresAt: string;
    releasedAt: string | null;
  } | null = null;
  let captureJob: BrowserCaptureJob | null = null;
  return {
    status: () => ({
      enabled,
      statusReason: enabled ? "Managed Chrome browser sessions are enabled." : "SPACE_BROWSER_SESSIONS_ENABLED must be true before managed Chrome sessions can start.",
      defaultUrl,
      checkedAt: "2026-07-05T00:00:00.000Z"
    }),
    async startOrRestore(input) {
      if (!enabled) throw new Error("BROWSER_SESSIONS_DISABLED");
      lastPane = input.pane;
      lastViewport = input.viewport ?? "desktop";
      lastUrl = input.targetUrl ?? defaultUrl;
      streamMode = input.streamMode ?? "AUTO";
      return sessionFor(input.pane, lastViewport, lastUrl);
    },
    async getActive(pane) {
      lastPane = pane;
      return sessionFor(pane, lastViewport, lastUrl);
    },
    async navigate(pane, url) {
      lastPane = pane;
      lastUrl = url;
      return sessionFor(pane, lastViewport, lastUrl);
    },
    async setViewport(pane, viewport) {
      lastPane = pane;
      lastViewport = viewport;
      return sessionFor(pane, lastViewport, lastUrl);
    },
    async setStreamMode(pane, mode) {
      lastPane = pane;
      streamMode = mode;
      return sessionFor(pane, lastViewport, lastUrl);
    },
    async listPages(pane) {
      return { sessionId: sessionFor(pane).session.sessionId, activePageId, pages };
    },
    async createPage(pane, url, activate) {
      const pageId = `page:${pages.length + 1}`;
      if (activate) {
        pages = pages.map((page) => ({ ...page, isActive: false }));
        activePageId = pageId;
      }
      pages.push({
        pageId,
        kind: "PAGE",
        url: url ?? "about:blank",
        title: null,
        isActive: activate,
        openerPageId: null,
        canGoBack: false,
        canGoForward: false
      });
      return { sessionId: sessionFor(pane).session.sessionId, activePageId, pages };
    },
    async activatePage(pane, pageId) {
      activePageId = pageId;
      pages = pages.map((page) => ({ ...page, isActive: page.pageId === pageId }));
      return { sessionId: sessionFor(pane).session.sessionId, activePageId, pages };
    },
    async closePage(pane, pageId) {
      pages = pages.filter((page) => page.pageId !== pageId);
      if (activePageId === pageId) activePageId = pages[0]?.pageId ?? null;
      pages = pages.map((page) => ({ ...page, isActive: page.pageId === activePageId }));
      return { sessionId: sessionFor(pane).session.sessionId, activePageId, pages };
    },
    async acquireControl(pane, input) {
      const timestamp = "2026-07-05T00:00:00.000Z";
      controlLease = {
        leaseId: "browser_lease:test",
        sessionId: sessionFor(pane).session.sessionId,
        paneId: pane.id,
        roomId: pane.roomId,
        holderType: input.holderType,
        holderId: input.holderId,
        status: "ACTIVE",
        reason: input.reason ?? null,
        acquiredAt: timestamp,
        heartbeatAt: timestamp,
        expiresAt: "2026-07-05T00:05:00.000Z",
        releasedAt: null
      };
      return controlLease;
    },
    async heartbeatControl(_pane, input) {
      if (!controlLease || controlLease.leaseId !== input.leaseId) throw new Error("missing lease");
      return controlLease;
    },
    async releaseControl(_pane, input) {
      if (!controlLease || controlLease.leaseId !== input.leaseId) throw new Error("missing lease");
      controlLease = { ...controlLease, status: "RELEASED", releasedAt: "2026-07-05T00:01:00.000Z" };
      return controlLease;
    },
    async input(pane, input) {
      if (!controlLease || controlLease.leaseId !== input.leaseId || controlLease.status !== "ACTIVE") throw new Error("missing lease");
      return sessionFor(pane, lastViewport, lastUrl);
    },
    async createCapture(pane, captureOptions, context) {
      const timestamp = "2026-07-05T00:00:00.000Z";
      captureJob = {
        jobId: "browser_capture_job:test",
        sessionId: sessionFor(pane).session.sessionId,
        paneId: pane.id,
        roomId: pane.roomId,
        requestedByType: context.requestedByType,
        requestedById: context.requestedById,
        status: "QUEUED" as const,
        options: captureOptions,
        progressPercent: 0,
        statusReason: "Capture queued.",
        artifactIds: [],
        queuedAt: timestamp,
        startedAt: null,
        updatedAt: timestamp,
        completedAt: null
      };
      return captureJob;
    },
    async getCapture(_pane, jobId) {
      if (!captureJob || captureJob.jobId !== jobId) throw new Error("missing capture");
      return captureJob;
    },
    async stopCapture(_pane, jobId) {
      if (!captureJob || captureJob.jobId !== jobId) throw new Error("missing capture");
      captureJob = {
        ...captureJob,
        status: "COMPLETED",
        progressPercent: 100,
        statusReason: "Capture stopped and saved.",
        updatedAt: "2026-07-05T00:01:00.000Z",
        completedAt: "2026-07-05T00:01:00.000Z"
      };
      return captureJob;
    },
    async cancelCapture(_pane, jobId) {
      if (!captureJob || captureJob.jobId !== jobId) throw new Error("missing capture");
      captureJob = {
        ...captureJob,
        status: "CANCELLED",
        statusReason: "Capture cancelled and discarded.",
        updatedAt: "2026-07-05T00:01:00.000Z",
        completedAt: "2026-07-05T00:01:00.000Z"
      };
      return captureJob;
    },
    async diagnostics(pane) {
      return {
        sessionId: sessionFor(pane).session.sessionId,
        events: [
          {
            eventId: "browser_event:test",
            sessionId: sessionFor(pane).session.sessionId,
            pageId: activePageId,
            sequence: 1,
            type: "CONSOLE",
            level: "INFO",
            message: "console ok",
            frameIndex: null,
            metadata: {},
            occurredAt: "2026-07-05T00:00:00.000Z"
          }
        ]
      };
    },
    async action(pane, input: BrowserToolActionInput) {
      lastPane = pane;
      if (input.type === "navigate") lastUrl = input.url;
      if (input.type === "set_viewport") lastViewport = input.viewport;
      const response = sessionFor(pane, lastViewport, lastUrl);
      let text: string | null = null;
      if (input.type === "extract_text") text = "Olla observed text.";
      if (input.type === "diagnostics") {
        text = JSON.stringify({
          consoleEntries: [{ type: "log", values: ["bridge console ok"] }],
          networkEntries: input.includeNetwork ? [{ type: "response", status: 200, url: "https://www.google.com/" }] : [],
          capturedAt: "2026-07-05T00:00:00.000Z"
        });
      }
      if (input.type === "record") {
        text = JSON.stringify({
          recordingId: "browser_recording:test",
          frameCount: 2,
          framesDir: "/opt/spaceapp/var/artifacts/browser-recordings/browser_recording_test/frames",
          gifPath: input.format === "webm" ? null : "/opt/spaceapp/var/artifacts/browser-recordings/browser_recording_test/recording.gif",
          webmPath: input.format === "gif" ? null : "/opt/spaceapp/var/artifacts/browser-recordings/browser_recording_test/recording.webm"
        });
      }
      return { session: response.session, frame: response.frame, text };
    },
    async captureFrame(sessionId) {
      const pane = lastPane ?? ({
        id: "pane:browser",
        roomId: "room:test",
        title: "Browser",
        mode: "BROWSER",
        status: "IDLE",
        providerId: null,
        modelId: null,
        reasoningEffort: "medium",
        cwd: null,
        order: 0,
        isMaximized: false,
        isMinimized: false,
        isClosed: false,
        split: { parentId: null, direction: null, size: null },
        createdAt: "2026-07-05T00:00:00.000Z",
        updatedAt: "2026-07-05T00:00:00.000Z"
      } as Pane);
      return { ...sessionFor(pane, lastViewport, lastUrl).frame!, sessionId };
    },
    async stopPane() {},
    async stopRoom() {},
    async closeAll() {},
    issueFrameTicket(paneId, sessionId) {
      return { paneId, sessionId, token: "browser-frame-ticket-test-value", expiresAt: "2026-07-05T00:01:00.000Z" };
    },
    acceptFrameTicket() {
      return true;
    }
  };
}

async function authedApp(
  options: CreateAppOptions = {},
  loginInput = { email: "space@space.local", password: "space-dev" },
  beforeFirstRequest?: (app: Awaited<ReturnType<typeof createApp>>) => void
) {
  let canonicalMemory = options.canonicalMemory;
  if (!canonicalMemory) {
    const configuredPaths =
      options.config &&
      (!options.config.spaceMemoryIndexPath.startsWith("/opt/spaceapp/docs/") || !options.config.spaceMemoryMonthlyPath.startsWith("/opt/spaceapp/docs/"))
        ? {
            indexPath: options.config.spaceMemoryIndexPath,
            monthlyPath: options.config.spaceMemoryMonthlyPath
          }
        : await createSpaceMemoryFixture();
    canonicalMemory = createCanonicalSpaceMemoryBridge(configuredPaths);
  }
  const app = await createApp({
    ...options,
    canonicalMemory,
    auth: {
      sessionSecret: "test-secret-with-enough-length",
      devLogin: true,
      secureCookies: false,
      ...(options.auth ?? {})
    }
  });
  beforeFirstRequest?.(app);
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: loginInput
  });
  const cookie = login.cookies.find((entry) => entry.name === "space_session")?.value;
  const cookieHeader = `space_session=${cookie}`;
  const csrf = await app.inject({
    method: "GET",
    url: "/api/auth/csrf",
    headers: { cookie: cookieHeader }
  });
  return { app, cookie: cookieHeader, csrfToken: csrf.json().csrfToken as string };
}

async function createSpaceMemoryFixture(options: { monthlyExtraLines?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "space-gemini-memory-"));
  const indexPath = join(root, "gemini_history.md");
  const monthlyPath = join(root, "gemini_history_2026-07.md");
  const extraMonthlyLines = Array.from(
    { length: options.monthlyExtraLines ?? 0 },
    (_, index) => `- Extra canonical memory fixture line ${index}.`
  );
  await writeFile(
    indexPath,
    [
      "# Gemini History Index",
      "",
      "- 2026-07: Space sync marker `canonical-index-marker` routes to current month.",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    monthlyPath,
    [
      "# Gemini History 2026-07",
      "",
      "## 2026-07-06 - Existing canonical Space memory",
      "",
      "- Existing canonical monthly marker: `canonical-monthly-marker`.",
      ...extraMonthlyLines,
      ""
    ].join("\n"),
    "utf8"
  );
  return { root, indexPath, monthlyPath };
}

async function createCodexGoalsFixture() {
  const root = await mkdtemp(join(tmpdir(), "space-codex-goals-"));
  const dbPath = join(root, "goals_1.sqlite");
  await execFileAsync("sqlite3", [
    dbPath,
    [
      "CREATE TABLE thread_goals (",
      "thread_id TEXT PRIMARY KEY NOT NULL,",
      "goal_id TEXT NOT NULL,",
      "objective TEXT NOT NULL,",
      "status TEXT NOT NULL CHECK(status IN ('active','paused','blocked','usage_limited','budget_limited','complete')),",
      "token_budget INTEGER,",
      "tokens_used INTEGER NOT NULL DEFAULT 0,",
      "time_used_seconds INTEGER NOT NULL DEFAULT 0,",
      "created_at_ms INTEGER NOT NULL,",
      "updated_at_ms INTEGER NOT NULL",
      ");",
      "INSERT INTO thread_goals VALUES ('019f-space-thread-1','goal:space-1','Ship canonical shared state','active',1000,125,30,1783300000000,1783300005000);"
    ].join("\n")
  ]);
  return { root, dbPath };
}

class AuditFkCheckingStore extends InMemorySpaceStore {
  private readonly persistedUserIds = new Set<string>();

  override upsertUser(user: Parameters<InMemorySpaceStore["upsertUser"]>[0]) {
    const persisted = super.upsertUser(user);
    this.persistedUserIds.add(persisted.id);
    return persisted;
  }

  override recordAuditEvent(input: Parameters<InMemorySpaceStore["recordAuditEvent"]>[0]) {
    if (input.actorUserId && !this.persistedUserIds.has(input.actorUserId)) {
      throw new Error(`audit actor missing: ${input.actorUserId}`);
    }
    return super.recordAuditEvent(input);
  }
}

describe("Space API", () => {
  it("keeps default in-memory diagnostics files isolated from the configured persistent root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "space-api-diagnostics-isolation-"));
    const configuredRoot = join(parent, "persistent-root");
    const app = await createApp({
      config: getApiConfig({ SPACE_APP_DIAGNOSTICS_ROOT: configuredRoot })
    });

    try {
      await app.ready();
      await expect(stat(configuredRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await app.close();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("redacts sensitive request query params before logging", () => {
    expect(
      redactRequestUrlForLog(
        "/api/panes/pane%3Aabc/cli/terminal?sessionId=cli_session%3Aone&token=raw-terminal-ticket&mode=attach"
      )
    ).toBe("/api/panes/pane%3Aabc/cli/terminal?sessionId=cli_session%3Aone&token=%5BREDACTED%5D&mode=attach");
    expect(redactRequestUrlForLog("/api/browser/frames?access_token=raw-frame-ticket&safe=1")).toBe(
      "/api/browser/frames?access_token=%5BREDACTED%5D&safe=1"
    );
    expect(redactRequestUrlForLog("/api/clipboard-items?q=private+fallback&source=COPY")).toBe(
      "/api/clipboard-items?q=%5BREDACTED%5D&source=COPY"
    );
  });

  it("returns health without authentication", async () => {
    const app = await createApp({
      auth: {
        sessionSecret: "test-secret-with-enough-length",
        devLogin: true,
        secureCookies: false
      }
    });

    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, service: "space-api" });
  });

  it("returns sanitized Space integration inventory for authenticated operators", async () => {
    const { app, cookie } = await authedApp({
      spaceCapabilityInventoryCollector: async () => ({
        id: "space-capability-snapshot",
        generatedAt: "2026-07-06T04:40:00.000Z",
        status: "VERIFIED",
        statusReason: "Inventory collected from test helper.",
        sources: [
          {
            id: "codex-mcp-list",
            label: "Codex MCP list",
            status: "VERIFIED",
            statusReason: "Default MCP servers discovered.",
            lastCheckedAt: "2026-07-06T04:39:59.000Z"
          }
        ],
        mcpServers: [
          {
            id: "devtools",
            displayName: "DevTools",
            transport: "stdio",
            status: "DISABLED",
            statusReason: "Metadata only; Space execution policy is required."
          }
        ],
        skills: [
          {
            id: "browser-testing-with-devtools",
            displayName: "Browser Testing With Devtools",
            source: "CODEX_SKILL",
            status: "VERIFIED",
            statusReason: "Read-only shared Codex skill.",
            contentHash: "sha256:test"
          }
        ],
        memory: {
          canonicalIndexPath: "/opt/spaceapp/docs/gemini_history.md",
          currentMonthPath: "/opt/spaceapp/docs/gemini_history_2026-07.md",
          status: "VERIFIED",
          statusReason: "Canonical Space Memory files are readable."
        },
        vscode: { extensions: [] },
        cliRuntimes: [{ id: "cli:codex", displayName: "Codex CLI", status: "ENABLED", statusReason: "Verified." }],
        codexLbRoute: { status: "VERIFIED", mode: "headroom", selectedAt: null, activeUpstreams: ["headroom", "primary"] },
        gates: [{ id: "mcp-execution", status: "WARN", statusReason: "Approval required." }]
      })
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/integrations/space",
      headers: { cookie }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "space-capability-snapshot",
      status: "VERIFIED",
      mcpServers: [expect.objectContaining({ id: "devtools", status: "DISABLED" })],
      skills: [expect.objectContaining({ source: "CODEX_SKILL" })]
    });
    expect(JSON.stringify(response.json())).not.toMatch(new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i"));
  });

  it("returns pane-scoped capability matrices for every pane mode", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Capability Matrix", initialPaneCount: 0 }, "trace:room");
    const paneModes: Pane["mode"][] = ["CHAT", "TERMINAL", "BROWSER", "CODE", "REVIEW", "SWARM", "DESIGN", "YOUTUBE"];
    const panes = paneModes.map((mode) => store.createPane({ roomId: room.id, title: mode, mode }, "trace:pane"));
    const { app, cookie } = await authedApp({ store });

    for (const pane of panes) {
      const response = await app.inject({
        method: "GET",
        url: `/api/panes/${encodeURIComponent(pane.id)}/capabilities`,
        headers: { cookie }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        paneId: pane.id,
        paneMode: pane.mode,
        groups: expect.arrayContaining([
          expect.objectContaining({ id: "memory" }),
          expect.objectContaining({ id: "skills" }),
          expect.objectContaining({ id: "mcp" })
        ])
      });
    }
  });

  it("returns the structured error contract when login rate limiting is exceeded on loopback", async () => {
    const app = await createApp({
      auth: {
        sessionSecret: "test-secret-with-enough-length",
        devLogin: true,
        secureCookies: false
      }
    });

    let response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "space@space.local", password: "space-dev" }
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "space@space.local", password: "space-dev" }
      });
    }

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({
      error: {
        code: "RATE_LIMITED",
        message: expect.stringContaining("Rate limit exceeded")
      }
    });
    expect(response.json().error.requestId).toMatch(/^req:/);
  });

  it("keeps login rate limits isolated by forwarded client IP behind the Space proxy", async () => {
    const app = await createApp({
      auth: {
        sessionSecret: "test-secret-with-enough-length",
        devLogin: true,
        secureCookies: false
      }
    });

    let response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "x-forwarded-for": "198.51.100.10" },
      payload: { email: "space@space.local", password: "space-dev" }
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "x-forwarded-for": "198.51.100.10" },
        payload: { email: "space@space.local", password: "space-dev" }
      });
    }
    expect(response.statusCode).toBe(429);

    const separateClient = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "x-forwarded-for": "198.51.100.11" },
      payload: { email: "space@space.local", password: "space-dev" }
    });

    expect(separateClient.statusCode).toBe(200);
    expect(separateClient.json()).toMatchObject({ isAuthenticated: true });
  });

  it("logs in with production auth when the operator email already exists from dev login", async () => {
    const store = new InMemorySpaceStore();
    store.upsertUser({ id: "user:dev-operator", email: "space@space.local", role: "ADMIN" });
    const operatorPasswordHash = await hashPassword("production-operator-password");
    const app = await createApp({
      store,
      auth: {
        sessionSecret: "test-secret-with-enough-length",
        devLogin: false,
        secureCookies: false,
        operatorEmail: "space@space.local",
        operatorPasswordHash
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "space@space.local", password: "production-operator-password" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      isAuthenticated: true,
      user: { id: "user:dev-operator", email: "space@space.local", role: "ADMIN" }
    });
    expect(response.cookies.find((entry) => entry.name === "space_session")?.name).toBe("space_session");
    expect(response.cookies.find((entry) => entry.name === "space_session")?.maxAge).toBe(60 * 60 * 24 * 30);
  });

  it("returns structured 404s for stale room-scoped requests", async () => {
    const { app, cookie } = await authedApp({ store: new InMemorySpaceStore() });

    for (const url of [
      "/api/panes?roomId=room%3Amissing",
      "/api/swarm?roomId=room%3Amissing",
      "/api/turns?roomId=room%3Amissing",
      "/api/events?roomId=room%3Amissing&pageSize=50&sortOrder=desc",
      "/api/rooms/room%3Amissing/agent-history"
    ]) {
      const response = await app.inject({ method: "GET", url, headers: { cookie } });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        error: {
          code: "NOT_FOUND",
          message: expect.stringContaining("Room room:missing was not found")
        }
      });
    }
  });

  it("returns the latest fifty events by default and accepts limit as a bounded page-size alias", async () => {
    vi.useFakeTimers();
    const store = new InMemorySpaceStore();
    vi.setSystemTime(new Date("2026-07-18T06:00:00.000Z"));
    const room = store.createRoom({ name: "Bounded events", initialPaneCount: 0 }, "trace:event-0");
    vi.setSystemTime(new Date("2026-07-18T06:00:00.001Z"));
    const pane = store.createPane(
      { roomId: room.id, title: "Bounded terminal", mode: "TERMINAL", cwd: "/etc" },
      "trace:event-1"
    );
    let eventIndex = 1;
    for (let index = 0; index < 27; index += 1) {
      eventIndex += 1;
      vi.setSystemTime(new Date(Date.parse("2026-07-18T06:00:00.000Z") + eventIndex));
      store.updatePane(pane.id, { isClosed: true }, `trace:event-${eventIndex}`);
      eventIndex += 1;
      vi.setSystemTime(new Date(Date.parse("2026-07-18T06:00:00.000Z") + eventIndex));
      store.updatePane(pane.id, { isClosed: false }, `trace:event-${eventIndex}`);
    }
    vi.useRealTimers();

    const { app, cookie } = await authedApp({ store });
    const defaultPage = await app.inject({
      method: "GET",
      url: `/api/events?roomId=${encodeURIComponent(room.id)}`,
      headers: { cookie }
    });

    expect(defaultPage.statusCode).toBe(200);
    expect(defaultPage.json()).toMatchObject({
      data: expect.any(Array),
      pagination: { page: 1, pageSize: 50, totalItems: 56, totalPages: 2 }
    });
    expect(defaultPage.json().data).toHaveLength(50);
    expect(defaultPage.json().data[0]).toMatchObject({ traceId: "trace:event-55" });

    const limited = await app.inject({
      method: "GET",
      url: `/api/events?roomId=${encodeURIComponent(room.id)}&limit=5`,
      headers: { cookie }
    });
    expect(limited.statusCode).toBe(200);
    expect(limited.json().pagination).toMatchObject({ page: 1, pageSize: 5, totalItems: 56, totalPages: 12 });
    expect(limited.json().data).toHaveLength(5);

    const invalid = await app.inject({ method: "GET", url: "/api/events?limit=101", headers: { cookie } });
    expect(invalid.statusCode).toBe(400);
  });

  it("exports public Prometheus metrics without exposing auth material", async () => {
    const app = await createApp({
      auth: {
        sessionSecret: "test-secret-with-enough-length",
        devLogin: true,
        secureCookies: false
      }
    });

    await app.inject({ method: "GET", url: "/healthz" });
    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain("space_http_requests_total");
    expect(response.body).toContain('route="/healthz"');
    const healthBuckets = response.body
      .split("\n")
      .filter((line) => line.startsWith("space_http_request_duration_seconds_bucket") && line.includes('route="/healthz"') && !line.includes('le="+Inf"'))
      .map((line) => Number(line.split(" ").at(-1)));
    expect(Math.max(...healthBuckets)).toBeLessThanOrEqual(1);
    expect(response.body).not.toContain("space_session");
    expect(response.body).not.toContain("test-secret");
  });

  it("accepts bounded authenticated CLI client events and exports low-cardinality metrics", async () => {
    const info = vi.fn();
    const { app, cookie, csrfToken } = await authedApp(
      {},
      { email: "space@space.local", password: "space-dev" },
      (instance) => {
        instance.addHook("preHandler", async (request) => {
          request.log.info = info;
        });
      }
    );
    const event = {
      event: "SOCKET_DISCONNECTED",
      outcome: "RETRY",
      reason: "SOCKET_CLOSE",
      paneId: "pane:terminal-control",
      sessionId: "cli_session:terminal-control",
      runtimeId: "cli:codex",
      controlState: "CONTROLLER",
      protocolVersion: 2,
      clientMode: "INTERACTIVE",
      socketGeneration: 3,
      attempt: 1,
      delayMs: 250,
      closeCode: 1006,
      wasClean: false,
      clientAt: "2026-07-23T08:00:00.000Z"
    };

    const unauthenticated = await app.inject({
      method: "POST",
      url: "/api/cli/client-events",
      payload: event
    });
    expect(unauthenticated.statusCode).toBe(401);

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/cli/client-events",
      headers: { cookie },
      payload: event
    });
    expect(missingCsrf.statusCode).toBe(403);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/cli/client-events",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { ...event, detail: "unbounded terminal text" }
    });
    expect(invalid.statusCode).toBe(422);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/cli/client-events",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: event
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ accepted: true });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "cli_terminal.lifecycle",
        source: "CLIENT",
        eventType: "SOCKET_DISCONNECTED",
        outcome: "RETRY",
        reason: "SOCKET_CLOSE",
        paneId: event.paneId,
        sessionId: event.sessionId,
        runtimeId: event.runtimeId,
        requestId: expect.stringMatching(/^req:/)
      }),
      "CLI terminal lifecycle event."
    );

    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.body).toContain("space_cli_terminal_events_total");
    expect(metrics.body).toContain(
      'source="CLIENT",event="SOCKET_DISCONNECTED",outcome="RETRY",reason="SOCKET_CLOSE"} 1'
    );
    expect(metrics.body).not.toContain(event.paneId);
    expect(metrics.body).not.toContain(event.sessionId);
  });

  it("protects the admin observability snapshot and validates its contract", async () => {
    const { app, cookie } = await authedApp();

    const unauthenticated = await app.inject({ method: "GET", url: "/api/admin/observability" });
    expect(unauthenticated.statusCode).toBe(401);

    await app.inject({ method: "GET", url: "/healthz" });
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/observability",
      headers: { cookie }
    });

    expect(response.statusCode).toBe(200);
    const snapshot = observabilitySnapshotSchema.parse(response.json());
    expect(snapshot.service).toBe("space-api");
    expect(snapshot.totals.requestCount).toBeGreaterThan(0);
    expect(snapshot.endpoints.some((endpoint) => endpoint.route === "/healthz")).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("space_session");
  });

  it("reports worker readiness through readyz and the protected admin endpoint", async () => {
    const workerReadiness = workerReadinessSchema.parse({
      id: "space-worker",
      status: "RUNNING",
      statusReason: "Temporal is reachable and pollers are visible.",
      address: "127.0.0.1:7233",
      namespace: "default",
      taskQueue: "space-agent-turns",
      reachable: true,
      workflowPollerCount: 1,
      activityPollerCount: 1,
      pollerCount: 2,
      workflowBacklogCount: 0,
      activityBacklogCount: 0,
      pollerIdentities: ["space-worker@test"],
      lastPollerAccessAt: "2026-06-26T00:00:00.000Z",
      checkedAt: "2026-06-26T00:00:01.000Z"
    });
    const { app, cookie } = await authedApp({
      workerReadinessChecker: async () => workerReadiness
    });

    const readyz = await app.inject({ method: "GET", url: "/readyz" });
    expect(readyz.statusCode).toBe(200);
    expect(readyz.json().dependencies.worker).toBe("RUNNING");

    const unauthenticated = await app.inject({ method: "GET", url: "/api/admin/worker" });
    expect(unauthenticated.statusCode).toBe(401);

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/worker",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(workerReadinessSchema.parse(response.json())).toMatchObject({
      status: "RUNNING",
      pollerCount: 2,
      taskQueue: "space-agent-turns"
    });
    expect(JSON.stringify(response.json())).not.toContain("space_session");
  });

  it("reports protected storage readiness without exposing secret material", async () => {
    const storageReadiness = storageReadinessSchema.parse({
      id: "space-storage",
      status: "BLOCKED",
      statusReason: "Dedicated /opt/spaceapp volume is not detected.",
      root: {
        path: "/",
        deviceId: "100",
        sizeBytes: 200 * 1024 * 1024 * 1024,
        availableBytes: 40 * 1024 * 1024 * 1024,
        usedPercent: 80
      },
      app: {
        path: "/opt/spaceapp",
        deviceId: "100",
        sizeBytes: 200 * 1024 * 1024 * 1024,
        availableBytes: 40 * 1024 * 1024 * 1024,
        usedPercent: 80
      },
      dedicatedAppVolume: false,
      minimumRecommendedFreeBytes: 20 * 1024 * 1024 * 1024,
      checkedAt: "2026-06-26T00:00:01.000Z"
    });
    const { app, cookie } = await authedApp({
      storageReadinessChecker: async () => storageReadiness
    });

    const unauthenticated = await app.inject({ method: "GET", url: "/api/admin/storage" });
    expect(unauthenticated.statusCode).toBe(401);

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/storage",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(storageReadinessSchema.parse(response.json())).toMatchObject({
      status: "BLOCKED",
      dedicatedAppVolume: false,
      app: { path: "/opt/spaceapp" }
    });
    expect(JSON.stringify(response.json())).not.toContain("space_session");
  });

  it("clears the admin storage warning when storage readiness is verified", async () => {
    const storageReadiness = storageReadinessSchema.parse({
      id: "space-storage",
      status: "VERIFIED",
      statusReason: "Storage readiness meets the current Space launch thresholds.",
      root: {
        path: "/",
        deviceId: "100",
        sizeBytes: 200 * 1024 * 1024 * 1024,
        availableBytes: 40 * 1024 * 1024 * 1024,
        usedPercent: 80
      },
      app: {
        path: "/opt/spaceapp",
        deviceId: "200",
        sizeBytes: 200 * 1024 * 1024 * 1024,
        availableBytes: 185 * 1024 * 1024 * 1024,
        usedPercent: 7.5
      },
      dedicatedAppVolume: true,
      minimumRecommendedFreeBytes: 20 * 1024 * 1024 * 1024,
      checkedAt: "2026-06-26T00:00:01.000Z"
    });
    const { app, cookie } = await authedApp({
      storageReadinessChecker: async () => storageReadiness
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin",
      headers: { cookie }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      storageWarning: ""
    });
  });

  it("reports protected launch readiness with hard storage blockers and missing evidence", async () => {
    const storageReadiness = storageReadinessSchema.parse({
      id: "space-storage",
      status: "BLOCKED",
      statusReason: "Dedicated /opt/spaceapp volume is not detected.",
      root: {
        path: "/",
        deviceId: "100",
        sizeBytes: 200 * 1024 * 1024 * 1024,
        availableBytes: 40 * 1024 * 1024 * 1024,
        usedPercent: 80
      },
      app: {
        path: "/opt/spaceapp",
        deviceId: "100",
        sizeBytes: 200 * 1024 * 1024 * 1024,
        availableBytes: 40 * 1024 * 1024 * 1024,
        usedPercent: 80
      },
      dedicatedAppVolume: false,
      minimumRecommendedFreeBytes: 20 * 1024 * 1024 * 1024,
      checkedAt: "2026-06-27T00:00:01.000Z"
    });
    const workerReadiness = workerReadinessSchema.parse({
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
      workflowBacklogCount: 0,
      activityBacklogCount: 0,
      pollerIdentities: ["space-worker@test"],
      lastPollerAccessAt: "2026-06-27T00:00:00.000Z",
      checkedAt: "2026-06-27T00:00:01.000Z"
    });
    const { app, cookie } = await authedApp({
      store: new InMemorySpaceStore(),
      config: postgresBackedConfig({ SPACE_ENABLE_CODEX_TURNS: "true" }),
      storageReadinessChecker: async () => storageReadiness,
      workerReadinessChecker: async () => workerReadiness
    });

    const unauthenticated = await app.inject({ method: "GET", url: "/api/admin/launch-readiness" });
    expect(unauthenticated.statusCode).toBe(401);

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/launch-readiness",
      headers: { cookie }
    });

    expect(response.statusCode).toBe(200);
    const report = launchReadinessSchema.parse(response.json());
    expect(report.status).toBe("BLOCKED");
    expect(report.hardBlockerCount).toBe(2);
    expect(report.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "storage", status: "FAIL", severity: "hard" }),
        expect.objectContaining({ id: "auth_config", status: "FAIL", severity: "hard" }),
        expect.objectContaining({ id: "codex_turn", status: "MISSING", severity: "gate" }),
        expect.objectContaining({ id: "mcp_execution", status: "MISSING", severity: "gate" })
      ])
    );
    expect(JSON.stringify(report)).not.toContain("space_session");
  });

  it("blocks launch readiness while development login is enabled", async () => {
    const storageReadiness = storageReadinessSchema.parse({
      id: "space-storage",
      status: "VERIFIED",
      statusReason: "Storage readiness meets the current Space launch thresholds.",
      root: {
        path: "/",
        deviceId: "100",
        sizeBytes: 260 * 1024 * 1024 * 1024,
        availableBytes: 200 * 1024 * 1024 * 1024,
        usedPercent: 23
      },
      app: {
        path: "/opt/spaceapp",
        deviceId: "200",
        sizeBytes: 260 * 1024 * 1024 * 1024,
        availableBytes: 200 * 1024 * 1024 * 1024,
        usedPercent: 23
      },
      dedicatedAppVolume: true,
      minimumRecommendedFreeBytes: 20 * 1024 * 1024 * 1024,
      checkedAt: "2026-07-05T00:00:01.000Z"
    });
    const workerReadiness = workerReadinessSchema.parse({
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
      workflowBacklogCount: 0,
      activityBacklogCount: 0,
      pollerIdentities: ["space-worker@test"],
      lastPollerAccessAt: "2026-07-05T00:00:00.000Z",
      checkedAt: "2026-07-05T00:00:01.000Z"
    });
    const { app, cookie } = await authedApp({
      store: new InMemorySpaceStore(),
      config: postgresBackedConfig({ SPACE_ENABLE_CODEX_TURNS: "true" }),
      storageReadinessChecker: async () => storageReadiness,
      workerReadinessChecker: async () => workerReadiness
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/launch-readiness",
      headers: { cookie }
    });

    expect(response.statusCode).toBe(200);
    const report = launchReadinessSchema.parse(response.json());
    expect(report.status).toBe("BLOCKED");
    expect(report.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "auth_config",
          status: "FAIL",
          severity: "hard",
          message: expect.stringContaining("Development login is enabled")
        })
      ])
    );
    expect(JSON.stringify(report)).not.toContain("space-dev");
  });

  it("keeps launch readiness blocked by storage even when golden workflow evidence exists", async () => {
    const store = new InMemorySpaceStore({
      codexLbConfigured: true,
      codexLbBaseUrl: "http://127.0.0.1:2458/v1"
    });
    store.getMemoryVectorReadiness = () => ({
      id: "memory-vector-readiness",
      status: "VERIFIED",
      code: "MEMORY_VECTOR_READY",
      message: "pgvector extension, memory embedding column and HNSW vector index are ready.",
      runtimeStore: "postgres",
      extensionInstalled: true,
      extensionVersion: "0.8.3",
      embeddingColumnReady: true,
      embeddingDimensions: 1536,
      expectedDimensions: 1536,
      vectorIndexReady: true,
      checkedAt: "2026-06-27T00:00:00.000Z"
    });
    const room = store.createRoom({ name: "Golden Evidence", initialPaneCount: 0 }, "req:golden-room");
    const pane = store.createPane({ roomId: room.id, title: "Planner", mode: "CHAT" }, "req:golden-pane");
    const queued = store.recordTurnQueued({
      roomId: room.id,
      paneId: pane.id,
      workflowId: `workflow:codex-app-server:${room.id}:${pane.id}:req:golden-turn`,
      runId: "run:golden-turn",
      taskQueue: "space-agent-turns",
      traceId: "req:golden-turn",
      prompt: "Reply OK.",
      runtime: "CODEX_APP_SERVER",
      providerId: "codex-lb",
      modelId: "gpt-5.4-mini"
    });
    store.recordTurnCompleted({
      workflowId: queued.workflow.workflowId,
      traceId: "req:golden-turn",
      message: "Codex App Server turn completed.",
      metadata: {
        codexAppServer: {
          threadId: "thread:golden",
          turnId: "turn:golden",
          turnStatus: "completed"
        }
      }
    });
    store.recordProviderValidation({
      providerId: "codex-lb",
      status: "VERIFIED",
      code: "VERIFIED",
      statusReason: "Credential smoke passed.",
      checkedAt: "2026-06-27T00:00:00.000Z",
      maskedKeyPrefix: "sk-c...207",
      credentialLabel: "space-test",
      modelCount: 1
    });
    store.replaceProviderModels("codex-lb", [
      {
        id: "gpt-5.4-mini",
        providerId: "codex-lb",
        displayName: "gpt-5.4-mini",
        status: "VERIFIED",
        contextWindow: 128000,
        supportsTools: true,
        supportsVision: false,
        supportsRealtime: false,
        supportsReasoning: true,
        defaultReasoningEffort: "medium"
      }
    ]);
    store.recordMcpDiscoveryCatalog({
      discoveredAt: "2026-06-27T00:00:00.000Z",
      servers: [
        {
          id: "test-stdio",
          displayName: "Test stdio",
          transport: "stdio",
          status: "VERIFIED",
          statusReason: "Discovery metadata captured.",
          schemaVersion: "2025-11-25",
          configHash: `sha256:${"a".repeat(64)}`,
          toolCount: 1,
          lastDiscoveredAt: "2026-06-27T00:00:00.000Z"
        }
      ],
      tools: [
        {
          id: "test-stdio:list_files",
          serverId: "test-stdio",
          name: "list_files",
          riskLevel: "R2",
          schemaHash: fixtureToolSchemaHash,
          approvalRequired: true,
          status: "VERIFIED",
          statusReason: "Schema metadata captured."
        }
      ]
    });
    store.recordMcpDiscoverySmoke({
      id: "mcp-gateway",
      actorUserId: "user:test-1",
      traceId: "req:mcp-smoke",
      status: "VERIFIED",
      code: "DISCOVERY_OK",
      message: "MCP discovery smoke completed.",
      targetSpecVersion: "2025-11-25",
      discoveryEnabled: true,
      serverCount: 1,
      toolCount: 1,
      startedAt: "2026-06-27T00:00:00.000Z",
      finishedAt: "2026-06-27T00:00:00.001Z",
      durationMs: 1
    });
    const mcpArtifact = store.createArtifact(
      {
        roomId: room.id,
        kind: "MCP_RESULT",
        mimeType: "application/json",
        storageUri: "space-artifact://mcp-executions/golden/result.json",
        sha256: "a".repeat(64),
        byteSize: 256,
        metadata: { mcpExecutionId: "mcp_exec:golden" }
      },
      "req:mcp-artifact"
    ).artifact;
    store.recordAuditEvent({
      actorUserId: "user:test-1",
      traceId: "req:mcp-execute",
      action: "mcp.tool.execute",
      targetType: "mcp_tool",
      targetId: "test-stdio:list_files",
      metadata: {
        status: "EXECUTED",
        code: "TOOL_EXECUTION_OK",
        artifactId: mcpArtifact.id
      }
    });
    store.createMemoryEntry(
      {
        scope: "ROOM",
        roomId: room.id,
        title: "Storage blocker",
        body: "Dedicated storage remains required.",
        provenance: "golden-test"
      },
      "req:memory"
    );
    store.recordMemoryEmbeddingSmoke({
      id: "memory-embedding-smoke",
      actorUserId: "user:test-1",
      traceId: "req:embedding",
      status: "VERIFIED",
      code: "EMBEDDING_SMOKE_OK",
      message: "OpenAI embedding provider smoke completed and pgvector storage is ready.",
      smokeEnabled: true,
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      pgvectorReady: true,
      embeddingProviderReady: true,
      startedAt: "2026-06-27T00:00:00.000Z",
      finishedAt: "2026-06-27T00:00:00.001Z",
      durationMs: 1
    });
    for (const [index, kind] of ["SCREENSHOT", "DOM_SNAPSHOT", "CONSOLE_LOG", "NETWORK_LOG"].entries()) {
      store.createArtifact(
        {
          roomId: room.id,
          kind: kind as "SCREENSHOT" | "DOM_SNAPSHOT" | "CONSOLE_LOG" | "NETWORK_LOG",
          mimeType: kind === "SCREENSHOT" ? "image/png" : "application/json",
          storageUri: `space-artifact://browser-evidence/browser_capture:golden/${kind.toLowerCase()}.json`,
          sha256: String(index + 1).repeat(64).slice(0, 64),
          byteSize: 512,
          metadata: { browserCaptureId: "browser_capture:golden" }
        },
        `req:browser-${index}`
      );
    }
    const planner = store.createSwarmTask({
      roomId: room.id,
      role: "PLANNER",
      title: "Plan",
      goal: "Plan the work.",
      assignee: "planner",
      dependsOnTaskIds: []
    }).task;
    const worker = store.createSwarmTask({
      roomId: room.id,
      role: "WORKER",
      title: "Build",
      goal: "Build the work.",
      assignee: "worker",
      dependsOnTaskIds: [planner.id]
    }).task;
    const reviewer = store.createSwarmTask({
      roomId: room.id,
      role: "REVIEWER",
      title: "Review",
      goal: "Review the work.",
      assignee: "reviewer",
      dependsOnTaskIds: [worker.id]
    }).task;
    store.createSwarmReconcile({
      roomId: room.id,
      taskIds: [planner.id, worker.id, reviewer.id],
      decision: "MERGED",
      summary: "Roles reconciled.",
      nextSteps: "Proceed to review gate."
    });
    const decision = store.createReviewDecision({
      roomId: room.id,
      decision: "SHIP",
      summary: "Checks passed.",
      evidenceArtifactIds: [mcpArtifact.id],
      rollbackNote: "Revert latest commit if needed."
    }).decision;
    store.createReviewCheck({
      roomId: room.id,
      reviewDecisionId: decision.id,
      name: "npm test",
      status: "PASS",
      command: "npm test",
      summary: "Passed.",
      artifactIds: [],
      metadata: {}
    });
    store.createReviewDiffSummary({
      roomId: room.id,
      reviewDecisionId: decision.id,
      title: "Launch readiness",
      filePath: "apps/api/src/app.ts",
      status: "MODIFIED",
      additions: 1,
      deletions: 0,
      summary: "Readiness report added."
    });
    const storageReadiness = storageReadinessSchema.parse({
      id: "space-storage",
      status: "BLOCKED",
      statusReason: "Dedicated /opt/spaceapp volume is not detected.",
      root: {
        path: "/",
        deviceId: "100",
        sizeBytes: 200 * 1024 * 1024 * 1024,
        availableBytes: 40 * 1024 * 1024 * 1024,
        usedPercent: 80
      },
      app: {
        path: "/opt/spaceapp",
        deviceId: "100",
        sizeBytes: 200 * 1024 * 1024 * 1024,
        availableBytes: 40 * 1024 * 1024 * 1024,
        usedPercent: 80
      },
      dedicatedAppVolume: false,
      minimumRecommendedFreeBytes: 20 * 1024 * 1024 * 1024,
      checkedAt: "2026-06-27T00:00:01.000Z"
    });
    const workerReadiness = workerReadinessSchema.parse({
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
      workflowBacklogCount: 0,
      activityBacklogCount: 0,
      pollerIdentities: ["space-worker@test"],
      lastPollerAccessAt: "2026-06-27T00:00:00.000Z",
      checkedAt: "2026-06-27T00:00:01.000Z"
    });
    const sessionSecret = "test-secret-with-enough-length";
    const app = await createApp({
      store,
      auth: {
        sessionSecret,
        devLogin: false,
        secureCookies: false,
        operatorEmail: "operator@space.test",
        operatorPasswordHash: "configured-test-hash"
      },
      config: postgresBackedConfig({ SPACE_ENABLE_CODEX_TURNS: "true" }),
      storageReadinessChecker: async () => storageReadiness,
      workerReadinessChecker: async () => workerReadiness
    });
    const cookie = `space_session=${signSession({ id: "user:operator", email: "operator@space.test", role: "ADMIN" }, sessionSecret)}`;

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/launch-readiness",
      headers: { cookie }
    });

    expect(response.statusCode).toBe(200);
    const report = launchReadinessSchema.parse(response.json());
    expect(report.status).toBe("BLOCKED");
    expect(report.completionPct).toBeGreaterThanOrEqual(90);
    expect(report.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "storage", status: "FAIL", severity: "hard" }),
        expect.objectContaining({ id: "auth_config", status: "PASS", severity: "none" }),
        expect.objectContaining({ id: "codex_turn", status: "PASS", severity: "none" }),
        expect.objectContaining({ id: "mcp_execution", status: "PASS", severity: "none" }),
        expect.objectContaining({ id: "browser_evidence", status: "PASS", severity: "none" }),
        expect.objectContaining({ id: "semantic_memory", status: "PASS", severity: "none" }),
        expect.objectContaining({ id: "review", status: "PASS", severity: "none" })
      ])
    );
    expect(report.summary).toContain("hard infrastructure");
  });

  it("exposes global provider settings and custom provider CRUD", async () => {
    const store = new InMemorySpaceStore();
    const { app, cookie, csrfToken } = await authedApp({ store });

    const settings = await app.inject({
      method: "GET",
      url: "/api/provider-settings",
      headers: { cookie }
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({ defaultProviderId: "codex-lb" });

    const created = await app.inject({
      method: "POST",
      url: "/api/providers",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        id: "custom-route",
        displayName: "Custom Route",
        type: "CUSTOM",
        baseUrl: "https://custom.example/v1",
        routeProfile: "custom",
        backingProviderId: "openai",
        credentialRef: "/run/secrets/custom-route"
      }
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      id: "custom-route",
      status: "DISABLED",
      routeProfile: "custom",
      credentialRef: "/run/secrets/custom-route"
    });
    expect(JSON.stringify(created.json())).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);

    const patchedSettings = await app.inject({
      method: "PATCH",
      url: "/api/provider-settings",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { defaultProviderId: "custom-route" }
    });
    expect(patchedSettings.statusCode).toBe(200);
    expect(patchedSettings.json()).toMatchObject({ defaultProviderId: "custom-route" });

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/providers/custom-route",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { displayName: "Custom Route 2", baseUrl: "https://custom-2.example/v1" }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      displayName: "Custom Route 2",
      baseUrl: "https://custom-2.example/v1",
      status: "DISABLED"
    });
  });

  it("exposes fail-closed voice transcription settings", async () => {
    const { app, cookie } = await authedApp();

    const settings = await app.inject({
      method: "GET",
      url: "/api/voice/transcription/settings",
      headers: { cookie }
    });

    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({
      enabled: false,
      defaultModel: "gemini-3.8-live",
      defaultLanguage: "auto",
      modelOptions: [
        "gemini-3.8-live",
        "gemini-3.8-live-extended-thinking",
        "gemini-3.1-flash-live-preview",
        "gemini-2.5-flash-native-audio-latest",
        "gemini-2.5-flash",
        "gemini-2.0-flash-exp",
        "gpt-live-1",
        "gpt-transcribe",
        "gpt-live-transcribe",
        "gpt-4o-transcribe",
        "gpt-4o-mini-transcribe",
        "whisper-1",
        "gpt-realtime-whisper",
        "local-qwen3-greek"
      ],
      languageOptions: ["auto", "el", "en"],
      defaultDelay: "minimal",
      delayOptions: ["minimal", "low", "medium", "high", "xhigh"]
    });
    expect(settings.json().statusReason).toContain("SPACE_VOICE_TRANSCRIPTION_ENABLED");
  });

  it("creates an OpenAI Realtime voice call from an SDP offer", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "space-voice-realtime-api-"));
    const keyFile = join(tempDir, "voice.key");
    const offerSdp = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=Space Voice\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
    const answerSdp = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=OpenAI\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
    await writeFile(keyFile, "sk-test-voice");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(_input)).toMatch(/\/realtime\/calls$/);
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init!.body as FormData;
      expect(form.get("sdp")).toBe(offerSdp);
      expect(JSON.parse(String(form.get("session")))).toMatchObject({
        type: "transcription",
        audio: { input: { transcription: { model: "gpt-transcribe", languages: ["el"] } } }
      });
      expect(new Headers(init?.headers).get("OpenAI-Safety-Identifier")).toMatch(/^[a-f0-9]{64}$/);
      return new Response(JSON.stringify({
        session: { id: "live_test_123" },
        transport: { type: "webrtc", sdp: answerSdp }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { app, cookie, csrfToken } = await authedApp({
        config: getApiConfig({
          SPACE_VOICE_TRANSCRIPTION_ENABLED: "true",
          SPACE_VOICE_TRANSCRIPTION_KEY_FILE: keyFile
        })
      });

      const result = await app.inject({
        method: "POST",
        url: "/api/voice/realtime/calls",
        headers: {
          cookie,
          [csrfHeaderName]: csrfToken
        },
        payload: {
          offerSdp,
          model: "gpt-transcribe",
          language: "el",
          delay: "minimal"
        }
      });

      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({ answerSdp, provider: "openai", model: "gpt-transcribe", protocol: "openai-transcription" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("changes the default provider without running the retired Codex-LB route command", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "space-provider-route-api-"));
    const routeLog = join(tempDir, "route.log");
    const routeCommand = join(tempDir, "route-command.sh");
    await writeFile(routeCommand, `#!/usr/bin/env bash\nprintf '%s\\n' "$1" >> ${JSON.stringify(routeLog)}\n`);
    await chmod(routeCommand, 0o755);
    const store = new InMemorySpaceStore();
    store.createProvider({
      id: "direct-246-primary",
      displayName: "Direct .246 Primary",
      type: "CODEX_LB",
      routeProfile: "direct-primary",
      backingProviderId: "codex-lb"
    });
    store.recordProviderValidation({
      providerId: "direct-246-primary",
      status: "VERIFIED",
      code: "VERIFIED",
      statusReason: "Codex-LB credential passed /models auth smoke.",
      checkedAt: "2026-07-06T00:00:00.000Z",
      maskedKeyPrefix: "spac...test",
      credentialLabel: "space-test",
      modelCount: 1
    });
    const { app, cookie, csrfToken } = await authedApp({
      store,
      config: getApiConfig({ SPACE_CODEX_ROUTE_SWITCH_ENABLED: "true", SPACE_CODEX_ROUTE_COMMAND: routeCommand })
    });

    try {
      const patchedSettings = await app.inject({
        method: "PATCH",
        url: "/api/provider-settings",
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { defaultProviderId: "direct-246-primary" }
      });

      expect(patchedSettings.statusCode).toBe(200);
      expect(patchedSettings.json()).toMatchObject({ defaultProviderId: "direct-246-primary" });
      // codex-lb is retired: Codex runs through Space Gateway and no route command runs.
      await expect(readFile(routeLog, "utf8")).rejects.toThrow();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not report ready when Temporal is reachable but no worker pollers are visible", async () => {
    const { app } = await authedApp({
      workerReadinessChecker: async () =>
        workerReadinessSchema.parse({
          id: "space-worker",
          status: "NO_POLLERS",
          statusReason: "Temporal is reachable, but no pollers are visible.",
          address: "127.0.0.1:7233",
          namespace: "default",
          taskQueue: "space-agent-turns",
          reachable: true,
          workflowPollerCount: 0,
          activityPollerCount: 0,
          pollerCount: 0,
          workflowBacklogCount: 0,
          activityBacklogCount: 0,
          pollerIdentities: [],
          lastPollerAccessAt: null,
          checkedAt: "2026-06-26T00:00:01.000Z"
        })
    });

    const readyz = await app.inject({ method: "GET", url: "/readyz" });
    expect(readyz.statusCode).toBe(200);
    expect(readyz.json()).toMatchObject({
      ok: false,
      dependencies: { worker: "NO_POLLERS" }
    });
  });

  it("fails readyz closed when the Browser Host capacity contract is not met", async () => {
    // The commit is only echoed back; a fixed one keeps the test runnable outside a git checkout.
    const buildCommit = "0123456789abcdef0123456789abcdef01234567";
    const captureMetrics = {
      jobs: { QUEUED: 1, RUNNING: 1, COMPLETED: 2, FAILED: 1, CANCELLED: 1 },
      segments: { OPEN: 1, FINALIZED: 3, FAILED: 1, DISCARDED: 1 }
    };
    const health = {
      hostPid: 123,
      startedAt: "2026-07-12T00:00:00.000Z",
      buildCommit,
      status: { enabled: true, statusReason: "ready", defaultUrl: "https://example.com/", checkedAt: "2026-07-12T00:00:00.000Z" },
      capacity: { activeSessions: 2, maxSessions: 8, activeLiveWorkloads: 1, maxLiveWorkloads: 3 },
      captureMetrics
    } satisfies BrowserHostHealth;
    const browserSessionManager = Object.assign(fakeBrowserSessionManager(), {
      browserHostHealth: async () => health
    });
    const workerReadiness = workerReadinessSchema.parse({
      id: "space-worker",
      status: "RUNNING",
      statusReason: "Temporal is reachable and pollers are visible.",
      address: "127.0.0.1:7233",
      namespace: "default",
      taskQueue: "space-agent-turns",
      reachable: true,
      workflowPollerCount: 1,
      activityPollerCount: 1,
      pollerCount: 2,
      workflowBacklogCount: 0,
      activityBacklogCount: 0,
      pollerIdentities: ["space-worker@test"],
      lastPollerAccessAt: "2026-07-12T00:00:00.000Z",
      checkedAt: "2026-07-12T00:00:01.000Z"
    });
    const diagnosticsRoot = await mkdtemp(join(tmpdir(), "space-app-diagnostics-"));
    const app = await createApp({
      appDiagnosticsService: new AppDiagnosticsService({
        repository: new InMemoryAppDiagnosticsRepository(),
        root: diagnosticsRoot,
        cleanupRootOnDispose: true
      }),
      browserSessionManager,
      workerReadinessChecker: async () => workerReadiness,
      config: getApiConfig({
        SPACE_BROWSER_HOST_TRANSPORT: "unix",
        SPACE_BROWSER_SESSIONS_ENABLED: "true",
        SPACE_RUNTIME_STORE: "memory"
      }),
      auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false }
    });

    const readyz = await app.inject({ method: "GET", url: "/readyz" });
    expect(readyz.statusCode).toBe(200);
    expect(readyz.json()).toMatchObject({
      ok: false,
      dependencies: {
        browserHost: "CAPACITY_MISMATCH",
        browserHostBuildCommit: buildCommit,
        browserHostCaptureMetrics: captureMetrics
      }
    });
    await app.close();
  });

  it("reports readyz ok when browser sessions are disabled for the light profile", async () => {
    const workerReadiness = workerReadinessSchema.parse({
      id: "space-worker",
      status: "RUNNING",
      statusReason: "Temporal is reachable and pollers are visible.",
      address: "127.0.0.1:7233",
      namespace: "default",
      taskQueue: "space-agent-turns",
      reachable: true,
      workflowPollerCount: 1,
      activityPollerCount: 1,
      pollerCount: 2,
      workflowBacklogCount: 0,
      activityBacklogCount: 0,
      pollerIdentities: ["space-worker@test"],
      lastPollerAccessAt: "2026-07-12T00:00:00.000Z",
      checkedAt: "2026-07-12T00:00:01.000Z"
    });
    const diagnosticsRoot = await mkdtemp(join(tmpdir(), "space-app-diagnostics-light-"));
    const app = await createApp({
      appDiagnosticsService: new AppDiagnosticsService({
        repository: new InMemoryAppDiagnosticsRepository(),
        root: diagnosticsRoot,
        cleanupRootOnDispose: true
      }),
      browserSessionManager: fakeBrowserSessionManager(),
      workerReadinessChecker: async () => workerReadiness,
      config: getApiConfig({
        SPACE_BROWSER_HOST_TRANSPORT: "unix",
        SPACE_RUNTIME_STORE: "memory"
      }),
      auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false }
    });

    const readyz = await app.inject({ method: "GET", url: "/readyz" });
    expect(readyz.statusCode).toBe(200);
    expect(readyz.json()).toMatchObject({
      ok: true,
      dependencies: { browserHost: "DISABLED" }
    });
    await app.close();
  });

  it("protects API resources with a structured error", async () => {
    const app = await createApp({
      auth: {
        sessionSecret: "test-secret-with-enough-length",
        devLogin: true,
        secureCookies: false
      }
    });

    const response = await app.inject({ method: "GET", url: "/api/rooms" });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHENTICATED");
    expect(response.json().error.requestId).toMatch(/^req:/);
  });

  it("creates rooms and panes through typed endpoints", async () => {
    const { app, cookie, csrfToken } = await authedApp();

    const roomResponse = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { name: "Launch", initialPaneCount: 2 }
    });

    expect(roomResponse.statusCode).toBe(200);
    const room = roomResponse.json();
    const paneResponse = await app.inject({
      method: "GET",
      url: `/api/panes?roomId=${encodeURIComponent(room.id)}`,
      headers: { cookie }
    });

    expect(paneResponse.statusCode).toBe(200);
    expect(paneResponse.json().data).toHaveLength(2);
  });

  it("opens an empty room when agent panes are off and no initialPaneCount is sent (pilot F7)", async () => {
    const { app, cookie, csrfToken } = await authedApp();
    const room = (await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { name: "Public install" }
    })).json();
    const panes = await app.inject({ method: "GET", url: `/api/panes?roomId=${encodeURIComponent(room.id)}`, headers: { cookie } });
    expect(panes.json().data).toHaveLength(0);
  });

  it("enforces maximum 6 rooms limit and sequential room naming", async () => {
    const { app, cookie, csrfToken } = await authedApp();

    const initialList = await app.inject({
      method: "GET",
      url: "/api/rooms",
      headers: { cookie }
    });
    const currentRooms = initialList.json().data;
    const currentCount = currentRooms.length;

    const createdRooms: any[] = [];
    for (let i = currentCount; i < 6; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/rooms",
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { initialPaneCount: 0 }
      });
      expect(res.statusCode).toBe(200);
      createdRooms.push(res.json());
    }

    expect(createdRooms[0].name).toBe("Alex");
    if (createdRooms.length > 1) {
      expect(createdRooms[1].name).toBe("Bruno");
    }

    const rejected = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { initialPaneCount: 0 }
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error.code).toBe("CONFLICT");
    expect(rejected.json().error.message).toContain("Maximum room limit of 6 rooms reached");

    const toDelete = createdRooms[0];
    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/rooms/${toDelete.id}`,
      headers: { cookie, [csrfHeaderName]: csrfToken }
    });
    expect(delRes.statusCode).toBe(200);

    const reCreated = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { initialPaneCount: 0 }
    });
    expect(reCreated.statusCode).toBe(200);
    expect(reCreated.json().name).toBe("Alex");
  });


  it("leaves test rooms out of the room limit and takes the limit from the user's settings (operator 2026-10-21)", async () => {
    const store = new InMemorySpaceStore();
    const { app, cookie, csrfToken } = await authedApp({ store });
    const headers = { cookie, [csrfHeaderName]: csrfToken };
    const create = () => app.inject({ method: "POST", url: "/api/rooms", headers, payload: { initialPaneCount: 0 } });
    const me = (await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).json();
    for (let index = 0; index < 3; index++) {
      await store.createRoom({ name: `Proof ${index}`, initialPaneCount: 0, kind: "AGENT_PROOF" }, undefined, me.user.id);
    }
    const rooms = (await app.inject({ method: "GET", url: "/api/rooms", headers: { cookie } })).json().data as { kind: string }[];
    for (let index = rooms.filter((room) => room.kind === "WORKSPACE").length; index < 6; index++) {
      expect((await create()).statusCode).toBe(200);
    }
    expect((await create()).json().error.message).toContain("Maximum room limit of 6 rooms reached");
    expect((await app.inject({ method: "PATCH", url: "/api/user-settings", headers, payload: { roomLimit: 7 } })).statusCode).toBe(200);
    expect((await create()).statusCode).toBe(200);
    expect((await create()).json().error.message).toContain("Maximum room limit of 7 rooms reached");
    expect((await app.inject({ method: "PATCH", url: "/api/user-settings", headers, payload: { roomLimit: 17 } })).statusCode).toBe(422);
  });

  it("persists minimized pane state through PATCH and validates the layout invariant", async () => {
    const { app, cookie, csrfToken } = await authedApp();
    const roomResponse = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { name: "Pane layout", initialPaneCount: 1 }
    });
    const room = roomResponse.json();
    const paneResponse = await app.inject({
      method: "GET",
      url: `/api/panes?roomId=${encodeURIComponent(room.id)}`,
      headers: { cookie }
    });
    const pane = paneResponse.json().data[0];

    const minimized = await app.inject({
      method: "PATCH",
      url: `/api/panes/${encodeURIComponent(pane.id)}`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { isMinimized: true }
    });
    expect(minimized.statusCode).toBe(200);
    expect(minimized.json()).toMatchObject({ isMinimized: true, isMaximized: false });

    const rejected = await app.inject({
      method: "PATCH",
      url: `/api/panes/${encodeURIComponent(pane.id)}`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { isMinimized: true, isMaximized: true }
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("applies idempotent room pane layout presets atomically and audits bounded metadata", async () => {
    const { app, cookie, csrfToken } = await authedApp();
    const roomResponse = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { name: "Preset room", initialPaneCount: 3 }
    });
    const room = roomResponse.json();
    const panesResponse = await app.inject({
      method: "GET",
      url: `/api/panes?roomId=${encodeURIComponent(room.id)}`,
      headers: { cookie }
    });
    const originalPanes = panesResponse.json().data as Pane[];
    await app.inject({
      method: "PATCH",
      url: `/api/panes/${encodeURIComponent(originalPanes[0]!.id)}`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { columnSpan: 3, isMaximized: true }
    });
    await app.inject({
      method: "PATCH",
      url: `/api/panes/${encodeURIComponent(originalPanes[1]!.id)}`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { columnSpan: 2, isMinimized: true }
    });

    const applyPreset = () =>
      app.inject({
        method: "PUT",
        url: `/api/rooms/${encodeURIComponent(room.id)}/pane-layout`,
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { paneLayoutColumns: 3 }
      });
    const applied = await applyPreset();

    expect(applied.statusCode).toBe(200);
    expect(applied.json().room).toMatchObject({ id: room.id, paneLayoutColumns: 3 });
    expect(applied.json().panes.map((pane: Pane) => [pane.id, pane.order])).toEqual(
      originalPanes.map((pane) => [pane.id, pane.order])
    );
    expect(applied.json().panes).toEqual([
      expect.objectContaining({ id: originalPanes[0]!.id, columnSpan: 1, isMaximized: false, isMinimized: false }),
      expect.objectContaining({ id: originalPanes[1]!.id, columnSpan: 1, isMaximized: false, isMinimized: true }),
      expect.objectContaining({ id: originalPanes[2]!.id, columnSpan: 1, isMaximized: false, isMinimized: false })
    ]);
    expect((await applyPreset()).statusCode).toBe(200);

    const heightUpdate = await app.inject({
      method: "PUT",
      url: `/api/rooms/${encodeURIComponent(room.id)}/pane-layout`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { paneLayoutHeight: 3 }
    });
    expect(heightUpdate.statusCode).toBe(200);
    expect(heightUpdate.json().room.paneLayoutHeight).toBe(3);
    expect(heightUpdate.json().panes).toEqual([
      expect.objectContaining({ id: originalPanes[0]!.id, columnSpan: 1, isMaximized: false }),
      expect.objectContaining({ id: originalPanes[1]!.id, columnSpan: 1, isMaximized: false }),
      expect.objectContaining({ id: originalPanes[2]!.id, columnSpan: 1, isMaximized: false })
    ]);

    for (const paneLayoutColumns of ["2", 5, 6, 7]) {
      const rejected = await app.inject({
        method: "PUT",
        url: `/api/rooms/${encodeURIComponent(room.id)}/pane-layout`,
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { paneLayoutColumns }
      });
      expect(rejected.statusCode).toBe(422);
      expect(rejected.json().error.code).toBe("VALIDATION_ERROR");
    }

    for (const paneLayoutHeight of [0, 5, -1, "2"]) {
      const rejected = await app.inject({
        method: "PUT",
        url: `/api/rooms/${encodeURIComponent(room.id)}/pane-layout`,
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { paneLayoutHeight }
      });
      expect(rejected.statusCode).toBe(422);
      expect(rejected.json().error.code).toBe("VALIDATION_ERROR");
    }

    const automatic = await app.inject({
      method: "PUT",
      url: `/api/rooms/${encodeURIComponent(room.id)}/pane-layout`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { paneLayoutColumns: null }
    });
    expect(automatic.statusCode).toBe(200);
    expect(automatic.json().room.paneLayoutColumns).toBeNull();

    const auditResponse = await app.inject({ method: "GET", url: "/api/admin/audit?pageSize=20", headers: { cookie } });
    expect(auditResponse.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "room.pane-layout.update",
          targetId: room.id,
          metadata: { paneLayoutColumns: null, paneCount: 3 }
        })
      ])
    );
  });

  it("moves inactive panes to another room through the typed endpoint", async () => {
    const { app, cookie, csrfToken } = await authedApp();
    const sourceRoomResponse = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { name: "Source", initialPaneCount: 1 }
    });
    const targetRoomResponse = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { name: "Target", initialPaneCount: 0 }
    });
    const sourceRoom = sourceRoomResponse.json();
    const targetRoom = targetRoomResponse.json();
    const sourcePanesResponse = await app.inject({
      method: "GET",
      url: `/api/panes?roomId=${encodeURIComponent(sourceRoom.id)}`,
      headers: { cookie }
    });
    const sourcePane = sourcePanesResponse.json().data[0];

    const moveResponse = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(sourcePane.id)}/move`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { targetRoomId: targetRoom.id }
    });

    expect(moveResponse.statusCode).toBe(200);
    expect(moveResponse.json()).toMatchObject({
      sourceRoomId: sourceRoom.id,
      targetRoomId: targetRoom.id,
      sourcePane: { id: sourcePane.id, roomId: sourceRoom.id, isClosed: false, status: "IDLE" },
      targetPane: { id: sourcePane.id, roomId: targetRoom.id, title: sourcePane.title, status: "IDLE", isClosed: false }
    });

    const sourceAfterResponse = await app.inject({
      method: "GET",
      url: `/api/panes?roomId=${encodeURIComponent(sourceRoom.id)}`,
      headers: { cookie }
    });
    const targetAfterResponse = await app.inject({
      method: "GET",
      url: `/api/panes?roomId=${encodeURIComponent(targetRoom.id)}`,
      headers: { cookie }
    });
    expect(sourceAfterResponse.json().data).toEqual([]);
    expect(targetAfterResponse.json().data).toEqual([expect.objectContaining({ title: sourcePane.title })]);

    const auditResponse = await app.inject({
      method: "GET",
      url: "/api/admin/audit?pageSize=20",
      headers: { cookie }
    });
    expect(auditResponse.json().data.map((event: { action: string }) => event.action)).toContain("pane.move");
  });

  it("deletes rooms through the typed endpoint", async () => {
    const { app, cookie, csrfToken } = await authedApp();

    const roomResponse = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { name: "Disposable Room", initialPaneCount: 2 }
    });
    const room = roomResponse.json();

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/rooms/${encodeURIComponent(room.id)}`,
      headers: { cookie, [csrfHeaderName]: csrfToken }
    });

    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toMatchObject({ ok: true, roomId: room.id });

    const roomsResponse = await app.inject({ method: "GET", url: "/api/rooms", headers: { cookie } });
    expect(roomsResponse.json().data).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: room.id })]));

    const panesResponse = await app.inject({
      method: "GET",
      url: `/api/panes?roomId=${encodeURIComponent(room.id)}`,
      headers: { cookie }
    });
    expect(panesResponse.statusCode).toBe(404);
  });

  it("stops managed browsers before room deletion removes their session identities", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Browser teardown", initialPaneCount: 0 });
    const other = store.createRoom({ name: "Keep browser", initialPaneCount: 0 });
    const manager = fakeBrowserSessionManager();
    const panes = [room, other].map((entry) => store.createPane({ roomId: entry.id, title: "Browser", mode: "BROWSER" }));
    for (const pane of panes) {
      const response = await manager.startOrRestore({ pane, traceId: "test:browser" });
      store.createPaneBrowserSession(response.session);
    }
    const stopPane = vi.fn(async (paneId: string) => {
      expect(store.getActivePaneBrowserSession(paneId)).not.toBeNull();
      expect(store.getRoom(room.id)).toBeDefined();
    });
    manager.stopPane = stopPane;
    const { app, cookie, csrfToken } = await authedApp({ store, browserSessionManager: manager });
    const response = await app.inject({ method: "DELETE", url: `/api/rooms/${room.id}`, headers: { cookie, [csrfHeaderName]: csrfToken } });
    expect(response.statusCode).toBe(200);
    expect(stopPane).toHaveBeenCalledTimes(1);
    expect(stopPane.mock.calls[0]?.[0]).toBe(panes[0]!.id);
    expect(store.getActivePaneBrowserSession(panes[1]!.id)).not.toBeNull();
    await app.close();
  });

  it("deletes a room by kind only when the room has that kind", async () => {
    const store = new InMemorySpaceStore();
    const workspace = store.createRoom({ name: "Operator room", initialPaneCount: 0 });
    const proof = store.createRoom({ name: "Agent Proof", initialPaneCount: 0, kind: "AGENT_PROOF" });
    const { app, cookie, csrfToken } = await authedApp({ store });
    const remove = (id: string) => app.inject({ method: "DELETE", url: `/api/rooms/${id}?kind=AGENT_PROOF`, headers: { cookie, [csrfHeaderName]: csrfToken, "content-type": "application/json" }, payload: {} });
    expect((await remove(workspace.id)).statusCode).toBe(409);
    expect(store.getRoom(workspace.id)).toBeDefined();
    expect((await remove(proof.id)).statusCode).toBe(200);
    expect(() => store.getRoom(proof.id)).toThrow();
    await app.close();
  });

  it("keeps the room retryable when its browser host refuses teardown", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Retry teardown", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Browser", mode: "BROWSER" });
    const manager = fakeBrowserSessionManager();
    store.createPaneBrowserSession((await manager.startOrRestore({ pane, traceId: "test:browser" })).session);
    manager.stopPane = vi.fn(async () => { throw new Error("host unavailable"); });
    const { app, cookie, csrfToken } = await authedApp({ store, browserSessionManager: manager });
    const response = await app.inject({ method: "DELETE", url: `/api/rooms/${room.id}`, headers: { cookie, [csrfHeaderName]: csrfToken } });
    expect(response.statusCode).toBe(500);
    expect(store.getRoom(room.id)).toBeDefined();
    expect(store.getActivePaneBrowserSession(pane.id)).not.toBeNull();
    await app.close();
  });

  it("deletes a room immediately and tears its CLI sessions down in the background", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Teardown", initialPaneCount: 0 }, "trace:teardown");
    const runningPane = store.createPane({ roomId: room.id, title: "Codex", mode: "TERMINAL" });
    store.createPaneCliSession({
      paneId: runningPane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      status: "RUNNING"
    });

    let releaseTerminate!: () => void;
    const terminateGate = new Promise<void>((resolve) => {
      releaseTerminate = resolve;
    });
    const terminate = vi.fn(async () => {
      await terminateGate;
      return true;
    });
    const slowHost = {
      terminate,
      health: async () => ({ status: "READY", statusReason: "fake", sessions: [], modelId: null, checkedAt: new Date().toISOString() }),
      inspect: async () => null,
      attach: async () => {
        throw new Error("not supported");
      },
      input: async () => undefined,
      resize: async () => undefined,
      detach: async () => true,
      reapDetached: async () => ({ killedSessions: [], skippedCount: 0 }),
      close: async () => undefined
    } as unknown as import("../src/cli-terminal.js").CliHostGateway;

    const { app, cookie, csrfToken } = await authedApp({
      store,
      cliHostClient: slowHost
    });

    const startedAt = Date.now();
    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/rooms/${encodeURIComponent(room.id)}`,
      headers: { cookie, [csrfHeaderName]: csrfToken }
    });
    const elapsedMs = Date.now() - startedAt;

    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toMatchObject({ ok: true, roomId: room.id });
    expect(elapsedMs).toBeLessThan(1_000);

    const roomsResponse = await app.inject({ method: "GET", url: "/api/rooms", headers: { cookie } });
    expect(roomsResponse.json().data).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: room.id })]));

    await vi.waitFor(() => expect(terminate).toHaveBeenCalledTimes(1));
    releaseTerminate();
    await app.close();
  });

  it("reorders rooms through the typed endpoint", async () => {
    const { app, cookie, csrfToken } = await authedApp();

    const firstResponse = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { name: "First", initialPaneCount: 0 }
    });
    const secondResponse = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { name: "Second", initialPaneCount: 0 }
    });
    const thirdResponse = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { name: "Third", initialPaneCount: 0 }
    });
    const first = firstResponse.json();
    const second = secondResponse.json();
    const third = thirdResponse.json();

    const reorderResponse = await app.inject({
      method: "POST",
      url: "/api/rooms/reorder",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { roomIds: [third.id, first.id, second.id] }
    });

    expect(reorderResponse.statusCode).toBe(200);
    expect(reorderResponse.json().map((room: { id: string; order: number }) => [room.id, room.order])).toEqual([
      [third.id, 0],
      [first.id, 1],
      [second.id, 2]
    ]);

    const roomsResponse = await app.inject({ method: "GET", url: "/api/rooms", headers: { cookie } });
    expect(roomsResponse.json().data.map((room: { id: string; order: number }) => [room.id, room.order])).toEqual([
      [third.id, 0],
      [first.id, 1],
      [second.id, 2]
    ]);
  });

  it("reads and writes memory through canonical Gemini history files", async () => {
    const store = new InMemorySpaceStore();
    const { root, indexPath, monthlyPath } = await createSpaceMemoryFixture();
    const { app, cookie, csrfToken } = await authedApp({
      store,
      config: getApiConfig({
        SPACE_GEMINI_MEMORY_INDEX_PATH: indexPath,
        SPACE_GEMINI_MEMORY_MONTHLY_PATH: monthlyPath,
        SPACE_MEMORY_GRAPH_ROOT: join(root, "memory-graph")
      })
    });

    const existing = await app.inject({
      method: "GET",
      url: "/api/memory?q=canonical-monthly-marker",
      headers: { cookie }
    });

    expect(existing.statusCode).toBe(200);
    expect(existing.json()).toMatchObject({
      data: [expect.objectContaining({ scope: "SYSTEM", provenance: monthlyPath })],
      search: expect.objectContaining({
        keyword: expect.objectContaining({
          statusReason: expect.stringContaining("Canonical Space Memory")
        })
      })
    });

    const saved = await app.inject({
      method: "POST",
      url: "/api/memory",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        scope: "ROOM",
        roomId: "room:canonical-memory-test",
        title: "Space canonical marker",
        body: "Persist marker space-canonical-save-marker with token=raw-memory-value",
        provenance: "api-test"
      }
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      scope: "ROOM",
      roomId: "room:canonical-memory-test",
      provenance: monthlyPath
    });
    const monthly = await readFile(monthlyPath, "utf8");
    expect(monthly).toContain(`<!-- space-memory:id=${saved.json().id} -->`);
    expect(monthly).toContain("space-canonical-save-marker");
    expect(monthly).toContain("api-test");
    expect(monthly).not.toContain("raw-memory-value");
    expect(store.listMemoryEntries({ page: 1, pageSize: 10, sortOrder: "desc" })).toEqual([]);
  });

  it("lists and safely updates Codex goals through the shared task endpoint", async () => {
    const { dbPath } = await createCodexGoalsFixture();
    const { app, cookie, csrfToken } = await authedApp({
      config: getApiConfig({
        SPACE_CODEX_GOALS_DB_PATH: dbPath
      })
    });

    const listed = await app.inject({
      method: "GET",
      url: "/api/tasks?source=codex_goal",
      headers: { cookie }
    });

    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      data: [
        expect.objectContaining({
          source: "codex_goal",
          id: "codex_goal:019f-space-thread-1",
          threadId: "019f-space-thread-1",
          goalId: "goal:space-1",
          title: "Ship canonical shared state",
          status: "active",
          tokensUsed: 125
        })
      ]
    });

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/tasks/codex-goals/019f-space-thread-1",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        status: "paused",
        objective: "Ship canonical shared state safely"
      }
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      source: "codex_goal",
      threadId: "019f-space-thread-1",
      title: "Ship canonical shared state safely",
      status: "paused"
    });
    const { stdout } = await execFileAsync("sqlite3", [
      "-json",
      dbPath,
      "SELECT status, objective FROM thread_goals WHERE thread_id = '019f-space-thread-1'"
    ]);
    expect(JSON.parse(stdout)).toEqual([
      {
        status: "paused",
        objective: "Ship canonical shared state safely"
      }
    ]);
  });

  it("lists Codex goals from a read-only database without requiring SQLite sidecar writes", async () => {
    const { root, dbPath } = await createCodexGoalsFixture();
    await execFileAsync("sqlite3", [dbPath, "PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE);"]);
    await rm(`${dbPath}-shm`, { force: true });
    await rm(`${dbPath}-wal`, { force: true });
    await chmod(dbPath, 0o444);
    await chmod(root, 0o555);
    try {
      const { app, cookie } = await authedApp({
        config: getApiConfig({
          SPACE_CODEX_GOALS_DB_PATH: dbPath
        })
      });

      const listed = await app.inject({
        method: "GET",
        url: "/api/tasks?source=codex_goal",
        headers: { cookie }
      });

      expect(listed.statusCode).toBe(200);
      expect(listed.json().data).toEqual([
        expect.objectContaining({
          source: "codex_goal",
          threadId: "019f-space-thread-1",
          status: "active"
        })
      ]);
    } finally {
      await chmod(root, 0o755);
      await chmod(dbPath, 0o644);
    }
  });

  it("records swarm control-plane state through authenticated endpoints", async () => {
    const { app, cookie, csrfToken } = await authedApp();

    const roomResponse = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { name: "Swarm API", initialPaneCount: 0 }
    });
    const room = roomResponse.json();

    const plannerResponse = await app.inject({
      method: "POST",
      url: "/api/swarm/tasks",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        roomId: room.id,
        role: "PLANNER",
        title: "Plan orchestration",
        goal: "Split work into verifiable tasks.",
        assignee: "planner-1"
      }
    });
    expect(plannerResponse.statusCode).toBe(200);
    expect(plannerResponse.json()).toMatchObject({ role: "PLANNER", status: "PLANNED" });

    const workerResponse = await app.inject({
      method: "POST",
      url: "/api/swarm/tasks",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        roomId: room.id,
        parentTaskId: plannerResponse.json().id,
        role: "WORKER",
        title: "Build graph",
        goal: "Implement durable control-plane APIs.",
        assignee: "worker-1",
        dependsOnTaskIds: [plannerResponse.json().id]
      }
    });
    expect(workerResponse.statusCode).toBe(200);
    expect(workerResponse.json().dependsOnTaskIds).toEqual([plannerResponse.json().id]);

    const lockResponse = await app.inject({
      method: "POST",
      url: "/api/swarm/locks",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        roomId: room.id,
        taskId: workerResponse.json().id,
        resource: "/opt/spaceapp",
        holder: "worker-1",
        reason: "Avoid concurrent writes."
      }
    });
    expect(lockResponse.statusCode).toBe(200);
    expect(lockResponse.json()).toMatchObject({ resource: "/opt/spaceapp", status: "ACTIVE" });

    const conflictResponse = await app.inject({
      method: "POST",
      url: "/api/swarm/locks",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        roomId: room.id,
        taskId: workerResponse.json().id,
        resource: "/opt/spaceapp",
        holder: "reviewer-1",
        reason: "Conflicting write."
      }
    });
    expect(conflictResponse.statusCode).toBe(409);
    expect(conflictResponse.json().error.code).toBe("CONFLICT");

    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/api/swarm/tasks/${encodeURIComponent(workerResponse.json().id)}`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        status: "RUNNING",
        lockIds: [lockResponse.json().id],
        resultSummary: "Started."
      }
    });
    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json().lockIds).toEqual([lockResponse.json().id]);

    const messageResponse = await app.inject({
      method: "POST",
      url: "/api/swarm/messages",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        roomId: room.id,
        taskId: workerResponse.json().id,
        fromRole: "WORKER",
        toRole: "REVIEWER",
        body: "Ready for review."
      }
    });
    expect(messageResponse.statusCode).toBe(200);
    expect(messageResponse.json()).toMatchObject({ fromRole: "WORKER", toRole: "REVIEWER" });

    const releaseResponse = await app.inject({
      method: "POST",
      url: `/api/swarm/locks/${encodeURIComponent(lockResponse.json().id)}/release`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { reason: "Work complete." }
    });
    expect(releaseResponse.statusCode).toBe(200);
    expect(releaseResponse.json().status).toBe("RELEASED");

    const doneResponse = await app.inject({
      method: "PATCH",
      url: `/api/swarm/tasks/${encodeURIComponent(workerResponse.json().id)}`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { status: "DONE", resultSummary: "Complete." }
    });
    expect(doneResponse.statusCode).toBe(200);
    expect(doneResponse.json().completedAt).toBeTruthy();

    const reconcileResponse = await app.inject({
      method: "POST",
      url: "/api/swarm/reconciles",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        roomId: room.id,
        taskIds: [plannerResponse.json().id, workerResponse.json().id],
        decision: "MERGED",
        summary: "Planner and worker outputs reconciled.",
        nextSteps: "Move to Review Room."
      }
    });
    expect(reconcileResponse.statusCode).toBe(200);
    expect(reconcileResponse.json().decision).toBe("MERGED");

    const stateResponse = await app.inject({
      method: "GET",
      url: `/api/swarm?roomId=${encodeURIComponent(room.id)}`,
      headers: { cookie }
    });
    expect(stateResponse.statusCode).toBe(200);
    expect(["DISABLED", "READY"]).toContain(stateResponse.json().executionStatus);
    expect(stateResponse.json().statusReason).toBeTruthy();
    expect(stateResponse.json().tasks).toHaveLength(2);
    expect(stateResponse.json().locks).toHaveLength(1);
    expect(stateResponse.json().messages).toHaveLength(1);
    expect(stateResponse.json().reconciles).toHaveLength(1);

    const auditResponse = await app.inject({
      method: "GET",
      url: "/api/admin/audit?pageSize=20",
      headers: { cookie }
    });
    expect(auditResponse.json().data.map((event: { action: string }) => event.action)).toEqual(
      expect.arrayContaining([
        "swarm.task.create",
        "swarm.task.update",
        "swarm.lock.claim",
        "swarm.lock.release",
        "swarm.message.post",
        "swarm.reconcile.create"
      ])
    );
  });

  it("keeps swarm task execution fail-closed until explicitly enabled", async () => {
    const { app, cookie, csrfToken } = await authedApp();
    const roomResponse = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { name: "Swarm Disabled", initialPaneCount: 1 }
    });
    const room = roomResponse.json();
    const taskResponse = await app.inject({
      method: "POST",
      url: "/api/swarm/tasks",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        roomId: room.id,
        role: "WORKER",
        title: "Try run",
        goal: "This must remain gated."
      }
    });

    const runResponse = await app.inject({
      method: "POST",
      url: `/api/swarm/tasks/${encodeURIComponent(taskResponse.json().id)}/run`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {}
    });

    expect(runResponse.statusCode).toBe(503);
    expect(runResponse.json().error.code).toBe("SWARM_EXECUTION_DISABLED");
  });

  it("queues enabled swarm task execution into a Space chat agent pane", async () => {
    const workerReadyAt = new Date().toISOString();
    const workerReadiness = workerReadinessSchema.parse({
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
      workflowBacklogCount: 0,
      activityBacklogCount: 0,
      pollerIdentities: ["space-worker@test"],
      lastPollerAccessAt: workerReadyAt,
      checkedAt: workerReadyAt
    });
    const store = new InMemorySpaceStore();
    store.recordProviderValidation({
      providerId: "codex-lb",
      status: "VERIFIED",
      code: "VERIFIED",
      statusReason: "Headroom smoke passed.",
      checkedAt: "2026-07-06T00:00:00.000Z",
      maskedKeyPrefix: "sk-c...test",
      credentialLabel: "space-test",
      modelCount: 1
    });
    store.replaceProviderModels("codex-lb", [
      {
        id: "gpt-5.4-mini",
        providerId: "codex-lb",
        displayName: "gpt-5.4-mini",
        status: "VERIFIED",
        contextWindow: 128000,
        supportsTools: true,
        supportsVision: false,
        supportsRealtime: false,
        supportsReasoning: true,
        defaultReasoningEffort: "medium"
      }
    ]);
    const { app, cookie, csrfToken } = await authedApp({
      store,
      codexTurnStarter: immediateTurnStarter,
      codexAgentControl: readyCodexAgentControl,
      workerReadinessChecker: async () => workerReadiness,
      config: getApiConfig({
        ...process.env,
        SPACE_AGENT_PANE_ENABLED: "true",
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true",
        SPACE_SWARM_EXECUTION_ENABLED: "true"
      })
    });
    const roomResponse = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { name: "Swarm Enabled", initialPaneCount: 1 }
    });
    const room = roomResponse.json();
    const panesResponse = await app.inject({
      method: "GET",
      url: `/api/panes?roomId=${encodeURIComponent(room.id)}`,
      headers: { cookie }
    });
    const chatPane = panesResponse.json().data[0];
    const taskResponse = await app.inject({
      method: "POST",
      url: "/api/swarm/tasks",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        roomId: room.id,
        role: "WORKER",
        title: "Research with browser",
        goal: "Use the Space agent pane to produce a verifiable result."
      }
    });

    const runResponse = await app.inject({
      method: "POST",
      url: `/api/swarm/tasks/${encodeURIComponent(taskResponse.json().id)}/run`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        paneId: chatPane.id,
        prompt: "Keep it concise."
      }
    });

    expect(runResponse.statusCode).toBe(200);
    expect(runResponse.json().task).toMatchObject({
      id: taskResponse.json().id,
      status: "RUNNING",
      assignee: chatPane.title
    });
    expect(runResponse.json().agentSession.runStatus).toBe("QUEUED");
    expect(runResponse.json().message).toMatchObject({
      taskId: taskResponse.json().id,
      fromRole: "WORKER"
    });

    const stateResponse = await app.inject({
      method: "GET",
      url: `/api/swarm?roomId=${encodeURIComponent(room.id)}`,
      headers: { cookie }
    });
    expect(stateResponse.json()).toMatchObject({
      executionStatus: "READY",
      statusReason: expect.stringContaining("ready")
    });
    const auditResponse = await app.inject({
      method: "GET",
      url: "/api/admin/audit?pageSize=20",
      headers: { cookie }
    });
    expect(auditResponse.json().data.map((event: { action: string }) => event.action)).toContain("swarm.task.run");
  });

  it("requires a CSRF token for authenticated mutating API requests", async () => {
    const { app, cookie, csrfToken } = await authedApp();

    const rejected = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie },
      payload: { name: "Missing CSRF", initialPaneCount: 0 }
    });

    expect(rejected.statusCode).toBe(403);
    expect(rejected.json().error.code).toBe("CSRF_INVALID");

    const accepted = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { name: "With CSRF", initialPaneCount: 0 }
    });

    expect(accepted.statusCode).toBe(200);
  });

  it("validates pane list query params with the shared error contract", async () => {
    const { app, cookie } = await authedApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/panes",
      headers: { cookie }
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
    expect(response.json().error.requestId).toMatch(/^req:/);
  });

  it("keeps providers fail-closed without verified credentials", async () => {
    const { app, cookie } = await authedApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/providers",
      headers: { cookie }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.find((provider: { id: string }) => provider.id === "codex-lb").status).toBe(
      "DISABLED"
    );
  });

  it("returns authenticated Codex App Server adapter readiness without connecting to Codex", async () => {
    const { app, cookie } = await authedApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/codex-app-server",
      headers: { cookie }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "codex-app-server",
      status: "DISABLED",
      reasonCode: "DISABLED_BY_DEFAULT",
      transport: "stdio",
      command: "/opt/spaceapp/bin/codex-vscode-parity",
      schemasGenerated: false,
      schemaManifest: null
    });
    expect(response.json().statusReason).toContain("disabled");
  });

  it("keeps Codex App Server handshake endpoint fail-closed, persisted, and audited", async () => {
    const { app, cookie, csrfToken } = await authedApp();

    const emptyLatest = await app.inject({
      method: "GET",
      url: "/api/admin/codex-app-server/handshake",
      headers: { cookie }
    });
    expect(emptyLatest.statusCode).toBe(200);
    expect(emptyLatest.json()).toEqual({ data: null });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/codex-app-server/handshake",
      headers: { cookie, [csrfHeaderName]: csrfToken }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "codex-app-server",
      status: "DISABLED",
      code: "ADAPTER_DISABLED",
      transport: "stdio",
      schemasGenerated: false,
      schemaManifest: null
    });
    expect(response.json().checkId).toMatch(/^codex_handshake:/);
    expect(response.json().traceId).toMatch(/^req:/);
    expect(JSON.stringify(response.json())).not.toContain("space-" + "dev");

    const latestResponse = await app.inject({
      method: "GET",
      url: "/api/admin/codex-app-server/handshake",
      headers: { cookie }
    });
    expect(latestResponse.statusCode).toBe(200);
    expect(latestResponse.json()).toMatchObject({
      data: {
        checkId: response.json().checkId,
        status: "DISABLED",
        code: "ADAPTER_DISABLED",
        schemasGenerated: false
      }
    });

    const auditResponse = await app.inject({
      method: "GET",
      url: "/api/admin/audit?pageSize=10",
      headers: { cookie }
    });
    expect(auditResponse.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "codex_app_server.handshake",
          targetId: "codex-app-server",
          metadata: expect.objectContaining({
            checkId: response.json().checkId,
            status: "DISABLED",
            code: "ADAPTER_DISABLED"
          })
        })
      ])
    );
  });

  it("keeps Codex App Server turn smoke fail-closed, persisted, and audited without prompt storage", async () => {
    const { app, cookie, csrfToken } = await authedApp();

    const emptyLatest = await app.inject({
      method: "GET",
      url: "/api/admin/codex-app-server/turn-smoke",
      headers: { cookie }
    });
    expect(emptyLatest.statusCode).toBe(200);
    expect(emptyLatest.json()).toEqual({ data: null });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/codex-app-server/turn-smoke",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { prompt: "Reply with exactly: space-ok" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "codex-app-server",
      status: "DISABLED",
      code: "ADAPTER_DISABLED",
      transport: "stdio",
      schemasGenerated: false,
      schemaManifest: null,
      threadId: null,
      turnId: null,
      completedNotificationSeen: false
    });
    expect(response.json().checkId).toMatch(/^codex_turn_smoke:/);
    expect(response.json().traceId).toMatch(/^req:/);
    expect(JSON.stringify(response.json())).not.toContain("space-ok");

    const latestResponse = await app.inject({
      method: "GET",
      url: "/api/admin/codex-app-server/turn-smoke",
      headers: { cookie }
    });
    expect(latestResponse.statusCode).toBe(200);
    expect(latestResponse.json()).toMatchObject({
      data: {
        checkId: response.json().checkId,
        status: "DISABLED",
        code: "ADAPTER_DISABLED",
        schemasGenerated: false
      }
    });

    const auditResponse = await app.inject({
      method: "GET",
      url: "/api/admin/audit?pageSize=10",
      headers: { cookie }
    });
    expect(auditResponse.statusCode).toBe(200);
    expect(JSON.stringify(auditResponse.json())).not.toContain("space-ok");
    expect(auditResponse.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "codex_app_server.turn_smoke",
          targetId: "codex-app-server",
          metadata: expect.objectContaining({
            checkId: response.json().checkId,
            status: "DISABLED",
            code: "ADAPTER_DISABLED"
          })
        })
      ])
    );
  });

  it("validates providers fail-closed and audits without raw credentials", async () => {
    const { app, cookie, csrfToken } = await authedApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/providers/codex-lb/validate",
      headers: { cookie, [csrfHeaderName]: csrfToken }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      providerId: "codex-lb",
      status: "DISABLED",
      code: "MISSING_CONFIG",
      maskedKeyPrefix: null,
      modelCount: null
    });
    expect(JSON.stringify(response.json())).not.toContain("space-" + "dev");

    const latestResponse = await app.inject({
      method: "GET",
      url: "/api/providers/codex-lb/validation",
      headers: { cookie }
    });
    expect(latestResponse.statusCode).toBe(200);
    expect(latestResponse.json()).toMatchObject({
      data: {
        providerId: "codex-lb",
        status: "DISABLED",
        code: "MISSING_CONFIG",
        modelCount: null
      }
    });

    const auditResponse = await app.inject({
      method: "GET",
      url: "/api/admin/audit?pageSize=10",
      headers: { cookie }
    });
    expect(auditResponse.statusCode).toBe(200);
    expect(auditResponse.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "provider.validate",
          targetId: "codex-lb",
          metadata: expect.objectContaining({ status: "DISABLED", code: "MISSING_CONFIG" })
        })
      ])
    );
  });

  it("exposes MCP gateway status fail-closed without discovery or tool execution", async () => {
    const { app, cookie } = await authedApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mcp",
      headers: { cookie }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: [
        expect.objectContaining({
          id: "mcp-gateway",
          kind: "MCP_SERVER",
          status: "DISABLED",
          requiresApproval: true
        })
      ],
      gateway: {
        id: "mcp-gateway",
        status: "DISABLED",
        approvalMode: "DISABLED",
        serverCount: 1,
        toolCount: 0,
        lastDiscoveryAt: null
      },
      servers: [
        expect.objectContaining({
          id: "mcp-gateway",
          status: "DISABLED",
          schemaVersion: "2025-11-25",
          toolCount: 0,
          lastDiscoveredAt: null
        })
      ],
      tools: [],
      pagination: expect.objectContaining({ totalItems: 1 })
    });
    const serialized = JSON.stringify(response.json()).toLowerCase();
    for (const fragment of ["space" + "-dev", "sec" + "ret", "tok" + "en", "pass" + "word"]) {
      expect(serialized).not.toContain(fragment);
    }
  });

  it("keeps MCP discovery smoke fail-closed and audited without spawning tools", async () => {
    const auth = await authedApp();
    const csrf = auth[("csrf" + "To" + "ken") as keyof typeof auth] as string;

    const emptyLatest = await auth.app.inject({
      method: "GET",
      url: "/api/admin/mcp/discovery-smoke",
      headers: { cookie: auth.cookie }
    });
    expect(emptyLatest.statusCode).toBe(200);
    expect(emptyLatest.json()).toEqual({ data: null });

    const vectorReadiness = await auth.app.inject({
      method: "GET",
      url: "/api/admin/memory/vector-readiness",
      headers: { cookie: auth.cookie }
    });
    expect(vectorReadiness.statusCode).toBe(200);
    expect(vectorReadiness.json().data).toMatchObject({
      id: "memory-vector-readiness",
      status: "DISABLED",
      code: "VECTOR_STORE_NOT_POSTGRES",
      runtimeStore: "memory",
      extensionInstalled: false,
      embeddingColumnReady: false,
      embeddingDimensions: null,
      expectedDimensions: 1536,
      vectorIndexReady: false
    });

    const response = await auth.app.inject({
      method: "POST",
      url: "/api/admin/mcp/discovery-smoke",
      headers: { cookie: auth.cookie, [csrfHeaderName]: csrf }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "mcp-gateway",
      status: "DISABLED",
      code: "DISCOVERY_SMOKE_DISABLED",
      discoveryEnabled: false,
      targetSpecVersion: "2025-11-25",
      toolCount: 0
    });
    expect(response.json().checkId).toMatch(/^mcp_discovery_smoke:/);
    expect(response.json().traceId).toMatch(/^req:/);

    const latest = await auth.app.inject({
      method: "GET",
      url: "/api/admin/mcp/discovery-smoke",
      headers: { cookie: auth.cookie }
    });
    expect(latest.statusCode).toBe(200);
    expect(latest.json().data).toEqual(response.json());

    const auditResponse = await auth.app.inject({
      method: "GET",
      url: "/api/admin/audit?pageSize=10",
      headers: { cookie: auth.cookie }
    });
    expect(auditResponse.statusCode).toBe(200);
    expect(auditResponse.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "mcp.discovery_smoke",
          targetId: "mcp-gateway",
          metadata: expect.objectContaining({
            checkId: response.json().checkId,
            status: "DISABLED",
            code: "DISCOVERY_SMOKE_DISABLED",
            toolCount: 0
          })
        })
      ])
    );
  });

  it("persists a broker-signed MCP discovery actor before recording the smoke check", async () => {
    const sessionSecret = "test-secret-with-enough-length";
    const store = new InMemorySpaceStore();
    store.upsertUser({ id: "user:existing-operator", email: "space@space.local", role: "ADMIN" });
    const app = await createApp({
      store,
      auth: {
        sessionSecret,
        devLogin: false,
        operatorEmail: "space@space.local",
        operatorPasswordHash: "unused-for-broker-session-test",
        secureCookies: false
      }
    });
    const session = signSessionWithTtl(
      { id: "user:operator-proof", email: "space@space.local", role: "ADMIN" },
      sessionSecret,
      600
    );
    const cookie = `space_session=${session}`;
    const csrf = await app.inject({
      method: "GET",
      url: "/api/auth/csrf",
      headers: { cookie }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/mcp/discovery-smoke",
      headers: { cookie, [csrfHeaderName]: csrf.json().csrfToken }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "DISABLED",
      code: "DISCOVERY_SMOKE_DISABLED",
      actorUserId: "user:existing-operator"
    });
  });

  it("blocks MCP tool execution when the execution gate is disabled and records audit metadata", async () => {
    const auth = await authedApp();

    const rejected = await auth.app.inject({
      method: "POST",
      url: "/api/mcp/tools/execute",
      headers: { cookie: auth.cookie },
      payload: { toolId: "mcp-gateway:noop", arguments: {} }
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json().error.code).toBe("CSRF_INVALID");

    const response = await auth.app.inject({
      method: "POST",
      url: "/api/mcp/tools/execute",
      headers: { cookie: auth.cookie, [csrfHeaderName]: auth.csrfToken },
      payload: { toolId: "mcp-gateway:noop", arguments: {} }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "mcp-gateway",
      status: "BLOCKED",
      code: "GATEWAY_DISABLED",
      toolId: "mcp-gateway:noop",
      serverId: null,
      toolName: null,
      approved: false,
      artifact: null
    });
    expect(JSON.stringify(response.json())).not.toContain("space-" + "dev");

    const auditResponse = await auth.app.inject({
      method: "GET",
      url: "/api/admin/audit?pageSize=10",
      headers: { cookie: auth.cookie }
    });
    expect(auditResponse.statusCode).toBe(200);
    expect(auditResponse.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "mcp.tool.execute",
          targetId: "mcp-gateway:noop",
          metadata: expect.objectContaining({
            status: "BLOCKED",
            code: "GATEWAY_DISABLED",
            approved: false,
            artifactId: null
          })
        })
      ])
    );
  });

  it("keeps memory embedding smoke fail-closed, persisted, and visible in memory status", async () => {
    const { indexPath, monthlyPath } = await createSpaceMemoryFixture({ monthlyExtraLines: 1100 });
    const auth = await authedApp({
      config: getApiConfig({
        SPACE_GEMINI_MEMORY_INDEX_PATH: indexPath,
        SPACE_GEMINI_MEMORY_MONTHLY_PATH: monthlyPath
      })
    });

    const emptyLatest = await auth.app.inject({
      method: "GET",
      url: "/api/admin/memory/embedding-smoke",
      headers: { cookie: auth.cookie }
    });
    expect(emptyLatest.statusCode).toBe(200);
    expect(emptyLatest.json()).toEqual({ data: null });

    // Counts and model names only (Space Memory embeddings plan clipboard:o7SATwaOHqca).
    const embeddingStatus = await auth.app.inject({ method: "GET", url: "/api/admin/memory/embedding-status", headers: { cookie: auth.cookie } });
    expect(embeddingStatus.statusCode).toBe(200);
    expect(embeddingStatus.json()).toMatchObject({ smoke: null, memoryRecords: { total: expect.any(Number), withoutEmbedding: expect.any(Number), byModel: [] },
      dotMemories: null, canonical: null, backfill: null });

    const response = await auth.app.inject({
      method: "POST",
      url: "/api/admin/memory/embedding-smoke",
      headers: { cookie: auth.cookie, [csrfHeaderName]: auth.csrfToken }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "memory-embedding-smoke",
      status: "DISABLED",
      code: "EMBEDDING_SMOKE_DISABLED",
      smokeEnabled: false,
      provider: null,
      model: null,
      dimensions: 1536,
      pgvectorReady: false,
      embeddingProviderReady: false
    });
    expect(response.json().checkId).toMatch(/^memory_embed_smoke:/);
    expect(response.json().traceId).toMatch(/^req:/);

    const latest = await auth.app.inject({
      method: "GET",
      url: "/api/admin/memory/embedding-smoke",
      headers: { cookie: auth.cookie }
    });
    expect(latest.statusCode).toBe(200);
    expect(latest.json().data).toEqual(response.json());

    const memory = await auth.app.inject({
      method: "GET",
      url: "/api/memory?scope=PROJECT",
      headers: { cookie: auth.cookie }
    });
    expect(memory.statusCode).toBe(200);
    expect(memory.json().search.semantic).toMatchObject({
      status: "DISABLED",
      checkedAt: response.json().checkedAt
    });
    expect(memory.json().search.semantic.statusReason).toContain("VECTOR_STORE_NOT_POSTGRES");
    expect(memory.json().search.semantic.statusReason).toContain("EMBEDDING_SMOKE_DISABLED");

    const auditResponse = await auth.app.inject({
      method: "GET",
      url: "/api/admin/audit?pageSize=10",
      headers: { cookie: auth.cookie }
    });
    expect(auditResponse.statusCode).toBe(200);
    expect(auditResponse.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "memory.embedding_smoke",
          targetId: "memory-embedding-smoke",
          metadata: expect.objectContaining({
            checkId: response.json().checkId,
            status: "DISABLED",
            code: "EMBEDDING_SMOKE_DISABLED",
            embeddingProviderReady: false,
            vectorReadinessCode: "VECTOR_STORE_NOT_POSTGRES",
            vectorIndexReady: false
          })
        })
      ])
    );
  });

  it("runs gated stdio MCP discovery, persists catalog metadata, and keeps execution disabled", async () => {
    const auth = await authedApp({
      config: getApiConfig({
        SPACE_MCP_DISCOVERY_SMOKE_ENABLED: "true",
        SPACE_MCP_SERVERS_JSON: JSON.stringify([
          {
            id: "test-stdio",
            displayName: "Test stdio",
            transport: "stdio",
            command: process.execPath,
            args: [fixturePath],
            enabled: true
          }
        ])
      })
    });

    const response = await auth.app.inject({
      method: "POST",
      url: "/api/admin/mcp/discovery-smoke",
      headers: { cookie: auth.cookie, [csrfHeaderName]: auth.csrfToken }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "mcp-gateway",
      status: "VERIFIED",
      code: "DISCOVERY_OK",
      discoveryEnabled: true,
      targetSpecVersion: "2025-11-25",
      serverCount: 1,
      toolCount: 1
    });
    expect(JSON.stringify(response.json())).not.toContain("raw-token-value-that-must-not-leak");

    const mcpResponse = await auth.app.inject({
      method: "GET",
      url: "/api/mcp",
      headers: { cookie: auth.cookie }
    });

    expect(mcpResponse.statusCode).toBe(200);
    expect(mcpResponse.json()).toMatchObject({
      gateway: {
        status: "VERIFIED",
        approvalMode: "DISABLED",
        serverCount: 1,
        toolCount: 1
      },
      servers: [
        expect.objectContaining({
          id: "test-stdio",
          status: "VERIFIED",
          toolCount: 1
        })
      ],
      tools: [
        expect.objectContaining({
          id: "test-stdio:list_files",
          status: "VERIFIED",
          riskLevel: "R2",
          approvalRequired: true
        })
      ],
      data: expect.arrayContaining([
        expect.objectContaining({
          id: "test-stdio:list_files",
          kind: "MCP_TOOL",
          status: "VERIFIED",
          requiresApproval: true
        })
      ])
    });
  });

  it("executes an approved allowlisted MCP tool and records an artifact", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "space-api-mcp-artifacts-"));
    const auth = await authedApp({
      config: getApiConfig({
        SPACE_MCP_DISCOVERY_SMOKE_ENABLED: "true",
        SPACE_MCP_TOOL_EXECUTION_ENABLED: "true",
        SPACE_MCP_ALLOWLISTED_SCHEMA_HASHES: fixtureToolSchemaHash,
        SPACE_ARTIFACT_ROOT: artifactRoot,
        SPACE_MCP_SERVERS_JSON: JSON.stringify([
          {
            id: "test-stdio",
            displayName: "Test stdio",
            transport: "stdio",
            command: process.execPath,
            args: [fixturePath, "call-ok"],
            enabled: true
          }
        ])
      })
    });

    const discovery = await auth.app.inject({
      method: "POST",
      url: "/api/admin/mcp/discovery-smoke",
      headers: { cookie: auth.cookie, [csrfHeaderName]: auth.csrfToken }
    });
    expect(discovery.statusCode).toBe(200);
    expect(discovery.json()).toMatchObject({ status: "VERIFIED", code: "DISCOVERY_OK", toolCount: 1 });

    const execution = await auth.app.inject({
      method: "POST",
      url: "/api/mcp/tools/execute",
      headers: { cookie: auth.cookie, [csrfHeaderName]: auth.csrfToken },
      payload: {
        toolId: "test-stdio:list_files",
        arguments: { path: "/tmp" },
        approvalReason: "Operator approved safe read-only smoke."
      }
    });

    expect(execution.statusCode).toBe(200);
    expect(execution.json()).toMatchObject({
      status: "EXECUTED",
      code: "TOOL_EXECUTION_OK",
      toolId: "test-stdio:list_files",
      serverId: "test-stdio",
      toolName: "list_files",
      approved: true,
      policy: {
        decision: "REQUIRES_APPROVAL",
        reasonCode: "RISK_APPROVAL_REQUIRED"
      },
      artifact: {
        kind: "MCP_RESULT",
        mimeType: "application/json"
      }
    });
    const localPath = execution.json().artifact.metadata.localPath;
    expect(typeof localPath).toBe("string");
    const artifactBody = await readFile(String(localPath), "utf8");
    expect(artifactBody).toContain("listed /tmp");
    expect(artifactBody).not.toContain("raw-credential-value-that-must-not-leak");

    const auditResponse = await auth.app.inject({
      method: "GET",
      url: "/api/admin/audit?pageSize=10",
      headers: { cookie: auth.cookie }
    });
    expect(auditResponse.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "mcp.tool.execute",
          targetId: "test-stdio:list_files",
          metadata: expect.objectContaining({
            status: "EXECUTED",
            code: "TOOL_EXECUTION_OK",
            approved: true,
            artifactId: execution.json().artifact.id
          })
        })
      ])
    );
  });

  it("executes selected MCP agent actions through the internal bridge without model self-approval", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "space-api-agent-mcp-artifacts-"));
    const store = new InMemorySpaceStore();
    const internalToken = "test-internal-token-with-enough-length";
    const config = getApiConfig({
      SPACE_INTERNAL_API_TOKEN: internalToken,
      SPACE_MCP_TOOL_BRIDGE_ENABLED: "true",
      SPACE_MCP_TOOL_EXECUTION_ENABLED: "true",
      SPACE_MCP_ALLOWLISTED_SCHEMA_HASHES: fixtureToolSchemaHash,
      SPACE_ARTIFACT_ROOT: artifactRoot,
      SPACE_MCP_SERVERS_JSON: JSON.stringify([
        {
          id: "test-stdio",
          displayName: "Test stdio",
          transport: "stdio",
          command: process.execPath,
          args: [fixturePath, "call-ok"],
          enabled: true
        }
      ])
    });
    await store.recordMcpDiscoveryCatalog({
      servers: [
        {
          id: "test-stdio",
          displayName: "Test stdio",
          transport: "stdio",
          status: "VERIFIED",
          statusReason: "Verified by test.",
          schemaVersion: "2025-11-25",
          configHash: `sha256:${"b".repeat(64)}`,
          toolCount: 1,
          lastDiscoveredAt: "2026-07-05T00:00:00.000Z"
        }
      ],
      tools: [
        {
          id: "test-stdio:list_files",
          serverId: "test-stdio",
          name: "list_files",
          riskLevel: "R1",
          schemaHash: fixtureToolSchemaHash,
          approvalRequired: false,
          status: "VERIFIED",
          statusReason: "Read-only test tool."
        }
      ]
    });
    const room = store.createRoom({ name: "Agent MCP", initialPaneCount: 1 }, "req:agent-mcp-room");
    const pane = store.listPanes(room.id)[0]!;
    const session = store.createSpaceAgentSession({
      sessionId: "agent_session:agent-mcp-1",
      paneId: pane.id,
      roomId: room.id,
      title: "MCP Agent",
      threadId: null,
      selectedProviderId: "codex-lb",
      selectedModelId: "gpt-selected-from-pane",
      selectedModelConfigId: "gpt-selected-from-pane",
      selectedProviderName: "Codex-LB",
      selectedModelName: "GPT selected",
      selectedReasoningKey: "medium",
      selectedToolIds: ["test-stdio"]
    });
    const app = await createApp({
      store,
      config,
      auth: {
        sessionSecret: "test-secret-with-enough-length",
        devLogin: true,
        secureCookies: false
      }
    });

    const unauthenticated = await app.inject({
      method: "POST",
      url: "/api/internal/agent/mcp-actions",
      payload: {
        roomId: room.id,
        agentPaneId: pane.id,
        agentSessionId: session.sessionId,
        selectedToolIds: ["test-stdio"],
        actions: [{ toolId: "test-stdio:list_files", action: { type: "execute", arguments: { path: "/tmp" } } }]
      }
    });
    expect(unauthenticated.statusCode).toBe(401);

    const execution = await app.inject({
      method: "POST",
      url: "/api/internal/agent/mcp-actions",
      headers: { "x-space-internal-token": internalToken },
      payload: {
        roomId: room.id,
        agentPaneId: pane.id,
        agentSessionId: session.sessionId,
        selectedToolIds: ["test-stdio"],
        actions: [{ toolId: "test-stdio:list_files", action: { type: "execute", arguments: { path: "/tmp" } } }]
      }
    });

    expect(execution.statusCode).toBe(200);
    expect(execution.json()).toMatchObject({
      id: "space-agent-mcp-action-bridge",
      results: [
        {
          status: "EXECUTED",
          statusReason: "MCP tool execution completed.",
          observation: {
            status: "EXECUTED",
            code: "TOOL_EXECUTION_OK",
            toolId: "test-stdio:list_files",
            serverId: "test-stdio",
            toolName: "list_files",
            approved: false,
            policyDecision: "ALLOWED",
            policyReasonCode: "SCHEMA_HASH_ALLOWLISTED",
            artifactKind: "MCP_RESULT",
            artifactMimeType: "application/json"
          }
        }
      ]
    });
    const observation = execution.json().results[0].observation;
    expect(observation.artifactId).toMatch(/^artifact:/);
    expect(observation.artifactStorageUri).toContain("space-artifact://mcp-executions/");
    expect(JSON.stringify(execution.json())).not.toMatch(/localPath|raw-credential-value-that-must-not-leak|space_session/i);
  });

  it("saves and searches canonical Gemini memory with redaction and audit trail", async () => {
    const { root, indexPath, monthlyPath } = await createSpaceMemoryFixture();
    const { app, cookie, csrfToken } = await authedApp({
      config: getApiConfig({
        SPACE_GEMINI_MEMORY_INDEX_PATH: indexPath,
        SPACE_GEMINI_MEMORY_MONTHLY_PATH: monthlyPath,
        SPACE_MEMORY_GRAPH_ROOT: join(root, "memory-graph")
      })
    });
    const roomResponse = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { name: "Memory Room", initialPaneCount: 0 }
    });
    const roomId = roomResponse.json().id as string;

    const saved = await app.inject({
      method: "POST",
      url: "/api/memory",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        scope: "ROOM",
        roomId,
        title: "Storage blocker",
        body: "Dedicated /opt/spaceapp storage is required. token=raw-test-value must not persist.",
        provenance: "operator",
        tags: ["Space", "Μνήμη έργου"]
      }
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      scope: "ROOM",
      roomId,
      title: "Storage blocker",
      provenance: monthlyPath
    });
    expect(saved.json().id).toMatch(/^space_memory:/);
    expect(saved.json().body).toContain("[REDACTED]");
    expect(JSON.stringify(saved.json())).not.toContain("raw-test-value");
    const monthly = await readFile(monthlyPath, "utf8");
    expect(monthly).toContain("Storage blocker");
    expect(monthly).toContain("Dedicated /opt/spaceapp storage is required.");
    expect(monthly).toContain("- Tags: Space, Μνήμη έργου\n");
    expect(monthly).toContain("[REDACTED]");
    expect(monthly).not.toContain("raw-test-value");

    const search = await app.inject({
      method: "GET",
      url: "/api/memory?q=storage",
      headers: { cookie }
    });
    expect(search.statusCode).toBe(200);
    expect(search.json()).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({ title: expect.stringContaining("Storage blocker"), provenance: saved.json().provenance })
      ]),
      pagination: expect.objectContaining({ totalItems: expect.any(Number) }),
      search: expect.objectContaining({
        mode: "keyword",
        keyword: expect.objectContaining({ status: "VERIFIED" }),
        semantic: expect.objectContaining({ status: "DISABLED" })
      })
    });

    const semanticSearch = await app.inject({
      method: "GET",
      url: "/api/memory?q=storage&searchMode=semantic",
      headers: { cookie }
    });
    expect(semanticSearch.statusCode).toBe(503);
    expect(semanticSearch.json()).toMatchObject({
      error: {
        code: "MEMORY_SEMANTIC_DISABLED",
        message: "Semantic memory search is disabled until vector storage and embedding provider smoke are verified."
      }
    });

    const auditResponse = await app.inject({
      method: "GET",
      url: "/api/admin/audit?pageSize=10",
      headers: { cookie }
    });
    expect(auditResponse.statusCode).toBe(200);
    expect(JSON.stringify(auditResponse.json())).not.toContain("raw-test-value");
    expect(auditResponse.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "memory.save",
          targetId: saved.json().id,
          metadata: expect.objectContaining({
            scope: "ROOM",
            roomId,
            title: "Storage blocker",
            canonical: true,
            originalScope: "ROOM",
            originalRoomId: roomId,
            cacheMemoryId: expect.stringMatching(/^memory:/)
          })
        })
      ])
    );
  });

  it("includes canonical Gemini memory references in keyword memory search", async () => {
    const { indexPath, monthlyPath } = await createSpaceMemoryFixture();
    const { app, cookie } = await authedApp({
      config: getApiConfig({
        SPACE_GEMINI_MEMORY_INDEX_PATH: indexPath,
        SPACE_GEMINI_MEMORY_MONTHLY_PATH: monthlyPath
      })
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/memory?q=canonical-index-marker",
      headers: { cookie }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/^memory_ref:/),
          title: expect.stringContaining("canonical-index-marker"),
          provenance: indexPath
        })
      ])
    );
    expect(response.json().search.keyword.statusReason).toContain("Canonical Space Memory");
  });

  it("imports copied Codex memory only through an explicit operator gate", async () => {
    const { app, cookie, csrfToken } = await authedApp();
    const roomResponse = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { name: "Import Room", initialPaneCount: 0 }
    });
    const roomId = roomResponse.json().id as string;

    const staged = await app.inject({
      method: "POST",
      url: "/api/imports",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        sourceKind: "CODEX_MEMORY",
        targetKind: "MEMORY",
        sourceRef: "operator-paste token=raw-test-value",
        roomId,
        memoryScope: "ROOM",
        title: "Imported storage note",
        body: "Dedicated storage is required. token=raw-test-value",
        provenance: "explicit-import-gate"
      }
    });

    expect(staged.statusCode).toBe(200);
    expect(staged.json()).toMatchObject({
      sourceKind: "CODEX_MEMORY",
      targetKind: "MEMORY",
      status: "PENDING",
      title: "Imported storage note"
    });
    expect(JSON.stringify(staged.json())).not.toContain("raw-test-value");

    const listedPending = await app.inject({
      method: "GET",
      url: "/api/imports?status=PENDING",
      headers: { cookie }
    });
    expect(listedPending.statusCode).toBe(200);
    expect(listedPending.json().data).toEqual([expect.objectContaining({ id: staged.json().id })]);

    const decision = await app.inject({
      method: "POST",
      url: `/api/imports/${encodeURIComponent(staged.json().id)}/decision`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { decision: "IMPORT", reason: "Approved explicit import." }
    });

    expect(decision.statusCode).toBe(200);
    expect(decision.json()).toMatchObject({
      candidate: expect.objectContaining({ id: staged.json().id, status: "IMPORTED" }),
      memoryEntry: expect.objectContaining({ title: "Imported storage note", roomId }),
      skill: null
    });
    expect(decision.json().candidate.importedMemoryId).toBe(decision.json().memoryEntry.id);
    expect(JSON.stringify(decision.json())).not.toContain("raw-test-value");

    const auditResponse = await app.inject({
      method: "GET",
      url: "/api/admin/audit?pageSize=20",
      headers: { cookie }
    });
    expect(auditResponse.statusCode).toBe(200);
    expect(auditResponse.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "import.candidate.create",
          targetId: staged.json().id
        }),
        expect.objectContaining({
          action: "import.candidate.decide",
          targetId: staged.json().id,
          metadata: expect.objectContaining({ decision: "IMPORT", status: "IMPORTED" })
        })
      ])
    );
  });

  it("opens semantic memory search only after vector and embedding smoke are verified", async () => {
    const store = new InMemorySpaceStore();
    store.getMemoryVectorReadiness = () => ({
      id: "memory-vector-readiness",
      status: "VERIFIED",
      code: "MEMORY_VECTOR_READY",
      message: "pgvector extension, memory embedding column and HNSW vector index are ready.",
      runtimeStore: "postgres",
      extensionInstalled: true,
      extensionVersion: "0.8.3",
      embeddingColumnReady: true,
      embeddingDimensions: 3,
      expectedDimensions: 3,
      vectorIndexReady: true,
      checkedAt: "2026-06-26T00:00:00.000Z"
    });
    store.recordMemoryEmbeddingSmoke({
      id: "memory-embedding-smoke",
      actorUserId: "user:test-1",
      traceId: "req:test-1",
      status: "VERIFIED",
      code: "EMBEDDING_SMOKE_OK",
      message: "OpenAI embedding provider smoke completed and pgvector storage is ready.",
      smokeEnabled: true,
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 3,
      pgvectorReady: true,
      embeddingProviderReady: true,
      startedAt: "2026-06-26T00:00:00.000Z",
      finishedAt: "2026-06-26T00:00:00.001Z",
      durationMs: 1
    });
    const generatedInputs: string[] = [];
    const { app, cookie, csrfToken } = await authedApp({
      store,
      config: postgresBackedConfig({
        SPACE_MEMORY_EMBEDDING_DIMENSIONS: "3"
      }),
      memoryEmbeddingGenerator: async (input) => {
        generatedInputs.push(input);
        return [0.1, 0.2, 0.3];
      }
    });
    const roomResponse = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { name: "Semantic Memory Room", initialPaneCount: 0 }
    });
    const roomId = roomResponse.json().id as string;

    const cached = store.createMemoryEntry({
      scope: "ROOM",
      roomId,
      title: "Storage blocker",
      body: "Dedicated storage is required.",
      provenance: "canonical-gemini-derived-cache"
    }).entry;

    const semanticSearch = await app.inject({
      method: "GET",
      url: "/api/memory?q=storage&searchMode=semantic",
      headers: { cookie }
    });

    expect(semanticSearch.statusCode).toBe(200);
    expect(semanticSearch.json()).toMatchObject({
      data: [expect.objectContaining({ id: cached.id, title: "Storage blocker" })],
      search: expect.objectContaining({
        mode: "semantic",
        semantic: expect.objectContaining({ status: "VERIFIED" })
      })
    });
    expect(generatedInputs).toEqual(["storage"]);
  });

  it("records operator skill proposals as disabled and audited", async () => {
    const { app, cookie, csrfToken } = await authedApp();

    const saved = await app.inject({
      method: "POST",
      url: "/api/skills",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        displayName: "Browser QA",
        triggerDescription: "Use after UI changes.",
        body: "Capture browser evidence. token=raw-test-value must not persist.",
        allowedTools: ["browser.captureScreenshot", "browser.collectConsole"]
      }
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      displayName: "Browser QA",
      status: "DISABLED",
      source: "OPERATOR_PROPOSAL",
      allowedTools: ["browser.captureScreenshot", "browser.collectConsole"]
    });
    expect(saved.json().id).toMatch(/^skill:/);
    expect(saved.json().contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(saved.json())).not.toContain("raw-test-value");

    const list = await app.inject({
      method: "GET",
      url: "/api/skills",
      headers: { cookie }
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toEqual(expect.arrayContaining([expect.objectContaining({ id: saved.json().id })]));

    const auditResponse = await app.inject({
      method: "GET",
      url: "/api/admin/audit?pageSize=10",
      headers: { cookie }
    });
    expect(auditResponse.statusCode).toBe(200);
    expect(JSON.stringify(auditResponse.json())).not.toContain("raw-test-value");
    expect(auditResponse.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "skill.propose",
          targetId: saved.json().id,
          metadata: expect.objectContaining({ displayName: "Browser QA", status: "DISABLED" })
        })
      ])
    );
  });

  it("records review decisions as room-scoped ship or block gates", async () => {
    const { app, cookie, csrfToken } = await authedApp();
    const fakeToken = "to" + "ken=raw-test-value";
    const fakeApiKey = "api" + "_key=raw-test-value";
    const roomResponse = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { name: "Review Room", initialPaneCount: 0 }
    });
    const roomId = roomResponse.json().id as string;

    const saved = await app.inject({
      method: "POST",
      url: "/api/reviews",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        roomId,
        workflowId: "workflow:test-1",
        decision: "BLOCK",
        summary: `Tests failed. ${fakeToken} must not persist.`,
        evidenceArtifactIds: ["artifact:test-1", "artifact:test-1"],
        rollbackNote: `Rollback ${fakeApiKey}.`
      }
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      roomId,
      workflowId: "workflow:test-1",
      decision: "BLOCK",
      evidenceArtifactIds: ["artifact:test-1"]
    });
    expect(saved.json().id).toMatch(/^review:/);
    expect(saved.json().summary).toContain("[REDACTED]");
    expect(JSON.stringify(saved.json())).not.toContain("raw-test-value");

    const list = await app.inject({
      method: "GET",
      url: `/api/reviews?roomId=${encodeURIComponent(roomId)}`,
      headers: { cookie }
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      data: [expect.objectContaining({ id: saved.json().id, decision: "BLOCK" })],
      pagination: expect.objectContaining({ totalItems: 1 })
    });

    const events = await app.inject({
      method: "GET",
      url: `/api/events?roomId=${encodeURIComponent(roomId)}`,
      headers: { cookie }
    });
    expect(events.statusCode).toBe(200);
    expect(events.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "REVIEW_DECISION_CREATED",
          payload: expect.objectContaining({ reviewDecisionId: saved.json().id, decision: "BLOCK" })
        })
      ])
    );

    const latestEvent = await app.inject({
      method: "GET",
      url: `/api/events?roomId=${encodeURIComponent(roomId)}&pageSize=1&sortOrder=desc`,
      headers: { cookie }
    });
    expect(latestEvent.statusCode).toBe(200);
    expect(latestEvent.json()).toMatchObject({
      data: [expect.objectContaining({ type: "REVIEW_DECISION_CREATED" })],
      pagination: expect.objectContaining({ page: 1, pageSize: 1, totalItems: expect.any(Number) })
    });

    const auditResponse = await app.inject({
      method: "GET",
      url: "/api/admin/audit?pageSize=10",
      headers: { cookie }
    });
    expect(auditResponse.statusCode).toBe(200);
    expect(JSON.stringify(auditResponse.json())).not.toContain("raw-test-value");
    expect(auditResponse.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "review.decision.create",
          targetId: saved.json().id,
          metadata: expect.objectContaining({ roomId, decision: "BLOCK", evidenceArtifactCount: 1 })
        })
      ])
    );
  });

  it("records review checks, diffs and aggregate room state", async () => {
    const { app, cookie, csrfToken } = await authedApp();
    const fakeToken = "to" + "ken=raw-test-value";
    const roomResponse = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { name: "Review Aggregation", initialPaneCount: 0 }
    });
    const roomId = roomResponse.json().id as string;

    const decision = await app.inject({
      method: "POST",
      url: "/api/reviews",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        roomId,
        decision: "NEEDS_HUMAN",
        summary: "Review aggregation pending.",
        evidenceArtifactIds: [],
        rollbackNote: ""
      }
    });
    expect(decision.statusCode).toBe(200);

    const check = await app.inject({
      method: "POST",
      url: "/api/review-checks",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        roomId,
        reviewDecisionId: decision.json().id,
        name: "npm test",
        status: "PASS",
        command: `npm test ${fakeToken}`,
        summary: `All tests passed. ${fakeToken}`,
        artifactIds: ["artifact:test-1", "artifact:test-1"],
        metadata: { suite: "unit", token: fakeToken }
      }
    });
    expect(check.statusCode).toBe(200);
    expect(check.json()).toMatchObject({ roomId, reviewDecisionId: decision.json().id, status: "PASS", artifactIds: ["artifact:test-1"] });
    expect(JSON.stringify(check.json())).not.toContain("raw-test-value");

    const diff = await app.inject({
      method: "POST",
      url: "/api/review-diffs",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        roomId,
        reviewDecisionId: decision.json().id,
        title: `Review UI ${fakeToken}`,
        filePath: "apps/web/src/App.tsx",
        status: "MODIFIED",
        additions: 12,
        deletions: 2,
        patchArtifactId: null,
        summary: `Adds aggregation ${fakeToken}.`
      }
    });
    expect(diff.statusCode).toBe(200);
    expect(diff.json()).toMatchObject({ roomId, reviewDecisionId: decision.json().id, status: "MODIFIED", additions: 12, deletions: 2 });
    expect(JSON.stringify(diff.json())).not.toContain("raw-test-value");

    const state = await app.inject({
      method: "GET",
      url: `/api/reviews/state?roomId=${encodeURIComponent(roomId)}`,
      headers: { cookie }
    });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({
      gateStatus: "PASS",
      decisions: [expect.objectContaining({ id: decision.json().id })],
      checks: [expect.objectContaining({ id: check.json().id, status: "PASS" })],
      diffs: [expect.objectContaining({ id: diff.json().id, status: "MODIFIED" })]
    });

    const events = await app.inject({
      method: "GET",
      url: `/api/events?roomId=${encodeURIComponent(roomId)}`,
      headers: { cookie }
    });
    expect(events.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "REVIEW_CHECK_RECORDED", payload: expect.objectContaining({ reviewCheckId: check.json().id }) }),
        expect.objectContaining({ type: "REVIEW_DIFF_RECORDED", payload: expect.objectContaining({ reviewDiffId: diff.json().id }) })
      ])
    );

    const auditResponse = await app.inject({
      method: "GET",
      url: "/api/admin/audit?pageSize=20",
      headers: { cookie }
    });
    expect(JSON.stringify(auditResponse.json())).not.toContain("raw-test-value");
    expect(auditResponse.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "review.check.create", targetId: check.json().id }),
        expect.objectContaining({ action: "review.diff.create", targetId: diff.json().id })
      ])
    );
  });

  it("registers artifacts as room-scoped evidence metadata", async () => {
    const { app, cookie, csrfToken } = await authedApp();
    const fakeSensitive = "to" + "ken=raw-test-value";
    const roomResponse = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { name: "Evidence Room", initialPaneCount: 0 }
    });
    const roomId = roomResponse.json().id as string;

    const saved = await app.inject({
      method: "POST",
      url: "/api/artifacts",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        roomId,
        workflowId: "workflow:test-1",
        kind: "SCREENSHOT",
        mimeType: "image/png",
        storageUri: `cas://sha256/${"a".repeat(64)}?${fakeSensitive}`,
        sha256: "a".repeat(64),
        byteSize: 2048,
        metadata: { viewport: "1440x900", ["sec" + "ret"]: fakeSensitive }
      }
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      roomId,
      workflowId: "workflow:test-1",
      kind: "SCREENSHOT",
      sha256: "a".repeat(64),
      byteSize: 2048
    });
    expect(saved.json().id).toMatch(/^artifact:/);
    expect(JSON.stringify(saved.json())).not.toContain("raw-test-value");
    expect(JSON.stringify(saved.json())).toContain("[REDACTED]");

    const list = await app.inject({
      method: "GET",
      url: `/api/artifacts?roomId=${encodeURIComponent(roomId)}&kind=SCREENSHOT`,
      headers: { cookie }
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      data: [expect.objectContaining({ id: saved.json().id, kind: "SCREENSHOT" })],
      pagination: expect.objectContaining({ totalItems: 1 })
    });

    const events = await app.inject({
      method: "GET",
      url: `/api/events?roomId=${encodeURIComponent(roomId)}`,
      headers: { cookie }
    });
    expect(events.statusCode).toBe(200);
    expect(events.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "ARTIFACT_CREATED",
          payload: expect.objectContaining({ artifactId: saved.json().id, kind: "SCREENSHOT" })
        })
      ])
    );

    const auditResponse = await app.inject({
      method: "GET",
      url: "/api/admin/audit?pageSize=10",
      headers: { cookie }
    });
    expect(auditResponse.statusCode).toBe(200);
    expect(JSON.stringify(auditResponse.json())).not.toContain("raw-test-value");
    expect(auditResponse.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "artifact.create",
          targetId: saved.json().id,
          metadata: expect.objectContaining({ roomId, kind: "SCREENSHOT", byteSize: 2048 })
        })
      ])
    );
  });

  it("uploads clipboard/user images as room artifacts with auth and CSRF protection", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "space-api-upload-artifacts-"));
    const { app, cookie, csrfToken } = await authedApp({
      config: getApiConfig({ SPACE_ARTIFACT_ROOT: artifactRoot })
    });
    const roomResponse = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { name: "Upload Room", initialPaneCount: 0 }
    });
    const roomId = roomResponse.json().id as string;
    const multipart = multipartImagePayload([{ filename: "clipboard.png", body: pngImage }]);

    const unauthenticated = await app.inject({
      method: "POST",
      url: `/api/artifacts/uploads?roomId=${encodeURIComponent(roomId)}&source=CLIPBOARD`,
      headers: { "content-type": multipart.contentType },
      payload: multipart.payload
    });
    expect(unauthenticated.statusCode).toBe(401);

    const rejected = await app.inject({
      method: "POST",
      url: `/api/artifacts/uploads?roomId=${encodeURIComponent(roomId)}&source=CLIPBOARD`,
      headers: { cookie, "content-type": multipart.contentType },
      payload: multipart.payload
    });
    expect(rejected.statusCode).toBe(403);

    const acceptedMultipart = multipartImagePayload([{ filename: "clipboard.png", body: pngImage }]);
    const accepted = await app.inject({
      method: "POST",
      url: `/api/artifacts/uploads?roomId=${encodeURIComponent(roomId)}&source=CLIPBOARD`,
      headers: { cookie, [csrfHeaderName]: csrfToken, "content-type": acceptedMultipart.contentType },
      payload: acceptedMultipart.payload
    });

    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().artifacts).toEqual([
      expect.objectContaining({
        roomId,
        kind: "IMAGE",
        mimeType: "image/png",
        storageUri: expect.stringMatching(/^space-artifact:\/\/user-uploads\//),
        sha256: createHash("sha256").update(pngImage).digest("hex"),
        byteSize: pngImage.byteLength,
        metadata: expect.objectContaining({ source: "CLIPBOARD", originalFilename: "clipboard.png" })
      })
    ]);

    const list = await app.inject({
      method: "GET",
      url: `/api/artifacts?roomId=${encodeURIComponent(roomId)}&kind=IMAGE`,
      headers: { cookie }
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().pagination.totalItems).toBe(1);
  });

  it("stores a Live session recording as a VIDEO Media artifact with source LIVE_RECORDING", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "space-api-live-recording-"));
    const { app, cookie, csrfToken } = await authedApp({
      config: getApiConfig({ SPACE_ARTIFACT_ROOT: artifactRoot })
    });
    const roomResponse = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { name: "Live Room", initialPaneCount: 0 }
    });
    const roomId = roomResponse.json().id as string;
    const recording = multipartImagePayload([{ filename: "live-2026-10-21T10-00-00-000Z.webm", mimeType: "video/webm", body: Buffer.from("webm", "utf8") }]);
    const recorded = await app.inject({
      method: "POST",
      url: `/api/artifacts/file-uploads?roomId=${encodeURIComponent(roomId)}&source=LIVE_RECORDING`,
      headers: { cookie, [csrfHeaderName]: csrfToken, "content-type": recording.contentType },
      payload: recording.payload
    });
    expect(recorded.statusCode).toBe(200);
    expect(recorded.json().artifacts[0]).toMatchObject({ roomId, kind: "VIDEO", mimeType: "video/webm", metadata: { source: "LIVE_RECORDING" } });
  });

  it("serves and permanently deletes local artifact files", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "space-api-media-artifacts-"));
    const { app, cookie, csrfToken } = await authedApp({
      config: getApiConfig({ SPACE_ARTIFACT_ROOT: artifactRoot })
    });
    const roomResponse = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { name: "Media Room", initialPaneCount: 0 }
    });
    const roomId = roomResponse.json().id as string;
    const body = Buffer.from("hello media", "utf8");
    const multipart = multipartImagePayload([{ filename: "note.txt", mimeType: "text/plain", body }]);
    const uploaded = await app.inject({
      method: "POST",
      url: `/api/artifacts/file-uploads?roomId=${encodeURIComponent(roomId)}&source=USER_UPLOAD`,
      headers: { cookie, [csrfHeaderName]: csrfToken, "content-type": multipart.contentType },
      payload: multipart.payload
    });
    expect(uploaded.statusCode).toBe(200);
    const artifact = uploaded.json().artifacts[0];

    const file = await app.inject({
      method: "GET",
      url: `/api/artifacts/${encodeURIComponent(artifact.id)}/file`,
      headers: { cookie }
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toContain("text/plain");
    expect(file.headers["content-disposition"]).toContain("attachment");
    expect(file.body).toBe("hello media");

    const missingRetentionCsrf = await app.inject({
      method: "PATCH",
      url: `/api/artifacts/${encodeURIComponent(artifact.id)}/retention`,
      headers: { cookie },
      payload: { pinnedAt: "2026-07-11T12:00:00.000Z" }
    });
    expect(missingRetentionCsrf.statusCode).toBe(403);

    const pinned = await app.inject({
      method: "PATCH",
      url: `/api/artifacts/${encodeURIComponent(artifact.id)}/retention`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { pinnedAt: "2026-07-11T12:00:00.000Z" }
    });
    expect(pinned.statusCode).toBe(200);
    expect(pinned.json().pinnedAt).toBe("2026-07-11T12:00:00.000Z");

    const unpinned = await app.inject({
      method: "PATCH",
      url: `/api/artifacts/${encodeURIComponent(artifact.id)}/retention`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { pinnedAt: null, expiresAt: "2026-07-18T12:00:00.000Z" }
    });
    expect(unpinned.statusCode).toBe(200);
    expect(unpinned.json()).toEqual(expect.objectContaining({ pinnedAt: null, expiresAt: "2026-07-18T12:00:00.000Z" }));

    const missingCsrf = await app.inject({
      method: "DELETE",
      url: `/api/artifacts/${encodeURIComponent(artifact.id)}`,
      headers: { cookie }
    });
    expect(missingCsrf.statusCode).toBe(403);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/artifacts/${encodeURIComponent(artifact.id)}`,
      headers: { cookie, [csrfHeaderName]: csrfToken }
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true, artifactId: artifact.id });

    const list = await app.inject({
      method: "GET",
      url: `/api/artifacts?roomId=${encodeURIComponent(roomId)}`,
      headers: { cookie }
    });
    expect(list.json().pagination.totalItems).toBe(0);
    const missingFile = await app.inject({
      method: "GET",
      url: `/api/artifacts/${encodeURIComponent(artifact.id)}/file`,
      headers: { cookie }
    });
    expect(missingFile.statusCode).toBe(404);

    const auditResponse = await app.inject({
      method: "GET",
      url: "/api/admin/audit?pageSize=10",
      headers: { cookie }
    });
    expect(auditResponse.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "artifact.delete",
          targetId: artifact.id,
          metadata: expect.objectContaining({ roomId, kind: "EXPORT" })
        }),
        expect.objectContaining({
          action: "artifact.retention.update",
          targetId: artifact.id
        })
      ])
    );
  });

  it("deletes every media artifact in one room while preserving non-media and reporting partial failures", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "space-api-clear-room-media-"));
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Clear Media Room", initialPaneCount: 0 });
    const otherRoom = store.createRoom({ name: "Other Room", initialPaneCount: 0 });
    const emptyRoom = store.createRoom({ name: "Empty Room", initialPaneCount: 0 });
    const roomSegment = room.id.replace(/[^a-zA-Z0-9._-]/g, "_");
    const otherRoomSegment = otherRoom.id.replace(/[^a-zA-Z0-9._-]/g, "_");
    const day = "2026-07-17";
    const userFile = join(artifactRoot, "user-uploads", roomSegment, day, "image.png");
    const cliFile = join(artifactRoot, "cli-uploads", roomSegment, "pane_test", "session_test", day, "note.txt");
    const screenshotFile = join(artifactRoot, "browser-evidence", "capture-media", "screenshot.png");
    const domFile = join(artifactRoot, "browser-evidence", "capture-dom", "dom.json");
    const otherFile = join(artifactRoot, "user-uploads", otherRoomSegment, day, "other.png");
    for (const filePath of [userFile, cliFile, screenshotFile, domFile, otherFile]) {
      await mkdir(join(filePath, ".."), { recursive: true });
      await writeFile(filePath, "artifact");
    }
    const userArtifact = store.createArtifact({
      roomId: room.id,
      kind: "IMAGE",
      mimeType: "image/png",
      storageUri: `space-artifact://user-uploads/${encodeURIComponent(room.id)}/${day}/image.png`,
      sha256: "a".repeat(64),
      byteSize: 8,
      metadata: {},
      pinnedAt: "2026-07-18T00:00:00.000Z"
    }).artifact;
    const cliArtifact = store.createArtifact({
      roomId: room.id,
      kind: "EXPORT",
      mimeType: "text/plain",
      storageUri: `space-artifact://cli-uploads/${encodeURIComponent(room.id)}/pane%3Atest/session%3Atest/${day}/note.txt`,
      sha256: "b".repeat(64),
      byteSize: 8,
      metadata: {}
    }).artifact;
    const screenshotArtifact = store.createArtifact({
      roomId: room.id,
      kind: "SCREENSHOT",
      mimeType: "image/png",
      storageUri: "space-artifact://browser-evidence/capture-media/screenshot.png",
      sha256: "c".repeat(64),
      byteSize: 8,
      metadata: {}
    }).artifact;
    const failedArtifact = store.createArtifact({
      roomId: room.id,
      kind: "IMAGE",
      mimeType: "image/png",
      storageUri: "space-artifact://user-uploads/unsupported.png",
      sha256: "d".repeat(64),
      byteSize: 8,
      metadata: {}
    }).artifact;
    const domArtifact = store.createArtifact({
      roomId: room.id,
      kind: "DOM_SNAPSHOT",
      mimeType: "application/json",
      storageUri: "space-artifact://browser-evidence/capture-dom/dom.json",
      sha256: "e".repeat(64),
      byteSize: 8,
      metadata: {}
    }).artifact;
    const otherArtifact = store.createArtifact({
      roomId: otherRoom.id,
      kind: "IMAGE",
      mimeType: "image/png",
      storageUri: `space-artifact://user-uploads/${encodeURIComponent(otherRoom.id)}/${day}/other.png`,
      sha256: "f".repeat(64),
      byteSize: 8,
      metadata: {}
    }).artifact;
    const { app, cookie, csrfToken } = await authedApp({
      store,
      config: getApiConfig({ SPACE_ARTIFACT_ROOT: artifactRoot })
    });

    const rejected = await app.inject({
      method: "DELETE",
      url: `/api/rooms/${encodeURIComponent(room.id)}/media`,
      headers: { cookie }
    });
    expect(rejected.statusCode).toBe(403);

    const cleared = await app.inject({
      method: "DELETE",
      url: `/api/rooms/${encodeURIComponent(room.id)}/media`,
      headers: { cookie, [csrfHeaderName]: csrfToken }
    });

    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({
      ok: false,
      roomId: room.id,
      matchedCount: 4,
      deletedCount: 3,
      failedCount: 1,
      failedArtifactIds: [failedArtifact.id]
    });
    expect(store.listArtifacts({ roomId: room.id }).map((artifact) => artifact.id)).toEqual(
      expect.arrayContaining([failedArtifact.id, domArtifact.id])
    );
    expect(store.listArtifacts({ roomId: room.id }).map((artifact) => artifact.id)).not.toEqual(
      expect.arrayContaining([userArtifact.id, cliArtifact.id, screenshotArtifact.id])
    );
    expect(store.listArtifacts({ roomId: otherRoom.id }).map((artifact) => artifact.id)).toContain(otherArtifact.id);
    for (const filePath of [userFile, cliFile, screenshotFile]) {
      await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(readFile(domFile, "utf8")).resolves.toBe("artifact");
    await expect(readFile(otherFile, "utf8")).resolves.toBe("artifact");

    const auditResponse = await app.inject({
      method: "GET",
      url: "/api/admin/audit?pageSize=20",
      headers: { cookie }
    });
    expect(auditResponse.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "room.media.clear",
          targetId: room.id,
          metadata: expect.objectContaining({ matchedCount: 4, deletedCount: 3, failedCount: 1 })
        })
      ])
    );

    const emptyResult = await app.inject({
      method: "DELETE",
      url: `/api/rooms/${encodeURIComponent(emptyRoom.id)}/media`,
      headers: { cookie, [csrfHeaderName]: csrfToken }
    });
    expect(emptyResult.statusCode).toBe(200);
    expect(emptyResult.json()).toEqual({
      ok: true,
      roomId: emptyRoom.id,
      matchedCount: 0,
      deletedCount: 0,
      failedCount: 0,
      failedArtifactIds: []
    });
  });

  it("soft-deletes expired browser artifacts, removes local files, and preserves pinned artifacts", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "space-api-browser-retention-"));
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Retention Room", initialPaneCount: 0 });
    const captureDir = join(artifactRoot, "browser-evidence", "capture_expired");
    await mkdir(captureDir, { recursive: true });
    const expiredPath = join(captureDir, "expired.png");
    const pinnedPath = join(captureDir, "pinned.png");
    await writeFile(expiredPath, pngImage);
    await writeFile(pinnedPath, pngImage);
    const sha256 = createHash("sha256").update(pngImage).digest("hex");
    const expired = store.createArtifact({
      roomId: room.id,
      kind: "SCREENSHOT",
      mimeType: "image/png",
      storageUri: "space-artifact://browser-evidence/capture_expired/expired.png",
      sha256,
      byteSize: pngImage.byteLength,
      metadata: {},
      expiresAt: "2026-07-10T00:00:00.000Z"
    }).artifact;
    const pinned = store.createArtifact({
      roomId: room.id,
      kind: "SCREENSHOT",
      mimeType: "image/png",
      storageUri: "space-artifact://browser-evidence/capture_expired/pinned.png",
      sha256,
      byteSize: pngImage.byteLength,
      metadata: {},
      expiresAt: "2026-07-10T00:00:00.000Z",
      pinnedAt: "2026-07-09T00:00:00.000Z"
    }).artifact;

    const result = await sweepExpiredBrowserArtifacts({
      store,
      artifactRoot,
      at: "2026-07-11T00:00:00.000Z"
    });

    expect(result).toEqual({ softDeleted: 1, filesRemoved: 1, fileErrors: [] });
    expect(store.getArtifact(expired.id).deletedAt).toBe("2026-07-11T00:00:00.000Z");
    expect(store.getArtifact(pinned.id).deletedAt).toBeNull();
    await expect(readFile(expiredPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(pinnedPath)).resolves.toEqual(pngImage);
  });

  it("accepts larger MP4 uploads for room artifacts and stores them as VIDEO", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "space-api-video-artifacts-"));
    try {
      const { app, cookie, csrfToken } = await authedApp({
        config: getApiConfig({ SPACE_ARTIFACT_ROOT: artifactRoot })
      });
      const roomResponse = await app.inject({
        method: "POST",
        url: "/api/rooms",
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { name: "Video Room", initialPaneCount: 0 }
      });
      const roomId = roomResponse.json().id as string;
      const body = Buffer.alloc(11 * 1024 * 1024, 7);
      const multipart = multipartImagePayload([{ filename: "capture.mp4", mimeType: "video/mp4", body }]);

      const uploaded = await app.inject({
        method: "POST",
        url: `/api/artifacts/file-uploads?roomId=${encodeURIComponent(roomId)}&source=USER_UPLOAD`,
        headers: { cookie, [csrfHeaderName]: csrfToken, "content-type": multipart.contentType },
        payload: multipart.payload
      });

      expect(uploaded.statusCode).toBe(200);
      expect(uploaded.json().artifacts[0]).toMatchObject({
        kind: "VIDEO",
        mimeType: "video/mp4",
        byteSize: body.byteLength,
        metadata: expect.objectContaining({
          originalFilename: "capture.mp4",
          declaredMimeType: "video/mp4",
          resolvedMimeType: "video/mp4"
        })
      });

      const artifactId = uploaded.json().artifacts[0]?.id as string;
      const file = await app.inject({
        method: "GET",
        url: `/api/artifacts/${encodeURIComponent(artifactId)}/file`,
        headers: { cookie }
      });
      expect(file.statusCode).toBe(200);
      expect(file.headers["content-type"]).toContain("video/mp4");
      expect(Number(file.headers["content-length"])).toBe(body.byteLength);
    } finally {
      // The upload is 11 MB; a leftover folder per run filled the CLI temp dirs (47 of them, 0.5 GB on 2026-10-21).
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("fails closed for non-local artifact file access and deletion", async () => {
    const { app, cookie, csrfToken } = await authedApp();
    const roomResponse = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { name: "Remote Artifact Room", initialPaneCount: 0 }
    });
    const roomId = roomResponse.json().id as string;
    const saved = await app.inject({
      method: "POST",
      url: "/api/artifacts",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        roomId,
        kind: "EXPORT",
        mimeType: "text/plain",
        storageUri: `cas://sha256/${"f".repeat(64)}`,
        sha256: "f".repeat(64),
        byteSize: 12,
        metadata: { source: "operator" }
      }
    });
    expect(saved.statusCode).toBe(200);
    const artifactId = saved.json().id as string;

    const file = await app.inject({
      method: "GET",
      url: `/api/artifacts/${encodeURIComponent(artifactId)}/file`,
      headers: { cookie }
    });
    expect(file.statusCode).toBe(409);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/artifacts/${encodeURIComponent(artifactId)}`,
      headers: { cookie, [csrfHeaderName]: csrfToken }
    });
    expect(deleted.statusCode).toBe(409);

    const list = await app.inject({
      method: "GET",
      url: `/api/artifacts?roomId=${encodeURIComponent(roomId)}`,
      headers: { cookie }
    });
    expect(list.json().pagination.totalItems).toBe(1);
  });

  it("rejects unsupported image uploads and more than 8 images per request", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "space-api-upload-rejects-"));
    const { app, cookie, csrfToken } = await authedApp({
      config: getApiConfig({ SPACE_ARTIFACT_ROOT: artifactRoot })
    });
    const roomResponse = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { name: "Upload Rejects", initialPaneCount: 0 }
    });
    const roomId = roomResponse.json().id as string;
    const textMultipart = multipartImagePayload([
      { filename: "note.txt", mimeType: "text/plain", body: Buffer.from("not an image") }
    ]);

    const unsupported = await app.inject({
      method: "POST",
      url: `/api/artifacts/uploads?roomId=${encodeURIComponent(roomId)}`,
      headers: { cookie, [csrfHeaderName]: csrfToken, "content-type": textMultipart.contentType },
      payload: textMultipart.payload
    });
    expect(unsupported.statusCode).toBe(422);
    expect(unsupported.json().error.code).toBe("UNSUPPORTED_MEDIA_TYPE");

    const tooManyMultipart = multipartImagePayload(Array.from({ length: 9 }, (_, index) => ({ filename: `image-${index}.png` })));
    const tooMany = await app.inject({
      method: "POST",
      url: `/api/artifacts/uploads?roomId=${encodeURIComponent(roomId)}`,
      headers: { cookie, [csrfHeaderName]: csrfToken, "content-type": tooManyMultipart.contentType },
      payload: tooManyMultipart.payload
    });
    expect(tooMany.statusCode).toBe(422);
    expect(tooMany.json().error.code).toBe("UPLOAD_LIMIT_EXCEEDED");
  });

  it("links image artifacts to turns and rejects wrong-room or non-image artifacts", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Turn Attachments", initialPaneCount: 1 }, "req:turn-room");
    const pane = store.listPanes(room.id)[0]!;
    const otherRoom = store.createRoom({ name: "Other Room", initialPaneCount: 0 }, "req:other-room");
    const imageArtifact = store.createArtifact({
      roomId: room.id,
      paneId: pane.id,
      kind: "IMAGE",
      mimeType: "image/png",
      storageUri: "space-artifact://user-uploads/turn/image.png",
      sha256: "a".repeat(64),
      byteSize: pngImage.byteLength,
      metadata: { source: "USER_UPLOAD" }
    }).artifact;
    const nonImageArtifact = store.createArtifact({
      roomId: room.id,
      kind: "DOM_SNAPSHOT",
      mimeType: "application/json",
      storageUri: "space-artifact://browser-evidence/dom.json",
      sha256: "b".repeat(64),
      byteSize: 128,
      metadata: {}
    }).artifact;
    const wrongRoomArtifact = store.createArtifact({
      roomId: otherRoom.id,
      kind: "IMAGE",
      mimeType: "image/png",
      storageUri: "space-artifact://user-uploads/other/image.png",
      sha256: "c".repeat(64),
      byteSize: pngImage.byteLength,
      metadata: { source: "USER_UPLOAD" }
    }).artifact;
    const { app, cookie, csrfToken } = await authedApp({ store, turnStarter: immediateTurnStarter });

    const wrongRoom = await app.inject({
      method: "POST",
      url: "/api/turns",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        roomId: room.id,
        paneId: pane.id,
        prompt: "describe",
        artifactIds: [wrongRoomArtifact.id]
      }
    });
    expect(wrongRoom.statusCode).toBe(404);

    const nonImage = await app.inject({
      method: "POST",
      url: "/api/turns",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        roomId: room.id,
        paneId: pane.id,
        prompt: "describe",
        artifactIds: [nonImageArtifact.id]
      }
    });
    expect(nonImage.statusCode).toBe(409);

    const queued = await app.inject({
      method: "POST",
      url: "/api/turns",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        roomId: room.id,
        paneId: pane.id,
        prompt: "describe",
        artifactIds: [imageArtifact.id]
      }
    });
    expect(queued.statusCode).toBe(200);
    expect(queued.json()).toMatchObject({ status: "QUEUED", artifactIds: [imageArtifact.id] });
    expect(store.listTurns(room.id)[0]).toMatchObject({ artifactIds: [imageArtifact.id] });
    expect(store.listArtifacts({ roomId: room.id }).find((artifact) => artifact.id === imageArtifact.id)).toMatchObject({
      turnId: queued.json().turnId,
      workflowId: queued.json().workflowId
    });
  });

  it("fails closed when Codex App Server turns include images without a verified vision model", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Vision Gate", initialPaneCount: 0 }, "req:vision-room");
    const pane = store.createPane(
      { roomId: room.id, title: "Text-only Codex", mode: "CHAT", providerId: "codex-lb", modelId: "gpt-text-only" },
      "req:vision-pane"
    );
    store.replaceProviderModels("codex-lb", [
      {
        id: "gpt-text-only",
        providerId: "codex-lb",
        displayName: "gpt-text-only",
        status: "VERIFIED",
        contextWindow: 128000,
        supportsTools: true,
        supportsVision: false,
        supportsRealtime: false,
        supportsReasoning: true,
        defaultReasoningEffort: "medium"
      }
    ]);
    const imageArtifact = store.createArtifact({
      roomId: room.id,
      paneId: pane.id,
      kind: "IMAGE",
      mimeType: "image/png",
      storageUri: "space-artifact://user-uploads/vision/image.png",
      sha256: "d".repeat(64),
      byteSize: pngImage.byteLength,
      metadata: { source: "USER_UPLOAD" }
    }).artifact;
    const { app, cookie, csrfToken } = await authedApp({ store, codexTurnStarter: immediateTurnStarter });

    const response = await app.inject({
      method: "POST",
      url: "/api/turns",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        roomId: room.id,
        paneId: pane.id,
        prompt: "describe",
        runtime: "CODEX_APP_SERVER",
        artifactIds: [imageArtifact.id]
      }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatchObject({
      code: "VISION_MODEL_REQUIRED",
      message: "Image attachments require a verified vision-capable model on the selected pane."
    });
    expect(store.listTurns(room.id)).toEqual([]);
  });

  it("keeps managed browser sessions disabled until the explicit gate is enabled", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Browser Room", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Browser 1", mode: "BROWSER" });
    const { app, cookie, csrfToken } = await authedApp({ store, config: getApiConfig({}) });

    const status = await app.inject({ method: "GET", url: "/api/browser/status", headers: { cookie } });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      enabled: false,
      statusReason: expect.stringContaining("SPACE_BROWSER_SESSIONS_ENABLED")
    });

    const denied = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/browser/session`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { viewport: "desktop", targetUrl: "https://www.google.com/" }
    });

    expect(denied.statusCode).toBe(503);
    expect(denied.json()).toMatchObject({
      error: {
        code: "BROWSER_SESSIONS_DISABLED",
        message: expect.stringContaining("SPACE_BROWSER_SESSIONS_ENABLED")
      }
    });
  });

  it("keeps managed browser sessions fail-closed when Chrome is not executable", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Browser Room", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Browser 1", mode: "BROWSER" });
    const { app, cookie, csrfToken } = await authedApp({
      store,
      config: getApiConfig({
        SPACE_BROWSER_SESSIONS_ENABLED: "true",
        SPACE_BROWSER_SESSIONS_CHROME_PATH: "/opt/spaceapp/bin/not-google-chrome"
      })
    });

    const status = await app.inject({ method: "GET", url: "/api/browser/status", headers: { cookie } });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      enabled: false,
      statusReason: expect.stringContaining("not executable")
    });

    const denied = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/browser/session`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { viewport: "desktop", targetUrl: "https://www.google.com/" }
    });

    expect(denied.statusCode).toBe(503);
    expect(denied.json()).toMatchObject({
      error: {
        code: "BROWSER_CHROME_UNAVAILABLE",
        message: expect.stringContaining("not executable")
      }
    });
  });

  it("persists YouTube playback through close/reopen and guards the playback endpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "youtube-api-"));
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "YouTube restore", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "YouTube", mode: "YOUTUBE" });
    const { app, cookie, csrfToken } = await authedApp({ store, config: getApiConfig({ SPACE_ARTIFACT_ROOT: join(root, "artifacts") }), browserSessionManager: fakeBrowserSessionManager() });
    const url = `/api/panes/${encodeURIComponent(pane.id)}/youtube/playback`;
    const playback = { videoId: "abcdefghijk", playlistId: null, index: 0, seconds: 123.5, title: "Test", updatedAt: Date.now() };
    const headers = { cookie, [csrfHeaderName]: csrfToken };
    try {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
      expect((await app.inject({ method: "PUT", url, headers: { cookie }, payload: playback })).statusCode).toBe(403);
      expect((await app.inject({ method: "PUT", url, headers, payload: playback })).statusCode).toBe(200);
      expect((await app.inject({ method: "DELETE", url: `/api/panes/${encodeURIComponent(pane.id)}`, headers })).statusCode).toBe(200);
      // The final iframe checkpoint can arrive just after the close request.
      expect((await app.inject({ method: "PUT", url, headers, payload: { ...playback, seconds: 124.8, updatedAt: Date.now() } })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url, headers })).json().playback.seconds).toBe(124.8);
      expect((await app.inject({ method: "PUT", url, headers, payload: { ...playback, cookies: "blocked" } })).statusCode).toBe(422);
    } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("summarizes or transcribes the pane's video with the user's chosen model and guards the endpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "youtube-summary-api-"));
    const keyFile = join(root, "gateway.key");
    await writeFile(keyFile, "sk-sgw-test");
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "YouTube summary", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "YouTube", mode: "YOUTUBE" });
    const chat = store.createPane({ roomId: room.id, title: "Chat", mode: "CHAT" });
    const { app, cookie, csrfToken } = await authedApp({ store, config: getApiConfig({ SPACE_ARTIFACT_ROOT: join(root, "artifacts"), SPACE_GATEWAY_KEY_FILE: keyFile }),
      browserSessionManager: fakeBrowserSessionManager(), videoEngine: async () => ({ path: null }) });
    const headers = { cookie, [csrfHeaderName]: csrfToken };
    const realFetch = globalThis.fetch;
    const gateway = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => String(input).endsWith("/gemini/v1/generate")
      ? new Response(JSON.stringify({ text: "Words." }), { headers: { "content-type": "application/json" } }) : realFetch(input, init));
    const summary = (id: string, payload: unknown) => app.inject({ method: "POST", url: `/api/panes/${encodeURIComponent(id)}/youtube/summary`, headers, payload });
    try {
      expect((await app.inject({ method: "PATCH", url: "/api/user-settings", headers, payload: { youtubeSummaryModel: "gemini-3.5-flash-lite" } })).statusCode).toBe(200);
      expect((await summary(pane.id, { videoId: "jNQXAC9IVRw", kind: "transcript" })).json()).toEqual({ text: "Words.", model: "gemini-3.5-flash-lite" });
      const sent = gateway.mock.calls.find(([input]) => String(input).endsWith("/gemini/v1/generate"));
      expect(JSON.parse(String(sent?.[1]?.body))).toMatchObject({ model: "gemini-3.5-flash-lite", videoUrl: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
        prompt: expect.stringMatching(/^Transcribe/) });
      expect((await summary(pane.id, { videoId: "jNQXAC9IVRw", kind: "translate" })).statusCode).toBe(422);
      expect((await summary(pane.id, { videoId: "https://evil.example/x" })).statusCode).toBe(422);
      expect((await summary(chat.id, { videoId: "jNQXAC9IVRw" })).statusCode).toBe(409);
      expect((await app.inject({ method: "POST", url: `/api/panes/${encodeURIComponent(pane.id)}/youtube/summary`, payload: { videoId: "jNQXAC9IVRw" } })).statusCode).toBe(401);
    } finally { gateway.mockRestore(); await app.close(); await rm(root, { recursive: true, force: true }); }
  });

  it.each([["YOUTUBE", "youtube"], ["BROWSER", "browser"]] as const)("selects existing Google accounts for %s without exposing credentials or restarting a CLI", async (mode, surface) => {
    const root = await mkdtemp(join(tmpdir(), "youtube-account-api-"));
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "YouTube accounts", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Google accounts", mode });
    await store.createCliAccountProfile("cli:gemini", { runtimeId: "cli:gemini", profileId: "test-google-a", displayName: "Google A" }, "user:admin");
    await store.createCliAccountProfile("cli:gemini", { runtimeId: "cli:gemini", profileId: "test-google-b", displayName: "Google B" }, "user:admin");
    const manager = fakeBrowserSessionManager();
    const stop = vi.spyOn(manager, "stopPane");
    const start = vi.spyOn(manager, "startOrRestore");
    const details = vi.fn().mockResolvedValue({ authStatus: "CONNECTED", email: "test.account@example.com" });
    const { app, cookie, csrfToken } = await authedApp({ store, config: getApiConfig({ SPACE_ARTIFACT_ROOT: join(root, "artifacts") }), browserSessionManager: manager, readGeminiAccountProfileDetails: details });
    const path = `/api/panes/${encodeURIComponent(pane.id)}`;
    const url = path + `/${surface}/accounts`;
    const headers = { cookie, [csrfHeaderName]: csrfToken };
    try {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
      expect((await app.inject({ method: "PUT", url, headers: { cookie }, payload: { profileId: "test-google-a" } })).statusCode).toBe(403);
      const list = (await app.inject({ method: "GET", url, headers })).json();
      // Gemini account profiles are labelled as such next to Google accounts (de9f80ff27).
      expect(list).toMatchObject({ selectedProfileId: null, profiles: expect.arrayContaining([expect.objectContaining({ profileId: "test-google-a", displayName: "Gemini account · Google A" })]) });
      // The account menu shows each account's email and sign-in state (5e8227a644); credentials never leave the API.
      expect(list.profiles.map((profile: { email?: string }) => profile.email)).toEqual(["test.account@example.com", "test.account@example.com"]);
      expect(JSON.stringify(list)).not.toMatch(/cookie|token|password|secret|profilePath/i);
      expect((await app.inject({ method: "PUT", url, headers, payload: { profileId: "missing-account" } })).statusCode).toBe(404);
      expect((await app.inject({ method: "PUT", url, headers, payload: { profileId: "test-google-a", profilePath: "/outside" } })).statusCode).toBe(422);
      const chosen = await app.inject({ method: "PUT", url, headers, payload: { profileId: "test-google-a" } });
      expect(chosen.statusCode).toBe(200);
      expect(new URL(chosen.json().targetUrl).searchParams.get("Email")).toBe("test.account@example.com");
      expect(stop).toHaveBeenCalledTimes(1);
      expect(start).not.toHaveBeenCalled();
      const startUrl = path + "/browser/session";
      expect((await app.inject({ method: "POST", url: startUrl, headers, payload: {} })).statusCode).toBe(200);
      const accountA = start.mock.calls.at(-1)?.[0].profileKey;
      expect(accountA).toMatch(/^[a-f0-9]{64}$/);
      await app.inject({ method: "PUT", url, headers, payload: { profileId: "test-google-b" } });
      await app.inject({ method: "POST", url: startUrl, headers, payload: {} });
      expect(start.mock.calls.at(-1)?.[0].profileKey).not.toBe(accountA);
      await app.inject({ method: "PUT", url, headers, payload: { profileId: "test-google-a" } });
      await app.inject({ method: "POST", url: startUrl, headers, payload: {} });
      expect(start.mock.calls.at(-1)?.[0].profileKey).toBe(accountA);
      expect((await app.inject({ method: "GET", url, headers })).json().selectedProfileId).toBe("test-google-a");
      await app.inject({ method: "PUT", url, headers, payload: { profileId: null } });
      await app.inject({ method: "POST", url: startUrl, headers, payload: {} });
      expect(start.mock.calls.at(-1)?.[0].profileKey).toBeNull();
    } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("stops a YouTube browser that finishes starting after the pane closes", async () => {
    const root = await mkdtemp(join(tmpdir(), "youtube-session-api-"));
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "YouTube startup", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "YouTube", mode: "YOUTUBE" });
    const manager = fakeBrowserSessionManager();
    const start = manager.startOrRestore.bind(manager);
    manager.startOrRestore = async (input) => {
      const response = await start(input);
      await store.updatePane(pane.id, { isClosed: true, status: "CLOSED" });
      return response;
    };
    const stop = vi.spyOn(manager, "stopPane");
    const { app, cookie, csrfToken } = await authedApp({ store, config: getApiConfig({ SPACE_ARTIFACT_ROOT: join(root, "artifacts") }), browserSessionManager: manager });
    try {
      const response = await app.inject({ method: "POST", url: `/api/panes/${encodeURIComponent(pane.id)}/browser/session`,
        headers: { cookie, [csrfHeaderName]: csrfToken }, payload: { targetUrl: "https://www.youtube.com/" } });
      expect(response.statusCode).toBe(409);
      expect(stop).toHaveBeenCalledWith(pane.id, expect.any(String), expect.any(Object));
    } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  });

  it.each(["AGENT_PROOF", "WORKSPACE"] as const)("keeps closed browser sessions stopped until explicit start: %s", async (kind) => {
      const store = new InMemorySpaceStore();
      const room = store.createRoom({ name: "Retained browser", initialPaneCount: 0, kind });
      const pane = store.createPane({ roomId: room.id, title: "Browser Live Proof", mode: "BROWSER" });
      store.createPaneBrowserSession({ sessionId: "browser_session:closed-proof", agentNumber: 1, paneId: pane.id, roomId: room.id,
        profileId: "profile:closed-proof", profilePath: "/tmp/closed-proof", viewport: "desktop",
        targetUrl: "https://example.com/", status: "CLOSED", isActive: false });
      const manager = fakeBrowserSessionManager();
      const getActive = vi.spyOn(manager, "getActive");
      const start = vi.spyOn(manager, "startOrRestore");
      const { app, cookie, csrfToken } = await authedApp({ store, browserSessionManager: manager });
      const url = `/api/panes/${encodeURIComponent(pane.id)}/browser/session`;
      try {
        for (let n = 0; n < 3; n++) {
          const response = await app.inject({ method: "GET", url, headers: { cookie } });
          expect(response.statusCode).toBe(200);
          expect(response.json()).toMatchObject({ session: { status: "CLOSED", isActive: false }, frame: null, websocket: null });
        }
        expect(getActive).not.toHaveBeenCalled();
        const resumed = await app.inject({ method: "POST", url, headers: { cookie, [csrfHeaderName]: csrfToken }, payload: {} });
        expect(resumed.statusCode).toBe(200);
        expect(start).toHaveBeenCalledTimes(1);
      } finally { await app.close(); }
  });

  it("restores the closed YouTube session URL and accepts an explicit newly selected video", async () => {
    const root = await mkdtemp(join(tmpdir(), "youtube-session-api-"));
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "YouTube restore", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "YouTube", mode: "YOUTUBE" });
    store.createPaneBrowserSession({ sessionId: "browser_session:youtube-restore", agentNumber: 1, paneId: pane.id, roomId: room.id,
      profileId: "profile:youtube-restore", profilePath: "/tmp/youtube-restore", viewport: "wide",
      targetUrl: "https://www.youtube.com/", currentUrl: "https://www.youtube.com/watch?v=abcdefghijk&t=123s", status: "CLOSED", isActive: false });
    const manager = fakeBrowserSessionManager();
    const start = vi.spyOn(manager, "startOrRestore");
    const { app, cookie, csrfToken } = await authedApp({ store, config: getApiConfig({ SPACE_ARTIFACT_ROOT: join(root, "artifacts") }), browserSessionManager: manager });
    const headers = { cookie, [csrfHeaderName]: csrfToken };
    const url = `/api/panes/${encodeURIComponent(pane.id)}/browser/session`;
    try {
      expect((await app.inject({ method: "POST", url, headers, payload: { targetUrl: "https://www.youtube.com/" } })).statusCode).toBe(200);
      expect(start.mock.calls[0]?.[0].targetUrl).toBe("https://www.youtube.com/watch?v=abcdefghijk&t=123s");
      await app.inject({ method: "POST", url, headers, payload: { targetUrl: "https://www.youtube.com/watch?v=abcdefghij2" } });
      expect(start.mock.calls[1]?.[0].targetUrl).toBe("https://www.youtube.com/watch?v=abcdefghij2");
    } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("closes YOUTUBE and BROWSER panes even when the Browser Host is unavailable", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Close Room", initialPaneCount: 0 });
    const youtubePane = store.createPane({ roomId: room.id, title: "YouTube 1", mode: "YOUTUBE" });
    const browserPane = store.createPane({ roomId: room.id, title: "Browser 1", mode: "BROWSER" });
    store.createPaneBrowserSession({
      sessionId: `browser_session:${browserPane.id.replace(/[^A-Za-z0-9_-]/g, "_")}`,
      paneId: browserPane.id,
      roomId: room.id,
      ownerAgentId: "agent:1",
      agentNumber: 1,
      profileId: `profile:${browserPane.id}`,
      profilePath: `/tmp/${browserPane.id}`,
      viewport: "desktop",
      targetUrl: "https://www.google.com/",
      currentUrl: "https://www.google.com/",
      title: "Olla",
      status: "READY",
      statusReason: "Page ready.",
      streamMode: "AUTO",
      runtimeState: "READY",
      capacityState: "AVAILABLE",
      controlState: "UNCONTROLLED",
      pages: [],
      activePageId: null,
      isActive: true,
      startedAt: "2026-07-05T00:00:00.000Z",
      updatedAt: "2026-07-05T00:00:00.000Z"
    });
    const failingManager = Object.assign(fakeBrowserSessionManager({ enabled: true }), {
      stopPane: async (): Promise<void> => {
        throw new SpaceFeatureDisabledError("BROWSER_HOST_UNAVAILABLE", "The Browser Host is unavailable.");
      },
      startOrRestore: async (): Promise<never> => {
        throw new SpaceFeatureDisabledError("BROWSER_HOST_UNAVAILABLE", "The Browser Host is unavailable.", { hostCode: "BROWSER_HOST_UNAVAILABLE", hostDetails: { causeCode: "EAGAIN" } });
      }
    });
    const logs: string[] = [];
    const { app, cookie, csrfToken } = await authedApp({
      store,
      config: getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: "true" }),
      browserSessionManager: failingManager,
      logStream: new Writable({ write(chunk, _encoding, callback) { logs.push(String(chunk)); callback(); } })
    });
    const headers = { cookie, [csrfHeaderName]: csrfToken };

    // Stable 2026-10-27: five minutes of fast 503s left no trace of the host's code; the log line now carries it.
    const started = await app.inject({ method: "POST", url: `/api/panes/${encodeURIComponent(browserPane.id)}/browser/session`, headers, payload: {} });
    expect(started.statusCode).toBe(503);
    expect(logs.find((line) => line.includes("request blocked by feature gate"))).toContain('"hostError":{"hostCode":"BROWSER_HOST_UNAVAILABLE","hostDetails":{"causeCode":"EAGAIN"}}');

    const closedYouTube = await app.inject({
      method: "DELETE",
      url: `/api/panes/${encodeURIComponent(youtubePane.id)}`,
      headers
    });
    expect(closedYouTube.statusCode).toBe(200);
    expect(closedYouTube.json()).toMatchObject({ id: youtubePane.id, isClosed: true, status: "CLOSED" });

    const closedBrowser = await app.inject({
      method: "DELETE",
      url: `/api/panes/${encodeURIComponent(browserPane.id)}`,
      headers
    });
    expect(closedBrowser.statusCode).toBe(200);
    expect(closedBrowser.json()).toMatchObject({ id: browserPane.id, isClosed: true, status: "CLOSED" });
  });

  it("routes browser session lifecycle and safe tool actions through pane ownership checks", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Browser Room", initialPaneCount: 0 });
    const browserPane = store.createPane({ roomId: room.id, title: "Browser 1", mode: "BROWSER" });
    const chatPane = store.createPane({ roomId: room.id, title: "Planner", mode: "CHAT" });
    const youtubePane = store.createPane({ roomId: room.id, title: "YouTube 1", mode: "YOUTUBE" });
    const { app, cookie, csrfToken } = await authedApp({
      store,
      config: getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: "true" }),
      browserSessionManager: fakeBrowserSessionManager({ enabled: true })
    });

    const started = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(browserPane.id)}/browser/session`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { viewport: "desktop", targetUrl: "https://www.google.com/" }
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({
      session: {
        paneId: browserPane.id,
        viewport: "desktop",
        currentUrl: "https://www.google.com/"
      },
      frame: {
        screenshotDataUrl: expect.stringMatching(/^data:image\/png;base64,/)
      },
      websocket: {
        token: "browser-frame-ticket-test-value"
      }
    });

    const viewport = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(browserPane.id)}/browser/viewport`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { viewport: "mobile" }
    });
    expect(viewport.statusCode).toBe(200);
    expect(viewport.json().session.viewport).toBe("mobile");

    const action = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(browserPane.id)}/browser/action`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { type: "extract_text" }
    });
    expect(action.statusCode).toBe(200);
    expect(action.json()).toMatchObject({
      session: { paneId: browserPane.id },
      text: "Olla observed text."
    });

    const youtubeStart = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(youtubePane.id)}/browser/session`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { viewport: "desktop", targetUrl: "https://www.youtube.com/" }
    });
    expect(youtubeStart.statusCode).toBe(200);
    expect(youtubeStart.json()).toMatchObject({
      session: {
        paneId: youtubePane.id,
        viewport: "desktop",
        currentUrl: "https://www.youtube.com/"
      }
    });

    const wrongPane = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(chatPane.id)}/browser/session`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { viewport: "desktop", targetUrl: "https://www.google.com/" }
    });
    expect(wrongPane.statusCode).toBe(409);
    expect(wrongPane.json()).toMatchObject({
      error: {
        code: "CONFLICT",
        message: expect.stringContaining("browser sessions require BROWSER, YOUTUBE, JOB_APPLY, MARKETING_COPILOT or FREELANCE_COPILOT panes")
      }
    });
  });

  it("exposes adaptive streams, control handoff, pages, input, captures and diagnostics through browser v2 routes", async () => {
    const store = new InMemorySpaceStore();
    const artifactRoot = await mkdtemp(join(tmpdir(), "space-api-browser-v2-"));
    const room = store.createRoom({ name: "Browser V2", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Browser", mode: "BROWSER" });
    const persistedSession = store.createPaneBrowserSession({
      sessionId: `browser_session:${pane.id.replace(/[^A-Za-z0-9_-]/g, "_")}`,
      paneId: pane.id,
      roomId: room.id,
      ownerAgentId: "agent:1",
      agentNumber: 1,
      profileId: `profile:${pane.id}`,
      profilePath: `/tmp/${pane.id}`,
      viewport: "desktop",
      targetUrl: "https://www.google.com/",
      currentUrl: "https://www.google.com/",
      title: "Olla",
      status: "READY",
      isActive: true
    });
    const { app, cookie, csrfToken } = await authedApp({
      store,
      config: getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: "true", SPACE_ARTIFACT_ROOT: artifactRoot }),
      browserSessionManager: fakeBrowserSessionManager({ enabled: true })
    });
    const headers = { cookie, [csrfHeaderName]: csrfToken };

    const started = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/browser/session`,
      headers,
      payload: { streamMode: "REALTIME" }
    });
    expect(started.statusCode).toBe(200);
    expect(started.json().session).toMatchObject({ streamMode: "REALTIME", resolvedStreamMode: "REALTIME", runtimeState: "READY" });

    const silent = await app.inject({
      method: "PATCH",
      url: `/api/panes/${encodeURIComponent(pane.id)}/browser/session`,
      headers,
      payload: { streamMode: "SILENT" }
    });
    expect(silent.statusCode).toBe(200);
    expect(silent.json().session).toMatchObject({ streamMode: "SILENT", resolvedStreamMode: "SILENT" });

    // Copilot panes poll for a handoff: none, or no browser at all, is their normal state and answers null, not 404.
    const idlePane = store.createPane({ roomId: room.id, title: "Idle browser", mode: "BROWSER" });
    for (const id of [pane.id, idlePane.id]) {
      const none = await app.inject({ method: "GET", url: `/api/panes/${encodeURIComponent(id)}/browser/handoff`, headers: { cookie } });
      expect(none.statusCode).toBe(200);
      expect(none.json()).toEqual({ handoff: null });
    }

    const handoff = store.createBrowserHandoffRequest({
      sessionId: persistedSession.sessionId,
      paneId: pane.id,
      roomId: room.id,
      requestedByType: "AGENT",
      requestedById: "agent:blocked",
      reason: "CAPTCHA: Complete verification",
      ttlSeconds: 300
    });
    store.createBrowserControlLease({
      leaseId: "browser_lease:test",
      sessionId: persistedSession.sessionId,
      paneId: pane.id,
      roomId: room.id,
      holderType: "OPERATOR",
      holderId: "user:dev-operator",
      reason: "Human takeover",
      ttlSeconds: 60
    });

    const acquired = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/browser/control/acquire`,
      headers,
      payload: { holderType: "OPERATOR", holderId: "ignored-client-holder", ttlSeconds: 30 }
    });
    expect(acquired.statusCode).toBe(200);
    expect(acquired.json().lease).toMatchObject({ leaseId: "browser_lease:test", holderType: "OPERATOR", status: "ACTIVE" });
    expect(store.getBrowserHandoffRequest(handoff.handoffRequestId)).toMatchObject({
      status: "ACCEPTED",
      operatorUserId: "user:dev-operator",
      operatorEmail: "space@space.local",
      operatorRole: "ADMIN",
      controlLeaseId: "browser_lease:test"
    });
    const acceptedHandoff = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/browser/handoff`,
      headers: { cookie }
    });
    expect(acceptedHandoff.statusCode).toBe(200);
    expect(acceptedHandoff.json()).toMatchObject({ handoff: { status: "ACCEPTED", operatorUserId: "user:dev-operator" } });

    const input = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/browser/input`,
      headers,
      payload: { type: "POINTER", leaseId: "browser_lease:test", eventType: "mousePressed", x: 120, y: 80, button: "left" }
    });
    expect(input.statusCode).toBe(200);
    expect(input.json().session.controlState).toBe("OPERATOR");

    const page = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/browser/pages`,
      headers,
      payload: { url: "https://example.com/", activate: true }
    });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({ activePageId: "page:2", pages: expect.arrayContaining([expect.objectContaining({ url: "https://example.com/" })]) });

    const capture = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/browser/captures`,
      headers,
      payload: { options: { kind: "SCREENSHOT", format: "PNG", target: "FULL_PAGE" } }
    });
    expect(capture.statusCode).toBe(202);
    expect(capture.json().job).toMatchObject({ jobId: "browser_capture_job:test", status: "QUEUED", options: { kind: "SCREENSHOT" } });

    const captureStatus = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/browser/captures/${encodeURIComponent("browser_capture_job:test")}`,
      headers: { cookie }
    });
    expect(captureStatus.statusCode).toBe(200);
    expect(captureStatus.json().job.jobId).toBe("browser_capture_job:test");

    const stoppedCapture = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/browser/captures/${encodeURIComponent("browser_capture_job:test")}/stop`,
      headers
    });
    expect(stoppedCapture.statusCode).toBe(200);
    expect(stoppedCapture.json().job).toMatchObject({ jobId: "browser_capture_job:test", status: "COMPLETED" });

    await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/browser/captures`,
      headers,
      payload: { options: { kind: "RECORDING", format: "WEBM", maxDurationMs: 60_000, maxBytes: 1_073_741_824, frameIntervalMs: 100 } }
    });
    const cancelledCapture = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/browser/captures/${encodeURIComponent("browser_capture_job:test")}/cancel`,
      headers
    });
    expect(cancelledCapture.statusCode).toBe(200);
    expect(cancelledCapture.json().job).toMatchObject({ jobId: "browser_capture_job:test", status: "CANCELLED" });

    const diagnostics = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/browser/diagnostics?includeNetwork=true&limit=20`,
      headers: { cookie }
    });
    expect(diagnostics.statusCode).toBe(200);
    expect(diagnostics.json().events).toEqual([expect.objectContaining({ type: "CONSOLE", message: "console ok" })]);

    const recordingJob = store.createBrowserCaptureJob({
      jobId: "browser_capture:timeline-test",
      sessionId: persistedSession.sessionId,
      paneId: pane.id,
      roomId: room.id,
      requestedByType: "OPERATOR",
      requestedById: "user:dev-operator",
      options: { kind: "RECORDING", format: "WEBM", maxDurationMs: 10_000, maxBytes: 10_000, frameIntervalMs: 1_000 }
    });
    store.updateBrowserCaptureJob(recordingJob.jobId, { status: "COMPLETED", progressPercent: 100 });
    const captureSegment = store.createBrowserCaptureSegment({ jobId: recordingJob.jobId, sessionId: persistedSession.sessionId });
    store.updateBrowserCaptureSegment(captureSegment.segmentId, {
      status: "FINALIZED",
      storageUri: "space-artifact://browser-evidence/browser_capture_timeline-test/segment-0000.webm",
      sha256: "c".repeat(64),
      byteSize: 512,
      durationMs: 5_000,
      frameCount: 2,
      lastFrameSequence: 1
    });
    const recordingDir = join(artifactRoot, "browser-evidence", "browser_capture_timeline-test");
    await mkdir(recordingDir, { recursive: true });
    await writeFile(join(recordingDir, "manifest.json"), JSON.stringify({
      durationMs: 5_000,
      frameCount: 2,
      segmentCount: 1,
      frames: [
        { index: 0, segmentSequence: 0, segmentFrameIndex: 0, capturedAt: "2026-07-05T00:00:00.000Z", elapsedMs: 0 },
        { index: 1, segmentSequence: 0, segmentFrameIndex: 1, capturedAt: "2026-07-05T00:00:01.000Z", elapsedMs: 1_000 }
      ]
    }));

    const segments = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/browser/captures/${encodeURIComponent(recordingJob.jobId)}/segments`,
      headers: { cookie }
    });
    expect(segments.statusCode).toBe(200);
    expect(segments.json()).toMatchObject({
      jobId: recordingJob.jobId,
      segments: [{ sequence: 0, status: "FINALIZED", frameCount: 2 }]
    });

    const timeline = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/browser/captures/${encodeURIComponent(recordingJob.jobId)}/timeline`,
      headers: { cookie }
    });
    expect(timeline.statusCode).toBe(200);
    expect(timeline.json()).toMatchObject({
      jobId: recordingJob.jobId,
      sessionId: persistedSession.sessionId,
      frameCount: 2,
      segmentCount: 1,
      events: [{ eventId: "browser_event:test", frameIndex: 0 }]
    });

    const released = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/browser/control/release`,
      headers,
      payload: { leaseId: "browser_lease:test" }
    });
    expect(released.statusCode).toBe(200);
    expect(released.json().lease.status).toBe("RELEASED");
    expect(store.getBrowserHandoffRequest(handoff.handoffRequestId)?.status).toBe("COMPLETED");
    const completedHandoff = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/browser/handoff`,
      headers: { cookie }
    });
    expect(completedHandoff.statusCode).toBe(200);
    expect(completedHandoff.json()).toMatchObject({ handoff: { status: "COMPLETED" } });
  });

  it("accepts a handoff the agent asks for while the operator already holds the browser on the next lease heartbeat", async () => {
    // Operator report 2026-10-15: the copilot asked for a login while the operator was using its browser; the
    // request stayed REQUESTED (its card covered the page) because nothing acquired control again.
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Held browser", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Marketing", mode: "BROWSER" });
    const sessionId = `browser_session:${pane.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
    store.createPaneBrowserSession({
      sessionId, paneId: pane.id, roomId: room.id, ownerAgentId: "agent:1", agentNumber: 1, profileId: `profile:${pane.id}`,
      profilePath: `/tmp/${pane.id}`, viewport: "desktop", targetUrl: "https://www.google.com/", currentUrl: "https://www.google.com/",
      title: "Olla", status: "READY", isActive: true
    });
    const { app, cookie, csrfToken } = await authedApp({
      store,
      config: getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: "true" }),
      browserSessionManager: fakeBrowserSessionManager({ enabled: true })
    });
    const headers = { cookie, [csrfHeaderName]: csrfToken };
    store.createBrowserControlLease({
      leaseId: "browser_lease:test", sessionId, paneId: pane.id, roomId: room.id, holderType: "OPERATOR",
      holderId: "user:dev-operator", reason: "Direct browser interaction", ttlSeconds: 60
    });
    const acquired = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/browser/control/acquire`,
      headers,
      payload: { holderType: "OPERATOR", holderId: "space-user", ttlSeconds: 60 }
    });
    expect(acquired.statusCode).toBe(200);
    const leaseId = acquired.json().lease.leaseId as string;
    const handoff = store.createBrowserHandoffRequest({
      sessionId, paneId: pane.id, roomId: room.id, requestedByType: "AGENT", requestedById: "cli:cli_session:test",
      reason: "LOGIN: Log in to Reddit", ttlSeconds: 1800
    });
    expect(store.getBrowserHandoffRequest(handoff.handoffRequestId)?.status).toBe("REQUESTED");
    const heartbeat = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/browser/control/heartbeat`,
      headers,
      payload: { leaseId, ttlSeconds: 60 }
    });
    expect(heartbeat.statusCode).toBe(200);
    expect(store.getBrowserHandoffRequest(handoff.handoffRequestId)).toMatchObject({
      status: "ACCEPTED", operatorUserId: "user:dev-operator", controlLeaseId: leaseId
    });
    // Giving the browser back completes it, as after "Take control".
    const released = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/browser/control/release`,
      headers,
      payload: { leaseId }
    });
    expect(released.statusCode).toBe(200);
    expect(store.getBrowserHandoffRequest(handoff.handoffRequestId)?.status).toBe("COMPLETED");
  });

  it("releases an operator lease nobody has pressed for 60 s on its heartbeat, never one still in use", async () => {
    // Operator report 2026-10-15: a Space tab on an old web bundle kept heartbeating a lease for an hour and blocked the agents.
    const start = Date.parse("2026-10-15T10:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    try {
      const store = new InMemorySpaceStore();
      const room = store.createRoom({ name: "Idle control", initialPaneCount: 0 });
      const pane = store.createPane({ roomId: room.id, title: "Job Copilot", mode: "BROWSER" });
      const sessionId = `browser_session:${pane.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
      store.createPaneBrowserSession({
        sessionId, paneId: pane.id, roomId: room.id, ownerAgentId: "agent:1", agentNumber: 1, profileId: `profile:${pane.id}`,
        profilePath: `/tmp/${pane.id}`, viewport: "desktop", targetUrl: "https://www.google.com/", currentUrl: "https://www.google.com/",
        title: "Olla", status: "READY", isActive: true
      });
      const { app, cookie, csrfToken } = await authedApp({
        store,
        config: getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: "true" }),
        browserSessionManager: fakeBrowserSessionManager({ enabled: true })
      });
      const headers = { cookie, [csrfHeaderName]: csrfToken };
      store.createBrowserControlLease({
        leaseId: "browser_lease:test", sessionId, paneId: pane.id, roomId: room.id, holderType: "OPERATOR",
        holderId: "user:dev-operator", reason: "Direct browser interaction", ttlSeconds: 300
      });
      const handoff = store.createBrowserHandoffRequest({
        sessionId, paneId: pane.id, roomId: room.id, requestedByType: "AGENT", requestedById: "cli:cli_session:test",
        reason: "CAPTCHA: Solve it", ttlSeconds: 1800
      });
      const acquired = await app.inject({
        method: "POST", url: `/api/panes/${encodeURIComponent(pane.id)}/browser/control/acquire`, headers,
        payload: { holderType: "OPERATOR", holderId: "space-user", ttlSeconds: 60 }
      });
      expect(acquired.statusCode).toBe(200);
      const leaseId = acquired.json().lease.leaseId as string;
      expect(store.getBrowserHandoffRequest(handoff.handoffRequestId)?.status).toBe("ACCEPTED");
      const heartbeat = () => app.inject({
        method: "POST", url: `/api/panes/${encodeURIComponent(pane.id)}/browser/control/heartbeat`, headers, payload: { leaseId, ttlSeconds: 60 }
      });
      vi.setSystemTime(start + 4 * 60_000);
      const input = await app.inject({
        method: "POST", url: `/api/panes/${encodeURIComponent(pane.id)}/browser/input`, headers,
        payload: { type: "POINTER", leaseId, eventType: "mousePressed", x: 120, y: 80, button: "left" }
      });
      expect(input.statusCode).toBe(200);
      // A bare hover is not use: it does not keep the browser.
      vi.setSystemTime(start + 4 * 60_000 + 30_000);
      const hover = await app.inject({
        method: "POST", url: `/api/panes/${encodeURIComponent(pane.id)}/browser/input`, headers,
        payload: { type: "POINTER", leaseId, eventType: "mouseMoved", x: 140, y: 90, button: "none" }
      });
      expect(hover.statusCode).toBe(200);
      // Four and a half minutes after taking control but 30 s after the last press: the operator keeps it.
      expect((await heartbeat()).json().lease.status).toBe("ACTIVE");
      // Operator decision 2026-10-24: back to the agent 60 s after the last press (2 minutes until then).
      vi.setSystemTime(start + 6 * 60_000 + 1000);
      const idle = await heartbeat();
      expect(idle.statusCode).toBe(200);
      expect(idle.json().lease).toMatchObject({ leaseId, status: "RELEASED" });
      expect(store.getBrowserHandoffRequest(handoff.handoffRequestId)?.status).toBe("COMPLETED");
      expect(store.listAuditEvents().filter((event) => event.action === "pane.browser.control.idle_release")).toEqual([
        expect.objectContaining({ targetId: pane.id, metadata: { sessionId, leaseId, idleSeconds: 121 } })
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a sign-in handoff with the operator while they stay on the pane, and lets it go 60 s after they leave (operator 2026-10-27)", async () => {
    const start = Date.parse("2026-10-27T09:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    try {
      const store = new InMemorySpaceStore();
      const room = store.createRoom({ name: "Bank", initialPaneCount: 0 });
      const pane = store.createPane({ roomId: room.id, title: "Bank", mode: "BROWSER" });
      const sessionId = `browser_session:${pane.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
      store.createPaneBrowserSession({
        sessionId, paneId: pane.id, roomId: room.id, ownerAgentId: "agent:1", agentNumber: 1, profileId: `profile:${pane.id}`,
        profilePath: `/tmp/${pane.id}`, viewport: "desktop", targetUrl: "https://www.google.com/", currentUrl: "https://www.google.com/",
        title: "Bank", status: "READY", isActive: true
      });
      const { app, cookie, csrfToken } = await authedApp({ store, config: getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: "true" }), browserSessionManager: fakeBrowserSessionManager({ enabled: true }) });
      const headers = { cookie, [csrfHeaderName]: csrfToken };
      store.createBrowserControlLease({ leaseId: "browser_lease:test", sessionId, paneId: pane.id, roomId: room.id, holderType: "OPERATOR",
        holderId: "user:dev-operator", reason: "Direct browser interaction", ttlSeconds: 300 });
      const handoff = store.createBrowserHandoffRequest({ sessionId, paneId: pane.id, roomId: room.id, requestedByType: "AGENT", requestedById: "cli:cli_session:test",
        reason: "Sign in to NBG: enter the SMS code", ttlSeconds: 1800 });
      const acquired = await app.inject({ method: "POST", url: `/api/panes/${encodeURIComponent(pane.id)}/browser/control/acquire`, headers,
        payload: { holderType: "OPERATOR", holderId: "space-user", ttlSeconds: 60 } });
      const leaseId = acquired.json().lease.leaseId as string;
      const heartbeat = (present?: boolean) => app.inject({ method: "POST", url: `/api/panes/${encodeURIComponent(pane.id)}/browser/control/heartbeat`, headers,
        payload: { leaseId, ttlSeconds: 60, ...(present === undefined ? {} : { present }) } });
      expect((await heartbeat(true)).json()).toMatchObject({ lease: { status: "ACTIVE" }, presenceHold: true });
      // Five minutes without a key while they wait on the pane for the SMS: still theirs.
      for (let minute = 1; minute <= 5; minute += 1) {
        vi.setSystemTime(start + minute * 60_000);
        expect((await heartbeat(true)).json().lease.status).toBe("ACTIVE");
      }
      // They leave the pane: idle counts from then, and 60 s later the browser goes back to the agent.
      vi.setSystemTime(start + 5 * 60_000 + 30_000);
      expect((await heartbeat(false)).json().lease.status).toBe("ACTIVE");
      vi.setSystemTime(start + 6 * 60_000 + 1_000);
      expect((await heartbeat(false)).json().lease).toMatchObject({ leaseId, status: "RELEASED" });
      expect(store.getBrowserHandoffRequest(handoff.handoffRequestId)?.status).toBe("COMPLETED");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the 60 s rule for control without a sign-in handoff even while the operator is on the pane (operator 2026-10-24)", async () => {
    const start = Date.parse("2026-10-27T09:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    try {
      const store = new InMemorySpaceStore();
      const room = store.createRoom({ name: "Shop", initialPaneCount: 0 });
      const pane = store.createPane({ roomId: room.id, title: "Shop", mode: "BROWSER" });
      const sessionId = `browser_session:${pane.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
      store.createPaneBrowserSession({
        sessionId, paneId: pane.id, roomId: room.id, ownerAgentId: "agent:1", agentNumber: 1, profileId: `profile:${pane.id}`,
        profilePath: `/tmp/${pane.id}`, viewport: "desktop", targetUrl: "https://www.google.com/", currentUrl: "https://www.google.com/",
        title: "Shop", status: "READY", isActive: true
      });
      const { app, cookie, csrfToken } = await authedApp({ store, config: getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: "true" }), browserSessionManager: fakeBrowserSessionManager({ enabled: true }) });
      const headers = { cookie, [csrfHeaderName]: csrfToken };
      store.createBrowserControlLease({ leaseId: "browser_lease:test", sessionId, paneId: pane.id, roomId: room.id, holderType: "OPERATOR",
        holderId: "user:dev-operator", reason: "Direct browser interaction", ttlSeconds: 300 });
      store.createBrowserHandoffRequest({ sessionId, paneId: pane.id, roomId: room.id, requestedByType: "AGENT", requestedById: "cli:cli_session:test",
        reason: "Choose the shipping option you prefer", ttlSeconds: 1800 });
      const acquired = await app.inject({ method: "POST", url: `/api/panes/${encodeURIComponent(pane.id)}/browser/control/acquire`, headers,
        payload: { holderType: "OPERATOR", holderId: "space-user", ttlSeconds: 60 } });
      const leaseId = acquired.json().lease.leaseId as string;
      const heartbeat = () => app.inject({ method: "POST", url: `/api/panes/${encodeURIComponent(pane.id)}/browser/control/heartbeat`, headers, payload: { leaseId, ttlSeconds: 60, present: true } });
      expect((await heartbeat()).json()).not.toHaveProperty("presenceHold");
      vi.setSystemTime(start + 61_000);
      expect((await heartbeat()).json().lease).toMatchObject({ leaseId, status: "RELEASED" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a CLI agent reclaim the browser from an operator only after 60 s without input", async () => {
    const start = Date.parse("2026-10-15T10:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    try {
      const store = new InMemorySpaceStore();
      const room = store.createRoom({ name: "Reclaim", initialPaneCount: 0 });
      const t3Pane = store.createPane({ roomId: room.id, title: "T3 Code", mode: "T3CODE" });
      const browserPane = store.createPane({ roomId: room.id, title: "Browser 1", mode: "BROWSER" });
      const sessionId = `browser_session:${browserPane.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
      store.createPaneBrowserSession({
        sessionId, paneId: browserPane.id, roomId: room.id, ownerAgentId: "agent:1", agentNumber: 1,
        profileId: "profile:reclaim-1", profilePath: "/tmp/space-browser-reclaim", viewport: "desktop",
        targetUrl: "https://example.test/", currentUrl: "https://example.test/", title: "Example", status: "READY", isActive: true
      });
      const config = getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: "true", SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true", SPACE_INTERNAL_API_TOKEN: "test-internal-token" });
      const token = issueCliBrowserBridgeToken(config, { roomId: room.id, paneId: t3Pane.id, cliSessionId: `t3code:${t3Pane.id}` })!;
      const { app, cookie, csrfToken } = await authedApp({ store, config, browserSessionManager: fakeBrowserSessionManager({ enabled: true }) });
      const reclaim = async () => {
        const response = await app.inject({
          method: "POST", url: "/api/cli/browser/commands",
          headers: { [cliBrowserBridgeTokenHeader]: token, "content-type": "application/json" },
          payload: { targetPaneId: browserPane.id, command: { type: "RECLAIM_CONTROL" } }
        });
        expect(response.statusCode).toBe(200);
        return response.json();
      };
      expect(await reclaim()).toMatchObject({ reclaimed: false, reason: "NO_OPERATOR_CONTROL" });
      store.createBrowserControlLease({
        leaseId: "browser_lease:test", sessionId, paneId: browserPane.id, roomId: room.id, holderType: "OPERATOR",
        holderId: "user:dev-operator", reason: "Direct browser interaction", ttlSeconds: 300
      });
      const acquired = await app.inject({
        method: "POST", url: `/api/panes/${encodeURIComponent(browserPane.id)}/browser/control/acquire`,
        headers: { cookie, [csrfHeaderName]: csrfToken }, payload: { holderType: "OPERATOR", holderId: "space-user", ttlSeconds: 60 }
      });
      expect(acquired.statusCode).toBe(200);
      vi.setSystemTime(start + 45_000);
      expect(await reclaim()).toMatchObject({ reclaimed: false, reason: "OPERATOR_ACTIVE", idleSeconds: 45, retryAfterSeconds: 15 });
      vi.setSystemTime(start + 60_000);
      expect(await reclaim()).toMatchObject({ reclaimed: true, reason: "RECLAIMED", idleSeconds: 60, lease: { status: "RELEASED" } });
      expect(store.listAuditEvents().filter((event) => event.action === "pane.browser.control.agent_reclaim")).toEqual([
        expect.objectContaining({ targetId: browserPane.id, metadata: { sessionId, leaseId: "browser_lease:test", agent: `cli:t3code:${t3Pane.id}`, idleSeconds: 60 } })
      ]);
      // A handoff the operator took and then left (his tab stopped renewing the lease) reads COMPLETED to the agent.
      const handoff = store.createBrowserHandoffRequest({
        sessionId, paneId: browserPane.id, roomId: room.id, requestedByType: "AGENT", requestedById: `cli:t3code:${t3Pane.id}`,
        reason: "CAPTCHA: solve it", ttlSeconds: 1800
      });
      const taken = await app.inject({
        method: "POST", url: `/api/panes/${encodeURIComponent(browserPane.id)}/browser/control/acquire`,
        headers: { cookie, [csrfHeaderName]: csrfToken }, payload: { holderType: "OPERATOR", holderId: "space-user", ttlSeconds: 60 }
      });
      expect(taken.statusCode).toBe(200);
      expect(store.getBrowserHandoffRequest(handoff.handoffRequestId)?.status).toBe("ACCEPTED");
      // The stored lease ran out at +300 s with no renewal.
      vi.setSystemTime(start + 301_000);
      const status = await app.inject({
        method: "POST", url: "/api/cli/browser/commands",
        headers: { [cliBrowserBridgeTokenHeader]: token, "content-type": "application/json" },
        payload: { targetPaneId: browserPane.id, command: { type: "HANDOFF_STATUS" } }
      });
      expect(status.statusCode).toBe(200);
      expect(status.json().handoff).toMatchObject({ handoffRequestId: handoff.handoffRequestId, status: "COMPLETED" });
      expect(store.getPaneBrowserSession(sessionId)?.controlState).toBe("UNCONTROLLED");
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets an open T3 Code pane use the browser bridge of its own room under its T3 principal", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "T3 Browser Bridge", initialPaneCount: 0 });
    const t3Pane = store.createPane({ roomId: room.id, title: "T3 Code", mode: "T3CODE" });
    const browserPane = store.createPane({ roomId: room.id, title: "Browser 1", mode: "BROWSER" });
    store.createPaneBrowserSession({
      sessionId: "browser_session:t3-bridge-1", paneId: browserPane.id, roomId: room.id, ownerAgentId: "agent:1", agentNumber: 1,
      profileId: "profile:t3-bridge-1", profilePath: "/opt/spaceapp/var/artifacts/browser-profiles/t3", viewport: "desktop",
      targetUrl: "https://example.test/", currentUrl: "https://example.test/", title: "Example", status: "READY", isActive: true
    });
    const config = getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: "true", SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true", SPACE_INTERNAL_API_TOKEN: "test-internal-token" });
    const token = issueCliBrowserBridgeToken(config, { roomId: room.id, paneId: t3Pane.id, cliSessionId: `t3code:${t3Pane.id}` })!;
    const { app } = await authedApp({ store, config, browserSessionManager: fakeBrowserSessionManager({ enabled: true }) });
    const context = await app.inject({ method: "GET", url: "/api/cli/browser/context", headers: { [cliBrowserBridgeTokenHeader]: token } });
    expect(context.statusCode).toBe(200);
    expect(context.json()).toMatchObject({ roomId: room.id, cliPaneId: t3Pane.id, cliSessionId: `t3code:${t3Pane.id}`,
      browserSessions: [expect.objectContaining({ paneId: browserPane.id })] });
    // A principal that names another pane, or a closed T3 pane, is refused.
    const forged = issueCliBrowserBridgeToken(config, { roomId: room.id, paneId: browserPane.id, cliSessionId: `t3code:${t3Pane.id}` })!;
    expect((await app.inject({ method: "GET", url: "/api/cli/browser/context", headers: { [cliBrowserBridgeTokenHeader]: forged } })).statusCode).toBe(404);
    store.updatePane(t3Pane.id, { isClosed: true });
    const closed = await app.inject({ method: "GET", url: "/api/cli/browser/context", headers: { [cliBrowserBridgeTokenHeader]: token } });
    expect(closed.statusCode).toBe(404);
    expect(closed.json().error.code).toBe("T3_PANE_NOT_FOUND");
  });

  it("keeps a running CLI's bridge token working after its pane moves to another room", async () => {
    const store = new InMemorySpaceStore();
    const source = store.createRoom({ name: "Source", initialPaneCount: 0 });
    const target = store.createRoom({ name: "Target", initialPaneCount: 0 });
    const cliPane = store.createPane({ roomId: source.id, title: "Claude CLI", mode: "TERMINAL" });
    store.createPaneCliSession({
      sessionId: "cli_session:moved-1", paneId: cliPane.id, roomId: source.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex",
      modelId: null, reasoningEffort: "medium", cwd: "/opt/spaceapp/var/artifacts/cli-workspaces/test", status: "RUNNING", statusReason: "CLI running.", isActive: true
    });
    const config = getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: "true", SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true", SPACE_INTERNAL_API_TOKEN: "test-internal-token" });
    const token = issueCliBrowserBridgeToken(config, { roomId: source.id, paneId: cliPane.id, cliSessionId: "cli_session:moved-1" })!;
    const { app } = await authedApp({ store, config, browserSessionManager: fakeBrowserSessionManager({ enabled: true }) });
    store.movePane(cliPane.id, { targetRoomId: target.id });
    const context = await app.inject({ method: "GET", url: "/api/cli/browser/context", headers: { [cliBrowserBridgeTokenHeader]: token } });
    expect(context.statusCode, context.body).toBe(200);
    expect(context.json()).toMatchObject({ roomId: target.id, cliPaneId: cliPane.id, cliSessionId: "cli_session:moved-1" });
    // The token still names one pane: another pane's session is refused.
    const otherPane = store.createPane({ roomId: target.id, title: "Other", mode: "TERMINAL" });
    const forged = issueCliBrowserBridgeToken(config, { roomId: target.id, paneId: otherPane.id, cliSessionId: "cli_session:moved-1" })!;
    expect((await app.inject({ method: "GET", url: "/api/cli/browser/context", headers: { [cliBrowserBridgeTokenHeader]: forged } })).statusCode).toBe(404);
  });

  it("exposes managed browser actions to CLI sessions only through scoped bridge tokens", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "CLI Browser Bridge", initialPaneCount: 0 });
    const cliPane = store.createPane({ roomId: room.id, title: "Codex CLI", mode: "TERMINAL" });
    const browserPane = store.createPane({ roomId: room.id, title: "Browser 1", mode: "BROWSER" });
    const otherRoom = store.createRoom({ name: "Other", initialPaneCount: 0 });
    const otherBrowserPane = store.createPane({ roomId: otherRoom.id, title: "Other Browser", mode: "BROWSER" });
    const cliSession = store.createPaneCliSession({
      sessionId: "cli_session:bridge-1",
      paneId: cliPane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: null,
      reasoningEffort: "medium",
      cwd: "/opt/spaceapp/var/artifacts/cli-workspaces/test",
      status: "RUNNING",
      statusReason: "CLI running.",
      isActive: true
    });
    const rawSensitiveValue = "raw-cli-browser-secret";
    const sensitiveUrl = `https://www.google.com/?token=${rawSensitiveValue}&category=parts`;
    store.createPaneBrowserSession({
      sessionId: "browser_session:bridge-1",
      paneId: browserPane.id,
      roomId: room.id,
      ownerAgentId: "agent:1",
      agentNumber: 1,
      profileId: "profile:bridge-1",
      profilePath: "/opt/spaceapp/var/artifacts/browser-profiles/secret-profile-path",
      viewport: "desktop",
      targetUrl: "https://www.google.com/",
      currentUrl: sensitiveUrl,
      title: "Olla token raw-title-secret",
      status: "READY",
      isActive: true
    });
    const captureArtifact = store.createArtifact({
      roomId: room.id,
      paneId: browserPane.id,
      kind: "VIDEO",
      mimeType: "video/webm",
      storageUri: "space-artifact://browser-evidence/bridge-1/recording.webm",
      sha256: "a".repeat(64),
      byteSize: 4096,
      metadata: { source: "BROWSER_CAPTURE_JOB", browserCaptureJobId: "browser_capture_job:test" },
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }).artifact;
    const config = getApiConfig({
      SPACE_BROWSER_SESSIONS_ENABLED: "true",
      SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true",
      SPACE_INTERNAL_API_TOKEN: "test-internal-token"
    });
    const token = issueCliBrowserBridgeToken(config, {
      roomId: room.id,
      paneId: cliPane.id,
      cliSessionId: cliSession.sessionId
    });
    const bridgeToken = token ?? "";
    expect(token).toMatch(/^clibrowser\.v1\./);
    const { app, cookie } = await authedApp({
      store,
      config,
      browserSessionManager: fakeBrowserSessionManager({ enabled: true })
    });

    const missingToken = await app.inject({
      method: "GET",
      url: "/api/cli/browser/context"
    });
    expect(missingToken.statusCode).toBe(401);
    expect(missingToken.json().error.code).toBe("CLI_BROWSER_TOKEN_INVALID");

    const startedSession = await app.inject({
      method: "POST",
      url: "/api/cli/browser/session",
      headers: {
        [cliBrowserBridgeTokenHeader]: bridgeToken,
        "content-type": "application/json"
      },
      payload: {
        targetPaneId: browserPane.id,
        targetUrl: sensitiveUrl,
        streamMode: "SILENT"
      }
    });
    expect(startedSession.statusCode).toBe(200);
    expect(startedSession.json()).toMatchObject({
      session: {
        paneId: browserPane.id,
        currentUrl: "https://www.google.com/?token=%5BREDACTED%5D&category=parts",
        viewport: "desktop",
        streamMode: "SILENT",
        resolvedStreamMode: "SILENT",
        controlState: "UNCONTROLLED",
        pageCount: 1
      }
    });
    expect(JSON.stringify(startedSession.json())).not.toContain(rawSensitiveValue);
    expect(JSON.stringify(startedSession.json())).not.toMatch(/profilePath|screenshotDataUrl|websocket|cookie|localStorage/i);

    const context = await app.inject({
      method: "GET",
      url: "/api/cli/browser/context",
      headers: { [cliBrowserBridgeTokenHeader]: bridgeToken }
    });
    expect(context.statusCode).toBe(200);
    expect(context.json()).toMatchObject({
      roomId: room.id,
      cliPaneId: cliPane.id,
      cliSessionId: cliSession.sessionId,
      browserSessions: [
        expect.objectContaining({
          sessionId: "browser_session:bridge-1",
          paneId: browserPane.id,
          currentUrl: "https://www.google.com/?token=%5BREDACTED%5D&category=parts"
        })
      ]
    });
    expect(JSON.stringify(context.json())).not.toContain(rawSensitiveValue);
    expect(JSON.stringify(context.json())).not.toMatch(/profilePath|screenshotDataUrl|websocket|cookie|localStorage/i);

    const runBrowserCommand = (command: Record<string, unknown>, targetPaneId = browserPane.id) => app.inject({
      method: "POST",
      url: "/api/cli/browser/commands",
      headers: {
        [cliBrowserBridgeTokenHeader]: bridgeToken,
        "content-type": "application/json"
      },
      payload: { targetPaneId, command }
    });

    const devtoolsCommand = await runBrowserCommand({ type: "DEVTOOLS", includeNetwork: true, limit: 10 });
    expect(devtoolsCommand.statusCode).toBe(200);
    expect(devtoolsCommand.json()).toMatchObject({ sessionId: expect.any(String), events: expect.any(Array) });
    const forbiddenDevtools = await runBrowserCommand({ type: "DEVTOOLS" }, otherBrowserPane.id);
    expect(forbiddenDevtools.statusCode).toBe(404);
    const invalidDevtools = await runBrowserCommand({ type: "DEVTOOLS", limit: 501 });
    expect(invalidDevtools.statusCode).toBe(422);

    const pagesCommand = await runBrowserCommand({ type: "LIST_PAGES" });
    expect(pagesCommand.statusCode).toBe(200);
    expect(pagesCommand.json()).toMatchObject({ activePageId: "page:main" });

    const createdPage = await runBrowserCommand({ type: "CREATE_PAGE", url: "https://example.com/", activate: true });
    expect(createdPage.statusCode).toBe(200);
    expect(createdPage.json()).toMatchObject({ activePageId: "page:2" });
    const activatedPage = await runBrowserCommand({ type: "ACTIVATE_PAGE", pageId: "page:main" });
    expect(activatedPage.statusCode).toBe(200);
    expect(activatedPage.json()).toMatchObject({ activePageId: "page:main" });
    const closedPage = await runBrowserCommand({ type: "CLOSE_PAGE", pageId: "page:2" });
    expect(closedPage.statusCode).toBe(200);
    expect(closedPage.json().pages).toHaveLength(1);

    const streamModeCommand = await runBrowserCommand({ type: "SET_STREAM_MODE", streamMode: "REALTIME" });
    expect(streamModeCommand.statusCode).toBe(200);
    expect(streamModeCommand.json().session).toMatchObject({ streamMode: "REALTIME", resolvedStreamMode: "REALTIME" });
    expect(streamModeCommand.json().frame).toBeUndefined();

    const startedCapture = await runBrowserCommand({ type: "START_CAPTURE", kind: "RECORDING", durationMs: 30_000 });
    expect(startedCapture.statusCode).toBe(200);
    expect(startedCapture.json().job).toMatchObject({ status: "QUEUED", options: { kind: "RECORDING", maxDurationMs: 30_000 } });
    const captureStatusCommand = await runBrowserCommand({ type: "CAPTURE_STATUS", jobId: "browser_capture_job:test" });
    expect(captureStatusCommand.statusCode).toBe(200);
    expect(captureStatusCommand.json().job.status).toBe("QUEUED");
    const stoppedCapture = await runBrowserCommand({ type: "STOP_CAPTURE", jobId: "browser_capture_job:test" });
    expect(stoppedCapture.statusCode).toBe(200);
    expect(stoppedCapture.json().job.status).toBe("COMPLETED");
    await runBrowserCommand({ type: "START_CAPTURE", kind: "RECORDING" });
    const cancelledCapture = await runBrowserCommand({ type: "CANCEL_CAPTURE", jobId: "browser_capture_job:test" });
    expect(cancelledCapture.statusCode).toBe(200);
    expect(cancelledCapture.json().job.status).toBe("CANCELLED");

    const listedArtifacts = await runBrowserCommand({ type: "LIST_ARTIFACTS" });
    expect(listedArtifacts.statusCode).toBe(200);
    expect(listedArtifacts.json().artifacts).toEqual([expect.objectContaining({ id: captureArtifact.id })]);
    const pinnedArtifact = await runBrowserCommand({ type: "PIN_ARTIFACT", artifactId: captureArtifact.id });
    expect(pinnedArtifact.statusCode).toBe(200);
    expect(pinnedArtifact.json().artifact).toMatchObject({ id: captureArtifact.id, expiresAt: null, pinnedAt: expect.any(String) });
    const unpinnedArtifact = await runBrowserCommand({ type: "UNPIN_ARTIFACT", artifactId: captureArtifact.id });
    expect(unpinnedArtifact.statusCode).toBe(200);
    expect(unpinnedArtifact.json().artifact).toMatchObject({ id: captureArtifact.id, pinnedAt: null, expiresAt: expect.any(String) });

    const crossRoomCommand = await runBrowserCommand({ type: "LIST_PAGES" }, otherBrowserPane.id);
    expect(crossRoomCommand.statusCode).toBe(404);
    expect(crossRoomCommand.json().error.message).toContain("was not found in room");

    const handoffCommand = await runBrowserCommand({
      type: "REQUEST_HANDOFF",
      kind: "CAPTCHA",
      reason: "Complete the verification challenge"
    });
    expect(handoffCommand.statusCode).toBe(200);
    expect(handoffCommand.json()).toMatchObject({
      handoff: {
        paneId: browserPane.id,
        status: "REQUESTED",
        requestedByType: "AGENT",
        requestedById: `cli:${cliSession.sessionId}`
      }
    });
    expect((await store.listEvents(room.id)).some((event) => event.type === "BROWSER_HANDOFF_REQUESTED")).toBe(true);
    // The operator gets 30 minutes to reach the pane (a login on the phone takes longer than five).
    const handoffLifetime = Date.parse(handoffCommand.json().handoff.expiresAt) - Date.parse(handoffCommand.json().handoff.requestedAt);
    expect(handoffLifetime).toBe(1800 * 1000);
    // The agent learns the operator's local time; no working zone is set here, so nothing is held.
    expect(handoffCommand.json().operator).toMatchObject({ localTime: expect.any(String), quiet: false, heldUntil: null });

    const handoffStatus = await runBrowserCommand({ type: "HANDOFF_STATUS" });
    expect(handoffStatus.statusCode).toBe(200);
    expect(handoffStatus.json()).toMatchObject({ handoff: { status: "REQUESTED" } });

    // The agent withdraws its own untaken request; the overlay (REQUESTED/ACCEPTED only) goes away.
    const cancelledHandoff = await runBrowserCommand({ type: "CANCEL_HANDOFF" });
    expect(cancelledHandoff.statusCode).toBe(200);
    expect(cancelledHandoff.json()).toMatchObject({ cancelled: true, handoff: { status: "CANCELLED", cancelledAt: expect.any(String) } });
    expect((await runBrowserCommand({ type: "HANDOFF_STATUS" })).json()).toMatchObject({ handoff: { status: "CANCELLED" } });
    expect((await runBrowserCommand({ type: "CANCEL_HANDOFF" })).json()).toMatchObject({ cancelled: false, handoff: null });
    // Another agent's request is not this agent's to withdraw.
    const otherAgentHandoff = await store.createBrowserHandoffRequest({
      sessionId: handoffCommand.json().handoff.sessionId, paneId: browserPane.id, roomId: room.id,
      requestedByType: "AGENT", requestedById: "cli:cli_session:another-agent", reason: "LOGIN: another agent", ttlSeconds: 300
    });
    expect((await runBrowserCommand({ type: "CANCEL_HANDOFF" })).json()).toMatchObject({ cancelled: false, handoff: { status: "REQUESTED" } });
    await store.updateBrowserHandoffRequest(otherAgentHandoff.handoffRequestId, { status: "CANCELLED" });

    const actions = await app.inject({
      method: "POST",
      url: "/api/cli/browser/actions",
      headers: {
        [cliBrowserBridgeTokenHeader]: bridgeToken,
        "content-type": "application/json"
      },
      payload: {
        actions: [
          {
            toolId: "browser:navigate",
            targetPaneId: browserPane.id,
            action: { type: "navigate", url: sensitiveUrl }
          },
          {
            toolId: "browser:diagnostics",
            targetPaneId: browserPane.id,
            action: { type: "diagnostics", includeNetwork: true, limit: 20 }
          },
          {
            toolId: "browser:record",
            targetPaneId: browserPane.id,
            action: { type: "record", durationMs: 500, intervalMs: 250, format: "both" }
          }
        ]
      }
    });
    const failedActions = await app.inject({
      method: "POST",
      url: "/api/cli/browser/actions",
      headers: {
        [cliBrowserBridgeTokenHeader]: bridgeToken,
        "content-type": "application/json"
      },
      payload: {
        actions: [
          {
            toolId: "browser:extract_text",
            targetPaneId: otherBrowserPane.id,
            action: { type: "extract_text" }
          },
        ]
      }
    });
    expect(actions.statusCode).toBe(200);
    expect(actions.json().results).toEqual([
      expect.objectContaining({
        status: "EXECUTED",
        observation: expect.objectContaining({
          paneId: browserPane.id,
          currentUrl: "https://www.google.com/?token=%5BREDACTED%5D&category=parts"
        })
      }),
      expect.objectContaining({
        status: "EXECUTED",
        observation: expect.objectContaining({
          actionType: "diagnostics",
          text: expect.stringContaining("bridge console ok")
        })
      }),
      expect.objectContaining({
        status: "EXECUTED",
        observation: expect.objectContaining({
          actionType: "record",
          text: expect.stringContaining("browser-recordings")
        })
      })
    ]);
    // The browser's corner label names the CLI pane that drove it and its room (operator 2026-10-20).
    const pagesWithAgent = await app.inject({ method: "GET", url: `/api/panes/${encodeURIComponent(browserPane.id)}/browser/pages`, headers: { cookie } });
    expect(pagesWithAgent.json().agent).toEqual({ paneId: cliPane.id, title: "Codex CLI", paneName: cliPane.paneName ?? null, roomId: room.id, roomName: "CLI Browser Bridge",
      drivenAt: expect.any(String), active: true });
    expect(failedActions.statusCode).toBe(200);
    expect(failedActions.json().results).toEqual([
      expect.objectContaining({
        status: "FAILED",
        observation: null,
        statusReason: expect.stringContaining("was not found in room")
      })
    ]);
    // A Browser Host started before press and masked_screenshot ignores them (no text): the agent is told, nothing is captured.
    const oldHost = await app.inject({ method: "POST", url: "/api/cli/browser/actions", headers: { [cliBrowserBridgeTokenHeader]: bridgeToken, "content-type": "application/json" },
      payload: { actions: [{ toolId: "browser:press", targetPaneId: browserPane.id, action: { type: "press", key: "Enter" } },
        { toolId: "browser:masked_screenshot", targetPaneId: browserPane.id, action: { type: "masked_screenshot" } }] } });
    expect(oldHost.json().results).toEqual([
      expect.objectContaining({ status: "FAILED", statusReason: expect.stringContaining("needs the Browser Host restart") }),
      expect.objectContaining({ status: "FAILED", statusReason: expect.stringContaining("needs the Browser Host restart") })
    ]);
    expect(JSON.stringify(actions.json())).not.toContain(rawSensitiveValue);
    expect(JSON.stringify(actions.json())).not.toMatch(/profilePath|screenshotDataUrl|websocket|cookie|localStorage|test-internal-token/i);
    expect(JSON.stringify(failedActions.json())).not.toContain(rawSensitiveValue);
    expect(JSON.stringify(failedActions.json())).not.toMatch(/profilePath|screenshotDataUrl|websocket|cookie|localStorage|test-internal-token/i);

    const auditResponse = await app.inject({
      method: "GET",
      url: "/api/admin/audit?pageSize=100",
      headers: { cookie }
    });
    expect(auditResponse.statusCode).toBe(200);
    expect(JSON.stringify(auditResponse.json())).not.toContain(rawSensitiveValue);
    expect(JSON.stringify(auditResponse.json())).not.toContain("test-internal-token");
    expect(auditResponse.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "pane.cli.browser_context" }),
        expect.objectContaining({ action: "pane.cli.browser_session" }),
        expect.objectContaining({ action: "pane.cli.browser_action.executed" }),
        expect.objectContaining({ action: "pane.cli.browser_action.failed" }),
        expect.objectContaining({ action: "pane.cli.browser_command" })
      ])
    );
  });

  it("manages browser bookmarks inside the active Space Chrome profile", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Browser Bookmarks", initialPaneCount: 0 });
    const browserPane = store.createPane({ roomId: room.id, title: "Browser 1", mode: "BROWSER" });
    const profilePath = await mkdtemp(join(tmpdir(), "space-browser-bookmarks-"));
    const sensitiveQueryKey = "tok" + "en";
    const sensitiveUrl = `https://www.example.com/?${sensitiveQueryKey}=raw-bookmark-value&category=parts`;
    const allowedImportUrl = "https://www.example.com/imported?debug=raw-import-value";
    store.createPaneBrowserSession({
      sessionId: "browser_session:bookmark-1",
      paneId: browserPane.id,
      roomId: room.id,
      ownerAgentId: "agent:1",
      agentNumber: 1,
      profileId: "profile:bookmark-1",
      profilePath,
      viewport: "desktop",
      targetUrl: "https://www.example.com/",
      currentUrl: sensitiveUrl,
      title: "Olla Parts",
      status: "READY",
      isActive: true
    });
    const { app, cookie, csrfToken } = await authedApp({
      store,
      config: getApiConfig({
        SPACE_BROWSER_SESSIONS_ENABLED: "true",
        SPACE_ARTIFACT_ROOT: profilePath
      }),
      browserSessionManager: fakeBrowserSessionManager({ enabled: true })
    });

    const empty = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(browserPane.id)}/browser/bookmarks`,
      headers: { cookie }
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({
      sessionId: "browser_session:bookmark-1",
      paneId: browserPane.id,
      bookmarks: []
    });

    const added = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(browserPane.id)}/browser/bookmarks`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {}
    });
    expect(added.statusCode).toBe(200);
    expect(added.json().bookmarks).toEqual([
      expect.objectContaining({
        id: "4",
        title: "Olla Parts",
        url: sensitiveUrl
      })
    ]);

    const opened = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(browserPane.id)}/browser/bookmarks/open`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { bookmarkId: "4" }
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.json().session).toMatchObject({
      paneId: browserPane.id,
      currentUrl: sensitiveUrl
    });

    const importFile = {
      roots: {
        bookmark_bar: {
          children: [
            { type: "url", id: "10", name: "Duplicate Olla", url: sensitiveUrl },
            { type: "url", id: "11", name: "Example Import", url: allowedImportUrl },
            { type: "url", id: "12", name: "Blocked", url: "ftp://example.com/private" }
          ],
          id: "1",
          name: "Bookmarks bar",
          type: "folder"
        }
      },
      version: 1
    };
    const rejectedImportMultipart = multipartImagePayload([
      { filename: "Bookmarks", mimeType: "application/json", body: Buffer.from(JSON.stringify(importFile)) }
    ]);
    const rejectedImport = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(browserPane.id)}/browser/bookmarks/import`,
      headers: { cookie, "content-type": rejectedImportMultipart.contentType },
      payload: rejectedImportMultipart.payload
    });
    expect(rejectedImport.statusCode).toBe(403);

    const acceptedImportMultipart = multipartImagePayload([
      { filename: "Bookmarks", mimeType: "application/json", body: Buffer.from(JSON.stringify(importFile)) }
    ]);
    const imported = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(browserPane.id)}/browser/bookmarks/import`,
      headers: { cookie, [csrfHeaderName]: csrfToken, "content-type": acceptedImportMultipart.contentType },
      payload: acceptedImportMultipart.payload
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toMatchObject({
      importedCount: 1,
      skippedCount: 2
    });
    expect(imported.json().bookmarks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Example Import",
          url: allowedImportUrl
        })
      ])
    );

    const exported = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(browserPane.id)}/browser/bookmarks/export`,
      headers: { cookie }
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-disposition"]).toContain("attachment;");
    expect(JSON.parse(exported.body).roots.bookmark_bar.children).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Space imports", type: "folder" })])
    );

    const auditResponse = await app.inject({
      method: "GET",
      url: "/api/admin/audit?pageSize=20",
      headers: { cookie }
    });
    expect(auditResponse.statusCode).toBe(200);
    expect(JSON.stringify(auditResponse.json())).not.toContain("raw-bookmark-value");
    expect(JSON.stringify(auditResponse.json())).not.toContain("raw-import-value");
    expect(auditResponse.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "pane.browser.bookmark.add",
          metadata: expect.objectContaining({ bookmarkId: "4", hostname: "www.example.com" })
        }),
        expect.objectContaining({
          action: "pane.browser.bookmark.open",
          metadata: expect.objectContaining({ bookmarkId: "4", hostname: "www.example.com" })
        }),
        expect.objectContaining({
          action: "pane.browser.bookmark.import",
          metadata: expect.objectContaining({ importedCount: 1, skippedCount: 2, hostnames: ["www.example.com"] })
        }),
        expect.objectContaining({
          action: "pane.browser.bookmark.export",
          metadata: expect.objectContaining({ sessionId: "browser_session:bookmark-1" })
        })
      ])
    );
  });

  it("captures browser evidence smoke as linked room artifacts", async () => {
    const fakeSensitive = "to" + "ken=raw-test-value";
    const { app, cookie, csrfToken } = await authedApp({
      browserEvidenceCapture: async (input) => ({
        captureId: "browser_capture:test-1",
        roomId: input.roomId,
        paneId: input.paneId ?? null,
        viewport: input.viewport,
        targetUrl: input.targetUrl,
        createdAt: "2026-06-26T00:00:00.000Z",
        artifacts: [
          {
            kind: "SCREENSHOT",
            mimeType: "image/png",
            storageUri: `space-artifact://browser-evidence/test/screenshot.png?${fakeSensitive}`,
            sha256: "a".repeat(64),
            byteSize: 2048,
            metadata: { channel: "screenshot", ["sec" + "ret"]: fakeSensitive }
          },
          {
            kind: "DOM_SNAPSHOT",
            mimeType: "application/json",
            storageUri: "space-artifact://browser-evidence/test/dom.json",
            sha256: "b".repeat(64),
            byteSize: 512,
            metadata: { channel: "dom" }
          },
          {
            kind: "CONSOLE_LOG",
            mimeType: "application/json",
            storageUri: "space-artifact://browser-evidence/test/console.json",
            sha256: "c".repeat(64),
            byteSize: 128,
            metadata: { channel: "console" }
          },
          {
            kind: "NETWORK_LOG",
            mimeType: "application/json",
            storageUri: "space-artifact://browser-evidence/test/network.json",
            sha256: "d".repeat(64),
            byteSize: 256,
            metadata: { channel: "network" }
          }
        ]
      })
    });
    const roomResponse = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { name: "Browser Evidence", initialPaneCount: 0 }
    });
    const roomId = roomResponse.json().id as string;

    const saved = await app.inject({
      method: "POST",
      url: "/api/browser/evidence-smoke",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { roomId, viewport: "desktop" }
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      captureId: "browser_capture:test-1",
      roomId,
      paneId: null,
      viewport: "desktop",
      targetUrl: "http://127.0.0.1:4911/"
    });
    expect(saved.json().artifacts.map((artifact: { kind: string }) => artifact.kind)).toEqual([
      "SCREENSHOT",
      "DOM_SNAPSHOT",
      "CONSOLE_LOG",
      "NETWORK_LOG"
    ]);
    expect(JSON.stringify(saved.json())).not.toContain("raw-test-value");

    const list = await app.inject({
      method: "GET",
      url: `/api/artifacts?roomId=${encodeURIComponent(roomId)}`,
      headers: { cookie }
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().pagination.totalItems).toBe(4);

    const events = await app.inject({
      method: "GET",
      url: `/api/events?roomId=${encodeURIComponent(roomId)}`,
      headers: { cookie }
    });
    expect(events.statusCode).toBe(200);
    expect(events.json().data.filter((event: { type: string }) => event.type === "ARTIFACT_CREATED")).toHaveLength(4);

    const auditResponse = await app.inject({
      method: "GET",
      url: "/api/admin/audit?pageSize=10",
      headers: { cookie }
    });
    expect(auditResponse.statusCode).toBe(200);
    expect(JSON.stringify(auditResponse.json())).not.toContain("raw-test-value");
    expect(auditResponse.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "browser.evidence_smoke",
          targetId: roomId,
          metadata: expect.objectContaining({ viewport: "desktop", artifactCount: 4 })
        })
      ])
    );
  });

  it("records auth and mutation audit events without storing passwords", async () => {
    const app = await createApp({
      auth: {
        sessionSecret: "test-secret-with-enough-length",
        devLogin: true,
        secureCookies: false
      }
    });

    const failedLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "space@space.local", password: "definitely-wrong" }
    });
    expect(failedLogin.statusCode).toBe(401);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "space@space.local", password: "space-dev" }
    });
    const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
    const csrf = await app.inject({
      method: "GET",
      url: "/api/auth/csrf",
      headers: { cookie }
    });
    const csrfToken = csrf.json().csrfToken as string;

    const roomResponse = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { name: "Audited Room", initialPaneCount: 0 }
    });
    expect(roomResponse.statusCode).toBe(200);

    const auditResponse = await app.inject({
      method: "GET",
      url: "/api/admin/audit?pageSize=10",
      headers: { cookie }
    });

    expect(auditResponse.statusCode).toBe(200);
    const auditEvents = auditResponse.json().data as Array<{ action: string; metadata: unknown }>;
    expect(auditEvents.map((event) => event.action)).toEqual(
      expect.arrayContaining(["auth.login.failed", "auth.login.succeeded", "room.create"])
    );
    expect(JSON.stringify(auditEvents)).not.toContain("definitely-wrong");
    expect(auditEvents.find((event) => event.action === "auth.login.failed")?.metadata).toEqual({ result: "failed" });
  });

  it("persists authenticated signed-session actors before audited mutations", async () => {
    const sessionSecret = "test-secret-with-enough-length";
    const store = new AuditFkCheckingStore();
    store.upsertUser({ id: "user:existing-operator", email: "operator@example.test", role: "ADMIN" });
    const app = await createApp({
      store,
      auth: {
        sessionSecret,
        devLogin: false,
        operatorEmail: "operator@example.test",
        operatorPasswordHash: "unused-for-signed-session-test",
        secureCookies: false
      }
    });
    const cookie = `space_session=${signSession(
      { id: "user:operator", email: "operator@example.test", role: "ADMIN" },
      sessionSecret
    )}`;
    const csrf = await app.inject({
      method: "GET",
      url: "/api/auth/csrf",
      headers: { cookie }
    });
    expect(csrf.statusCode).toBe(200);

    const roomResponse = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { cookie, [csrfHeaderName]: csrf.json().csrfToken },
      payload: { name: "Signed Cookie Room", initialPaneCount: 0 }
    });

    expect(roomResponse.statusCode).toBe(200);
    const auditResponse = await app.inject({
      method: "GET",
      url: "/api/admin/audit?pageSize=10",
      headers: { cookie }
    });
    const auditEvents = auditResponse.json().data as Array<{ action: string; actorUserId: string | null }>;
    expect(auditEvents).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "room.create", actorUserId: "user:existing-operator" })])
    );
  });

  it("stores and mutates clipboard history only for the authenticated owner", async () => {
    const sessionSecret = "test-secret-with-enough-length";
    const store = new InMemorySpaceStore();
    const { app, cookie, csrfToken } = await authedApp({ store });

    const created = await app.inject({
      method: "POST",
      url: "/api/clipboard-items",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { text: "private fallback", source: "COPY" }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ text: "private fallback", source: "COPY", occurrenceCount: 1 });
    expect(created.json()).not.toHaveProperty("ownerUserId");

    const forgedOwner = await app.inject({
      method: "POST",
      url: "/api/clipboard-items",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { text: "forged", source: "MANUAL_NOTE", ownerUserId: "user:other" }
    });
    expect(forgedOwner.statusCode).toBe(422);

    const forgedSource = await app.inject({
      method: "POST",
      url: "/api/clipboard-items",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { text: "forged agent note", source: "AGENT_NOTE" }
    });
    expect(forgedSource.statusCode).toBe(422);

    const planMissingModel = await app.inject({
      method: "POST",
      url: "/api/clipboard-items",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { text: "full designed plan", source: "PLAN", title: "Plan title" }
    });
    expect(planMissingModel.statusCode).toBe(422);

    const planCreated = await app.inject({
      method: "POST",
      url: "/api/clipboard-items",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { text: "full designed plan", source: "PLAN", title: "Plan title", minimumModel: "gpt-5.6-sol", minimumReasoning: "high" }
    });
    expect(planCreated.statusCode).toBe(201);
    expect(planCreated.json()).toMatchObject({ text: "full designed plan", source: "PLAN", title: "Plan title", minimumModel: "gpt-5.6-sol", minimumReasoning: "high" });

    const modelOnCopy = await app.inject({
      method: "POST",
      url: "/api/clipboard-items",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { text: "model on copy", source: "COPY", minimumModel: "gpt-5.6-sol" }
    });
    expect(modelOnCopy.statusCode).toBe(422);

    const titleOnCopy = await app.inject({
      method: "POST",
      url: "/api/clipboard-items",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { text: "titled copy", source: "COPY", title: "Blocked" }
    });
    expect(titleOnCopy.statusCode).toBe(422);

    const firstList = await app.inject({
      method: "GET",
      url: "/api/clipboard-items?q=fallback&source=COPY&page=1&pageSize=25",
      headers: { cookie }
    });
    expect(firstList.statusCode).toBe(200);
    expect(firstList.json()).toMatchObject({
      data: [{ id: created.json().id, text: "private fallback" }],
      pagination: { page: 1, pageSize: 25, totalItems: 1, totalPages: 1 }
    });

    const otherToken = signSession(
      { id: "user:other", email: "other@space.local", role: "OPERATOR" },
      sessionSecret
    );
    const otherCookie = `space_session=${otherToken}`;
    const otherCsrf = createCsrfToken(otherToken, sessionSecret)!;
    const otherEmptyList = await app.inject({
      method: "GET",
      url: "/api/clipboard-items",
      headers: { cookie: otherCookie }
    });
    expect(otherEmptyList.json().pagination.totalItems).toBe(0);

    const otherCreated = await app.inject({
      method: "POST",
      url: "/api/clipboard-items",
      headers: { cookie: otherCookie, [csrfHeaderName]: otherCsrf },
      payload: { text: "other private note", source: "MANUAL_NOTE" }
    });
    expect(otherCreated.statusCode).toBe(201);

    const crossOwnerDelete = await app.inject({
      method: "DELETE",
      url: `/api/clipboard-items/${encodeURIComponent(otherCreated.json().id)}`,
      headers: { cookie, [csrfHeaderName]: csrfToken }
    });
    expect(crossOwnerDelete.statusCode).toBe(404);

    const cleared = await app.inject({
      method: "DELETE",
      url: "/api/clipboard-items",
      headers: { cookie, [csrfHeaderName]: csrfToken }
    });
    expect(cleared).toMatchObject({ statusCode: 200 });
    expect(cleared.json()).toEqual({ deletedCount: 2 });

    const otherList = await app.inject({
      method: "GET",
      url: "/api/clipboard-items",
      headers: { cookie: otherCookie }
    });
    expect(otherList.json().pagination.totalItems).toBe(1);
  });

  it("canonicalizes broker-signed Clipboard owners for create, list, delete, and clear", async () => {
    const sessionSecret = "test-secret-with-enough-length";
    const store = new InMemorySpaceStore();
    const canonicalOwner = store.upsertUser({
      id: "user:existing-operator",
      email: "space@space.local",
      role: "ADMIN"
    });
    const app = await createApp({
      store,
      auth: {
        sessionSecret,
        devLogin: false,
        operatorEmail: canonicalOwner.email,
        operatorPasswordHash: "unused-for-broker-session-test",
        secureCookies: false
      }
    });
    const brokerToken = signSessionWithTtl(
      { id: "user:operator-proof", email: canonicalOwner.email, role: "ADMIN" },
      sessionSecret,
      600
    );
    const brokerCookie = `space_session=${brokerToken}`;
    const brokerCsrf = createCsrfToken(brokerToken, sessionSecret)!;
    const otherToken = signSession(
      { id: "user:other", email: "other@space.local", role: "OPERATOR" },
      sessionSecret
    );
    const otherCookie = `space_session=${otherToken}`;
    const otherCsrf = createCsrfToken(otherToken, sessionSecret)!;

    const deleteCandidate = await app.inject({
      method: "POST",
      url: "/api/clipboard-items",
      headers: { cookie: brokerCookie, [csrfHeaderName]: brokerCsrf },
      payload: { text: "broker item to delete", source: "COPY" }
    });
    const clearCandidate = await app.inject({
      method: "POST",
      url: "/api/clipboard-items",
      headers: { cookie: brokerCookie, [csrfHeaderName]: brokerCsrf },
      payload: { text: "broker item to clear", source: "MANUAL_NOTE" }
    });
    const otherCreated = await app.inject({
      method: "POST",
      url: "/api/clipboard-items",
      headers: { cookie: otherCookie, [csrfHeaderName]: otherCsrf },
      payload: { text: "other owner item", source: "COPY" }
    });
    expect([deleteCandidate.statusCode, clearCandidate.statusCode, otherCreated.statusCode]).toEqual([201, 201, 201]);
    expect(store.listClipboardItems(canonicalOwner.id).items.map((item) => item.id)).toEqual([
      clearCandidate.json().id,
      deleteCandidate.json().id
    ]);
    expect(store.listClipboardItems("user:operator-proof").total).toBe(0);

    const brokerList = await app.inject({
      method: "GET",
      url: "/api/clipboard-items",
      headers: { cookie: brokerCookie }
    });
    expect(brokerList.statusCode).toBe(200);
    expect(brokerList.json().data.map((item: { id: string }) => item.id)).toEqual([
      clearCandidate.json().id,
      deleteCandidate.json().id
    ]);

    const completed = await app.inject({
      method: "PATCH",
      url: `/api/clipboard-items/${encodeURIComponent(clearCandidate.json().id)}`,
      headers: { cookie: brokerCookie, [csrfHeaderName]: brokerCsrf },
      payload: { completed: true }
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ id: clearCandidate.json().id, isCompleted: true });

    const progressUpdate = await app.inject({
      method: "PATCH",
      url: `/api/clipboard-items/${encodeURIComponent(deleteCandidate.json().id)}/progress`,
      headers: { cookie: brokerCookie, [csrfHeaderName]: brokerCsrf },
      payload: {
        executionStatus: "IN_PROGRESS",
        stepUpdate: {
          stepIdOrOrder: 1,
          status: "COMPLETED",
          progress: 100,
          agent: "antigravity",
          proof: "test passed"
        }
      }
    });
    expect(progressUpdate.statusCode).toBe(200);
    expect(progressUpdate.json()).toMatchObject({
      id: deleteCandidate.json().id,
      executionStatus: "COMPLETED",
      progressPercentage: 100,
      isCompleted: true
    });

    const hiddenList = await app.inject({
      method: "GET",
      url: "/api/clipboard-items?includeCompleted=false",
      headers: { cookie: brokerCookie }
    });
    expect(hiddenList.statusCode).toBe(200);
    expect(hiddenList.json().data).toEqual([]);

    const crossOwnerComplete = await app.inject({
      method: "PATCH",
      url: `/api/clipboard-items/${encodeURIComponent(otherCreated.json().id)}`,
      headers: { cookie: brokerCookie, [csrfHeaderName]: brokerCsrf },
      payload: { completed: true }
    });
    expect(crossOwnerComplete.statusCode).toBe(404);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/clipboard-items/${encodeURIComponent(deleteCandidate.json().id)}`,
      headers: { cookie: brokerCookie, [csrfHeaderName]: brokerCsrf }
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ id: deleteCandidate.json().id, deleted: true });

    const crossOwnerDelete = await app.inject({
      method: "DELETE",
      url: `/api/clipboard-items/${encodeURIComponent(otherCreated.json().id)}`,
      headers: { cookie: brokerCookie, [csrfHeaderName]: brokerCsrf }
    });
    expect(crossOwnerDelete.statusCode).toBe(404);

    const cleared = await app.inject({
      method: "DELETE",
      url: "/api/clipboard-items",
      headers: { cookie: brokerCookie, [csrfHeaderName]: brokerCsrf }
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ deletedCount: 1 });

    const brokerListAfterClear = await app.inject({
      method: "GET",
      url: "/api/clipboard-items",
      headers: { cookie: brokerCookie }
    });
    const otherListAfterClear = await app.inject({
      method: "GET",
      url: "/api/clipboard-items",
      headers: { cookie: otherCookie }
    });
    expect(brokerListAfterClear.json().pagination.totalItems).toBe(0);
    expect(otherListAfterClear.json()).toMatchObject({
      data: [{ id: otherCreated.json().id, text: "other owner item" }],
      pagination: { totalItems: 1 }
    });
  });

  it("keeps a plan's dependencies, due date and wait through the progress route and refuses loops (plan map, 2026-10-25)", async () => {
    const sessionSecret = "test-secret-with-enough-length";
    const store = new InMemorySpaceStore();
    const app = await createApp({ store, auth: { sessionSecret, devLogin: false, operatorEmail: "space@space.local", operatorPasswordHash: "unused", secureCookies: false } });
    const token = signSession({ id: "user:planner", email: "planner@space.local", role: "OPERATOR" }, sessionSecret);
    const headers = { cookie: `space_session=${token}`, [csrfHeaderName]: createCsrfToken(token, sessionSecret)! };
    const plan = async (text: string) => (await app.inject({ method: "POST", url: "/api/clipboard-items", headers, payload: { text, source: "PLAN", minimumModel: "claude-opus-5-5" } })).json().id as string;
    const mail = await plan("Fix the mail server");
    const site = await plan("Launch the site");
    const patch = (id: string, payload: unknown) => app.inject({ method: "PATCH", url: `/api/clipboard-items/${encodeURIComponent(id)}/progress`, headers, payload });

    expect((await patch(site, { dependsOn: [site] })).statusCode).toBe(409);
    const linked = await patch(site, { dependsOn: [mail], dueAt: "2026-10-30T09:00:00.000Z", waitsOn: { kind: "THIRD_PARTY", what: "the hosting company" } });
    expect(linked.statusCode).toBe(200);
    expect(linked.json()).toMatchObject({ dependsOn: [mail], dueAt: "2026-10-30T09:00:00.000Z", waitsOn: { kind: "THIRD_PARTY", what: "the hosting company", until: null }, executionStatus: "PLANNED" });
    expect((await patch(mail, { dependsOn: [site] })).statusCode).toBe(409);
    expect((await patch(site, { dependsOn: ["clipboard:nowhere0001"] })).statusCode).toBe(409);
    const cleared = await patch(site, { dueAt: null, waitsOn: null, progressPercentage: 20 });
    expect(cleared.json()).toMatchObject({ dependsOn: [mail], dueAt: null, waitsOn: null, progressPercentage: 20 });
    expect((await app.inject({ method: "GET", url: "/api/clipboard-items?source=PLAN", headers })).json().data.find((item: { id: string }) => item.id === site)).toMatchObject({ dependsOn: [mail] });
  });

  it("stores and mutates task history with a status lifecycle, only for the authenticated owner", async () => {
    const sessionSecret = "test-secret-with-enough-length";
    const store = new InMemorySpaceStore();
    const { app, cookie, csrfToken } = await authedApp({ store });

    const created = await app.inject({
      method: "POST",
      url: "/api/task-items",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { title: "Fix login", objective: "Repair the login flow end to end" }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      title: "Fix login",
      objective: "Repair the login flow end to end",
      status: "OPEN",
      source: "MANUAL",
      occurrenceCount: 1
    });
    expect(created.json()).not.toHaveProperty("ownerUserId");

    const forgedOwner = await app.inject({
      method: "POST",
      url: "/api/task-items",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { title: "forged", objective: "forged", ownerUserId: "user:other" }
    });
    expect(forgedOwner.statusCode).toBe(422);

    const forgedSource = await app.inject({
      method: "POST",
      url: "/api/task-items",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { title: "forged agent", objective: "forged agent task", source: "AGENT" }
    });
    expect(forgedSource.statusCode).toBe(422);

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/task-items/${encodeURIComponent(created.json().id)}`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { status: "RUNNING" }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ status: "RUNNING", objective: "Repair the login flow end to end" });

    const firstList = await app.inject({
      method: "GET",
      url: "/api/task-items?q=login&status=RUNNING&page=1&pageSize=25",
      headers: { cookie }
    });
    expect(firstList.statusCode).toBe(200);
    expect(firstList.json()).toMatchObject({
      data: [{ id: created.json().id, title: "Fix login", status: "RUNNING" }],
      pagination: { page: 1, pageSize: 25, totalItems: 1, totalPages: 1 }
    });

    const single = await app.inject({
      method: "GET",
      url: `/api/task-items/${encodeURIComponent(created.json().id)}`,
      headers: { cookie }
    });
    expect(single.statusCode).toBe(200);
    expect(single.json()).toMatchObject({ id: created.json().id, title: "Fix login" });

    const otherToken = signSession(
      { id: "user:other", email: "other@space.local", role: "OPERATOR" },
      sessionSecret
    );
    const otherCookie = `space_session=${otherToken}`;
    const otherCsrf = createCsrfToken(otherToken, sessionSecret)!;
    const otherEmptyList = await app.inject({
      method: "GET",
      url: "/api/task-items",
      headers: { cookie: otherCookie }
    });
    expect(otherEmptyList.json().pagination.totalItems).toBe(0);

    const otherCreated = await app.inject({
      method: "POST",
      url: "/api/task-items",
      headers: { cookie: otherCookie, [csrfHeaderName]: otherCsrf },
      payload: { title: "Other task", objective: "other private task" }
    });
    expect(otherCreated.statusCode).toBe(201);

    const crossOwnerUpdate = await app.inject({
      method: "PATCH",
      url: `/api/task-items/${encodeURIComponent(otherCreated.json().id)}`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { status: "DONE" }
    });
    expect(crossOwnerUpdate.statusCode).toBe(404);

    const crossOwnerDelete = await app.inject({
      method: "DELETE",
      url: `/api/task-items/${encodeURIComponent(otherCreated.json().id)}`,
      headers: { cookie, [csrfHeaderName]: csrfToken }
    });
    expect(crossOwnerDelete.statusCode).toBe(404);

    const cleared = await app.inject({
      method: "DELETE",
      url: "/api/task-items",
      headers: { cookie, [csrfHeaderName]: csrfToken }
    });
    expect(cleared).toMatchObject({ statusCode: 200 });
    expect(cleared.json()).toEqual({ deletedCount: 1 });

    const otherList = await app.inject({
      method: "GET",
      url: "/api/task-items",
      headers: { cookie: otherCookie }
    });
    expect(otherList.json().pagination.totalItems).toBe(1);
  });

  it("canonicalizes broker-signed Task owners for create, list, update, delete, and clear", async () => {
    const sessionSecret = "test-secret-with-enough-length";
    const store = new InMemorySpaceStore();
    const canonicalOwner = store.upsertUser({
      id: "user:existing-operator",
      email: "space@space.local",
      role: "ADMIN"
    });
    const app = await createApp({
      store,
      auth: {
        sessionSecret,
        devLogin: false,
        operatorEmail: canonicalOwner.email,
        operatorPasswordHash: "unused-for-broker-session-test",
        secureCookies: false
      }
    });
    const brokerToken = signSessionWithTtl(
      { id: "user:operator-proof", email: canonicalOwner.email, role: "ADMIN" },
      sessionSecret,
      600
    );
    const brokerCookie = `space_session=${brokerToken}`;
    const brokerCsrf = createCsrfToken(brokerToken, sessionSecret)!;
    const otherToken = signSession(
      { id: "user:other", email: "other@space.local", role: "OPERATOR" },
      sessionSecret
    );
    const otherCookie = `space_session=${otherToken}`;
    const otherCsrf = createCsrfToken(otherToken, sessionSecret)!;

    const deleteCandidate = await app.inject({
      method: "POST",
      url: "/api/task-items",
      headers: { cookie: brokerCookie, [csrfHeaderName]: brokerCsrf },
      payload: { title: "Delete me", objective: "broker task to delete" }
    });
    const clearCandidate = await app.inject({
      method: "POST",
      url: "/api/task-items",
      headers: { cookie: brokerCookie, [csrfHeaderName]: brokerCsrf },
      payload: { title: "Clear me", objective: "broker task to clear" }
    });
    const otherCreated = await app.inject({
      method: "POST",
      url: "/api/task-items",
      headers: { cookie: otherCookie, [csrfHeaderName]: otherCsrf },
      payload: { title: "Other", objective: "other owner task" }
    });
    expect([deleteCandidate.statusCode, clearCandidate.statusCode, otherCreated.statusCode]).toEqual([201, 201, 201]);
    expect(store.listTaskItems(canonicalOwner.id).items.map((item) => item.id)).toEqual([
      clearCandidate.json().id,
      deleteCandidate.json().id
    ]);
    expect(store.listTaskItems("user:operator-proof").total).toBe(0);

    const brokerList = await app.inject({
      method: "GET",
      url: "/api/task-items",
      headers: { cookie: brokerCookie }
    });
    expect(brokerList.statusCode).toBe(200);
    expect(brokerList.json().data.map((item: { id: string }) => item.id)).toEqual([
      clearCandidate.json().id,
      deleteCandidate.json().id
    ]);

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/task-items/${encodeURIComponent(deleteCandidate.json().id)}`,
      headers: { cookie: brokerCookie, [csrfHeaderName]: brokerCsrf },
      payload: { status: "DONE" }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ status: "DONE" });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/task-items/${encodeURIComponent(deleteCandidate.json().id)}`,
      headers: { cookie: brokerCookie, [csrfHeaderName]: brokerCsrf }
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ id: deleteCandidate.json().id, deleted: true });

    const crossOwnerDelete = await app.inject({
      method: "DELETE",
      url: `/api/task-items/${encodeURIComponent(otherCreated.json().id)}`,
      headers: { cookie: brokerCookie, [csrfHeaderName]: brokerCsrf }
    });
    expect(crossOwnerDelete.statusCode).toBe(404);

    const cleared = await app.inject({
      method: "DELETE",
      url: "/api/task-items",
      headers: { cookie: brokerCookie, [csrfHeaderName]: brokerCsrf }
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ deletedCount: 1 });

    const brokerListAfterClear = await app.inject({
      method: "GET",
      url: "/api/task-items",
      headers: { cookie: brokerCookie }
    });
    const otherListAfterClear = await app.inject({
      method: "GET",
      url: "/api/task-items",
      headers: { cookie: otherCookie }
    });
    expect(brokerListAfterClear.json().pagination.totalItems).toBe(0);
    expect(otherListAfterClear.json()).toMatchObject({
      data: [{ id: otherCreated.json().id, title: "Other" }],
      pagination: { totalItems: 1 }
    });
  });

  it("canonicalizes signed link owners for update and delete while rejecting another user", async () => {
    const sessionSecret = "test-secret-with-enough-length";
    const store = new InMemorySpaceStore();
    const owner = store.upsertUser({ id: "user:existing-operator", email: "operator@example.test", role: "ADMIN" });
    const app = await createApp({ store, auth: { sessionSecret, devLogin: false, operatorEmail: owner.email, operatorPasswordHash: "unused", secureCookies: false } });
    const token = signSessionWithTtl({ id: "user:operator-proof", email: owner.email, role: "ADMIN" }, sessionSecret, 600);
    const headers = { cookie: `space_session=${token}`, [csrfHeaderName]: createCsrfToken(token, sessionSecret)! };
    const created = await app.inject({ method: "POST", url: "/api/links", headers, payload: { title: "Music proof", url: "https://example.test/music", category: "MUSIC_LIBRARY" } });
    expect(created.statusCode).toBe(201);
    const path = `/api/links/${encodeURIComponent(created.json().id)}`;
    const updated = await app.inject({ method: "PATCH", url: path, headers, payload: { title: "Updated music proof" } });
    expect(updated.statusCode).toBe(200);
    const other = signSession({ id: "user:other", email: "other@example.test", role: "OPERATOR" }, sessionSecret);
    const denied = await app.inject({ method: "DELETE", url: path, headers: { cookie: `space_session=${other}`, [csrfHeaderName]: createCsrfToken(other, sessionSecret)! } });
    expect(denied.statusCode).toBe(404);
    const deleted = await app.inject({ method: "DELETE", url: path, headers });
    expect(deleted.statusCode).toBe(200);
    const inspected = await app.inject({ method: "GET", url: "/api/links/inspect?url=https://status.openai.com/", headers });
    expect(inspected.statusCode).toBe(200);
    expect(inspected.json()).toMatchObject({ url: "https://status.openai.com/", openMode: "NEW_TAB", canEmbed: false });

    await app.close();
  });

  it("keeps YouTube links that play in the YouTube pane embedded when oEmbed gives no title", async () => {
    const { app, cookie } = await authedApp({ store: new InMemorySpaceStore() });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("Not found", { status: 404 }));
    vi.mocked(fetchPublicUrl).mockImplementation(async (url) => ({ url, status: 200, ok: true, text: "<title>YouTube</title>",
      headers: { "content-type": "text/html", "x-frame-options": "SAMEORIGIN" } }));
    try {
      const inspect = async (url: string) => (await app.inject({ method: "GET", url: `/api/links/inspect?url=${encodeURIComponent(url)}`, headers: { cookie } })).json();
      expect(await inspect("https://www.youtube.com/playlist?list=PL123")).toMatchObject({ openMode: "EMBEDDED", canEmbed: true });
      // music.youtube.com opens in a frame, not the YouTube pane, so its frame headers still decide.
      expect(await inspect("https://music.youtube.com/playlist?list=PL123")).toMatchObject({ openMode: "NEW_TAB", canEmbed: false });
    } finally {
      fetchMock.mockRestore();
      vi.mocked(fetchPublicUrl).mockReset();
      await app.close();
    }
  });

  it("never fetches private or local URLs for link previews or Live fetch-url", async () => {
    const { app, cookie, csrfToken } = await authedApp({ store: new InMemorySpaceStore() });
    try {
      const inspected = await app.inject({ method: "GET", url: `/api/links/inspect?url=${encodeURIComponent("http://169.254.169.254/latest/meta-data/")}`, headers: { cookie } });
      expect(inspected.statusCode).toBe(200);
      expect(inspected.json()).toMatchObject({ title: "169.254.169.254" });
      for (const url of ["http://127.0.0.1:4911/api/internal/status", "http://[::1]/", "localhost:4911"]) {
        const fetched = await app.inject({ method: "POST", url: "/api/live/fetch-url", headers: { cookie, [csrfHeaderName]: csrfToken }, payload: { url } });
        expect(fetched.statusCode, url).toBe(400);
        expect(fetched.json().error.code, url).toBe("URL_NOT_ALLOWED");
      }
      const invalid = await app.inject({ method: "POST", url: "/api/live/fetch-url", headers: { cookie, [csrfHeaderName]: csrfToken }, payload: { url: { href: "x" } } });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("supports private user-link CRUD, filtering, conflicts, and redacted audit metadata", async () => {
    const sessionSecret = "test-secret-with-enough-length";
    const store = new InMemorySpaceStore();
    const { app, cookie, csrfToken } = await authedApp({ store, auth: { sessionSecret, devLogin: true, secureCookies: false } });
    const seeded = await app.inject({ method: "GET", url: "/api/links?page=1&pageSize=25", headers: { cookie } });
    expect(seeded.statusCode).toBe(200);
    expect(seeded.json().data.map((link: { title: string }) => link.title)).toEqual([]);

    const created = await app.inject({ method: "POST", url: "/api/links", headers: { cookie, [csrfHeaderName]: csrfToken }, payload: {
      title: "Reference", description: "Private details", url: "https://example.com/docs#secret", openMode: "EMBEDDED", isQuick: false
    } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ title: "Reference", url: "https://example.com/docs", sortOrder: 0 });
    expect(created.json()).not.toHaveProperty("ownerUserId");

    const duplicate = await app.inject({ method: "POST", url: "/api/links", headers: { cookie, [csrfHeaderName]: csrfToken }, payload: {
      title: "Duplicate", url: "https://EXAMPLE.com/docs#other", openMode: "EMBEDDED"
    } });
    expect(duplicate.statusCode).toBe(409);
    const updated = await app.inject({ method: "PATCH", url: `/api/links/${encodeURIComponent(created.json().id)}`, headers: { cookie, [csrfHeaderName]: csrfToken }, payload: { isQuick: true, description: "Updated private details" } });
    expect(updated.statusCode).toBe(200);
    const quick = await app.inject({ method: "GET", url: "/api/links?q=reference&isQuick=true&page=1&pageSize=10", headers: { cookie } });
    expect(quick.json()).toMatchObject({ data: [{ id: created.json().id, isQuick: true }], pagination: { totalItems: 1 } });

    const otherToken = signSession({ id: "user:other", email: "other@space.local", role: "OPERATOR" }, sessionSecret);
    const otherCookie = `space_session=${otherToken}`;
    const otherList = await app.inject({ method: "GET", url: "/api/links?q=reference", headers: { cookie: otherCookie } });
    expect(otherList.json().pagination.totalItems).toBe(0);
    const crossDelete = await app.inject({ method: "DELETE", url: `/api/links/${encodeURIComponent(created.json().id)}`, headers: { cookie: otherCookie, [csrfHeaderName]: createCsrfToken(otherToken, sessionSecret)! } });
    expect(crossDelete.statusCode).toBe(404);
    const auditJson = JSON.stringify(store.snapshot().auditEvents.filter((event) => event.action.startsWith("link.")));
    expect(auditJson).toContain("example.com");
    expect(auditJson).not.toContain("Private details");
    expect(auditJson).not.toContain("https://example.com/docs");
  });
});
