import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp, type CreateAppOptions } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { createCsrfToken, signSession } from "../src/auth.js";
const secret = "task-title-route-test-session-secret";
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function headers(role: "ADMIN" | "OPERATOR" = "ADMIN") {
  const session = signSession(
    { id: `user:${role}`, email: "test@space.local", role },
    secret,
  );
  return {
    cookie: `space_session=${session}`,
    "x-space-csrf-token": createCsrfToken(session, secret)!,
  };
}
async function fixture(
  options: Partial<CreateAppOptions> = {},
  runtimeId = "cli:qwen",
) {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Task titles", initialPaneCount: 0 });
  const pane = store.createPane({
    roomId: room.id,
    title: "[Image #1] Task",
    mode: "TERMINAL",
    terminalRuntimeId: runtimeId,
    cwd: "/title-test",
  });
  const session = store.createPaneCliSession({
    paneId: pane.id,
    roomId: room.id,
    runtimeId,
    providerId: "qwen",
    agentId: "qwen",
    modelId: null,
    reasoningEffort: "none",
    cwd: "/title-test",
  });
  store.appendPaneCliTranscriptChunk({
    paneId: pane.id,
    roomId: room.id,
    sessionId: session.sessionId,
    sequence: 1,
    stream: "stdin",
    content: "[Image #1] Repair workspace navigation\r",
  });
  const app = await createApp({
    store,
    config: getApiConfig({}),
    findCodexThreadId: async () => null,
    opencodeStateRoot: "/tmp/task-title-missing-controls",
    auth: { sessionSecret: secret, devLogin: false, secureCookies: false },
    ...options,
  });
  apps.push(app);
  return { app, store, pane, room, session };
}
describe("queued task title API", () => {
  it("returns pending metadata without echoing the raw prompt and projects the shared task history title", async () => {
    const f = await fixture();
    const response = await f.app.inject({
      method: "POST",
      url: `/api/panes/${f.pane.id}/title/generate`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      title: "New task",
      taskMetadata: {
        generationStatus: "pending",
        description: "",
        topics: [],
      },
    });
    expect(
      f.store.getCliTaskRevision(f.session.cliTaskRevisionId!)?.displayTitle,
    ).toBe("New task");
  });
  it("keeps manual titles while queuing a description and ignores client-supplied metadata", async () => {
    const f = await fixture();
    await f.app.inject({
      method: "POST",
      url: `/api/panes/${f.pane.id}/title/generate`,
      headers: headers(),
    });
    const metadata = f.store.getPane(f.pane.id).taskMetadata!;
    const response = await f.app.inject({
      method: "PATCH",
      url: `/api/panes/${f.pane.id}`,
      headers: headers(),
      payload: {
        title: "Pinned task",
        taskMetadata: { ...metadata, description: "Forged description" },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(f.store.getPane(f.pane.id).title).toBe("Pinned task");
    expect(f.store.getPane(f.pane.id).taskMetadata?.description).not.toBe(
      "Forged description",
    );
    await f.app.inject({
      method: "POST",
      url: `/api/panes/${f.pane.id}/title/generate`,
      headers: headers(),
    });
    expect(f.store.getPane(f.pane.id).title).toBe("Pinned task");
  });
  it("protects global generation policy with ADMIN and CSRF and persists valid changes", async () => {
    const f = await fixture();
    const url = "/api/settings/task-titles";
    expect(
      (
        await f.app.inject({
          method: "PATCH",
          url,
          headers: headers("OPERATOR"),
          payload: { enabled: false },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          method: "PATCH",
          url,
          headers: { cookie: headers().cookie },
          payload: { enabled: false },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          method: "PATCH",
          url,
          headers: headers(),
          payload: { enabled: false },
        })
      ).json().enabled,
    ).toBe(false);
    expect(
      (await f.app.inject({ method: "GET", url, headers: headers() })).json()
        .enabled,
    ).toBe(false);
  });
  it("saves pane model preferences with matching metadata versions", async () => {
    const f = await fixture();
    const response = await f.app.inject({
      method: "PATCH",
      url: `/api/panes/${f.pane.id}/title/preference`,
      headers: headers(),
      payload: { candidateId: "opencode:opencode:free-flash" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().taskMetadata.preferredCandidateId).toBe(
      "opencode:opencode:free-flash",
    );
  });
  it("uses native Codex first-user context when detailed transcript reading is unavailable", async () => {
    const native = {
      getThread: vi.fn(async () => {
        throw new Error("Transcript unavailable");
      }),
      getHistoryThread: vi.fn(async () => ({
        title: "Native menu repair",
        firstUserMessage: "Repair workspace navigation",
      })),
    } as any;
    const f = await fixture(
      {
        codexParity: native,
        findCodexThreadId: async () => "019f40f1-4a7e-7c41-b137-41705dad3b98",
      },
      "cli:codex",
    );
    const response = await f.app.inject({
      method: "POST",
      url: `/api/panes/${f.pane.id}/title/generate`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(200);
    // Codex's saved thread title is a summary, not an echo of the prompt, so it
    // names the task until the title model answers.
    expect(response.json()).toMatchObject({
      title: "Native menu repair",
      taskMetadata: { generationStatus: "pending", nativeTitle: "Native menu repair", nativeTitleLabel: "Codex" },
    });
    expect(native.getHistoryThread).toHaveBeenCalled();
  });
  it("ignores a Codex saved title that only repeats the first prompt", async () => {
    const native = {
      getThread: vi.fn(async () => {
        throw new Error("Transcript unavailable");
      }),
      getHistoryThread: vi.fn(async () => ({
        title: "Repair workspace navigation",
        firstUserMessage: "Repair workspace navigation",
      })),
    } as any;
    const f = await fixture(
      {
        codexParity: native,
        findCodexThreadId: async () => "019f40f1-4a7e-7c41-b137-41705dad3b98",
      },
      "cli:codex",
    );
    const response = await f.app.inject({
      method: "POST",
      url: `/api/panes/${f.pane.id}/title/generate`,
      headers: headers(),
    });
    expect(response.json()).toMatchObject({ title: "New task", taskMetadata: { nativeTitle: null } });
  });
});
