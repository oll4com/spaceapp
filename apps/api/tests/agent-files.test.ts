import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCanonicalSpaceMemoryBridge, InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import {
  AgentFileDocxNormalizationError,
  agentFileStoragePath,
  backfillAgentFile,
  cliAgentFilesTokenHeader,
  issueCliAgentFilesToken,
  normalizeAgentFileDocx,
  renderAgentFileDocxPreview,
  sanitizeAgentFileDocxHtml,
  verifyCliAgentFilesToken,
  type AgentFileDocxNormalizer
} from "../src/cli-agent-files.js";
import { buildCliEnvironment } from "../src/cli-terminal.js";
import { getApiConfig, type SpaceApiConfig } from "../src/config.js";
import { inspectUploadRecord } from "../src/upload-record.js";

const csrfHeaderName = "x-space-csrf-token";
const temporaryRoots: string[] = [];

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180) || "item";
}

function multipartFiles(parts: Array<{ filename: string; mimeType?: string; body: Buffer | string }>) {
  const boundary = "space-agent-files-test-boundary";
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${part.filename}"\r\n` +
      `Content-Type: ${part.mimeType ?? "application/octet-stream"}\r\n\r\n`
    ));
    chunks.push(Buffer.isBuffer(part.body) ? part.body : Buffer.from(part.body));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

function testConfig(artifactRoot: string): SpaceApiConfig {
  return getApiConfig({
    SPACE_INTERNAL_API_TOKEN: "agent-files-test-internal-token",
    SPACE_ARTIFACT_ROOT: artifactRoot,
    SPACE_BROWSER_EVIDENCE_TARGET_ORIGIN: "http://127.0.0.1:4910"
  });
}

async function createTestApp(
  store: InMemorySpaceStore,
  artifactRoot: string,
  agentFileDocxNormalizer?: AgentFileDocxNormalizer
) {
  const memoryRoot = await mkdtemp(join(tmpdir(), "space-agent-files-memory-"));
  temporaryRoots.push(memoryRoot);
  const indexPath = join(memoryRoot, "gemini_history.md");
  const monthlyPath = join(memoryRoot, "gemini_history_2026-07.md");
  await writeFile(indexPath, "# Test memory\n");
  await writeFile(monthlyPath, "# Test monthly memory\n");
  const config = {
    ...testConfig(artifactRoot),
    spaceMemoryIndexPath: indexPath,
    spaceMemoryMonthlyPath: monthlyPath,
    spaceMemoryLockPath: join(memoryRoot, "memory.lock")
  };
  const app = await createApp({
    store,
    config,
    agentFileDocxNormalizer,
    canonicalMemory: createCanonicalSpaceMemoryBridge({ indexPath, monthlyPath }),
    auth: {
      sessionSecret: "agent-files-test-session-secret",
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
  const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
  expect(csrf.statusCode).toBe(200);
  return { app, config, cookie, csrfToken: csrf.json().csrfToken as string };
}

function createCliFixture(
  store: InMemorySpaceStore,
  name = "Agent Files",
  purpose: "NORMAL" | "LOGIN" = "NORMAL"
) {
  const room = store.createRoom({ name, initialPaneCount: 0 });
  const pane = store.createPane({ roomId: room.id, title: "Codex CLI", mode: "TERMINAL" });
  const session = store.createPaneCliSession({
    sessionId: `cli_session:${safeSegment(name).toLowerCase()}`,
    paneId: pane.id,
    roomId: room.id,
    runtimeId: "cli:codex",
    providerId: "codex",
    agentId: "codex",
    modelId: null,
    reasoningEffort: "medium",
    cwd: "/opt/spaceapp/var/artifacts/cli-workspaces/test",
    status: "RUNNING",
    statusReason: "CLI running.",
    isActive: true,
    purpose
  });
  return { room, pane, session };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Agent Files token and environment", () => {
  it("issues room/pane/session scoped tokens, rejects expiry, and excludes login environments", () => {
    const config = testConfig("/tmp/space-agent-files-test");
    const context = { roomId: "room:test", paneId: "pane:test", cliSessionId: "cli_session:test" };
    const token = issueCliAgentFilesToken(config, context, 1_000_000);

    expect(token).toMatch(/^cliagentfiles\.v1\./);
    expect(verifyCliAgentFilesToken(config, token, 1_000_000)).toMatchObject(context);
    expect(verifyCliAgentFilesToken(config, token, 1_000_000 + 12 * 60 * 60 * 1000 + 1)).toBeNull();
    expect(verifyCliAgentFilesToken({ ...config, internalApiToken: "different" }, token, 1_000_000)).toBeNull();

    expect(buildCliEnvironment(config, {
      ...context,
      runtimeId: "cli:codex",
      purpose: "NORMAL"
    })).toMatchObject({
      SPACE_AGENT_FILES_ENABLED: "true",
      SPACE_AGENT_FILES_TOKEN: expect.stringMatching(/^cliagentfiles\.v1\./),
      SPACE_ROOM_ID: context.roomId,
      SPACE_PANE_ID: context.paneId,
      SPACE_CLI_SESSION_ID: context.cliSessionId
    });
    expect(buildCliEnvironment(config, {
      ...context,
      runtimeId: "cli:codex",
      purpose: "LOGIN"
    })).toMatchObject({
      SPACE_AGENT_FILES_ENABLED: "unavailable"
    });
    expect(buildCliEnvironment(config, {
      ...context,
      runtimeId: "cli:root",
      purpose: "NORMAL"
    }).PATH).toContain("/opt/spaceapp/bin");
  });
});

describe("Agent Files API", () => {
  it("denies artifact symlink escape and isolates active artifact responses", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "space-artifact-containment-"));
    temporaryRoots.push(artifactRoot);
    const store = new InMemorySpaceStore();
    const { room } = createCliFixture(store, "Containment");
    const { app, cookie } = await createTestApp(store, artifactRoot);
    try {
      const directory = join(artifactRoot, "user-uploads", safeSegment(room.id), "2026-10-03");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "active.html"), "<script>fetch('/api/rooms')</script>");
      const { artifact } = store.createArtifact({ roomId: room.id, paneId: null, kind: "EXPORT", mimeType: "text/html",
        storageUri: `space-artifact://user-uploads/${encodeURIComponent(room.id)}/2026-10-03/active.html`,
        sha256: "a".repeat(64), byteSize: 42, metadata: {} }, "trace:security");
      const response = await app.inject({ url: `/api/artifacts/${encodeURIComponent(artifact.id)}/file`, headers: { cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-disposition"]).toMatch(/^attachment;/);
      expect(response.headers["content-security-policy"]).toContain("sandbox");
      const outside = await mkdtemp(join(tmpdir(), "space-artifact-outside-"));
      temporaryRoots.push(outside);
      await writeFile(join(outside, "sentinel.txt"), "OUTSIDE_SENTINEL");
      await rm(join(directory, "active.html"));
      await symlink(join(outside, "sentinel.txt"), join(directory, "active.html"));
      const escaped = await app.inject({ url: `/api/artifacts/${encodeURIComponent(artifact.id)}/file`, headers: { cookie } });
      expect(escaped.statusCode).toBe(403);
      expect(escaped.body).not.toContain("OUTSIDE_SENTINEL");
    } finally { await app.close(); }
  });

  it("publishes, previews, downloads, audits, emits, and deletes only Agent Files", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "space-agent-files-api-"));
    temporaryRoots.push(artifactRoot);
    const store = new InMemorySpaceStore();
    const { room, pane, session } = createCliFixture(store);
    const { app, config, cookie, csrfToken } = await createTestApp(store, artifactRoot);
    const token = issueCliAgentFilesToken(config, {
      roomId: room.id,
      paneId: pane.id,
      cliSessionId: session.sessionId
    })!;
    const upload = multipartFiles([{
      filename: "agent-notes.txt",
      mimeType: "text/plain",
      body: "<script>not executable</script>\nFinal notes"
    }]);

    const published = await app.inject({
      method: "POST",
      url: "/api/cli/agent-files",
      headers: {
        [cliAgentFilesTokenHeader]: token,
        "content-type": upload.contentType
      },
      payload: upload.payload
    });
    expect(published.statusCode).toBe(200);
    const artifact = published.json().artifacts[0];
    expect(artifact).toMatchObject({
      roomId: room.id,
      paneId: pane.id,
      mimeType: "text/plain",
      metadata: {
        source: "AGENT_OUTPUT",
        originalFilename: "agent-notes.txt",
        cliSessionId: session.sessionId,
        runtimeId: "cli:codex",
        previewKind: "TEXT"
      }
    });
    expect(artifact.storageUri).toMatch(/^space-artifact:\/\/agent-files\//);
    expect(store.listArtifacts({
      roomId: room.id,
      collection: "AGENT_FILES",
      page: 1,
      pageSize: 25,
      sortOrder: "desc"
    })).toHaveLength(1);
    expect(store.listEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "ARTIFACT_CREATED",
        roomId: room.id,
        paneId: pane.id,
        payload: expect.objectContaining({ artifactId: artifact.id })
      })
    ]));
    expect(store.listAuditEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "agent_file.publish",
        targetId: pane.id,
        metadata: expect.objectContaining({ roomId: room.id, artifactIds: [artifact.id] })
      })
    ]));

    const parsedUri = new URL(artifact.storageUri);
    const pathSegments = parsedUri.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const storedPath = agentFileStoragePath({
      artifactRoot,
      roomId: pathSegments[0]!,
      paneId: pathSegments[1]!,
      cliSessionId: pathSegments[2]!,
      day: pathSegments[3]!,
      storedFilename: pathSegments[4]!
    });
    expect((await stat(storedPath)).size).toBe(Buffer.byteLength("<script>not executable</script>\nFinal notes"));
    expect((await stat(storedPath)).mode & 0o777).toBe(0o644);

    const preview = await app.inject({
      method: "GET",
      url: `/api/artifacts/${encodeURIComponent(artifact.id)}/preview`,
      headers: { cookie }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["content-type"]).toContain("text/plain");
    expect(preview.body).toContain("<script>not executable</script>");

    const download = await app.inject({
      method: "GET",
      url: `/api/artifacts/${encodeURIComponent(artifact.id)}/download`,
      headers: { cookie }
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toContain("attachment");
    expect(download.headers["content-disposition"]).toContain("agent-notes.txt");
    expect(download.body).toContain("Final notes");

    const mediaPath = join(artifactRoot, "cli-uploads", "room", "pane", "session", "2026-07-29", "input.txt");
    await mkdir(join(mediaPath, ".."), { recursive: true });
    await writeFile(mediaPath, "input stays");
    const mediaArtifact = store.createArtifact({
      roomId: room.id,
      paneId: pane.id,
      kind: "EXPORT",
      mimeType: "text/plain",
      storageUri: "space-artifact://cli-uploads/room/pane/session/2026-07-29/input.txt",
      sha256: createHash("sha256").update("input stays").digest("hex"),
      byteSize: 11,
      metadata: { source: "USER_UPLOAD", originalFilename: "input.txt" }
    }).artifact;

    const cleared = await app.inject({
      method: "DELETE",
      url: `/api/rooms/${encodeURIComponent(room.id)}/agent-files`,
      headers: { cookie, [csrfHeaderName]: csrfToken }
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ matchedCount: 1, deletedCount: 1, failedCount: 0 });
    expect(store.listArtifacts({
      roomId: room.id,
      collection: "AGENT_FILES",
      page: 1,
      pageSize: 25,
      sortOrder: "desc"
    })).toEqual([]);
    expect(store.getArtifact(mediaArtifact.id)).toEqual(mediaArtifact);
    await expect(readFile(mediaPath, "utf8")).resolves.toBe("input stays");
    await expect(readFile(storedPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(store.listAuditEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "room.agent_files.clear",
        targetId: room.id,
        metadata: expect.objectContaining({ matchedCount: 1, deletedCount: 1 })
      })
    ]));

    await app.close();
  });

  it("lets an authenticated operator upload own files into Agent Files and rejects unauthenticated or empty uploads", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "space-agent-files-user-upload-"));
    temporaryRoots.push(artifactRoot);
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Operator Uploads", initialPaneCount: 0 });
    const { app, cookie, csrfToken } = await createTestApp(store, artifactRoot);
    const uploadUrl = `/api/rooms/${encodeURIComponent(room.id)}/agent-files/uploads`;

    const unauthenticated = await app.inject({
      method: "POST",
      url: uploadUrl,
      headers: { "content-type": "application/json" },
      payload: {}
    });
    expect(unauthenticated.statusCode).toBe(401);

    const notMultipart = await app.inject({
      method: "POST",
      url: uploadUrl,
      headers: { cookie, [csrfHeaderName]: csrfToken, "content-type": "application/json" },
      payload: {}
    });
    expect(notMultipart.statusCode).toBe(400);

    const emptyUpload = multipartFiles([]);
    const empty = await app.inject({
      method: "POST",
      url: uploadUrl,
      headers: { cookie, [csrfHeaderName]: csrfToken, "content-type": emptyUpload.contentType },
      payload: emptyUpload.payload
    });
    expect(empty.statusCode).toBe(422);
    expect(empty.json()).toMatchObject({ error: { code: "EMPTY_UPLOAD" } });

    const upload = multipartFiles([
      { filename: "operator-brief.txt", mimeType: "text/plain", body: "Operator provided context" },
      { filename: "operator-data.txt", mimeType: "text/plain", body: "More operator data" }
    ]);
    const uploaded = await app.inject({
      method: "POST",
      url: uploadUrl,
      headers: { cookie, [csrfHeaderName]: csrfToken, "content-type": upload.contentType },
      payload: upload.payload
    });
    expect(uploaded.statusCode).toBe(200);
    const artifacts = uploaded.json().artifacts;
    expect(artifacts).toHaveLength(2);
    for (const artifact of artifacts) {
      expect(artifact).toMatchObject({
        roomId: room.id,
        paneId: null,
        mimeType: "text/plain",
        metadata: {
          source: "USER_UPLOAD",
          runtimeId: "user",
          previewKind: "TEXT"
        }
      });
      expect(artifact.metadata.cliSessionId).toBeUndefined();
      expect(artifact.storageUri).toMatch(
        new RegExp(`^space-artifact://agent-files/${encodeURIComponent(room.id)}/user/browser/\\d{4}-\\d{2}-\\d{2}/`)
      );
      const segments = new URL(artifact.storageUri).pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const storedPath = agentFileStoragePath({
        artifactRoot,
        roomId: segments[0]!,
        paneId: segments[1]!,
        cliSessionId: segments[2]!,
        day: segments[3]!,
        storedFilename: segments[4]!
      });
      expect((await stat(storedPath)).mode & 0o777).toBe(0o644);
    }
    expect(store.listArtifacts({
      roomId: room.id,
      collection: "AGENT_FILES",
      page: 1,
      pageSize: 25,
      sortOrder: "desc"
    })).toHaveLength(2);
    expect(store.listAuditEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "agent_file.upload",
        targetId: room.id,
        metadata: expect.objectContaining({ roomId: room.id, artifactCount: 2 })
      })
    ]));

    await app.close();
  });

  it("rebuilds DOCX files before persistence and fails closed when Word compatibility cannot be produced", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "space-agent-files-docx-publish-"));
    temporaryRoots.push(artifactRoot);
    const sourceBuffer = Buffer.from([0x50, 0x4b, ...Buffer.from("source-docx")]);
    const normalizedBuffer = Buffer.concat([sourceBuffer, Buffer.from("-libreoffice-rebuilt")]);
    const store = new InMemorySpaceStore();
    const { room, pane, session } = createCliFixture(store, "DOCX publish");
    const { app, config, cookie } = await createTestApp(
      store,
      artifactRoot,
      async () => normalizedBuffer
    );
    const token = issueCliAgentFilesToken(config, {
      roomId: room.id,
      paneId: pane.id,
      cliSessionId: session.sessionId
    })!;
    const upload = multipartFiles([{
      filename: "final.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      body: sourceBuffer
    }]);

    const published = await app.inject({
      method: "POST",
      url: "/api/cli/agent-files",
      headers: {
        [cliAgentFilesTokenHeader]: token,
        "content-type": upload.contentType
      },
      payload: upload.payload
    });
    expect(published.statusCode).toBe(200);
    const artifact = published.json().artifacts[0];
    expect(artifact).toMatchObject({
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sha256: createHash("sha256").update(normalizedBuffer).digest("hex"),
      byteSize: normalizedBuffer.byteLength,
      metadata: {
        originalFilename: "final.docx",
        previewKind: "DOCX",
        wordCompatibility: "LIBREOFFICE_REBUILT",
        agentFileSourceSha256: createHash("sha256").update(sourceBuffer).digest("hex"),
        agentFileSourceByteSize: sourceBuffer.byteLength
      }
    });
    const download = await app.inject({
      method: "GET",
      url: `/api/artifacts/${encodeURIComponent(artifact.id)}/download`,
      headers: { cookie }
    });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload).toEqual(normalizedBuffer);
    await app.close();

    const failingStore = new InMemorySpaceStore();
    const failingFixture = createCliFixture(failingStore, "DOCX failure");
    const failing = await createTestApp(
      failingStore,
      artifactRoot,
      async () => {
        throw new AgentFileDocxNormalizationError();
      }
    );
    const failingToken = issueCliAgentFilesToken(failing.config, {
      roomId: failingFixture.room.id,
      paneId: failingFixture.pane.id,
      cliSessionId: failingFixture.session.sessionId
    })!;
    const rejected = await failing.app.inject({
      method: "POST",
      url: "/api/cli/agent-files",
      headers: {
        [cliAgentFilesTokenHeader]: failingToken,
        "content-type": upload.contentType
      },
      payload: upload.payload
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error.code).toBe("DOCX_NORMALIZATION_FAILED");
    expect(failingStore.listArtifacts({
      roomId: failingFixture.room.id,
      collection: "AGENT_FILES",
      page: 1,
      pageSize: 25,
      sortOrder: "desc"
    })).toEqual([]);
    await failing.app.close();
  });

  it("lets an open T3 Code pane publish under its T3 principal and refuses closed or foreign panes", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "space-agent-files-t3-"));
    temporaryRoots.push(artifactRoot);
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "T3 Agent Files", initialPaneCount: 0 });
    const other = store.createRoom({ name: "T3 other room", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "T3 Code", mode: "T3CODE" });
    const { app, config } = await createTestApp(store, artifactRoot);
    const publish = (token: string) => {
      const upload = multipartFiles([{ filename: "t3-notes.txt", mimeType: "text/plain", body: "Final notes" }]);
      return app.inject({ method: "POST", url: "/api/cli/agent-files",
        headers: { [cliAgentFilesTokenHeader]: token, "content-type": upload.contentType }, payload: upload.payload });
    };
    const t3Token = (roomId: string, paneId: string) =>
      issueCliAgentFilesToken(config, { roomId, paneId, cliSessionId: `t3code:${paneId}` })!;
    const published = await publish(t3Token(room.id, pane.id));
    expect(published.statusCode).toBe(200);
    expect(published.json().artifacts[0]).toMatchObject({ roomId: room.id, paneId: pane.id,
      metadata: { source: "AGENT_OUTPUT", cliSessionId: `t3code:${pane.id}`, runtimeId: "cli:t3code" } });
    expect((await publish(t3Token(other.id, pane.id))).statusCode).toBe(404);
    store.updatePane(pane.id, { isClosed: true });
    expect((await publish(t3Token(room.id, pane.id))).statusCode).toBe(404);
  });

  it("fails closed for missing, cross-room, inactive, login, and over-count publishes", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "space-agent-files-gates-"));
    temporaryRoots.push(artifactRoot);
    const store = new InMemorySpaceStore();
    const normal = createCliFixture(store, "Normal");
    const inactive = createCliFixture(store, "Inactive");
    store.updatePaneCliSession(inactive.session.sessionId, {
      status: "EXITED",
      statusReason: "CLI exited.",
      isActive: false
    });
    const login = createCliFixture(store, "Login", "LOGIN");
    const otherRoom = store.createRoom({ name: "Other", initialPaneCount: 0 });
    const { app, config } = await createTestApp(store, artifactRoot);
    const oneFile = multipartFiles([{ filename: "final.txt", body: "final" }]);

    const missing = await app.inject({
      method: "POST",
      url: "/api/cli/agent-files",
      headers: { "content-type": oneFile.contentType },
      payload: oneFile.payload
    });
    expect(missing.statusCode).toBe(401);

    // The token is bound to its pane and session; it acts in the session's current room (a moved pane keeps working).
    const crossRoomToken = issueCliAgentFilesToken(config, {
      roomId: otherRoom.id,
      paneId: inactive.pane.id,
      cliSessionId: normal.session.sessionId
    })!;
    const crossRoom = await app.inject({
      method: "POST",
      url: "/api/cli/agent-files",
      headers: { [cliAgentFilesTokenHeader]: crossRoomToken, "content-type": oneFile.contentType },
      payload: oneFile.payload
    });
    expect(crossRoom.statusCode).toBe(404);

    for (const [fixture, expectedStatus, expectedCode] of [
      [inactive, 409, "CLI_SESSION_INACTIVE"],
      [login, 409, "CLI_LOGIN_SESSION_RESTRICTED"]
    ] as const) {
      const token = issueCliAgentFilesToken(config, {
        roomId: fixture.room.id,
        paneId: fixture.pane.id,
        cliSessionId: fixture.session.sessionId
      })!;
      const response = await app.inject({
        method: "POST",
        url: "/api/cli/agent-files",
        headers: { [cliAgentFilesTokenHeader]: token, "content-type": oneFile.contentType },
        payload: oneFile.payload
      });
      expect(response.statusCode).toBe(expectedStatus);
      expect(response.json().error.code).toBe(expectedCode);
    }

    const normalToken = issueCliAgentFilesToken(config, {
      roomId: normal.room.id,
      paneId: normal.pane.id,
      cliSessionId: normal.session.sessionId
    })!;
    const tooMany = multipartFiles(Array.from({ length: 9 }, (_, index) => ({
      filename: `final-${index}.txt`,
      body: "x"
    })));
    const limited = await app.inject({
      method: "POST",
      url: "/api/cli/agent-files",
      headers: { [cliAgentFilesTokenHeader]: normalToken, "content-type": tooMany.contentType },
      payload: tooMany.payload
    });
    expect(limited.statusCode).toBe(422);
    expect(limited.json().error.code).toBe("UPLOAD_LIMIT_EXCEEDED");
    expect(store.listArtifacts({
      roomId: normal.room.id,
      collection: "AGENT_FILES",
      page: 1,
      pageSize: 25,
      sortOrder: "desc"
    })).toEqual([]);

    await app.close();
  });

  it("clears more than one API page of Agent Files without repeating or skipping artifacts", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "space-agent-files-clear-pages-"));
    temporaryRoots.push(artifactRoot);
    const store = new InMemorySpaceStore();
    const { room, pane, session } = createCliFixture(store, "Clear pages");
    const { app, cookie, csrfToken } = await createTestApp(store, artifactRoot);
    const day = "2026-07-29";
    const destinationDir = join(
      artifactRoot,
      "agent-files",
      safeSegment(room.id),
      safeSegment(pane.id),
      safeSegment(session.sessionId),
      day
    );
    await mkdir(destinationDir, { recursive: true });

    for (let index = 0; index < 101; index += 1) {
      const storedFilename = `agent-file-${index}.txt`;
      const body = `deliverable-${index}`;
      await writeFile(join(destinationDir, storedFilename), body);
      store.createArtifact({
        roomId: room.id,
        paneId: pane.id,
        kind: "EXPORT",
        mimeType: "text/plain",
        storageUri:
          `space-artifact://agent-files/${encodeURIComponent(room.id)}/${encodeURIComponent(pane.id)}/` +
          `${encodeURIComponent(session.sessionId)}/${day}/${encodeURIComponent(storedFilename)}`,
        sha256: createHash("sha256").update(body).digest("hex"),
        byteSize: Buffer.byteLength(body),
        metadata: {
          source: "AGENT_OUTPUT",
          originalFilename: storedFilename,
          storedFilename,
          cliSessionId: session.sessionId,
          runtimeId: session.runtimeId,
          previewKind: "TEXT"
        }
      });
    }

    const cleared = await app.inject({
      method: "DELETE",
      url: `/api/rooms/${encodeURIComponent(room.id)}/agent-files`,
      headers: { cookie, [csrfHeaderName]: csrfToken }
    });

    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ matchedCount: 101, deletedCount: 101, failedCount: 0 });
    expect(store.listArtifacts({
      roomId: room.id,
      collection: "AGENT_FILES",
      page: 1,
      pageSize: 100,
      sortOrder: "desc"
    })).toEqual([]);
    await expect(stat(destinationDir)).resolves.toMatchObject({ size: expect.any(Number) });

    await app.close();
  });
});

describe("Agent Files backfill and DOCX preview safety", () => {
  it("copies one provenance-bound source idempotently and verifies hashes without changing the original", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "space-agent-files-backfill-"));
    temporaryRoots.push(artifactRoot);
    const store = new InMemorySpaceStore();
    const { room, pane, session } = createCliFixture(store, "Backfill");
    const day = "2026-07-28";
    const filename = "Complete_Space_Resume.docx";
    const sourceDir = join(
      artifactRoot,
      "cli-uploads",
      safeSegment(room.id),
      safeSegment(pane.id),
      safeSegment(session.sessionId),
      day
    );
    await mkdir(sourceDir, { recursive: true });
    const sourcePath = join(sourceDir, filename);
    const sourceBuffer = Buffer.from([0x50, 0x4b, ...Buffer.from("bounded-docx-fixture")]);
    const normalizedBuffer = Buffer.concat([sourceBuffer, Buffer.from("-word-compatible")]);
    const docxNormalizer: AgentFileDocxNormalizer = async () => normalizedBuffer;
    await writeFile(sourcePath, sourceBuffer);
    const sourceStorageUri =
      `space-artifact://cli-uploads/${encodeURIComponent(room.id)}/${encodeURIComponent(pane.id)}/` +
      `${encodeURIComponent(session.sessionId)}/${day}/${encodeURIComponent(filename)}`;
    const sourceArtifact = store.createArtifact({
      roomId: room.id,
      paneId: pane.id,
      kind: "EXPORT",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      storageUri: sourceStorageUri,
      sha256: createHash("sha256").update(sourceBuffer).digest("hex"),
      byteSize: sourceBuffer.byteLength,
      metadata: { source: "USER_UPLOAD", originalFilename: filename }
    }).artifact;
    for (let index = 0; index < 100; index += 1) {
      const body = `unrelated-${index}`;
      store.createArtifact({
        roomId: room.id,
        paneId: pane.id,
        kind: "EXPORT",
        mimeType: "text/plain",
        storageUri:
          `space-artifact://cli-uploads/${encodeURIComponent(room.id)}/${encodeURIComponent(pane.id)}/` +
          `${encodeURIComponent(session.sessionId)}/${day}/unrelated-${index}.txt`,
        sha256: createHash("sha256").update(body).digest("hex"),
        byteSize: Buffer.byteLength(body),
        metadata: { source: "USER_UPLOAD", originalFilename: `unrelated-${index}.txt` }
      });
    }

    const first = await backfillAgentFile({
      store,
      artifactRoot,
      sourcePath,
      roomId: room.id,
      paneId: pane.id,
      cliSessionId: session.sessionId,
      traceId: "trace:agent-files-backfill",
      docxNormalizer
    });
    const storedUrl = new URL(first.artifact.storageUri);
    const storedSegments = storedUrl.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const storedPath = agentFileStoragePath({
      artifactRoot,
      roomId: storedSegments[0]!,
      paneId: storedSegments[1]!,
      cliSessionId: storedSegments[2]!,
      day: storedSegments[3]!,
      storedFilename: storedSegments[4]!
    });
    await chmod(storedPath, 0o600);
    const second = await backfillAgentFile({
      store,
      artifactRoot,
      sourcePath,
      roomId: room.id,
      paneId: pane.id,
      cliSessionId: session.sessionId,
      traceId: "trace:agent-files-backfill-retry",
      docxNormalizer
    });

    expect(first.alreadyImported).toBe(false);
    expect(second.alreadyImported).toBe(true);
    expect(second.artifact.id).toBe(first.artifact.id);
    expect((await stat(storedPath)).mode & 0o777).toBe(0o644);
    expect(first.artifact.metadata).toMatchObject({
      source: "AGENT_OUTPUT_BACKFILL",
      originalFilename: filename,
      cliSessionId: session.sessionId,
      runtimeId: "cli:codex",
      previewKind: "DOCX",
      wordCompatibility: "LIBREOFFICE_REBUILT",
      agentFileSourceSha256: createHash("sha256").update(sourceBuffer).digest("hex"),
      agentFileSourceByteSize: sourceBuffer.byteLength,
      backfillSourceStorageUri: sourceStorageUri,
      backfillSourceArtifactId: sourceArtifact.id
    });
    expect(await readFile(storedPath)).toEqual(normalizedBuffer);
    expect(await readFile(sourcePath)).toEqual(sourceBuffer);
    expect(store.listArtifacts({
      roomId: room.id,
      collection: "AGENT_FILES",
      page: 1,
      pageSize: 25,
      sortOrder: "desc"
    })).toHaveLength(1);
    expect(store.listAuditEvents().filter((event) => event.action === "agent_file.backfill")).toHaveLength(1);
  });

  it("runs DOCX normalization in an isolated temporary profile and requires a rewritten Office package", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-agent-files-docx-normalizer-"));
    temporaryRoots.push(root);
    const fakeLibreOffice = join(root, "fake-libreoffice.mjs");
    await writeFile(
      fakeLibreOffice,
      `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const outputDirectory = process.argv[process.argv.indexOf("--outdir") + 1];
const sourcePath = process.argv.at(-1);
const source = readFileSync(sourcePath);
writeFileSync(join(outputDirectory, "document.docx"), Buffer.concat([source, Buffer.from("-rebuilt")]));
`
    );
    await chmod(fakeLibreOffice, 0o755);
    const source = Buffer.from([0x50, 0x4b, ...Buffer.from("fixture")]);
    const normalized = await normalizeAgentFileDocx(
      { buffer: source, originalFilename: "fixture.docx" },
      { command: fakeLibreOffice, temporaryRoot: root, timeoutMs: 2_000 }
    );

    expect(normalized).toEqual(Buffer.concat([source, Buffer.from("-rebuilt")]));
    await expect(normalizeAgentFileDocx(
      { buffer: source, originalFilename: "fixture.docx" },
      { command: join(root, "missing-libreoffice"), temporaryRoot: root, timeoutMs: 2_000 }
    )).rejects.toBeInstanceOf(AgentFileDocxNormalizationError);

    const fakeBroker = join(root, "fake-broker.mjs");
    await writeFile(
      fakeBroker,
      `#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = ${JSON.stringify(root)};
const requestDirectory = join(root, readdirSync(root).find((entry) => entry.startsWith("request-")));
const source = readFileSync(join(requestDirectory, "input", "document.docx"));
writeFileSync(join(requestDirectory, "output", "document.docx"), Buffer.concat([source, Buffer.from("-broker")]));
writeFileSync(
  join(requestDirectory, "result.json"),
  JSON.stringify({ contract: "SpaceAgentDocxNormalizationResultV1", ok: true })
);
`
    );
    await chmod(fakeBroker, 0o755);
    const brokerNormalized = await normalizeAgentFileDocx(
      { buffer: source, originalFilename: "fixture.docx" },
      { brokerCommand: fakeBroker, temporaryRoot: root, timeoutMs: 2_000 }
    );
    expect(brokerNormalized).toEqual(Buffer.concat([source, Buffer.from("-broker")]));
  });

  it("sanitizes DOCX HTML and bounds worker failure and timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-agent-files-docx-"));
    temporaryRoots.push(root);
    const inputPath = join(root, "fixture.docx");
    await writeFile(inputPath, Buffer.from([0x50, 0x4b, 0x01]));
    const maliciousWorker = join(root, "malicious-worker.mjs");
    await writeFile(
      maliciousWorker,
      "process.stdout.write('<p onclick=\"steal()\">Safe</p><script>steal()</script><img src=\"javascript:steal()\">')"
    );
    const slowWorker = join(root, "slow-worker.mjs");
    await writeFile(slowWorker, "setTimeout(() => process.stdout.write('<p>late</p>'), 1000)");
    const failingWorker = join(root, "failing-worker.mjs");
    await writeFile(failingWorker, "process.exit(2)");

    const direct = sanitizeAgentFileDocxHtml(
      '<p onclick="steal()">Safe</p><script>steal()</script><img src="javascript:steal()">'
    );
    expect(direct).toContain("<p>Safe</p>");
    expect(direct).not.toContain("onclick");
    expect(direct).not.toContain("<script");
    expect(direct).not.toContain("javascript:");

    const rendered = await renderAgentFileDocxPreview(inputPath, { workerPath: maliciousWorker, timeoutMs: 1_000 });
    expect(rendered).toContain("<p>Safe</p>");
    expect(rendered).not.toContain("onclick");
    expect(rendered).not.toContain("<script");
    expect(rendered).not.toContain("javascript:");
    await expect(renderAgentFileDocxPreview(inputPath, {
      workerPath: slowWorker,
      timeoutMs: 25
    })).rejects.toThrow();
    await expect(renderAgentFileDocxPreview(inputPath, {
      workerPath: failingWorker,
      timeoutMs: 1_000
    })).rejects.toThrow();
  });
});

// Use the full authenticated application so the helper cannot silently be
// bypassed by a route and parser/CSRF/error semantics stay covered together.
describe("staged artifact uploads", () => {
  it.each(["uploads", "file-uploads"])("rejects a malformed batch on %s before creating artifacts", async route => {
    const root = await mkdtemp(join(tmpdir(), "space-staged-route-"));
    temporaryRoots.push(root);
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Staged upload", initialPaneCount: 0 });
    const { app, cookie, csrfToken } = await createTestApp(store, root);
    try {
      const multipart = multipartFiles([{ filename: "image.png", mimeType: "image/png", body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }]);
      const response = await app.inject({ method: "POST", url: `/api/artifacts/${route}?roomId=${encodeURIComponent(room.id)}`,
        headers: { cookie, [csrfHeaderName]: csrfToken, "content-type": multipart.contentType },
        payload: multipart.payload.subarray(0, multipart.payload.length - 12) });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(store.listArtifacts({ roomId: room.id })).toEqual([]);
      expect((await readdir(root)).filter(name => name.startsWith(".incoming"))).toEqual([]);
    } finally { await app.close(); }
  });

  it("rejects a symlinked artifact destination without writing outside the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-staged-route-"));
    const outside = await mkdtemp(join(tmpdir(), "space-staged-outside-"));
    temporaryRoots.push(root, outside);
    await symlink(outside, join(root, "user-uploads"));
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Staged containment", initialPaneCount: 0 });
    const { app, cookie, csrfToken } = await createTestApp(store, root);
    try {
      const multipart = multipartFiles([{ filename: "note.txt", mimeType: "text/plain", body: "hello" }]);
      const response = await app.inject({ method: "POST", url: `/api/artifacts/file-uploads?roomId=${encodeURIComponent(room.id)}`,
        headers: { cookie, [csrfHeaderName]: csrfToken, "content-type": multipart.contentType }, payload: multipart.payload });
      expect(response.statusCode).toBe(403);
      expect(store.listArtifacts({ roomId: room.id })).toEqual([]);
      expect(await readdir(outside)).toEqual([]);
    } finally { await app.close(); }
  });

  it("retains uncertain artifact writes for reconciliation and cleans staging", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-staged-route-"));
    temporaryRoots.push(root);
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Staged DB failure", initialPaneCount: 0 });
    const { app, cookie, csrfToken } = await createTestApp(store, root);
    const failedWrite = vi.spyOn(store, "createArtifact").mockImplementation(() => { throw new Error("DB unavailable"); });
    try {
      const multipart = multipartFiles([{ filename: "note.txt", mimeType: "text/plain", body: "hello" }]);
      const response = await app.inject({ method: "POST", url: `/api/artifacts/file-uploads?roomId=${encodeURIComponent(room.id)}`,
        headers: { cookie, [csrfHeaderName]: csrfToken, "content-type": multipart.contentType }, payload: multipart.payload });
      expect(response.statusCode).toBe(503);
      const entries = await readdir(root, { recursive: true, withFileTypes: true });
      const marker = entries.find(entry => entry.name.startsWith(".upload-record-"))!;
      expect(entries.filter(entry => entry.isFile())).toHaveLength(2);
      expect(await inspectUploadRecord(root, join(marker.parentPath, marker.name), uri => store.listArtifacts().filter(artifact => artifact.storageUri === uri))).toMatchObject({
        status: "AWAITING_CONFIRMATION", fileValid: true, artifactIds: []
      });
      expect(entries.filter(entry => entry.name.startsWith(".incoming"))).toEqual([]);
    } finally { failedWrite.mockRestore(); await app.close(); }
  });

  it.each(["generic", "agent-files"])("preserves a committed %s upload when the artifact acknowledgement is lost", async kind => {
    const root = await mkdtemp(join(tmpdir(), "space-staged-ack-"));
    temporaryRoots.push(root);
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Lost upload acknowledgement", initialPaneCount: 0 });
    const { app, cookie, csrfToken } = await createTestApp(store, root);
    const create = store.createArtifact.bind(store);
    const failedAck = vi.spyOn(store, "createArtifact").mockImplementation((...args) => {
      create(...args);
      throw new Error("Connection lost after COMMIT");
    });
    try {
      const multipart = multipartFiles([{ filename: "note.txt", mimeType: "text/plain", body: "keep this file" }]);
      const url = kind === "generic" ? `/api/artifacts/file-uploads?roomId=${encodeURIComponent(room.id)}` : `/api/rooms/${encodeURIComponent(room.id)}/agent-files/uploads`;
      const response = await app.inject({ method: "POST", url,
        headers: { cookie, [csrfHeaderName]: csrfToken, "content-type": multipart.contentType }, payload: multipart.payload });
      const [artifact] = store.listArtifacts({ roomId: room.id });
      expect(artifact).toBeDefined();
      const download = await app.inject({ method: "GET", url: `/api/artifacts/${encodeURIComponent(artifact!.id)}/file`, headers: { cookie } });
      expect(download.statusCode).toBe(200);
      expect(download.body).toBe("keep this file");
      expect(response.statusCode).toBe(503);
      expect(failedAck).toHaveBeenCalledTimes(1);
      const entries = await readdir(root, { recursive: true, withFileTypes: true });
      const marker = entries.find(entry => entry.name.startsWith(".upload-record-"))!;
      expect(await inspectUploadRecord(root, join(marker.parentPath, marker.name), uri => store.listArtifacts().filter(artifact => artifact.storageUri === uri))).toMatchObject({
        status: "CONFIRMED", fileValid: true, artifactIds: [artifact!.id]
      });
    } finally { failedAck.mockRestore(); await app.close(); }
  });
});
