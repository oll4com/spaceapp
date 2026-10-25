import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { InMemoryNousRepository } from "@space/db";
import { registerNousMcpRoute, signNousToken } from "../src/nous/mcp.js";
import { createNousService, NOUS_PERSONA, type NousRunner } from "../src/nous/service.js";
import { createNousSubagents, NOUS_SUBAGENT_EXCLUDED, nousSubagentTools, type NousSubagentDeps } from "../src/nous/subagents.js";
import { nousToolDefinitions } from "../src/nous/tools.js";

// Plan clipboard:BeaSM1Sle5du (operator request 2026-10-20): Nous runs up to 5 helpers at once through space_subagents.
const owner = "user:operator";
const turnId = "nous_turn:parent0001";
const minute = 60_000;

/** Helpers that wait until the test lets them answer. */
function fixture(options: { deadlineIn?: number; load?: "CALM" | "BUSY" | "OVERLOADED"; capMs?: number; answerMs?: number } = {}) {
  const parentController = new AbortController();
  let parentRunning = true;
  const release: Array<() => void> = [];
  const started: Array<{ subagentId: string; timeoutMs: number; prompt: string }> = [];
  const run: NousSubagentDeps["run"] = (input, signal) => new Promise((resolve, reject) => {
    started.push({ subagentId: input.subagentId, timeoutMs: input.timeoutMs, prompt: input.prompt });
    if (input.prompt.includes("FAIL")) { reject(new Error("The helper's Claude Code stopped.")); return; }
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    release.push(() => resolve({ text: `Report of ${input.prompt.split("\n")[0]}`, isError: false }));
  });
  const subagents = createNousSubagents({ run, ...(options.capMs ? { capMs: options.capMs } : {}), ...(options.answerMs ? { answerMs: options.answerMs } : {}),
    parent: (who, id) => who === owner && id === turnId && parentRunning ? { deadline: Date.now() + (options.deadlineIn ?? 20 * minute), signal: parentController.signal } : null,
    ...(options.load ? { load: async () => options.load! } : {}) });
  const task = (title: string) => ({ title, instructions: `Check ${title}.` });
  return { subagents, started, release, task, endParent: () => { parentRunning = false; parentController.abort(); } };
}

describe("Nous's helpers (space_subagents)", () => {
  it("keeps the operator's, memory, notes and structural tools with the parent, and gives helpers the reads and routine pane work", () => {
    const all = nousToolDefinitions({ copilots: true });
    const helperTools = nousSubagentTools(all).map((tool) => tool.name);
    const parentOnly = ["space_ask_operator", "space_withdraw_decision", "space_nous_away", "space_nous_outcome", "space_notify_operator", "space_focus_pane",
      "space_release", "space_council_approve", "space_vault_fill", "space_vault_save", "space_memory_save", "space_note", "space_subagents"];
    for (const name of parentOnly) expect(NOUS_SUBAGENT_EXCLUDED.has(name), name).toBe(true);
    expect(helperTools.filter((name) => NOUS_SUBAGENT_EXCLUDED.has(name))).toEqual([]);
    expect(helperTools).toEqual(expect.arrayContaining(["space_world", "space_read_pane", "space_send_to_pane", "space_answer_pane", "space_pane_checked",
      "space_plan_update", "space_pane_reports", "space_mail_read", "space_files_read"]));
    // Every excluded name is a real tool (no typo leaves a tool open).
    const names = new Set(all.map((tool) => tool.name));
    expect([...NOUS_SUBAGENT_EXCLUDED].filter((name) => !names.has(name) && !name.startsWith("space_vault_"))).toEqual([]);
    expect(names.has("space_subagents")).toBe(true);
  });

  it("tells Nous when to use helpers and that it keeps the decisions and the final answer", () => {
    expect(NOUS_PERSONA).toContain("Helpers (space_subagents)");
    expect(NOUS_PERSONA).toMatch(/never use them for one quick action/);
    expect(NOUS_PERSONA).toMatch(/You keep the decisions, the operator's cards, memory and notes, the outcome and the final answer/);
  });

  it("runs at most 5 helpers at once per owner and refuses the 6th clearly; 2 while BUSY, none while OVERLOADED", async () => {
    const f = fixture();
    const first = f.subagents.run(owner, turnId, [f.task("Alex"), f.task("Bruno"), f.task("Clara")]);
    await vi.waitFor(() => expect(f.started).toHaveLength(3));
    expect(await f.subagents.run(owner, turnId, [f.task("Dino"), f.task("Eva"), f.task("Finn")])).toEqual({
      refused: "At most 5 helpers run at once; 3 are running and you asked for 3. Wait for them, or send fewer tasks." });
    const second = f.subagents.run(owner, turnId, [f.task("Dino"), f.task("Eva")]);
    await vi.waitFor(() => expect(f.started).toHaveLength(5));
    expect(f.subagents.liveCount(owner)).toBe(5);
    expect(await f.subagents.run(owner, turnId, [f.task("Gus")])).toEqual({ refused: expect.stringMatching(/^At most 5 helpers run at once; 5 are running/) });
    f.release.forEach((answer) => answer());
    const results = [...("results" in (await first) ? (await first as { results: unknown[] }).results : []), ...((await second) as { results: unknown[] }).results];
    expect(results).toHaveLength(5);
    expect(f.subagents.liveCount(owner)).toBe(0);

    const busy = fixture({ load: "BUSY" });
    expect(await busy.subagents.run(owner, turnId, [busy.task("A"), busy.task("B"), busy.task("C")])).toEqual({ refused: expect.stringMatching(/^At most 2 helpers run at once while the server is BUSY/) });
    const overloaded = fixture({ load: "OVERLOADED" });
    expect(await overloaded.subagents.run(owner, turnId, [overloaded.task("A")])).toEqual({ refused: expect.stringMatching(/OVERLOADED: no helpers start now/) });
    expect(await f.subagents.run(owner, "nous_turn:other", [f.task("A")])).toEqual({ refused: "Helpers start only from a running Nous turn." });
  });

  it("caps each helper by the parent's remaining time, and a failed or timed-out helper never fails the others", async () => {
    const f = fixture({ deadlineIn: 5 * minute });
    const running = f.subagents.run(owner, turnId, [f.task("Alex")]);
    await vi.waitFor(() => expect(f.started).toHaveLength(1));
    // min(10 minutes, 5 minutes left - 1 minute margin)
    expect(f.started[0]!.timeoutMs).toBeGreaterThan(3.9 * minute);
    expect(f.started[0]!.timeoutMs).toBeLessThanOrEqual(4 * minute);
    f.release[0]!();
    await running;
    expect(await fixture({ deadlineIn: 90_000 }).subagents.run(owner, turnId, [f.task("Late")])).toEqual({ refused: expect.stringMatching(/under 2 minutes left/) });

    const mixed = fixture({ capMs: 150 });
    const outcome = mixed.subagents.run(owner, turnId, [mixed.task("Alex"), { title: "Broken", instructions: "FAIL" }, mixed.task("Slow")]);
    await vi.waitFor(() => expect(mixed.started).toHaveLength(3));
    mixed.release[0]!();
    const { results } = (await outcome) as { results: Array<{ title: string; status: string; answer: string; toolCalls: number; durationMs: number }> };
    expect(results.map(({ title, status }) => [title, status])).toEqual([["Alex", "DONE"], ["Broken", "FAILED"], ["Slow", "TIMEOUT"]]);
    expect(results[0]).toMatchObject({ answer: "Report of # Your task from Nous: Alex", toolCalls: 0 });
    expect(results[1]!.answer).toBe("The helper's Claude Code stopped.");
  });

  it("answers within the window with RUNNING for slow helpers and their run id, then reads them later (stable 2026-10-19: a 91 s helper timed the call out at 60 s)", async () => {
    const f = fixture({ answerMs: 150 });
    const call = f.subagents.run(owner, turnId, [f.task("Clara"), f.task("Paul")]);
    await vi.waitFor(() => expect(f.started).toHaveLength(2));
    f.release[0]!(); // Clara answers at once; Paul keeps working past the window
    const first = (await call) as { runId: string; done: boolean; results: Array<{ title: string; status: string; answer: string }> };
    expect(first.done).toBe(false);
    expect(first.runId).toMatch(/^nous_helpers:[a-f0-9]{20}$/);
    expect(first.results.map(({ title, status }) => [title, status])).toEqual([["Clara", "DONE"], ["Paul", "RUNNING"]]);
    expect(first.results[0]!.answer).toBe("Report of # Your task from Nous: Clara");
    expect(f.subagents.liveCount(owner)).toBe(1);
    // Another owner cannot read it; reading waits for Paul.
    expect(await f.subagents.wait("user:someone", first.runId)).toBeNull();
    const reading = f.subagents.wait(owner, first.runId);
    f.release[1]!();
    expect((await reading)!).toMatchObject({ runId: first.runId, done: true, results: [{ title: "Clara", status: "DONE" }, { title: "Paul", status: "DONE", answer: "Report of # Your task from Nous: Paul" }] });
    // The tool takes tasks or a run id.
    const schema = nousToolDefinitions({ copilots: false }).find((tool) => tool.name === "space_subagents")!.inputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual(["runId", "tasks"]);
  });

  it("serves a helper only the helpers' tools while it and its parent run, records its calls under the parent, and revokes its token after", async () => {
    const secret = "nous-subagent-secret-with-enough-length";
    const f = fixture();
    const callTool = vi.fn(async () => ({ ok: true, display: "Read Andy's screen", result: "Andy is idle." }));
    const app = Fastify();
    registerNousMcpRoute(app, { secret, service: { turnRunning: () => false, callTool }, routeOptions: {}, tools: nousToolDefinitions({ copilots: false }), subagents: f.subagents });
    await app.ready();
    const rpc = (token: string, body: unknown) => app.inject({ method: "POST", url: "/api/cli/nous/mcp", payload: body as object, headers: { authorization: `Bearer ${token}` } });
    try {
      const running = f.subagents.run(owner, turnId, [f.task("Alex"), f.task("Bruno")]);
      await vi.waitFor(() => expect(f.started).toHaveLength(2));
      const helperId = f.started[0]!.subagentId;
      const token = signNousToken(secret, { owner, turnId: helperId, expiresAt: Date.now() + minute });
      const listed = (await rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json().result.tools.map((tool: { name: string }) => tool.name) as string[];
      expect(listed).toContain("space_send_to_pane");
      expect(listed.filter((name) => NOUS_SUBAGENT_EXCLUDED.has(name))).toEqual([]);
      const refused = (await rpc(token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "space_ask_operator", arguments: {} } })).json().result;
      expect(refused).toEqual({ content: [{ type: "text", text: "space_ask_operator stays with Nous: say in your report what it should do." }], isError: true });
      await rpc(token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "space_read_pane", arguments: { room: "Main", pane: "Andy" }, _meta: { "claudecode/toolUseId": "toolu_h1" } } });
      expect(callTool).toHaveBeenCalledWith(owner, turnId, "space_read_pane", { room: "Main", pane: "Andy" }, "toolu_h1", { subagentId: helperId, title: "Alex" });
      // The parent's own turn token is not a helper's.
      expect((await rpc(signNousToken(secret, { owner, turnId, expiresAt: Date.now() + minute }), { jsonrpc: "2.0", id: 4, method: "tools/list" })).statusCode).toBe(403);
      f.release.forEach((answer) => answer());
      const { results } = (await running) as { results: Array<{ subagentId: string; toolCalls: number }> };
      expect(results.find((result) => result.subagentId === helperId)!.toolCalls).toBe(1);
      // Done: the helper's token no longer works.
      expect((await rpc(token, { jsonrpc: "2.0", id: 5, method: "tools/list" })).json()).toEqual({ error: "This Nous helper is over." });

      // The parent ending revokes a running helper's token too.
      const again = f.subagents.run(owner, turnId, [f.task("Clara")]);
      await vi.waitFor(() => expect(f.started).toHaveLength(3));
      const late = signNousToken(secret, { owner, turnId: f.started[2]!.subagentId, expiresAt: Date.now() + minute });
      f.endParent();
      expect((await rpc(late, { jsonrpc: "2.0", id: 6, method: "tools/list" })).statusCode).toBe(403);
      expect(((await again) as { results: Array<{ status: string }> }).results[0]!.status).toBe("FAILED");
    } finally {
      await app.close();
    }
  });

  it("audits a helper's call in the conversation with its subagent id and the parent turn id", async () => {
    const repository = new InMemoryNousRepository();
    let service!: ReturnType<typeof createNousService>;
    const runner: NousRunner = async (input) => {
      expect(service.turnContext(owner, input.turnId)).toMatchObject({ deadline: expect.any(Number), signal: expect.any(AbortSignal) });
      await service.callTool(owner, input.turnId, "space_world", {}, "toolu_helper", { subagentId: "nous_helper:abc123", title: "Check Alex" });
      return { text: "Done.", isError: false };
    };
    service = createNousService({ repository, runner, tools: { execute: vi.fn(async () => ({ ok: true, display: "Looked at everything", result: "# The world now" })) } as never,
      world: async () => ({ text: "# The world now", overview: {} as never }),
      settings: async () => ({ enabled: true, maxTurnsPerHour: 20, mayPromote: false, mayApproveWarm: false }), saveSettings: async (_owner, value) => value,
      notifications: { raise: vi.fn(async () => ({}) as never), resolve: vi.fn(async () => {}) }, executeAction: vi.fn() });
    await service.send(owner, "Check every pane", { person: true });
    await service.idle(owner);
    const tool = (await repository.listMessages(owner, 20)).find((message) => message.kind === "TOOL")!;
    expect(tool).toMatchObject({ status: "DONE", content: "Check Alex: Looked at everything", meta: { name: "space_world", subagentId: "nous_helper:abc123", parentTurnId: tool.turnId } });
    expect(service.turnContext(owner, tool.turnId!)).toBeNull();
  });
});
