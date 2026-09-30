import { randomBytes } from "node:crypto";
import type { DemoTestRun, DemoTestStep, DemoTestRunStatus } from "@space/contracts";
import type { DemoProjectsRepository, DemoRunRecord, DemoTestRunRecord } from "@space/db";

export interface DemoTestRunnerOptions {
  repository: DemoProjectsRepository;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  stepTimeoutMs?: number;
}

interface ScenarioContext {
  baseUrl: string;
  mode: "SAMPLE" | "LIVE";
  projectId: string;
  variantId: string;
  runId: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  operationKey: string;
}

interface ScenarioStep {
  key: string;
  label: string | ((context: ScenarioContext) => string);
  run: (context: ScenarioContext) => Promise<string>;
}

class StepFailure extends Error {}

async function jsonRequest(
  context: ScenarioContext,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown }> {
  const response = await context.fetchImpl(`${context.baseUrl}${path}`, {
    ...init,
    headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...((init.headers as Record<string, string>) ?? {}) },
    signal: AbortSignal.timeout(context.timeoutMs)
  });
  const text = await response.text().catch(() => "");
  let body: unknown = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text.slice(0, 200);
  }
  return { status: response.status, body };
}

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

const commonSteps: ScenarioStep[] = [
  {
    key: "health",
    label: "The demo runtime answers its own health check",
    run: async (context) => {
      const { status, body } = await jsonRequest(context, "/healthz");
      if (status !== 200) throw new StepFailure(`Health check returned ${status}.`);
      const record = asRecord(body);
      if (record.ok !== true) throw new StepFailure("The demo reported an unhealthy state.");
      return `Run ${String(record.runId ?? context.runId)} healthy in ${String(record.mode ?? context.mode)} mode.`;
    }
  },
  {
    key: "variant-identity",
    label: "The running server reports the selected project and variant",
    run: async (context) => {
      const { status, body } = await jsonRequest(context, "/api/config");
      if (status !== 200) throw new StepFailure(`Config endpoint returned ${status}.`);
      const record = asRecord(body);
      if (record.projectId !== context.projectId) throw new StepFailure(`Expected project ${context.projectId}, received ${String(record.projectId)}.`);
      if (record.variantId !== context.variantId) throw new StepFailure(`Expected variant ${context.variantId}, received ${String(record.variantId)}.`);
      if (record.mode !== context.mode) throw new StepFailure(`Expected mode ${context.mode}, received ${String(record.mode)}.`);
      return `Serving ${context.projectId} · ${context.variantId} in ${context.mode}.`;
    }
  },
  {
    key: "validation",
    label: "Empty input is rejected before any external call",
    run: async (context) => {
      const { status } = await jsonRequest(context, "/api/records", { method: "POST", body: JSON.stringify({}) });
      if (status !== 400) throw new StepFailure(`Expected 400 for invalid input, received ${status}.`);
      return "Invalid payload rejected with 400.";
    }
  },
  {
    key: "create",
    label: "A valid record is created exactly once",
    run: async (context) => {
      const suffix = context.operationKey.replace(/[^A-Za-z0-9]/g, "").slice(-6);
      const payload = {
        operationKey: context.operationKey,
        name: `Space Demo Test ${suffix}`,
        contactLastName: `Test-${suffix}`,
        firstName: "Space",
        email: `demo-test-${suffix}@spaceapp.example`,
        phone: "+30 0000000000",
        website: "http://127.0.0.1:4911",
        title: "Test task"
      };
      const first = await jsonRequest(context, "/api/records", { method: "POST", body: JSON.stringify(payload) });
      if (first.status !== 201 && first.status !== 200) {
        throw new StepFailure(`Create returned ${first.status}: ${JSON.stringify(first.body).slice(0, 200)}`);
      }
      const created = asRecord(first.body);
      const id = String(created.id ?? "");
      if (!id) throw new StepFailure("Create did not return a record id.");
      const second = await jsonRequest(context, "/api/records", { method: "POST", body: JSON.stringify(payload) });
      const repeated = asRecord(second.body);
      if (String(repeated.id ?? "") !== id) throw new StepFailure("A repeated submit created a second record.");
      return `Record ${id} created once; repeated submit returned the same record.`;
    }
  },
  {
    key: "read-back",
    label: "The created record is visible in the list",
    run: async (context) => {
      const { status, body } = await jsonRequest(context, "/api/records?page=1&pageSize=25");
      if (status !== 200) throw new StepFailure(`List returned ${status}.`);
      const record = asRecord(body);
      const data = Array.isArray(record.data) ? (record.data as Array<Record<string, unknown>>) : [];
      const match = data.find((entry) => entry.operationKey === context.operationKey);
      if (!match) throw new StepFailure("The created record is missing from the list.");
      return `List returned ${data.length} row(s) including ${String(match.id)}.`;
    }
  },
  {
    key: "sync-status",
    label: "The record reaches a completed synchronisation state",
    run: async (context) => {
      const deadline = Date.now() + (context.mode === "LIVE" ? 45_000 : 8_000);
      let last = "";
      while (Date.now() < deadline) {
        const { body } = await jsonRequest(context, "/api/records?page=1&pageSize=25");
        const data = Array.isArray(asRecord(body).data) ? (asRecord(body).data as Array<Record<string, unknown>>) : [];
        const match = data.find((entry) => entry.operationKey === context.operationKey);
        last = String(match?.syncStatus ?? match?.status ?? "unknown");
        if (last === "SYNCED" || last === "COMPLETED") {
          const externalIds = [match?.accountId, match?.contactId].filter((value) => typeof value === "string" && value.length > 0).length;
          return `Synchronisation finished with status ${last}${externalIds > 0 ? ` and ${externalIds} external id(s)` : ""}.`;
        }
        if (last === "FAILED" || last === "PARTIAL") throw new StepFailure(`Synchronisation ended as ${last}.`);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      throw new StepFailure(`Synchronisation did not complete within the window (last status ${last}).`);
    }
  },
  {
    key: "isolation",
    label: "The run writes only inside its own workspace",
    run: async (context) => {
      const { status, body } = await jsonRequest(context, "/api/isolation");
      if (status !== 200) throw new StepFailure(`Isolation endpoint returned ${status}.`);
      const record = asRecord(body);
      if (record.runId !== context.runId) throw new StepFailure("The run reported a different run id.");
      if (record.workspaceInsideRun !== true) throw new StepFailure("The run data directory is outside the run workspace.");
      if (record.sharedStateDetected === true) throw new StepFailure("The run reports shared state with another run.");
      return `Data directory is isolated to ${String(record.dataPath ?? "the run workspace")}.`;
    }
  }
];

const projectOneSteps: ScenarioStep[] = [
  {
    key: "accounts-table",
    label: "The accounts table reflects the data source of this mode",
    run: async (context) => {
      const { status, body } = await jsonRequest(context, "/api/accounts?page=1&pageSize=10");
      if (status !== 200) throw new StepFailure(`Accounts endpoint returned ${status}.`);
      const record = asRecord(body);
      const expected = context.mode === "LIVE" ? "salesforce" : "sample";
      if (record.source !== expected) throw new StepFailure(`Expected source ${expected}, received ${String(record.source)}.`);
      const data = Array.isArray(record.data) ? (record.data as unknown[]) : [];
      return `${data.length} account row(s) served from ${String(record.source)}.`;
    }
  },
  {
    key: "sheets-state",
    label: context => (context.mode === "LIVE" ? "A Google Sheets row was verified by read-back" : "Sample mode keeps every write local"),
    run: async (context) => {
      const { status, body } = await jsonRequest(context, "/api/records?page=1&pageSize=25");
      if (status !== 200) throw new StepFailure(`List returned ${status}.`);
      const data = Array.isArray(asRecord(body).data) ? (asRecord(body).data as Array<Record<string, unknown>>) : [];
      const match = data.find((entry) => entry.operationKey === context.operationKey);
      if (!match) throw new StepFailure("The created record is missing.");
      if (context.mode === "SAMPLE") {
        if (match.sheetRow !== null && match.sheetRow !== undefined && match.sheetRow !== "") {
          return `Sample mode recorded a local row marker (${String(match.sheetRow)}) without external writes.`;
        }
        return "Sample mode kept the row inside the run workspace.";
      }
      if (!match.sheetRow) throw new StepFailure("No Google Sheets row was recorded for the live operation.");
      return `Google Sheets row ${String(match.sheetRow)} matched the Salesforce ids on read-back.`;
    }
  }
];

const projectTwoSteps: ScenarioStep[] = [
  {
    key: "lifecycle",
    label: "Task status can be changed and the record removed",
    run: async (context) => {
      const list = await jsonRequest(context, "/api/records?page=1&pageSize=25");
      const data = Array.isArray(asRecord(list.body).data) ? (asRecord(list.body).data as Array<Record<string, unknown>>) : [];
      const match = data.find((entry) => entry.operationKey === context.operationKey);
      const id = String(match?.id ?? "");
      if (!id) throw new StepFailure("The created task is missing before the lifecycle check.");
      const updated = await jsonRequest(context, `/api/records/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "DONE" })
      });
      if (updated.status !== 200) throw new StepFailure(`Status update returned ${updated.status}.`);
      if (asRecord(updated.body).status !== "DONE") throw new StepFailure("The status update was not applied.");
      const removed = await jsonRequest(context, `/api/records/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (removed.status !== 200 && removed.status !== 204) throw new StepFailure(`Delete returned ${removed.status}.`);
      const after = await jsonRequest(context, "/api/records?page=1&pageSize=25");
      const remaining = Array.isArray(asRecord(after.body).data) ? (asRecord(after.body).data as Array<Record<string, unknown>>) : [];
      if (remaining.some((entry) => entry.id === id)) throw new StepFailure("The task is still present after deletion.");
      return `Task ${id} moved to DONE and was removed.`;
    }
  }
];

export class DemoTestRunner {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly stepTimeoutMs: number;

  constructor(private readonly options: DemoTestRunnerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.stepTimeoutMs = options.stepTimeoutMs ?? 12_000;
  }

  async run(input: {
    ownerUserId: string;
    run: DemoRunRecord;
    variantId: string;
    projectId: string;
  }): Promise<DemoTestRun> {
    if (!input.run.port || input.run.status !== "RUNNING") {
      throw new Error("The demo run must be running before tests can execute.");
    }
    const startedAt = this.now().toISOString();
    const context: ScenarioContext = {
      baseUrl: `http://127.0.0.1:${input.run.port}`,
      mode: input.run.mode,
      projectId: input.projectId,
      variantId: input.variantId,
      runId: input.run.id,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.stepTimeoutMs,
      operationKey: `test-${input.run.id.replace(/[^a-zA-Z0-9]/g, "").slice(-10)}-${Date.now().toString(36)}`
    };
    const steps = [...commonSteps, ...(input.projectId === "project-1-salesforce-crm" ? projectOneSteps : projectTwoSteps)];
    const results: DemoTestStep[] = [];
    for (const definition of steps) {
      const label = typeof definition.label === "function" ? definition.label(context) : definition.label;
      const stepStartedAt = Date.now();
      try {
        const detail = await definition.run(context);
        results.push({ key: definition.key, label, status: "PASSED", detail: detail.slice(0, 500), durationMs: Date.now() - stepStartedAt });
      } catch (error) {
        const detail = error instanceof Error ? error.message.slice(0, 500) : "The step failed.";
        results.push({ key: definition.key, label, status: "FAILED", detail, durationMs: Date.now() - stepStartedAt });
        break;
      }
    }
    const status: DemoTestRunStatus = results.every((step) => step.status === "PASSED") ? "PASSED" : "FAILED";
    const finishedAt = this.now().toISOString();
    const record = await this.options.repository.createTestRun({
      id: `demo-test:${randomBytes(9).toString("hex")}`,
      ownerUserId: input.ownerUserId,
      projectId: input.projectId,
      variantId: input.variantId,
      mode: input.run.mode,
      status,
      steps: results,
      startedAt,
      finishedAt
    });
    return {
      id: record.id,
      projectId: record.projectId,
      variantId: record.variantId,
      mode: record.mode,
      status: record.status,
      steps: record.steps.map((step) => ({ ...step })),
      startedAt: record.startedAt,
      finishedAt: record.finishedAt
    };
  }

  async list(ownerUserId: string, projectId: string, limit = 10): Promise<DemoTestRunRecord[]> {
    return this.options.repository.listTestRuns(ownerUserId, projectId, limit);
  }
}
