import { describe, expect, it } from "vitest";
import {
  authUserSchema,
  cliTerminalClientEventInputSchema,
  cliTerminalClientEventResponseSchema,
  createPaneCliTerminalControlLeaseInputSchema,
  paneCliClientModeSchema,
  paneCliTerminalControlLeaseSchema,
  paneCliWebSocketClientMessageSchema,
  paneCliWebSocketServerMessageSchema,
  paneCliWebSocketTokenSchema,
  updatePaneCliTerminalControlLeaseInputSchema
} from "../src/index.js";

const leaseId = "cli_terminal_lease:controller-one";
const browserClientId = "11111111-1111-4111-8111-111111111111";
const tabLineageId = "22222222-2222-4222-8222-222222222222";
const pageClientId = "33333333-3333-4333-8333-333333333333";
const interactionId = "44444444-4444-4444-8444-444444444444";

describe("CLI terminal control protocol", () => {
  it("accepts only bounded structured client lifecycle telemetry", () => {
    const event = {
      event: "SOCKET_DISCONNECTED",
      outcome: "RETRY",
      reason: "SOCKET_CLOSE",
      paneId: "pane:terminal-control",
      sessionId: "cli_session:terminal-control",
      runtimeId: "cli:codex",
      controlState: "CONTROLLER",
      protocolVersion: 2,
      clientMode: "INTERACTIVE",
      socketGeneration: 3,
      attempt: 1,
      delayMs: 250,
      closeCode: 1006,
      wasClean: false,
      clientAt: "2026-07-23T08:00:00.000Z"
    };

    expect(cliTerminalClientEventInputSchema.parse(event)).toEqual(event);
    expect(cliTerminalClientEventResponseSchema.parse({ accepted: true })).toEqual({ accepted: true });
    expect(() => cliTerminalClientEventInputSchema.parse({
      ...event,
      event: "ARBITRARY_CLIENT_LOG"
    })).toThrow();
    expect(() => cliTerminalClientEventInputSchema.parse({
      ...event,
      detail: "could contain terminal output or credentials"
    })).toThrow();
    expect(() => cliTerminalClientEventInputSchema.parse({
      ...event,
      delayMs: 120_000
    })).toThrow();

  });

  it("validates page-scoped controller identity and bounded durable leases", () => {
    expect(paneCliClientModeSchema.parse("INTERACTIVE")).toBe("INTERACTIVE");
    expect(paneCliClientModeSchema.parse("OBSERVER")).toBe("OBSERVER");

    const lease = {
      leaseId,
      sessionId: "cli_session:terminal-control",
      paneId: "pane:terminal-control",
      roomId: "room:terminal-control",
      userId: "user:operator",
      browserClientId,
      tabLineageId,
      pageClientId,
      status: "ACTIVE",
      acquiredAt: "2026-07-23T08:00:00.000Z",
      heartbeatAt: "2026-07-23T08:00:00.000Z",
      expiresAt: "2026-07-23T08:00:30.000Z",
      releasedAt: null
    };

    expect(paneCliTerminalControlLeaseSchema.parse(lease)).toEqual(lease);
    expect(createPaneCliTerminalControlLeaseInputSchema.parse({
      sessionId: lease.sessionId,
      paneId: lease.paneId,
      roomId: lease.roomId,
      userId: lease.userId,
      browserClientId,
      tabLineageId,
      pageClientId,
      expectedActiveLeaseId: null
    })).toMatchObject({ ttlSeconds: 30 });
    expect(updatePaneCliTerminalControlLeaseInputSchema.parse({
      expectedStatus: "ACTIVE",
      ttlSeconds: 30
    })).toEqual({ expectedStatus: "ACTIVE", ttlSeconds: 30 });

    expect(() => createPaneCliTerminalControlLeaseInputSchema.parse({
      sessionId: lease.sessionId,
      paneId: lease.paneId,
      roomId: lease.roomId,
      userId: lease.userId,
      browserClientId,
      tabLineageId,
      pageClientId: "not-a-page-uuid",
      expectedActiveLeaseId: null
    })).toThrow();
    expect(() => createPaneCliTerminalControlLeaseInputSchema.parse({
      ...lease,
      expectedActiveLeaseId: null,
      ttlSeconds: 4
    })).toThrow();
    expect(() => updatePaneCliTerminalControlLeaseInputSchema.parse({})).toThrow();
  });

  it("requires lease fencing on protocol-v2 terminal mutations while retaining v1 parsing", () => {
    const mutations = [
      { type: "input", data: "pwd\n", display: "visible", leaseId },
      { type: "resize", cols: 120, rows: 32, leaseId },
      { type: "interrupt", leaseId }
    ];

    for (const mutation of mutations) {
      expect(paneCliWebSocketClientMessageSchema.parse(mutation)).toEqual(mutation);
    }

    expect(paneCliWebSocketClientMessageSchema.parse({
      type: "resize",
      cols: 100,
      rows: 30
    })).toEqual({ type: "resize", cols: 100, rows: 30 });
  });

  it("accepts explicit observer upgrade, acquire, takeover, heartbeat and release messages", () => {
    const messages = [
      { type: "control_upgrade" },
      { type: "control_request" },
      { type: "control_takeover", expectedLeaseId: leaseId, interactionId },
      { type: "control_heartbeat", leaseId },
      { type: "control_release", leaseId }
    ];

    for (const message of messages) {
      expect(paneCliWebSocketClientMessageSchema.parse(message)).toEqual(message);
    }
    expect(() => paneCliWebSocketClientMessageSchema.parse({
      type: "control_takeover",
      expectedLeaseId: leaseId
    })).toThrow();
  });

  it("advertises observer/controller state and lease lifecycle frames", () => {
    const ready = {
      type: "ready",
      paneId: "pane:terminal-control",
      sessionId: "cli_session:terminal-control",
      runtimeId: "cli:codex",
      protocolVersion: 2,
      clientMode: "INTERACTIVE",
      controlState: "CONTROLLER",
      leaseId,
      heartbeatIntervalMs: 10_000
    };
    expect(paneCliWebSocketServerMessageSchema.parse(ready)).toEqual(ready);

    const lifecycle = [
      {
        type: "control_upgraded"
      },
      {
        type: "control_state",
        controlState: "HELD_BY_OTHER",
        leaseId,
        holderPageClientId: pageClientId,
        expiresAt: "2026-07-23T08:00:30.000Z"
      },
      {
        type: "control_granted",
        leaseId,
        expiresAt: "2026-07-23T08:00:30.000Z"
      },
      {
        type: "control_denied",
        code: "CLI_CONTROL_REQUIRED",
        message: "Take control before sending terminal input."
      },
      {
        type: "control_revoked",
        leaseId,
        reason: "TAKEN_OVER"
      }
    ];

    for (const message of lifecycle) {
      expect(paneCliWebSocketServerMessageSchema.parse(message)).toEqual(message);
    }
  });

  it("allows only the signed read-only proof scope", () => {
    const token = {
      paneId: "pane:proof",
      sessionId: "cli_session:proof",
      token: "a".repeat(24),
      expiresAt: "2026-07-23T08:00:30.000Z",
      proofScope: "READ_ONLY"
    };

    expect(paneCliWebSocketTokenSchema.parse(token)).toEqual(token);
    expect(() => paneCliWebSocketTokenSchema.parse({
      ...token,
      proofScope: "READ_WRITE"
    })).toThrow();
  });

  it("allows only the fixed app-diagnostics automation scope", () => {
    const user = {
      id: "user:diagnostics-automation",
      email: "diagnostics-automation@space.test",
      role: "ADMIN" as const,
      proofScope: "READ_ONLY" as const,
      automationScope: "APP_DIAGNOSTICS" as const
    };

    expect(authUserSchema.parse(user)).toEqual(user);
    expect(() => authUserSchema.parse({
      ...user,
      automationScope: "WORKSPACE_ADMIN"
    })).toThrow();
  });
});
