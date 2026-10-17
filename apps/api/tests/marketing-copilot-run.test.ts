import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore, SpaceEventBus } from "@space/runtime";
import type { Event, MarketingRun, Pane } from "@space/contracts";
import { buildMarketingCopilotPersonaMarkdown, buildCliAgentBootstrapMarkdown } from "../src/agent-bootstrap.js";
import { createApp } from "../src/app.js";
import { cliBrowserBridgeTokenHeader, issueCliBrowserBridgeToken } from "../src/cli-browser-bridge.js";
import { isCliBridgeRoutePath } from "../src/cli-bridge-paths.js";
import { getApiConfig } from "../src/config.js";

vi.setConfig({ testTimeout: 30_000 });
const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A signed-in owner, a Marketing Copilot pane, the operator's session and the agent's bridge token; the kickoff is recorded, not typed. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "space-marketing-copilot-run-"));
  temporaryRoots.push(root);
  const wrapper = join(root, "codex-vscode-parity");
  await writeFile(wrapper, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(wrapper, 0o755);
  const config = getApiConfig({
    SPACE_CLI_ENABLED: "true", SPACE_CLI_COMMAND_PATH: root, SPACE_CLI_HOST_SOCKET: join(root, "pane-host.sock"), SPACE_CLI_CODEX_CREDENTIAL_SMOKE: "true",
    SPACE_CLI_WORKSPACE_ROOT: join(root, "workspaces"), SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true", SPACE_INTERNAL_API_TOKEN: "internal-token-for-marketing-copilot-tests", SPACE_ARTIFACT_ROOT: root
  });
  const store = new InMemorySpaceStore();
  const eventBus = new SpaceEventBus();
  const roomEvents: Event[] = [];
  eventBus.subscribe((event) => { if (event.type === "MARKETING_COPILOT_UPDATED") roomEvents.push(event); });
  const kickoffs: Array<{ paneId: string; runId: string }> = [];
  const app = await createApp({ store, config, eventBus, jobApplyMailTriage: false, marketingCopilotScheduler: false,
    marketingCopilotKickoff: async (pane: Pane, run: MarketingRun) => { kickoffs.push({ paneId: pane.id, runId: run.id }); },
    auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false } });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
  const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
  const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
  const headers = { cookie, "x-space-csrf-token": csrf.json().csrfToken as string };
  const room = (await app.inject({ method: "POST", url: "/api/rooms", headers, payload: { name: "Marketing", initialPaneCount: 0 } })).json();
  const pane = store.createPane({ roomId: room.id, title: "Marketing Copilot", mode: "MARKETING_COPILOT", terminalRuntimeId: "cli:codex" });
  const cliSession = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex", status: "RUNNING", purpose: "NORMAL" });
  const token = issueCliBrowserBridgeToken(config, { roomId: room.id, paneId: pane.id, cliSessionId: cliSession.sessionId })!;
  const agent = { [cliBrowserBridgeTokenHeader]: token, "content-type": "application/json" };
  // A bridge token of another pane (a plain terminal) never reaches these tools.
  const other = store.createPane({ roomId: room.id, title: "Shell", mode: "TERMINAL", terminalRuntimeId: "cli:codex" });
  const otherSession = store.createPaneCliSession({ paneId: other.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex", status: "RUNNING", purpose: "NORMAL" });
  const outsider = { [cliBrowserBridgeTokenHeader]: issueCliBrowserBridgeToken(config, { roomId: room.id, paneId: other.id, cliSessionId: otherSession.sessionId })!, "content-type": "application/json" };
  return { app, pane, headers, agent, outsider, roomEvents, kickoffs, paneUrl: `/api/panes/${encodeURIComponent(pane.id)}/marketing-copilot` };
}

const cli = "/api/cli/marketing-copilot";

describe("marketing copilot run loop", () => {
  it("runs a brief to a reviewed, approved and published post with the URL as evidence", async () => {
    const { app, pane, headers, agent, outsider, roomEvents, kickoffs, paneUrl } = await fixture();
    try {
      expect((await app.inject({ method: "GET", url: `${cli}/state` })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: `${cli}/state`, headers: outsider })).statusCode).toBe(409);
      expect((await app.inject({ method: "POST", url: `${cli}/next`, headers: agent, payload: { waitMs: 0 } })).json()).toMatchObject({ done: true, reason: "NO_RUN" });

      expect((await app.inject({ method: "POST", url: `${paneUrl}/briefs`, headers, payload: { text: "A launch post for X about running many CLIs side by side" } })).statusCode).toBe(200);
      const started = await app.inject({ method: "POST", url: `${paneUrl}/run/start`, headers });
      expect(started.json()).toMatchObject({ status: "RUNNING", kickoffSent: true, backlog: 1 });
      expect(kickoffs).toEqual([{ paneId: pane.id, runId: started.json().run.id }]);

      const state = (await app.inject({ method: "GET", url: `${cli}/state`, headers: agent })).json();
      expect(state.channels.HACKER_NEWS).toMatchObject({ autonomyCap: "ASSIST", effectiveAutonomy: "ASSIST" });
      expect((await app.inject({ method: "GET", url: `${cli}/facts?query=install`, headers: agent })).json().facts.length).toBeGreaterThan(0);

      const brief = (await app.inject({ method: "POST", url: `${cli}/next`, headers: agent, payload: { waitMs: 0 } })).json();
      expect(brief).toMatchObject({ done: false, kind: "BRIEF", item: { message: expect.stringContaining("launch post") } });
      const created = (await app.inject({ method: "POST", url: `${cli}/posts`, headers: agent, payload: { channel: "X", body: "Run Codex, Claude Code and OpenCode side by side in rooms you host. npx --yes run-spaceapp@latest install" } })).json();
      expect(created.wordingIssues).toEqual([]);
      const postId = created.post.id as string;
      // Assist: the gate refuses before any review.
      const refused = await app.inject({ method: "POST", url: `${cli}/publish/begin`, headers: agent, payload: { postId } });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.message).toMatch(/MARKETING_NEEDS_REVIEW/);
      await app.inject({ method: "POST", url: `${cli}/review`, headers: agent, payload: { postId, summary: "Launch post for X" } });
      expect((await app.inject({ method: "POST", url: `${cli}/report`, headers: agent, payload: { eventId: brief.item.id, outcome: "drafted", summary: "Drafted one X post for review" } })).statusCode).toBe(200);

      const run = (await app.inject({ method: "GET", url: `${paneUrl}/run`, headers })).json();
      expect(run.pending.map((item: { kind: string }) => item.kind)).toEqual(["REVIEW"]);
      // The review raises one ATTENTION notification; the operator's decision resolves it.
      const openNotifications = async () => (await app.inject({ method: "GET", url: "/api/notifications?status=OPEN&source=MARKETING_COPILOT", headers })).json().notifications as Array<{ kind: string; severity: string; link: { target?: string } }>;
      await vi.waitFor(async () => expect(await openNotifications()).toEqual([expect.objectContaining({ kind: "REVIEW_REQUESTED", severity: "ATTENTION", link: expect.objectContaining({ target: `post:${postId}` }) })]));
      const approved = await app.inject({ method: "POST", url: `${paneUrl}/posts/${encodeURIComponent(postId)}/review`, headers, payload: { decision: "approve" } });
      expect(approved.json().post.status).toBe("APPROVED");
      await vi.waitFor(async () => expect(await openNotifications()).toEqual([]));
      expect((await app.inject({ method: "POST", url: `${cli}/review/wait`, headers: agent, payload: { postId, waitMs: 0 } })).json()).toMatchObject({ decided: true, status: "APPROVED" });

      // The approved post comes back as due; publishing passes the gate and needs the channel's own URL.
      expect((await app.inject({ method: "POST", url: `${cli}/next`, headers: agent, payload: { waitMs: 0 } })).json()).toMatchObject({ kind: "PUBLISH", post: { id: postId } });
      expect((await app.inject({ method: "POST", url: `${cli}/publish/begin`, headers: agent, payload: { postId } })).json().post.status).toBe("PUBLISHING");
      const wrongSite = await app.inject({ method: "POST", url: `${cli}/publish/done`, headers: agent, payload: { postId, url: "https://example.com/x" } });
      expect(wrongSite.statusCode).toBe(409);
      const done = await app.inject({ method: "POST", url: `${cli}/publish/done`, headers: agent, payload: { postId, url: "https://x.com/spaceapp/status/1846000000000000000" } });
      expect(done.json().post).toMatchObject({ status: "PUBLISHED", publishedUrl: "https://x.com/spaceapp/status/1846000000000000000" });
      expect((await app.inject({ method: "POST", url: `${cli}/next`, headers: agent, payload: { waitMs: 0 } })).json()).toMatchObject({ done: true, reason: "QUEUE_EMPTY" });

      const events = (await app.inject({ method: "GET", url: `/api/marketing-copilot/events?paneId=${encodeURIComponent(pane.id)}`, headers })).json().events.map((event: { type: string }) => event.type);
      expect(events).toEqual(expect.arrayContaining(["BRIEF", "RUN_STARTED", "POST_DRAFTED", "REVIEW_REQUESTED", "NOTE", "REVIEW_DECIDED", "PUBLISHING", "PUBLISHED", "RUN_STOPPED"]));
      expect(roomEvents.some((event) => event.paneId === pane.id && event.payload.type === "PUBLISHED")).toBe(true);
      const all = (await app.inject({ method: "GET", url: "/api/notifications?source=MARKETING_COPILOT", headers })).json().notifications as Array<{ kind: string; severity: string }>;
      await vi.waitFor(() => expect(all.some((entry) => entry.kind === "PUBLISHED" && entry.severity === "INFO")).toBe(true));
    } finally {
      await app.close();
    }
  });

  it("shows the agent the operator's bookmarks with their Google accounts", async () => {
    const { app, headers, agent, outsider } = await fixture();
    try {
      const saved = await app.inject({ method: "POST", url: "/api/marketing-copilot/bookmarks", headers, payload: { url: "https://x.com/home", profileId: "google_account:dev", accountLabel: "spaceappdv@gmail.com" } });
      expect(saved.statusCode, saved.body).toBe(200);
      const bookmark = { id: saved.json().bookmark.id, title: "x.com", url: "https://x.com/home", profileId: "google_account:dev", accountLabel: "spaceappdv@gmail.com" };
      expect((await app.inject({ method: "GET", url: `${cli}/bookmarks`, headers: agent })).json().bookmarks).toEqual([expect.objectContaining(bookmark)]);
      expect((await app.inject({ method: "GET", url: `${cli}/state`, headers: agent })).json().bookmarks).toEqual([expect.objectContaining(bookmark)]);
      expect((await app.inject({ method: "GET", url: `${cli}/bookmarks`, headers: outsider })).statusCode).toBe(409);
      expect((await app.inject({ method: "POST", url: `${cli}/bookmarks/mktbm:missing000/open`, headers: agent, payload: {} })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("skips session authentication only for the bridge routes, which check the pane token themselves", () => {
    expect(isCliBridgeRoutePath("/api/cli/marketing-copilot/publish/begin")).toBe(true);
    expect(isCliBridgeRoutePath("/api/cli/mail-copilot/state")).toBe(true);
    expect(isCliBridgeRoutePath("/api/cli/browser/commands")).toBe(true);
    expect(isCliBridgeRoutePath("/api/cli/marketing-copilotx/state")).toBe(false);
    expect(isCliBridgeRoutePath("/api/marketing-copilot/posts")).toBe(false);
    expect(isCliBridgeRoutePath("/api/panes/:id/marketing-copilot/settings")).toBe(false);
  });

  it("gives the agent its persona and tells it where the tools are", async () => {
    const persona = buildMarketingCopilotPersonaMarkdown({ paneId: "pane:mkt000001", runtimeId: "cli:claude" });
    expect(persona).toContain("`space_marketingcopilot.space_marketing_next`");
    expect(persona).toContain("Runtime: cli:claude.");
    const bootstrap = buildCliAgentBootstrapMarkdown({ paneMode: "MARKETING_COPILOT" } as Parameters<typeof buildCliAgentBootstrapMarkdown>[0]);
    expect(bootstrap).toContain("Marketing Copilot pane:");
    expect(bootstrap).toContain("space_marketing_publish_begin");
    // The skill the persona names exists with its channel playbooks.
    const skill = await readFile(new URL("../../../agent-skills/space-marketing-copilot/SKILL.md", import.meta.url), "utf8");
    expect(skill).toContain("name: space-marketing-copilot");
    await expect(readFile(new URL("../../../agent-skills/space-marketing-copilot/references/channels.md", import.meta.url), "utf8")).resolves.toContain("## Hacker News");
  });
});
