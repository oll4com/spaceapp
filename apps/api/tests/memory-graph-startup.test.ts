import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DummyTurnInput } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";

const graphModule = vi.hoisted(() => ({ importCount: 0 }));

vi.mock("@space/memory-graph", () => {
  graphModule.importCount += 1;
  throw new Error("ordinary startup imported the memory graph module");
});

const immediateTurnStarter = {
  plan(input: DummyTurnInput) {
    return {
      workflowId: `workflow:startup:${input.roomId}:${input.paneId}`,
      runId: null,
      roomId: input.roomId,
      paneId: input.paneId,
      traceId: input.traceId,
      status: "QUEUED" as const,
      runtime: "DUMMY_TEMPORAL" as const,
      artifactIds: input.artifactIds
    };
  },
  async start(input: DummyTurnInput) {
    return {
      ...this.plan(input),
      runId: "run:startup-turn"
    };
  }
};

describe("memory graph startup isolation", () => {
  it("keeps graph imports and maintenance polling out of ordinary room, chat and turn paths", async () => {
    const sessionSecret = "test-secret-with-enough-length";
    const sessionToken = signSession(
      { id: "user:operator", email: "operator@space.test", role: "OPERATOR" },
      sessionSecret
    );
    const cookie = `space_session=${sessionToken}`;
    const csrfToken = createCsrfToken(sessionToken, sessionSecret)!;
    const app = await createApp({
      store: new InMemorySpaceStore(),
      turnStarter: immediateTurnStarter,
      config: getApiConfig({
        SPACE_MEMORY_GRAPH_ENABLED: "true",
        SPACE_MEMORY_GRAPH_ROOT: "/tmp/space-memory-startup-must-not-read",
        SPACE_BROWSER_EVIDENCE_ENABLED: "false"
      }),
      auth: { sessionSecret, devLogin: false, secureCookies: false }
    });

    try {
      const createdRoom = await app.inject({
        method: "POST",
        url: "/api/rooms",
        headers: { cookie, "x-space-csrf-token": csrfToken },
        payload: { name: "Startup isolation", initialPaneCount: 1 }
      });
      expect(createdRoom.statusCode).toBe(200);
      const roomId = createdRoom.json().id as string;

      const rooms = await app.inject({ method: "GET", url: "/api/rooms", headers: { cookie } });
      const panes = await app.inject({
        method: "GET",
        url: `/api/panes?roomId=${encodeURIComponent(roomId)}`,
        headers: { cookie }
      });
      expect(rooms.statusCode).toBe(200);
      expect(panes.statusCode).toBe(200);
      const paneId = panes.json().data[0].id as string;

      const turn = await app.inject({
        method: "POST",
        url: "/api/turns",
        headers: { cookie, "x-space-csrf-token": csrfToken },
        payload: { roomId, paneId, prompt: "Ordinary chat turn", runtime: "DUMMY_TEMPORAL" }
      });
      expect(turn.statusCode).toBe(200);
      expect(turn.json()).toMatchObject({ status: "QUEUED", roomId, paneId });
      expect(graphModule.importCount).toBe(0);

      const ordinaryWorker = await readFile(resolve(process.cwd(), "../worker/src/worker.ts"), "utf8");
      expect(ordinaryWorker).not.toContain("memory-maintenance");
      expect(ordinaryWorker).not.toContain("memory-graph");
    } finally {
      await app.close();
    }
  });
});
