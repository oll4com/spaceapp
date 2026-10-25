import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type {
  SetupConnection,
  SetupConnectionCheckStage
} from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { cliRuntimeDescriptors } from "../src/cli-runtime-descriptors.js";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import {
  SetupConnectionCheckRunManager
} from "../src/setup-connection-check-runs.js";
import {
  summarizeSetupConnections,
  type SetupConnectionsService
} from "../src/setup-connections.js";

const sessionSecret = "setup-check-runs-test-secret";
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function authHeaders(role: "OPERATOR" | "ADMIN", includeCsrf = true) {
  const session = signSession(
    { id: `user:${role.toLowerCase()}`, email: `${role.toLowerCase()}@space.local`, role },
    sessionSecret
  );
  return {
    cookie: `space_session=${session}`,
    ...(includeCsrf ? { "x-space-csrf-token": createCsrfToken(session, sessionSecret)! } : {})
  };
}

function claimOwner(store: InMemorySpaceStore): void {
  const tokenHash = "a".repeat(64);
  store.initializeOwnerSetup({
    tokenHash,
    expiresAt: "2099-07-29T10:00:00.000Z"
  });
  store.claimOwnerSetup({
    tokenHash,
    email: "owner@example.com",
    passwordHash: "test-password-hash",
    now: "2026-07-29T10:00:00.000Z"
  });
}

function setupConnection(
  id: string,
  liveVerificationState: SetupConnection["liveVerificationState"] = "NOT_CHECKED"
): SetupConnection {
  const descriptor = cliRuntimeDescriptors.find((candidate) => candidate.id === id)!;
  const needsSetup = id === "cli:autohand";
  return {
    id,
    label: descriptor.agentName,
    providerName: descriptor.providerName,
    category: "AI coding CLI",
    state: needsSetup ? "NEEDS_SETUP" : "CONNECTED",
    functionalState: needsSetup ? "NEEDS_SETUP" : "FUNCTIONAL",
    liveVerificationState: needsSetup ? "NOT_CHECKED" : liveVerificationState,
    reasonCode: needsSetup
      ? "CREDENTIAL_REQUIRED"
      : liveVerificationState === "QUOTA_LIMITED"
        ? "PROVIDER_QUOTA_LIMITED"
        : liveVerificationState === "TIMED_OUT"
          ? "PROVIDER_CHECK_TIMED_OUT"
          : liveVerificationState === "PROVIDER_FAILED"
            ? "PROVIDER_CHECK_FAILED"
            : null,
    verifiedAt: liveVerificationState === "VERIFIED" ? "2026-07-29T10:00:00.000Z" : null,
    staleAt: liveVerificationState === "VERIFIED" ? "2026-08-28T10:00:00.000Z" : null,
    actions: needsSetup ? ["OPEN_LOGIN_PANE", "VERIFY"] : ["VERIFY"]
  };
}

function terminalStage(connection: SetupConnection): SetupConnectionCheckStage {
  if (connection.functionalState === "NEEDS_SETUP") return "Needs setup";
  if (connection.functionalState === "UNAVAILABLE") return "CLI unavailable";
  if (connection.liveVerificationState === "VERIFIED") return "Verified";
  if (connection.liveVerificationState === "QUOTA_LIMITED") return "Quota limited";
  if (connection.liveVerificationState === "TIMED_OUT") return "Timed out";
  if (connection.liveVerificationState === "CREDENTIAL_CHANGED") return "Credential changed";
  return "Provider failed";
}

function fakeSetupService(blockedConnectionId?: string) {
  const connections = new Map(
    cliRuntimeDescriptors.map((descriptor) => [descriptor.id, setupConnection(descriptor.id)])
  );
  const verifyCalls = new Map<string, number>();
  let verifyAllCalls = 0;
  let overviewCalls = 0;
  let releaseBlocked = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    releaseBlocked = resolve;
  });
  const verifiedIds = new Set(["cli:codex", "cli:claude", "cli:gemini"]);
  const service: SetupConnectionsService = {
    overview: async () => {
      overviewCalls += 1;
      return cliRuntimeDescriptors.map((descriptor) => connections.get(descriptor.id)!);
    },
    verify: async (connectionId, emitStage = () => undefined) => {
      verifyCalls.set(connectionId, (verifyCalls.get(connectionId) ?? 0) + 1);
      await emitStage("Detecting CLI");
      if (connectionId === blockedConnectionId) await blocked;
      await emitStage("Checking saved credential");
      if (connectionId !== "cli:autohand") {
        await emitStage("Sending live provider challenge");
        await emitStage("Confirming credential identity");
      }
      await emitStage("Saving result");
      const result = setupConnection(
        connectionId,
        verifiedIds.has(connectionId)
          ? "VERIFIED"
          : connectionId === "cli:kimi"
            ? "QUOTA_LIMITED"
            : connectionId === "cli:cursor"
              ? "TIMED_OUT"
              : "PROVIDER_FAILED"
      );
      connections.set(connectionId, result);
      await emitStage(terminalStage(result));
      return result;
    },
    verifyAll: async (
      emitStage = () => undefined,
      onComplete?: (connectionId: string, connection: SetupConnection | null) => void | Promise<void>
    ) => {
      verifyAllCalls += 1;
      return Promise.all(cliRuntimeDescriptors.map(async (descriptor) => {
        const result = await service.verify(
          descriptor.id,
          (stage) => emitStage(descriptor.id, stage)
        );
        await onComplete?.(descriptor.id, result);
        return result;
      }));
    },
    recordVerifiedEvidence: async (connectionId) => connections.get(connectionId)!
  };
  return {
    service,
    verifyCalls,
    releaseBlocked,
    verifyAllCalls: () => verifyAllCalls,
    overviewCalls: () => overviewCalls
  };
}

async function waitForCompletedCount(
  store: InMemorySpaceStore,
  runId: string,
  expected: number
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (store.getSetupConnectionCheckRun(runId)?.completedCount === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Setup check run did not reach ${expected} completed checks.`);
}

describe("SetupConnectionCheckRunManager", () => {
  it("runs all CLIs in parallel, exposes partial replay, and saves the real summary", async () => {
    const store = new InMemorySpaceStore();
    claimOwner(store);
    const fake = fakeSetupService("cli:autohand");
    const manager = new SetupConnectionCheckRunManager({
      store,
      setupConnections: fake.service,
      now: () => new Date("2026-07-29T10:00:00.000Z")
    });

    const admission = await manager.startAll("user:owner");
    await waitForCompletedCount(store, admission.run.id, 15);
    const partial = await manager.replay(admission.run.id, 0);

    expect(partial.run).toMatchObject({ status: "RUNNING", completedCount: 15, totalCount: 16 });
    expect(partial.events.filter((event) => event.state === "COMPLETED")).toHaveLength(15);
    fake.releaseBlocked();
    await manager.whenSettled(admission.run.id);

    const replay = await manager.replay(admission.run.id, 0);
    await manager.replay(admission.run.id, replay.events.at(-1)?.sequence ?? 0);
    expect(replay.run).toMatchObject({ status: "COMPLETED", completedCount: 16, totalCount: 16 });
    expect(replay.overview.summary).toEqual({
      total: 16,
      functional: 15,
      liveVerified: 3,
      needsSetup: 1
    });
    expect(summarizeSetupConnections(replay.overview.connections)).toEqual(replay.overview.summary);
    expect(
      replay.events
        .filter((event) => event.connectionId === "cli:codex")
        .map((event) => event.stage)
    ).toEqual([
      "Detecting CLI",
      "Checking saved credential",
      "Sending live provider challenge",
      "Confirming credential identity",
      "Saving result",
      "Verified"
    ]);
    expect(fake.verifyAllCalls()).toBe(1);
    expect(fake.overviewCalls()).toBe(1);
  });

  it("reuses duplicate active admission and allows a completed CLI to be retried alone", async () => {
    const store = new InMemorySpaceStore();
    claimOwner(store);
    const fake = fakeSetupService();
    const manager = new SetupConnectionCheckRunManager({
      store,
      setupConnections: fake.service
    });

    const [first, duplicate] = await Promise.all([
      manager.startAll("user:owner"),
      manager.startAll("user:owner")
    ]);
    expect(first.run.id).toBe(duplicate.run.id);
    expect([first.reused, duplicate.reused].sort()).toEqual([false, true]);
    await manager.whenSettled(first.run.id);
    expect([...fake.verifyCalls.values()].reduce((sum, count) => sum + count, 0)).toBe(16);

    const retry = await manager.startSingle("cli:codex", "user:owner");
    expect(retry.run.id).not.toBe(first.run.id);
    expect(retry.run).toMatchObject({ scope: "SINGLE", connectionIds: ["cli:codex"] });
    await manager.whenSettled(retry.run.id);
    expect(fake.verifyCalls.get("cli:codex")).toBe(2);
    expect(fake.verifyCalls.get("cli:gemini")).toBe(1);
  });
});

describe("setup connection check run API", () => {
  it("enforces ADMIN and strict schemas, then replays and resumes redacted SSE progress", async () => {
    const store = new InMemorySpaceStore();
    claimOwner(store);
    const fake = fakeSetupService("cli:autohand");
    const manager = new SetupConnectionCheckRunManager({
      store,
      setupConnections: fake.service
    });
    const app = await createApp({
      store,
      setupConnections: fake.service,
      setupConnectionCheckRuns: manager,
      auth: { sessionSecret, devLogin: false, secureCookies: false },
      config: getApiConfig({
        SPACE_BROWSER_EVIDENCE_ENABLED: "false",
        SPACE_BROWSER_SESSIONS_ENABLED: "false"
      })
    });
    apps.push(app);

    const forbidden = await app.inject({
      method: "POST",
      url: "/api/setup/connections/cli:codex/check-runs",
      headers: authHeaders("OPERATOR"),
      payload: {}
    });
    expect(forbidden.statusCode).toBe(403);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/setup/connections/cli:codex/check-runs",
      headers: authHeaders("ADMIN"),
      payload: { nonce: "must-not-survive" }
    });
    expect(invalid.statusCode).toBe(422);

    const started = await app.inject({
      method: "POST",
      url: "/api/setup/connection-check-runs",
      headers: authHeaders("ADMIN"),
      payload: {}
    });
    expect(started.statusCode).toBe(202);
    const runId = started.json().id as string;

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/setup/connections/cli:autohand/check-runs",
      headers: authHeaders("ADMIN"),
      payload: {}
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().id).toBe(runId);

    fake.releaseBlocked();
    await manager.whenSettled(runId);
    const replay = await app.inject({
      method: "GET",
      url: `/api/setup/connection-check-runs/${encodeURIComponent(runId)}/replay?afterSequence=1`,
      headers: authHeaders("ADMIN")
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      run: { id: runId, status: "COMPLETED", completedCount: 16 },
      overview: {
        summary: { total: 16, functional: 15, liveVerified: 3, needsSetup: 1 }
      }
    });
    expect(replay.json().events.every((event: { sequence: number }) => event.sequence > 1)).toBe(true);
    expect(JSON.stringify(replay.json())).not.toMatch(
      /\b(nonce|fingerprint|stdout|stderr|access_token|refresh_token|provider_payload)\b/i
    );

    const lastSequence = replay.json().events.at(-1).sequence as number;
    const stream = await app.inject({
      method: "GET",
      url: `/api/setup/connection-check-runs/${encodeURIComponent(runId)}/stream`,
      headers: {
        ...authHeaders("ADMIN"),
        "last-event-id": String(lastSequence - 1)
      }
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    expect(stream.body).toContain(`id: ${lastSequence}`);
    expect(stream.body).not.toContain(`id: ${lastSequence - 1}\n`);
    expect(stream.body).not.toContain("must-not-survive");

    const replayForbidden = await app.inject({
      method: "GET",
      url: `/api/setup/connection-check-runs/${encodeURIComponent(runId)}/replay`,
      headers: authHeaders("OPERATOR")
    });
    expect(replayForbidden.statusCode).toBe(403);
  });

  it("keeps all-CLI admission at the existing two-per-15-minute rate limit", async () => {
    const store = new InMemorySpaceStore();
    claimOwner(store);
    const fake = fakeSetupService("cli:autohand");
    const manager = new SetupConnectionCheckRunManager({
      store,
      setupConnections: fake.service
    });
    const app = await createApp({
      store,
      setupConnections: fake.service,
      setupConnectionCheckRuns: manager,
      auth: { sessionSecret, devLogin: false, secureCookies: false },
      config: getApiConfig({
        SPACE_BROWSER_EVIDENCE_ENABLED: "false",
        SPACE_BROWSER_SESSIONS_ENABLED: "false"
      })
    });
    apps.push(app);

    const statuses = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/setup/connection-check-runs",
        headers: authHeaders("ADMIN"),
        payload: {}
      });
      statuses.push(response.statusCode);
    }
    expect(statuses).toEqual([202, 200, 429]);
    fake.releaseBlocked();
  });
});
