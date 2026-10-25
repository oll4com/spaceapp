import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import {
  SourceControlBrokerClient,
  SourceControlPublishingError,
  SourceControlPublishingManager,
  type SourceControlBroker
} from "../src/source-control-publishing.js";

const sessionSecret = "source-control-publishing-test-secret";
const apps: FastifyInstance[] = [];

function authHeaders(role: "OPERATOR" | "ADMIN") {
  const session = signSession(
    { id: `user:${role.toLowerCase()}`, email: `${role.toLowerCase()}@space.local`, role },
    sessionSecret
  );
  return {
    cookie: `space_session=${session}`,
    "x-space-csrf-token": createCsrfToken(session, sessionSecret)!
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("source-control publishing credentials", () => {
  it("passes replacement credentials only over stdin", async () => {
    const calls: Array<{ command: string; args: string[]; stdin: string }> = [];
    const client = new SourceControlBrokerClient(async (command, args, stdin) => {
      calls.push({ command, args, stdin });
      return JSON.stringify({
        provider: "github",
        accountLogin: "oll4com",
        secretRef: "source_control_github_12345678",
        verificationCode: "VERIFIED"
      });
    });
    const writeOnlyValue = "test_value_123456789012345678901234567890";

    await client.replace("github", writeOnlyValue);

    expect(calls[0]?.command).toBe("/usr/bin/sudo");
    expect(calls[0]?.args[1]).toBe("/opt/spaceapp/bin/space-source-control-secret-broker");
    expect(calls[0]?.args.join(" ")).not.toContain(writeOnlyValue);
    expect(calls[0]?.stdin).toBe(`${writeOnlyValue}\n`);
  });

  it("keeps the last verified reference when replacement verification fails", async () => {
    const store = new InMemorySpaceStore();
    store.upsertSourceControlConnection({
      provider: "github",
      accountLogin: "old-account",
      connectionStatus: "CONNECTED",
      secretRef: "source_control_github_old_12345678",
      lastVerifiedAt: "2026-07-23T09:20:00.000+03:00",
      lastVerificationCode: "VERIFIED"
    });
    const broker: SourceControlBroker = {
      replace: vi.fn(async () => {
        throw new SourceControlPublishingError("INVALID_TOKEN", "The provider rejected this credential.", 422);
      }),
      verify: vi.fn(),
      remove: vi.fn(),
      importExisting: vi.fn()
    };
    const manager = new SourceControlPublishingManager({ store, broker });

    await expect(manager.replace("github", "test_value_123456789012345678901234567890"))
      .rejects.toMatchObject({ code: "INVALID_TOKEN" });

    expect(store.getSourceControlConnection("github")).toMatchObject({
      accountLogin: "old-account",
      secretRef: "source_control_github_old_12345678",
      status: "CONNECTED"
    });
  });

  it("requires ADMIN and never returns or audits the submitted credential", async () => {
    const store = new InMemorySpaceStore();
    const broker: SourceControlBroker = {
      replace: vi.fn(async (provider) => ({
        provider,
        accountLogin: "oll4com",
        secretRef: `source_control_${provider}_12345678`,
        verificationCode: "VERIFIED"
      })),
      verify: vi.fn(async (provider, secretRef) => ({
        provider,
        accountLogin: "oll4com",
        secretRef,
        verificationCode: "VERIFIED"
      })),
      remove: vi.fn(async () => undefined),
      importExisting: vi.fn()
    };
    const manager = new SourceControlPublishingManager({ store, broker });
    const app = await createApp({
      store,
      sourceControlPublishingManager: manager,
      config: getApiConfig({}),
      auth: { sessionSecret, devLogin: false, secureCookies: false }
    });
    apps.push(app);
    const operator = authHeaders("OPERATOR");
    const admin = authHeaders("ADMIN");
    const writeOnlyValue = "test_value_123456789012345678901234567890";

    const forbidden = await app.inject({
      method: "PUT",
      url: "/api/admin/source-control/connections/github",
      headers: operator,
      payload: { token: writeOnlyValue }
    });
    expect(forbidden.statusCode).toBe(403);

    const connected = await app.inject({
      method: "PUT",
      url: "/api/admin/source-control/connections/github",
      headers: admin,
      payload: { token: writeOnlyValue }
    });
    expect(connected.statusCode).toBe(200);
    expect(connected.json()).toMatchObject({
      provider: "github",
      repositoryName: "spaceapp",
      accountLogin: "oll4com",
      status: "CONNECTED",
      secretConfigured: true
    });
    expect(JSON.stringify(connected.json())).not.toContain(writeOnlyValue);
    expect(JSON.stringify(connected.json())).not.toMatch(/secretRef|token/);
    expect(JSON.stringify(store.snapshot().auditEvents)).not.toContain(writeOnlyValue);
    expect(JSON.stringify(store.snapshot().auditEvents)).not.toMatch(/secretRef|token/);
  });
});
