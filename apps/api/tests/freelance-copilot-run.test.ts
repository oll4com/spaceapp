import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore, SpaceEventBus } from "@space/runtime";
import type { Event, FreelanceRun, Pane } from "@space/contracts";
import { buildCliAgentBootstrapMarkdown, buildFreelanceCopilotPersonaMarkdown } from "../src/agent-bootstrap.js";
import { createApp } from "../src/app.js";
import { cliBrowserBridgeTokenHeader, issueCliBrowserBridgeToken } from "../src/cli-browser-bridge.js";
import { isCliBridgeRoutePath } from "../src/cli-bridge-paths.js";
import { getApiConfig } from "../src/config.js";
import type { MailboxFactory } from "../src/job-apply/mailbox.js";

vi.setConfig({ testTimeout: 30_000 });
const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const inbox = [{ uid: 3, from: "donotreply@upwork.com", subject: "Your Upwork verification code", receivedAt: new Date().toISOString(), snippet: "Code", text: "Your code is 482913." }];
const mailboxes: MailboxFactory = { async open() { return { recent: async () => inbox.map(({ text: _text, ...summary }) => summary), texts: async () => inbox, close: async () => undefined }; } };

/** A signed-in owner, a Freelance Copilot pane, the operator's session and the agent's bridge token; the kickoff is recorded, not typed. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "space-freelance-copilot-run-"));
  temporaryRoots.push(root);
  const wrapper = join(root, "codex-vscode-parity");
  await writeFile(wrapper, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(wrapper, 0o755);
  const config = getApiConfig({
    SPACE_CLI_ENABLED: "true", SPACE_CLI_COMMAND_PATH: root, SPACE_CLI_HOST_SOCKET: join(root, "pane-host.sock"), SPACE_CLI_CODEX_CREDENTIAL_SMOKE: "true",
    SPACE_CLI_WORKSPACE_ROOT: join(root, "workspaces"), SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true", SPACE_INTERNAL_API_TOKEN: "internal-token-for-freelance-copilot-tests", SPACE_ARTIFACT_ROOT: root
  });
  const store = new InMemorySpaceStore();
  const eventBus = new SpaceEventBus();
  const roomEvents: Event[] = [];
  eventBus.subscribe((event) => { if (event.type === "FREELANCE_COPILOT_UPDATED") roomEvents.push(event); });
  const kickoffs: Array<{ paneId: string; runId: string }> = [];
  const app = await createApp({ store, config, eventBus, jobApplyMailTriage: false, marketingCopilotScheduler: false, freelanceCopilotScheduler: false, freelanceCopilotMailboxes: mailboxes,
    freelanceCopilotKickoff: async (pane: Pane, run: FreelanceRun) => { kickoffs.push({ paneId: pane.id, runId: run.id }); },
    auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false } });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
  const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
  const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
  const headers = { cookie, "x-space-csrf-token": csrf.json().csrfToken as string };
  const room = (await app.inject({ method: "POST", url: "/api/rooms", headers, payload: { name: "Freelance", initialPaneCount: 0 } })).json();
  const pane = store.createPane({ roomId: room.id, title: "Freelance Copilot", mode: "FREELANCE_COPILOT", terminalRuntimeId: "cli:codex" });
  const cliSession = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex", status: "RUNNING", purpose: "NORMAL" });
  const token = issueCliBrowserBridgeToken(config, { roomId: room.id, paneId: pane.id, cliSessionId: cliSession.sessionId })!;
  const agent = { [cliBrowserBridgeTokenHeader]: token, "content-type": "application/json" };
  // A bridge token of another pane (a plain terminal) never reaches these tools.
  const other = store.createPane({ roomId: room.id, title: "Shell", mode: "TERMINAL", terminalRuntimeId: "cli:codex" });
  const otherSession = store.createPaneCliSession({ paneId: other.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex", status: "RUNNING", purpose: "NORMAL" });
  const outsider = { [cliBrowserBridgeTokenHeader]: issueCliBrowserBridgeToken(config, { roomId: room.id, paneId: other.id, cliSessionId: otherSession.sessionId })!, "content-type": "application/json" };
  return { app, pane, headers, agent, outsider, roomEvents, kickoffs, paneUrl: `/api/panes/${encodeURIComponent(pane.id)}/freelance-copilot` };
}

const cli = "/api/cli/freelance-copilot";

describe("freelance copilot run loop", () => {
  it("runs a brief to a sent proposal, a client reply and the client-ready handoff with a notification", async () => {
    const { app, pane, headers, agent, outsider, roomEvents, kickoffs, paneUrl } = await fixture();
    try {
      expect((await app.inject({ method: "GET", url: `${cli}/state` })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: `${cli}/state`, headers: outsider })).statusCode).toBe(409);
      // The mailbox: the operator connects it once (the password stays on the server), the agent reads codes.
      const mailbox = await app.inject({ method: "PUT", url: "/api/freelance-copilot/mailbox", headers, payload: { host: "example.invalid", port: 993, secure: true, user: "work@example.invalid", password: "secret" } });
      expect(mailbox.json()).toMatchObject({ connected: true, config: { user: "work@example.invalid" } });
      expect(JSON.stringify(mailbox.json())).not.toContain("secret");
      expect((await app.inject({ method: "POST", url: `${cli}/mail/code`, headers: agent, payload: { fromContains: "upwork.com", timeoutMs: 0 } })).json().result).toMatchObject({ code: "482913" });
      // Sign-up forms read the operator's Job Copilot profile, without the personal email and phone.
      expect((await app.inject({ method: "GET", url: `${cli}/profile`, headers: agent })).json().candidate).toMatchObject({ fullName: null });
      await app.inject({ method: "PATCH", url: "/api/job-apply/profile", headers, payload: { candidate: { fullName: "Ada Lovelace", email: "ada@example.com", phone: "+30 210 0000000", languages: ["English"] } } });
      const profile = (await app.inject({ method: "GET", url: `${cli}/profile`, headers: agent })).json();
      expect(profile.candidate).toMatchObject({ fullName: "Ada Lovelace", languages: ["English"] });
      expect(JSON.stringify(profile)).not.toMatch(/ada@example\.com|210 0000000/);

      expect((await app.inject({ method: "POST", url: `${paneUrl}/briefs`, headers, payload: { text: "Find two MCP jobs on Upwork and send proposals" } })).statusCode).toBe(200);
      const started = await app.inject({ method: "POST", url: `${paneUrl}/run/start`, headers });
      expect(started.json()).toMatchObject({ status: "RUNNING", kickoffSent: true, backlog: 1 });
      expect(kickoffs).toEqual([{ paneId: pane.id, runId: started.json().run.id }]);
      const state = (await app.inject({ method: "GET", url: `${cli}/state`, headers: agent })).json();
      expect(state.channels.UPWORK).toMatchObject({ effectiveAutonomy: "FULL", alias: "upwork@example.invalid" });
      expect(state.accounts.map((account: { channel: string }) => account.channel)).toEqual(["UPWORK", "CONTRA", "FIVERR", "TOPTAL", "ARC", "BRAINTRUST"]);

      const brief = (await app.inject({ method: "POST", url: `${cli}/next`, headers: agent, payload: { waitMs: 0 } })).json();
      expect(brief).toMatchObject({ done: false, kind: "BRIEF" });
      const added = (await app.inject({ method: "POST", url: `${cli}/leads`, headers: agent, payload: { channel: "UPWORK", url: "https://www.upwork.com/jobs/~031", externalId: "~031", title: "MCP server for a SaaS API", budget: "$1,500 fixed", status: "QUALIFIED", facts: { paymentVerified: true, proposals: 4 } } })).json();
      expect(added).toMatchObject({ duplicate: false, scamSignals: [] });
      const leadId = added.lead.id as string;
      const drafted = (await app.inject({ method: "POST", url: `${cli}/messages`, headers: agent, payload: { leadId, kind: "PROPOSAL", body: "You want your API usable by AI agents. I built SpaceApp (https://spaceapp.dev). First milestone: three read-only tools, $600.", bid: { type: "FIXED", amount: 1500 }, connects: 12 } })).json();
      expect(drafted.wordingIssues).toEqual([]);
      const messageId = drafted.message.id as string;
      expect((await app.inject({ method: "POST", url: `${cli}/send/begin`, headers: agent, payload: { messageId } })).json().message.status).toBe("SENDING");
      expect((await app.inject({ method: "POST", url: `${cli}/send/done`, headers: agent, payload: { messageId, url: "https://example.com/proposal" } })).statusCode).toBe(409);
      expect((await app.inject({ method: "POST", url: `${cli}/send/done`, headers: agent, payload: { messageId, url: "https://www.upwork.com/nx/proposals/1931" } })).json().message.status).toBe("SENT");
      await app.inject({ method: "POST", url: `${cli}/report`, headers: agent, payload: { eventId: brief.item.id, outcome: "done", summary: "One proposal sent" } });

      await app.inject({ method: "POST", url: `${cli}/messages/incoming`, headers: agent, payload: { leadId, body: "Great proposal. Can we start Monday? I will send the offer." } });
      const ready = await app.inject({ method: "POST", url: `${cli}/client-ready`, headers: agent, payload: { leadId, summary: "Offer coming for $1,500 fixed, start Monday." } });
      expect(ready.json().lead.status).toBe("CLIENT_READY");
      const openNotifications = async () => (await app.inject({ method: "GET", url: "/api/notifications?status=OPEN&source=FREELANCE_COPILOT", headers })).json().notifications as Array<{ kind: string; severity: string; title: string }>;
      await vi.waitFor(async () => expect(await openNotifications()).toEqual([expect.objectContaining({ kind: "CLIENT_READY", severity: "ATTENTION", title: expect.stringContaining("A client wants to go ahead") })]));
      const run = (await app.inject({ method: "GET", url: `${paneUrl}/run`, headers })).json();
      expect(run.pending.map((item: { kind: string }) => item.kind)).toEqual(["CLIENT_READY"]);
      const won = await app.inject({ method: "POST", url: `/api/freelance-copilot/leads/${encodeURIComponent(leadId)}/decide?paneId=${encodeURIComponent(pane.id)}`, headers, payload: { decision: "won", contractValue: 1500 } });
      expect(won.json().lead).toMatchObject({ status: "WON", contractValue: 1500 });
      await vi.waitFor(async () => expect(await openNotifications()).toEqual([]));
      expect((await app.inject({ method: "GET", url: "/api/freelance-copilot/funnel", headers })).json()).toMatchObject({ revenue: 1500, connectsToday: 12, channels: { UPWORK: { leads: 1, won: 1, sent: 1 } } });
      expect(roomEvents.some((event) => event.paneId === pane.id && event.payload.type === "SENT")).toBe(true);

      const settings = (await app.inject({ method: "GET", url: `${paneUrl}/settings`, headers })).json().metadata;
      settings.settings.paused = true;
      expect((await app.inject({ method: "PUT", url: `${paneUrl}/settings`, headers, payload: settings })).json().metadata.settings.paused).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("skips session authentication only for the bridge routes, and gives the agent its persona and skill", async () => {
    expect(isCliBridgeRoutePath("/api/cli/freelance-copilot/send/begin")).toBe(true);
    expect(isCliBridgeRoutePath("/api/cli/freelance-copilotx/state")).toBe(false);
    expect(isCliBridgeRoutePath("/api/freelance-copilot/leads")).toBe(false);
    const persona = buildFreelanceCopilotPersonaMarkdown({ paneId: "pane:fl0000001", runtimeId: "cli:claude" });
    expect(persona).toContain("`space_freelancecopilot.space_freelance_next`");
    expect(persona).toContain("Runtime: cli:claude.");
    const bootstrap = buildCliAgentBootstrapMarkdown({ paneMode: "FREELANCE_COPILOT" } as Parameters<typeof buildCliAgentBootstrapMarkdown>[0]);
    expect(bootstrap).toContain("Freelance Copilot pane:");
    expect(bootstrap).toContain("space_freelance_client_ready");
    const skill = await readFile(new URL("../../../agent-skills/space-freelance-copilot/SKILL.md", import.meta.url), "utf8");
    expect(skill).toContain("name: space-freelance-copilot");
    await expect(readFile(new URL("../../../agent-skills/space-freelance-copilot/references/channels.md", import.meta.url), "utf8")).resolves.toContain("## Upwork");
  });
});
