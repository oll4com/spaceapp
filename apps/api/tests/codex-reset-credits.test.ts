import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemoryGatewayRepository } from "@space/db";
import { InMemorySpaceStore } from "@space/runtime";
import { createCsrfToken, signSession } from "../src/auth.js";
import { createApp } from "../src/app.js";
import type { CodexResetCreditsService } from "../src/codex-reset-credits.js";
import { getApiConfig } from "../src/config.js";
import { createGatewayCodexResetCreditsService } from "../src/gateway/gateway-codex-services.js";

const sessionSecret = "codex-reset-credits-test-secret";
const csrfHeaderName = "x-space-csrf-token";
const checkedAt = "2026-07-24T08:00:00.000Z";
const idempotencyKey = "9943e22b-97a3-48b6-ae84-1a2cced6a353";
const apps: FastifyInstance[] = [];

function authHeaders(role: "OPERATOR" | "ADMIN") {
  const session = signSession(
    { id: `user:${role.toLowerCase()}`, email: `${role.toLowerCase()}@space.local`, role },
    sessionSecret
  );
  return {
    cookie: `space_session=${session}`,
    [csrfHeaderName]: createCsrfToken(session, sessionSecret)!
  };
}

function fakeService() {
  return {
    availability: vi.fn(async () => ({
      data: [
        { accountId: "account:one", availableCreditCount: 2 },
        { accountId: "account:unknown", availableCreditCount: null }
      ],
      source: "space-gateway" as const,
      isStale: false,
      error: null,
      checkedAt
    })),
    redeem: vi.fn(async (accountId: string) => ({
      response: { accountId, outcome: "RESET" as const, completedAt: checkedAt },
      audit: { outcome: "RESET" as const, usageVerified: true, creditIdHash: "sha256:first" }
    }))
  } satisfies CodexResetCreditsService;
}

async function setup(options: { store?: InMemorySpaceStore; service?: CodexResetCreditsService } = {}) {
  const store = options.store ?? new InMemorySpaceStore();
  const app = await createApp({
    store,
    config: getApiConfig({}),
    auth: { sessionSecret, devLogin: false, secureCookies: false },
    codexResetCreditsService: options.service ?? fakeService()
  });
  apps.push(app);
  return { app, store };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("Space Gateway reset credits", () => {
  it("joins a repeated click and refuses another redemption for the account while one runs", async () => {
    const accountId = `gw_account:${"a".repeat(32)}`;
    let finish!: () => void;
    const gatewayAdmin = vi.fn(() => new Promise<{ status: number; body: unknown }>((resolve) => {
      finish = () => resolve({ status: 200, body: { outcome: "RESET" } });
    }));
    const service = createGatewayCodexResetCreditsService({ repository: new InMemoryGatewayRepository(), admin: { gatewayAdmin } });
    const first = service.redeem(accountId, idempotencyKey);
    const again = service.redeem(accountId, idempotencyKey);
    await expect(service.redeem(accountId, "00000000-0000-4000-8000-000000000001")).rejects.toThrow(/already running/);
    finish();
    expect((await first).response).toMatchObject({ accountId, outcome: "RESET" });
    expect(await again).toBe(await first);
    expect(gatewayAdmin).toHaveBeenCalledTimes(1);
    // Once it ends, the account takes the next redemption.
    const next = service.redeem(accountId, "00000000-0000-4000-8000-000000000002");
    finish();
    await expect(next).resolves.toMatchObject({ audit: { outcome: "RESET", usageVerified: true } });
  });
});

describe("Codex reset credits API", () => {
  it("requires ADMIN and rejects reset access while the Codex master is off", async () => {
    const store = new InMemorySpaceStore();
    const service = fakeService();
    const { app } = await setup({ store, service });
    const operator = authHeaders("OPERATOR");

    for (const response of [
      await app.inject({ method: "GET", url: "/api/admin/codex-reset-credits", headers: operator }),
      await app.inject({
        method: "POST",
        url: "/api/admin/codex-reset-credits/account%3Aone/redemptions",
        headers: operator,
        payload: { idempotencyKey }
      })
    ]) {
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("ADMIN_REQUIRED");
    }

    store.updateCliRuntimeSetting(
      "cli:codex",
      { enabled: false, confirmationToken: "abcdefghijklmnopqrstuvwx" },
      "user:admin"
    );
    const admin = authHeaders("ADMIN");
    const disabled = await app.inject({
      method: "GET",
      url: "/api/admin/codex-reset-credits",
      headers: admin
    });
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json().error.code).toBe("CODEX_MASTER_DISABLED");
    expect(service.availability).not.toHaveBeenCalled();
  });

  it("returns availability and audits a redemption without raw credit identity", async () => {
    const { app, store } = await setup();
    const headers = authHeaders("ADMIN");

    const availability = await app.inject({
      method: "GET",
      url: "/api/admin/codex-reset-credits",
      headers
    });
    expect(availability.statusCode).toBe(200);
    expect(availability.json().data).toEqual([
      { accountId: "account:one", availableCreditCount: 2 },
      { accountId: "account:unknown", availableCreditCount: null }
    ]);

    const redeemed = await app.inject({
      method: "POST",
      url: "/api/admin/codex-reset-credits/account%3Aone/redemptions",
      headers,
      payload: { idempotencyKey }
    });
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.json()).toEqual({
      accountId: "account:one",
      outcome: "RESET",
      completedAt: checkedAt
    });
    expect(JSON.stringify(redeemed.json())).not.toContain("credit");

    const audit = store.listAuditEvents().find((event) => event.action === "admin.codex_reset_credit.redeemed");
    expect(audit).toMatchObject({
      targetId: "account:one",
      metadata: {
        outcome: "RESET",
        usageVerified: true,
        creditIdHash: "sha256:first"
      }
    });
    expect(JSON.stringify(audit)).not.toContain("credit:expires-first");
  });

  it("validates UUIDs and limits redemption attempts to twelve per five minutes", async () => {
    const { app } = await setup();
    const headers = authHeaders("ADMIN");
    const invalid = await app.inject({
      method: "POST",
      url: "/api/admin/codex-reset-credits/account%3Aone/redemptions",
      headers,
      payload: { idempotencyKey: "retry-1" }
    });
    expect(invalid.statusCode).toBe(422);

    const responses = [];
    for (let index = 0; index < 13; index += 1) {
      responses.push(await app.inject({
        method: "POST",
        url: "/api/admin/codex-reset-credits/account%3Aone/redemptions",
        headers,
        payload: { idempotencyKey: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` }
      }));
    }
    expect(responses.slice(0, 12).every((response) => response.statusCode === 200)).toBe(true);
    expect(responses[12]?.statusCode).toBe(429);
  });
});
