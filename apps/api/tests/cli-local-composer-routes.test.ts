import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryControlRepository } from "@space/db";
import { InMemorySpaceStore, SpaceConflictError, SpaceNotFoundError } from "@space/runtime";
import type { PaneCliSession } from "@space/contracts";
import { registerCliLocalComposerRoutes } from "../src/cli-local-composer-routes.js";
import { parseCliHttpControlAuthority, CliTerminalControlRequiredError } from "../src/cli-http-control.js";
import { configureQueueOperatorGrants, takePaneQueueGrant } from "../src/queue-operator-grants.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

function fixture(sessionOverrides: Partial<PaneCliSession> = {}, userOverrides: Record<string, unknown> = {}) {
  const user = { id: "user:alice", email: "alice@example.test", role: "ADMIN" as const, ...userOverrides };
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Composer", initialPaneCount: 0 }, "trace:composer", user.id);
  const pane = store.createPane({ roomId: room.id, title: "Claude", mode: "TERMINAL", terminalRuntimeId: "cli:claude", cwd: "/etc" });
  const session = store.createPaneCliSession({ sessionId: "cli_session:composer", paneId: pane.id, roomId: room.id,
    runtimeId: "cli:claude", providerId: "anthropic", agentId: "claude", modelId: null, reasoningEffort: "high", cwd: "/etc",
    status: "RUNNING", isActive: true, ...sessionOverrides });
  store.updatePaneCliTerminalGeometry(session.sessionId, { generationId: "process:one", cols: 80, rows: 24 });
  const lease = store.createPaneCliTerminalControlLease({ sessionId: session.sessionId, paneId: pane.id, roomId: room.id,
    userId: user.id, browserClientId: randomUUID(), tabLineageId: randomUUID(), pageClientId: randomUUID(), expectedActiveLeaseId: null });
  const headers = { "x-space-cli-control-lease-id": lease.leaseId, "x-space-cli-browser-client-id": lease.browserClientId,
    "x-space-cli-tab-lineage-id": lease.tabLineageId, "x-space-cli-page-client-id": lease.pageClientId };
  const sendInput = vi.fn(async () => ({ turnMarker: null, markerAtMs: 1 }));
  const wait = vi.fn(async (_ms: number) => undefined);
  const repository = new InMemoryControlRepository();
  const app = Fastify();
  apps.push(app);
  app.addHook("preHandler", async request => { request.user = user; request.requestIdForSpace = "trace:composer"; });
  app.setErrorHandler((error, _request, reply) => {
    reply.code(error instanceof SpaceNotFoundError ? 404 : error instanceof SpaceConflictError ? 409 : 422).send({ error: error.message });
  });
  const assertCliHttpMutationControl = vi.fn(async (request, active: PaneCliSession) => {
    const authority = parseCliHttpControlAuthority(request);
    const current = await store.getActivePaneCliTerminalControlLease(active.sessionId);
    if (!authority || !current || authority.leaseId !== current.leaseId || authority.browserClientId !== current.browserClientId ||
        authority.tabLineageId !== current.tabLineageId || authority.pageClientId !== current.pageClientId || current.userId !== request.user?.id)
      throw new CliTerminalControlRequiredError();
  });
  const observeOnly = vi.fn(async () => false);
  const screen = { text: "❯ " };
  registerCliLocalComposerRoutes(app, { store, repository, routeOptions: { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    cliTerminalManager: { sendInput, runSerializedTerminalMutation: async (_session, work) => work(), observeRoomScreen: async () => ({ text: screen.text, revision: 1 }) },
    assertRoomAccess: async roomId => store.getRoom(roomId), observeOnly,
    assertPaneCliRuntimeEnabled: async () => undefined, assertCliHttpMutationControl, wait });
  const url = `/api/panes/${pane.id}/cli/local-composer/submissions`;
  const input = () => ({ submissionId: randomUUID(), expectedSessionId: session.sessionId, text: "hello\nworld" });
  return { app, store, repository, session, pane, lease, headers, sendInput, wait, observeOnly, assertCliHttpMutationControl, url, input, screen };
}

describe("local composer route authority", () => {
  it("sends to the owned running session and reads receipts without mutation authority", async () => {
    const f = fixture();
    const draft = f.input();
    const response = await f.app.inject({ method: "POST", url: f.url, headers: f.headers, payload: draft });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().status).toBe("SENT");
    expect(f.sendInput).toHaveBeenCalledTimes(2);
    expect(f.assertCliHttpMutationControl).toHaveBeenCalledTimes(2);
    const read = await f.app.inject({ url: `${f.url}/${draft.submissionId}` });
    expect(read.json()).toEqual(response.json());
    expect(read.headers["cache-control"]).toBe("no-store");
    const unknown = await f.app.inject({ url: `${f.url}/${randomUUID()}` });
    expect(unknown.json()).toMatchObject({ status: "NOT_FOUND", sessionId: null });
  });

  it("holds the pane's promote grant for a promote the operator sends from their own draft, never an agent's session (2026-10-21)", async () => {
    configureQueueOperatorGrants("composer-test-secret-with-length");
    const f = fixture();
    const sent = await f.app.inject({ method: "POST", url: f.url, headers: f.headers, payload: { ...f.input(), text: "κάνε promote" } });
    expect(sent.json().status).toBe("SENT");
    expect(takePaneQueueGrant(f.pane.id, "promote")).toEqual(expect.any(String));
    const proof = fixture({}, { brokerScope: "UI_PROOF" });
    await proof.app.inject({ method: "POST", url: proof.url, headers: proof.headers, payload: { ...proof.input(), text: "κάνε promote" } });
    expect(takePaneQueueGrant(proof.pane.id, "promote")).toBeNull();
  });

  it("requires a live lease and all matching browser identities even when no controller exists", async () => {
    const f = fixture();
    for (const headers of [{}, { ...f.headers, "x-space-cli-page-client-id": randomUUID() }]) {
      const response = await f.app.inject({ method: "POST", url: f.url, headers, payload: f.input() });
      expect(response.json().status).toBe("REJECTED");
    }
    f.store.updatePaneCliTerminalControlLease(f.lease.leaseId, { expectedStatus: "ACTIVE", status: "RELEASED" });
    const noLease = await f.app.inject({ method: "POST", url: f.url, headers: f.headers, payload: f.input() });
    expect(noLease.json().status).toBe("REJECTED");
    expect(f.sendInput).not.toHaveBeenCalled();
  });

  it.each([
    { purpose: "LOGIN" as const }, { runtimeId: "cli:root" }, { status: "EXITED" as const }, { isActive: false }
  ])("rejects unsupported or inactive sessions before input: %j", async overrides => {
    const f = fixture(overrides);
    const response = await f.app.inject({ method: "POST", url: f.url, headers: f.headers, payload: f.input() });
    expect(response.json().status).toBe("REJECTED");
    expect(f.sendInput).not.toHaveBeenCalled();
  });

  it("rejects a stale expected session before delivery", async () => {
    const f = fixture();
    const response = await f.app.inject({ method: "POST", url: f.url, headers: f.headers,
      payload: { ...f.input(), expectedSessionId: "cli_session:old" } });
    expect(response.json().status).toBe("REJECTED");
    expect(f.sendInput).not.toHaveBeenCalled();
  });

  it("withholds remaining images, text and Enter if control changes after the first native image", async () => {
    const f = fixture();
    f.wait.mockImplementation(async () => {
      f.store.updatePaneCliTerminalControlLease(f.lease.leaseId, { expectedStatus: "ACTIVE", status: "REVOKED" });
    });
    const response = await f.app.inject({ method: "POST", url: f.url, headers: f.headers,
      payload: { ...f.input(), imagePaths: ["/tmp/one.png", "/tmp/two.png"] } });
    expect(response.json().status).toBe("UNCERTAIN");
    expect(f.sendInput).toHaveBeenCalledTimes(1);
  });

  it.each(["session", "generation", "lease", "owner"])("withholds Enter if %s changes after content was accepted", async change => {
    const f = fixture();
    f.wait.mockImplementation(async () => {
      if (change === "session") f.store.updatePaneCliSession(f.session.sessionId, { isActive: false });
      if (change === "generation") f.store.updatePaneCliTerminalGeometry(f.session.sessionId, { generationId: "process:two", cols: 80, rows: 24 });
      if (change === "lease") f.store.updatePaneCliTerminalControlLease(f.lease.leaseId, { expectedStatus: "ACTIVE", status: "REVOKED" });
      if (change === "owner") f.observeOnly.mockResolvedValue(true);
    });
    const response = await f.app.inject({ method: "POST", url: f.url, headers: f.headers, payload: f.input() });
    expect(response.json().status).toBe("UNCERTAIN");
    expect(f.sendInput).toHaveBeenCalledTimes(1);
  });

  it("refuses a user the terminal lets only watch, for both submission and receipt lookup", async () => {
    const f = fixture();
    f.observeOnly.mockResolvedValue(true);
    const draft = f.input();
    expect((await f.app.inject({ method: "POST", url: f.url, headers: f.headers, payload: draft })).statusCode).toBe(404);
    expect((await f.app.inject({ url: `${f.url}/${draft.submissionId}` })).statusCode).toBe(404);
    expect(f.sendInput).not.toHaveBeenCalled();
  });
});

describe("pane keys from SpaceApp Android (plan clipboard:1cZ-YxU8zS2O N1)", () => {
  const press = (f: ReturnType<typeof fixture>, keys: string[], expectedSessionId = f.session.sessionId) =>
    f.app.inject({ method: "POST", url: `/api/panes/${f.pane.id}/cli/keys`, payload: { expectedSessionId, keys } });

  it("presses named keys one write at a time without a lease, and audits their names", async () => {
    const f = fixture();
    f.store.updatePaneCliTerminalControlLease(f.lease.leaseId, { expectedStatus: "ACTIVE", status: "RELEASED" });
    const audit = vi.spyOn(f.store, "recordAuditEvent");
    const response = await press(f, ["DOWN", "ENTER", "ESCAPE", "CTRL_C", "3"]);
    expect(response.statusCode, response.body).toBe(200);
    expect(f.sendInput.mock.calls.map(call => (call as unknown[])[1])).toEqual(["\u001b[B", "\r", "\u001b", "\u0003", "3"]);
    expect(f.wait).toHaveBeenCalledTimes(4);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "pane.cli.keys", metadata: expect.objectContaining({ keys: ["DOWN", "ENTER", "ESCAPE", "CTRL_C", "3"] }) }));
  });

  it("refuses an answer key on a protected or destructive prompt, never Esc or Ctrl+C", async () => {
    const f = fixture();
    f.screen.text = "Bash command\n  space-queue promote\n❯ 1. Yes\n  2. No";
    for (const keys of [["ENTER"], ["1"], ["y"]]) expect((await press(f, keys)).statusCode).toBe(409);
    f.screen.text = "Bash command\n  rm -rf build\n❯ 1. Yes";
    expect((await press(f, ["DOWN", "ENTER"])).json().error).toMatch(/destructive.*recursive delete/);
    expect(f.sendInput).not.toHaveBeenCalled();
    expect((await press(f, ["ESCAPE", "CTRL_C", "n"])).statusCode).toBe(200);
  });

  it.each([
    [{ brokerScope: "UI_PROOF" }, ["ESCAPE"], 403], [{ proofScope: "READ_ONLY" }, ["ESCAPE"], 403], [{ mobile: { device: "d", person: true } }, ["ESCAPE"], 403],
    [{}, ["x"], 422], [{}, ["\u0003"], 422], [{}, [], 422], [{}, Array(9).fill("UP"), 422]
  ])("refuses %j %j", async (user, keys, status) => {
    const f = fixture({}, user);
    expect((await press(f, keys)).statusCode).toBe(status);
    expect(f.sendInput).not.toHaveBeenCalled();
  });

  it("refuses another session, an exited CLI and a pane the caller does not own", async () => {
    const stale = fixture();
    expect((await press(stale, ["ESCAPE"], "cli_session:old")).statusCode).toBe(409);
    expect((await press(fixture({ status: "EXITED" }), ["ESCAPE"])).statusCode).toBe(409);
    const other = fixture();
    other.observeOnly.mockResolvedValue(true);
    expect((await press(other, ["ESCAPE"])).statusCode).toBe(404);
  });
});
