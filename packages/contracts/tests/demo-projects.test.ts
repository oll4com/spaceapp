import { describe, expect, it } from "vitest";
import {
  createDemoOperationInputSchema,
  demoAccountsQuerySchema,
  demoSelectionInputSchema,
  demoSalesforceSettingsInputSchema,
  demoSheetsTargetInputSchema,
  demoStateResponseSchema,
  demoRunSchema,
  demoProjectIdSchema,
  demoSyncStepKeySchema,
  paneModeSchema
} from "../src/index.js";

const selection = { projectId: "project-1-salesforce-crm", variantId: "javascript-react-node", mode: "SAMPLE" };

describe("demo projects contracts", () => {
  it("accepts the demo pane mode and rejects unknown ones", () => {
    expect(paneModeSchema.safeParse("DEMOS").success).toBe(true);
    expect(paneModeSchema.safeParse("DEMO").success).toBe(false);
  });

  it("validates selection input and refuses extra fields", () => {
    expect(demoSelectionInputSchema.safeParse(selection).success).toBe(true);
    expect(demoSelectionInputSchema.safeParse({ ...selection, mode: "LIVE" }).success).toBe(true);
    expect(demoSelectionInputSchema.safeParse({ ...selection, mode: "MAYBE" }).success).toBe(false);
    expect(demoSelectionInputSchema.safeParse({ ...selection, roomId: "room:other" }).success).toBe(false);
    expect(demoProjectIdSchema.safeParse("Project_1").success).toBe(false);
  });

  it("keeps operation keys and account data bounded", () => {
    expect(
      createDemoOperationInputSchema.safeParse({ operationKey: "ui-abc12345", accountName: "Space Demo", contactLastName: "Tester" }).success
    ).toBe(true);
    expect(createDemoOperationInputSchema.safeParse({ operationKey: "short", accountName: "Space Demo", contactLastName: "T" }).success).toBe(false);
    expect(
      createDemoOperationInputSchema.safeParse({ operationKey: "ui-abc12345", accountName: "Space Demo", contactLastName: "Tester", secret: "x" }).success
    ).toBe(false);
    expect(
      createDemoOperationInputSchema.safeParse({ operationKey: "ui-abc12345", accountName: "Space Demo", contactLastName: "Tester", email: "nope" }).success
    ).toBe(false);
  });

  it("treats provider settings as write-only and single-use", () => {
    expect(demoSalesforceSettingsInputSchema.safeParse({ clientId: "3MVG9CLIENTID", clientSecret: "secret", loginUrl: "https://test.salesforce.com" }).success).toBe(true);
    expect(demoSalesforceSettingsInputSchema.safeParse({ clientId: "3MVG9CLIENTID", loginUrl: "https://evil.example" }).success).toBe(false);
    expect(demoSalesforceSettingsInputSchema.safeParse({ clientId: "abc" }).success).toBe(false);
  });

  it("accepts a spreadsheet id or url and clamps account queries", () => {
    expect(demoSheetsTargetInputSchema.safeParse({ spreadsheet: "https://docs.google.com/spreadsheets/d/abc123/edit", tab: "Sheet1" }).success).toBe(true);
    expect(demoSheetsTargetInputSchema.safeParse({ spreadsheet: "x" }).success).toBe(false);
    expect(demoAccountsQuerySchema.safeParse({ page: "2", pageSize: "25" }).success).toBe(true);
    expect(demoAccountsQuerySchema.safeParse({ pageSize: "5000" }).success).toBe(false);
  });

  it("exposes a run shape without secrets or tokens", () => {
    const parsed = demoRunSchema.safeParse({
      id: "demo-run:abc",
      projectId: "project-2-crud-playground",
      variantId: "javascript-react-node",
      mode: "SAMPLE",
      status: "RUNNING",
      port: 4942,
      previewPath: "/api/demo-projects/preview/demo-run:abc/token/",
      health: { ok: true, checkedAt: new Date().toISOString(), latencyMs: 12, detail: null },
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      lastError: null,
      logEntries: 4
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.keys(parsed.data)).not.toContain("runToken");
      expect(Object.keys(parsed.data)).not.toContain("previewToken");
    }
  });

  it("keeps the state payload closed and the sync steps stable", () => {
    const state = {
      catalog: {
        projects: [
          {
            id: "project-2-crud-playground",
            index: 2,
            name: "Project 2 — CRUD Playground",
            summary: "Small task list.",
            description: "Isolated demo.",
            variantIds: ["javascript-react-node"],
            requiresConnections: []
          }
        ],
        variants: [
          {
            id: "javascript-react-node",
            projectId: "project-2-crud-playground",
            language: "javascript",
            label: "JavaScript · React · Node.js",
            stack: ["JavaScript"],
            available: true,
            unavailableReason: null,
            supportsLive: true
          }
        ]
      },
      selection,
      run: null,
      connections: [],
      sheets: { spreadsheetId: null, spreadsheetUrl: null, title: null, tab: null, verified: false, headerPresent: false, verifiedAt: null },
      liveReady: false
    };
    expect(demoStateResponseSchema.safeParse(state).success).toBe(true);
    expect(demoStateResponseSchema.safeParse({ ...state, extra: true }).success).toBe(false);
    expect(demoSyncStepKeySchema.safeParse("google-sheets-row").success).toBe(true);
    expect(demoSyncStepKeySchema.safeParse("salesforce-lead").success).toBe(false);
  });
});
