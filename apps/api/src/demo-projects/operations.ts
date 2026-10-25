import { randomBytes } from "node:crypto";
import type {
  DemoAccount,
  DemoAccountsResponse,
  DemoSyncStepKey,
  DemoSyncStepStatus
} from "@space/contracts";
import type { DemoOperationRecord, DemoOperationStepRecord, DemoProjectsRepository, DemoSheetsTargetRecord } from "@space/db";
import type { DemoConnectionsService } from "./connections.js";
import { DemoConnectionError } from "./connections.js";
import { demoSheetHeaders, GoogleSheetsApi, GoogleSheetsError, type SpreadsheetMetadata } from "./google-sheets.js";
import { SalesforceApi, SalesforceError } from "./salesforce.js";

const maximumAutomaticAttempts = 5;
const backoffScheduleMs = [5_000, 15_000, 45_000, 120_000, 300_000];

export class DemoOperationError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) {
    super(message);
    this.name = "DemoOperationError";
  }
}

export interface DemoOperationsServiceOptions {
  repository: DemoProjectsRepository;
  connections: DemoConnectionsService;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  log?: (event: string, detail?: Record<string, unknown>) => void;
}

export interface CreateOperationInput {
  operationKey: string;
  accountName: string;
  contactLastName: string;
  firstName?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function step(key: DemoSyncStepKey, status: DemoSyncStepStatus, message: string | null, at: string, externalId: string | null = null, attempts = 0): DemoOperationStepRecord {
  return { key, status, attempts, externalId, message, updatedAt: at };
}

function defaultSteps(at: string): DemoOperationStepRecord[] {
  return [
    step("salesforce-account", "PENDING", null, at),
    step("salesforce-contact", "PENDING", null, at),
    step("google-sheets-row", "PENDING", null, at)
  ];
}

function replaceStep(steps: DemoOperationStepRecord[], next: DemoOperationStepRecord): DemoOperationStepRecord[] {
  const index = steps.findIndex((candidate) => candidate.key === next.key);
  if (index < 0) return [...steps, next];
  const copy = [...steps];
  copy[index] = next;
  return copy;
}

function findStep(steps: DemoOperationStepRecord[], key: DemoSyncStepKey): DemoOperationStepRecord | undefined {
  return steps.find((candidate) => candidate.key === key);
}

function spreadsheetIdFromInput(value: string): string {
  const trimmed = value.trim();
  const match = /\/spreadsheets\/d\/([A-Za-z0-9-_]{20,})/.exec(trimmed);
  if (match?.[1]) return match[1];
  if (/^[A-Za-z0-9-_]{20,}$/.test(trimmed)) return trimmed;
  throw new DemoOperationError("DEMO_SHEET_ID_INVALID", "Paste a Google Sheets URL or spreadsheet id.", 400);
}

export class DemoOperationsService {
  private readonly now: () => Date;
  private readonly log: (event: string, detail?: Record<string, unknown>) => void;
  private timer: NodeJS.Timeout | null = null;
  private processingChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: DemoOperationsServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.processPending(4).catch((error) => this.log("demo.operations.tick_failed", { message: String(error) })), 5_000);
    this.timer.unref();
    void this.processPending(4).catch(() => undefined);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async createOperation(input: {
    ownerUserId: string;
    projectId: string;
    variantId: string;
    mode: "SAMPLE" | "LIVE";
    operation: CreateOperationInput;
  }): Promise<{ operation: DemoOperationRecord; created: boolean }> {
    const existing = await this.options.repository.findOperationByKey(input.ownerUserId, input.projectId, input.operation.operationKey);
    if (existing) return { operation: existing, created: false };
    const at = nowIso(this.now);
    const record: Omit<DemoOperationRecord, "createdAt" | "updatedAt"> = {
      id: `demo-operation:${randomBytes(9).toString("hex")}`,
      ownerUserId: input.ownerUserId,
      operationKey: input.operation.operationKey,
      projectId: input.projectId,
      variantId: input.variantId,
      mode: input.mode,
      status: "PENDING",
      accountName: input.operation.accountName,
      contactLastName: input.operation.contactLastName,
      firstName: input.operation.firstName ?? null,
      email: input.operation.email ?? null,
      phone: input.operation.phone ?? null,
      website: input.operation.website ?? null,
      salesforceAccountId: null,
      salesforceContactId: null,
      salesforceInstanceUrl: null,
      sheetsRow: null,
      sheetsVerifiedAt: null,
      steps: defaultSteps(at),
      attempts: 0,
      nextAttemptAt: at,
      lastErrorCode: null,
      lastErrorMessage: null
    };
    try {
      const operation = await this.options.repository.upsertOperation(record);
      void this.processPending(2).catch(() => undefined);
      return { operation, created: true };
    } catch (error) {
      const raced = await this.options.repository.findOperationByKey(input.ownerUserId, input.projectId, input.operation.operationKey);
      if (raced) return { operation: raced, created: false };
      throw error;
    }
  }

  async listOperations(
    ownerUserId: string,
    input: { projectId?: string; limit?: number }
  ): Promise<{ data: DemoOperationRecord[]; pending: number; failed: number }> {
    const data = await this.options.repository.listOperations(ownerUserId, { projectId: input.projectId, limit: input.limit ?? 50 });
    const all = await this.options.repository.listOperations(ownerUserId, { projectId: input.projectId, limit: 200 });
    return {
      data,
      pending: all.filter((operation) => operation.status === "PENDING" || operation.status === "RUNNING").length,
      failed: all.filter((operation) => operation.status === "FAILED" || operation.status === "PARTIAL").length
    };
  }

  async retryOperation(ownerUserId: string, id: string, input: { attemptNow?: boolean }): Promise<DemoOperationRecord> {
    const operation = await this.options.repository.getOperation(id);
    if (!operation || operation.ownerUserId !== ownerUserId) {
      throw new DemoOperationError("DEMO_OPERATION_NOT_FOUND", "The operation was not found.", 404);
    }
    const at = nowIso(this.now);
    const updated = await this.options.repository.upsertOperation({
      ...operation,
      status: "PENDING",
      attempts: input.attemptNow ? 0 : operation.attempts,
      nextAttemptAt: at,
      lastErrorCode: null,
      lastErrorMessage: null,
      steps: operation.steps.map((candidate) => (candidate.status === "FAILED" ? { ...candidate, status: "PENDING" as const, message: null } : candidate))
    });
    void this.processPending(2).catch(() => undefined);
    return updated;
  }

  /**
   * Serialised outbox tick: concurrent callers queue behind the running batch
   * instead of being dropped, so awaiting this promise means the batch is done.
   */
  async processPending(limit: number): Promise<void> {
    const next = this.processingChain.then(() => this.processBatch(limit));
    this.processingChain = next.catch((error) => this.log("demo.operations.batch_failed", { message: String(error) }));
    return next;
  }

  private async processBatch(limit: number): Promise<void> {
    const claimed = await this.options.repository.claimDueOperations(nowIso(this.now), limit);
    for (const operation of claimed) {
      await this.processOperation(operation).catch((error) =>
        this.log("demo.operations.process_failed", { id: operation.id, message: String(error) })
      );
    }
  }

  async processOperation(operation: DemoOperationRecord): Promise<DemoOperationRecord> {
    if (operation.status === "SYNCED") return operation;
    let current = operation;
    let steps = [...current.steps];
    const at = () => nowIso(this.now);
    try {
      const { api } = await this.options.connections.salesforceClient(current.ownerUserId);
      current = { ...current, salesforceInstanceUrl: api.instanceUrl };
      const accountStep = findStep(steps, "salesforce-account");
      const accountAlreadyAttempted = (accountStep?.attempts ?? 0) > 0;
      if (accountStep?.status !== "DONE") {
        steps = replaceStep(steps, { ...(accountStep ?? step("salesforce-account", "RUNNING", null, at())), status: "RUNNING", attempts: (accountStep?.attempts ?? 0) + 1, updatedAt: at() });
        current = await this.options.repository.upsertOperation({ ...current, steps, attempts: current.attempts + 1 });
        const accountId = await this.ensureSalesforceAccount(api, current, accountAlreadyAttempted);
        steps = replaceStep(steps, step("salesforce-account", "DONE", "Account created and verified.", at(), accountId));
        current = await this.options.repository.upsertOperation({ ...current, steps, salesforceAccountId: accountId, salesforceInstanceUrl: api.instanceUrl });
      }
      const contactStep = findStep(steps, "salesforce-contact");
      if (contactStep?.status !== "DONE") {
        const linkedAccountId = current.salesforceAccountId;
        if (!linkedAccountId) throw new DemoOperationError("DEMO_ACCOUNT_MISSING", "The Salesforce Account id is unavailable.", 409);
        steps = replaceStep(steps, { ...(contactStep ?? step("salesforce-contact", "RUNNING", null, at())), status: "RUNNING", attempts: (contactStep?.attempts ?? 0) + 1, updatedAt: at() });
        current = await this.options.repository.upsertOperation({ ...current, steps });
        const contact = await api.createContact({
          accountId: linkedAccountId,
          lastName: current.contactLastName,
          firstName: current.firstName,
          email: current.email,
          phone: current.phone
        });
        const verified = await api.readContact(contact.id);
        if (!verified) throw new SalesforceError("SALESFORCE_CONTACT_UNVERIFIED", "The Contact could not be read back.", 502, true);
        steps = replaceStep(steps, step("salesforce-contact", "DONE", "Contact created and verified.", at(), contact.id));
        current = await this.options.repository.upsertOperation({ ...current, steps, salesforceContactId: contact.id });
      }
      const sheetsStep = findStep(steps, "google-sheets-row");
      if (sheetsStep?.status !== "DONE") {
        steps = replaceStep(steps, { ...(sheetsStep ?? step("google-sheets-row", "RUNNING", null, at())), status: "RUNNING", attempts: (sheetsStep?.attempts ?? 0) + 1, updatedAt: at() });
        current = await this.options.repository.upsertOperation({ ...current, steps });
        const appended = await this.appendSheetRow(current);
        steps = replaceStep(steps, step("google-sheets-row", "DONE", `Row ${appended.rowNumber} verified by read-back.`, at(), String(appended.rowNumber)));
        current = await this.options.repository.upsertOperation({
          ...current,
          steps,
          sheetsRow: appended.rowNumber,
          sheetsVerifiedAt: at(),
          status: "SYNCED",
          nextAttemptAt: null,
          lastErrorCode: null,
          lastErrorMessage: null
        });
        return current;
      }
      return this.options.repository.upsertOperation({
        ...current,
        steps,
        status: "SYNCED",
        nextAttemptAt: null,
        lastErrorCode: null,
        lastErrorMessage: null
      });
    } catch (error) {
      return this.recordFailure(current, steps, error);
    }
  }

  private async recordFailure(
    operation: DemoOperationRecord,
    steps: DemoOperationStepRecord[],
    error: unknown
  ): Promise<DemoOperationRecord> {
    const code = (error as { code?: string }).code ?? "DEMO_OPERATION_FAILED";
    const message = error instanceof Error ? error.message.slice(0, 400) : "The operation failed.";
    const retryable =
      code === "DUPLICATES_DETECTED" ||
      ((error instanceof SalesforceError || error instanceof GoogleSheetsError) ? error.retryable : false);
    const needsReconnect = /RECONNECT|REVOKED|NOT_CONNECTED/.test(code);
    const failedKey: DemoSyncStepKey =
      findStep(steps, "salesforce-account")?.status === "DONE"
        ? findStep(steps, "salesforce-contact")?.status === "DONE"
          ? "google-sheets-row"
          : "salesforce-contact"
        : "salesforce-account";
    const failedStep = findStep(steps, failedKey);
    const at = nowIso(this.now);
    const nextSteps = replaceStep(steps, {
      ...(failedStep ?? step(failedKey, "FAILED", null, at)),
      status: "FAILED",
      message,
      updatedAt: at
    });
    const attempts = operation.attempts + 1;
    const done = nextSteps.filter((candidate) => candidate.status === "DONE").length;
    const canRetry = !needsReconnect && retryable !== false && attempts < maximumAutomaticAttempts && done > 0;
    const backoff = backoffScheduleMs[Math.min(attempts, backoffScheduleMs.length - 1)] ?? 300_000;
    const status = needsReconnect ? "FAILED" : done > 0 ? "PARTIAL" : "FAILED";
    return this.options.repository.upsertOperation({
      ...operation,
      steps: nextSteps,
      status,
      attempts,
      nextAttemptAt: canRetry ? new Date(this.now().getTime() + backoff).toISOString() : null,
      lastErrorCode: code,
      lastErrorMessage: message
    });
  }

  private async ensureSalesforceAccount(api: SalesforceApi, operation: DemoOperationRecord, isRetry: boolean): Promise<string> {
    const externalIdField = process.env.SPACE_DEMO_SALESFORCE_EXTERNAL_ID_FIELD?.trim() || null;
    if (externalIdField) {
      const upserted = await api.createAccount({
        name: operation.accountName,
        website: operation.website,
        phone: operation.phone,
        externalId: operation.operationKey,
        externalIdField
      });
      const verified = await api.readAccount(upserted.id);
      if (!verified) throw new SalesforceError("SALESFORCE_ACCOUNT_UNVERIFIED", "The Account could not be read back.", 502, true);
      return upserted.id;
    }
    if (isRetry) {
      // A previous attempt may have created the Account before timing out.
      const existing = await api.listAccounts({ search: operation.accountName, page: 1, pageSize: 5 });
      const createdAfter = Date.parse(operation.createdAt) - 60_000;
      const match = existing.data.find(
        (record) => record.name === operation.accountName && (!record.createdAt || Date.parse(record.createdAt) >= createdAfter)
      );
      if (match) return match.id;
    }
    const created = await api.createAccount({ name: operation.accountName, website: operation.website, phone: operation.phone });
    const verified = await api.readAccount(created.id);
    if (!verified) throw new SalesforceError("SALESFORCE_ACCOUNT_UNVERIFIED", "The Account could not be read back.", 502, true);
    return created.id;
  }

  private async appendSheetRow(operation: DemoOperationRecord): Promise<{ rowNumber: number; verified: boolean }> {
    const target = await this.options.repository.getSheetsTarget(operation.ownerUserId);
    if (!target) {
      throw new DemoOperationError("DEMO_SHEET_NOT_SELECTED", "Select a Google Sheets spreadsheet before running live operations.", 409);
    }
    const sheets = await this.options.connections.googleSheetsClient(operation.ownerUserId);
    const existing = await sheets.findRowByOperationId(target.spreadsheetId, target.tab, operation.operationKey);
    if (existing) return { rowNumber: existing.rowNumber, verified: true };
    const contactName = [operation.firstName, operation.contactLastName].filter(Boolean).join(" ");
    const values = [
      operation.operationKey,
      nowIso(this.now),
      operation.salesforceAccountId ?? "",
      operation.accountName,
      operation.salesforceContactId ?? "",
      contactName,
      operation.email ?? "",
      operation.projectId,
      operation.variantId
    ].slice(0, demoSheetHeaders.length);
    const appended = await sheets.appendRow(target.spreadsheetId, target.tab, values);
    const rowNumber = appended.updatedRange ? Number(/(\d+):/.exec(appended.updatedRange)?.[1] ?? 0) : 0;
    if (!rowNumber) {
      const match = await sheets.findRowByOperationId(target.spreadsheetId, target.tab, operation.operationKey);
      if (!match) throw new GoogleSheetsError("GOOGLE_APPEND_UNVERIFIED", "The appended row could not be located for verification.", 502, true);
      return { rowNumber: match.rowNumber, verified: true };
    }
    const readBack = await sheets.findRowByRange(target.spreadsheetId, target.tab, rowNumber);
    const verified =
      (readBack[0] ?? "") === operation.operationKey &&
      (readBack[2] ?? "") === (operation.salesforceAccountId ?? "") &&
      (readBack[4] ?? "") === (operation.salesforceContactId ?? "");
    if (!verified) {
      throw new GoogleSheetsError("GOOGLE_ROW_MISMATCH", "The Google Sheets row does not match the Salesforce ids.", 502, true);
    }
    return { rowNumber, verified };
  }

  async listAccounts(input: {
    ownerUserId: string;
    variantId: string;
    mode: "SAMPLE" | "LIVE";
    search?: string;
    page: number;
    pageSize: number;
  }): Promise<DemoAccountsResponse> {
    if (input.mode !== "LIVE") {
      throw new DemoOperationError("DEMO_SAMPLE_LOCAL", "Sample mode accounts are served inside the demo runtime.", 400);
    }
    const { api } = await this.options.connections.salesforceClient(input.ownerUserId);
    const page = await api.listAccounts({ search: input.search, page: input.page, pageSize: input.pageSize });
    const operations = await this.options.repository.listOperations(input.ownerUserId, { projectId: "project-1-salesforce-crm", limit: 200 });
    const byAccountId = new Map(operations.filter((operation) => operation.salesforceAccountId).map((operation) => [operation.salesforceAccountId!, operation]));
    const data: DemoAccount[] = page.data.map((record) => {
      const operation = byAccountId.get(record.id);
      let contactId = record.contactId;
      let contactName = record.contactName;
      if (operation) {
        contactId = operation.salesforceContactId ?? contactId;
        contactName = [operation.firstName, operation.contactLastName].filter(Boolean).join(" ") || contactName;
      }
      return {
        id: record.id,
        name: record.name,
        contactName,
        contactId,
        createdAt: record.createdAt,
        source: "salesforce"
      };
    });
    return {
      data,
      page: input.page,
      pageSize: input.pageSize,
      totalItems: page.totalItems,
      source: "salesforce",
      refreshedAt: nowIso(this.now)
    };
  }

  async deleteAccount(input: {
    ownerUserId: string;
    accountId: string;
    contactId?: string | null;
  }): Promise<void> {
    const { api } = await this.options.connections.salesforceClient(input.ownerUserId);
    // Delete contact first (child record) then the account
    if (input.contactId) {
      await api.deleteContact(input.contactId);
    }
    await api.deleteAccount(input.accountId);
    // Mark any linked local operations so the UI reflects the deletion
    const operations = await this.options.repository.listOperations(input.ownerUserId, { projectId: "project-1-salesforce-crm", limit: 200 });
    const linked = operations.filter((op) => op.salesforceAccountId === input.accountId);
    const at = nowIso(this.now);
    for (const op of linked) {
      await this.options.repository.upsertOperation({
        ...op,
        status: "FAILED",
        lastErrorCode: "ACCOUNT_DELETED",
        lastErrorMessage: "Account was deleted from Salesforce.",
        nextAttemptAt: null,
        steps: op.steps.map((s) => (s.status === "DONE" ? { ...s, status: "FAILED" as const, message: "Account deleted.", updatedAt: at } : s))
      });
    }
  }

  async getSheetsTarget(ownerUserId: string): Promise<DemoSheetsTargetRecord | null> {
    return this.options.repository.getSheetsTarget(ownerUserId);
  }

  async selectSheetsTarget(
    ownerUserId: string,
    input: { spreadsheet: string; tab?: string | null }
  ): Promise<DemoSheetsTargetRecord> {
    const spreadsheetId = spreadsheetIdFromInput(input.spreadsheet);
    const sheets = await this.options.connections.googleSheetsClient(ownerUserId);
    const metadata: SpreadsheetMetadata = await sheets.getSpreadsheet(spreadsheetId);
    const tab = input.tab?.trim() || metadata.tabs[0] || "Sheet1";
    if (!metadata.tabs.includes(tab)) {
      throw new DemoOperationError("DEMO_SHEET_TAB_MISSING", `The tab "${tab}" does not exist in this spreadsheet.`, 400);
    }
    let headerPresent = await sheets.ensureHeader(spreadsheetId, tab).catch(() => false);
    if (!headerPresent) {
      const existingRows = await sheets.getValues(spreadsheetId, `${tab}!A1:I2`);
      if (existingRows.length === 0) {
        await sheets.writeHeader(spreadsheetId, tab);
        headerPresent = true;
      }
    }
    return this.options.repository.upsertSheetsTarget({
      ownerUserId,
      spreadsheetId: metadata.spreadsheetId,
      spreadsheetUrl: metadata.spreadsheetUrl,
      title: metadata.title,
      tab,
      headerPresent,
      verifiedAt: nowIso(this.now)
    });
  }

  async createSheetsTarget(ownerUserId: string, input: { title?: string | null; tab?: string | null }): Promise<DemoSheetsTargetRecord> {
    const sheets = await this.options.connections.googleSheetsClient(ownerUserId);
    const tab = input.tab?.trim() || "Demo Sync";
    const title = input.title?.trim() || `Space Demo Projects — Salesforce sync (${new Date().toISOString().slice(0, 10)})`;
    const metadata = await sheets.createSpreadsheet({ title, tab });
    await sheets.writeHeader(metadata.spreadsheetId, tab).catch(() => undefined);
    return this.options.repository.upsertSheetsTarget({
      ownerUserId,
      spreadsheetId: metadata.spreadsheetId,
      spreadsheetUrl: metadata.spreadsheetUrl,
      title: metadata.title,
      tab,
      headerPresent: true,
      verifiedAt: nowIso(this.now)
    });
  }

  async verifySheetsTarget(ownerUserId: string): Promise<DemoSheetsTargetRecord | null> {
    const target = await this.options.repository.getSheetsTarget(ownerUserId);
    if (!target) return null;
    const sheets = await this.options.connections.googleSheetsClient(ownerUserId);
    const metadata = await sheets.getSpreadsheet(target.spreadsheetId);
    const headerPresent = await sheets.ensureHeader(target.spreadsheetId, target.tab).catch(() => false);
    return this.options.repository.upsertSheetsTarget({
      ...target,
      title: metadata.title,
      spreadsheetUrl: metadata.spreadsheetUrl,
      headerPresent,
      verifiedAt: nowIso(this.now)
    });
  }

  async isSheetReady(ownerUserId: string): Promise<boolean> {
    const target = await this.options.repository.getSheetsTarget(ownerUserId).catch(() => null);
    return Boolean(target?.spreadsheetId);
  }

  async countsForRun(ownerUserId: string, projectId: string): Promise<{ pending: number; failed: number }> {
    const operations = await this.options.repository.listOperations(ownerUserId, { projectId, limit: 200 });
    return {
      pending: operations.filter((operation) => operation.status === "PENDING" || operation.status === "RUNNING").length,
      failed: operations.filter((operation) => operation.status === "FAILED" || operation.status === "PARTIAL").length
    };
  }

  describeFailure(error: unknown): { code: string; message: string; statusCode: number } {
    if (error instanceof DemoConnectionError || error instanceof DemoOperationError) {
      return { code: error.code, message: error.message, statusCode: error.statusCode };
    }
    if (error instanceof SalesforceError || error instanceof GoogleSheetsError) {
      return { code: error.code, message: error.message, statusCode: error.statusCode };
    }
    return {
      code: "DEMO_CONNECTOR_FAILED",
      message: error instanceof Error ? error.message.slice(0, 300) : "The connector request failed.",
      statusCode: 502
    };
  }
}
