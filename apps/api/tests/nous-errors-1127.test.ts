import { describe, expect, it, vi } from "vitest";
import { SpaceConflictError } from "@space/runtime";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";
import { historicalToolHold } from "../src/nous/tool-holds.js";

// Daily Nous errors 27/11: the 7 days' tool failures whose causes are fixed or whose answers name the next call stop counting.
describe("Daily Nous errors 27/11: fixed or guiding tool answers", () => {
  it("holds the recorded samples of fixed causes and keeps real failures counted", () => {
    for (const [name, error] of [
      ["space_release", "spaceapp-desktop 0.1.29 is open (captain Dana): join it instead of cutting your own version."],
      ["space_answer_pane", "Iris is a browser pane without a CLI: there is no prompt to answer. See its page with space_look and its tabs with space_browser_tabs; what only the operator can do there goes to them with space_focus_pane."],
      ["space_remote", "A linked SpaceApp answers only GET /api/auth/me, GET /api/rooms, GET /api/control/v1/capabilities."],
      ["space_mail_read", "No message 1a20c6dc7296807c in thread 19dcd4c2d578de64. Its messages: 19dcd4c2d578de64, 1a15e18a5f3a3b35"],
      ["space_files_read", "Give a path or an artifactId (Ignored artifact: not arguments of this tool, which takes {path?: string, artifactId?: string, offset?: integer}.)"]
    ] as const) expect(historicalToolHold(name, error), name).toBe(true);
    for (const [name, error] of [
      ["space_release", "The release train changed meanwhile. Read it again."],
      ["space_remote", "GET /api/rooms answered 500 in 3 ms."],
      ["space_mail_read", "Gmail answered 500."],
      ["space_files_read", "Give a path or an artifactId"]
    ] as const) expect(historicalToolHold(name, error), name).toBe(false);
  });

  it("space_release answers a release train conflict as a refusal; other errors still fail", async () => {
    const releaseTrain = vi.fn(async () => { throw new SpaceConflictError("spaceapp-desktop 0.1.29 is open (captain Dana): join it instead of cutting your own version."); });
    const ctx = { owner: "user:operator", turnId: "nous_turn:e1127", callId: "toolu_1", traceId: "trace:1" };
    expect(await createNousTools({ releaseTrain } as unknown as NousToolDeps).execute("space_release", { op: "status" }, ctx))
      .toMatchObject({ ok: false, refused: true, result: expect.stringContaining("join it instead") });
    const broken = vi.fn(async () => { throw new Error("database down"); });
    const outcome = await createNousTools({ releaseTrain: broken } as unknown as NousToolDeps).execute("space_release", { op: "status" }, ctx);
    expect(outcome.ok).toBe(false);
    expect(outcome.refused).toBeFalsy();
  });
});
