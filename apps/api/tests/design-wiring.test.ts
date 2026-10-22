// The Design pane's auto-open (plan clipboard:URdc3U314lUH): a request with no Design pane open opens one in the requester's room,
// allocates its CLI session and starts the designer headless (an allocated session alone waits for a terminal to attach), without
// holding the requester's answer while the designer starts.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { Pane } from "@space/contracts";
import { InMemoryDesignRepository } from "@space/db";
import { InMemorySpaceStore, SpaceEventBus } from "@space/runtime";
import { registerDesign } from "../src/design/wiring.js";

const owner = "user:design-owner";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Design pane auto-open", () => {
  it("opens a Design pane, allocates its session and starts the designer headless without waiting for it", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "space-design-wiring-"));
    roots.push(artifactRoot);
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Work", initialPaneCount: 0 }, "trace:room", owner);
    const requester = store.createPane({ roomId: room.id, title: "Claude Code CLI", mode: "TERMINAL", terminalRuntimeId: "cli:claude" });
    const calls: string[] = [];
    let finishStart: () => void = () => undefined;
    const app = Fastify();
    const service = registerDesign(app, {
      store, eventBus: new SpaceEventBus(), databaseUrl: null, repository: new InMemoryDesignRepository(), artifactRoot, brandRoot: "/opt/spaceapp/apps/web/public/brand",
      gatewayUrl: "http://127.0.0.1:1", gatewayKeyFile: null, routeOptions: {}, roomOwner: async () => owner,
      terminal: {} as never, notifications: { raise: async () => ({}) as never, resolve: async () => 1 },
      authenticatedOwner: async () => owner, assertPaneAccess: async () => undefined, parseBody: (schema, body) => schema.parse(body), parseQuery: (schema, query) => schema.parse(query), audit: async () => undefined,
      log: { warn: () => undefined },
      invoke: async (_owner, method, url) => {
        calls.push(`${method} ${url}`);
        if (url.endsWith("/panes")) return { data: [store.createPane({ roomId: room.id, title: "Design", mode: "DESIGN", terminalRuntimeId: "cli:claude" })] };
        return {};
      },
      inspect: async () => ({ state: "STARTING" }) as never,
      // A designer that takes long to start: the requester's answer must not wait for it.
      start: (pane: Pane) => { calls.push(`start ${pane.id}`); return new Promise<void>((resolve) => { finishStart = resolve; }); }
    });
    try {
      const created = await service.createRequest(owner, { kind: "PANE", paneId: requester.id, roomId: room.id, label: "Claude Code CLI" },
        { brief: "Release card", formatIds: ["square"], referenceArtifactIds: [] });
      const design = (await store.listPanes(room.id)).find((pane) => pane.mode === "DESIGN")!;
      expect(created.request).toMatchObject({ status: "QUEUED", designPaneId: design.id });
      expect(calls).toEqual([`POST /api/rooms/${encodeURIComponent(room.id)}/panes`, `POST /api/panes/${encodeURIComponent(design.id)}/cli/session`, `start ${design.id}`]);
    } finally {
      finishStart();
      await app.close();
    }
  });
});
