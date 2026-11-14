import { describe, expect, it, vi } from "vitest";
import type { ClipboardItem, Pane, Room } from "@space/contracts";
import { createNousTools, ignoredArgsNote, type NousToolDeps } from "../src/nous/tools.js";
import { NOUS_DB_COLUMN_SYNONYMS } from "../src/nous/db.js";
import { createNousPaneWatch } from "../src/nous/pane-watch.js";
import { nousNetCheckArgsSchema } from "../src/nous/web.js";
import { z } from "zod";

/** Daily Nous errors 13/11 (plan 1NF6u6gcCwtj): the residual tool failures after slices 4-7, fixed in the shared dispatcher. */

const owner = "user:operator";
const room = (id: string, name: string): Room => ({ id, name, kind: "WORKSPACE", ownerUserId: owner, archivedAt: null } as unknown as Room);
const pane = (id: string, paneName: string, roomId: string, isClosed = false): Pane =>
  ({ id, roomId, paneName, title: paneName, mode: "TERMINAL", terminalRuntimeId: "cli:claude", isClosed } as unknown as Pane);
const ctx = { owner, turnId: "nous_turn:t1", callId: "toolu_1", traceId: "trace:1" };
const plan = { id: "clipboard:mmeF0-e3x4Gq", source: "PLAN", title: "Light CLI panes", executionStatus: "IN_PROGRESS", progressPercentage: 40, steps: [] } as unknown as ClipboardItem;

function tools(overrides: Partial<NousToolDeps> = {}) {
  const deps: NousToolDeps = {
    world: async () => "world",
    rooms: async () => [room("room:felix001", "Felix"), room("room:dino0001", "Dino")],
    listPanes: async (roomId: string) => roomId === "room:felix001" ? [pane("pane:andy0001", "Andy", roomId), pane("pane:2f6a5unH-TBn", "Iris", roomId, true)] : [],
    inspectPane: async () => ({ text: "", state: "UNKNOWN", sessionId: "session:1", tasks: [] } as never),
    roomTool: vi.fn(async (name: string) => ({ ok: true, display: `ran ${name}`, result: `ran ${name}` })),
    plans: { list: async () => [plan], get: async (_owner, id) => id === plan.id ? plan : null, update: vi.fn() as never },
    tasks: { list: async () => [], add: vi.fn() as never, update: vi.fn() as never, rebind: vi.fn() as never },
    clipboard: { list: async () => [], save: vi.fn() as never, complete: vi.fn() as never, remove: vi.fn(async () => {}) },
    memory: null,
    notifications: { list: async () => [], resolve: async () => true },
    releaseTrain: vi.fn(async () => ""),
    setNote: vi.fn(async () => {}),
    ask: vi.fn() as never,
    withdraw: vi.fn(async () => false),
    allowances: async () => ({ promote: false, warm: false }),
    answerPrompt: vi.fn(async () => ({})),
    paneNotices: {} as never,
    ...overrides
  };
  return createNousTools(deps);
}

describe("Daily Nous errors 13/11: residual tool failures", () => {
  it("reads a plan named without its clipboard: prefix (task ids lost task: the same way)", async () => {
    const f = tools();
    expect(await f.execute("space_plan_read", { plan: "mmeF0-e3x4Gq" }, ctx)).toMatchObject({ ok: true, result: expect.stringMatching(/^\[clipboard:mmeF0-e3x4Gq\]/) });
    // An id that fits no plan still fails and names how to find it.
    expect(await f.execute("space_plan_read", { plan: "zzzzzzzzzzzz" }, ctx)).toMatchObject({ ok: false, display: "No such plan" });
  });

  it("names the arguments zod dropped when the call then fails (12:54 space_plan_update \"Nothing to update\")", async () => {
    const failed = await tools().execute("space_plan_update", { plan: plan.id, notes: "step 3 done", percent: 60 } as never, ctx);
    expect(failed).toMatchObject({ ok: false, display: "Nothing to update", result: expect.stringContaining("(Ignored notes, percent: not arguments of this tool, which takes {plan: string, ") });
    expect(failed.result).toContain("progressPercentage?: ");
    expect(ignoredArgsNote(z.object({ a: z.string() }), { a: "x" })).toBe("");
  });

  it("says that no room holds a pane id instead of \"No open pane named\" (11:42 space_notify_operator ×2)", async () => {
    const f = tools();
    const item = { text: "Approve the sign-in" };
    const closed = await f.execute("space_notify_operator", { room: "Felix", pane: "pane:2f6a5unH-TBn", title: "Sign-in", items: [item], checked: ["Vault: no login for this site"] } as never, ctx);
    // A closed one is held before the handler (R36-a), naming its id and how to reopen it.
    expect(closed).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("Iris in Felix is closed; reopen it (pane:2f6a5unH-TBn)") });
    const gone = await f.execute("space_notify_operator", { room: "Felix", pane: "pane:FxzPstGYGx5d", title: "Sign-in", items: [item], checked: ["Vault: no login for this site"] } as never, ctx);
    expect(gone).toMatchObject({ ok: false, result: expect.stringContaining("No room of yours holds a pane pane:FxzPstGYGx5d, open or closed") });
  });

  it("holds a send telling a pane to give the operator focus at a time (correction 180: «γύρω στις 13:00, μετά τις συνεντεύξεις»)", async () => {
    const roomTool = vi.fn(async (name: string) => ({ ok: true, display: `ran ${name}`, result: `ran ${name}` }));
    const f = tools({ roomTool });
    const held = await f.execute("space_send_to_pane", { room: "Felix", panes: ["Andy"], text: "Keep the Cartesia checkout open. Around 13:00, after the interviews, give the operator focus on the card field." }, ctx);
    expect(held).toMatchObject({ ok: false, refused: true, display: expect.stringContaining("focus set for a time"), result: expect.stringContaining("nous_msg:83c0acb8") });
    expect(roomTool).not.toHaveBeenCalled();
    // Focus raised when the step is ready goes through.
    expect(await f.execute("space_send_to_pane", { room: "Felix", panes: ["Andy"], text: "Bring the checkout to the card form and raise focus then." }, ctx)).toMatchObject({ ok: true });
  });

  it("corrects a guessed subject column (10:21 42703 subject)", () => {
    expect(NOUS_DB_COLUMN_SYNONYMS.subject).toEqual(expect.arrayContaining(["title"]));
  });

  it("holds a card asking the operator to put a key into the Vault when a Vault key has its tail (13/11 13:24 Stripe ...mFuf)", async () => {
    const call = vi.fn(async ({ path, body }: { path: string; body: { q?: string } }) => path === "key-list"
      ? { status: "LISTED", auditId: null, keys: body.q === "mFuf" ? [{ id: "vault_key:LFoT7bmzb7sx9ptuvffoPQ", label: "Stripe sk_live example.invalid 1006 mFuf 13/11", savedBy: "pane:sW4WhTxOJJwG" }] : [] }
      : { status: "LISTED", auditId: null, items: [] });
    const f = tools({ vault: { agent: { call } } as never });
    const card = (checked: string[]) => ({ room: "Felix", pane: "Andy", title: "New Stripe key in the Vault by 20:49",
      items: [{ text: "Copy the new Stripe key ...mFuf (copy icon on the page) into Vault > Passwords & keys, label «Stripe sk_live 1006 mFuf»." }], checked });
    const held = await f.execute("space_notify_operator", card(["Bob: the old Vault copy gets 401"]) as never, ctx);
    expect(held).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("the Vault already holds the key ending mFuf: «Stripe sk_live example.invalid 1006 mFuf 13/11» (vault_key:LFoT7bmzb7sx9ptuvffoPQ, saved by pane:sW4WhTxOJJwG)") });
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ path: "key-list", body: { q: "mFuf" } }));
    // Naming the key's id in `checked` (looked at, and why it does not do) passes; a key no Vault label carries is never held.
    const named = await f.execute("space_notify_operator", card(["vault_key:LFoT7bmzb7sx9ptuvffoPQ gets 401 at Stripe"]) as never, ctx);
    expect(named.result ?? "").not.toContain("the Vault already holds");
    const other = await tools({ vault: { agent: { call } } as never }).execute("space_notify_operator",
      { ...card(["Bob: no key yet"]), items: [{ text: "Copy the new Stripe key ...z2k0 into the Vault." }] } as never, ctx);
    expect(other.result ?? "").not.toContain("the Vault already holds");
  });
});

describe("Daily Nous errors 13/11 evening: failures after the 17:30/17:47 promotes", () => {
  it("takes a plan date without an offset as UTC (17:37 space_plan_update ×2 \"dueAt: Invalid ISO datetime\")", async () => {
    const update = vi.fn(async () => plan);
    const f = tools({ plans: { list: async () => [plan], get: async () => plan, update } as never });
    expect((await f.execute("space_plan_update", { plan: plan.id, dueAt: "2026-11-20" }, ctx)).ok).toBe(true);
    expect(JSON.stringify(update.mock.calls[0])).toContain("2026-11-20T00:00:00.000Z");
    // Text that is no ISO date still fails: "Nov 20" would parse as 2001.
    expect((await f.execute("space_plan_update", { plan: plan.id, dueAt: "Nov 20" }, ctx)).ok).toBe(false);
  });

  it("checks http when space_net_check names no check (17:48, asked again with http at once)", () => {
    expect(nousNetCheckArgsSchema.parse({ host: "example.invalid" }).check).toBe("http");
  });

  it("leaves a record id out of refs.files and says so; a Mail review's id stays for its draft (17:26 refs.files [\"mailrev:li-3ZsjmTXFb\"], 14/11)", async () => {
    const ask = vi.fn(async (input: { title: string }) => ({ id: "nous_decision:new00001", status: "OPEN", title: input.title }));
    const decisionFiles = vi.fn(async (_owner: string, refs: string[]) => refs.map((ref) => ({ ref, text: "To: maria@example.com\n\nHello Maria", total: 30, truncated: false })));
    const f = tools({ ask: ask as never, decisions: async () => [], files: { decisionFiles, fileHashes: async () => [] } as never });
    const asked = await f.execute("space_ask_operator", { category: "EXTERNAL", title: "Send the reply to Maria", body: "The reply waits in Mail.", recommendation: "Yes. Πρόβλεψη: ναι (80%)",
      refs: { files: ["mailrev:li-3ZsjmTXFb", "nous_decision:old00001"] }, checked: ["Mail Copilot: the review is open"] } as never, ctx);
    expect(asked).toMatchObject({ ok: true, result: expect.stringContaining("nous_decision:old00001: the id of a Space record, not files, so left out of refs.files.") });
    expect(decisionFiles).toHaveBeenCalledWith(owner, ["mailrev:li-3ZsjmTXFb"]);
  });

  it("holds a close the scheduled-post guard refuses (17:31 Cody's Marketing Copilot, a dev.to post due 19/11)", async () => {
    const roomTool = vi.fn(async () => ({ ok: false, display: "Close refused", result: "Pane Andy stays open: its Marketing Copilot has 1 approved post(s) scheduled, the next 2026-11-19 09:00 UTC. It closes once nothing is scheduled; only the operator can force-close it." }));
    const closed = await tools({ roomTool }).execute("space_close_pane", { room: "Felix", panes: ["Andy"] }, ctx);
    expect(closed).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("do not close it again before then") });
  });
});

describe("Daily Nous errors 13/11 night: the next 48 h of failed calls", () => {
  it("holds a pane name not open in the room, naming the open panes (pane_checked ×11, read_pane ×8, look ×1)", async () => {
    const read = await tools().execute("space_read_pane", { room: "Felix", pane: "Zoe" }, ctx);
    expect(read).toMatchObject({ ok: false, refused: true, result: expect.stringMatching(/^No open pane named "Zoe" in Felix\..* Open panes: Andy\./) });
  });

  it("records WAITING_DATE without nextCheckInMinutes 60 minutes ahead and says so (19:00 ×2; 14/11 review)", async () => {
    const record = vi.fn(async () => {});
    const watch = createNousPaneWatch({ repository: { list: async () => [], record } as never, now: () => Date.parse("2026-11-13T19:00:00Z") });
    const at = pane("pane:andy0001", "Andy", "room:felix001");
    expect(await watch.checked(owner, room("room:felix001", "Felix"), at, { verdict: "WAITING_DATE" } as never))
      .toMatchObject({ ok: true, result: expect.stringMatching(/^Recorded; next check 2026-11-13T20:00:00\.000Z \(no nextCheckInMinutes: WAITING_DATE looks again in 60 minutes/) });
    expect(record).toHaveBeenCalledWith(owner, expect.objectContaining({ verdict: expect.objectContaining({ verdict: "WAITING_DATE", nextCheckAt: "2026-11-13T20:00:00.000Z" }) }));
  });

  it("holds an artifact id no room holds, naming the newest (12/11 06:57 space_files_read ×2)", async () => {
    const files = { read: async () => { throw new Error("No Agent Files or Media artifact artifact:w3-OjyVGyJsB in your rooms. Newest: artifact:shurC0RqkGi9 (clipboard-image-1.png)."); } };
    const read = await tools({ files: files as never }).execute("space_files_read", { artifactId: "artifact:w3-OjyVGyJsB" }, ctx);
    expect(read).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("Newest: artifact:shurC0RqkGi9") });
  });

  it("holds an answer to a pane whose CLI exited (18:39 Dana, state EXITED)", async () => {
    const roomTool = vi.fn(async () => ({ ok: false, display: "Andy is not waiting for an answer", result: "Andy is not waiting for an answer (state EXITED). Read the pane again." }));
    const answered = await tools({ roomTool }).execute("space_answer_pane", { room: "Felix", pane: "Andy", answer: "1" }, ctx);
    expect(answered).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("(state EXITED)") });
  });
});

describe("Daily Nous errors 13/11 late: an answer that did nothing and names what is open", () => {
  it("takes an answer to a copilot that asks nothing now as a no-op (space_copilot_answer ×10; 14/11: nothing open, already handled)", async () => {
    const copilots = { items: async () => [], answerQuestion: async () => { throw new Error("The question was not found."); } };
    const answered = await tools({ copilots: copilots as never, notifications: { list: async () => [], resolve: async () => true, closedQuestions: async () => [] } as never })
      .execute("space_copilot_answer", { copilot: "FREELANCE", question: "Fares Upwork reply not sent", answer: "Send it" }, ctx);
    expect(answered).toMatchObject({ ok: true, result: expect.stringMatching(/^Nothing open, already handled: the FREELANCE copilot asks nothing now.*space_copilot_brief\.$/) });
  });
});

describe("Daily Nous errors 14/11: the tool round after the 13/11 promotes", () => {
  const gus = pane("pane:GLslBwgz8h0W", "Gus", "room:dino0001");
  const listPanes = async (roomId: string) => roomId === "room:felix001" ? [pane("pane:andy0001", "Andy", roomId)] : [gus];

  it("reads a pane id written without pane: in the room that holds it (pane_reports {pane: \"GLslBwgz8h0W\"})", async () => {
    const roomTool = vi.fn(async (name: string) => ({ ok: true, display: `ran ${name}`, result: `ran ${name}` }));
    expect((await tools({ listPanes, roomTool }).execute("space_read_pane", { room: "Felix", pane: "GLslBwgz8h0W" }, ctx)).ok).toBe(true);
    expect(roomTool).toHaveBeenCalledWith("read_pane", expect.objectContaining({ pane: gus.id }), expect.objectContaining({ roomId: "room:dino0001" }));
  });

  it("reads a pane whose room and pane were swapped (pane_reports {pane: \"Felix\", room: \"Bob\"}); neither a room still refuses", async () => {
    const roomTool = vi.fn(async (name: string) => ({ ok: true, display: `ran ${name}`, result: `ran ${name}` }));
    expect((await tools({ listPanes, roomTool }).execute("space_read_pane", { room: "Andy", pane: "Felix" }, ctx)).ok).toBe(true);
    expect(roomTool).toHaveBeenCalledWith("read_pane", expect.objectContaining({ pane: "pane:andy0001" }), expect.objectContaining({ roomId: "room:felix001" }));
    expect(await tools({ listPanes }).execute("space_read_pane", { room: "Zed", pane: "Quinn" }, ctx)).toMatchObject({ ok: false });
  });

  it("lets a card follow a pane name to the one room it is open in (notify_operator ×2 \"No open pane named\")", async () => {
    const notify = vi.fn(async () => ({ ok: true, display: "Card", result: "carded" }));
    const carded = await tools({ listPanes, paneNotices: { notify } as never }).execute("space_notify_operator",
      { room: "Felix", pane: "Gus", title: "Sign-in", items: [{ text: "Approve the sign-in" }], checked: ["Vault: no login for this site"] } as never, ctx);
    expect(carded.ok).toBe(true);
    expect(notify).toHaveBeenCalledWith(owner, expect.objectContaining({ id: "room:dino0001" }), expect.objectContaining({ id: gus.id }), expect.anything());
  });

  it("shows a browser pane's last stored image with its age while its live browser is down (look ×9)", async () => {
    const at = new Date(Date.now() - 30 * 60_000).toISOString();
    const image = vi.fn(async () => ({ label: "shot.png", mimeType: "image/png", bytes: Buffer.from("png") }));
    const looked = await tools({ listPanes: async (roomId: string) => [{ ...pane("pane:emma0001", "Emma", roomId), mode: "BROWSER" } as Pane],
      browser: { getActive: async () => null, action: vi.fn() as never }, vaultProtection: {} as never, files: { image } as never,
      lastScreenshot: async () => ({ id: "artifact:shot0001", createdAt: at }) }).execute("space_look", { room: "Felix", pane: "Emma" }, ctx);
    expect(looked).toMatchObject({ ok: true, images: [{ mimeType: "image/png" }], result: expect.stringContaining("its last stored page image, 30 minutes old") });
    expect(image).toHaveBeenCalledWith(owner, "artifact:shot0001", expect.any(Number));
  });

  it("restarts an idle Codex that lost live model control and holds the model for its first empty prompt (set_pane_model ×3)", async () => {
    const roomTool = vi.fn(async (name: string) => name === "set_pane_model"
      ? { ok: false, display: "Model not set", result: "Live Codex model control is unavailable for this pane." } : { ok: true, display: `ran ${name}`, result: `ran ${name}` });
    const hold = vi.fn(async () => ({}));
    const codex = { ...pane("pane:andy0001", "Andy", "room:felix001"), terminalRuntimeId: "cli:codex", createdAt: "2026-11-13T08:00:00.000Z" } as Pane;
    const f = (state: string) => tools({ roomTool, listPanes: async () => [codex], held: { level: async () => "CALM", hold } as never,
      inspectPane: async () => ({ text: "", state, sessionId: "session:1", tasks: [] } as never) });
    expect(await f("IDLE").execute("space_set_pane_model", { room: "Felix", pane: "Andy", modelId: "gpt-6.1-sol" }, ctx)).toMatchObject({ ok: true, display: "Restarted Andy for its model" });
    expect(roomTool).toHaveBeenCalledWith("restart_pane", { panes: [codex.id] }, expect.anything());
    expect(hold).toHaveBeenCalledWith(owner, expect.objectContaining({ paneId: codex.id }), "Set the model gpt-6.1-sol", "light", { modelId: "gpt-6.1-sol" });
    // An open question is never restarted under.
    roomTool.mockClear();
    expect((await f("WAITING_FOR_INPUT").execute("space_set_pane_model", { room: "Felix", pane: "Andy", modelId: "gpt-6.1-sol" }, ctx)).ok).toBe(false);
    expect(roomTool).not.toHaveBeenCalledWith("restart_pane", expect.anything(), expect.anything());
  });
  it("says a task_update id is a plan (task_update ×5 \"is no task id\")", async () => {
    const update = vi.fn(async () => { throw new Error("Task item task:mmeF0-e3x4Gq was not found."); });
    const changed = await tools({ tasks: { list: async () => [], add: vi.fn() as never, update, rebind: vi.fn() as never } }).execute("space_task_update", { task: "mmeF0-e3x4Gq", status: "DONE" }, ctx);
    expect(changed).toMatchObject({ ok: false, result: expect.stringContaining("It is the plan clipboard:mmeF0-e3x4Gq (\"Light CLI panes\"): change it with space_plan_update.") });
  });

  it("retries a database read once on a dropped connection (db_query ×3 \"Connection terminated unexpectedly\")", async () => {
    const query = vi.fn().mockRejectedValueOnce(new Error("Connection terminated unexpectedly")).mockResolvedValueOnce("1 row");
    expect(await tools({ db: { query } as never }).execute("space_db_query", { sql: "SELECT 1" }, ctx)).toMatchObject({ ok: true, result: "1 row" });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("asks without a replaces that names no open decision, and says so", async () => {
    const ask = vi.fn(async (input: { title: string }) => ({ id: "nous_decision:new00002", status: "OPEN", title: input.title }));
    const asked = await tools({ ask: ask as never, decisions: async () => [] }).execute("space_ask_operator", { category: "EXTERNAL", title: "Renew the domain",
      body: "It expires on 20/11.", recommendation: "Yes. Πρόβλεψη: ναι (80%)", replaces: "nous_decision:gone0001", checked: ["Registrar: renewal open"] } as never, ctx);
    expect(asked).toMatchObject({ ok: true, result: expect.stringContaining("replaces named nous_decision:gone0001, which is no open decision of yours: nothing replaced") });
    expect(JSON.stringify(ask.mock.calls[0])).not.toContain("gone0001");
  });

  // Daily Nous errors 14/11 slice 2: caller mistakes whose answer names the next call are refusals, not counted failures.
  it("refuses invalid arguments with the field, its rule and the next step (net_check check \"ssl\", open_requests, settle_decision reason ×9 tools)", async () => {
    const web = { check: vi.fn() };
    const checked = await tools({ web: web as never }).execute("space_net_check", { check: "ssl", host: "example.com" }, ctx);
    expect(checked).toMatchObject({ ok: false, refused: true, result: expect.stringMatching(/^Invalid arguments: check: .*"tls".* Nothing done: call it again with that fixed\.$/) });
    expect(web.check).not.toHaveBeenCalled();
  });

  it("refuses a git path that is no repository with the repositories it reads (git ×2)", async () => {
    const git = { run: vi.fn(async () => { throw new Error('Repositories: stable, dev or a Space worktree under /opt/spaceapp/var/worktrees/space (wt-...).'); }) };
    expect(await tools({ git: git as never }).execute("space_git", { repo: "/home/x/site", op: "log" }, ctx)).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("Repositories: stable, dev") });
  });

  it("refuses a read-on of an answer that is not kept, naming the kept ones (tool_result ×1)", async () => {
    expect(await tools().execute("space_tool_result", { call: "toolu_gone", offset: 2000 }, ctx)).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("No long answer of call toolu_gone is kept") });
  });

  it("refuses to settle a decision id that is none of the owner's, naming where the ids are (settle_decision ×1)", async () => {
    const settled = await tools({ settleDecision: async () => null }).execute("space_settle_decision", { decision: "nous_decision:c25803f2", state: "VOID", reason: "Superseded." }, ctx);
    expect(settled).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("space_nous_decisions") });
  });

  // Daily Nous errors 14/11 slice 3: a card the gates did not raise, or one about no plan, is a refusal.
  it("refuses a card whose answer says Nothing raised (notify_operator ×1, options with no recommended one)", async () => {
    const notify = vi.fn(async () => ({ ok: false, display: "Asked without a recommended option", result: "\"Paired?\" has options and no recommended one: give one. Nothing raised." }));
    expect(await tools({ paneNotices: { notify } as never }).execute("space_notify_operator", { room: "Felix", pane: "Andy", title: "Pairing",
      items: [{ text: "Paired?", options: ["Yes", "No"] }], checked: ["Andy's screen: the pairing prompt"] } as never, ctx)).toMatchObject({ ok: false, refused: true });
  });

  it("refuses a card about a plan that is none of the owner's, naming space_plans (notify_operator ×1)", async () => {
    const notify = vi.fn();
    expect(await tools({ paneNotices: { notify } as never }).execute("space_notify_operator", { plan: "clipboard:zzzzzzzzzzzz", title: "Plan",
      items: [{ text: "Approve the plan" }], checked: ["The plan: waits for approval"] } as never, ctx)).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("space_plans") });
    expect(notify).not.toHaveBeenCalled();
  });

  // Daily Nous errors 14/11 slice 4.
  it("refuses a send whose text stayed an unsent draft, naming space_clear_pane_draft (send_to_pane ×3)", async () => {
    const roomTool = vi.fn(async () => ({ ok: false, display: "Send failed", result: JSON.stringify({ results: [{ paneId: "pane:andy0001", status: "FAILED",
      detail: "The CLI kept the text as an unsent draft after Enter; it was not submitted." }] }) }));
    expect(await tools({ roomTool }).execute("space_send_to_pane", { room: "Felix", pane: "Andy", text: "Run the tests." }, ctx))
      .toMatchObject({ ok: false, refused: true, result: expect.stringContaining("space_clear_pane_draft") });
  });

  it("holds an attachment Gmail still does not serve after a fresh read, naming space_mail_read without attachment (mail_read ×1)", async () => {
    const mail = { search: vi.fn(), accounts: vi.fn(async () => ["op@example.com"]),
      read: vi.fn(async () => ({ account: "op@example.com", threadId: "t1", subject: "Invite", messages: [{ messageId: "m1", from: { name: "A", address: "a@example.com" }, to: [],
        receivedAt: "2026-11-13T08:00:00.000Z", text: "See the invite.", attachments: [{ attachmentId: "att-1", filename: "invite.ics", mimeType: "text/calendar", size: 900, contentId: null }] }] })),
      attachmentText: vi.fn(async () => { throw new Error("Attachment was not found."); }) };
    const read = await tools({ mail: mail as unknown as NousToolDeps["mail"] }).execute("space_mail_read", { account: "op@example.com", threadId: "t1", attachment: "invite.ics" }, ctx);
    expect(read).toMatchObject({ ok: false, refused: true, meta: { mailCode: "NOT_FOUND" }, result: expect.stringContaining('without "attachment"') });
    expect(read.result).not.toContain("space_mail_search");
  });

  // Daily Nous errors 14/11 slice 5.
  it("refuses helpers called with both tasks and runId, or neither, naming which to give (subagents ×1)", async () => {
    const subagents = { run: vi.fn(), wait: vi.fn() };
    const f = tools({ subagents: subagents as never });
    expect(await f.execute("space_subagents", {}, ctx)).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("not both") });
    expect(await f.execute("space_subagents", { tasks: [{ title: "Check", instructions: "Read Andy." }], runId: "nous_helpers:0123456789abcdef0123" }, ctx)).toMatchObject({ ok: false, refused: true });
    expect(subagents.run).not.toHaveBeenCalled();
  });

});
