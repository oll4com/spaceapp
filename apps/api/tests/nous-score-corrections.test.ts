import { describe, expect, it } from "vitest";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";
import { errorCause } from "../src/room-agent-tools.js";

// 13/11 Score lever "Daily Nous errors": a card answer ("[Room · Pane] My answer to …") is never an operator correction.
describe("space_nous_outcome corrections", () => {
  const card = { id: "nous_msg:card0001", kind: "OPERATOR", ownerUserId: "user:operator", meta: { person: true },
    content: "[Dino · Emma] My answer to \"Outlier: να συνεχίσω;\": ναι" };
  const real = { id: "nous_msg:real0001", kind: "OPERATOR", ownerUserId: "user:operator", meta: { person: true },
    content: "Λάθος, το B2 είναι κλειστό μόνο στο pve-az" };
  const tools = createNousTools({ listConversation: async () => [card, real] } as unknown as NousToolDeps);
  const ctx = (replyTo: string[]) => ({ owner: "user:operator", turnId: "nous_turn:t1", callId: "toolu_1", traceId: "trace:1",
    turn: { reason: "STANDING", operatorMessage: null, replyTo } }) as never;
  const report = async (replyTo: string[], id?: string) => {
    const result = await tools.execute("space_nous_outcome", { requests: [{ summary: "x", outcome: "PENDING", correction: true, ...(id ? { id } : {}) }] }, ctx(replyTo));
    return (result as { outcomes?: Array<{ correction?: boolean }> }).outcomes?.[0];
  };

  it("drops correction when the bound message is a card answer", async () => {
    expect((await report([card.id]))?.correction).toBeUndefined();
    expect((await report([], card.id))?.correction).toBeUndefined();
  });

  it("keeps a real correction and one with no bound message", async () => {
    expect((await report([real.id]))?.correction).toBe(true);
    expect((await report([]))?.correction).toBe(true);
  });
});

describe("space_db_query failures (13/11 Score lever)", () => {
  it("tells a slow query apart from an unavailable database", () => {
    const slow = errorCause("Postgres: canceling statement due to statement timeout (code 57014)");
    expect(slow).toContain("query too slow");
    expect(slow).not.toContain("database unavailable");
    expect(errorCause("Connection terminated unexpectedly")).toContain("database unavailable");
  });
});

describe("Nous persona (13/11 Score lever)", () => {
  it("asks for a re-check or a date before a remembered fact is stated as current", async () => {
    const persona = (await import("../src/nous/service.js")).NOUS_PERSONA;
    expect(persona).toContain("give its date and say you did not re-check it");
    expect(persona).toContain("not a new request, a card answer or a repeat while you were still working");
  });
});
