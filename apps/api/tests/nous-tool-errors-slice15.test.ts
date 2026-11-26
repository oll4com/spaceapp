import { describe, expect, it, vi } from "vitest";
import type { Pane } from "@space/contracts";
import { CliTerminalControlRequiredError } from "../src/cli-http-control.js";
import { heldToolFailures, historicalToolHold } from "../src/nous/tool-holds.js";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";

/** Daily Nous errors 14/11 slice 15 (plan 1NF6u6gcCwtj step 4): the Score's own cause list. */

const ctx = { owner: "user:operator", turnId: "nous_turn:t15", callId: "toolu_15", traceId: "trace:15" };
const bob = { id: "pane:bob00001", roomId: "room:bruno001", paneName: "Bob", title: "Bob", mode: "MAIL_COPILOT", terminalRuntimeId: "cli:claude", isClosed: false } as unknown as Pane;
const tools = (deps: Partial<NousToolDeps>) => createNousTools({ rooms: async () => [{ id: "room:bruno001", name: "Bruno" }], listPanes: async () => [bob], ...deps } as unknown as NousToolDeps);

describe("Daily Nous errors 14/11 slice 15", () => {
  it("answers a statement timeout whose plan names the slow scan as a refusal; since slice 19 r2 one with no plan too (its answer says how to narrow it)", async () => {
    const slow = "Postgres: canceling statement due to statement timeout (code 57014)\nWhere the time goes (PostgreSQL's plan of this query): it reads all of nous_messages (≈1.2M rows).";
    const query = vi.fn().mockRejectedValueOnce(new Error(slow)).mockRejectedValueOnce(new Error("Postgres: canceling statement due to statement timeout (code 57014)"));
    const db = tools({ db: { query } as never });
    expect(await db.execute("space_db_query", { sql: "SELECT * FROM nous_messages" }, ctx)).toMatchObject({ ok: false, refused: true, meta: { dbCode: "57014" } });
    const plain = await db.execute("space_db_query", { sql: "SELECT 1" }, ctx);
    expect(plain).toMatchObject({ ok: false, refused: true, meta: { dbCode: "57014" } });
  });

  it("answers a restricted table or secret column (42501) as a refusal naming the readable columns, never a thrown error (W48 step 2)", async () => {
    const denied = "Postgres: permission denied for table mail_open_messages (code 42501)\nReadable columns of mail_open_messages: id, token, created_at";
    const db = tools({ db: { query: vi.fn().mockRejectedValue(new Error(denied)) } as never });
    const out = await db.execute("space_db_query", { sql: "SELECT * FROM mail_open_messages" }, ctx);
    expect(out).toMatchObject({ ok: false, refused: true, meta: { dbCode: "42501" }, result: expect.stringContaining("Readable columns of mail_open_messages") });
    // 23/11 00:03Z's recorded sample (before the refusal) is held too, so the Score and the live rule agree.
    expect(historicalToolHold("space_db_query", "Postgres: permission denied for table mail_open_messages (code 42501)")).toBe(true);
  });

  it("answers the operator's control lease on a copilot's CLI as a refusal that says to leave the pane to them", async () => {
    const control = vi.fn(async () => { throw new CliTerminalControlRequiredError(); });
    const held = await tools({ copilots: { control } } as never).execute("space_copilot_control", { room: "Bruno", pane: "Bob", action: "stop_agent" }, ctx);
    expect(held).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("Leave the pane to them") });
    expect(historicalToolHold("space_copilot_control", "Bob: stop agent: Take control of this CLI pane before changing its active session.")).toBe(true);
  });

  it("holds every stored sample of a held cause, not only the first 3 of a turn", () => {
    const text = "Task item task:x was not found. It is the plan clipboard:x: change it with space_plan_update.";
    expect(historicalToolHold("space_task_update", text)).toBe(true);
    expect(heldToolFailures("space_task_update", { calls: 6, failed: 6, refused: 0, errors: Array(6).fill(text) })).toBe(6);
    // A call with no stored text stays charged.
    expect(heldToolFailures("space_task_update", { calls: 6, failed: 6, refused: 0, errors: Array(3).fill(text) })).toBe(3);
  });
});
