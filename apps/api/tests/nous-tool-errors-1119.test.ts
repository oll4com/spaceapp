import { describe, expect, it, vi } from "vitest";
import type { Pane, Room } from "@space/contracts";
import { createCopilotControl } from "../src/nous/copilot-control.js";
import { historicalToolHold } from "../src/nous/tool-holds.js";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";

/** Daily Nous errors 18/11 (brief 20261119-score-errors-delta): each call works, or refuses with the next step before it counts. */

const owner = "user:operator";
const ctx = { owner, turnId: "nous_turn:t19", callId: "toolu_19", traceId: "trace:19" };
const room = { id: "room:felix001", name: "Felix", kind: "WORKSPACE", ownerUserId: owner, archivedAt: null } as unknown as Room;
const pane = (mode: string) => ({ id: "pane:andy0001", roomId: room.id, paneName: "Andy", title: "Andy", mode, terminalRuntimeId: "cli:claude", isClosed: false } as unknown as Pane);

const tools = (overrides: Partial<NousToolDeps> = {}, rooms: Room[] = [room], mode = "BROWSER") => createNousTools({
  world: async () => "world", rooms: async () => rooms, listPanes: async () => [pane(mode)],
  roomTool: vi.fn(async () => ({ ok: true, display: "ran", result: "ran" })),
  inspectPane: async () => ({ text: "", state: "UNKNOWN", sessionId: "session:1", tasks: [] }),
  allowances: async () => ({ promote: false, warm: false }), notifications: { list: async () => [], resolve: async () => true }, paneNotices: {},
  ...overrides
} as unknown as NousToolDeps);

describe("Daily Nous errors 18/11", () => {
  it("creates the operator's first room through the store, and holds when it cannot", async () => {
    const createRoom = vi.fn(async () => ({}));
    expect(await tools({ createRoom }, []).execute("space_create_room", { name: "Main" }, ctx)).toMatchObject({ ok: true, display: "Created the room Main" });
    expect(createRoom).toHaveBeenCalledWith(owner, "Main", "trace:19");
    expect(await tools({}, []).execute("space_create_room", { name: "Main" }, ctx)).toMatchObject({ ok: false, refused: true });
  });

  it("holds a browser route another pane's account holds, and a tab the Browser Host will not reopen", async () => {
    for (const message of ["BROWSER_ROUTE: another pane uses this browser account on another network route; …", "Browser navigation target must use http or https."]) {
      const setBrowserRoute = vi.fn(async () => { throw new Error(message); });
      expect(await tools({ setBrowserRoute } as never).execute("space_browser_set_route", { room: "Felix", pane: "Andy", route: "direct" }, ctx), message)
        .toMatchObject({ ok: false, refused: true });
    }
  });

  it("refuses a Design or Video run before the call (HTTP 404), and holds it", async () => {
    const invoke = vi.fn(async () => ({}));
    const control = createCopilotControl({ invoke, store: { getActivePaneCliSession: async () => null, listPaneCliSessions: async () => [] } as never });
    await expect(control(owner, pane("DESIGN"), "run_start")).rejects.toThrow("works on requests, not runs: ask it with space_design_request");
    expect(invoke).not.toHaveBeenCalled();
    expect(await tools({ copilots: { control } } as never, [room], "DESIGN").execute("space_copilot_control", { room: "Felix", pane: "Andy", action: "run_start" }, ctx))
      .toMatchObject({ ok: false, refused: true });
  });

  it("holds a campaign whose deliverability checks failed", async () => {
    const mailCampaigns = { submit: async () => { throw new Error("Fix the failed checks first: DNSBL."); } };
    expect(await tools({ mailCampaigns } as never).execute("space_mail_campaign_submit", { campaign: "campaign:1" }, ctx)).toMatchObject({ ok: false, refused: true });
  });

  it("reads the day's counted samples as the holds they are now", () => {
    for (const [tool, error] of [
      ["space_execute", "FAILED configure pane:x1: Antigravity account profile \"space-gateway\" is not found.\n{"],
      ["space_execute", "FAILED configure pane:rQhyjbLbLzcM: \"gemini-4-neon\" is not available in the CLI's current model menu: this CLI offers gemini-3.8-flash (low/medium/high), claude-sonnet-4-6 (high), claude-opus-4-6 (hi…"],
      ["space_execute", "FAILED files.preview: [\n  {\n    \"expected\": \"string\","],
      ["space_execute", "FAILED capture: Another Space screenshot is being captured; try again shortly."],
      ["space_execute", "FAILED status: Schedule belongs to another room."],
      ["space_files_write", "EACCES: permission denied, open '/proc/self/fd/71/20261118-score.md'"],
      ["space_create_room", "The operator has no room yet."],
      ["space_browser_set_route", "Browser navigation target must use http or https."],
      ["space_browser_set_route", "BROWSER_ROUTE: another pane uses this browser account on another network route; …"],
      ["space_web_read", "https://nginx.org/packages/Packages is application/octet-stream, not a text page."],
      ["space_net_check", "PTR takes a public IP address."],
      ["space_copilot_control", "Protected control failed (HTTP 404)."],
      ["space_set_pane_model", "FAILED pane:nmJsQWoYY0I7: The CLI rejected the model selection. Check its model menu."],
      ["space_mail_campaign_submit", "Fix the failed checks first: DNSBL."],
      ["space_copilot_answer", "This design request has no open question."]
    ] as const) expect(historicalToolHold(tool, error), `${tool}: ${error}`).toBe(true);
    expect(historicalToolHold("space_files_write", "ENOSPC: no space left on device")).toBe(false);
    expect(historicalToolHold("space_copilot_control", "Protected control failed (HTTP 500).")).toBe(false);
  });
});
