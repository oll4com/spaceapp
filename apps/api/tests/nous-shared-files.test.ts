// Agent Files shared to the Nous app (plan clipboard:RQSrp1EczBbV, operator 31/10 00:25 BKK): Nous shares one of the owner's Agent Files
// for a while, the app lists and opens it, and removing it there removes only the share; the Agent File is never touched.
import Fastify from "fastify";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { InMemoryNousRepository } from "@space/db";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession, signSessionWithTtl } from "../src/auth.js";
import { persistAgentFile } from "../src/cli-agent-files.js";
import { getApiConfig } from "../src/config.js";
import { createNousSharedFiles, registerNousSharedFileRoutes } from "../src/nous/shared-files.js";
import { NOUS_SUBAGENT_EXCLUDED } from "../src/nous/subagents.js";
import { createNousTools, nousToolDefinitions } from "../src/nous/tools.js";

const owner = "user:operator";
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "nous-shared-files-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function agentFile(store: InMemorySpaceStore, roomId: string, name: string, text: string) {
  const sourcePath = join(root, `staged-${name}`);
  await writeFile(sourcePath, text);
  return (await persistAgentFile({ store, artifactRoot: root, roomId, paneId: null, cliSessionId: null, runtimeId: "user", originalFilename: name,
    declaredMimeType: "text/plain", sourcePath, traceId: "trace:shared-files", source: "AGENT_OUTPUT", folder: "Graphics/Icons" })).artifact;
}

async function fixture(now = Date.now) {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Main", initialPaneCount: 0 }, undefined, owner);
  const other = store.createRoom({ name: "Theirs", initialPaneCount: 0 }, undefined, "user:other");
  const icon = await agentFile(store, room.id, "icon-options.txt", "three icons");
  const theirs = await agentFile(store, other.id, "theirs.txt", "not yours");
  const media = store.createArtifact({ roomId: room.id, kind: "SCREENSHOT", mimeType: "image/png", storageUri: "space-artifact://user-uploads/x/shot.png",
    byteSize: 3, sha256: "a".repeat(64), metadata: {} }).artifact;
  const repository = new InMemoryNousRepository();
  const files = createNousSharedFiles({ repository, getArtifact: async (id) => store.getArtifact(id), rooms: async (who) => store.listRooms(who), now });
  return { store, room, icon, theirs, media, repository, files };
}

it("shares only the owner's Agent Files, lists them in the app's shape, renews instead of duplicating and clamps the time", async () => {
  const { icon, theirs, media, files } = await fixture();
  expect((await files.share(owner, { artifactId: theirs.id })).ok).toBe(false);
  expect((await files.share(owner, { artifactId: media.id })).ok).toBe(false);
  expect((await files.share(owner, { artifactId: "artifact:missing0001" })).ok).toBe(false);
  // 13/11 15:40: an id without its "artifact:" prefix names the same file.
  expect(await files.share(owner, { artifactId: icon.id.replace(/^artifact:/, "") })).toMatchObject({ ok: true });
  const shared = await files.share(owner, { artifactId: icon.id, note: "Pick one of the three icons" });
  expect(shared).toMatchObject({ ok: true, display: "Shared icon-options.txt to the Nous app" });
  const [file] = await files.list(owner);
  expect(Object.keys(file!).sort()).toEqual(["artifactId", "expiresAt", "folder", "mime", "name", "note", "shareId", "sharedAt", "size"]);
  expect(file).toMatchObject({ artifactId: icon.id, name: "icon-options.txt", folder: "Graphics/Icons", mime: "text/plain", size: 11, note: "Pick one of the three icons" });
  expect(Date.parse(file!.expiresAt) - Date.parse(file!.sharedAt)).toBe(72 * 3_600_000);
  const again = await files.share(owner, { artifactId: icon.id, hours: 1_000 });
  // Any length since 31/10 (until then at most 14 days).
  expect(again.result).not.toContain("at most");
  const renewed = await files.list(owner);
  expect(renewed).toHaveLength(1);
  expect(renewed[0]!.shareId).toBe(file!.shareId);
  expect(Date.parse(renewed[0]!.expiresAt) - Date.parse(renewed[0]!.sharedAt)).toBe(1_000 * 3_600_000);
  expect(await files.list("user:other")).toEqual([]);
});

it("drops expired shares and shares whose Agent File is gone, and removing a share leaves the Agent File", async () => {
  const past = await fixture(() => Date.now() - 100 * 3_600_000);
  await past.files.share(owner, { artifactId: past.icon.id });
  expect(await past.files.list(owner)).toEqual([]);

  const { store, icon, files } = await fixture();
  await files.share(owner, { artifactId: icon.id });
  const [file] = await files.list(owner);
  expect(await files.remove("user:other", file!.shareId)).toBe(false);
  expect(await files.remove(owner, file!.shareId)).toBe(true);
  expect(await files.list(owner)).toEqual([]);
  expect(store.getArtifact(icon.id).deletedAt).toBeFalsy();
  await files.share(owner, { artifactId: icon.id });
  store.deleteArtifact(icon.id);
  expect(await files.list(owner)).toEqual([]);
});

it("answers the app's routes: the list, and a DELETE that removes only the share", async () => {
  const { store, icon, files } = await fixture();
  await files.share(owner, { artifactId: icon.id, note: "Approve" });
  const app = Fastify();
  let person = true;
  registerNousSharedFileRoutes(app, { files, routeOptions: {}, owner: async () => owner, parseQuery: (schema, value) => schema.parse(value),
    assertPerson: () => { if (!person) throw Object.assign(new Error("Only the operator."), { statusCode: 403 }); } });
  const list = await app.inject("/api/nous/shared-files");
  expect(list.statusCode).toBe(200);
  const [file] = list.json();
  expect(file).toMatchObject({ artifactId: icon.id, name: "icon-options.txt", note: "Approve" });
  person = false;
  expect((await app.inject({ method: "DELETE", url: `/api/nous/shared-files/${file.shareId}` })).statusCode).toBe(403);
  person = true;
  expect((await app.inject({ method: "DELETE", url: `/api/nous/shared-files/${file.shareId}` })).json()).toEqual({ removed: true });
  expect((await app.inject("/api/nous/shared-files")).json()).toEqual([]);
  expect(store.getArtifact(icon.id).deletedAt).toBeFalsy();
  await app.close();
});

it("gives Nous the share tool and the list, never a helper the share", async () => {
  const { icon, files } = await fixture();
  const tools = createNousTools({ sharedFiles: files } as never);
  const ctx = { owner, turnId: "turn:share", callId: "call:share", traceId: "trace:share" };
  expect((await tools.execute("space_nous_share_file", { artifactId: icon.id, note: "Pick one" }, { ...ctx, turn: { reason: "HELPER" } } as never)).ok).toBe(false);
  expect((await tools.execute("space_nous_share_file", { artifactId: icon.id, note: "Pick one", hours: 24 }, ctx)).ok).toBe(true);
  const listed = await tools.execute("space_nous_shared_files", {}, ctx);
  expect(listed.result).toContain("icon-options.txt");
  expect(listed.result).toContain("Pick one");
  const names = nousToolDefinitions({ copilots: false }).map((tool) => tool.name);
  expect(names).toEqual(expect.arrayContaining(["space_nous_share_file", "space_nous_shared_files"]));
  expect(NOUS_SUBAGENT_EXCLUDED.has("space_nous_share_file")).toBe(true);
});

it("lets the Nous app's device session list, remove and open files; a proof session cannot remove", async () => {
  const secret = "nous-shared-files-test-session-secret";
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Main", initialPaneCount: 0 }, undefined, owner);
  const icon = await agentFile(store, room.id, "icon-options.txt", "three icons");
  const app = await createApp({ store, config: getApiConfig({ SPACE_LOG_LEVEL: "silent", SPACE_CLI_ENABLED: "false", SPACE_BROWSER_SESSIONS_ENABLED: "false", SPACE_ARTIFACT_ROOT: root }),
    auth: { sessionSecret: secret, devLogin: false, secureCookies: false } });
  const session = (token: string) => ({ cookie: `space_session=${token}`, "x-space-csrf-token": createCsrfToken(token, secret)! });
  const user = { id: owner, role: "ADMIN" as const, email: "space@space.local" };
  const device = session(signSession(user, secret, Date.now(), { app: "nous" }));
  const proof = session(signSessionWithTtl({ ...user, id: "user:operator-proof" }, secret, 120));
  try {
    const list = await app.inject({ url: "/api/nous/shared-files", headers: device });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([]);
    expect((await app.inject({ method: "DELETE", url: "/api/nous/shared-files/nous_share:missing000001", headers: device })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/api/nous/shared-files/nous_share:missing000001", headers: proof })).statusCode).toBe(403);
    const opened = await app.inject({ url: `/api/artifacts/${encodeURIComponent(icon.id)}/file`, headers: device });
    expect(opened.statusCode).toBe(200);
    expect(opened.body).toBe("three icons");
  } finally { await app.close(); }
});
