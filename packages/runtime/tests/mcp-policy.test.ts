import { describe, expect, it } from "vitest";
import { decideMcpToolPolicy, hashMcpSchema } from "../src/index.js";

describe("MCP policy", () => {
  const schemaA = {
    type: "object",
    properties: {
      path: { type: "string" },
      recursive: { type: "boolean", default: false }
    },
    required: ["path"],
    additionalProperties: false
  };

  it("hashes schemas canonically without depending on object key order", () => {
    const schemaB = {
      required: ["path"],
      additionalProperties: false,
      properties: {
        recursive: { default: false, type: "boolean" },
        path: { type: "string" }
      },
      type: "object"
    };

    expect(hashMcpSchema(schemaA)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(hashMcpSchema(schemaA)).toBe(hashMcpSchema(schemaB));
    expect(hashMcpSchema({ ...schemaA, required: ["path", "recursive"] })).not.toBe(hashMcpSchema(schemaA));
  });

  it("blocks execution while the gateway, server, or tool is not verified", () => {
    const schemaHash = hashMcpSchema(schemaA);

    expect(
      decideMcpToolPolicy({
        gatewayApprovalMode: "DISABLED",
        serverStatus: "VERIFIED",
        toolStatus: "VERIFIED",
        riskLevel: "R0",
        schemaHash,
        toolApprovalRequired: false,
        allowlistedSchemaHashes: [schemaHash]
      })
    ).toMatchObject({ decision: "BLOCKED", reasonCode: "GATEWAY_DISABLED", approvalRequired: true });

    expect(
      decideMcpToolPolicy({
        gatewayApprovalMode: "ALLOWLISTED",
        serverStatus: "ERROR",
        toolStatus: "VERIFIED",
        riskLevel: "R0",
        schemaHash,
        toolApprovalRequired: false,
        allowlistedSchemaHashes: [schemaHash]
      })
    ).toMatchObject({ decision: "BLOCKED", reasonCode: "SERVER_NOT_VERIFIED", approvalRequired: true });

    expect(
      decideMcpToolPolicy({
        gatewayApprovalMode: "ALLOWLISTED",
        serverStatus: "VERIFIED",
        toolStatus: "DISABLED",
        riskLevel: "R0",
        schemaHash,
        toolApprovalRequired: false,
        allowlistedSchemaHashes: [schemaHash]
      })
    ).toMatchObject({ decision: "BLOCKED", reasonCode: "TOOL_NOT_VERIFIED", approvalRequired: true });
  });

  it("requires approval or blocks unless low-risk schemas are allowlisted", () => {
    const schemaHash = hashMcpSchema(schemaA);

    expect(
      decideMcpToolPolicy({
        gatewayApprovalMode: "ALLOWLISTED",
        serverStatus: "VERIFIED",
        toolStatus: "VERIFIED",
        riskLevel: "R0",
        schemaHash,
        toolApprovalRequired: false,
        allowlistedSchemaHashes: []
      })
    ).toMatchObject({ decision: "BLOCKED", reasonCode: "SCHEMA_HASH_NOT_ALLOWLISTED", approvalRequired: true });

    expect(
      decideMcpToolPolicy({
        gatewayApprovalMode: "ALLOWLISTED",
        serverStatus: "VERIFIED",
        toolStatus: "VERIFIED",
        riskLevel: "R0",
        schemaHash,
        toolApprovalRequired: false,
        allowlistedSchemaHashes: [schemaHash]
      })
    ).toMatchObject({ decision: "ALLOWED", reasonCode: "SCHEMA_HASH_ALLOWLISTED", approvalRequired: false });

    expect(
      decideMcpToolPolicy({
        gatewayApprovalMode: "ALLOWLISTED",
        serverStatus: "VERIFIED",
        toolStatus: "VERIFIED",
        riskLevel: "R2",
        schemaHash,
        toolApprovalRequired: false,
        allowlistedSchemaHashes: [schemaHash]
      })
    ).toMatchObject({ decision: "REQUIRES_APPROVAL", reasonCode: "RISK_APPROVAL_REQUIRED", approvalRequired: true });

    expect(
      decideMcpToolPolicy({
        gatewayApprovalMode: "ALWAYS_ASK",
        serverStatus: "VERIFIED",
        toolStatus: "VERIFIED",
        riskLevel: "R0",
        schemaHash,
        toolApprovalRequired: false,
        allowlistedSchemaHashes: []
      })
    ).toMatchObject({ decision: "REQUIRES_APPROVAL", reasonCode: "GATEWAY_ALWAYS_ASK", approvalRequired: true });
  });
});
