import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { browserCensus, browserProfileLabel, registerBrowserCensusRoutes } from "../src/browser-census-routes.js";
import { freelanceProfileKey, youtubeAccountProfileKey } from "../src/youtube-accounts.js";

const session = (paneId: string, profilePath: string, pages: unknown[], profileId = `profile:room_abcdef:${paneId.slice(5)}`) => ({
  sessionId: `browser_session:${paneId.slice(5)}`, paneId, roomId: "room:abcdef", profilePath, profileId, pages, status: "READY",
  runtimeState: "READY", capacityState: "AVAILABLE", controlState: "OPERATOR", startedAt: "t0", updatedAt: "t1", lastFrameAt: "t2"
});

function store() {
  return {
    listActivePaneBrowserSessions: vi.fn(async () => [
      session("pane:browser1", "/opt/spaceapp/var/artifacts/browser-profiles/room_abcdef/pane_browser1", [
        { pageId: "T1", url: "https://mail.example.com/inbox?token=secret#x", title: "Inbox", isActive: true },
        { pageId: "T2", url: "https://bank.example.com/login", title: "Sign in", isActive: false }
      ]),
      session("pane:copilot1", "/opt/spaceapp/var/artifacts/browser-profiles/cli-accounts/3916b5f5c837cd45fb3f50dff65e", [
        { pageId: "T3", url: "about:blank", title: null, isActive: true, account: { profileId: "p1", label: "work@example.com" } }
      ])
    ]),
    getPane: vi.fn(async (paneId: string) => ({ id: paneId, paneName: "Bob", title: "Browser 7", mode: "BROWSER", isClosed: false })),
    getActiveBrowserControlLease: vi.fn(async (sessionId: string) => sessionId.endsWith("browser1")
      ? { leaseId: "lease:1", holderType: "OPERATOR", heartbeatAt: "t3", acquiredAt: "t0" } : null),
    getActiveBrowserHandoffRequest: vi.fn(async (sessionId: string) => sessionId.endsWith("copilot1")
      ? { status: "REQUESTED", requestedAt: "t4", reason: "CAPTCHA: secret" } : null),
    getRoom: vi.fn(async () => ({ ownerUserId: "user:operator" })),
    listGoogleAccounts: vi.fn(async () => []),
    listCliAccountProfiles: vi.fn(async () => [])
  };
}

describe("browser census", () => {
  it("reads the API's records only: account profile, tabs without queries, control, handoff, and no fenced tab content", async () => {
    const census = await browserCensus({
      store: store() as never,
      capacity: () => ({ activeSessions: 2, maxSessions: 10 }),
      operatorIdleMs: () => 90_000,
      fencedTargets: async (paneId) => paneId === "pane:browser1" ? ["T2"] : []
    });
    expect(census.capacity).toEqual({ activeSessions: 2, maxSessions: 10 });
    expect(census.totalTabs).toBe(3);
    const [browser, copilot] = census.sessions;
    expect(browser).toMatchObject({ paneId: "pane:browser1", profile: "pane", mode: "BROWSER", fencedTabs: 1,
      control: { holderType: "OPERATOR", operatorIdleSeconds: 90 }, handoff: null });
    expect(browser!.tabs).toEqual([
      { title: "Inbox", url: "https://mail.example.com/inbox", isActive: true },
      { fenced: true, isActive: false }
    ]);
    expect(copilot).toMatchObject({ profile: "cli-accounts/3916b5f5c837", accountEmail: null, control: null, handoff: { status: "REQUESTED", requestedAt: "t4" } });
    expect(browser!.accountEmail).toBeNull();
    expect(copilot!.tabs).toEqual([{ title: null, url: "about:", isActive: true, account: "work@example.com" }]);
    expect(JSON.stringify(census)).not.toMatch(/secret|token=|\/srv\/space/);
  });

  it("names each session's account email from the API's own records, and none for a pane's own profile", async () => {
    const owner = "user:operator";
    const profiles = "/opt/spaceapp/var/artifacts/browser-profiles";
    const accounts = [{ id: "google_account:good1", email: "ntheogr@example.com" }, { id: "google_account:other2", email: "other@example.com" }];
    const sessions = [
      session("pane:google01", `${profiles}/google-accounts/aa/bb`, [], "google-account:google_account:good1"),
      session("pane:gemini01", `${profiles}/cli-accounts/cc`, [], `cli-account:${youtubeAccountProfileKey(owner, "gemini-two")}`),
      session("pane:freela01", `${profiles}/cli-accounts/dd`, [], `cli-account:${freelanceProfileKey(owner, "google_account:other2")}`),
      session("pane:freela02", `${profiles}/cli-accounts/ee`, [], `cli-account:${freelanceProfileKey(owner, "gemini-two")}`),
      session("pane:ownpro01", `${profiles}/room_abcdef/pane_ownpro01`, []),
      session("pane:unknown1", `${profiles}/cli-accounts/ff`, [], `cli-account:${"0".repeat(64)}`),
      session("pane:gone0001", `${profiles}/google-accounts/aa/zz`, [], "google-account:google_account:removed")
    ];
    const geminiEmails = vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, id === "gemini-two" ? "pirni@example.com" : null] as [string, string | null])));
    const census = await browserCensus({
      store: { ...store(), listActivePaneBrowserSessions: vi.fn(async () => sessions), listGoogleAccounts: vi.fn(async () => accounts),
        listCliAccountProfiles: vi.fn(async () => [{ profileId: "gemini-one" }, { profileId: "gemini-two" }]) } as never,
      fencedTargets: async () => [], geminiEmails
    });
    expect(Object.fromEntries(census.sessions.map((row) => [row.paneId, row.accountEmail]))).toEqual({
      "pane:google01": "ntheogr@example.com", "pane:gemini01": "pirni@example.com", "pane:freela01": "other@example.com",
      "pane:freela02": "pirni@example.com", "pane:ownpro01": null, "pane:unknown1": null, "pane:gone0001": null
    });
    // The Gemini emails are read once per census, through the account menu's own reader.
    expect(geminiEmails).toHaveBeenCalledTimes(1);
    // Without the reader (or an owner), nothing is guessed.
    const bare = await browserCensus({ store: { ...store(), listActivePaneBrowserSessions: vi.fn(async () => sessions.slice(1, 2)),
      listCliAccountProfiles: vi.fn(async () => [{ profileId: "gemini-two" }]) } as never, fencedTargets: async () => [] });
    expect(bare.sessions[0]!.accountEmail).toBeNull();
  });

  it("labels each Chrome profile the way the host's --user-data-dir names it", () => {
    expect(browserProfileLabel("/x/browser-profiles/google-accounts/35cc85dbfc14/ce399d95d02d")).toBe("google-accounts/35cc85db/ce399d95");
    expect(browserProfileLabel("/x/browser-profiles/room_a1/pane_b2")).toBe("pane");
    expect(browserProfileLabel("/x/elsewhere")).toBe("other");
  });

  it("answers only an administrator", async () => {
    const app = Fastify();
    let role = "USER";
    app.addHook("onRequest", async (request) => { (request as unknown as { user: unknown }).user = { role }; });
    registerBrowserCensusRoutes(app, { store: store() as never, browserSessionManager: { status: () => ({ capacity: undefined }) as never },
      controlActivity: { idleMs: () => 0 }, routeOptions: {} });
    expect((await app.inject({ method: "GET", url: "/api/admin/browser-census" })).statusCode).toBe(403);
    role = "ADMIN";
    const answer = await app.inject({ method: "GET", url: "/api/admin/browser-census" });
    expect(answer.statusCode).toBe(200);
    expect(answer.json().sessions).toHaveLength(2);
    await app.close();
  });
});
