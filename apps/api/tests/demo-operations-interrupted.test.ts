import { describe, expect, it } from "vitest";
import { InMemoryDemoProjectsRepository, type DemoOperationRecord, type DemoOperationStepRecord } from "@space/db";
import { DemoOperationsService } from "../src/demo-projects/operations.js";

const at = "2026-11-04T00:00:00.000Z";
const step = (key: DemoOperationStepRecord["key"], status: DemoOperationStepRecord["status"]): DemoOperationStepRecord =>
  ({ key, status, attempts: status === "PENDING" ? 0 : 1, externalId: status === "DONE" ? "001" : null, message: null, updatedAt: at });

function operation(id: string, status: DemoOperationRecord["status"], steps: DemoOperationStepRecord[]): Omit<DemoOperationRecord, "createdAt" | "updatedAt"> {
  return {
    id, ownerUserId: "user:owner", operationKey: id, projectId: "crm-lead-sync", variantId: "v1", mode: "LIVE", status,
    accountName: "Acme", contactLastName: "Doe", firstName: null, email: null, phone: null, website: null,
    salesforceAccountId: null, salesforceContactId: null, salesforceInstanceUrl: null, sheetsRow: null, sheetsVerifiedAt: null,
    steps, attempts: 1, nextAttemptAt: null, lastErrorCode: null, lastErrorMessage: null
  };
}

describe("DATA-001: demo syncs cut by an API restart", () => {
  it("fails a sync the previous API left RUNNING, once, without an automatic retry", async () => {
    const repository = new InMemoryDemoProjectsRepository();
    await repository.upsertOperation(operation("op-contact", "RUNNING",
      [step("salesforce-account", "DONE"), step("salesforce-contact", "RUNNING"), step("google-sheets-row", "PENDING")]));
    await repository.upsertOperation(operation("op-account", "RUNNING",
      [step("salesforce-account", "RUNNING"), step("salesforce-contact", "PENDING"), step("google-sheets-row", "PENDING")]));
    await repository.upsertOperation(operation("op-synced", "SYNCED",
      [step("salesforce-account", "DONE"), step("salesforce-contact", "DONE"), step("google-sheets-row", "DONE")]));
    const service = new DemoOperationsService({ repository, connections: {} as never, now: () => new Date(at) });

    await service.processPending(4);

    const contact = await repository.getOperation("op-contact");
    expect(contact).toMatchObject({ status: "PARTIAL", lastErrorCode: "DEMO_OPERATION_INTERRUPTED", nextAttemptAt: null, attempts: 2 });
    expect(contact?.steps.map((candidate) => candidate.status)).toEqual(["DONE", "FAILED", "PENDING"]);
    expect(await repository.getOperation("op-account")).toMatchObject({ status: "FAILED", lastErrorCode: "DEMO_OPERATION_INTERRUPTED", nextAttemptAt: null });
    expect((await repository.getOperation("op-synced"))?.status).toBe("SYNCED");
    expect(await repository.listRunningOperations()).toEqual([]);

    // Later batches of the same process leave RUNNING rows alone: from now on they are its own.
    await repository.upsertOperation(operation("op-own", "RUNNING", [step("salesforce-account", "RUNNING")]));
    await service.processPending(4);
    expect((await repository.getOperation("op-own"))?.status).toBe("RUNNING");
  });
});
