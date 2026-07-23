import { createHash } from "node:crypto";
import type { IntegrationStatus, McpApprovalMode, McpRiskLevel } from "@space/contracts";

export type McpToolPolicyDecisionKind = "BLOCKED" | "REQUIRES_APPROVAL" | "ALLOWED";

export type McpToolPolicyReasonCode =
  | "GATEWAY_DISABLED"
  | "SERVER_NOT_VERIFIED"
  | "TOOL_NOT_VERIFIED"
  | "SCHEMA_HASH_INVALID"
  | "GATEWAY_ALWAYS_ASK"
  | "SCHEMA_HASH_NOT_ALLOWLISTED"
  | "RISK_APPROVAL_REQUIRED"
  | "TOOL_APPROVAL_REQUIRED"
  | "SCHEMA_HASH_ALLOWLISTED";

export interface McpToolPolicyInput {
  gatewayApprovalMode: McpApprovalMode;
  serverStatus: IntegrationStatus;
  toolStatus: IntegrationStatus;
  riskLevel: McpRiskLevel;
  schemaHash: string;
  toolApprovalRequired: boolean;
  allowlistedSchemaHashes?: readonly string[];
}

export interface McpToolPolicyDecision {
  decision: McpToolPolicyDecisionKind;
  reasonCode: McpToolPolicyReasonCode;
  approvalRequired: boolean;
  canExecuteWithoutApproval: boolean;
}

const validSchemaHashPattern = /^sha256:[a-f0-9]{64}$/;
const elevatedRiskLevels = new Set<McpRiskLevel>(["R2", "R3", "R4"]);

function blocked(reasonCode: McpToolPolicyReasonCode): McpToolPolicyDecision {
  return { decision: "BLOCKED", reasonCode, approvalRequired: true, canExecuteWithoutApproval: false };
}

function requiresApproval(reasonCode: McpToolPolicyReasonCode): McpToolPolicyDecision {
  return { decision: "REQUIRES_APPROVAL", reasonCode, approvalRequired: true, canExecuteWithoutApproval: false };
}

function allowed(reasonCode: McpToolPolicyReasonCode): McpToolPolicyDecision {
  return { decision: "ALLOWED", reasonCode, approvalRequired: false, canExecuteWithoutApproval: true };
}

function normalizeForCanonicalJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("MCP schema hash input must not contain non-finite numbers.");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForCanonicalJson(item));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, normalizeForCanonicalJson(entryValue)])
    );
  }
  throw new Error(`MCP schema hash input cannot contain ${typeof value}.`);
}

export function canonicalizeMcpSchema(schema: unknown): string {
  return JSON.stringify(normalizeForCanonicalJson(schema));
}

export function hashMcpSchema(schema: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalizeMcpSchema(schema), "utf8").digest("hex")}`;
}

export function decideMcpToolPolicy(input: McpToolPolicyInput): McpToolPolicyDecision {
  if (input.gatewayApprovalMode === "DISABLED") {
    return blocked("GATEWAY_DISABLED");
  }
  if (input.serverStatus !== "VERIFIED") {
    return blocked("SERVER_NOT_VERIFIED");
  }
  if (input.toolStatus !== "VERIFIED") {
    return blocked("TOOL_NOT_VERIFIED");
  }
  if (!validSchemaHashPattern.test(input.schemaHash)) {
    return blocked("SCHEMA_HASH_INVALID");
  }
  if (input.gatewayApprovalMode === "ALWAYS_ASK") {
    return requiresApproval("GATEWAY_ALWAYS_ASK");
  }

  const allowlistedSchemaHashes = new Set(input.allowlistedSchemaHashes ?? []);
  if (!allowlistedSchemaHashes.has(input.schemaHash)) {
    return blocked("SCHEMA_HASH_NOT_ALLOWLISTED");
  }
  if (elevatedRiskLevels.has(input.riskLevel)) {
    return requiresApproval("RISK_APPROVAL_REQUIRED");
  }
  if (input.toolApprovalRequired) {
    return requiresApproval("TOOL_APPROVAL_REQUIRED");
  }
  return allowed("SCHEMA_HASH_ALLOWLISTED");
}
