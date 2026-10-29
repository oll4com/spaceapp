import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryNousRepository } from "@space/db";
import { createNousService } from "../src/nous/service.js";
import { computeNousTokens } from "../src/nous/tokens.js";
import { NOUS_CONNECT_CLAUDE, NOUS_UPDATE_CLI, nousTurnBackend } from "../src/nous/wiring.js";
import { createNousTools, nousToolDefinitions } from "../src/nous/tools.js";
import { nousLowSpendSettingsSchema, nousSettingsSchema, withNousPublicDefaults } from "@space/contracts";

const owner = "user:operator";
const config = (extra: Record<string, unknown>) => ({ instance: "stable", publicDistribution: false, cliEnabled: true, cliHostSocketPath: "/run/x/host.sock", ...extra }) as never;

describe("where Nous's turns run (plan clipboard:1NF6u6gcCwtj, operator decision 2026-10-27, B+C3)", () => {
  it("stable's worker, nothing on dev, and on a public install the CLI container once Claude Code is signed in", async () => {
    expect(await nousTurnBackend({ config: config({}) }).unavailable()).toBeNull();
    expect(nousTurnBackend({ config: config({}) }).run).not.toBeNull();
    const dev = nousTurnBackend({ config: config({ instance: "dev" }) });
    expect(dev.run).toBeNull();
    expect(await dev.unavailable()).toMatch(/only on the stable instance/);
    expect(await nousTurnBackend({ config: config({ publicDistribution: true, cliEnabled: false }) }).unavailable()).toMatch(/needs the CLI container/);
    // A runner the caller brings (tests) is always there.
    expect(await nousTurnBackend({ config: config({ instance: "dev" }), runner: async () => ({ text: "", isError: false }) }).unavailable()).toBeNull();

    const root = await mkdtemp("/tmp/space-public-nous-");
    let ready = false;
    let old = false;
    const requests: Array<Record<string, unknown>> = [];
    const agent = createServer({ allowHalfOpen: true }, (socket) => {
      let body = "";
      socket.setEncoding("utf8").on("data", (chunk) => {
        body += chunk;
        if (!body.includes("\n")) return;
        const request = JSON.parse(body.split("\n")[0]!) as Record<string, unknown>;
        requests.push(request);
        if (request.action === "credential-status") { socket.end(`${JSON.stringify({ exitCode: ready ? 0 : 1, stdout: ready ? "READY\n" : "NOT_READY\n" })}\n`); return; }
        // A CLI container from before agent-tools (run-spaceapp 1.1.9) refuses the action.
        if (old) { socket.end(`${JSON.stringify({ exitCode: 64, stdout: "FAILED bad-request\n" })}\n`); return; }
        socket.end(`${JSON.stringify({ type: "result", subtype: "success", result: "Done.", num_turns: 1, total_cost_usd: 0.01 })}\n\n\x1e${JSON.stringify({ exitCode: 0, stderr: "" })}\n`);
      });
    });
    await new Promise<void>((resolve) => agent.listen(join(root, "credentials.sock"), resolve));
    try {
      const signedOut = nousTurnBackend({ config: config({ publicDistribution: true, cliHostSocketPath: join(root, "host.sock") }) });
      expect(await signedOut.unavailable()).toBe(NOUS_CONNECT_CLAUDE);
      expect(requests[0]).toEqual({ command: "claude-vscode-parity", action: "credential-status" });
      ready = true;
      const backend = nousTurnBackend({ config: config({ publicDistribution: true, cliHostSocketPath: join(root, "host.sock") }) });
      expect(await backend.unavailable()).toBeNull();
      // The answer is read at most once a minute, not on every dock refresh.
      await backend.unavailable();
      expect(requests).toHaveLength(2);
      expect(await backend.run!({ model: "claude-sonnet-5-5", effort: "medium", fallbackModel: null, system: "s", prompt: "p", maxTurns: 80, timeoutMs: 60_000, shell: false,
        mcpUrl: "http://spaceapp-core:4911/api/cli/nous/mcp", mcpToken: "tok_0123456789abcdefghij" }, new AbortController().signal))
        .toEqual({ text: "Done.", isError: false, costUsd: 0.01, tokens: null });
      expect(JSON.parse(String(requests.at(-1)!.input))).toEqual({ model: "claude-sonnet-5-5", effort: "medium", system: "s", prompt: "p", maxTurns: 80, shell: false, stream: false,
        mcpUrl: "http://spaceapp-core:4911/api/cli/nous/mcp", mcpToken: "tok_0123456789abcdefghij" });
      // An older CLI container: one answer saying to update, then Nous is unavailable (no turn of its own fails again and again).
      old = true;
      await expect(backend.run!({ model: "claude-sonnet-5-5", effort: "medium", system: "s", prompt: "p", maxTurns: 80, timeoutMs: 60_000,
        mcpUrl: "http://spaceapp-core:4911/api/cli/nous/mcp", mcpToken: "tok_0123456789abcdefghij" }, new AbortController().signal)).rejects.toThrow(NOUS_UPDATE_CLI);
      expect(await backend.unavailable()).toBe(NOUS_UPDATE_CLI);
    } finally {
      agent.close();
    }
  });

  it("while no turn can run, the dock says why and no turn of Nous's own starts", async () => {
    let unavailable: string | null = NOUS_CONNECT_CLAUDE;
    const runs: string[] = [];
    const repository = new InMemoryNousRepository();
    let settings = { enabled: true, maxTurnsPerHour: 20 };
    const service = createNousService({
      repository,
      runner: async (input) => { runs.push(input.reason); return { text: "Done.", isError: false }; },
      tools: { execute: async () => ({ ok: true, display: "", result: "" }) },
      world: async () => ({ text: "# The world now", overview: { plans: [], needsHands: [], trains: "", planMap: null } }),
      settings: async () => settings as never,
      saveSettings: async (_owner, value) => { settings = value as never; return value; },
      notifications: { raise: async () => ({}) as never, resolve: async () => {} } as never,
      executeAction: async () => "",
      unavailable: async () => unavailable,
      limits: { inboxDebounceMs: 10 }
    });
    expect(await service.state(owner)).toMatchObject({ status: "UNAVAILABLE", unavailable: NOUS_CONNECT_CLAUDE });
    await service.notice(owner, "pane:a", "Andy finished.");
    expect(await service.standing(owner, "STANDING", "## Finished panes\n- Andy")).toBe("PAUSED");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runs).toEqual([]);
    // Claude Code is connected: the waiting line runs with the next one.
    unavailable = null;
    expect((await service.state(owner)).status).toBe("IDLE");
    await service.notice(owner, "pane:b", "Bea finished.");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await service.idle(owner);
    expect(runs).toEqual(["INBOX"]);
    expect((await repository.listMessages(owner, 10)).find((message) => message.kind === "INBOX")?.content).toMatch(/Andy finished\.\nBea finished\./);
  });

  it("hides what a self-hosted install has no service for, and its Low-spend mode reads unknown, never CRITICAL", async () => {
    const names = (publicInstall: boolean) => nousToolDefinitions({ copilots: true, publicInstall }).map((tool) => tool.name);
    const hidden = ["space_git", "space_queue_status", "space_release", "space_ops_gateway", "space_vault_fill", "space_vault_list", "space_vault_save"];
    expect(names(false)).toEqual(expect.arrayContaining(hidden));
    expect(names(true).filter((name) => hidden.includes(name))).toEqual([]);
    expect(names(true)).toEqual(expect.arrayContaining(["space_world", "space_goals", "space_vault_key_list", "space_db_query"]));
    // A call that names one anyway is refused before it reaches its service.
    const ctx = { owner, turnId: "turn:1", callId: "c1", traceId: "t1" };
    expect(await createNousTools({ publicInstall: true } as never).execute("space_git", { op: "log", repo: "stable" }, ctx))
      .toEqual({ ok: false, display: "space_git is not available here", result: "space_git needs a service a self-hosted install does not run." });
    // The wiring gives a public install no Gateway admin: no account list reads unknown; an empty one would read CRITICAL.
    const settings = nousLowSpendSettingsSchema.parse({});
    expect(computeNousTokens({ accounts: null, settings, now: Date.now() }).mode).toBe("NORMAL");
    expect(computeNousTokens({ accounts: [], settings, now: Date.now() }).mode).toBe("CRITICAL");
  });

  it("starts lean on a self-hosted install and keeps what the owner chose", () => {
    const lean = nousSettingsSchema.parse(withNousPublicDefaults({}));
    expect(lean).toMatchObject({ enabled: false, maxTurnsPerHour: 6, shell: false, paneBoard: { enabled: false }, standingOrders: { closeFinishedPanes: false, dailyReview: false },
      goals: { gapSeconds: 900, loop: true } });
    expect(Object.values(lean.models)).toEqual([...Array(6)].map((_, index) => ({ model: "claude-sonnet-5-5", effort: index < 2 ? "medium" : "low" })));
    const chosen = nousSettingsSchema.parse(withNousPublicDefaults({ shell: true, models: { operator: { model: "claude-opus-5-5", effort: "high" } }, goals: { loop: false } }));
    expect(chosen).toMatchObject({ shell: true, maxTurnsPerHour: 6, goals: { loop: false, gapSeconds: 900 }, models: { operator: { model: "claude-opus-5-5", effort: "high" }, goal: { model: "claude-sonnet-5-5", effort: "low" } } });
  });

  it("turns on only once Claude Code is connected (the one switch)", async () => {
    let unavailable: string | null = NOUS_CONNECT_CLAUDE;
    let settings = nousSettingsSchema.parse(withNousPublicDefaults({}));
    const service = createNousService({
      repository: new InMemoryNousRepository(),
      runner: async () => ({ text: "Done.", isError: false }),
      tools: { execute: async () => ({ ok: true, display: "", result: "" }) },
      world: async () => ({ text: "# The world now", overview: { plans: [], needsHands: [], trains: "", planMap: null } }),
      settings: async () => settings,
      saveSettings: async (_owner, value) => { settings = value; return value; },
      notifications: { raise: async () => ({}) as never, resolve: async () => {} } as never,
      executeAction: async () => "",
      unavailable: async () => unavailable,
      enableNeedsRunner: true
    });
    await expect(service.saveSettings(owner, { enabled: true })).rejects.toThrow(NOUS_CONNECT_CLAUDE);
    expect(settings.enabled).toBe(false);
    // Other settings still save meanwhile.
    expect((await service.saveSettings(owner, { maxTurnsPerHour: 4 })).maxTurnsPerHour).toBe(4);
    unavailable = null;
    expect((await service.saveSettings(owner, { enabled: true })).enabled).toBe(true);
  });
});
