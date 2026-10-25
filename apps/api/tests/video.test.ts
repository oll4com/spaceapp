// The Video pane's backend (plan clipboard:-HpLbbtWKj53): operator routes (settings, view, sources, library, requests), the agent
// bridge (any CLI pane asks, only the Video pane's CLI works), engine jobs with a fake engine (probe, assemble into pinned Media
// outputs with poster frames), delivery AUTO and under approval, the Marketing callback and the VIDEO notifications.
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore, SpaceEventBus } from "@space/runtime";
import type { Event } from "@space/contracts";
import { createApp } from "../src/app.js";
import { cliBrowserBridgeTokenHeader, issueCliBrowserBridgeToken } from "../src/cli-browser-bridge.js";
import { getApiConfig } from "../src/config.js";
import { createVideoEngine, type VideoEngineJob } from "../src/video/engine.js";
import { sniffVideoMime } from "../src/video/service.js";
import { pngOf } from "./fixtures/design-png.js";

vi.setConfig({ testTimeout: 30_000 });
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const mp4Bytes = (size = 64) => { const bytes = Buffer.alloc(size); bytes.write("ftypisom", 4, "ascii"); return bytes; };
const wavBytes = () => { const bytes = Buffer.alloc(64); bytes.write("RIFF", 0, "ascii"); bytes.write("WAVE", 8, "ascii"); return bytes; };
const boundary = "----video-test";
const multipart = (fields: Record<string, string>, filename: string, bytes: Buffer, type = "application/octet-stream") => Buffer.concat([
  ...Object.entries(fields).map(([name, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)),
  Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)
]);

/** A fake engine: writes the files a real one would and answers like it. */
function fakeEngine() {
  const jobs: VideoEngineJob[] = [];
  const engine = async (job: VideoEngineJob, onProgress?: (progress: { progress: number; message: string }) => void) => {
    jobs.push(job);
    onProgress?.({ progress: 50, message: `${job.op} half way` });
    if (job.op === "probe") return { durationSec: 12, width: 640, height: 360, fps: 25, hasAudio: true, videoCodec: "h264", audioCodec: "aac", byteSize: 256 };
    if (job.op === "proxy") {
      await writeFile(join(job.workDir, "contact.png"), pngOf(320, 200));
      return { proxyPath: join(job.workDir, "proxy.mp4"), contactPath: join(job.workDir, "contact.png"), frameDir: join(job.workDir, "frames"), frameCount: 6, frameEverySec: 2 };
    }
    if (job.op === "transcribe") {
      await writeFile(join(job.workDir, "transcript.txt"), "hello space");
      return { wordsPath: join(job.workDir, "words.json"), transcriptPath: join(job.workDir, "transcript.txt"), language: "en", durationSec: 12, wordCount: 2 };
    }
    if (job.op === "fetch") { await writeFile(join(job.workDir, "source-abc.mp4"), mp4Bytes(256)); return { path: join(job.workDir, "source-abc.mp4"), durationSec: 300, width: 3840, height: 2160 }; }
    if (job.op === "tts") { await writeFile(join(job.workDir, "narration.wav"), wavBytes()); return { path: join(job.workDir, "narration.wav"), durationSec: 2.5 }; }
    if (job.op === "music_fetch") { await writeFile(join(job.workDir, "music.mp3"), Buffer.concat([Buffer.from("ID3"), Buffer.alloc(61)])); return { path: join(job.workDir, "music.mp3"), durationSec: 180 }; }
    if (job.op === "music_search") return { results: [{ id: "1", title: "Calm", artist: "Ann", url: "https://ccmixter.org/x.mp3", license: "CC BY", attribution: "Calm by Ann (ccMixter, CC BY)" }] };
    if (job.op === "assemble") {
      const outputs = [];
      for (const output of job.outputs as Array<{ formatId: string; width: number; height: number; maxDurationSec: number | null }>) {
        const path = join(job.workDir, `out-${output.formatId}.mp4`);
        const thumbnailPath = join(job.workDir, `thumb-${output.formatId}.png`);
        await writeFile(path, mp4Bytes(128));
        await writeFile(thumbnailPath, pngOf(output.width / 10, output.height / 10));
        outputs.push({ formatId: output.formatId, path, width: output.width, height: output.height, durationSec: Math.min(8, output.maxDurationSec ?? 8), sha256: "x", thumbnailPath });
      }
      return { outputs };
    }
    return { ok: true };
  };
  return { engine, jobs };
}

async function fixture(options: { kickoff?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "space-video-routes-"));
  roots.push(root);
  const config = getApiConfig({ SPACE_ARTIFACT_ROOT: root, SPACE_VIDEO_WORK_ROOT: join(root, "video-work"), SPACE_VIDEO_TOOLS_DIR: join(root, "tools"), SPACE_LOG_LEVEL: "silent" });
  const store = new InMemorySpaceStore();
  const eventBus = new SpaceEventBus();
  const roomEvents: Event[] = [];
  eventBus.subscribe((event) => { if (event.type === "VIDEO_UPDATED" || event.type === "ARTIFACT_CREATED") roomEvents.push(event); });
  const fake = fakeEngine();
  const kickoffs: string[] = [];
  const app = await createApp({ store, config, eventBus, jobApplyMailTriage: false, marketingCopilotScheduler: false, videoEngine: fake.engine,
    videoKickoff: options.kickoff === false ? undefined : async (pane) => { kickoffs.push(pane.id); },
    auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false } });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
  const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
  const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
  const headers = { cookie, "x-space-csrf-token": csrf.json().csrfToken as string };
  const room = (await app.inject({ method: "POST", url: "/api/rooms", headers, payload: { name: "Video", initialPaneCount: 0 } })).json();
  const pane = store.createPane({ roomId: room.id, title: "Video", mode: "VIDEO", terminalRuntimeId: "cli:claude" });
  const uploadSource = async (name = "clip.mp4") => {
    const response = await app.inject({ method: "POST", url: `/api/panes/${encodeURIComponent(pane.id)}/video/sources`, headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipart({ label: "Launch clip" }, name, mp4Bytes(256), "video/mp4") });
    expect(response.statusCode).toBe(200);
    return response.json().asset as { id: string; artifactId: string; kind: string; mimeType: string };
  };
  return { app, store, room, pane, headers, roomEvents, fake, kickoffs, uploadSource, url: `/api/panes/${encodeURIComponent(pane.id)}/video` };
}

describe("Video pane routes", () => {
  it("keeps the pane's settings and view, lists the formats and answers 409 on other panes", async () => {
    const { app, store, room, headers, url } = await fixture();
    try {
      const settings = await app.inject({ method: "GET", url: `${url}/settings`, headers });
      expect(settings.json().metadata.settings).toMatchObject({ defaultFormatIds: ["youtube-short"], technique: "highlights", requestAutonomy: "AUTO", captions: "karaoke" });
      const updated = await app.inject({ method: "PUT", url: `${url}/settings`, headers, payload: { version: 1, settings: { requestAutonomy: "APPROVAL", defaultFormatIds: ["x", "square"], technique: "silence" } } });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().metadata.settings).toMatchObject({ requestAutonomy: "APPROVAL", defaultFormatIds: ["x", "square"], technique: "silence", paused: false });
      expect((await app.inject({ method: "PUT", url: `${url}/settings`, headers, payload: { version: 1, settings: { defaultFormatIds: ["yt-thumb"] } } })).statusCode).toBe(422);
      expect((await app.inject({ method: "PUT", url: `${url}/settings`, headers, payload: { version: 1, settings: { canvas: true } } })).statusCode).toBe(422);
      const view = await app.inject({ method: "PUT", url: `${url}/view`, headers, payload: { tab: "MUSIC" } });
      expect(view.json().view).toMatchObject({ tab: "MUSIC", requestId: null, assetId: null, sourceArtifactId: null });
      const browser = store.createPane({ roomId: room.id, title: "Browser", mode: "BROWSER" });
      expect((await app.inject({ method: "GET", url: `/api/panes/${encodeURIComponent(browser.id)}/video/settings`, headers })).statusCode).toBe(409);
      expect((await app.inject({ method: "GET", url: `${url}/settings` })).statusCode).toBe(401);
      const formats = (await app.inject({ method: "GET", url: "/api/video/formats", headers })).json().formats as Array<{ id: string; networkLabel: string }>;
      expect(formats).toContainEqual(expect.objectContaining({ id: "youtube-short", networkLabel: "YouTube", maxDurationSec: 180 }));
      expect(formats.some((format) => format.id === "yt-thumb")).toBe(false);
      expect((await app.inject({ method: "GET", url: "/api/video/tools", headers })).json().tools).toMatchObject({ ok: false });
    } finally { await app.close(); }
  });

  it("stores uploaded sources as Media typed by their bytes, runs engine jobs and saves assembled outputs as pinned Media with poster frames", async () => {
    const { app, store, pane, headers, roomEvents, fake, uploadSource, url } = await fixture();
    try {
      const source = await uploadSource();
      expect(source).toMatchObject({ kind: "UPLOAD", mimeType: "video/mp4", durationSec: 12, width: 640, height: 360 });
      expect(store.getArtifact(source.artifactId)).toMatchObject({ kind: "VIDEO", roomId: pane.roomId, paneId: pane.id, pinnedAt: null, expiresAt: null });
      // The source was probed on its way in (a short job run to its end).
      expect(fake.jobs.map((job) => job.op)).toEqual(["probe"]);
      expect(fake.jobs[0]!.workDir).toContain("video-work");
      expect((await app.inject({ method: "POST", url: `${url}/sources`, headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: multipart({}, "x.svg", Buffer.from("<svg/>")) })).statusCode).toBe(409);

      // The operator's own request from the Studio, then the agent-facing jobs through the service (the bridge test covers the routes).
      const created = await app.inject({ method: "POST", url: `${url}/requests`, headers, payload: { brief: "A reel of the launch", sources: [{ artifactId: source.artifactId }], formatIds: ["youtube-short", "square"] } });
      expect(created.statusCode).toBe(200);
      expect(created.json().request).toMatchObject({ requester: { kind: "OPERATOR", label: "You" }, status: "QUEUED", videoPaneId: pane.id, sources: [{ artifactId: source.artifactId }] });
      expect((await app.inject({ method: "POST", url: `${url}/requests`, headers, payload: { brief: "x", sources: [{ artifactId: "artifact:notmine1" }] } })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: `${url}/requests`, headers, payload: { brief: "x", sources: [{ url: "https://example.com/v" }] } })).statusCode).toBe(422);
      expect(roomEvents.some((event) => event.type === "ARTIFACT_CREATED")).toBe(true);
      expect(roomEvents.some((event) => event.type === "VIDEO_UPDATED" && event.paneId === pane.id)).toBe(true);

      // A track from the operator's library joins as MUSIC with its credits, pinned; the Music tab lists it by kind.
      const track = await app.inject({ method: "POST", url: `${url}/music`, headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: multipart({ label: "Calm", credits: "Calm by Ann (CC BY)" }, "calm.wav", wavBytes(), "audio/wav") });
      expect(track.statusCode).toBe(200);
      expect(track.json().asset).toMatchObject({ kind: "MUSIC", mimeType: "audio/wav", label: "Calm", credits: "Calm by Ann (CC BY)", pinned: true });
      expect(store.getArtifact(track.json().asset.artifactId)).toMatchObject({ kind: "AUDIO" });
      expect((await app.inject({ method: "GET", url: `${url}/assets?kind=MUSIC`, headers })).json().assets.map((asset: { id: string }) => asset.id)).toEqual([track.json().asset.id]);
      const music = await app.inject({ method: "POST", url: `${url}/music/search`, headers, payload: { query: "calm piano" } });
      expect(music.json().results[0]).toMatchObject({ attribution: "Calm by Ann (ccMixter, CC BY)" });
      expect(fake.jobs.at(-1)).toMatchObject({ op: "music_search", query: "calm piano", limit: 20 });
      expect((await app.inject({ method: "GET", url: `${url}/jobs/vjob:nope12345`, headers })).statusCode).toBe(404);
      expect(sniffVideoMime(wavBytes())).toBe("audio/wav");
      expect(sniffVideoMime(Buffer.from("<svg/>"))).toBeNull();
    } finally { await app.close(); }
  });
});

describe("YouTube pane Download", () => {
  it("downloads the video on screen into the chosen Agent Files folder at the chosen resolution, lists it in the Video library and notifies", async () => {
    const { app, store, room, headers, fake, url } = await fixture();
    try {
      const youtube = store.createPane({ roomId: room.id, title: "Bob", mode: "YOUTUBE" });
      const download = `/api/panes/${encodeURIComponent(youtube.id)}/youtube/download`;
      expect((await app.inject({ method: "POST", url: download, headers, payload: { videoId: "dQw4w9WgXcQ" } })).statusCode).toBe(422);
      expect((await app.inject({ method: "POST", url: download, headers, payload: { videoId: "../etc", rightsConfirmed: true } })).statusCode).toBe(422);
      expect((await app.inject({ method: "POST", url: `${url.replace("/video", "")}/youtube/download`, headers, payload: { videoId: "dQw4w9WgXcQ", rightsConfirmed: true } })).statusCode).toBe(409);
      const run = async (title: string) => {
        const started = await app.inject({ method: "POST", url: download, headers, payload: { videoId: "dQw4w9WgXcQ", title, rightsConfirmed: true } });
        expect(started.statusCode).toBe(200);
        let job = started.json().job as { id: string; status: string; result: { asset: { id: string; artifactId: string }; folder: string | null } | null };
        for (let i = 0; i < 50 && job.status !== "DONE" && job.status !== "FAILED"; i += 1) job = (await app.inject({ method: "GET", url: `${download}/${encodeURIComponent(job.id)}`, headers })).json().job;
        expect(job.status).toBe("DONE");
        return job.result!;
      };

      // Defaults: the best YouTube has, into Agent Files › Media / YouTube.
      const first = await run("Oday Hacks");
      expect(fake.jobs.at(-1)).toMatchObject({ op: "fetch", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", maxHeight: 0 });
      expect(first.folder).toBe("MEDIA/YouTube");
      expect(first.asset).toMatchObject({ kind: "UPLOAD", label: "Oday Hacks", width: 3840, height: 2160, durationSec: 300, madeBy: { by: "OPERATOR" } });
      const filed = store.getArtifact(first.asset.artifactId);
      expect(filed).toMatchObject({ kind: "VIDEO", roomId: room.id, paneId: youtube.id, metadata: expect.objectContaining({ folder: "MEDIA/YouTube", originalFilename: "Oday Hacks.mp4", source: "USER_UPLOAD" }) });
      expect(filed.storageUri.startsWith("space-artifact://agent-files/")).toBe(true);
      expect((await app.inject({ method: "GET", url: `${url}/assets?kind=UPLOAD`, headers })).json().assets.map((asset: { id: string }) => asset.id)).toContain(first.asset.id);
      const notices = (await app.inject({ method: "GET", url: "/api/notifications", headers })).json() as { data?: unknown[]; notifications?: unknown[] };
      expect(JSON.stringify(notices)).toContain("Downloaded: Oday Hacks");
      expect(JSON.stringify(notices)).toContain("Agent Files › Media / YouTube");

      // Settings → YouTube: another folder and 1080p; an unsafe folder is refused.
      expect((await app.inject({ method: "PATCH", url: "/api/user-settings", headers, payload: { youtubeDownload: { folder: "../etc", maxHeight: 1080 } } })).statusCode).toBe(422);
      expect((await app.inject({ method: "PATCH", url: "/api/user-settings", headers, payload: { youtubeDownload: { folder: "MEDIA/YouTube", maxHeight: 999 } } })).statusCode).toBe(422);
      expect((await app.inject({ method: "PATCH", url: "/api/user-settings", headers, payload: { youtubeDownload: { folder: "Clips/Talks", maxHeight: 1080 } } })).statusCode).toBe(200);
      const second = await run("Talk");
      expect(fake.jobs.at(-1)).toMatchObject({ op: "fetch", maxHeight: 1080 });
      expect(store.getArtifact(second.asset.artifactId).metadata).toMatchObject({ folder: "Clips/Talks" });

      // Removing it from the Video library leaves the Agent File where the operator filed it.
      expect((await app.inject({ method: "DELETE", url: `${url}/assets/${encodeURIComponent(second.asset.id)}`, headers })).statusCode).toBe(200);
      expect(store.getArtifact(second.asset.artifactId)).toMatchObject({ expiresAt: null, deletedAt: null });
      // The Studio's Delete of a download does the same: out of the library, the Agent File stays.
      expect((await app.inject({ method: "DELETE", url: `${url}/files/${encodeURIComponent(first.asset.artifactId)}`, headers })).json()).toEqual({ deleted: true, removedAssets: 1, keptInAgentFiles: true });
      expect(store.getArtifact(first.asset.artifactId)).toMatchObject({ expiresAt: null, deletedAt: null });
      expect((await app.inject({ method: "GET", url: `${url}/assets?kind=UPLOAD`, headers })).json().assets.map((asset: { id: string }) => asset.id)).not.toContain(first.asset.id);
    } finally { await app.close(); }
  });
});

describe("Video agent bridge", () => {
  it("lets any CLI pane request a video, keeps worker tools to the Video pane, runs jobs and delivers assembled outputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-video-bridge-"));
    roots.push(root);
    const wrapper = join(root, "codex-vscode-parity");
    await writeFile(wrapper, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(wrapper, 0o755);
    const config = getApiConfig({
      SPACE_CLI_ENABLED: "true", SPACE_CLI_COMMAND_PATH: root, SPACE_CLI_HOST_SOCKET: join(root, "pane-host.sock"), SPACE_CLI_CODEX_CREDENTIAL_SMOKE: "true",
      SPACE_CLI_WORKSPACE_ROOT: join(root, "workspaces"), SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true", SPACE_INTERNAL_API_TOKEN: "internal-token-for-video-bridge-tests", SPACE_ARTIFACT_ROOT: root,
      SPACE_VIDEO_WORK_ROOT: join(root, "video-work"), SPACE_VIDEO_TOOLS_DIR: join(root, "tools"), SPACE_LOG_LEVEL: "silent"
    });
    const store = new InMemorySpaceStore();
    const kickoffs: string[] = [];
    const fake = fakeEngine();
    const app = await createApp({ store, config, jobApplyMailTriage: false, marketingCopilotScheduler: false, videoKickoff: async (pane) => { kickoffs.push(pane.id); }, videoEngine: fake.engine,
      auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false } });
    try {
      const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
      const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
      const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
      const headers = { cookie, "x-space-csrf-token": csrf.json().csrfToken as string };
      const room = (await app.inject({ method: "POST", url: "/api/rooms", headers, payload: { name: "Work", initialPaneCount: 0 } })).json();
      const tokenFor = (paneId: string, roomId: string = room.id) => {
        const session = store.createPaneCliSession({ paneId, roomId, runtimeId: "cli:codex", providerId: "codex", agentId: "codex", status: "RUNNING", purpose: "NORMAL" });
        return { [cliBrowserBridgeTokenHeader]: issueCliBrowserBridgeToken(config, { roomId, paneId, cliSessionId: session.sessionId })! };
      };
      const shell = store.createPane({ roomId: room.id, title: "Codex CLI", mode: "TERMINAL", terminalRuntimeId: "cli:codex" });
      const video = store.createPane({ roomId: room.id, title: "Video", mode: "VIDEO", terminalRuntimeId: "cli:codex" });
      const requester = { ...tokenFor(shell.id), "content-type": "application/json" };
      const videoToken = tokenFor(video.id);
      const worker = { ...videoToken, "content-type": "application/json" };
      const cli = "/api/cli/video";
      // A source the operator uploaded in the Studio (any Media video of the owner's rooms works).
      const uploaded = await app.inject({ method: "POST", url: `/api/panes/${encodeURIComponent(video.id)}/video/sources`, headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: multipart({ label: "Launch" }, "launch.mp4", mp4Bytes(256), "video/mp4") });
      const source = uploaded.json().asset as { artifactId: string };

      expect((await app.inject({ method: "GET", url: `${cli}/formats` })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: `${cli}/formats`, headers: requester })).json().techniques).toEqual(["silence", "scene", "highlights", "manual"]);
      const created = (await app.inject({ method: "POST", url: `${cli}/requests`, headers: requester, payload: { brief: "A reel of the launch", sources: [{ artifactId: source.artifactId }], formatIds: ["youtube-short"],
        options: { technique: "silence", narration: { text: "Welcome", language: "en" } } } })).json();
      expect(created).toMatchObject({ videoPaneId: video.id, runStarted: true, request: { requester: { kind: "PANE", paneId: shell.id, label: expect.stringContaining("Codex CLI") } } });
      expect(kickoffs).toEqual([video.id]);
      expect((await app.inject({ method: "POST", url: `${cli}/next`, headers: requester, payload: {} })).statusCode).toBe(409);

      const next = (await app.inject({ method: "POST", url: `${cli}/next`, headers: worker, payload: {} })).json();
      expect(next).toMatchObject({ done: false, request: { id: created.request.id }, formats: [{ id: "youtube-short", width: 1080, height: 1920, maxDurationSec: 180 }],
        sources: [{ index: 0, artifactId: source.artifactId, kind: "VIDEO" }], options: { technique: "silence", narration: { text: "Welcome", language: "en", engine: "kokoro" } } });

      // Engine jobs answer at once; the agent waits for them.
      const probe = (await app.inject({ method: "POST", url: `${cli}/probe`, headers: worker, payload: { requestId: created.request.id } })).json().job;
      expect(probe).toMatchObject({ op: "probe", paneId: video.id });
      const probed = (await app.inject({ method: "POST", url: `${cli}/jobs/${encodeURIComponent(probe.id)}/wait`, headers: worker, payload: { waitMs: 5000 } })).json().job;
      expect(probed).toMatchObject({ status: "DONE", progress: 100, result: { durationSec: 12, frameCount: 6, contactPath: expect.stringContaining("contact.png") } });
      expect(fake.jobs.filter((job) => job.op === "probe" || job.op === "proxy").map((job) => job.op)).toEqual(["probe", "probe", "proxy"]);
      expect(fake.jobs.find((job) => job.op === "proxy")).toMatchObject({ sources: [{ path: expect.stringContaining(root) }], sourceIndex: 0 });
      const transcribe = (await app.inject({ method: "POST", url: `${cli}/transcribe`, headers: worker, payload: { requestId: created.request.id } })).json().job;
      const transcribed = (await app.inject({ method: "POST", url: `${cli}/jobs/${encodeURIComponent(transcribe.id)}/wait`, headers: worker, payload: { waitMs: 5000 } })).json().job;
      expect(transcribed.result).toMatchObject({ text: "hello space", wordCount: 2 });
      // A job's result stays readable; an unknown job is 404; the request moved to IN_PROGRESS.
      expect((await app.inject({ method: "GET", url: `${cli}/jobs/${encodeURIComponent(transcribe.id)}`, headers: worker })).json().job.status).toBe("DONE");
      expect((await app.inject({ method: "GET", url: `${cli}/jobs/vjob:nope12345`, headers: worker })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: `${cli}/requests/${encodeURIComponent(created.request.id)}`, headers: requester })).json().request.status).toBe("IN_PROGRESS");

      // Assembling needs what the video shows and the model; the outputs become pinned Media with their poster frames and the timeline.
      const timeline = { version: 1, clips: [{ sourceIndex: 0, inSec: 1, outSec: 9 }], captions: { style: "karaoke" }, narration: { segments: [{ atSec: 0, text: "Welcome" }] }, outputs: [{ formatId: "youtube-short" }, { formatId: "square" }] };
      expect((await app.inject({ method: "POST", url: `${cli}/assemble`, headers: worker, payload: { requestId: created.request.id, timeline, description: "The launch in 8 s" } })).statusCode).toBe(422);
      // A clip of a source that does not exist fails the job in its build step and frees the owner's slot.
      const badJob = (await app.inject({ method: "POST", url: `${cli}/assemble`, headers: worker, payload: { requestId: created.request.id, timeline: { ...timeline, clips: [{ sourceIndex: 3, inSec: 0, outSec: 1 }] }, description: "x", madeByModel: "m" } })).json().job;
      const bad = (await app.inject({ method: "POST", url: `${cli}/jobs/${encodeURIComponent(badJob.id)}/wait`, headers: worker, payload: { waitMs: 5000 } })).json().job;
      expect(bad).toMatchObject({ status: "FAILED", error: expect.stringContaining("Clip source 3") });
      const assemble = (await app.inject({ method: "POST", url: `${cli}/assemble`, headers: worker, payload: { requestId: created.request.id, timeline, wordsPath: transcribed.result.wordsPath, description: "The launch in 8 s, karaoke captions", madeByModel: "claude-opus-5-5" } }));
      expect(assemble.statusCode).toBe(200);
      const assembled = (await app.inject({ method: "POST", url: `${cli}/jobs/${encodeURIComponent(assemble.json().job.id)}/wait`, headers: worker, payload: { waitMs: 10000 } })).json().job;
      expect(assembled.status).toBe("DONE");
      const assets = assembled.result.assets as Array<{ id: string; artifactId: string; thumbnailArtifactId: string; formatId: string; width: number; height: number; durationSec: number; kind: string; description: string; madeBy: unknown; timeline: unknown }>;
      expect(assets.map((asset) => [asset.formatId, asset.width, asset.height, asset.kind])).toEqual([["youtube-short", 1080, 1920, "OUTPUT"], ["square", 1080, 1080, "OUTPUT"]]);
      expect(assets[0]).toMatchObject({ description: "The launch in 8 s, karaoke captions [YouTube Short, 8 s]", madeBy: { by: "AGENT", runtimeId: "cli:codex", model: "claude-opus-5-5" }, durationSec: 8, timeline: { clips: [{ inSec: 1, outSec: 9, speed: 1 }] } });
      expect(store.getArtifact(assets[0]!.artifactId)).toMatchObject({ kind: "VIDEO", roomId: room.id, expiresAt: null });
      expect(store.getArtifact(assets[0]!.thumbnailArtifactId)).toMatchObject({ kind: "IMAGE", roomId: room.id });
      expect(store.getArtifact(assets[0]!.artifactId).pinnedAt).not.toBeNull();
      // The engine got the narration spoken first, the words and the formats' limits.
      const assembleJob = fake.jobs.find((job) => job.op === "assemble")!;
      expect(assembleJob).toMatchObject({ wordsPath: transcribed.result.wordsPath, outputs: [{ formatId: "youtube-short", maxDurationSec: 180, safeArea: { top: 200 } }, { formatId: "square", maxDurationSec: 60 }] });
      expect((assembleJob.timeline as { narration: { path: string } }).narration.path).toContain("narration.wav");
      // Only the engine's own keys: no version, outputs or artifact ids (the first real cut on 2026-10-21 failed on timeline.version).
      expect(Object.keys(assembleJob.timeline as object).sort()).toEqual(["captions", "clips", "filter", "music", "narration", "overlays", "reframe", "transition", "transitionSec"]);
      expect((assembleJob.timeline as { narration: Record<string, unknown> }).narration).toEqual({ path: expect.stringContaining("narration.wav"), volumeDb: 0 });

      // Delivery under AUTO reaches the requester with every output's details; the output file streams to the requester.
      const delivered = (await app.inject({ method: "POST", url: `${cli}/deliver`, headers: worker, payload: { requestId: created.request.id, assetIds: assets.map((asset) => asset.id), message: "Two cuts" } })).json();
      expect(delivered.request.status).toBe("DELIVERED");
      const waited = (await app.inject({ method: "POST", url: `${cli}/requests/${encodeURIComponent(created.request.id)}/wait`, headers: requester, payload: { waitMs: 0 } })).json();
      expect(waited.assets).toEqual(expect.arrayContaining([expect.objectContaining({ assetId: assets[0]!.id, thumbnailArtifactId: assets[0]!.thumbnailArtifactId, durationSec: 8, description: expect.stringContaining("karaoke captions"), replacedBy: null })]));
      const file = await app.inject({ method: "GET", url: `${cli}/assets/${encodeURIComponent(assets[0]!.id)}/file`, headers: requester });
      expect(file.statusCode).toBe(200);
      expect(file.headers["content-type"]).toContain("video/mp4");
      expect(file.rawPayload.subarray(4, 8).toString("ascii")).toBe("ftyp");
      // Another pane's delivered assets are not a requester's to read.
      const other = store.createPane({ roomId: room.id, title: "Other", mode: "TERMINAL", terminalRuntimeId: "cli:codex" });
      expect((await app.inject({ method: "GET", url: `${cli}/assets/${encodeURIComponent(assets[0]!.id)}/file`, headers: tokenFor(other.id) })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: `${cli}/next`, headers: worker, payload: {} })).json()).toMatchObject({ done: true });

      // A file the agent made in the pane joins the library, typed by its bytes.
      const upload = await app.inject({ method: "POST", url: `${cli}/assets`, headers: { ...videoToken, "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: multipart({ label: "Title card", description: "Title card: SpaceApp 0.3", madeByModel: "claude-opus-5-5" }, "title.mp4", mp4Bytes()) });
      expect(upload.statusCode).toBe(200);
      expect(upload.json().asset).toMatchObject({ kind: "UPLOAD", mimeType: "video/mp4", description: "Title card: SpaceApp 0.3", madeBy: { by: "AGENT", runtimeId: "cli:codex", model: "claude-opus-5-5" } });
      expect((await app.inject({ method: "POST", url: `${cli}/assets`, headers: { ...videoToken, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: multipart({ madeByModel: "m" }, "t.mp4", mp4Bytes()) })).statusCode).toBe(422);
      expect((await app.inject({ method: "GET", url: `${cli}/assets?kind=OUTPUT`, headers: worker })).json().assets).toHaveLength(2);
      expect((await app.inject({ method: "GET", url: `${cli}/assets?kind=UPLOAD`, headers: worker })).json().assets.map((asset: { label: string }) => asset.label)).toEqual(["Title card", "Launch"]);

      // The Studio's Save to Agent Files copies an output on the server into Agent Files › Media / Video, named by when it was made;
      // a file that already is an Agent File stays put. Delete takes the output's library entry, its poster and its Media file for good.
      const files = `/api/panes/${encodeURIComponent(video.id)}/video/files`;
      const saved = (await app.inject({ method: "POST", url: `${files}/${encodeURIComponent(assets[0]!.artifactId)}/agent-file`, headers, payload: {} })).json();
      expect(saved).toMatchObject({ folder: "MEDIA/Video", alreadyThere: false,
        artifact: { kind: "VIDEO", roomId: room.id, metadata: expect.objectContaining({ folder: "MEDIA/Video", originalFilename: expect.stringMatching(/^video-youtube-short-\d{8}-\d{4}\.mp4$/) }) } });
      expect(saved.artifact.storageUri.startsWith("space-artifact://agent-files/")).toBe(true);
      expect((await app.inject({ method: "POST", url: `${files}/${encodeURIComponent(saved.artifact.id)}/agent-file`, headers, payload: {} })).json()).toMatchObject({ alreadyThere: true, artifact: { id: saved.artifact.id } });
      expect((await app.inject({ method: "POST", url: `${files}/artifact:notmine1/agent-file`, headers, payload: {} })).statusCode).toBe(404);
      expect((await app.inject({ method: "DELETE", url: `${files}/${encodeURIComponent(assets[0]!.artifactId)}`, headers })).json()).toEqual({ deleted: true, removedAssets: 1, keptInAgentFiles: false });
      expect(() => store.getArtifact(assets[0]!.artifactId)).toThrow();
      expect(() => store.getArtifact(assets[0]!.thumbnailArtifactId)).toThrow();
      expect(store.getArtifact(saved.artifact.id)).toMatchObject({ deletedAt: null });
      expect((await app.inject({ method: "GET", url: `${cli}/assets?kind=OUTPUT`, headers: worker })).json().assets.map((asset: { id: string }) => asset.id)).toEqual([assets[1]!.id]);
      expect((await app.inject({ method: "DELETE", url: `${files}/${encodeURIComponent(assets[0]!.artifactId)}`, headers })).statusCode).toBe(404);
      expect((await app.inject({ method: "DELETE", url: `${files}/${encodeURIComponent(assets[1]!.artifactId)}` })).statusCode).toBe(401);

      // The rest of the worker tools on a second request: fetch a URL source, analyze, narration, music, a question, then fail.
      const second = (await app.inject({ method: "POST", url: `${cli}/requests`, headers: requester, payload: { brief: "Cut the talk", sources: [{ url: "https://example.org/talk.webm", rightsConfirmed: true }], formatIds: ["x"] } })).json();
      expect((await app.inject({ method: "POST", url: `${cli}/next`, headers: worker, payload: {} })).json()).toMatchObject({ request: { id: second.request.id } });
      const waitJob = async (job: { id: string }) => (await app.inject({ method: "POST", url: `${cli}/jobs/${encodeURIComponent(job.id)}/wait`, headers: worker, payload: { waitMs: 5000 } })).json().job;
      const fetched = await waitJob((await app.inject({ method: "POST", url: `${cli}/fetch`, headers: worker, payload: { requestId: second.request.id, sourceIndex: 0, madeByModel: "m" } })).json().job);
      expect(fetched).toMatchObject({ status: "DONE", result: { sources: [{ artifactId: fetched.result.artifactId }] } });
      expect(fake.jobs.at(-1)).toMatchObject({ op: "fetch", url: "https://example.org/talk.webm" });
      expect(await waitJob((await app.inject({ method: "POST", url: `${cli}/analyze`, headers: worker, payload: { requestId: second.request.id, technique: "silence", silenceDb: -35 } })).json().job)).toMatchObject({ status: "DONE" });
      expect(fake.jobs.at(-1)).toMatchObject({ op: "analyze", technique: "silence", silenceDb: -35 });
      const spoken = await waitJob((await app.inject({ method: "POST", url: `${cli}/tts`, headers: worker, payload: { text: "Hello", language: "en", requestId: second.request.id, madeByModel: "m" } })).json().job);
      expect(spoken.result.asset).toMatchObject({ kind: "NARRATION", mimeType: "audio/wav", description: "Hello" });
      const found = (await app.inject({ method: "POST", url: `${cli}/music/search`, headers: worker, payload: { query: "calm" } })).json();
      expect(found.results[0]).toMatchObject({ license: "CC BY" });
      const track = (await app.inject({ method: "POST", url: `${cli}/music/fetch`, headers: worker, payload: { url: found.results[0].url, title: "Calm", artist: "Ann", attribution: found.results[0].attribution, madeByModel: "m" } })).json();
      expect(track.asset).toMatchObject({ kind: "MUSIC", mimeType: "audio/mpeg", credits: "Calm by Ann (ccMixter, CC BY)" });
      expect((await app.inject({ method: "POST", url: `${cli}/ask`, headers: worker, payload: { requestId: second.request.id, question: "Keep the intro?" } })).json().request).toMatchObject({ question: "Keep the intro?" });
      expect((await app.inject({ method: "GET", url: `${cli}/requests/${encodeURIComponent(second.request.id)}`, headers: requester })).json().request).toMatchObject({ question: "Keep the intro?" });
      expect((await app.inject({ method: "POST", url: `${cli}/fail`, headers: worker, payload: { requestId: second.request.id, reason: "The talk has no picture." } })).json().request).toMatchObject({ status: "FAILED" });
      expect((await app.inject({ method: "POST", url: `${cli}/fail`, headers: requester, payload: { requestId: second.request.id, reason: "x" } })).statusCode).toBe(409);
      await mkdir(join(root, "unused"), { recursive: true });
      expect(await readFile(wrapper, "utf8")).toContain("exit 0");
    } finally { await app.close(); }
  });

  it("holds deliveries for the operator under approval, raises VIDEO notifications and attaches to a Marketing post", async () => {
    const { app, store, pane, headers, fake, uploadSource, url } = await fixture();
    try {
      await app.inject({ method: "PUT", url: `${url}/settings`, headers, payload: { version: 1, settings: { requestAutonomy: "APPROVAL" } } });
      const source = await uploadSource();
      const videoPane = store.getPane(pane.id);
      const created = (await app.inject({ method: "POST", url: `${url}/requests`, headers, payload: { brief: "Reel", sources: [{ artifactId: source.artifactId }], formatIds: ["x"] } })).json();
      // The worker side through the service: take, assemble, deliver → held.
      const tokenHeaders = (() => { const session = store.createPaneCliSession({ paneId: pane.id, roomId: pane.roomId, runtimeId: "cli:codex", providerId: "codex", agentId: "codex", status: "RUNNING", purpose: "NORMAL" });
        return { [cliBrowserBridgeTokenHeader]: issueCliBrowserBridgeToken(getApiConfig({ SPACE_ARTIFACT_ROOT: tmpdir(), SPACE_LOG_LEVEL: "silent" }), { roomId: pane.roomId, paneId: pane.id, cliSessionId: session.sessionId })!, "content-type": "application/json" }; })();
      void tokenHeaders; void videoPane;
      const list = (await app.inject({ method: "GET", url: `${url}/requests`, headers })).json().requests;
      expect(list.map((entry: { id: string; status: string }) => [entry.id, entry.status])).toEqual([[created.request.id, "QUEUED"]]);
      expect((await app.inject({ method: "POST", url: `${url}/requests/${encodeURIComponent(created.request.id)}/approve`, headers, payload: {} })).statusCode).toBe(409);
      const cancelled = await app.inject({ method: "POST", url: `${url}/requests/${encodeURIComponent(created.request.id)}/cancel`, headers });
      expect(cancelled.json().request.status).toBe("CANCELLED");
      const events = (await app.inject({ method: "GET", url: `${url}/events`, headers })).json().events as Array<{ type: string }>;
      expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["REQUEST_CREATED", "CANCELLED", "SOURCE_ADDED", "JOB_DONE"]));
      expect(fake.jobs.map((job) => job.op)).toEqual(["probe"]);
      // A request from another pane the operator works in (Marketing's "Make video", the Live pane) is routed to this pane.
      const live = store.createPane({ roomId: pane.roomId, title: "Live", mode: "LIVE" });
      const fromLive = await app.inject({ method: "POST", url: "/api/video/requests", headers, payload: { fromPaneId: live.id, brief: "What we just discussed", sources: [{ artifactId: source.artifactId }], options: { narration: { text: "A summary" } } } });
      expect(fromLive.statusCode).toBe(200);
      expect(fromLive.json()).toMatchObject({ videoPaneId: pane.id, request: { requester: { kind: "OPERATOR", paneId: live.id, label: "You, from Live" }, formatIds: ["youtube-short"], options: { narration: { text: "A summary" } } } });
      expect((await app.inject({ method: "POST", url: "/api/video/requests", headers, payload: { fromPaneId: live.id, brief: "x", callback: { kind: "MARKETING_POST", postId: "mktpost:missing1" } } })).statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it("refuses engine jobs while the server is overloaded or two already run", async () => {
    let level = "OVERLOADED";
    const engine = createVideoEngine({ load: () => ({ level, reasons: ["load 40 on 20 cores"] }), run: async (request, _timeout, onProgress) => { onProgress({ progress: 10, message: "x" }); return JSON.stringify({ result: { echo: JSON.parse(request).op } }); } });
    const job = { op: "probe" as const, workDir: "/nowhere", toolsDir: "/nowhere" };
    await expect(engine(job)).rejects.toThrow(/overloaded/);
    level = "CALM";
    const progress: number[] = [];
    expect(await engine(job, (step) => progress.push(step.progress))).toEqual({ echo: "probe" });
    expect(progress).toEqual([10]);
  });
});
