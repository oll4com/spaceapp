import { describe, expect, it, vi } from "vitest";
import { NOUS_PROMPT_MAX_CHARS } from "@space/contracts";
import { InMemoryNousRepository } from "@space/db";
import { fitPrompt, worldParts } from "../src/nous/prompt-budget.js";
import { createNousService, NOUS_HISTORY_MAX_CHARS, type NousRunner } from "../src/nous/service.js";

const owner = "user:operator";
const lines = (prefix: string, count: number, width = 80) => Array.from({ length: count }, (_, index) => `${prefix} ${index} ${"x".repeat(width)}`).join("\n");

describe("Nous turn prompt budget (operator 1/11 14:53 BKK: stable 1/11 09:33-10:00 UTC, 59 operator turns failed \"Invalid prompt.\" past the worker's 400,000)", () => {
  it("joins the parts unchanged under the bound", () => {
    const parts = [{ name: "a", text: "A\nA2", rank: 2 }, { name: "b", text: "", rank: 1 }, { name: "c", text: "C", rank: 3 }];
    expect(fitPrompt(parts, 100)).toEqual({ text: "A\nA2\n\nC", cuts: [] });
  });

  it("cuts the lowest rank first, at a line boundary, and names the rest with how to read it", () => {
    const parts = [{ name: "the turn", text: "Answer now.", rank: 100 }, { name: "the notes", text: lines("note", 50), rank: 20, readHow: "space_notes {key} reads one" },
      { name: "the memory", text: lines("mem", 50), rank: 10, readHow: "space_memory_recall reads it" }];
    const fitted = fitPrompt(parts, 3_000);
    expect(fitted.text.length).toBeLessThanOrEqual(3_000);
    expect(fitted.cuts.map((cut) => cut.name)).toEqual(["the memory", "the notes"]);
    // The memory went first (down to its note alone), then the notes lost only what was still over.
    expect(fitted.text).toMatch(/^Answer now\.\n\nnote 0 x+\n(?:note \d+ x+\n)+… \(the notes: [\d,]+ characters left out of this turn to fit the model's context; space_notes \{key\} reads one\)\n\n… \(the memory: 4,[\d]{3} characters left out of this turn to fit the model's context; space_memory_recall reads it\)$/);
    // Whole lines only: every kept note line keeps its 80 characters.
    expect(fitted.text.match(/^note \d+ (x+)$/gm)!.every((line) => line.endsWith("x".repeat(80)))).toBe(true);
  });

  it("a head cut keeps the heading and the newest lines; a part no longer than its note is left alone", () => {
    const history = `# Conversation so far\n${lines("Operator:", 40)}`;
    const fitted = fitPrompt([{ name: "the conversation's oldest part", text: history, rank: 40, cut: "head", readHow: "the dock keeps it" }, { name: "tiny", text: "T", rank: 1 }], 1_200);
    expect(fitted.text.length).toBeLessThanOrEqual(1_200);
    expect(fitted.text).toMatch(/^# Conversation so far\n… \(the conversation's oldest part: [\d,]+ characters left out[^\n]*the dock keeps it\)\nOperator: \d+ x+\n(?:Operator: \d+ x+\n)*Operator: 39 x+\n\nT$/);
    expect(fitted.cuts).toEqual([{ name: "the conversation's oldest part", whole: history.length, kept: expect.any(Number) }]);
  });

  it("splits the world at its sections: the notes go first, then the sections from the tail, the head last", () => {
    const parts = worldParts("Tokens: ok\n\n# The world now\n## Goals\n- g\n## Rooms and panes\n### Alex\n- Andy\n## Your notes\n### plan-map\ntext\n## Your cards\n- c", { notes: 20, tail: 50 });
    expect(parts.map((part) => [part.name, part.rank])).toEqual([["the world's head", 54], ["## Goals", 53], ["## Rooms and panes", 52], ["## Your notes", 20], ["## Your cards", 50]]);
    expect(parts[3]!.readHow).toContain("space_notes");
    expect(parts[1]!.readHow).toContain("space_world reads the whole world");
    expect(parts.map((part) => part.text).join("\n")).toBe("Tokens: ok\n\n# The world now\n## Goals\n- g\n## Rooms and panes\n### Alex\n- Andy\n## Your notes\n### plan-map\ntext\n## Your cards\n- c");
  });

  it("a turn whose world and conversation pass the bound still runs, within it, with the operator's message, the turn's orders and the world's head whole", async () => {
    const repository = new InMemoryNousRepository();
    const requests: Array<Parameters<NousRunner>[0]> = [];
    const world = ["Tokens: ok", "# The world now (2026-11-01)", "## Goals\n- [nous_goal:1] «θελω να αναβαθμιζεσαι καθε μέρα» ACTIVE", "## Operator requests waiting\n- [nous_msg:1] «promote» 3 h, Bruno/Max working",
      `## Rooms and panes\n### Alex\n${lines("- Andy · CLI", 20)}`, `## Waiting for the operator now (open notifications, newest first)\n${lines("- [notif]", 400)}`,
      `## Your notes\n### plan-map\n${lines("plan", 2_000)}`].join("\n\n");
    const service = createNousService({
      repository, runner: async (input) => { requests.push(input); return { text: "Έγινε.", isError: false }; }, tools: { execute: vi.fn(async () => ({ ok: true, display: "did", result: "r" })) },
      world: async () => ({ text: world, overview: { plans: [], needsHands: [], trains: "", planMap: null } }),
      settings: async () => ({ enabled: true, maxTurnsPerHour: 20 }), saveSettings: async (_owner, value) => value, notifications: { raise: vi.fn(async () => ({})), resolve: vi.fn(async () => {}) } as never,
      executeAction: vi.fn(async () => "ok"), limits: { inboxDebounceMs: 10 }
    });
    for (let index = 0; index < 60; index += 1) await repository.addMessage({ ownerUserId: owner, turnId: null, kind: "ANSWER", status: "DONE", content: lines(`old answer ${index}`, 30) });
    await service.send(owner, "Στείλε το promote στον Max τώρα.", { person: true });
    await service.idle(owner);
    const prompt = requests[0]!.prompt;
    expect(world.length + NOUS_HISTORY_MAX_CHARS).toBeGreaterThan(NOUS_PROMPT_MAX_CHARS);
    expect(prompt.length).toBeLessThanOrEqual(NOUS_PROMPT_MAX_CHARS);
    expect(prompt).toContain("Στείλε το promote στον Max τώρα.");
    expect(prompt).toContain("Answer every operator message listed");
    expect(prompt).toContain("## Goals\n- [nous_goal:1]");
    expect(prompt).toContain("## Operator requests waiting\n- [nous_msg:1]");
    expect(prompt).toContain("- Andy · CLI 19 ");
    expect(prompt).toMatch(/## Your notes\n### plan-map\nplan 0 x+\n[\s\S]*… \(## Your notes: [\d,]+ characters left out of this turn to fit the model's context; space_notes \{key\} reads one note whole, \{q\} searches them by words\)/);
    expect(prompt).toContain("old answer 59 29 ");
    expect(prompt).not.toContain("space_world reads the whole world");
    expect(requests[0]!.prompt.length).toBeLessThan(400_000);
  });
});
