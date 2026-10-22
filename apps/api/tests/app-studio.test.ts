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

async function fixture() {
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
  const app = await createApp({ store, config, eventBus, jobApplyMailTriage: false, marketingCopilotScheduler: false, appStudioKickoff: async (pane) => { kickoffs.push(pane.id); },
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

      const asked = (await app.inject({ method: "POST", url: `${cli}/ask`, headers: agent, payload: { question: "Light or dark theme?", options: ["Light", "Dark"] } })).json();
      const pending = (await app.inject({ method: "GET", url: "/api/notifications?status=OPEN", headers })).json().notifications as Array<{ source: string; kind: string; severity: string }>;
      expect(pending).toContainEqual(expect.objectContaining({ source: "APP_STUDIO", kind: "APP_STUDIO_QUESTION", severity: "ATTENTION" }));
      const answerUrl = `${url}/questions/${encodeURIComponent(asked.question.id)}/answer`;
      expect((await app.inject({ method: "POST", url: answerUrl, headers, payload: { answer: "Dark" } })).json().question).toMatchObject({ status: "ANSWERED", payload: { answer: "Dark", answeredBy: "OPERATOR" } });
      expect((await app.inject({ method: "POST", url: answerUrl, headers, payload: { answer: "Light" } })).statusCode).toBe(409);
      expect((await app.inject({ method: "POST", url: `${cli}/questions/${encodeURIComponent(asked.question.id)}/wait`, headers: agent, payload: { waitMs: 0 } })).json()).toEqual({ answered: true, answer: "Dark" });
      expect(((await app.inject({ method: "GET", url: "/api/notifications?status=OPEN", headers })).json().notifications as Array<{ kind: string }>).some((row) => row.kind === "APP_STUDIO_QUESTION")).toBe(false);

      await app.inject({ method: "POST", url: `${cli}/note`, headers: agent, payload: { message: "Created the Expo project" } });
      const done = await app.inject({ method: "POST", url: `${cli}/briefs/${encodeURIComponent(created.brief.id)}/done`, headers: agent, payload: { summary: "Todo list and settings screens" } });
      expect(done.json().event).toMatchObject({ type: "BRIEF_DONE", payload: { briefId: created.brief.id } });
      expect((await app.inject({ method: "POST", url: `${cli}/briefs/${encodeURIComponent(created.brief.id)}/done`, headers: agent, payload: { summary: "again" } })).statusCode).toBe(409);
      expect((await app.inject({ method: "POST", url: `${cli}/next`, headers: agent, payload: {} })).json()).toMatchObject({ done: true });

      const state = (await app.inject({ method: "GET", url: `${url}/state`, headers })).json();
      expect(state.run).toEqual({ status: "IDLE", paused: false, openQuestions: 0, pendingBriefs: 0 });
      expect(state.events.map((event: { type: string }) => event.type).sort()).toEqual(["ANSWERED", "BRIEF", "BRIEF_DONE", "NOTE", "QUESTION"]);
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
      expect(all.json().previews).toHaveLength(10);
      expect((await upload({ route: "/" }, [["iphone-414x896", pngOf(828, 1792)]])).statusCode).toBe(409);
      expect((await upload({ route: "/" }, [["iphone-402x874", Buffer.from("<html></html>")]])).statusCode).toBe(409);
      expect((await upload({ route: "/../etc" }, [["iphone-402x874", pngOf(804, 1748)]])).statusCode).toBe(409);
      const shell = store.createPane({ roomId: room.id, title: "Claude CLI", mode: "TERMINAL", terminalRuntimeId: "cli:claude" });
      expect((await upload({ route: "/" }, [["iphone-402x874", pngOf(804, 1748)]], tokenFor(shell.id))).statusCode).toBe(409);
      expect((await app.inject({ method: "GET", url: `${cli}/devices`, headers: tokenFor(pane.id) })).json()).toMatchObject({ selected: ["android-412x915", "iphone-402x874"], devices: expect.arrayContaining([expect.objectContaining({ id: "iphone-440x956" })]) });
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
    const repository = new InMemoryAppStudioRepository(options.now ? () => new Date(options.now!()).toISOString() : undefined);
    const studio = createAppStudioService({ repository, store, artifactRoot: root, now: options.now,
      kickoff: { ready: async () => options.ready ?? true, send: async (target: Pane) => { kickoffs.push(target.id); } },
      notifications: { raise: async (input) => { notifications.push({ action: "raise", key: input.dedupeKey!, severity: input.severity }); return {} as never; },
        resolve: async (_owner, key) => { notifications.push({ action: "resolve", key }); return 1; } } });
    return { store, pane, studio, notifications, kickoffs };
  }

  it("types the kickoff only into an idle pane at an empty prompt, at most once a minute", async () => {
    let clock = Date.parse("2026-10-19T10:00:00.000Z");
    const busy = await service({ ready: false });
    expect((await busy.studio.addBrief("user:operator", busy.pane, "One", "NOUS")).kickoffSent).toBe(false);
    const { studio, pane, kickoffs } = await service({ now: () => clock });
    expect((await studio.addBrief("user:operator", pane, "One", "NOUS")).kickoffSent).toBe(true);
    expect((await studio.addBrief("user:operator", pane, "Two", "OPERATOR")).kickoffSent).toBe(false);
    clock += 61_000;
    await studio.takeNext("user:operator", pane);
    // The agent works on a brief: a new one waits for its loop.
    expect((await studio.addBrief("user:operator", pane, "Three", "OPERATOR")).kickoffSent).toBe(false);
    expect(kickoffs).toEqual([pane.id]);
  });

  it("raises and resolves its notifications by the pane's switches", async () => {
    const { studio, store, pane, notifications } = await service();
    const { brief } = await studio.addBrief("user:operator", pane, "Build it", "NOUS");
    const question = await studio.ask("user:operator", pane, { question: "Which name?" });
    await studio.answer("user:operator", pane, question.id, "Orbit", "NOUS");
    await studio.takeNext("user:operator", pane);
    await studio.finishBrief("user:operator", pane, brief.id, { failed: false, summary: "Built" });
    expect(notifications).toEqual([
      { action: "raise", key: `app-studio:question:${question.id}`, severity: "ATTENTION" },
      { action: "resolve", key: `app-studio:question:${question.id}` },
      { action: "raise", key: `app-studio:done:${brief.id}`, severity: "INFO" }]);
    const quiet = store.updateAppStudioMetadata(pane.id, { version: 1, settings: { paused: false, devices: ["android-412x915"], notifications: { needsYou: false, done: false, telegram: false } } });
    await studio.ask("user:operator", quiet, { question: "Again?" });
    expect(notifications).toHaveLength(3);
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
