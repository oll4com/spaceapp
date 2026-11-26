import { describe, expect, it } from "vitest";
import { InMemoryNousRepository } from "@space/db";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";

// 15/11 lessons ×17: lessons-own-tool-failures-1113, -prediction-misses-1112, -hands-cards-ready-now and -refs-files-private-nous re-counted
// errors the score had already charged, uncited and outside the REVIEW, so each cost −5 again.
describe("a new lesson that re-counts charged errors", () => {
  const owner = "user:operator";
  const RECOUNT = "Score 13/11: Daily Nous errors −516 (173 failures/7 days). Check table names before space_db_query.";
  const setup = () => {
    const repository = new InMemoryNousRepository();
    const tools = createNousTools({ setNote: (who, key, text) => repository.setNote(who, key, text), listNotes: (who) => repository.listNotes(who) } as unknown as NousToolDeps);
    const ctx = (reason: string, turnId = `turn:${reason}`) => ({ owner, turnId, callId: "call:1", traceId: "trace:1", turn: { reason, operatorMessage: null } }) as never;
    return { repository, tools, ctx };
  };

  it("is held once outside the REVIEW and passes when saved again unchanged", async () => {
    const { repository, tools, ctx } = setup();
    expect(await tools.execute("space_note", { key: "lessons-own-tool-failures", text: RECOUNT }, ctx("STANDING")))
      .toMatchObject({ ok: false, refused: true, display: "Held once: the lesson re-counts errors the score already charged" });
    expect((await repository.listNotes(owner)).find((note) => note.key === "lessons-own-tool-failures")).toBeUndefined();
    expect(await tools.execute("space_note", { key: "lessons-own-tool-failures", text: RECOUNT }, ctx("STANDING"))).toMatchObject({ ok: true });
  });

  it("passes at once in the REVIEW, cited, as a rewrite, or when it counts nothing", async () => {
    const { tools, ctx } = setup();
    expect(await tools.execute("space_note", { key: "lessons-r1", text: RECOUNT }, ctx("REVIEW"))).toMatchObject({ ok: true });
    expect(await tools.execute("space_note", { key: "lessons-r2", text: `Ledger 12-13/11: 57 of 81 predicted (nous_decision:missed123456).` }, ctx("STANDING"))).toMatchObject({ ok: true });
    expect(await tools.execute("space_note", { key: "lessons-r1", text: `${RECOUNT} Also read the pane state.` }, ctx("STANDING"))).toMatchObject({ ok: true });
    expect(await tools.execute("space_note", { key: "lessons-r3", text: "Self-found: I sent the plan to a closing pane; read its state first." }, ctx("STANDING"))).toMatchObject({ ok: true });
  });
});
