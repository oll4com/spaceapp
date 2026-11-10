import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { configureQueueOperatorGrants, allowPaneQueueCommand, noteOperatorPaneInput, noteOperatorPromoteLine, queueOperatorOp, registerQueueOperatorGrantRoute } from "../src/queue-operator-grants.js";

const secret = "test-secret-with-enough-length";

describe("merge queue operator grants (hardening step 5)", () => {
  // The cases checked against the queue's own verifier (scripts/space-queue-operator-grant.mjs, not in the public tree):
  // queue-operator-grants-verify.test.ts.
  it("names the operator-only command a text asks for, never one it forbids", () => {
    expect(queueOperatorOp("npm run live:verify:dev && space-queue promote --wait")).toBe("promote");
    expect(queueOperatorOp("space-queue approve q-20261019-051103-9daf")).toBe("approve:q-20261019-051103-9daf");
    expect(queueOperatorOp("Finish the tests; never space-queue promote.")).toBeNull();
    expect(queueOperatorOp("space-queue submit --worktree . --wait")).toBeNull();
  });

  it("names the exact reason a pane has no promote grant", async () => {
    configureQueueOperatorGrants(secret);
    const app = Fastify();
    registerQueueOperatorGrantRoute(app, { routeOptions: {}, requireBridge: async (request) => ({ claims: { paneId: String(request.headers["x-pane"]), roomId: "room:main0001" } as never }) });
    const ask = (pane: string, op: string) => app.inject({ method: "POST", url: "/api/cli/queue-operator-grant", headers: { "x-pane": pane }, payload: { op } });
    const refusal = async (pane: string) => {
      const response = await ask(pane, "promote");
      expect(response.statusCode).toBe(403);
      return response.json().error as { message: string; reason: string };
    };
    expect((await refusal("pane:why00001")).reason).toBe("no line you typed or sent into this pane from your own browser asked to promote");
    noteOperatorPaneInput("pane:why00002", "δεν θέλω promote ακόμα\r");
    const negated = await refusal("pane:why00002");
    expect(negated.reason).toMatch(/^your line at \d\d:\d\d UTC had the word "δεν"$/);
    expect(negated.message).toBe(`No operator grant for this pane: ${negated.reason}.`);
    noteOperatorPaneInput("pane:why00003", "promote now\r");
    expect((await ask("pane:why00003", "promote")).statusCode).toBe(200);
    expect((await refusal("pane:why00003")).reason).toMatch(/^your line at \d\d:\d\d UTC was already used by the promote at \d\d:\d\d UTC \(one promote per line\)$/);
    noteOperatorPromoteLine("pane:why00004", "promote now", "pane-prompt", Date.now() - 31 * 60_000);
    expect((await refusal("pane:why00004")).reason).toMatch(/^your line at \d\d:\d\d UTC is older than 30 minutes$/);
    allowPaneQueueCommand("pane:why00005", "space-queue approve q-20261021-074419-7e42", "nous-decision:test");
    expect((await refusal("pane:why00005")).reason).toBe("this pane holds a grant for approve:q-20261021-074419-7e42, not promote");
    await app.close();
  });

});
