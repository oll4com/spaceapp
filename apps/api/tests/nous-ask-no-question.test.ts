// Operator 21/11 22:3x BKK «μου δινεις ερωτησεις χωρις να υπαρχει ερωτηση»: space_ask_operator asks nothing that has no question, choice or action.
import { describe, expect, it } from "vitest";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";

const ctx = { owner: "user:operator", turnId: "turn:nq1", callId: "call:1", traceId: "trace:1", turn: { reason: "OPERATOR", operatorMessage: null } } as never;
const ask = (args: Record<string, unknown>) => createNousTools({} as unknown as NousToolDeps)
  .execute("space_ask_operator", { category: "DIRECTION", recommendation: "Go ahead.", checked: ["pane reports: read"], ...args }, ctx);

describe("space_ask_operator with nothing to answer", () => {
  it("holds status, FYI and acknowledge-only options", async () => {
    expect(await ask({ title: "spaceapp-hz switches are on", body: "Both switches answer on the network." })).toMatchObject({ ok: false, refused: true, display: "Nothing to answer" });
    expect(await ask({ title: "Upwork 44913614 waits on you", body: "", options: ["OK", "Εντάξει"] })).toMatchObject({ display: "Nothing to answer" });
    expect((await ask({ title: "Did you turn on both switches?", body: "" })).result).toMatch(/never asks whether the operator did/);
  });

  it("lets a question, a proposal (the title, recommendation yes), a real choice or an approval through to the ask's other gates", async () => {
    for (const args of [{ title: "Which plan do we buy?", body: "Pro is $20, Team $30." }, { title: "Anthropic plan", body: "", options: ["Pro", "Team"] }, { title: "Restart the build VM at 18:00", body: "At 18:00." },
      { title: "Publish 0.3.0", body: "", action: { kind: "PANE_TEXT", roomId: "room:x", paneId: "pane:y" } }])
      expect((await ask(args)).display).not.toBe("Nothing to answer");
  });
});
