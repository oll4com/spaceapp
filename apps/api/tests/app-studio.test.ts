// The App Studio pane (plan clipboard:v7hyZ76ThCyv): operator routes (settings, state, briefs, answers, run), the agent bridge
// (next, done, ask, wait, note, previews) and the service's rules (kickoff only for an idle pane, notifications, the latest preview
// per device and route with the replaced one unpinned, the route cap).
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryAppStudioRepository } from "@space/db";
import { InMemorySpaceStore, SpaceEventBus } from "@space/runtime";
import { APP_STUDIO_DEVICES, type Event, type Pane } from "@space/contracts";
import { createAppStudioService } from "../src/app-studio/service.js";
import { createApp } from "../src/app.js";
import { cliBrowserBridgeTokenHeader, issueCliBrowserBridgeToken } from "../src/cli-browser-bridge.js";
import { getApiConfig } from "../src/config.js";
import { pngOf } from "./fixtures/design-png.js";

vi.setConfig({ testTimeout: 30_000 });
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const tempRoot = async () => { const root = await mkdtemp(join(tmpdir(), "space-app-studio-")); roots.push(root); return root; };

async function fixture(options: { repository?: InMemoryAppStudioRepository } = {}) {
  const root = await tempRoot();
  // The agent bridge needs the CLI and its browser bridge on (a Codex wrapper that exits at once).
  const wrapper = join(root, "codex-vscode-parity");
  await writeFile(wrapper, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(wrapper, 0o755);
  const config = getApiConfig({
    SPACE_CLI_ENABLED: "true", SPACE_CLI_COMMAND_PATH: root, SPACE_CLI_HOST_SOCKET: join(root, "pane-host.sock"), SPACE_CLI_CODEX_CREDENTIAL_SMOKE: "true",
    SPACE_CLI_WORKSPACE_ROOT: join(root, "workspaces"), SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true", SPACE_INTERNAL_API_TOKEN: "internal-token-for-app-studio-tests", SPACE_ARTIFACT_ROOT: root, SPACE_LOG_LEVEL: "silent"
  });
  const store = new InMemorySpaceStore();
  const eventBus = new SpaceEventBus();
  const roomEvents: Event[] = [];
  eventBus.subscribe((event) => { if (event.type === "APP_STUDIO_UPDATED" || event.type === "ARTIFACT_CREATED") roomEvents.push(event); });
  const kickoffs: string[] = [];
  const app = await createApp({ store, config, eventBus, jobApplyMailTriage: false, marketingCopilotScheduler: false, appStudioKickoff: async (pane) => { kickoffs.push(pane.id); }, appStudioRepository: options.repository,
    auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false } });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
  const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
  const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
  const headers = { cookie, "x-space-csrf-token": csrf.json().csrfToken as string };
  const room = (await app.inject({ method: "POST", url: "/api/rooms", headers, payload: { name: "Apps", initialPaneCount: 0 } })).json();
  const pane = store.createPane({ roomId: room.id, title: "App Studio", mode: "APP_STUDIO", terminalRuntimeId: "cli:claude" });
  const tokenFor = (paneId: string) => {
    const session = store.createPaneCliSession({ paneId, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex", status: "RUNNING", purpose: "NORMAL" });
    return { [cliBrowserBridgeTokenHeader]: issueCliBrowserBridgeToken(config, { roomId: room.id, paneId, cliSessionId: session.sessionId })! };
  };
  return { app, store, room, pane, headers, kickoffs, roomEvents, tokenFor, url: `/api/panes/${encodeURIComponent(pane.id)}/app-studio`, cli: "/api/cli/app-studio" };
}

const boundary = "----app-studio-test";
function multipart(fields: Record<string, string>, files: Array<[string, Buffer]>) {
  return Buffer.concat([
    ...Object.entries(fields).map(([name, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)),
    ...files.flatMap(([name, bytes]) => [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${name}.png"\r\nContent-Type: image/png\r\n\r\n`), bytes, Buffer.from("\r\n")]),
    Buffer.from(`--${boundary}--\r\n`)
  ]);
}

describe("App Studio routes", () => {
  it("keeps the pane's settings and answers 409 on other panes and unknown devices", async () => {
    const { app, store, room, headers, url } = await fixture();
    try {
      expect((await app.inject({ method: "GET", url: `${url}/settings`, headers })).json().metadata.settings).toEqual({
        paused: false, devices: ["android-412x915", "iphone-402x874"], notifications: { needsYou: true, done: true, telegram: false } });
      const updated = await app.inject({ method: "PUT", url: `${url}/settings`, headers, payload: { version: 1, settings: { devices: ["android-360x800", "iphone-440x956"] } } });
      expect(updated.json().metadata.settings.devices).toEqual(["android-360x800", "iphone-440x956"]);
      expect((await app.inject({ method: "PUT", url: `${url}/settings`, headers, payload: { version: 1, settings: { devices: ["iphone-414x896"] } } })).statusCode).toBe(409);
      expect((await app.inject({ method: "PUT", url: `${url}/settings`, headers, payload: { version: 1, settings: { autonomy: "FULL" } } })).statusCode).toBe(422);
      const design = store.createPane({ roomId: room.id, title: "Design", mode: "DESIGN", terminalRuntimeId: "cli:claude" });
      expect((await app.inject({ method: "GET", url: `/api/panes/${encodeURIComponent(design.id)}/app-studio/settings`, headers })).statusCode).toBe(409);
      expect((await app.inject({ method: "GET", url: `${url}/settings` })).statusCode).toBe(401);
    } finally { await app.close(); }
  });

  it("runs a brief from the rail through the agent's tools, with a question answered by the operator", async () => {
    const { app, headers, url, cli, pane, kickoffs, roomEvents, tokenFor } = await fixture();
    try {
      const agent = { ...tokenFor(pane.id), "content-type": "application/json" };
      const created = (await app.inject({ method: "POST", url: `${url}/briefs`, headers, payload: { text: "Build a todo app with two screens" } })).json();
      expect(created).toMatchObject({ kickoffSent: true, brief: { type: "BRIEF", status: "PENDING", payload: { requester: "OPERATOR" } } });
      expect(kickoffs).toEqual([pane.id]);
      expect((await app.inject({ method: "POST", url: `${cli}/next`, payload: {} })).statusCode).toBe(401);
      const next = (await app.inject({ method: "POST", url: `${cli}/next`, headers: agent, payload: {} })).json();
      expect(next).toMatchObject({ done: false, brief: { id: created.brief.id, text: "Build a todo app with two screens", requester: "OPERATOR" }, devices: ["android-412x915", "iphone-402x874"] });
      // After a CLI restart the agent gets the brief it already took.
      expect((await app.inject({ method: "POST", url: `${cli}/next`, headers: agent, payload: {} })).json().brief.id).toBe(created.brief.id);

      // R23-2 (31/10: 5 App Studio questions with options and no recommended one): options need the recommended one, which must be one of them.
      const unrecommended = await app.inject({ method: "POST", url: `${cli}/ask`, headers: agent, payload: { question: "Light or dark theme?", options: ["Light", "Dark"] } });
      expect(unrecommended.statusCode).toBeGreaterThanOrEqual(400);
      expect(unrecommended.json().error.details.fieldErrors.recommended).toEqual([expect.stringContaining("with options, name the one you recommend")]);
      expect((await app.inject({ method: "POST", url: `${cli}/ask`, headers: agent, payload: { question: "Light or dark theme?", options: ["Light", "Dark"], recommended: "Sepia" } })).json().error.details.fieldErrors.recommended)
        .toEqual(["recommended must be one of the options"]);
      const asked = (await app.inject({ method: "POST", url: `${cli}/ask`, headers: agent, payload: { question: "Light or dark theme?", options: ["Light", "Dark"], recommended: "Dark" } })).json();
      expect(asked.question.payload).toMatchObject({ options: ["Light", "Dark"], recommended: "Dark" });
      const pending = (await app.inject({ method: "GET", url: "/api/notifications?status=OPEN", headers })).json().notifications as Array<{ source: string; kind: string; severity: string }>;
      expect(pending).toContainEqual(expect.objectContaining({ source: "APP_STUDIO", kind: "APP_STUDIO_QUESTION", severity: "ATTENTION",
        payload: expect.objectContaining({ ask: { question: "Light or dark theme?", options: ["Light", "Dark"], recommended: "Dark", answer: { kind: "COPILOT_QUESTION", copilot: "APP_STUDIO", questionId: asked.question.id } } }) }));
      const answerUrl = `${url}/questions/${encodeURIComponent(asked.question.id)}/answer`;
      expect((await app.inject({ method: "POST", url: answerUrl, headers, payload: { answer: "Dark" } })).json().question).toMatchObject({ status: "ANSWERED", payload: { answer: "Dark", answeredBy: "OPERATOR" } });
      expect((await app.inject({ method: "POST", url: answerUrl, headers, payload: { answer: "Light" } })).statusCode).toBe(409);
      expect((await app.inject({ method: "POST", url: `${cli}/questions/${encodeURIComponent(asked.question.id)}/wait`, headers: agent, payload: { waitMs: 0 } })).json()).toEqual({ answered: true, answer: "Dark" });
      expect(((await app.inject({ method: "GET", url: "/api/notifications?status=OPEN", headers })).json().notifications as Array<{ kind: string }>).some((row) => row.kind === "APP_STUDIO_QUESTION")).toBe(false);

      await app.inject({ method: "POST", url: `${cli}/note`, headers: agent, payload: { message: "Created the Expo project" } });
      const doneUrl = `${cli}/briefs/${encodeURIComponent(created.brief.id)}/done`;
      // Proof gate (operator 31/10 14:13 BKK): no done without a fresh preview per item.
      const bare = await app.inject({ method: "POST", url: doneUrl, headers: agent, payload: { summary: "Todo list and settings screens" } });
      expect(bare.statusCode).toBe(409);
      expect(bare.json().error.message).toContain("space_appstudio_preview");
      const shot = (await app.inject({ method: "POST", url: `${cli}/previews`, headers: { ...agent, "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: multipart({ route: "/" }, [["android-412x915", pngOf(824, 1830)]]) })).json().previews[0].artifactId as string;
      const items = [{ item: "Todo list screen", previewArtifactIds: [shot] }];
      const done = await app.inject({ method: "POST", url: doneUrl, headers: agent, payload: { summary: "Todo list and settings screens", items } });
      expect(done.json().event).toMatchObject({ type: "BRIEF_DONE", payload: { briefId: created.brief.id, items } });
      expect(((await app.inject({ method: "GET", url: "/api/notifications?status=OPEN", headers })).json().notifications as Array<{ kind: string; body: string }>)
        .find((row) => row.kind === "APP_STUDIO_DONE")?.body).toContain(`"Todo list screen" → ${shot}`);
      expect((await app.inject({ method: "POST", url: doneUrl, headers: agent, payload: { summary: "again", items } })).statusCode).toBe(409);
      expect((await app.inject({ method: "POST", url: `${cli}/next`, headers: agent, payload: {} })).json()).toMatchObject({ done: true });

      const state = (await app.inject({ method: "GET", url: `${url}/state`, headers })).json();
      expect(state.run).toEqual({ status: "IDLE", paused: false, openQuestions: 0, pendingBriefs: 0 });
      expect(state.events.map((event: { type: string }) => event.type).sort()).toEqual(["ANSWERED", "BRIEF", "BRIEF_DONE", "NOTE", "PREVIEW", "QUESTION"]);
      expect(state.events.find((event: { type: string }) => event.type === "BRIEF").status).toBe("DONE");
      expect(roomEvents.some((event) => event.type === "APP_STUDIO_UPDATED" && event.paneId === pane.id)).toBe(true);
    } finally { await app.close(); }
  });

  it("stores the agent's captures as the latest preview per device and route, and refuses what is not one", async () => {
    const { app, store, room, headers, url, cli, pane, tokenFor } = await fixture();
    try {
      const upload = (fields: Record<string, string>, files: Array<[string, Buffer]>, token = tokenFor(pane.id)) => app.inject({ method: "POST", url: `${cli}/previews`,
        headers: { ...token, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: multipart(fields, files) });
      const first = await upload({ route: "/" }, [["android-412x915", pngOf(824, 1830)], ["iphone-402x874", pngOf(804, 1748)]]);
      expect(first.statusCode).toBe(200);
      const [android, iphone] = first.json().previews as Array<{ deviceId: string; artifactId: string }>;
      expect(store.getArtifact(android!.artifactId)).toMatchObject({ kind: "SCREENSHOT", roomId: room.id, paneId: pane.id, pinnedAt: expect.any(String), metadata: expect.objectContaining({ source: "APP_STUDIO", deviceId: "android-412x915", route: "/" }) });
      const again = await upload({ route: "/" }, [["iphone-402x874", pngOf(804, 1748)]]);
      const replacement = again.json().previews[0].artifactId as string;
      expect(replacement).not.toBe(iphone!.artifactId);
      expect(store.getArtifact(iphone!.artifactId)).toMatchObject({ pinnedAt: null, expiresAt: expect.any(String) });
      expect((await app.inject({ method: "GET", url: `${url}/state`, headers })).json().previews.map((row: { deviceId: string; artifactId: string }) => [row.deviceId, row.artifactId]))
        .toEqual([["android-412x915", android!.artifactId], ["iphone-402x874", replacement]]);
      // "all": one capture per phone in one upload, more files than the multipart plugin's global limit.
      const all = await upload({ route: "/all" }, APP_STUDIO_DEVICES.map((device) => [device.id, pngOf(device.width * 2, device.height * 2)] as [string, Buffer]));
      expect(all.statusCode).toBe(200);
      expect(all.json().previews).toHaveLength(APP_STUDIO_DEVICES.length);
      expect((await upload({ route: "/" }, [["iphone-414x896", pngOf(828, 1792)]])).statusCode).toBe(409);
      expect((await upload({ route: "/" }, [["iphone-402x874", Buffer.from("<html></html>")]])).statusCode).toBe(409);
      expect((await upload({ route: "/../etc" }, [["iphone-402x874", pngOf(804, 1748)]])).statusCode).toBe(409);
      // The lab emulator's capture of the installed build (space-app-studio-apk-proof.mjs) is filed as an APK preview.
      const apk = await upload({ route: "/plans", source: "APK", packageName: "com.oll4.spaceapp.nous", versionName: "0.2.11" }, [["android-412x915", pngOf(720, 1600)]]);
      expect(store.getArtifact(apk.json().previews[0].artifactId).metadata).toMatchObject({ capturedFrom: "APK", packageName: "com.oll4.spaceapp.nous", versionName: "0.2.11" });
      expect((await upload({ route: "/plans", source: "PHONE" }, [["android-412x915", pngOf(720, 1600)]])).statusCode).toBe(409);
      expect((await upload({ route: "/plans", source: "APK", packageName: "nous" }, [["android-412x915", pngOf(720, 1600)]])).statusCode).toBe(409);
      const shell = store.createPane({ roomId: room.id, title: "Claude CLI", mode: "TERMINAL", terminalRuntimeId: "cli:claude" });
      expect((await upload({ route: "/" }, [["iphone-402x874", pngOf(804, 1748)]], tokenFor(shell.id))).statusCode).toBe(409);
      expect((await app.inject({ method: "GET", url: `${cli}/devices`, headers: tokenFor(pane.id) })).json()).toMatchObject({ selected: ["android-412x915", "iphone-402x874"], devices: expect.arrayContaining([expect.objectContaining({ id: "iphone-440x956" })]) });
    } finally { await app.close(); }
  });

  it("stores the agent's APK as a pinned room EXPORT for download, releases the one it replaces, and refuses what is not one", async () => {
    const { app, store, room, url, headers, cli, pane, tokenFor } = await fixture();
    try {
      const apk = (marker: string) => Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.from(marker.repeat(64))]);
      const fields = { packageName: "com.oll4.nous", versionName: "1.0.0", versionCode: "1", buildMs: "412000" };
      const upload = (form: Record<string, string>, bytes: Buffer, token = tokenFor(pane.id)) => app.inject({ method: "POST", url: `${cli}/apk`,
        headers: { ...token, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: multipart(form, [["apk", bytes]]) });
      const first = await upload(fields, apk("a"));
      expect(first.statusCode).toBe(200);
      const { artifactId, downloadPath } = first.json() as { artifactId: string; downloadPath: string };
      expect(downloadPath).toBe(`/api/artifacts/${encodeURIComponent(artifactId)}/file`);
      expect(store.getArtifact(artifactId)).toMatchObject({ kind: "EXPORT", roomId: room.id, paneId: pane.id, mimeType: "application/vnd.android.package-archive", pinnedAt: expect.any(String),
        metadata: expect.objectContaining({ source: "APP_STUDIO", packageName: "com.oll4.nous", versionName: "1.0.0", signedWith: "android-debug-keystore" }) });
      // The operator downloads it with their session, as an attachment.
      const file = await app.inject({ method: "GET", url: downloadPath, headers });
      expect(file.statusCode).toBe(200);
      expect(file.headers["content-disposition"]).toMatch(/^attachment; filename="com\.oll4\.nous-1\.0\.0\.apk"/);
      const events = (await app.inject({ method: "GET", url: `${url}/state`, headers })).json().events as Array<{ type: string; payload: Record<string, unknown> }>;
      expect(events.find((event) => event.payload.apkArtifactId === artifactId)).toMatchObject({ type: "NOTE", payload: { packageName: "com.oll4.nous", downloadPath } });
      // R20-15 (operator 30/10): the same APK is an Agent File named for the app and its version. A test build (the default) goes to
      // Apps/Android/Builds, which the Nous app's updater ignores (operator 31/10, space_memory:b5146b7c).
      const { agentFileId } = first.json() as { agentFileId: string };
      expect(store.getArtifact(agentFileId)).toMatchObject({ roomId: room.id, mimeType: "application/vnd.android.package-archive", sha256: store.getArtifact(artifactId)!.sha256,
        metadata: expect.objectContaining({ folder: "Apps/Android/Builds", originalFilename: "Nous-Android-1.0.0.apk" }) });
      expect((await app.inject({ method: "GET", url: `/api/artifacts/${encodeURIComponent(agentFileId)}/download`, headers })).statusCode).toBe(200);
      // Only a release build is filed in Apps/Android itself, which the updater reads (once 1.0.5 was installed on the lab emulator).
      await app.inject({ method: "POST", url: `${cli}/previews`, headers: { ...tokenFor(pane.id), "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: multipart({ route: "/", source: "APK", packageName: "com.oll4.nous", versionName: "1.0.5" }, [["android-412x915", pngOf(720, 1600)]]) });
      const released = await upload({ ...fields, versionName: "1.0.5", versionCode: "5", release: "true" }, apk("r"));
      expect(released.statusCode).toBe(200);
      expect(store.getArtifact((released.json() as { agentFileId: string }).agentFileId)).toMatchObject({
        metadata: expect.objectContaining({ folder: "Apps/Android", originalFilename: "Nous-Android-1.0.5.apk" }) });
      const second = await upload({ ...fields, versionName: "1.0.1", versionCode: "2" }, apk("b"));
      expect(second.statusCode).toBe(200);
      expect(store.getArtifact(artifactId)).toMatchObject({ pinnedAt: null, expiresAt: expect.any(String) });
      expect(store.getArtifact(second.json().artifactId)).toMatchObject({ pinnedAt: expect.any(String) });
      // A release-signed build (the app's kept Vault key) says so; any other signer name is refused.
      const third = await upload({ ...fields, versionName: "1.0.2", versionCode: "3", signedWith: "release" }, apk("c"));
      expect(third.statusCode).toBe(200);
      expect(store.getArtifact(third.json().artifactId)).toMatchObject({ metadata: expect.objectContaining({ signedWith: "release" }) });
      // The build script's release of a release-signed app sends both (six fields): the route's field limit cut it as "interrupted".
      await app.inject({ method: "POST", url: `${cli}/previews`, headers: { ...tokenFor(pane.id), "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: multipart({ route: "/", source: "APK", packageName: "com.oll4.nous", versionName: "1.0.6" }, [["android-412x915", pngOf(720, 1600)]]) });
      const signedRelease = await upload({ ...fields, versionName: "1.0.6", versionCode: "6", signedWith: "release", release: "true" }, apk("s"));
      expect(signedRelease.statusCode).toBe(200);
      expect(store.getArtifact((signedRelease.json() as { agentFileId: string }).agentFileId)).toMatchObject({
        metadata: expect.objectContaining({ folder: "Apps/Android", originalFilename: "Nous-Android-1.0.6.apk" }) });
      expect((await upload({ ...fields, signedWith: "my-own-key" }, apk("d"))).statusCode).toBe(409);
      expect((await upload(fields, Buffer.from("<html></html>"))).statusCode).toBe(409);
      expect((await upload({ ...fields, packageName: "../../x" }, apk("c"))).statusCode).toBe(409);
      const shell = store.createPane({ roomId: room.id, title: "Claude CLI", mode: "TERMINAL", terminalRuntimeId: "cli:claude" });
      expect((await upload(fields, apk("d"), tokenFor(shell.id))).statusCode).toBe(409);
    } finally { await app.close(); }
  });

  it("refuses a release build while a brief done since the last release has no proof, and takes that proof later (31/10 proof gate)", async () => {
    const repository = new InMemoryAppStudioRepository();
    const { app, store, room, cli, pane, tokenFor } = await fixture({ repository });
    try {
      const owner = store.getRoom(room.id).ownerUserId!;
      const token = tokenFor(pane.id);
      const agent = { ...token, "content-type": "application/json" };
      const multipartHeaders = { ...token, "content-type": `multipart/form-data; boundary=${boundary}` };
      // Closed before the gate (Nous app 0.2.8): DONE with no items.
      const old = await repository.createEvent({ ownerUserId: owner, paneId: pane.id, type: "BRIEF", status: "DONE", message: "Plan colours", payload: { requester: "NOUS", result: "plan colours YES" } });
      const check = await app.inject({ method: "POST", url: `${cli}/release-check`, headers: agent, payload: {} });
      expect(check.statusCode).toBe(409);
      expect(check.json().error.message).toContain(`${old.id} "Plan colours"`);
      const apk = Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.from("x".repeat(64))]);
      const fields = { packageName: "com.oll4.spaceapp.nous", versionName: "0.2.9", versionCode: "29", buildMs: "1000" };
      const upload = (form: Record<string, string>) => app.inject({ method: "POST", url: `${cli}/apk`, headers: multipartHeaders, payload: multipart(form, [["apk", apk]]) });
      expect((await upload({ ...fields, release: "true" })).statusCode).toBe(409);
      // A test build still builds and names what lacks proof.
      const test = await upload(fields);
      expect(test.statusCode).toBe(200);
      expect(test.json().unproven).toEqual([expect.objectContaining({ briefId: old.id, text: "Plan colours" })]);
      // The agent previews the screen now and adds the proof to the closed brief.
      const shot = (await app.inject({ method: "POST", url: `${cli}/previews`, headers: multipartHeaders, payload: multipart({ route: "/plans" }, [["android-412x915", pngOf(824, 1830)]]) }))
        .json().previews[0].artifactId as string;
      const proven = await app.inject({ method: "POST", url: `${cli}/briefs/${encodeURIComponent(old.id)}/done`, headers: agent,
        payload: { summary: "Plan colours", items: [{ item: "Plan colours", previewArtifactIds: [shot] }] } });
      expect(proven.json().event).toMatchObject({ type: "NOTE", payload: { briefId: old.id } });
      expect((await app.inject({ method: "POST", url: `${cli}/release-check`, headers: agent, payload: {} })).json()).toEqual({ ok: true });
      // B (Nous 31/10): a release only once that exact version was installed and opened on the lab emulator.
      const unprovenRelease = await upload({ ...fields, versionName: "0.2.10", versionCode: "30", release: "true" });
      expect(unprovenRelease.statusCode).toBe(409);
      expect(unprovenRelease.json().error.message).toContain("needs that version installed and opened on the lab emulator");
      const releaseCheck = (body: Record<string, string>) => app.inject({ method: "POST", url: `${cli}/release-check`, headers: agent, payload: body });
      expect((await releaseCheck({ packageName: "com.oll4.spaceapp.nous", versionName: "0.2.10" })).statusCode).toBe(409);
      await app.inject({ method: "POST", url: `${cli}/previews`, headers: multipartHeaders,
        payload: multipart({ route: "/", source: "APK", packageName: "com.oll4.spaceapp.nous", versionName: "0.2.9", versionCode: "29", data: "SIGNED_OUT" }, [["android-412x915", pngOf(720, 1600)]]) });
      expect((await releaseCheck({ packageName: "com.oll4.spaceapp.nous", versionName: "0.2.10" })).statusCode).toBe(409);
      const installed = await app.inject({ method: "POST", url: `${cli}/previews`, headers: multipartHeaders,
        payload: multipart({ route: "/", source: "APK", packageName: "com.oll4.spaceapp.nous", versionName: "0.2.10", versionCode: "30", data: "SIGNED_OUT" }, [["android-412x915", pngOf(720, 1600)]]) });
      expect(store.getArtifact(installed.json().previews[0].artifactId).metadata).toMatchObject({ capturedFrom: "APK", versionCode: 30, data: "SIGNED_OUT" });
      expect((await releaseCheck({ packageName: "com.oll4.spaceapp.nous", versionName: "0.2.10" })).json()).toEqual({ ok: true });
      const release = await upload({ ...fields, versionName: "0.2.10", versionCode: "30", release: "true" });
      expect(release.statusCode).toBe(200);
      expect(release.json().unproven).toBeUndefined();
    } finally { await app.close(); }
  });

  it("lets the run be paused and started again, the way Nous controls it", async () => {
    const { app, headers, url, cli, pane, kickoffs, tokenFor } = await fixture();
    try {
      const agent = { ...tokenFor(pane.id), "content-type": "application/json" };
      expect((await app.inject({ method: "POST", url: `${url}/run/pause`, headers, payload: {} })).json()).toMatchObject({ status: "PAUSED", kickoffSent: false });
      expect((await app.inject({ method: "POST", url: `${cli}/next`, headers: agent, payload: {} })).json()).toMatchObject({ done: true, reason: "The run is paused." });
      // A new brief restarts a paused run.
      await app.inject({ method: "POST", url: `${url}/briefs`, headers, payload: { text: "Add a login screen" } });
      expect((await app.inject({ method: "GET", url: `${url}/run`, headers })).json()).toMatchObject({ status: "RUNNING", pendingBriefs: 1 });
      expect((await app.inject({ method: "POST", url: `${cli}/next`, headers: agent, payload: {} })).json().done).toBe(false);
      expect((await app.inject({ method: "POST", url: `${url}/run/stop`, headers, payload: {} })).json().status).toBe("STOPPED");
      // Paused in Setup: nothing is taken and no kickoff is typed.
      await app.inject({ method: "PUT", url: `${url}/settings`, headers, payload: { version: 1, settings: { paused: true } } });
      const started = (await app.inject({ method: "POST", url: `${url}/run/start`, headers, payload: {} })).json();
      expect(started).toMatchObject({ status: "RUNNING", paused: true, kickoffSent: false });
      expect((await app.inject({ method: "POST", url: `${cli}/next`, headers: agent, payload: {} })).json()).toMatchObject({ done: true, reason: "The operator paused this pane." });
      expect(kickoffs).toEqual([pane.id]);
    } finally { await app.close(); }
  });
});

describe("App Studio service", () => {
  async function service(options: { ready?: boolean; now?: () => number } = {}) {
    const root = await tempRoot();
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Apps", initialPaneCount: 0 }, "trace:apps", "user:operator");
    const pane = store.createPane({ roomId: room.id, title: "App Studio", mode: "APP_STUDIO", terminalRuntimeId: "cli:claude" });
    const notifications: Array<{ action: string; key: string; severity?: string }> = [];
    const kickoffs: string[] = [];
    const fresh: boolean[] = [];
    const repository = new InMemoryAppStudioRepository(options.now ? () => new Date(options.now!()).toISOString() : undefined);
    const studio = createAppStudioService({ repository, store, artifactRoot: root, now: options.now,
      kickoff: { ready: async () => options.ready ?? true, send: async (target: Pane, isFresh: boolean) => { kickoffs.push(target.id); fresh.push(isFresh); } },
      notifications: { raise: async (input) => { notifications.push({ action: "raise", key: input.dedupeKey!, severity: input.severity }); return {} as never; },
        resolve: async (_owner, key) => { notifications.push({ action: "resolve", key }); return 1; }, list: async () => [] } });
    return { store, pane, studio, notifications, kickoffs, fresh };
  }

  it("types the kickoff only into an idle pane at an empty prompt, at most once a minute", async () => {
    let clock = Date.parse("2026-10-19T10:00:00.000Z");
    const busy = await service({ ready: false });
    expect((await busy.studio.addBrief("user:operator", busy.pane, "One", "NOUS")).kickoffSent).toBe(false);
    const { studio, pane, kickoffs, fresh } = await service({ now: () => clock });
    expect((await studio.addBrief("user:operator", pane, "One", "NOUS")).kickoffSent).toBe(true);
    expect((await studio.addBrief("user:operator", pane, "Two", "OPERATOR")).kickoffSent).toBe(false);
    clock += 61_000;
    await studio.takeNext("user:operator", pane);
    // A TAKEN brief does not hold new work: the empty prompt (ready) is the guard against typing into the agent's turn.
    expect((await studio.addBrief("user:operator", pane, "Three", "OPERATOR")).kickoffSent).toBe(true);
    expect(kickoffs).toEqual([pane.id, pane.id]);
    // Plan clipboard:qH5emwVaV6yO step 4: a batch with nothing TAKEN starts a fresh session; one beside a TAKEN brief keeps the session.
    expect(fresh).toEqual([true, false]);
  });

  it("sends a PENDING brief's kickoff again once a minute, only to a ready pane whose run is not paused or stopped", async () => {
    let clock = Date.parse("2026-10-24T00:00:00.000Z");
    let ready = false;
    const root = await tempRoot();
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Apps", initialPaneCount: 0 }, "trace:apps", "user:operator");
    const pane = store.createPane({ roomId: room.id, title: "App Studio", mode: "APP_STUDIO", terminalRuntimeId: "cli:claude" });
    const kickoffs: string[] = [];
    const studio = createAppStudioService({ repository: new InMemoryAppStudioRepository(() => new Date(clock).toISOString()), store, artifactRoot: root, now: () => clock,
      kickoff: { ready: async () => ready, send: async (target: Pane) => { kickoffs.push(target.id); } } });
    expect(await studio.dispatchPending()).toBe(0);
    // The CLI was not at its prompt when the brief came: no kickoff then, none while it stays busy.
    expect((await studio.addBrief("user:operator", pane, "Google sign-in", "NOUS")).kickoffSent).toBe(false);
    expect(await studio.dispatchPending()).toBe(0);
    ready = true;
    expect(await studio.dispatchPending()).toBe(1);
    expect(await studio.dispatchPending()).toBe(0);
    clock += 61_000;
    await studio.setRun("user:operator", pane, "stop");
    clock += 61_000;
    expect(await studio.dispatchPending()).toBe(0);
    await studio.setRun("user:operator", pane, "start");
    clock += 61_000;
    expect(await studio.dispatchPending()).toBe(1);
    await studio.takeNext("user:operator", pane);
    clock += 61_000;
    // A TAKEN brief, and no PENDING one left: nothing to send.
    expect(await studio.dispatchPending()).toBe(0);
    expect(kickoffs).toEqual([pane.id, pane.id, pane.id]);
  });

  it("kicks a pane that never recorded a run at its empty prompt, past a TAKEN brief, and serves the PENDING ones first (31/10 Alex/Emma)", async () => {
    let clock = Date.parse("2026-10-30T17:38:00.000Z");
    const root = await tempRoot();
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Alex", initialPaneCount: 0 }, "trace:alex", "user:operator");
    const pane = store.createPane({ roomId: room.id, title: "App Studio 20", mode: "APP_STUDIO", terminalRuntimeId: "cli:claude" });
    const kickoffs: string[] = [];
    let ready = false;
    const studio = createAppStudioService({ repository: new InMemoryAppStudioRepository(() => new Date(clock).toISOString()), store, artifactRoot: root, now: () => clock,
      kickoff: { ready: async () => ready, send: async (target: Pane) => { kickoffs.push(target.id); } } });
    await studio.addBrief("user:operator", pane, "Icon v2", "NOUS");
    await studio.takeNext("user:operator", pane);
    clock = Date.parse("2026-10-30T17:50:00.000Z");
    await studio.addBrief("user:operator", pane, "Quotas tab", "NOUS");
    clock = Date.parse("2026-10-30T18:04:00.000Z");
    await studio.addBrief("user:operator", pane, "Server parts", "NOUS");
    expect((await studio.events("user:operator", pane)).some((event) => event.type.startsWith("RUN_"))).toBe(false);
    expect(await studio.runStatus("user:operator", pane)).toBe("IDLE");
    ready = true;
    clock = Date.parse("2026-10-30T18:05:00.000Z");
    // The icon brief was taken 27 minutes ago and parked; the prompt is empty, so the waiting briefs go in.
    expect(await studio.dispatchPending()).toBe(1);
    expect(await studio.dispatchPending()).toBe(0);
    expect(kickoffs).toEqual([pane.id]);
    clock = Date.parse("2026-10-30T18:15:00.000Z");
    // The waiting briefs come first, oldest first; the taken one (37 minutes untouched) only once none waits, touched (2/11 Cleo/Iris: a brief
    // worked on for hours came back first on every kickoff and 7 PENDING briefs were never taken).
    expect(await studio.takeNext("user:operator", pane)).toMatchObject({ brief: { text: "Quotas tab" } });
    expect(await studio.takeNext("user:operator", pane)).toMatchObject({ brief: { text: "Server parts" } });
    expect(await studio.takeNext("user:operator", pane)).toMatchObject({ brief: { text: "Icon v2" } });
    expect((await studio.events("user:operator", pane)).find((event) => event.message === "Icon v2")).toMatchObject({ status: "TAKEN", updatedAt: new Date(clock).toISOString() });
  });

  it("folds a burst of failed briefs into one card per pane, alerted once (operator 31/10 17:31 BKK: 12 pop-ups in 3 minutes)", async () => {
    const { app, headers, url, cli, pane, tokenFor } = await fixture();
    try {
      const agent = { ...tokenFor(pane.id), "content-type": "application/json" };
      for (const n of [1, 2, 3]) {
        const { brief } = (await app.inject({ method: "POST", url: `${url}/briefs`, headers, payload: { text: `Old brief ${n}` } })).json();
        expect((await app.inject({ method: "POST", url: `${cli}/briefs/${encodeURIComponent(brief.id)}/done`, headers: agent, payload: { summary: `Handed over ${n}`, failed: true } })).statusCode).toBe(200);
      }
      const failed = ((await app.inject({ method: "GET", url: "/api/notifications?status=OPEN", headers })).json().notifications as Array<{ kind: string }>)
        .filter((row) => row.kind === "APP_STUDIO_FAILED");
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ severity: "ATTENTION", dedupeKey: `app-studio:failed:${pane.id}`, title: "App Studio could not finish 3 briefs",
        body: "3 briefs failed since this card was raised; the newest: Handed over 3" });
    } finally { await app.close(); }
  });

  it("raises and resolves its notifications by the pane's switches", async () => {
    const { studio, store, pane, notifications } = await service();
    const { brief } = await studio.addBrief("user:operator", pane, "Build it", "NOUS");
    const question = await studio.ask("user:operator", pane, { question: "Which name?" });
    await studio.answer("user:operator", pane, question.id, "Orbit", "NOUS");
    await studio.takeNext("user:operator", pane);
    const [shot] = await studio.savePreviews("user:operator", pane, "/", [{ deviceId: "android-360x800", bytes: pngOf(720, 1600) }]);
    await studio.finishBrief("user:operator", pane, brief.id, { failed: false, summary: "Built", items: [{ item: "Home", previewArtifactIds: [shot!.artifactId] }] });
    expect(notifications).toEqual([
      { action: "raise", key: `app-studio:question:${question.id}`, severity: "ATTENTION" },
      { action: "resolve", key: `app-studio:question:${question.id}` },
      { action: "raise", key: `app-studio:done:${brief.id}`, severity: "INFO" }]);
    const quiet = store.updateAppStudioMetadata(pane.id, { version: 1, settings: { paused: false, devices: ["android-412x915"], notifications: { needsYou: false, done: false, telegram: false } } });
    await studio.ask("user:operator", quiet, { question: "Again?" });
    expect(notifications).toHaveLength(3);
  });

  it("closes a brief DONE only with a preview per item captured after it was taken, and tells Nous each item's previews (31/10 proof gate)", async () => {
    let clock = Date.parse("2026-10-31T07:00:00.000Z");
    const root = await tempRoot();
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Alex", initialPaneCount: 0 }, "trace:alex", "user:operator");
    const pane = store.createPane({ roomId: room.id, title: "App Studio", mode: "APP_STUDIO", terminalRuntimeId: "cli:claude" });
    const notices: string[] = [];
    const studio = createAppStudioService({ repository: new InMemoryAppStudioRepository(() => new Date(clock).toISOString()), store, artifactRoot: root, now: () => clock,
      notice: (_owner, key, line) => { notices.push(`${key} ${line}`); } });
    const owner = "user:operator";
    const capture = async () => (await studio.savePreviews(owner, pane, "/plans", [{ deviceId: "android-360x800", bytes: pngOf(720, 1600) }]))[0]!.artifactId;
    const before = await capture();
    clock += 60_000;
    const { brief } = await studio.addBrief(owner, pane, "Plan colours", "NOUS");
    await studio.takeNext(owner, pane);
    clock += 60_000;
    const close = (items?: Array<{ item: string; previewArtifactIds: string[] }>) => studio.finishBrief(owner, pane, brief.id, { failed: false, summary: "plan colours YES", items });
    await expect(close()).rejects.toThrow(/is not done: A brief is done only with proof/);
    await expect(close([{ item: "Plan colours", previewArtifactIds: [] }])).rejects.toThrow(/"Plan colours" has no preview/);
    await expect(close([{ item: "Plan colours", previewArtifactIds: [before] }])).rejects.toThrow(/before this brief was taken/);
    await expect(close([{ item: "Plan colours", previewArtifactIds: ["artifact:nosuchone"] }])).rejects.toThrow(/not one of this pane's current previews/);
    const fresh = await capture();
    // The capture it replaced (same phone and screen) proves nothing any more.
    await expect(close([{ item: "Plan colours", previewArtifactIds: [before] }])).rejects.toThrow(/not one of this pane's current previews/);
    const items = [{ item: "Plan colours", previewArtifactIds: [fresh] }];
    expect(await close(items)).toMatchObject({ type: "BRIEF_DONE", payload: { briefId: brief.id, items } });
    expect((await studio.events(owner, pane)).find((event) => event.id === brief.id)).toMatchObject({ status: "DONE", payload: { items, takenAt: "2026-10-31T07:01:00.000Z" } });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(`app-studio-done:${brief.id} `);
    expect(notices[0]).toContain(`"Plan colours" → ${fresh} (web)`);
    expect(notices[0]).toContain("space_look {artifactId}");
    expect(notices[0]).toContain('"Plan colours" has only web captures');
    // A failed brief needs no proof.
    const { brief: listing } = await studio.addBrief(owner, pane, "Store listing", "NOUS");
    await expect(studio.finishBrief(owner, pane, listing.id, { failed: true, summary: "Needs the operator's Play account" })).resolves.toMatchObject({ type: "BRIEF_FAILED" });
    await expect(studio.assertReleaseProven(owner, pane)).resolves.toBeUndefined();
  });

  it("files a lab-emulator capture of the APK as an APK preview and tells Nous which items only web captures show (plan clipboard:VWt5sAXmYwgI)", async () => {
    let clock = Date.parse("2026-10-31T07:00:00.000Z");
    const root = await tempRoot();
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Alex", initialPaneCount: 0 }, "trace:alex", "user:operator");
    const pane = store.createPane({ roomId: room.id, title: "App Studio", mode: "APP_STUDIO", terminalRuntimeId: "cli:claude" });
    const notices: string[] = [];
    const studio = createAppStudioService({ repository: new InMemoryAppStudioRepository(() => new Date(clock).toISOString()), store, artifactRoot: root, now: () => clock,
      notice: (_owner, key, line) => { notices.push(`${key} ${line}`); } });
    const owner = "user:operator";
    const { brief } = await studio.addBrief(owner, pane, "Requests status filter", "NOUS");
    await studio.takeNext(owner, pane);
    clock += 60_000;
    const [apkShot] = await studio.savePreviews(owner, pane, "/requests", [{ deviceId: "android-412x915", bytes: pngOf(720, 1600) }], { packageName: "com.oll4.spaceapp.nous", versionName: "0.2.11" });
    const [webShot] = await studio.savePreviews(owner, pane, "/quotas", [{ deviceId: "android-360x800", bytes: pngOf(720, 1600) }]);
    expect(store.getArtifact(apkShot!.artifactId).metadata).toMatchObject({ capturedFrom: "APK", packageName: "com.oll4.spaceapp.nous", versionName: "0.2.11", route: "/requests" });
    expect(store.getArtifact(webShot!.artifactId).metadata).toMatchObject({ capturedFrom: "WEB" });
    expect((await studio.events(owner, pane)).find((event) => event.type === "PREVIEW" && event.payload.route === "/requests"))
      .toMatchObject({ message: "Preview of /requests on 1 device (APK com.oll4.spaceapp.nous 0.2.11 on the lab emulator)", payload: { source: "APK" } });
    await studio.finishBrief(owner, pane, brief.id, { failed: false, summary: "Status filter and quotas",
      items: [{ item: "Status filter", previewArtifactIds: [apkShot!.artifactId] }, { item: "Quota red icon", previewArtifactIds: [webShot!.artifactId] }] });
    expect(notices[0]).toContain(`"Status filter" → ${apkShot!.artifactId} (APK); "Quota red icon" → ${webShot!.artifactId} (web)`);
    expect(notices[0]).toContain('"Quota red icon" has only web captures');
    expect(notices[0]).not.toContain('"Status filter" has only');
    expect(notices[0]).toContain("space-app-studio-apk-proof.mjs");
  });

  it("keeps the newest twenty routes and unpins the previews it drops", async () => {
    let clock = Date.parse("2026-10-19T10:00:00.000Z");
    const { studio, store, pane } = await service({ now: () => (clock += 1000) });
    const saved = [];
    for (let index = 0; index < 21; index += 1) saved.push((await studio.savePreviews("user:operator", pane, `/screen-${index}`, [{ deviceId: "android-360x800", bytes: pngOf(720, 1600) }]))[0]!);
    const routes = (await studio.previews("user:operator", pane)).map((row) => row.route);
    expect(routes).toHaveLength(20);
    expect(routes).not.toContain("/screen-0");
    expect(store.getArtifact(saved[0]!.artifactId)).toMatchObject({ pinnedAt: null, expiresAt: expect.any(String) });
    expect(store.getArtifact(saved[20]!.artifactId).pinnedAt).not.toBeNull();
  });
});
