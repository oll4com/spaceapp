import { describe, expect, it, vi } from "vitest";
import type { Pane, Room } from "@space/contracts";
import { InMemorySpaceStore, SpaceConflictError, SpaceFeatureDisabledError } from "@space/runtime";
import { NEVER_BUY_ANSWER } from "../src/nous/allowances.js";
import { historicalToolHold } from "../src/nous/tool-holds.js";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";
import { createNousWeb } from "../src/nous/web.js";

/** Daily Nous errors 20/11: a call on a target already closed, answered or absent answers that state; it does not count as a failure. */

const owner = "user:operator";
const ctx = { owner, turnId: "nous_turn:t20", callId: "toolu_20", traceId: "trace:20" };
const room = { id: "room:felix001", name: "Felix", kind: "WORKSPACE", ownerUserId: owner, archivedAt: null } as unknown as Room;
const pane = { id: "pane:andy0001", roomId: room.id, paneName: "Andy", title: "Andy", mode: "DESIGN", terminalRuntimeId: "cli:claude", isClosed: false } as unknown as Pane;
const decision = "nous_decision:d8b6dd598bdb44ed81533f2d";

const tools = (overrides: Partial<NousToolDeps> = {}) => createNousTools({
  world: async () => "world", rooms: async () => [room], listPanes: async () => [pane],
  roomTool: vi.fn(async () => ({ ok: true, display: "ran", result: "ran" })),
  inspectPane: async () => ({ text: "", state: "UNKNOWN", sessionId: "session:1", tasks: [] }),
  allowances: async () => ({ promote: false, warm: false }), notifications: { list: async () => [], resolve: async () => true }, paneNotices: {},
  ...overrides
} as unknown as NousToolDeps);

describe("Daily Nous errors 20/11", () => {
  it("settles nothing on an answered decision without failing, and holds an open one", async () => {
    const settle = (status: string) => tools({ settleDecision: async () => ({ id: decision, status }) } as never)
      .execute("space_settle_decision", { decision, state: "VOID", reason: "superseded by the operator's answer" }, ctx);
    expect(await settle("ANSWERED")).toMatchObject({ ok: true, result: `${decision} is already answered: nothing to settle.` });
    expect(await settle("OPEN")).toMatchObject({ ok: false, refused: true });
  });

  it("holds a resume of a campaign that is not paused", async () => {
    const mailCampaigns = { resume: async () => { throw new SpaceConflictError("\"Paid pilot batch 7\" is DONE."); } };
    expect(await tools({ mailCampaigns, coversApproval: async () => true } as never).execute("space_mail_campaign_resume", { campaign: "mcamp:abcdef1" }, ctx))
      .toMatchObject({ ok: false, refused: true, result: "\"Paid pilot batch 7\" is DONE. Nothing resumed." });
  });

  it("holds a copilot state read on a pane with no run", async () => {
    const copilots = { state: async () => { throw new Error("Only copilot panes (Job, Mail, Freelance, Marketing, App Studio) have a run to read here, and Design and Video panes their requests."); } };
    expect(await tools({ copilots } as never).execute("space_copilot_state", { room: "Felix", pane: "Andy" }, ctx)).toMatchObject({ ok: false, refused: true });
  });

  it("answers a net check of a name that does not resolve", async () => {
    const web = createNousWeb({ resolve: async (host) => { throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }); } });
    for (const check of ["http", "tcp", "tls"] as const) {
      expect(await web.check({ check, host: "kuponista.pages.dev" } as never)).toMatch(/^\w+ kuponista\.pages\.dev → the name does not resolve from public-host/);
    }
  });

  it("reads the counted samples as the holds they are now", () => {
    for (const [tool, error] of [
      ["space_settle_decision", `${decision} is answered: nothing to settle.`],
      ["space_mail_campaign_resume", "\"Paid pilot batch 7: 20 dev teams, SE Asia + Cyprus\" is DONE."],
      ["space_copilot_state", "Only copilot panes (Job, Mail, Freelance, Marketing, App Studio) have a run to read here, and Design and Video panes their requests."],
      ["space_git", "git: fatal: bad object 9ba69398dda0d120c161ed3494e871a1af028867"],
      ["space_net_check", "getaddrinfo ENOTFOUND kuponista.pages.dev"]
    ] as const) expect(historicalToolHold(tool, error), `${tool}: ${error}`).toBe(true);
    expect(historicalToolHold("space_mail_campaign_resume", "Cannot read properties of undefined (reading 'status')")).toBe(false);
  });

  // 20/11 (fourth pass): a plan map answer is held live; past remote status lines read as the holds their calls are now.
  it("holds a dependency on a plan that is not open", async () => {
    const plan = { id: "clipboard:abcdefgh", kind: "PLAN", title: "Pilot", text: "", steps: [], parked: null, waitsOn: null, dependsOn: [] };
    const plans = { get: async () => plan, list: async () => [plan], update: async () => { throw new SpaceConflictError("Plan clipboard:vStwchpvnWec is not an open plan."); } };
    expect(await tools({ plans } as never).execute("space_plan_update", { plan: "clipboard:abcdefgh", dependsOn: ["clipboard:vStwchpvnWec"] }, ctx))
      .toMatchObject({ ok: false, refused: true, result: expect.stringContaining("is not an open plan") });
    const broken = { ...plans, update: async () => { throw new Error("connection terminated"); } };
    expect((await tools({ plans: broken } as never).execute("space_plan_update", { plan: "clipboard:abcdefgh", dependsOn: ["clipboard:vStwchpvnWec"] }, ctx)).refused).toBeFalsy();
  });

  it("re-sets a plan's minimum model to its work, on a managed plan too, without touching its progress (token saving 20/11)", async () => {
    const store = new InMemorySpaceStore();
    const saved = await store.upsertClipboardItem({ ownerUserId: owner, source: "PLAN", text: "Sell the car on car.gr", title: "Car sale", minimumModel: "claude-opus-5-5",
      steps: [{ order: 1, title: "Write the listing" }, { order: 2, title: "Answer buyers" }] as never });
    const plans = { get: async (o: string, id: string) => store.getClipboardItem(o, id), list: async () => [], update: async (o: string, id: string, input: never) => store.updateClipboardItemProgress(o, id, input) };
    expect(await tools({ plans } as never).execute("space_plan_update", { plan: saved.id, minimumModel: "claude-sonnet-5-5", minimumReasoning: "high" }, ctx)).toMatchObject({ ok: true });
    expect(store.getClipboardItem(owner, saved.id)).toMatchObject({ minimumModel: "claude-sonnet-5-5", minimumReasoning: "high", progressPercentage: 0, lastProgressAt: saved.lastProgressAt });
    // A later progress update keeps the model it was given.
    store.updateClipboardItemProgress(owner, saved.id, { stepUpdate: { stepIdOrOrder: 1, status: "COMPLETED" } });
    expect(store.getClipboardItem(owner, saved.id)).toMatchObject({ minimumModel: "claude-sonnet-5-5", minimumReasoning: "high" });
  });

  it("reads the remote status line, the plan map and copilot item answers as holds, and the real errors as failures", () => {
    for (const [tool, error] of [
      ["space_remote", "- SpaceApp example.invalid (link:6g5VWWBKAn8JNuMo) at https://example.invalid: may read, act; last answered 2026-11-15T01:24:19.616Z, connected"],
      ["space_plan_update", "Plan clipboard:vStwchpvnWec is not an open plan."],
      ["space_plan_update", "The dependency would loop: clipboard:a -> clipboard:b -> clipboard:a."],
      ["space_ask_operator", "An approved decision cannot decide a design copilot's review: the items it decides are mail review, mail rule."]
    ] as const) expect(historicalToolHold(tool, error), `${tool}: ${error}`).toBe(true);
    for (const [tool, error] of [
      ["space_remote", "That SpaceApp closed the link: it refused a message."],
      ["space_remote", "No address of that SpaceApp answered (https://example.invalid): Unexpected server response: 502."]
      // The 40 s web search wording is held since 22/11 (fixed by d9bc59a333; nous-tool-errors-1122.test.ts).
    ] as const) expect(historicalToolHold(tool, error), `${tool}: ${error}`).toBe(false);
  });

  // 20/11 (fifth pass): the gate's ops.logs failures and the bare no-match, whose wordings no longer occur, are held; today's wordings count.
  it("holds the old ops.logs fallback and the bare no-match, and counts their wordings of today", () => {
    expect(historicalToolHold("space_execute", "FAILED ops.logs: The protected adapter did not complete this control.")).toBe(true);
    expect(historicalToolHold("space_send_to_pane", "No panes match this selection.")).toBe(true);
    for (const [tool, error] of [
      ["space_execute", "FAILED ops.logs: The protected adapter answered FAILED with no reason; its result is in this receipt's evidence."],
      ["space_execute", "FAILED ops.logs: EXECUTION_FAILED: journalctl exited 1."],
      ["space_send_to_pane", "No panes match this selection. Open panes in this room: Bob (pane:bob00001)."]
    ] as const) expect(historicalToolHold(tool, error), `${tool}: ${error}`).toBe(false);
  });

  // 20/11 (sixth pass, 06:54Z): a tab close on a pane Chrome that stopped answering is a target state, held live and in the counted sample.
  it("holds a tab close on an unresponsive pane Chrome, and still counts another browser error", async () => {
    const unresponsive = "This pane's Chrome left a command unanswered and has not answered since, so the action was not run. It is not relaunched automatically (a relaunch could lose a filled form); Space reported it to Nous.";
    const close = (error: Error) => tools({ closeBrowserTab: async () => { throw error; } } as never).execute("space_browser_close_tab", { room: "Felix", pane: "Andy", tabId: "tab:1" }, ctx);
    expect(await close(new SpaceFeatureDisabledError("BROWSER_UNRESPONSIVE", unresponsive))).toMatchObject({ ok: false, refused: true });
    expect((await close(new Error("Target closed unexpectedly"))).refused).toBeFalsy();
    expect(historicalToolHold("space_browser_close_tab", unresponsive)).toBe(true);
    expect(historicalToolHold("space_browser_close_tab", "This pane's Chrome lost its DevTools connection, so the action was not run.")).toBe(true);
    expect(historicalToolHold("space_browser_close_tab", "Target closed unexpectedly")).toBe(false);
  });

  it("reads a restarted CLI again until it is back at its prompt, and names an exited one", async () => {
    const receipt = JSON.stringify({ status: "UNKNOWN", results: [{ index: 0, paneId: pane.id, status: "UNKNOWN", detail: "CLI readiness has not been confirmed." }] });
    const restart = (states: string[]) => {
      const inspectPane = vi.fn(async () => ({ text: "", state: states.length > 1 ? states.shift()! : states[0]!, sessionId: "session:1", tasks: [] }));
      return tools({ roomTool: vi.fn(async () => ({ ok: false, display: "Could not restart Andy", result: receipt })), inspectPane, wait: async () => undefined } as never)
        .execute("space_restart_pane", { room: "Felix", panes: ["Andy"] }, ctx);
    };
    expect(await restart(["UNKNOWN", "UNKNOWN", "IDLE"])).toMatchObject({ ok: true, result: expect.stringMatching(/^Andy: the CLI is back at its prompt after the restart\./) });
    const exited = await restart(["EXITED"]);
    expect(exited).toMatchObject({ ok: false, result: expect.stringMatching(/^UNKNOWN Andy: CLI readiness has not been confirmed\. Read again for up to 30 s: state EXITED\.\n/) });
    // The live answer is not the counted 19/11 sample, so it still counts.
    expect(historicalToolHold("space_restart_pane", exited.result)).toBe(false);
  });

  it("holds the second pass of counted samples whose cause the live tools answer now", () => {
    for (const [tool, error] of [
      ["space_net_check", "getHostByAddr ENOTFOUND 186.247.190.77"],
      ["space_net_check", "Too many redirects."],
      ["space_web_read", "Too many redirects."],
      ["space_send_to_pane", "Not sent: the send: No panes match this selection. (read the pane (space_read_pane) before sending again)."],
      ["space_send_to_pane", "Dana is closed and did not reopen ({\"dotId\":\"dot:fb378243c320313db0ffaf09c8d77e02\",\"id\":\"daedc66248ab"],
      ["space_execute", "FAILED panes.open: Room capacity exceeded: room currently has 16 open panes, maximum capacity is 16 panes. No free slots for 1 requested panes."],
      ["space_execute", "FAILED native_command pane:LOvgZAn1duk9: Native state is unknown."],
      ["space_ask_operator", "\"revise\" is not a decision a mail copilot's review takes: use approve, edit, reject. Waiting in the mail copilot now: REVIEW mailrev:h0kJfzuEGeZu"],
      ["space_restart_pane", "UNKNOWN Andy: CLI readiness has not been confirmed."],
      ["space_restart_pane", "UNKNOWN Andy: CLI readiness has not been confirmed.\nRead the pane (space_read_pane): if its CLI is back at a prompt, the restart took"]
    ] as const) expect(historicalToolHold(tool, error), `${tool}: ${error}`).toBe(true);
    // Today's wordings of real failures keep counting.
    for (const [tool, error] of [
      ["space_send_to_pane", "Not sent: the send: No panes match this selection. Open panes in this room: Bob (pane:bob00001). (read the pane (space_read_pane) before sending again)."],
      ["space_web_read", "GET https://a.example → redirect loop, https://a.example → https://b.example → https://a.example"],
      ["space_restart_pane", "FAILED Andy: CLI host session cli_session:x is EXITED."]
    ] as const) expect(historicalToolHold(tool, error), `${tool}: ${error}`).toBe(false);
  });

  it("holds a purchase ask while \"Never buy\" is on, before any decision exists, with or without an action (Daily Nous errors 23/11)", async () => {
    // 20/11 07:23Z 70aca5ae (car.gr promotion, no action) then 07:26Z b07adee5 with a PANE_TEXT action: both created, then declined by Never buy (−5 each).
    const ask = vi.fn(async (input: { title: string }) => ({ id: "nous_decision:new00007", status: "OPEN", title: input.title }));
    let neverBuy = true;
    const tools = createNousTools({ ask, decisions: async () => [], rooms: async () => [room], listPanes: async () => [pane],
      allowances: async () => ({ promote: false, warm: false, neverBuy }) } as unknown as NousToolDeps);
    const question = (title: string, extra: Record<string, unknown> = {}) => tools.execute("space_ask_operator", { category: "EXTERNAL", title, body: "Kate pays on car.gr.",
      recommendation: "Ναι. Πρόβλεψη: ναι (70%)", checked: ["car.gr: the promotion page"], refs: { planId: "clipboard:PW27POretOHM", site: "car.gr" }, ...extra }, ctx);
    const held = { ok: false, refused: true, display: 'Not asked: "Never buy" is on', result: expect.stringContaining(NEVER_BUY_ANSWER) };
    expect(await question("car.gr: ποια επιλογή προώθησης να αγοράσουμε; 4,99 €")).toMatchObject(held);
    expect(await question("car.gr: αγορά One-click προώθησης 4,99 €", { action: { type: "PANE_TEXT", roomId: room.id, paneId: pane.id, text: "pay the One-click", mode: "PROMPT" } })).toMatchObject(held);
    // Not a purchase, or the operator turned the rule off: asked.
    expect((await question("car.gr: ποια φωτογραφία να μπει πρώτη;")).ok).toBe(true);
    neverBuy = false;
    expect((await question("car.gr: αγορά One-click προώθησης 4,99 €")).ok).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
  });

});
