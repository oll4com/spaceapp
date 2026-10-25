import { describe, expect, it, vi } from "vitest";
import { InMemoryMailCopilotRepository } from "@space/db";
import { InMemorySpaceStore } from "@space/runtime";
import type { MailCopilotRun, Pane } from "@space/contracts";
import { createApp } from "../src/app.js";
import { signNousToken } from "../src/nous/mcp.js";
import { createNousTools, nousToolDefinitions, type NousToolDeps } from "../src/nous/tools.js";

const pane = (mode: string, extra: Partial<Pane> = {}): Pane =>
  ({ id: "pane:bob00001", roomId: "room:bruno001", paneName: "Bob", title: "Bob", mode, terminalRuntimeId: "cli:claude", isClosed: false, ...extra } as unknown as Pane);

describe("space_copilot_control as Nous's tool", () => {
  it("is one of Nous's copilot tools, acting on the named pane of the owner's room", async () => {
    expect(nousToolDefinitions({ copilots: true }).some((tool) => tool.name === "space_copilot_control")).toBe(true);
    expect(nousToolDefinitions({ copilots: false }).some((tool) => tool.name === "space_copilot_control")).toBe(false);
    const bob = pane("MAIL_COPILOT");
    const control = vi.fn(async () => "Started Bob's agent (cli:claude).");
    const tools = createNousTools({
      rooms: async (owner: string) => owner === "user:operator" ? [{ id: "room:bruno001", name: "Bruno" }] : [],
      listPanes: async () => [bob],
      copilots: { control }
    } as unknown as NousToolDeps);
    const ctx = { owner: "user:operator", turnId: "nous_turn:t1", callId: "toolu_1", traceId: "trace:1" };
    expect(await tools.execute("space_copilot_control", { room: "bruno", pane: "bob", action: "start_agent" }, ctx))
      .toEqual({ ok: true, display: "Started Bob's agent (cli:claude).", result: "Started Bob's agent (cli:claude)." });
    expect(control).toHaveBeenCalledWith("user:operator", bob, "start_agent");
    expect((await tools.execute("space_copilot_control", { room: "Bruno", pane: "Bob", action: "deploy" }, ctx)).ok).toBe(false);
    expect((await tools.execute("space_copilot_control", { room: "Bruno", pane: "Bob", action: "pause" }, { ...ctx, owner: "user:someone" })).ok).toBe(false);
    expect(control).toHaveBeenCalledTimes(1);
  });
});

describe("space_copilot_control through the API", () => {
  it("pauses, resumes and runs a Mail Copilot through its own routes during a Nous turn", async () => {
    const sessionSecret = "nous-copilot-control-secret-long-enough";
    const store = new InMemorySpaceStore();
    const kickoffs: string[] = [];
    const results: Array<{ text: string; isError: boolean }> = [];
    const actions = ["pause", "pause", "resume", "run_start", "run_stop"];
    let app!: Awaited<ReturnType<typeof createApp>>;
    app = await createApp({ store, auth: { sessionSecret, devLogin: true, secureCookies: false }, mailCopilotRepository: new InMemoryMailCopilotRepository(),
      mailCopilotKickoff: async (_pane: Pane, run: MailCopilotRun) => { kickoffs.push(run.id); },
      // The turn calls the tool over Nous's MCP endpoint with its own token, as its Claude Code run does.
      nousRunner: async ({ owner, turnId }) => {
        const token = signNousToken(sessionSecret, { owner, turnId, expiresAt: Date.now() + 60_000 });
        for (const [index, action] of actions.entries()) {
          const response = await app.inject({ method: "POST", url: "/api/cli/nous/mcp", headers: { authorization: `Bearer ${token}` },
            payload: { jsonrpc: "2.0", id: index + 1, method: "tools/call", params: { name: "space_copilot_control", arguments: { room: "Bruno", pane: "Bob", action } } } });
          const result = response.json().result as { content: Array<{ text: string }>; isError: boolean };
          results.push({ text: result.content[0]!.text, isError: result.isError });
        }
        return { text: "done", isError: false };
      } });
    try {
      const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
      const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
      const headers = { cookie, "x-space-csrf-token": (await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } })).json().csrfToken as string };
      const room = (await app.inject({ method: "POST", url: "/api/rooms", headers, payload: { name: "Bruno", initialPaneCount: 0 } })).json();
      // Space names the pane Andy; Nous may also name it by its title.
      const bob = store.createPane({ roomId: room.id, title: "Bob", mode: "MAIL_COPILOT", terminalRuntimeId: "cli:claude" });
      expect((await app.inject({ method: "POST", url: "/api/nous/messages", headers, payload: { content: "Pause Bob, then run it." } })).statusCode).toBe(202);
      await vi.waitFor(() => expect(results).toHaveLength(actions.length), { timeout: 10_000 });
      expect(results.map((result) => result.text)).toEqual(["Paused Andy.", "Andy is already paused.", "Resumed Andy.", "Andy's run is RUNNING; its agent got the kickoff.", "Stopped Andy's run."]);
      expect(results.every((result) => !result.isError)).toBe(true);
      expect(kickoffs).toHaveLength(1);
      const settings = await app.inject({ method: "GET", url: `/api/panes/${encodeURIComponent(bob.id)}/mail-copilot/settings`, headers });
      expect(settings.json().metadata.settings.paused).toBe(false);
    } finally {
      await app.close();
    }
  });
});
