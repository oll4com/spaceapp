import { describe, expect, it, vi } from "vitest";
import { InMemoryNousRepository } from "@space/db";
import { createNousService } from "../src/nous/service.js";
import type { NousRunner } from "../src/nous/service.js";

const owner = "user:fan-out";

// Daily Nous errors 22/11 (21/11 17:46Z «κόλλησε»: 7 answers in 2 min from an operator turn and inbox turns beside it, contradicting each other):
// while an operator turn runs, a background turn neither replies now nor posts its final answer; that turn reads it, or its end posts it.
function fixture(operatorCallsTool: boolean) {
  const repository = new InMemoryNousRepository();
  const late: { service?: ReturnType<typeof createNousService> } = {};
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const seen = { interim: "", toolResult: "" };
  const background = ["No sign that SpaceApp is stuck.", "Second check: the queue drains too."];
  const runner: NousRunner = async (input) => {
    if (input.reason === "OPERATOR") {
      await gate;
      if (operatorCallsTool) seen.toolResult = (await late.service!.callTool(owner, input.turnId, "space_check_services", {}, "toolu_1")).result;
      return { text: "Stable restarted at 00:43; it works again.", isError: false };
    }
    seen.interim = await late.service!.replyNow(owner, input.turnId, "Looking now.");
    return { text: background.shift() ?? "Nothing more.", isError: false };
  };
  const service = late.service = createNousService({
    repository, runner, tools: { execute: vi.fn(async () => ({ ok: true, display: "Checked", result: "all healthy" })) as never },
    world: async () => ({ text: "# The world now", overview: { plans: [], needsHands: [], trains: "", planMap: null } }),
    settings: async () => ({ enabled: true, maxTurnsPerHour: 20 }) as never, saveSettings: async (_owner, value) => value,
    notifications: { raise: vi.fn(async () => ({}) as never), resolve: vi.fn(async () => {}) } as never, executeAction: vi.fn(async () => ""),
    autonomous: false, limits: { inboxDebounceMs: 5 }
  });
  const answers = async () => (await repository.listMessages(owner, 30)).filter((message) => message.kind === "ANSWER").map((message) => message.content);
  return { service, repository, release, seen, answers };
}

describe("one voice per operator message", () => {
  it("hands a background turn's answer to the running operator turn's next tool answer, and refuses its reply now", async () => {
    const f = fixture(true);
    await f.service.send(owner, "Σαν να έχει κολλήσει το spaceapp!!", { person: true });
    await f.service.notice(owner, "monitor:a", "Utilization under target");
    await vi.waitFor(() => expect(f.seen.interim).not.toBe(""));
    expect(f.seen.interim).toBe("BESIDE");
    f.release();
    await f.service.idle(owner);
    expect(f.seen.toolResult).toContain("# Your background turn ended while this turn runs");
    expect(f.seen.toolResult).toContain("No sign that SpaceApp is stuck.");
    expect(await f.answers()).toEqual(["Stable restarted at 00:43; it works again."]);
  });

  it("posts the held answer after the operator turn's own when that turn calls no tool after it (never lost)", async () => {
    const f = fixture(false);
    await f.service.send(owner, "Σαν να έχει κολλήσει το spaceapp!!", { person: true });
    await f.service.notice(owner, "monitor:a", "Utilization under target");
    await vi.waitFor(() => expect(f.seen.interim).toBe("BESIDE"));
    // The inbox turn's end is what holds its answer: wait for it before the operator turn ends.
    await vi.waitFor(async () => expect((await f.repository.listTurnFacts(owner, "2000-01-01T00:00:00.000Z")).map((facts) => facts.reason)).toEqual(["INBOX"]));
    f.release();
    await f.service.idle(owner);
    expect(await f.answers()).toEqual(["Stable restarted at 00:43; it works again.", "No sign that SpaceApp is stuck."]);
  });

  it("posts a background answer that ends while the operator turn posts its held ones (never lost)", async () => {
    const f = fixture(false);
    const facts = async () => (await f.repository.listTurnFacts(owner, "2000-01-01T00:00:00.000Z")).filter((row) => row.reason === "INBOX").length;
    const add = f.repository.addMessage.bind(f.repository);
    // While the first held answer is written, a second inbox turn ends: its answer must not go into the list already drained.
    f.repository.addMessage = async (input) => {
      if (input.content === "No sign that SpaceApp is stuck.") {
        await f.service.notice(owner, "monitor:b", "Queue slow");
        await vi.waitFor(async () => expect(await facts()).toBe(2), { timeout: 3000 });
      }
      return add(input);
    };
    await f.service.send(owner, "Σαν να έχει κολλήσει το spaceapp!!", { person: true });
    await f.service.notice(owner, "monitor:a", "Utilization under target");
    await vi.waitFor(async () => expect(await facts()).toBe(1));
    f.release();
    await f.service.idle(owner);
    // Order is the test's doing (it holds the first write); the operator turn has ended, so the second turn's reply now posts too.
    await vi.waitFor(async () => expect(await f.answers()).toContain("Second check: the queue drains too."));
    expect(await f.answers()).toEqual(expect.arrayContaining(["Stable restarted at 00:43; it works again.", "No sign that SpaceApp is stuck.", "Second check: the queue drains too."]));
  });
});
