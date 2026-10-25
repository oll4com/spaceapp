import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoStateResponse, Pane, DemoRun } from "@space/contracts";

const apiMock = {
  demoState: vi.fn(),
  demoSaveSelection: vi.fn(),
  demoStartRun: vi.fn(),
  demoStopRun: vi.fn(),
  demoRestartRun: vi.fn(),
  demoRunLogs: vi.fn(),
  demoVariantFiles: vi.fn(),
  demoVariantFile: vi.fn(),
  demoOperations: vi.fn(),
  demoRunTests: vi.fn(),
  demoTests: vi.fn(),
  demoSaveConnectionSettings: vi.fn(),
  demoAuthorizeConnection: vi.fn(),
  demoDisconnectConnection: vi.fn(),
  demoSelectSheet: vi.fn(),
  demoCreateSheet: vi.fn(),
  demoVerifySheet: vi.fn(),
  demoRetryOperation: vi.fn(),
  demoAccounts: vi.fn()
};

vi.mock("../src/api.js", () => ({ api: apiMock }));

const { DemosPane } = await import("../src/features/demos-pane/DemosPane.js");

const pane = {
  id: "pane:demos",
  roomId: "room:test",
  title: "Demo Projects",
  mode: "DEMOS",
  status: "IDLE",
  providerId: null,
  modelId: null,
  terminalRuntimeId: null,
  reasoningEffort: null,
  cwd: null,
  taskMetadata: null,
  isMinimized: false,
  createdAt: "2026-09-20T10:00:00.000Z",
  updatedAt: "2026-09-20T10:00:00.000Z"
} as unknown as Pane;

function stoppedRun(overrides: Partial<DemoRun> = {}): DemoRun {
  return {
    id: "demo-run:test",
    projectId: "project-2-crud-playground",
    variantId: "javascript-react-node",
    mode: "SAMPLE",
    status: "STOPPED",
    port: null,
    previewPath: null,
    health: null,
    startedAt: null,
    stoppedAt: null,
    lastError: null,
    logEntries: 0,
    ...overrides
  };
}

function state(overrides: Partial<DemoStateResponse> = {}): DemoStateResponse {
  return {
    catalog: {
      projects: [
        {
          id: "project-1-salesforce-crm",
          index: 1,
          name: "Project 1 — Salesforce CRM",
          summary: "Salesforce Accounts and Contacts with Google Sheets synchronisation.",
          description: "Live and sample modes.",
          variantIds: ["javascript-react-node", "typescript-react-node"],
          requiresConnections: ["salesforce", "google-sheets"]
        },
        {
          id: "project-2-crud-playground",
          index: 2,
          name: "Project 2 — CRUD Playground",
          summary: "Small task list with create and status change.",
          description: "Isolated CRUD demo.",
          variantIds: ["javascript-react-node", "typescript-react-node"],
          requiresConnections: []
        }
      ],
      variants: [
        { id: "javascript-react-node", projectId: "project-2-crud-playground", language: "javascript", label: "JavaScript · React · Node.js", stack: ["JavaScript"], available: true, unavailableReason: null, supportsLive: true },
        { id: "typescript-react-node", projectId: "project-2-crud-playground", language: "typescript", label: "TypeScript · React · Node.js", stack: ["TypeScript"], available: true, unavailableReason: null, supportsLive: true }
      ]
    },
    selection: { projectId: "project-2-crud-playground", variantId: "javascript-react-node", mode: "SAMPLE" },
    run: stoppedRun(),
    connections: [
      {
        provider: "salesforce",
        status: "UNCONFIGURED",
        configured: false,
        label: "",
        detail: null,
        scopes: [],
        redirectUri: "https://space.example/api/demo-projects/connections/salesforce/callback",
        connectedAt: null,
        lastRefreshedAt: null,
        lastCheckedAt: null,
        safeErrorCode: null,
        safeErrorMessage: null
      },
      {
        provider: "google-sheets",
        status: "UNCONFIGURED",
        configured: false,
        label: "",
        detail: null,
        scopes: [],
        redirectUri: "https://space.example/api/demo-projects/connections/google-sheets/callback",
        connectedAt: null,
        lastRefreshedAt: null,
        lastCheckedAt: null,
        safeErrorCode: null,
        safeErrorMessage: null
      }
    ],
    sheets: {
      spreadsheetId: null,
      spreadsheetUrl: null,
      title: null,
      tab: null,
      verified: false,
      headerPresent: false,
      verifiedAt: null
    },
    liveReady: false,
    ...overrides
  };
}

beforeEach(() => {
  for (const mock of Object.values(apiMock)) mock.mockReset();
  apiMock.demoState.mockResolvedValue(state());
  apiMock.demoOperations.mockResolvedValue({ data: [], pending: 0, failed: 0 });
  apiMock.demoRunLogs.mockResolvedValue({ runId: "demo-run:test", entries: [], nextSeq: 0, dropped: false });
  apiMock.demoVariantFiles.mockResolvedValue({ variantId: "javascript-react-node", files: [], workspacePath: "/opt/spaceapp/demos" });
  apiMock.demoVariantFile.mockResolvedValue({ path: "server/index.mjs", content: "// demo", truncated: false });
  apiMock.demoAccounts.mockResolvedValue({ data: [], page: 1, pageSize: 10, totalItems: 0, source: "sample", refreshedAt: new Date().toISOString() });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Demo Projects pane", () => {
  it("restores the saved project, variant and mode and reports the stopped state", async () => {
    render(<DemosPane pane={pane} />);
    expect(await screen.findByDisplayValue("Project 2 — CRUD Playground")).toBeTruthy();
    expect(screen.getByDisplayValue("JavaScript · React · Node.js")).toBeTruthy();
    expect(screen.getByDisplayValue("Sample")).toBeTruthy();
    expect(screen.getByText("STOPPED")).toBeTruthy();
  });

  it("persists a variant change without starting anything", async () => {
    apiMock.demoSaveSelection.mockResolvedValue({ selection: { projectId: "project-2-crud-playground", variantId: "typescript-react-node", mode: "SAMPLE" } });
    apiMock.demoState.mockResolvedValueOnce(state()).mockResolvedValueOnce(
      state({ selection: { projectId: "project-2-crud-playground", variantId: "typescript-react-node", mode: "SAMPLE" }, run: null })
    );
    render(<DemosPane pane={pane} />);
    const variantSelect = await screen.findByDisplayValue("JavaScript · React · Node.js");
    fireEvent.change(variantSelect, { target: { value: "typescript-react-node" } });
    await waitFor(() =>
      expect(apiMock.demoSaveSelection).toHaveBeenCalledWith({
        projectId: "project-2-crud-playground",
        variantId: "typescript-react-node",
        mode: "SAMPLE"
      })
    );
    expect(apiMock.demoStartRun).not.toHaveBeenCalled();
  });

  it("starts a run, shows the sandboxed preview and stops it again", async () => {
    const running = stoppedRun({
      status: "RUNNING",
      port: 4942,
      previewPath: "/api/demo-projects/preview/demo-run:test/token/",
      health: { ok: true, checkedAt: new Date().toISOString(), latencyMs: 12, detail: null }
    });
    apiMock.demoState.mockReset();
    apiMock.demoState.mockResolvedValueOnce(state()).mockResolvedValue(state({ run: running }));
    apiMock.demoStartRun.mockResolvedValue({
      run: stoppedRun({ status: "RUNNING", port: 4942, previewPath: "/api/demo-projects/preview/demo-run:test/token/", health: { ok: true, checkedAt: new Date().toISOString(), latencyMs: 12, detail: null } })
    });
    apiMock.demoStopRun.mockResolvedValue({ run: stoppedRun() });
    render(<DemosPane pane={pane} />);
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    await waitFor(() => expect(apiMock.demoStartRun).toHaveBeenCalledWith({ projectId: "project-2-crud-playground", variantId: "javascript-react-node", mode: "SAMPLE" }));
    const frame = await screen.findByTitle("Demo preview");
    expect(frame.getAttribute("src")).toBe("/api/demo-projects/preview/demo-run:test/token/");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-popups allow-same-origin");
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(apiMock.demoStopRun).toHaveBeenCalledWith("demo-run:test"));
  });

  it("reports a required connection instead of pretending the run started", async () => {
    apiMock.demoStartRun.mockRejectedValue(new Error("Live mode requires these connections: Salesforce, Google Sheets."));
    apiMock.demoState.mockResolvedValue(
      state({
        selection: { projectId: "project-1-salesforce-crm", variantId: "javascript-react-node", mode: "LIVE" },
        run: stoppedRun({ projectId: "project-1-salesforce-crm", mode: "LIVE", status: "STOPPED" })
      })
    );
    render(<DemosPane pane={pane} />);
    const modeSelect = await screen.findByDisplayValue("Live");
    expect(modeSelect).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText(/Live mode requires these connections/)).toBeTruthy();
    expect(await screen.findByText("Salesforce consumer key (client id)")).toBeTruthy();
  });

  it("shows the check results after running them", async () => {
    apiMock.demoState.mockResolvedValue(
      state({ run: stoppedRun({ status: "RUNNING", port: 4943, previewPath: "/api/demo-projects/preview/demo-run:test/token/" }) })
    );
    apiMock.demoRunTests.mockResolvedValue({
      testRun: {
        id: "demo-test:1",
        projectId: "project-2-crud-playground",
        variantId: "javascript-react-node",
        mode: "SAMPLE",
        status: "PASSED",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        steps: [
          { key: "health", label: "The demo runtime answers its own health check", status: "PASSED", detail: "healthy", durationMs: 18 },
          { key: "isolation", label: "The run writes only inside its own workspace", status: "PASSED", detail: "isolated", durationMs: 12 }
        ]
      }
    });
    render(<DemosPane pane={pane} />);
    fireEvent.click(await screen.findByRole("button", { name: "Run checks" }));
    expect(await screen.findByText("The demo runtime answers its own health check")).toBeTruthy();
    expect(screen.getByText("The run writes only inside its own workspace")).toBeTruthy();
    expect(screen.getAllByText(/All checks passed/).length).toBeGreaterThan(0);
  });

  it("renders Guide & LOC tab with metrics, files breakdown and button catalog", async () => {
    apiMock.demoVariantFiles.mockResolvedValue({
      variantId: "javascript-react-node",
      files: [
        { path: "server/index.mjs", bytes: 4096, lines: 142, group: "server" },
        { path: "web/App.jsx", bytes: 2048, lines: 88, group: "web" }
      ],
      workspacePath: "/opt/spaceapp/demos"
    });
    render(<DemosPane pane={pane} />);
    fireEvent.click(await screen.findByRole("tab", { name: /Guide & LOC/ }));
    expect(await screen.findByText("Live Codebase Metrics (LOC Counter)")).toBeTruthy();
    expect(await screen.findByText("230")).toBeTruthy(); // 142 + 88 = 230 total lines
    expect(screen.getByText("Button Action Catalog (What Every Button Does)")).toBeTruthy();
    expect(screen.getByText("server/index.mjs")).toBeTruthy();
  });

  it("renders direct Open in Google Sheets link in Connections tab when sheet configured", async () => {
    apiMock.demoState.mockResolvedValue(
      state({
        sheets: {
          spreadsheetId: "1AbCdEfG123456",
          spreadsheetUrl: "https://docs.google.com/spreadsheets/d/1AbCdEfG123456",
          title: "Salesforce CRM Sync Sheet",
          tab: "Demo Sync",
          verified: true,
          headerPresent: true,
          verifiedAt: new Date().toISOString()
        }
      })
    );
    render(<DemosPane pane={pane} />);
    fireEvent.click(await screen.findByRole("tab", { name: /Connections/ }));
    const sheetLinks = await screen.findAllByRole("link", { name: /Open in Google Sheets/ });
    expect(sheetLinks.length).toBeGreaterThan(0);
    expect(sheetLinks[0]!.getAttribute("href")).toContain("1AbCdEfG123456");
  });
});

