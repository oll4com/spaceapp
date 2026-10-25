import { describe, expect, it } from "vitest";
import { InMemoryGatewayRepository, type GatewayApiKeyRecord } from "@space/db";
import { generateGatewayApiKey } from "../src/api-keys.js";
import { applyRequestPolicy, assertModelAllowed, checkKeyLimits, PolicyRejection, trackKeyRequest, trackKeySettlement } from "../src/policy.js";
import { createGatewayServer } from "../src/server.js";

const nowIso = "2030-01-01T00:00:00.000Z";
function keyWith(overrides: Partial<GatewayApiKeyRecord>): GatewayApiKeyRecord {
  return { id: `gw_key:${"c".repeat(32)}`, allowedModels: [], enforcedModel: null, limits: [], ...overrides } as GatewayApiKeyRecord;
}
const costCap = (currentValue: number) => ({ limitType: "COST_USD", limitWindow: "DAILY", maxValue: 1_000_000, currentValue, modelFilter: null,
  resetAt: "2030-01-02T00:00:00.000Z" }) as GatewayApiKeyRecord["limits"][number];

describe("Space Gateway hardening (security addendum step 8)", () => {
  it("a key with a model allowlist refuses a request that names no model", () => {
    const key = keyWith({ allowedModels: ["gpt-6"] });
    expect(() => assertModelAllowed(key, null)).toThrow(PolicyRejection);
    expect(() => applyRequestPolicy({ input: "hi" }, key)).toThrow(/needs a model/);
    expect(() => applyRequestPolicy({ model: "gpt-6", input: "hi" }, key)).not.toThrow();
    expect(() => assertModelAllowed(keyWith({}), null)).not.toThrow();
  });

  it("parallel requests cannot all pass a nearly spent cost cap", async () => {
    const key = keyWith({ id: `gw_key:${"d".repeat(32)}`, limits: [costCap(0)] });
    const releases: Array<() => void> = [];
    let admitted = 0;
    // Each request is tracked when it authenticates, then checked; every other running request holds a $0.20 reserve.
    for (let index = 0; index < 10; index += 1) {
      const release = trackKeyRequest(key.id);
      try {
        checkKeyLimits(key, null, nowIso);
        admitted += 1;
        releases.push(release);
      } catch (error) {
        expect(error).toBeInstanceOf(PolicyRejection);
        release();
      }
    }
    expect(admitted).toBe(5);
    // A settlement still being written keeps its cost counted.
    let finishWrite!: () => void;
    const settling = trackKeySettlement(key.id, { inputTokens: 0, outputTokens: 0, costMicros: 1_000_000 }, () => new Promise<void>((resolve) => { finishWrite = resolve; }));
    releases.forEach((release) => release());
    const next = trackKeyRequest(key.id);
    expect(() => checkKeyLimits(key, null, nowIso)).toThrow(PolicyRejection);
    finishWrite();
    await settling;
    expect(() => checkKeyLimits(keyWith({ id: key.id, limits: [costCap(0)] }), null, nowIso)).not.toThrow();
    next();
  });

  it("limits how many requests one key starts per minute", async () => {
    const repository = new InMemoryGatewayRepository();
    const { plainKey, keyHash, keyPrefix } = generateGatewayApiKey();
    await repository.createApiKey({
      keyId: `gw_key:${"e".repeat(32)}`, name: "Rate", keyHash, keyPrefix, trafficClass: "INTERACTIVE", allowedModels: [],
      enforcedModel: null, allowedReasoningEfforts: [], enforcedReasoningEffort: null, accountIds: [], compressionOverride: null,
      limits: [], expiresAt: null, createdBy: null
    });
    const server = createGatewayServer({ repository, version: "test", credentialKeyPresent: () => false, keyRequestsPerMinute: 2 });
    const statuses: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      statuses.push((await server.app.inject({ method: "POST", url: "/v1/responses", headers: { authorization: `Bearer ${plainKey}` }, payload: {} })).statusCode);
    }
    expect(statuses).toEqual([503, 503, 429]);
    await server.app.close();
  });
});
