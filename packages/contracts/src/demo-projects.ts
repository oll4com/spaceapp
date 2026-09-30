import { z } from "zod";

/**
 * Demo Projects contracts. The pane never receives provider secrets: settings
 * objects are write-only inputs and every response exposes status/metadata only.
 */
export const demoProjectIdSchema = z
  .string()
  .trim()
  .min(3)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Demo identifiers use lowercase letters, digits and dashes.");

export const demoVariantIdSchema = demoProjectIdSchema;
export const demoLanguageSchema = z.enum(["javascript", "typescript", "python"]);
export const demoRunModeSchema = z.enum(["SAMPLE", "LIVE"]);
export const demoRunStatusSchema = z.enum([
  "STOPPED",
  "STARTING",
  "RUNNING",
  "FAILED",
  "CONNECTION_REQUIRED"
]);
export const demoConnectionProviderSchema = z.enum(["salesforce", "google-sheets"]);
export const demoConnectionStatusSchema = z.enum([
  "UNCONFIGURED",
  "CONNECTED",
  "NEEDS_RECONNECT",
  "ERROR"
]);
export const demoOperationStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "SYNCED",
  "FAILED",
  "PARTIAL"
]);
export const demoSyncStepKeySchema = z.enum([
  "salesforce-account",
  "salesforce-contact",
  "google-sheets-row"
]);
export const demoSyncStepStatusSchema = z.enum(["PENDING", "RUNNING", "DONE", "FAILED", "SKIPPED"]);
export const demoTestStatusSchema = z.enum(["PASSED", "FAILED", "SKIPPED"]);
export const demoTestRunStatusSchema = z.enum(["PASSED", "FAILED"]);
export const demoLoginUrlSchema = z.enum([
  "https://login.salesforce.com",
  "https://test.salesforce.com"
]);

export const demoProjectSchema = z
  .object({
    id: demoProjectIdSchema,
    index: z.number().int().min(1).max(99),
    name: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(400),
    description: z.string().trim().min(1).max(1200),
    variantIds: z.array(demoVariantIdSchema).min(1).max(12),
    requiresConnections: z.array(demoConnectionProviderSchema).max(4)
  })
  .strict();

export const demoVariantSchema = z
  .object({
    id: demoVariantIdSchema,
    projectId: demoProjectIdSchema,
    language: demoLanguageSchema,
    label: z.string().trim().min(1).max(120),
    stack: z.array(z.string().trim().min(1).max(60)).min(1).max(8),
    available: z.boolean(),
    unavailableReason: z.string().trim().max(300).nullable(),
    supportsLive: z.boolean()
  })
  .strict();

export const demoCatalogResponseSchema = z
  .object({
    projects: z.array(demoProjectSchema).min(1),
    variants: z.array(demoVariantSchema).min(1)
  })
  .strict();

export const demoConnectionSchema = z
  .object({
    provider: demoConnectionProviderSchema,
    status: demoConnectionStatusSchema,
    configured: z.boolean(),
    label: z.string().trim().max(200),
    detail: z.string().trim().max(300).nullable(),
    scopes: z.array(z.string().trim().min(1).max(200)),
    redirectUri: z.string().trim().max(400),
    connectedAt: z.string().nullable(),
    lastRefreshedAt: z.string().nullable(),
    lastCheckedAt: z.string().nullable(),
    safeErrorCode: z.string().trim().max(80).nullable(),
    safeErrorMessage: z.string().trim().max(300).nullable()
  })
  .strict();

export const demoSheetsTargetSchema = z
  .object({
    spreadsheetId: z.string().trim().max(200).nullable(),
    spreadsheetUrl: z.string().trim().max(400).nullable(),
    title: z.string().trim().max(200).nullable(),
    tab: z.string().trim().max(120).nullable(),
    verified: z.boolean(),
    headerPresent: z.boolean(),
    verifiedAt: z.string().nullable()
  })
  .strict();

export const demoHealthSchema = z
  .object({
    ok: z.boolean(),
    checkedAt: z.string(),
    latencyMs: z.number().int().min(0).max(600_000).nullable(),
    detail: z.string().trim().max(300).nullable()
  })
  .strict();

export const demoRunSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    projectId: demoProjectIdSchema,
    variantId: demoVariantIdSchema,
    mode: demoRunModeSchema,
    status: demoRunStatusSchema,
    port: z.number().int().min(1).max(65_535).nullable(),
    previewPath: z.string().trim().max(600).nullable(),
    health: demoHealthSchema.nullable(),
    startedAt: z.string().nullable(),
    stoppedAt: z.string().nullable(),
    lastError: z.string().trim().max(400).nullable(),
    logEntries: z.number().int().min(0)
  })
  .strict();

export const demoSelectionSchema = z
  .object({
    projectId: demoProjectIdSchema,
    variantId: demoVariantIdSchema,
    mode: demoRunModeSchema
  })
  .strict();

export const demoStateResponseSchema = z
  .object({
    catalog: demoCatalogResponseSchema,
    selection: demoSelectionSchema,
    run: demoRunSchema.nullable(),
    connections: z.array(demoConnectionSchema),
    sheets: demoSheetsTargetSchema,
    liveReady: z.boolean()
  })
  .strict();

export const demoSelectionInputSchema = demoSelectionSchema.strict();
export const demoStartRunInputSchema = demoSelectionSchema.strict();

export const demoSalesforceSettingsInputSchema = z
  .object({
    clientId: z.string().trim().min(5).max(400),
    clientSecret: z.string().trim().min(5).max(400).nullable().optional(),
    loginUrl: demoLoginUrlSchema.optional()
  })
  .strict();

export const demoGoogleSettingsInputSchema = z
  .object({
    clientId: z.string().trim().min(5).max(400),
    clientSecret: z.string().trim().min(5).max(400).nullable().optional()
  })
  .strict();

export const demoConnectionSettingsInputSchema = z
  .union([demoSalesforceSettingsInputSchema, demoGoogleSettingsInputSchema])
  .describe("Provider client settings. Stored encrypted and never returned.");

export const demoSheetsTargetInputSchema = z
  .object({
    spreadsheet: z.string().trim().min(5).max(500),
    tab: z.string().trim().min(1).max(120).nullable().optional()
  })
  .strict();

export const demoAccountsQuerySchema = z
  .object({
    search: z.string().trim().max(120).optional(),
    page: z.coerce.number().int().min(1).max(200).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional()
  })
  .strict();

export const demoAccountSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    name: z.string().trim().max(300),
    contactName: z.string().trim().max(300).nullable(),
    contactId: z.string().trim().max(80).nullable(),
    createdAt: z.string().nullable(),
    source: z.enum(["salesforce", "sample"])
  })
  .strict();

export const demoAccountsResponseSchema = z
  .object({
    data: z.array(demoAccountSchema),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
    totalItems: z.number().int().min(0),
    source: z.enum(["salesforce", "sample"]),
    refreshedAt: z.string()
  })
  .strict();

export const demoOperationStepSchema = z
  .object({
    key: demoSyncStepKeySchema,
    status: demoSyncStepStatusSchema,
    attempts: z.number().int().min(0),
    externalId: z.string().trim().max(120).nullable(),
    message: z.string().trim().max(400).nullable(),
    updatedAt: z.string()
  })
  .strict();

export const demoOperationSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    operationKey: z.string().trim().min(1).max(160),
    projectId: demoProjectIdSchema,
    variantId: demoVariantIdSchema,
    mode: demoRunModeSchema,
    status: demoOperationStatusSchema,
    accountName: z.string().trim().max(300),
    contactLastName: z.string().trim().max(300),
    firstName: z.string().trim().max(200).nullable(),
    email: z.string().trim().max(300).nullable(),
    phone: z.string().trim().max(80).nullable(),
    website: z.string().trim().max(300).nullable(),
    salesforceAccountId: z.string().trim().max(80).nullable(),
    salesforceContactId: z.string().trim().max(80).nullable(),
    salesforceInstanceUrl: z.string().trim().max(300).nullable(),
    sheetsRow: z.number().int().min(1).nullable(),
    sheetsVerifiedAt: z.string().nullable(),
    steps: z.array(demoOperationStepSchema),
    attempts: z.number().int().min(0),
    nextAttemptAt: z.string().nullable(),
    lastErrorCode: z.string().trim().max(80).nullable(),
    lastErrorMessage: z.string().trim().max(400).nullable(),
    createdAt: z.string(),
    updatedAt: z.string()
  })
  .strict();

export const demoOperationListResponseSchema = z
  .object({
    data: z.array(demoOperationSchema),
    pending: z.number().int().min(0),
    failed: z.number().int().min(0)
  })
  .strict();

export const createDemoOperationInputSchema = z
  .object({
    operationKey: z
      .string()
      .trim()
      .min(8)
      .max(160)
      .regex(/^[A-Za-z0-9._:-]+$/, "Operation keys use letters, digits, dot, colon, dash and underscore."),
    accountName: z.string().trim().min(2).max(200),
    contactLastName: z.string().trim().min(2).max(200),
    firstName: z.string().trim().min(1).max(160).nullable().optional(),
    email: z.string().trim().email().max(300).nullable().optional(),
    phone: z.string().trim().max(60).nullable().optional(),
    website: z.string().trim().max(300).nullable().optional()
  })
  .strict();

export const demoOperationRetryInputSchema = z.object({ attemptNow: z.boolean().optional() }).strict();

export const demoTestStepSchema = z
  .object({
    key: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(200),
    status: demoTestStatusSchema,
    detail: z.string().trim().max(500),
    durationMs: z.number().int().min(0).max(600_000)
  })
  .strict();

export const demoTestRunSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    projectId: demoProjectIdSchema,
    variantId: demoVariantIdSchema,
    mode: demoRunModeSchema,
    status: demoTestRunStatusSchema,
    steps: z.array(demoTestStepSchema),
    startedAt: z.string(),
    finishedAt: z.string()
  })
  .strict();

export const demoTestRunListResponseSchema = z
  .object({
    data: z.array(demoTestRunSchema),
    lastRun: demoTestRunSchema.nullable()
  })
  .strict();

export const demoVariantFileSchema = z
  .object({
    path: z.string().trim().min(1).max(300),
    bytes: z.number().int().min(0),
    group: z.enum(["server", "web", "config", "docs"]),
    lines: z.number().int().min(0).optional()
  })
  .strict();

export const demoVariantFilesResponseSchema = z
  .object({
    variantId: demoVariantIdSchema,
    files: z.array(demoVariantFileSchema),
    workspacePath: z.string().trim().max(400)
  })
  .strict();

export const demoVariantFileContentSchema = z
  .object({
    path: z.string().trim().min(1).max(300),
    content: z.string(),
    truncated: z.boolean()
  })
  .strict();

export const demoLogEntrySchema = z
  .object({
    seq: z.number().int().min(0),
    at: z.string(),
    stream: z.enum(["stdout", "stderr", "system"]),
    line: z.string().max(2000)
  })
  .strict();

export const demoLogsResponseSchema = z
  .object({
    runId: z.string().trim().max(120),
    entries: z.array(demoLogEntrySchema),
    nextSeq: z.number().int().min(0),
    dropped: z.boolean()
  })
  .strict();

export const demoRunTokenHeader = "x-demo-run-token";
export const demoPreviewTokenHeader = "x-demo-preview-token";

export const demoConnectorAccountSchema = demoAccountSchema;
export const demoConnectorStatusSchema = z
  .object({
    mode: demoRunModeSchema,
    accountsSource: z.enum(["salesforce", "sample"]),
    sheetsReady: z.boolean(),
    sheetsRowCount: z.number().int().min(0).nullable(),
    salesforceInstanceUrl: z.string().trim().max(300).nullable(),
    sampleData: z.boolean()
  })
  .strict();

export type DemoProject = z.infer<typeof demoProjectSchema>;
export type DemoVariant = z.infer<typeof demoVariantSchema>;
export type DemoCatalogResponse = z.infer<typeof demoCatalogResponseSchema>;
export type DemoConnectionProvider = z.infer<typeof demoConnectionProviderSchema>;
export type DemoConnectionStatus = z.infer<typeof demoConnectionStatusSchema>;
export type DemoConnection = z.infer<typeof demoConnectionSchema>;
export type DemoSheetsTarget = z.infer<typeof demoSheetsTargetSchema>;
export type DemoRunMode = z.infer<typeof demoRunModeSchema>;
export type DemoRunStatus = z.infer<typeof demoRunStatusSchema>;
export type DemoRun = z.infer<typeof demoRunSchema>;
export type DemoSelection = z.infer<typeof demoSelectionSchema>;
export type DemoSelectionInput = z.infer<typeof demoSelectionInputSchema>;
export type DemoStartRunInput = z.infer<typeof demoStartRunInputSchema>;
export type DemoStateResponse = z.infer<typeof demoStateResponseSchema>;
export type DemoSalesforceSettingsInput = z.infer<typeof demoSalesforceSettingsInputSchema>;
export type DemoGoogleSettingsInput = z.infer<typeof demoGoogleSettingsInputSchema>;
export type DemoSheetsTargetInput = z.infer<typeof demoSheetsTargetInputSchema>;
export type DemoAccount = z.infer<typeof demoAccountSchema>;
export type DemoAccountsResponse = z.infer<typeof demoAccountsResponseSchema>;
export type DemoAccountsQuery = z.infer<typeof demoAccountsQuerySchema>;
export type DemoOperation = z.infer<typeof demoOperationSchema>;
export type DemoOperationStep = z.infer<typeof demoOperationStepSchema>;
export type DemoOperationStatus = z.infer<typeof demoOperationStatusSchema>;
export type DemoSyncStepKey = z.infer<typeof demoSyncStepKeySchema>;
export type DemoSyncStepStatus = z.infer<typeof demoSyncStepStatusSchema>;
export type CreateDemoOperationInput = z.infer<typeof createDemoOperationInputSchema>;
export type DemoOperationListResponse = z.infer<typeof demoOperationListResponseSchema>;
export type DemoTestRun = z.infer<typeof demoTestRunSchema>;
export type DemoTestRunStatus = z.infer<typeof demoTestRunStatusSchema>;
export type DemoTestStatus = z.infer<typeof demoTestStatusSchema>;
export type DemoTestStep = z.infer<typeof demoTestStepSchema>;
export type DemoTestRunListResponse = z.infer<typeof demoTestRunListResponseSchema>;
export type DemoVariantFile = z.infer<typeof demoVariantFileSchema>;
export type DemoVariantFilesResponse = z.infer<typeof demoVariantFilesResponseSchema>;
export type DemoVariantFileContent = z.infer<typeof demoVariantFileContentSchema>;
export type DemoLogEntry = z.infer<typeof demoLogEntrySchema>;
export type DemoLogsResponse = z.infer<typeof demoLogsResponseSchema>;
export type DemoConnectorStatus = z.infer<typeof demoConnectorStatusSchema>;
export type DemoLoginUrl = z.infer<typeof demoLoginUrlSchema>;
