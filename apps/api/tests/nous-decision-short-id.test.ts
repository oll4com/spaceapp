import { describe, expect, it, vi } from "vitest";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";

// 13/11 Score lever "Daily Nous errors": space_settle_decision refused nous_decision:c25803f2, the 8-character form of an APPROVED decision.
describe("decision tools take the short id", () => {
  const approved = { id: "nous_decision:c25803f2eda640c4828c1a32", status: "APPROVED" };
  const twins = [{ id: "nous_decision:aa11bb22cc33dd44ee55ff66", status: "OPEN" }, { id: "nous_decision:aa11bb22ffffffffffffffff", status: "OPEN" }];
  const settleDecision = vi.fn(async (_owner: string, id: string) => id === approved.id ? approved : null);
  const withdraw = vi.fn(async () => true);
  const tools = createNousTools({ settleDecision, withdraw,
    decisions: async (_owner: string, _limit?: number, statuses?: string[]) => [approved, ...twins].filter((d) => !statuses || statuses.includes(d.status)) } as unknown as NousToolDeps);
  const ctx = { owner: "user:operator", turnId: "nous_turn:t1", callId: "toolu_1", traceId: "trace:1", turn: { reason: "STANDING", operatorMessage: null, replyTo: [] } } as never;

  it("settles the one decision a short id begins", async () => {
    const result = await tools.execute("space_settle_decision", { decision: "nous_decision:c25803f2", state: "VOID", reason: "sent another way" }, ctx);
    expect(result.ok).toBe(true);
    expect(settleDecision).toHaveBeenCalledWith("user:operator", approved.id, expect.anything());
  });

  it("settles with a reason of any length (12/11: a 500+ character reason was refused)", async () => {
    const reason = "Sent through Mail Copilot and confirmed in the thread. ".repeat(40);
    const result = await tools.execute("space_settle_decision", { decision: approved.id, state: "DONE", proof: "https://example.com/p/1", reason }, ctx);
    expect(result.ok).toBe(true);
    expect(settleDecision).toHaveBeenLastCalledWith("user:operator", approved.id, expect.objectContaining({ reason: reason.trim() }));
  });

  it("leaves an ambiguous short id as it was", async () => {
    await tools.execute("space_withdraw_decision", { decision: "nous_decision:aa11bb22", reason: "answered" }, ctx);
    expect(withdraw).toHaveBeenLastCalledWith("user:operator", "nous_decision:aa11bb22", "answered", undefined);
    await tools.execute("space_withdraw_decision", { decision: "nous_decision:aa11bb22cc", reason: "answered" }, ctx);
    expect(withdraw).toHaveBeenLastCalledWith("user:operator", twins[0]!.id, "answered", undefined);
  });
});
