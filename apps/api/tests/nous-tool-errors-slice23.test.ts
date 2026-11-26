import { describe, expect, it } from "vitest";
import { historicalToolHold } from "../src/nous/tool-holds.js";
import { createNousTools } from "../src/nous/tools.js";

/** Daily Nous errors 15/11 slice 23: the recorded samples whose cause today's code answers as done or as guidance. */

describe("Daily Nous errors 15/11 slice 23", () => {
  it("a helper's link file move is a hold that says Nous's own turn makes it", async () => {
    const tools = createNousTools({ instanceLinks: () => ({}), files: {} } as never);
    const helper = { owner: "user:operator", turnId: "nous_turn:t23", callId: "toolu_23", traceId: "trace:23", turn: { reason: "HELPER" } } as never;
    expect(await tools.execute("space_remote_file", { instance: "spaceapp-hz", direction: "pull", path: "notes.md" }, helper))
      .toMatchObject({ ok: false, refused: true, result: expect.stringContaining("Nous's own turn calls space_remote_file") });
  });

  it("reads the recorded samples alike: stop pending, an ended host session, a pane with no room, a helper's link file", () => {
    expect(historicalToolHold("space_execute", "NOT CONFIRMED stop pane:TCq-x9fuWXKf: Native stop is not yet confirmed; process is still yielding. "
      + "(it may have run: read the pane with space_read_pane before repeating it)")).toBe(true);
    // A batch whose sample goes on may hide another action's failure: it still counts.
    expect(historicalToolHold("space_execute", "NOT CONFIRMED stop pane:TCq-x9fuWXKf: Native stop is not yet confirmed; process is still yielding. "
      + "(it may have run: read the pane with space_read_pane before repeating it)\nFAILED send pane:x")).toBe(false);
    expect(historicalToolHold("space_stop_pane", "CLI host session cli_session:Gv9VIYcUqRt4 is EXITED.")).toBe(true);
    expect(historicalToolHold("space_notify_operator", "A pane is found in its room: give `room` with `pane`.")).toBe(true);
    expect(historicalToolHold("space_remote_file", "Files with a linked SpaceApp are unavailable to this turn")).toBe(true);
    expect(historicalToolHold("space_remote", "POST /api/version-sync answered 400 INVALID_INPUT: The body takes commit: a full 40-character commit id.")).toBe(true);
    expect(historicalToolHold("space_execute", "FAILED files.preview: Invalid input: expected string")).toBe(true);
    expect(historicalToolHold("space_remote", "That SpaceApp closed the link: it refused a message.")).toBe(false);
  });
});
