import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import type { BrowserSessionManager } from "../src/browser-sessions.js";
import { cliBrowserBridgeTokenHeader, issueCliBrowserBridgeToken } from "../src/cli-browser-bridge.js";

describe("CLI browser bridge Google account selection", () => {
  const store = new InMemorySpaceStore();
  const admin = store.upsertUser({ id: "user:bridge-admin", email: "bridge-admin@example.test", role: "ADMIN" });
  const member = store.upsertUser({ id: "user:bridge-member", email: "bridge-member@example.test", role: "USER" });
  const stranger = store.upsertUser({ id: "user:bridge-stranger", email: "bridge-stranger@example.test", role: "ADMIN" });
  const account = store.linkGoogleAccount(admin.id, { sub: "bridge-admin", email: admin.email });
  const foreign = store.linkGoogleAccount(stranger.id, { sub: "bridge-stranger", email: stranger.email });
  const config = getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: "true", SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true", SPACE_INTERNAL_API_TOKEN: "test-internal-token" });
  const session = (paneId: string, roomId: string) => ({ session: { sessionId: "browser_session:bridge", paneId, roomId, agentNumber: 1, viewport: "desktop",
    streamMode: "AUTO", resolvedStreamMode: "INTERACTIVE", controlState: "UNCONTROLLED", activePageId: null, pages: [], status: "READY",
    currentUrl: "https://www.google.com/", title: "Google", lastFrameAt: null }, frame: null, websocket: null });
  const start = vi.fn(async (input: { pane: { id: string; roomId: string } }) => session(input.pane.id, input.pane.roomId));
  const stop = vi.fn(async () => undefined);
  const adopt = vi.fn(async (): Promise<unknown> => ({ result: "NO_SIGN_IN", accountId: null }));
  let app: Awaited<ReturnType<typeof createApp>>;
  let root: string;

  function fixture(owner: string | null, kind?: "AGENT_PROOF", mode: "BROWSER" | "FREELANCE_COPILOT" | "MARKETING_COPILOT" | "JOB_APPLY" = "BROWSER") {
    const room = store.createRoom({ name: "Bridge accounts", initialPaneCount: 0, ...(kind ? { kind } : {}) }, "trace", owner ?? undefined);
    const cliPane = store.createPane({ roomId: room.id, title: "Claude CLI", mode: "TERMINAL" });
    const browserPane = store.createPane({ roomId: room.id, title: "Browser", mode });
    const cli = store.createPaneCliSession({ sessionId: `cli_session:${room.id.slice(5)}`, paneId: cliPane.id, roomId: room.id, runtimeId: "cli:codex",
      providerId: "codex", agentId: "codex", modelId: null, reasoningEffort: "medium", cwd: "/opt/spaceapp/var/artifacts/cli-workspaces/test",
      status: "RUNNING", statusReason: "CLI running.", isActive: true });
    const token = issueCliBrowserBridgeToken(config, { roomId: room.id, paneId: cliPane.id, cliSessionId: cli.sessionId })!;
    const command = (body: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/cli/browser/commands",
      headers: { [cliBrowserBridgeTokenHeader]: token, "content-type": "application/json" }, payload: { targetPaneId: browserPane.id, command: body } });
    return { room, browserPane, cli, command };
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "cli-browser-accounts-test-"));
    const manager = { startOrRestore: start, stopPane: stop, adoptPaneGoogleProfile: adopt, closeAll: async () => {},
      status: () => ({ enabled: true, statusReason: "Test", defaultUrl: "about:blank", checkedAt: new Date().toISOString() }) };
    app = await createApp({ store, browserSessionManager: manager as unknown as BrowserSessionManager,
      config: { ...config, ...getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: "true", SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true", SPACE_INTERNAL_API_TOKEN: "test-internal-token",
        SPACE_ARTIFACT_ROOT: `${root}/browser-evidence`, SPACE_BROWSER_SESSIONS_PROFILE_ROOT: `${root}/profiles` }) },
      auth: { sessionSecret: "test-cli-browser-accounts-secret", devLogin: false, secureCookies: false } });
  }, 30_000);
  afterAll(async () => { await app?.close(); if (root) await rm(root, { recursive: true, force: true }); }, 30_000);

  it("lists the room owner's saved Google sign-ins and reopens the pane in the chosen one", async () => {
    const { browserPane, cli, command } = fixture(admin.id);
    const listed = await command({ type: "LIST_ACCOUNTS" });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().profiles).toEqual(expect.arrayContaining([expect.objectContaining({ profileId: account.id, displayName: expect.stringMatching(/^Google account · /) })]));
    expect(JSON.stringify(listed.json())).not.toMatch(/profilePath|cookie|token/i);

    const selected = await command({ type: "SELECT_ACCOUNT", profileId: account.id });
    expect(selected.statusCode, selected.body).toBe(200);
    expect(selected.json()).toMatchObject({ selectedProfileId: account.id, session: { paneId: browserPane.id, status: "READY" } });
    const agent = { holderType: "AGENT", holderId: `cli:${cli.sessionId}` };
    expect(stop).toHaveBeenLastCalledWith(browserPane.id, expect.any(String), agent);
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ googleAccount: { ownerUserId: admin.id, accountId: account.id }, ownerAgentId: agent.holderId }), agent);
    expect((await command({ type: "LIST_ACCOUNTS" })).json().selectedProfileId).toBe(account.id);

    // Another user's account is not offered and cannot be chosen.
    expect((await command({ type: "SELECT_ACCOUNT", profileId: foreign.id })).statusCode).toBe(404);
  });

  it("lets a Freelance Copilot list and choose its accounts (operator 2026-10-18)", async () => {
    const freelance = fixture(admin.id, undefined, "FREELANCE_COPILOT");
    const listed = await freelance.command({ type: "LIST_ACCOUNTS" });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().profiles).toEqual(expect.arrayContaining([expect.objectContaining({ profileId: account.id })]));
  });

  it("lets a Marketing Copilot choose its account (plan clipboard:NdUqdzgGp_BR), and leaves a Job Copilot's to its account menu", async () => {
    const { browserPane, cli, command } = fixture(admin.id, undefined, "MARKETING_COPILOT");
    const selected = await command({ type: "SELECT_ACCOUNT", profileId: account.id });
    expect(selected.statusCode, selected.body).toBe(200);
    expect(selected.json()).toMatchObject({ selectedProfileId: account.id, session: { paneId: browserPane.id, status: "READY" } });
    const agent = { holderType: "AGENT", holderId: `cli:${cli.sessionId}` };
    expect(stop).toHaveBeenLastCalledWith(browserPane.id, expect.any(String), agent);
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ pane: expect.objectContaining({ id: browserPane.id }),
      googleAccount: { ownerUserId: admin.id, accountId: account.id }, ownerAgentId: agent.holderId }), agent);
    expect((await command({ type: "LIST_ACCOUNTS" })).json().selectedProfileId).toBe(account.id);
    expect((await command({ type: "SELECT_ACCOUNT", profileId: foreign.id })).statusCode).toBe(404);
    // A Job Copilot's pane account is also its mail and calendar account: agents read it, the operator's account menu changes it.
    const job = fixture(admin.id, undefined, "JOB_APPLY");
    expect((await job.command({ type: "LIST_ACCOUNTS" })).statusCode).toBe(200);
    expect((await job.command({ type: "SELECT_ACCOUNT", profileId: account.id })).statusCode).toBe(409);
  });

  it("keeps a pane's network route and restarts its running browser on it (operator 31/10, plan clipboard:iLvBs5eOMZjF)", async () => {
    const { room, browserPane, cli, command } = fixture(admin.id);
    const agent = { holderType: "AGENT", holderId: `cli:${cli.sessionId}` };
    // No browser runs yet: the route is kept for the pane's next start.
    const kept = await command({ type: "SET_ROUTE", route: "greece" });
    expect(kept.statusCode, kept.body).toBe(200);
    expect(kept.json()).toMatchObject({ route: "greece", restarted: false });
    expect(store.getPaneBrowserRoute(browserPane.id)).toBe("greece");
    // A running browser restarts on the route, on the page it showed.
    store.createPaneBrowserSession({ sessionId: "browser_session:route", paneId: browserPane.id, roomId: room.id, ownerAgentId: "agent:1", agentNumber: 1,
      profileId: `profile:${browserPane.id}`, profilePath: `/tmp/${browserPane.id}`, viewport: "desktop", targetUrl: "https://learn.nvidia.com/",
      currentUrl: "https://learn.nvidia.com/courses", title: "NVIDIA", status: "READY", isActive: true });
    const restarted = await command({ type: "SET_ROUTE", route: "direct" });
    expect(restarted.json()).toMatchObject({ route: "direct", restarted: true });
    expect(stop).toHaveBeenLastCalledWith(browserPane.id, expect.any(String), agent);
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ targetUrl: "https://learn.nvidia.com/courses", ownerAgentId: agent.holderId }), agent);
    expect((await command({ type: "SET_ROUTE", route: "moon" })).statusCode).toBe(422);
    // A Freelance Copilot's route is its Setup route; another user's room is refused.
    const freelance = fixture(admin.id, undefined, "FREELANCE_COPILOT");
    expect((await freelance.command({ type: "SET_ROUTE", route: "nord" })).json()).toMatchObject({ route: "nord" });
    expect(store.getPane(freelance.browserPane.id).freelanceCopilotMetadata?.settings.browserEgress).toBe("nord");
    expect(store.getPaneBrowserRoute(freelance.browserPane.id)).toBeNull();
    expect((await fixture(member.id).command({ type: "SET_ROUTE", route: "greece" })).statusCode).toBe(403);

    // The pane's toolbar reads and sets the same route (ADMIN only).
    const session = (role: "ADMIN" | "USER") => {
      const user = role === "ADMIN" ? admin : member;
      const signed = signSession({ id: user.id, email: user.email, role }, "test-cli-browser-accounts-secret");
      return { cookie: `space_session=${signed}`, "x-space-csrf-token": createCsrfToken(signed, "test-cli-browser-accounts-secret")! };
    };
    const url = `/api/panes/${browserPane.id}/browser/route`;
    expect((await app.inject({ method: "GET", url, headers: session("ADMIN") })).json()).toEqual({ route: "direct", routes: ["direct", "greece", "thailand", "mullvad", "nord"] });
    const put = await app.inject({ method: "PUT", url, headers: session("ADMIN"), payload: { route: "thailand" } });
    expect(put.json()).toMatchObject({ route: "thailand", restarted: true });
    expect(store.getPaneBrowserRoute(browserPane.id)).toBe("thailand");
    const own = fixture(member.id).browserPane;
    expect((await app.inject({ method: "GET", url: `/api/panes/${own.id}/browser/route`, headers: session("USER") })).statusCode).toBe(403);
  });

  it("offers a self-hosted install only this server's route: the VPN routes do not exist there", async () => {
    const manager = { startOrRestore: start, stopPane: stop, adoptPaneGoogleProfile: adopt, closeAll: async () => {},
      status: () => ({ enabled: true, statusReason: "Test", defaultUrl: "about:blank", checkedAt: new Date().toISOString() }) };
    const publicApp = await createApp({ store, browserSessionManager: manager as unknown as BrowserSessionManager,
      config: { ...config, ...getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: "true", SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true", SPACE_INTERNAL_API_TOKEN: "test-internal-token",
        SPACE_ARTIFACT_ROOT: `${root}/browser-evidence`, SPACE_BROWSER_SESSIONS_PROFILE_ROOT: `${root}/profiles` }), publicDistribution: true },
      auth: { sessionSecret: "test-cli-browser-accounts-secret", devLogin: false, secureCookies: false } });
    try {
      const { browserPane } = fixture(admin.id);
      const signed = signSession({ id: admin.id, email: admin.email, role: "ADMIN" }, "test-cli-browser-accounts-secret");
      const headers = { cookie: `space_session=${signed}`, "x-space-csrf-token": createCsrfToken(signed, "test-cli-browser-accounts-secret")! };
      const url = `/api/panes/${browserPane.id}/browser/route`;
      expect((await publicApp.inject({ method: "GET", url, headers })).json()).toEqual({ route: "direct", routes: ["direct"] });
      const refused = await publicApp.inject({ method: "PUT", url, headers, payload: { route: "greece" } });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().message ?? refused.body).toMatch(/no VPN routes/);
      expect(store.getPaneBrowserRoute(browserPane.id)).toBeNull();
      expect((await publicApp.inject({ method: "PUT", url, headers, payload: { route: "direct" } })).statusCode).toBe(200);
    } finally { await publicApp.close(); }
  }, 30_000);

  it("requires a room owned by an ADMIN and offers no real accounts in proof rooms", async () => {
    expect((await fixture(member.id).command({ type: "LIST_ACCOUNTS" })).statusCode).toBe(403);
    const proof = fixture(admin.id, "AGENT_PROOF");
    expect((await proof.command({ type: "LIST_ACCOUNTS" })).json().profiles.filter((profile: { profileId: string }) => profile.profileId.startsWith("google_account:"))).toEqual([]);
    expect((await proof.command({ type: "SELECT_ACCOUNT", profileId: account.id })).statusCode).toBe(409);
  });
});
