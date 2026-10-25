import { createVerify, generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eventSchema, type Event } from "@space/contracts";
import { InMemorySpaceNotificationsRepository } from "@space/db";
import { InMemorySpaceStore, SpaceEventBus, makeSpaceId } from "@space/runtime";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { createFcmSender, loadFcmServiceAccount, type FcmSender } from "../src/notifications/fcm.js";
import { createNotificationService } from "../src/notifications/service.js";

vi.setConfig({ testTimeout: 30_000 });
const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(options: { telegram?: boolean; push?: FcmSender | null; seed?: (store: InMemorySpaceStore, repository: InMemorySpaceNotificationsRepository) => Promise<void> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "space-notifications-"));
  temporaryRoots.push(root);
  const wrapper = join(root, "codex-vscode-parity");
  await writeFile(wrapper, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(wrapper, 0o755);
  const config = getApiConfig({ SPACE_CLI_ENABLED: "true", SPACE_CLI_COMMAND_PATH: root, SPACE_CLI_HOST_SOCKET: join(root, "pane-host.sock"), SPACE_CLI_CODEX_CREDENTIAL_SMOKE: "true",
    SPACE_CLI_WORKSPACE_ROOT: join(root, "workspaces"), SPACE_ARTIFACT_ROOT: root });
  const store = new InMemorySpaceStore();
  const eventBus = new SpaceEventBus();
  const published: Event[] = [];
  eventBus.subscribe((event) => { if (event.type.startsWith("NOTIFICATION_")) published.push(event); });
  const notificationsRepository = new InMemorySpaceNotificationsRepository(undefined, options.telegram ?? false);
  await options.seed?.(store, notificationsRepository);
  const app = await createApp({ store, config, eventBus, notificationsRepository, notificationPush: options.push ?? null, jobApplyMailTriage: false,
    auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false } });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
  const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
  const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
  const headers = { cookie, "x-space-csrf-token": csrf.json().csrfToken as string };
  const room = (await app.inject({ method: "POST", url: "/api/rooms", headers, payload: { name: "Notify", initialPaneCount: 0 } })).json() as { id: string; ownerUserId: string };
  const pane = store.createPane({ roomId: room.id, title: "Browser", mode: "BROWSER" });
  return { app, store, eventBus, published, notificationsRepository, headers, room, pane };
}

describe("Space notifications", () => {
  it("raises, dedupes, lists, counts, reads and acknowledges the owner's notifications; the stream carries ids only", async () => {
    const { app, headers, room, pane, published, eventBus } = await fixture();
    // A browser handoff in the room becomes a notification for the room's owner (bridged from the event bus).
    eventBus.publish(eventSchema.parse({ id: makeSpaceId("event"), roomId: room.id, paneId: pane.id, turnId: null, workflowId: null, traceId: "trace:handoff-1", type: "BROWSER_HANDOFF_REQUESTED",
      message: "CAPTCHA on the form", payload: {}, createdAt: new Date().toISOString() }));
    await vi.waitFor(async () => expect((await app.inject({ method: "GET", url: "/api/notifications/pending", headers })).json().total).toBe(1));
    const pending = (await app.inject({ method: "GET", url: "/api/notifications/pending", headers })).json();
    expect(pending.byRoom).toEqual({ [room.id]: 1 });
    expect(pending.byPane).toEqual({ [pane.id]: 1 });
    expect(pending.bySource).toEqual({ BROWSER_HANDOFF: 1 });
    const first = pending.latest[0];
    expect(first).toMatchObject({ source: "BROWSER_HANDOFF", kind: "BROWSER_HANDOFF_REQUESTED", severity: "ATTENTION", title: "The browser needs you", body: "CAPTCHA on the form",
      link: { roomId: room.id, paneId: pane.id }, dedupeKey: `browser-handoff:${pane.id}`, status: "OPEN" });
    expect(published[0]).toMatchObject({ type: "NOTIFICATION_CREATED", roomId: room.id, paneId: pane.id, payload: { notificationId: first.id, ownerUserId: room.ownerUserId, source: "BROWSER_HANDOFF", status: "OPEN" } });
    expect(published[0]!.payload).not.toHaveProperty("title");
    // The same handoff again refreshes the open notification instead of adding another.
    eventBus.publish(eventSchema.parse({ id: makeSpaceId("event"), roomId: room.id, paneId: pane.id, turnId: null, workflowId: null, traceId: "trace:handoff-2", type: "BROWSER_HANDOFF_REQUESTED",
      message: "Login wall", payload: {}, createdAt: new Date().toISOString() }));
    await vi.waitFor(() => expect(published.some((event) => event.type === "NOTIFICATION_UPDATED")).toBe(true));
    const list = (await app.inject({ method: "GET", url: "/api/notifications?status=ALL&limit=10", headers })).json();
    expect(list.notifications).toHaveLength(1);
    expect(list.notifications[0]).toMatchObject({ id: first.id, body: "Login wall" });
    // Read, then acknowledge; a watchdog alert is URGENT and counts again.
    expect((await app.inject({ method: "POST", url: `/api/notifications/${first.id}/read`, headers })).json().notification.status).toBe("READ");
    expect((await app.inject({ method: "GET", url: "/api/notifications/pending", headers })).json().total).toBe(0);
    // One record by id (a native notification tap): the owner's own, never another id.
    const byId = await app.inject({ method: "GET", url: `/api/notifications/${encodeURIComponent(pending.latest[0].id)}`, headers });
    expect(byId.statusCode).toBe(200);
    expect(byId.json().notification.id).toBe(pending.latest[0].id);
    expect((await app.inject({ method: "GET", url: "/api/notifications/notification%3Anope00000000", headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/notifications/${first.id}/ack`, headers })).json().notification).toMatchObject({ status: "ACKED", ackedAt: expect.any(String) });
    eventBus.publish(eventSchema.parse({ id: makeSpaceId("event"), roomId: room.id, paneId: null, turnId: null, workflowId: null, traceId: "trace:watchdog-3", type: "ROOM_WATCHDOG_ALERT",
      message: "Pane host unreachable", payload: {}, createdAt: new Date().toISOString() }));
    await vi.waitFor(async () => expect((await app.inject({ method: "GET", url: "/api/notifications/pending", headers })).json().latest[0]).toMatchObject({ source: "ROOM_WATCHDOG", severity: "URGENT" }));
    expect((await app.inject({ method: "POST", url: "/api/notifications/read-all", headers })).json().read).toBe(1);
    expect((await app.inject({ method: "GET", url: "/api/notifications?status=OPEN", headers })).json().notifications).toEqual([]);
    expect((await app.inject({ method: "POST", url: "/api/notifications/notification:missing00/read", headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/notifications/pending" })).statusCode).toBe(401);
    await app.close();
  });

  it("sends a test notification and queues Telegram only for what needs the user, per the user's channels, never while notifications are suppressed", async () => {
    const { app, headers, notificationsRepository } = await fixture({ telegram: true });
    const test = (await app.inject({ method: "POST", url: "/api/notifications/test", headers })).json().notification;
    expect(test).toMatchObject({ source: "SYSTEM", kind: "TEST", severity: "ATTENTION", title: "Test notification" });
    expect(notificationsRepository.telegram.map((entry) => entry.id)).toEqual([test.id]);
    // Telegram off for SYSTEM: the next test notification stays in-app.
    await app.inject({ method: "PATCH", url: "/api/user-settings", headers, payload: { notifications: { channels: {}, perSource: { SYSTEM: { telegram: false } } } } });
    const second = (await app.inject({ method: "POST", url: "/api/notifications/test", headers })).json().notification;
    expect(notificationsRepository.telegram.map((entry) => entry.id)).toEqual([test.id]);
    expect(second.id).not.toBe(test.id);
    // Suppressed: nothing leaves the Center.
    await app.inject({ method: "PATCH", url: "/api/user-settings", headers, payload: { notifications: null, suppressNotifications: true } });
    await app.inject({ method: "POST", url: "/api/notifications/test", headers });
    expect(notificationsRepository.telegram).toHaveLength(1);
    await app.close();
  });

  it("resolves a browser handoff notification whose handoff is over: the ones left open when the API starts, and on a closed pane's event", async () => {
    let leftover = "";
    const { app, store, notificationsRepository, eventBus, room, pane, headers } = await fixture({ seed: async (seedStore, repository) => {
      // Left open by an earlier API: its pane never had an active handoff.
      const old = seedStore.createPane({ roomId: seedStore.createRoom({ name: "Earlier", initialPaneCount: 0 }).id, title: "Browser", mode: "BROWSER" });
      leftover = (await repository.raise({ ownerUserId: "user:earlier", roomId: old.roomId, paneId: old.id, source: "BROWSER_HANDOFF", kind: "BROWSER_HANDOFF_REQUESTED", severity: "ATTENTION",
        title: "The browser needs you", body: "", link: {}, dedupeKey: `browser-handoff:${old.id}`, payload: {}, telegram: null })).notification.id;
    } });
    try {
      await vi.waitFor(async () => expect((await notificationsRepository.get("user:earlier", leftover))?.status).toBe("RESOLVED"));
      eventBus.publish(eventSchema.parse({ id: makeSpaceId("event"), roomId: room.id, paneId: pane.id, turnId: null, workflowId: null, traceId: "trace:handoff-2", type: "BROWSER_HANDOFF_REQUESTED",
        message: "Sign in", payload: {}, createdAt: new Date().toISOString() }));
      await vi.waitFor(async () => expect((await app.inject({ method: "GET", url: "/api/notifications/pending", headers })).json().byRoom).toEqual({ [room.id]: 1 }));
      store.updatePane(pane.id, { isClosed: true, status: "CLOSED" });
      eventBus.publish(eventSchema.parse({ id: makeSpaceId("event"), roomId: room.id, paneId: pane.id, turnId: null, workflowId: null, traceId: "trace:close", type: "PANE_CLOSED",
        message: "Pane closed.", payload: {}, createdAt: new Date().toISOString() }));
      await vi.waitFor(async () => expect((await app.inject({ method: "GET", url: "/api/notifications/pending", headers })).json().total).toBe(0));
      expect((await app.inject({ method: "GET", url: "/api/notifications?status=ALL", headers })).json().notifications[0]).toMatchObject({ source: "BROWSER_HANDOFF", status: "RESOLVED" });
    } finally {
      await app.close();
    }
  });

  it("the service keeps INFO notifications off Telegram, honours a producer override and resolves by dedupe key", async () => {
    const repository = new InMemorySpaceNotificationsRepository(undefined, true);
    const bus = new SpaceEventBus();
    const events: Event[] = [];
    bus.subscribe((event) => events.push(event));
    const service = createNotificationService({ repository, eventBus: bus, userSettings: async () => ({ notifications: null }) as never,
      recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }) });
    const info = await service.raise({ ownerUserId: "user:1", roomId: null, paneId: null, source: "MAIL_COPILOT", kind: "MAIL_RECEIVED", severity: "INFO", title: "Anna", body: "", link: {}, dedupeKey: "mail:1", payload: {}, telegram: null });
    expect(repository.telegram).toEqual([]);
    expect(events[0]).toMatchObject({ type: "NOTIFICATION_CREATED", roomId: null, payload: { notificationId: info.id } });
    await service.raise({ ownerUserId: "user:1", roomId: null, paneId: null, source: "MAIL_COPILOT", kind: "MAIL_RECEIVED", severity: "INFO", title: "Anna", body: "", link: {}, dedupeKey: "mail:2", payload: {}, telegram: true });
    expect(repository.telegram).toHaveLength(1);
    expect(await service.resolve("user:1", "mail:1")).toBe(1);
    expect((await service.pending("user:1")).total).toBe(1);
    // An INFO notification in a room is not "Needs attention" there; an ATTENTION one is.
    await service.raise({ ownerUserId: "user:1", roomId: "room:1", paneId: "pane:1", source: "MAIL_COPILOT", kind: "MAIL_RECEIVED", severity: "INFO", title: "Anna", body: "", link: {}, dedupeKey: null, payload: {}, telegram: null });
    expect((await service.pending("user:1")).byRoom).toEqual({});
    expect((await service.pending("user:1")).byPane).toEqual({ "pane:1": 1 });
    await service.raise({ ownerUserId: "user:1", roomId: "room:1", paneId: "pane:1", source: "MAIL_COPILOT", kind: "REVIEW_REQUESTED", severity: "ATTENTION", title: "Review", body: "", link: {}, dedupeKey: null, payload: {}, telegram: null });
    expect((await service.pending("user:1")).byRoom).toEqual({ "room:1": 1 });
    expect(await service.resolve("user:1", "mail:1")).toBe(0);
  });

  it("pushes what needs the user to the owner's registered devices, per the push switches, and disables a token FCM no longer knows", async () => {
    const sent: Array<{ token: string; data: Record<string, string> }> = [];
    const push: FcmSender = { send: async (token, data) => { sent.push({ token, data }); return token.startsWith("gone") ? "INVALID_TOKEN" : "SENT"; } };
    const { app, headers, notificationsRepository } = await fixture({ push });
    const phone = `phone:${"a".repeat(40)}`;
    const gone = `gone:${"b".repeat(40)}`;
    // Session and CSRF like every other route; the token shape is checked.
    expect((await app.inject({ method: "POST", url: "/api/notifications/push-devices", payload: { token: phone } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/notifications/push-devices", headers: { cookie: headers.cookie }, payload: { token: phone } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/notifications/push-devices", headers, payload: { token: "bad token" } })).statusCode).toBe(422);
    for (const token of [phone, gone]) {
      expect((await app.inject({ method: "POST", url: "/api/notifications/push-devices", headers, payload: { token, platform: "ANDROID", appVersion: "0.1.24" } })).json()).toEqual({ registered: true, available: true });
    }
    const test = (await app.inject({ method: "POST", url: "/api/notifications/test", headers })).json().notification;
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.find((entry) => entry.token === phone)?.data).toEqual({ notificationId: test.id, title: "Space: Test notification", body: expect.stringContaining("This is how Space notifies you") });
    await vi.waitFor(async () => expect(await notificationsRepository.pushTokens(test.ownerUserId)).toEqual([phone]));
    // Push off for SYSTEM: the next test notification is not pushed.
    await app.inject({ method: "PATCH", url: "/api/user-settings", headers, payload: { notifications: { channels: {}, perSource: { SYSTEM: { push: false } } } } });
    await app.inject({ method: "POST", url: "/api/notifications/test", headers });
    expect((await app.inject({ method: "DELETE", url: "/api/notifications/push-devices", headers, payload: { token: phone } })).json()).toEqual({ removed: true });
    expect(await notificationsRepository.pushTokens(test.ownerUserId)).toEqual([]);
    expect(sent).toHaveLength(2);
    await app.close();
  });

  it("the service keeps INFO notifications off push and pushes nothing while notifications are suppressed", async () => {
    const repository = new InMemorySpaceNotificationsRepository();
    const sent: string[] = [];
    let suppress = false;
    const service = createNotificationService({ repository, eventBus: new SpaceEventBus(), userSettings: async () => ({ notifications: null, suppressNotifications: suppress }) as never,
      recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }),
      push: { send: async (_token, data) => { sent.push(data.notificationId!); return "SENT"; } } });
    await service.registerPushDevice("user:1", { token: `phone:${"c".repeat(40)}`, platform: "ANDROID", appVersion: null });
    const raise = (severity: "INFO" | "ATTENTION", key: string) => service.raise({ ownerUserId: "user:1", roomId: null, paneId: null, source: "MAIL_COPILOT", kind: "MAIL_RECEIVED", severity,
      title: "Anna", body: "", link: {}, dedupeKey: key, payload: {}, telegram: false });
    await raise("INFO", "mail:1");
    const attention = await raise("ATTENTION", "mail:2");
    await vi.waitFor(() => expect(sent).toEqual([attention.id]));
    suppress = true;
    await raise("ATTENTION", "mail:3");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual([attention.id]);
    expect(service.pushAvailable()).toBe(true);
  });

  it("the FCM sender signs the token request with the service account key, keeps the access token, and tells invalid tokens apart", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const root = await mkdtemp(join(tmpdir(), "space-fcm-"));
    temporaryRoots.push(root);
    const keyFile = join(root, "sa.secret");
    await writeFile(keyFile, JSON.stringify({ type: "service_account", project_id: "spaceapp-mobile", client_email: "fcm@spaceapp-mobile.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }) }), { mode: 0o600 });
    const account = await loadFcmServiceAccount(keyFile);
    expect(account?.project_id).toBe("spaceapp-mobile");
    expect(await loadFcmServiceAccount(null)).toBeNull();
    expect(await loadFcmServiceAccount(join(root, "missing.secret"))).toBeNull();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const replies = [new Response(JSON.stringify({ access_token: "access-1", expires_in: 3599 })), new Response("{}"),
      new Response(JSON.stringify({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }), { status: 404 }),
      new Response(JSON.stringify({ error: { status: "UNAVAILABLE" } }), { status: 503 })];
    const sender = createFcmSender(account!, { fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return replies.shift()!; }) as typeof fetch, now: () => 1_800_000_000_000 });
    expect(await sender.send("token-1", { notificationId: "notification:abc123" })).toBe("SENT");
    expect(await sender.send("token-2", { notificationId: "notification:abc123" })).toBe("INVALID_TOKEN");
    expect(await sender.send("token-3", { notificationId: "notification:abc123" })).toBe("FAILED");
    // One token request for three sends.
    expect(calls.map((call) => call.url)).toEqual(["https://oauth2.googleapis.com/token", ...Array(3).fill("https://fcm.googleapis.com/v1/projects/spaceapp-mobile/messages:send")]);
    const assertion = new URLSearchParams(String(calls[0]!.init.body)).get("assertion")!;
    const [header, claims, signature] = assertion.split(".");
    expect(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({ iss: "fcm@spaceapp-mobile.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token", iat: 1_800_000_000, exp: 1_800_003_600 });
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe("Bearer access-1");
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ message: { token: "token-1", data: { notificationId: "notification:abc123" }, android: { priority: "HIGH", ttl: "86400s" } } });
  });
});
