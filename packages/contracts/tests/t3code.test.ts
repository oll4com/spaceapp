import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";
import {
  paneModeSchema,
  restartT3CodeInputSchema,
  roomPaneBatchItemSchema,
  t3CodeAdminStatusSchema,
  updateT3CodeEnabledInputSchema
} from "../src/index.js";

const status = {
  version: 1,
  featureEnabled: true,
  serviceEnabled: true,
  serviceActive: true,
  socketActive: true,
  pid: 4242,
  ready: true,
  serverVersion: "0.0.44",
  runtime: {
    tag: "v0.0.45",
    commit: "6c8fed35dded9ff71c5b46807125457acbb76be6",
    packageVersion: "0.0.44",
    integrationRevision: 4,
    runtimeId: "v0.0.45-space.4-40b46afa8d98feff"
  },
  activeRuns: 0,
  checkedAt: "2026-10-10T00:00:00.000Z"
};

describe("T3 Code contracts", () => {
  it("keeps T3CODE as a first-class pane mode", () => {
    expect(paneModeSchema.safeParse("T3CODE").success).toBe(true);
    expect(paneModeSchema.safeParse("INVALID_MODE").success).toBe(false);
    expect(roomPaneBatchItemSchema.safeParse({ mode: "T3CODE" }).success).toBe(true);
  });

  it("validates ADMIN service status and strict control inputs", () => {
    expect(t3CodeAdminStatusSchema.parse(status)).toEqual(status);
    expect(t3CodeAdminStatusSchema.safeParse({ ...status, pid: null, runtime: null, activeRuns: null, ready: false }).success).toBe(true);
    expect(t3CodeAdminStatusSchema.safeParse({ ...status, threads: [] }).success).toBe(false);
    expect(t3CodeAdminStatusSchema.safeParse({ ...status, activeRuns: -1 }).success).toBe(false);
    expect(updateT3CodeEnabledInputSchema.safeParse({ enabled: false, confirmActiveRuns: true }).success).toBe(true);
    expect(updateT3CodeEnabledInputSchema.safeParse({ enabled: "false" }).success).toBe(false);
    expect(restartT3CodeInputSchema.safeParse({}).success).toBe(true);
    expect(restartT3CodeInputSchema.safeParse({ unit: "other.service" }).success).toBe(false);
  });

  it("no longer exports the retired supervision simulator contracts", () => {
    const exported = contracts as Record<string, unknown>;
    for (const name of [
      "t3CodePaneStateSchema", "t3CodeAgentEventSchema", "t3CodeApprovalDecisionSchema",
      "t3CodeSupervisionPolicySchema", "t3CodeSessionSummarySchema", "createT3CodeEventInputSchema"
    ]) expect(exported[name], name).toBeUndefined();
  });
});
