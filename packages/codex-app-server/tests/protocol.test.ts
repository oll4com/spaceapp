import { describe, expect, it } from "vitest";
import {
  assertCodexAppServerRpcMethodAllowed,
  permissionParamsForMode,
  validatePermissionModeRequirements
} from "../src/index.js";

describe("Codex App Server permission protocol", () => {
  it.each([
    [
      "ask_for_approval",
      { sandbox: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "user" }
    ],
    [
      "approve_for_me",
      { sandbox: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "guardian_subagent" }
    ],
    [
      "full_access",
      { sandbox: "danger-full-access", approvalPolicy: "never", approvalsReviewer: "user" }
    ]
  ] as const)("maps %s to exact app-server fields", (mode, expected) => {
    expect(permissionParamsForMode(mode)).toEqual(expected);
  });

  it("preserves inherited permission behavior without an explicit override", () => {
    expect(permissionParamsForMode(null)).toBeNull();
    expect(() => validatePermissionModeRequirements(null, null)).not.toThrow();
  });

  it("fails closed when any explicit permission field is disallowed", () => {
    expect(() => validatePermissionModeRequirements("approve_for_me", {
      allowedApprovalPolicies: ["on-request"],
      allowedApprovalsReviewers: ["user"],
      allowedSandboxModes: ["workspace-write"]
    })).toThrow("Codex permission mode is not allowed by runtime requirements.");
  });

  it("accepts null requirement lists as unrestricted", () => {
    expect(() => validatePermissionModeRequirements("full_access", {
      allowedApprovalPolicies: null,
      allowedApprovalsReviewers: null,
      allowedSandboxModes: null
    })).not.toThrow();
  });
});

describe("Codex App Server RPC allowlist", () => {
  it.each([
    "initialize",
    "config/read",
    "configRequirements/read",
    "collaborationMode/list",
    "thread/start",
    "thread/resume",
    "thread/settings/update",
    "turn/start",
    "thread/goal/get",
    "thread/goal/set",
    "thread/goal/clear"
  ])("allows %s", (method) => {
    expect(() => assertCodexAppServerRpcMethodAllowed(method)).not.toThrow();
  });

  it("rejects methods outside the bounded protocol surface", () => {
    expect(() => assertCodexAppServerRpcMethodAllowed("config/value/write")).toThrow(
      "Codex App Server RPC method is not allowed."
    );
  });
});
