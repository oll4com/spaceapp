import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
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

// 28/11, plan clipboard:CTVaL1V3kAFM step 1: the marks lived in the API's memory, so every deploy made the operator's own pane nobody's
// (Nous could close it) and a pane Nous had prompted "never prompted" (the operator's next line made it theirs for good).
describe("prompt marks across an API restart", () => {
  const old = new Date(Date.now() - 3 * 3_600_000).toISOString();
  const pane = (id: string) => ({ id, mode: "TERMINAL", terminalRuntimeId: "cli:claude", createdAt: old }) as never;

  it("keeps who prompted each pane, and when", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prompt-marks-"));
    const file = join(dir, "queue-operator-grants.json");
    const restart = async () => {
      vi.resetModules();
      const grants = await import("../src/queue-operator-grants.js");
      grants.configureQueueOperatorGrants(secret, file);
      return { ...grants, ...await import("../src/space-prompts.js") };
    };
    try {
      const before = await restart();
      before.noteOperatorPaneInput("pane:theirs01", "fix the login\r", 1_000);
      before.noteOperatorPaneInput("pane:theirs02", "fix the logout\r", 1_000);
      before.noteSpacePrompt("pane:theirs02", 2_000);
      before.noteSpacePrompt("pane:nous0001", 3_000);
      const after = await restart();
      expect(after.operatorPaneReason(pane("pane:theirs01"))).toBe("the operator prompted it last");
      expect(after.operatorPaneReason(pane("pane:theirs02"))).toBe("the operator gave it its first prompt");
      expect(after.lastPromptAt("pane:theirs02")).toBe(2_000);
      expect(after.lastPromptAt("pane:nous0001")).toBe(3_000);
      expect(after.lastPromptAt("pane:never001")).toBe(-Infinity);
      // The operator's line into Nous's worker: theirs while it is the newest prompt, never "their first prompt".
      after.noteOperatorPaneInput("pane:nous0001", "and the tests\r", 4_000);
      expect(after.operatorPaneReason(pane("pane:nous0001"))).toBe("the operator prompted it last");
      after.noteSpacePrompt("pane:nous0001", 5_000);
      expect((await restart()).operatorPaneReason(pane("pane:nous0001"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a state file written before the marks, and one with broken marks, as no marks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prompt-marks-"));
    const file = join(dir, "queue-operator-grants.json");
    try {
      for (const marks of [undefined, { space: [["pane:bad00001", "soon"]], operator: "none", first: 7 }]) {
        writeFileSync(file, JSON.stringify({ pending: [], lines: [], marks }));
        vi.resetModules();
        const grants = await import("../src/queue-operator-grants.js");
        grants.configureQueueOperatorGrants(secret, file);
        expect(grants.lastPromptAt("pane:bad00001")).toBe(-Infinity);
        expect(grants.operatorPaneReason(pane("pane:bad00001"))).toBeNull();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
