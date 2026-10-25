import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { createCsrfToken, signSession } from "../src/auth.js";

const secret = "isolated-control-upload-test";
let root: string;
let outside: string;
let app: Awaited<ReturnType<typeof createApp>>;
let store: InMemorySpaceStore;
let roomId: string;
const session = signSession({ id: "user:upload-test", role: "ADMIN", email: "uploads@space.local" }, secret);
const headers = { cookie: `space_session=${session}`, "x-space-csrf-token": createCsrfToken(session, secret)! };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "space-control-upload-"));
  outside = await mkdtemp(join(tmpdir(), "space-control-outside-"));
  store = new InMemorySpaceStore();
  store.upsertUser({ id: "user:upload-test", role: "ADMIN", email: "uploads@space.local" });
  roomId = store.createRoom({ name: "Control upload fixture", initialPaneCount: 0, kind: "AGENT_PROOF" }).id;
  app = await createApp({ store, config: getApiConfig({ SPACE_ARTIFACT_ROOT: root, SPACE_LOG_LEVEL: "silent" }),
    auth: { sessionSecret: secret, devLogin: false, secureCookies: false } });
});
afterEach(async () => { vi.restoreAllMocks(); await app.close(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
function publish(operation = "media.publish") {
  return app.inject({ method: "POST", url: "/api/control/v1/commands", headers, payload: { roomId, requestId: "control-upload-fixture",
    actions: [{ kind: "resource", operation, input: { filename: "note.txt", mimeType: "text/plain", text: "retained content" } }] } });
}

it("rejects symlinked Control media storage without writing outside the artifact root", async () => {
  await symlink(outside, join(root, "user-uploads"));
  const response = await publish();
  expect(response.json().status).toBe("FAILED");
  expect(await readdir(outside)).toEqual([]);
  expect(store.listArtifacts()).toEqual([]);
});

it.each(["media.publish", "files.publish"])("retains %s bytes after a lost database acknowledgement", async operation => {
  const create = store.createArtifact.bind(store);
  const lostAck = vi.spyOn(store, "createArtifact").mockImplementation((...args) => {
    create(...args); throw new Error("Connection lost after COMMIT");
  });
  const response = await publish(operation);
  expect(response.json().status).not.toBe("COMPLETED");
  expect(lostAck).toHaveBeenCalledTimes(1);
  const [artifact] = store.listArtifacts();
  expect(artifact).toBeDefined();
  const downloaded = await app.inject({ method: "GET", url: `/api/artifacts/${encodeURIComponent(artifact!.id)}/file`, headers });
  expect(downloaded.statusCode).toBe(200);
  expect(downloaded.body).toBe("retained content");
});
