import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getMemoryAiAuditConfig, runMemoryAiAudit } from "../src/memory-ai-audit.js";

const conflictIssue = {
  id: "issue:conflict-a",
  type: "CONFLICT" as const,
  severity: "ERROR" as const,
  status: "OPEN" as const,
  confidence: 1,
  recordId: "memory:conflict-a",
  sourcePath: "/opt/spaceapp/docs/gemini_history_2026-07.md",
  evidence: "memory:conflict-a conflicts with memory:conflict-b."
};

describe("memory AI audit", () => {
  it("keeps the lane disabled by default and clamps explicit batch settings", () => {
    expect(getMemoryAiAuditConfig({})).toMatchObject({
      enabled: false,
      baseUrl: null,
      keyFile: null,
      keyName: null,
      model: null,
      timeoutMs: 10_000,
      maxIssues: 20,
      maxRecordChars: 500
    });
    expect(getMemoryAiAuditConfig({
      SPACE_MEMORY_AI_AUDIT_ENABLED: "true",
      SPACE_MEMORY_AI_AUDIT_BASE_URL: "http://codex-lb.internal/v1",
      SPACE_MEMORY_AI_AUDIT_KEY_FILE: "/opt/spaceapp/secrets/space-memory-ai-audit.key",
      SPACE_MEMORY_AI_AUDIT_KEY_NAME: "space-memory-ai-audit",
      SPACE_MEMORY_AI_AUDIT_MODEL: "gpt-5.5",
      SPACE_MEMORY_AI_AUDIT_TIMEOUT_MS: "99999",
      SPACE_MEMORY_AI_AUDIT_MAX_ISSUES: "999",
      SPACE_MEMORY_AI_AUDIT_MAX_RECORD_CHARS: "99999"
    })).toMatchObject({
      enabled: true,
      model: "gpt-5.5",
      timeoutMs: 30_000,
      maxIssues: 100,
      maxRecordChars: 2_000
    });
  });

  it("verifies a dedicated Codex-LB model with a bounded redacted batch and downgrades unsafe output", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-memory-ai-audit-"));
    const keyFile = join(root, "space-memory-ai-audit.key");
    await writeFile(keyFile, "test-memory-audit-credential\n", "utf8");
    await chmod(keyFile, 0o640);
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "gpt-5.5" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              suggestions: [{
                issueId: conflictIssue.id,
                operationKind: "ARCHIVE_SUPERSEDED",
                confidence: 0.9,
                rationale: "Archive it."
              }]
            })
          }
        }]
      }), { status: 200 });
    };
    const env = {
      SPACE_MEMORY_AI_AUDIT_ENABLED: "true",
      SPACE_MEMORY_AI_AUDIT_BASE_URL: "http://codex-lb.internal/v1",
      SPACE_MEMORY_AI_AUDIT_KEY_FILE: keyFile,
      SPACE_MEMORY_AI_AUDIT_KEY_NAME: "space-memory-ai-audit",
      SPACE_MEMORY_AI_AUDIT_MODEL: "gpt-5.5"
    };

    const result = await runMemoryAiAudit({
      issues: [conflictIssue],
      records: [{
        id: "memory:conflict-a",
        title: "Conflict A",
        body: `token=supersecretvalue ${"x".repeat(4_000)}`,
        provenance: "operator",
        sourcePath: conflictIssue.sourcePath
      }]
    }, { env, fetchImpl });

    expect(result).toEqual({
      status: "VERIFIED",
      verified: true,
      modelId: "gpt-5.5",
      suggestionCount: 1,
      downgradedCount: 1,
      evidence: {
        providerSmoke: "PASSED",
        outputValidation: "PASSED",
        batchIssueCount: 1,
        batchRecordCount: 1
      }
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]!.url).toBe("http://codex-lb.internal/v1/models");
    const requestBody = JSON.parse(String(requests[1]!.init?.body));
    expect(requestBody.model).toBe("gpt-5.5");
    expect(requestBody).not.toHaveProperty("tools");
    expect(JSON.stringify(requestBody)).toContain("token:[REDACTED]");
    expect(JSON.stringify(requestBody)).not.toContain("supersecretvalue");
    expect(JSON.stringify(requestBody).length).toBeLessThan(20_000);
  });

  it("degrades deterministically when provider output is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-memory-ai-audit-malformed-"));
    const keyFile = join(root, "space-memory-ai-audit.key");
    await writeFile(keyFile, "test-memory-audit-credential\n", "utf8");
    await chmod(keyFile, 0o640);
    let calls = 0;
    const result = await runMemoryAiAudit({ issues: [conflictIssue], records: [] }, {
      env: {
        SPACE_MEMORY_AI_AUDIT_ENABLED: "true",
        SPACE_MEMORY_AI_AUDIT_BASE_URL: "http://codex-lb.internal/v1",
        SPACE_MEMORY_AI_AUDIT_KEY_FILE: keyFile,
        SPACE_MEMORY_AI_AUDIT_KEY_NAME: "space-memory-ai-audit",
        SPACE_MEMORY_AI_AUDIT_MODEL: "gpt-5.5"
      },
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? new Response(JSON.stringify({ data: [{ id: "gpt-5.5" }] }), { status: 200 })
          : new Response(JSON.stringify({ choices: [{ message: { content: "not-json" } }] }), { status: 200 });
      }
    });

    expect(result).toMatchObject({
      status: "DEGRADED",
      verified: false,
      modelId: null,
      suggestionCount: 0,
      downgradedCount: 0,
      evidence: { providerSmoke: "PASSED", outputValidation: "FAILED" }
    });
  });
});
