import { describe, expect, it } from "vitest";
import { buildCodexAppServerTurnWorkflowId, buildDummyTurnWorkflowId, type DummyTurnInput, type TurnStartResult } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { DisabledTurnStarter, type TurnStarter } from "../src/turns.js";

const csrfHeaderName = "x-space-csrf-token";

async function authedApp(turnStarter: TurnStarter = new DisabledTurnStarter(), codexTurnStarter?: TurnStarter) {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Turns", initialPaneCount: 1 }, "trace:seed");
  const pane = store.listPanes(room.id)[0]!;
  const app = await createApp({
    store,
    turnStarter,
    codexTurnStarter,
    auth: {
      sessionSecret: "test-secret-with-enough-length",
      devLogin: true,
      secureCookies: false
    }
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "space@space.local", password: "space-dev" }
  });
  const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
  const csrf = await app.inject({
    method: "GET",
    url: "/api/auth/csrf",
    headers: { cookie }
  });
  return { app, cookie, csrfToken: csrf.json().csrfToken as string, room, pane, store };
}

describe("Space turn API", () => {
  it("fails closed when dummy Temporal turns are not explicitly enabled", async () => {
    const { app, cookie, csrfToken, room, pane } = await authedApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/turns",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { roomId: room.id, paneId: pane.id, prompt: "hello" }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("TURN_STARTER_DISABLED");
  });

  it("starts a queued dummy turn through an injected starter", async () => {
    const turnStarter: TurnStarter = {
      plan(input: DummyTurnInput): TurnStartResult {
        return {
          workflowId: buildDummyTurnWorkflowId(input),
          runId: null,
          roomId: input.roomId,
          paneId: input.paneId,
          traceId: input.traceId,
          status: "QUEUED",
          runtime: "DUMMY_TEMPORAL"
        };
      },
      async start(input: DummyTurnInput): Promise<TurnStartResult> {
        return {
          workflowId: buildDummyTurnWorkflowId(input),
          runId: "run:test-1",
          roomId: input.roomId,
          paneId: input.paneId,
          traceId: input.traceId,
          status: "QUEUED"
        };
      }
    };
    const { app, cookie, csrfToken, room, pane, store } = await authedApp(turnStarter);

    const response = await app.inject({
      method: "POST",
      url: "/api/turns",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { roomId: room.id, paneId: pane.id, prompt: "hello" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      roomId: room.id,
      paneId: pane.id,
      runId: "run:test-1",
      status: "QUEUED"
    });
    expect(response.json().workflowId).toContain("workflow:dummy:");
    expect(response.json().traceId).toMatch(/^req:/);
    expect(response.json().turnId).toMatch(/^turn:/);

    const turns = await app.inject({
      method: "GET",
      url: `/api/turns?roomId=${encodeURIComponent(room.id)}`,
      headers: { cookie }
    });

    expect(turns.statusCode).toBe(200);
    expect(turns.json().data).toHaveLength(1);
    expect(turns.json().data[0]).toMatchObject({
      id: response.json().turnId,
      roomId: room.id,
      paneId: pane.id,
      workflowId: response.json().workflowId,
      status: "QUEUED"
    });
    expect(store.listEvents(room.id).at(-1)).toMatchObject({
      turnId: response.json().turnId,
      workflowId: response.json().workflowId,
      type: "TURN_STARTED",
      payload: expect.objectContaining({ runtime: "DUMMY_TEMPORAL" })
    });
  });

  it("routes Codex App Server turns through a separate fail-closed starter", async () => {
    const turnStarter: TurnStarter = {
      plan(): TurnStartResult {
        throw new Error("dummy starter must not run for codex turns");
      },
      async start(): Promise<TurnStartResult> {
        throw new Error("dummy starter must not run for codex turns");
      }
    };
    const { app, cookie, csrfToken, room, pane, store } = await authedApp(turnStarter);

    const response = await app.inject({
      method: "POST",
      url: "/api/turns",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { roomId: room.id, paneId: pane.id, prompt: "hello", runtime: "CODEX_APP_SERVER" }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("TURN_STARTER_DISABLED");
    expect(store.listTurns(room.id)).toEqual([]);
  });

  it("queues Codex App Server turns only through an explicitly injected starter", async () => {
    let storeRef: InMemorySpaceStore | null = null;
    let queuedTurnsObservedAtStart = -1;
    let plannedInput: DummyTurnInput | null = null;
    let startedInput: DummyTurnInput | null = null;
    const codexTurnStarter: TurnStarter = {
      plan(input: DummyTurnInput): TurnStartResult {
        plannedInput = input;
        return {
          workflowId: buildCodexAppServerTurnWorkflowId(input),
          runId: null,
          roomId: input.roomId,
          paneId: input.paneId,
          traceId: input.traceId,
          status: "QUEUED",
          runtime: "CODEX_APP_SERVER"
        };
      },
      async start(input: DummyTurnInput): Promise<TurnStartResult> {
        startedInput = input;
        queuedTurnsObservedAtStart = storeRef?.listTurns(input.roomId).length ?? -1;
        return {
          workflowId: buildCodexAppServerTurnWorkflowId(input),
          runId: "run:codex-1",
          roomId: input.roomId,
          paneId: input.paneId,
          traceId: input.traceId,
          status: "QUEUED",
          runtime: "CODEX_APP_SERVER"
        };
      }
    };
    const { app, cookie, csrfToken, room, pane, store } = await authedApp(new DisabledTurnStarter(), codexTurnStarter);
    storeRef = store;
    store.updatePane(
      pane.id,
      { providerId: "codex-lb", modelId: "gpt-5.5", reasoningEffort: "high" },
      "trace:routing"
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/turns",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { roomId: room.id, paneId: pane.id, prompt: "hello", runtime: "CODEX_APP_SERVER" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      roomId: room.id,
      paneId: pane.id,
      runId: "run:codex-1",
      status: "QUEUED",
      runtime: "CODEX_APP_SERVER"
    });
    expect(response.json().workflowId).toContain("workflow:codex-app-server:");
    expect(queuedTurnsObservedAtStart).toBe(1);
    expect(plannedInput).toMatchObject({
      providerId: "codex-lb",
      modelId: "gpt-5.5",
      reasoningEffort: "high"
    });
    expect(startedInput).toMatchObject({
      providerId: "codex-lb",
      modelId: "gpt-5.5",
      reasoningEffort: "high"
    });
    expect(store.listTurns(room.id)[0]).toMatchObject({
      id: response.json().turnId,
      workflowId: response.json().workflowId,
      status: "QUEUED",
      providerId: "codex-lb",
      modelId: "gpt-5.5"
    });
    expect(store.listEvents(room.id).at(-1)).toMatchObject({
      turnId: response.json().turnId,
      workflowId: response.json().workflowId,
      type: "TURN_STARTED",
      payload: expect.objectContaining({ runtime: "CODEX_APP_SERVER" })
    });
  });
});
