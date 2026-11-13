// Cause 5 (13/11): operator 9/11 «Pause Ολα τα goals» and 12/11 «ενεργοποίησε ξανά τα πάντα»; Nous had no way to do either, so 10-11/11 ran
// 0 GOAL turns and the loop waited for the operator's Resume clicks. Now space_goal_update pauses or resumes a goal on the operator's own message.
import { describe, expect, it } from "vitest";
import type { NousMessage } from "@space/contracts";
import { InMemoryNousGoalsRepository } from "@space/db";
import { createNousGoals } from "../src/nous/goals.js";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";

const owner = "user:operator";
const ctx = { owner, turnId: "nous_turn:t1", callId: "toolu_1", traceId: "trace:1" };
const message = (id: string, kind: string, person: boolean) => ({ id, ownerUserId: owner, kind, meta: { person } }) as unknown as NousMessage;

describe("space_goal_update status on the operator's order", () => {
  it("pauses and resumes only with the operator's own message, and the loop follows", async () => {
    const repository = new InMemoryNousGoalsRepository();
    const goals = createNousGoals({ repository, plans: async () => [], turnFacts: async () => [], timeZone: async () => "Asia/Bangkok", now: () => Date.now() });
    const tools = createNousTools({ ownerTimeZone: async () => "Asia/Bangkok",
      listConversation: async () => [message("nous_msg:order1", "OPERATOR", true), message("nous_msg:answer1", "ANSWER", false), message("nous_msg:agent1", "OPERATOR", false)],
      goals: { list: (who, options) => goals.list(who, options), recordUpdate: (who, args, turnId) => goals.recordUpdate(who, args, turnId) } } as unknown as NousToolDeps);
    const goal = await goals.create(owner, "≥ 3.000 €/month from remote work", "the operator");

    for (const order of [undefined, "nous_msg:answer1", "nous_msg:agent1", "nous_msg:missing1"]) {
      expect(await tools.execute("space_goal_update", { goal: goal.id, status: "PAUSED", ...(order ? { order } : {}) }, ctx), String(order)).toMatchObject({ ok: false, refused: true });
    }
    expect((await repository.get(owner, goal.id))!.status).toBe("ACTIVE");

    expect(await tools.execute("space_goal_update", { goal: goal.id, status: "PAUSED", order: "nous_msg:order1" }, ctx)).toMatchObject({ ok: true });
    expect((await repository.get(owner, goal.id))!.status).toBe("PAUSED");
    expect(await goals.pick(owner, Date.now())).toBeNull();

    expect(await tools.execute("space_goal_update", { goal: goal.id, status: "ACTIVE", order: "nous_msg:order1" }, ctx)).toMatchObject({ ok: true });
    expect(await repository.get(owner, goal.id)).toMatchObject({ status: "ACTIVE", nextTurnAt: null });
    expect((await goals.pick(owner, Date.now()))?.id).toBe(goal.id);
    const events = await repository.listEvents(owner, [goal.id], 10);
    expect(events.map((event) => event.text)).toEqual(expect.arrayContaining(["Paused by Nous on the operator's order nous_msg:order1", "Resumed by Nous on the operator's order nous_msg:order1"]));
  });
});
