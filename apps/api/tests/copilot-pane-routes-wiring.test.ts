import { afterEach, describe, expect, it, vi } from "vitest";
import { cookieName, signSession } from "../src/auth.js";

const { captured, rec } = vi.hoisted(() => {
  const captured = { order: [] as string[], args: {} as Record<string, unknown[]>, notifies: true, notified: [] as unknown[], started: [] as unknown[] };
  const rec = (name: string, result?: unknown) => (...args: unknown[]) => { captured.order.push(name); captured.args[name] = args; return result; };
  return { captured, rec };
});
vi.mock("../src/notifications/browser-handoff.js", async (orig) => ({ ...await orig<object>(), startBrowserHandoffNotifications: rec("handoffNotices", () => { captured.order.push("handoffNoticesStop"); }) }));
vi.mock("../src/appointments.js", async (orig) => ({ ...await orig<object>(), registerAppointments: rec("appointments") }));
vi.mock("../src/signatures.js", async (orig) => ({ ...await orig<object>(), registerSignatures: rec("signatures") }));
vi.mock("../src/job-apply-wiring.js", async (orig) => ({ ...await orig<object>(), registerJobApply: rec("jobApply", { jobApplyRepository: "job-repo", jobApplyService: "job-service" }) }));
vi.mock("../src/mail-copilot/kickoff.js", async (orig) => ({ ...await orig<object>(), createMailCopilotKickoff: rec("mailKickoff", { send: "kickoff-send" }) }));
vi.mock("../src/mail-copilot/service.js", async (orig) => ({ ...await orig<object>(), createMailCopilotService: rec("mailService", {
  thread: async () => ({ messages: [{ from: "a@x.test", to: ["b@x.test"], cc: ["c@x.test"] }, { from: "d@x.test", to: [], cc: [] }] }) }) }));
vi.mock("../src/mail-copilot/notify.js", async (orig) => ({ ...await orig<object>(), mailCopilotEventNotifies: () => captured.notifies,
  notifyMailCopilotEvent: async (event: unknown, input: unknown) => { captured.notified.push({ event, input }); } }));
vi.mock("../src/notifications/routes.js", async (orig) => ({ ...await orig<object>(), registerNotificationRoutes: rec("notificationRoutes") }));
vi.mock("../src/mail-copilot/sync.js", async (orig) => ({ ...await orig<object>(), createMailCopilotSync: rec("mailSync", {
  start: () => { captured.order.push("syncStart"); }, stop: () => { captured.order.push("syncStop"); } }) }));
vi.mock("../src/gateway/gateway-codex-services.js", async (orig) => ({ ...await orig<object>(), registerCodexQuotaResetWatch: rec("quotaWatch") }));
vi.mock("../src/gateway/gateway-down-watch.js", async (orig) => ({ ...await orig<object>(), registerGatewayDownWatch: rec("gatewayWatch") }));
vi.mock("../src/memory-maintenance-watch.js", async (orig) => ({ ...await orig<object>(), registerMemoryMaintenanceFailureWatch: rec("memoryWatch") }));
vi.mock("../src/mail-copilot/routes.js", async (orig) => ({ ...await orig<object>(), registerMailCopilotRoutes: rec("mailRoutes") }));
vi.mock("../src/marketing-copilot/wiring.js", async (orig) => ({ ...await orig<object>(), registerMarketingCopilot: rec("marketing", {
  getPost: async (_owner: string, postId: string) => postId === "mktpost-0001" ? { id: postId } : Promise.reject(new Error("missing")),
  attachAssets: async (...args: unknown[]) => { captured.order.push(`attach:${JSON.stringify(args)}`); } }) }));
vi.mock("../src/freelance-copilot/wiring.js", async (orig) => ({ ...await orig<object>(), registerFreelanceCopilot: rec("freelance", "freelance-service") }));
vi.mock("../src/design/wiring.js", async (orig) => ({ ...await orig<object>(), registerDesign: rec("design", "design-service") }));
vi.mock("../src/app-studio/wiring.js", async (orig) => ({ ...await orig<object>(), registerAppStudio: rec("appStudio", "app-studio-service") }));
vi.mock("../src/security-copilot/wiring.js", async (orig) => ({ ...await orig<object>(), registerSecurityCopilot: rec("security", "security-service") }));
vi.mock("../src/monitoring-copilot/wiring.js", async (orig) => ({ ...await orig<object>(), registerMonitoringCopilot: rec("monitoring", "monitoring-service") }));
vi.mock("../src/mail-campaigns/wiring.js", async (orig) => ({ ...await orig<object>(), registerMailCampaigns: rec("mailCampaigns", "campaigns-service") }));
vi.mock("../src/video/wiring.js", async (orig) => ({ ...await orig<object>(), registerVideo: rec("video", "video-service") }));
vi.mock("../src/make-app-routes.js", async (orig) => ({ ...await orig<object>(), registerMakeAppRoutes: rec("makeApp") }));
vi.mock("../src/nous/copilot-control.js", async (orig) => ({ ...await orig<object>(), startPaneCli: async (deps: unknown, owner: string, pane: unknown) => { captured.started.push({ deps, owner, pane }); return "started"; } }));

const { registerCopilotPaneRoutes } = await import("../src/copilot-pane-routes-wiring.js");

const secret = "s".repeat(32);
const owner = { id: "user:owner01", email: "owner@space.local", role: "ADMIN" as const };
const ALL = ["mail-copilot", "marketing-copilot", "freelance-copilot", "design", "app-studio", "security-copilot", "monitoring-copilot", "mail-campaigns", "video"];
afterEach(() => { Object.assign(captured, { order: [], args: {}, notifies: true, notified: [], started: [] }); });

type Hook = () => Promise<unknown> | unknown;
function wire(input: { modules?: string[]; jobs?: Record<string, boolean>; options?: Record<string, unknown>; panes?: Record<string, unknown> } = {}) {
  const hooks: Record<string, Hook[]> = { onClose: [], onReady: [] };
  const published: unknown[] = [];
  const audits: unknown[] = [];
  const disposed: string[] = [];
  const roomAccess: string[] = [];
  const paneReads: string[] = [];
  const app = { log: { warn: () => {}, info: () => {} }, addHook: (name: string, hook: Hook) => { hooks[name]!.push(hook); } };
  const deps = {
    store: {
      getPane: async (id: string) => { paneReads.push(id); const pane = (input.panes ?? {})[id]; if (!pane) throw new Error("no pane"); return pane; },
      upsertUser: async (user: { id: string }) => ({ id: `${user.id}:stored` }), recordAuditEvent: async (event: unknown) => { audits.push(event); }
    },
    config: { databaseUrl: undefined, optionalModules: new Set(input.modules ?? ALL), instanceJobs: { "mail-copilot-sync": true, ...input.jobs },
      memoryGraphEnabled: true, memoryMaintenanceEnabled: true, gatewayUrl: "http://gateway.test", temporalAddress: "t:7233", temporalNamespace: "space",
      browserEvidenceArtifactRoot: "/tmp/artifacts", connectorKeyFile: "/missing/connector.key", designGatewayKeyFile: "/missing/design.key",
      videoWorkRoot: "/tmp/video", videoToolsDir: "/tmp/tools", videoSourceMaxBytes: 1 },
    auth: { sessionSecret: secret },
    eventBus: { publish: (event: unknown) => { published.push(event); } },
    options: { mailCopilotRepository: { dispose: () => { disposed.push("mail"); } }, mailCopilotKickoff: "options-kickoff", ...input.options },
    defaultRouteRateLimitOptions: { config: { rateLimit: 1 } }, connectorCrypto: { crypto: true }, connectorServiceRef: { current: "connector" },
    notificationsRepository: { dispose: async () => { disposed.push("notifications"); } }, notificationService: { resolve: () => {} },
    notificationPrune: setInterval(() => {}, 3_600_000).unref(), stopMorningBatches: () => { disposed.push("morning"); }, stopNotificationProducers: () => { disposed.push("producers"); },
    roomOwner: async (roomId: string) => roomId === "room:owned01" ? "user:owner01" : null, telegramIntegrationManager: { notify: () => {} },
    roomPaneController: { inspect: async () => ({}), start: async () => ({}) }, cliTerminalManager: { terminal: true },
    assertRoomAccess: async (roomId: string) => { roomAccess.push(roomId); return {}; },
    nousRef: { current: { service: { notice: (...args: unknown[]) => { captured.order.push(`notice:${JSON.stringify(args)}`); } } } },
    railCli: { start: "rail-start" }, controlInvoke: "control-invoke", toolbarUsageProvider: "usage", reopenClosedPane: "reopen", taskBrief: { current: null },
    vault: { repository: "vault-store-at-call" as unknown }
  };
  const result = registerCopilotPaneRoutes(app as never, deps as never);
  return { result, hooks, published, audits, disposed, roomAccess, paneReads, deps };
}
const arg = (name: string, index = 1) => captured.args[name]![index] as Record<string, never>;
const fn = <T = unknown>(value: unknown) => value as (...args: unknown[]) => Promise<T>;
const request = (user: unknown, cookie?: string) => ({ user, cookies: cookie ? { [cookieName]: cookie } : {} });

describe("copilot pane routes wiring (ARCH-001 step 77)", () => {
  it("registers in app.ts's order and returns the services app.ts reads afterwards", () => {
    const { result } = wire();
    expect(captured.order).toEqual(["handoffNotices", "appointments", "signatures", "jobApply", "mailKickoff", "mailService", "notificationRoutes", "mailSync", "quotaWatch",
      "gatewayWatch", "memoryWatch", "mailRoutes", "marketing", "freelance", "design", "appStudio", "security", "monitoring", "mailCampaigns", "video", "makeApp"]);
    expect(result).toMatchObject({ jobApplyRepository: "job-repo", jobApplyService: "job-service", freelanceCopilotService: "freelance-service",
      designService: "design-service", appStudioService: "app-studio-service", securityCopilotService: "security-service",
      monitoringCopilotService: "monitoring-service", mailCampaignsService: "campaigns-service", videoService: "video-service" });
    expect(result.paneBrowserAccounts).toEqual({ current: null });
    expect(arg("marketing").paneBrowserAccounts).toBe(result.paneBrowserAccounts);
    expect(arg("mailRoutes", 1)).toBe(result.mailCopilotService);
    expect(arg("mailRoutes", 2).kickoff).toBe("kickoff-send");
    expect(arg("jobApply").telegramIntegrationManager).toBeDefined();
    expect(arg("signatures").routeOptions).toEqual({ config: { rateLimit: 1 } });
    expect(typeof arg("makeApp").brief()).toBe("function");
  });

  it("skips every optional pane module that is off", () => {
    const { result } = wire({ modules: [] });
    expect(captured.order).toEqual(["handoffNotices", "appointments", "signatures", "jobApply", "mailKickoff", "mailService", "notificationRoutes", "mailSync", "quotaWatch", "gatewayWatch", "memoryWatch", "makeApp"]);
    expect([result.marketingCopilotService, result.freelanceCopilotService, result.designService, result.appStudioService, result.securityCopilotService,
      result.monitoringCopilotService, result.mailCampaignsService, result.videoService]).toEqual(Array(8).fill(undefined));
  });

  it("closes the notification and mail stores, timers and sync, and starts the sync only with its job, module and option", async () => {
    const wired = wire();
    for (const hook of wired.hooks.onReady!) await hook();
    expect(captured.order).toContain("syncStart");
    for (const hook of wired.hooks.onClose!) await hook();
    expect(wired.disposed).toEqual(["notifications", "morning", "producers", "mail"]);
    expect(captured.order).toEqual(expect.arrayContaining(["handoffNoticesStop", "syncStop"]));
    for (const off of [{ jobs: { "mail-copilot-sync": false } }, { modules: [] }, { options: { mailCopilotSync: false } }]) {
      captured.order = [];
      const other = wire(off);
      for (const hook of other.hooks.onReady!) await hook();
      expect(captured.order).not.toContain("syncStart");
    }
  });

  it("publishes Mail Copilot events to the pane's room and notifies the room owner only for a Mail Copilot pane", async () => {
    const pane = { id: "pane:mail0001", roomId: "room:owned01", mode: "MAIL_COPILOT" };
    const wired = wire({ panes: { "pane:mail0001": pane, "pane:term0001": { id: "pane:term0001", roomId: "room:owned01", mode: "TERMINAL" } } });
    const onEvent = (arg("mailService", 0) as unknown as { onEvent: (event: unknown) => void }).onEvent;
    const event = { id: "mcev-0001", paneId: "pane:mail0001", type: "MAIL_RECEIVED", message: "New mail", threadId: "t1", accountEmail: "me@x.test", createdAt: "2026-11-01T00:00:00.000Z" };
    onEvent(event); await vi.waitFor(() => expect(captured.notified).toHaveLength(1));
    expect(wired.published[0]).toMatchObject({ roomId: "room:owned01", paneId: "pane:mail0001", type: "MAIL_COPILOT_UPDATED", traceId: "mail-copilot:mcev-0001",
      payload: { eventId: "mcev-0001", type: "MAIL_RECEIVED", threadId: "t1", accountEmail: "me@x.test" } });
    expect(captured.notified[0]).toMatchObject({ event, input: { roomId: "room:owned01", pane, owner: "user:owner01" } });
    captured.notifies = false;
    onEvent({ ...event, id: "mcev-0002" }); await vi.waitFor(() => expect(wired.published).toHaveLength(2));
    expect(wired.paneReads).toEqual(["pane:mail0001"]);
    captured.notifies = true;
    onEvent({ ...event, id: "mcev-0003", paneId: "pane:term0001" }); await vi.waitFor(() => expect(wired.published).toHaveLength(3));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(captured.notified).toHaveLength(1);
    onEvent({ ...event, id: "mcev-0004", paneId: null });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(wired.published).toHaveLength(3);
  });

  it("starts a Mail Copilot pane's CLI as its room owner and marks urgent notices soon", async () => {
    wire();
    const pane = { id: "pane:mail0001", roomId: "room:owned01" };
    await fn((arg("mailKickoff", 0) as unknown as { start: unknown }).start)(pane);
    expect(captured.started[0]).toMatchObject({ deps: { invoke: "control-invoke", start: "rail-start" }, owner: "user:owner01", pane });
    await fn((arg("mailKickoff", 0) as unknown as { start: unknown }).start)({ id: "pane:mail0002", roomId: "room:other01" });
    expect(captured.started[1]).toMatchObject({ owner: "" });
    expect((arg("mailKickoff", 0) as unknown as { send: unknown }).send).toBe("options-kickoff");
    const notice = (arg("mailService", 0) as unknown as { notice: (...args: unknown[]) => void }).notice;
    notice("user:owner01", "important-mail:x", "Mail", true);
    notice("user:owner01", "plain", "Mail", false);
    expect(captured.order.filter((entry) => entry.startsWith("notice:"))).toEqual([
      `notice:${JSON.stringify(["user:owner01", "important-mail:x", "Mail", undefined, { soonMs: 5_000 }])}`,
      `notice:${JSON.stringify(["user:owner01", "plain", "Mail", undefined, {}])}`]);
  });

  it("the notification, Mail Copilot and copilot pane routes take a signed session, the room's access and their own audit target", async () => {
    const wired = wire();
    const cookie = signSession(owner, secret);
    const routes: Array<[Record<string, unknown>, string]> = [[arg("notificationRoutes", 2), "Sign in to read notifications."],
      [arg("mailRoutes", 2), "Sign in to use Mail Copilot."], [arg("marketing"), "Sign in to use Marketing Copilot."],
      [arg("design"), "Sign in to use the Design pane."], [arg("video"), "Sign in to use the Video pane."], [arg("mailCampaigns"), "Sign in to use Mail Campaigns."]];
    for (const [deps, message] of routes) {
      await expect(fn(deps.authenticatedOwner)(request(owner, cookie))).resolves.toBe("user:owner01:stored");
      await expect(fn(deps.authenticatedOwner)(request(owner))).rejects.toMatchObject({ code: "UNAUTHENTICATED", statusCode: 401, message });
    }
    await fn(arg("security").assertPaneAccess)({ user: owner }, { roomId: "room:sec00001" });
    await fn(arg("mailRoutes", 2).assertPaneAccess)({ user: owner }, { roomId: "room:mail0001" });
    expect(wired.roomAccess).toEqual(["room:sec00001", "room:mail0001"]);
    await fn(arg("monitoring").audit)({ user: owner }, "monitoring.check", "pane:mon00001", { ok: true });
    await fn(arg("mailRoutes", 2).audit)({ user: owner }, "mail.send", "mailrev-0001", { ok: true });
    expect(wired.audits).toEqual([expect.objectContaining({ action: "monitoring.check", targetType: "monitoring_copilot", targetId: "pane:mon00001" }),
      expect.objectContaining({ action: "mail.send", targetType: "mail_copilot", targetId: "mailrev-0001" })]);
  });

  it("Mail Campaigns reads the Vault late, falls back to the session secret and lists a thread's participants", async () => {
    const wired = wire();
    const campaigns = arg("mailCampaigns") as unknown as { vaultStore: () => unknown; unsubscribeSecret: string; google: () => unknown; threadParticipants: (...args: unknown[]) => Promise<string[]> };
    wired.deps.vault.repository = "vault-store-later";
    expect(campaigns.vaultStore()).toBe("vault-store-later");
    expect(campaigns.unsubscribeSecret).toBe(secret);
    expect(campaigns.google()).toBe("connector");
    await expect(campaigns.threadParticipants("user:owner01", "me@x.test", "thread-01")).resolves.toEqual(["a@x.test", "b@x.test", "c@x.test", "d@x.test"]);
  });

  it("Design and Video reach Marketing posts only when Marketing is on", async () => {
    wire();
    for (const name of ["design", "video"]) {
      await expect(fn(arg(name).marketingPostExists)("user:owner01", "mktpost-0001")).resolves.toBe(true);
      await expect(fn(arg(name).marketingPostExists)("user:owner01", "mktpost-none")).resolves.toBe(false);
      await fn(arg(name).attachToMarketingPost)("user:owner01", "mktpost-0001", ["asset"]);
    }
    expect(captured.order.filter((entry) => entry.startsWith("attach:"))).toHaveLength(2);
    captured.order = [];
    wire({ modules: ["design", "video"] });
    expect(arg("design").marketingPostExists).toBeUndefined();
    expect(arg("video").attachToMarketingPost).toBeUndefined();
  });
});
