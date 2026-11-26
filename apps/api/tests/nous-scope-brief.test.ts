import { describe, expect, it, vi } from "vitest";
import type { Pane, Room } from "@space/contracts";
import { createNousTools, scopeLimitsLost, type NousToolDeps } from "../src/nous/tools.js";

/** 14/11 slice 22 (Daily Nous errors, ~16 corrections "acted beyond the order"): the operator's «μόνο …» limit lost in the brief to a pane. */

const owner = "user:operator";
const b2 = "οχι απενεργοποιεις τα backup του b2 μονο για το azure server!!";
const room = { id: "room:felix001", name: "Felix", kind: "WORKSPACE", ownerUserId: owner, archivedAt: null } as unknown as Room;
const andy = { id: "pane:andy0001", roomId: room.id, paneName: "Andy", title: "Andy", mode: "TERMINAL", terminalRuntimeId: "cli:codex", isClosed: false } as unknown as Pane;
const turn = (content: string, reason = "OPERATOR", person = true) => ({ owner, turnId: "nous_turn:s22", callId: "toolu_1", traceId: "trace:1",
  turn: { reason, operatorMessage: { id: "nous_msg:s22", content, person }, replyTo: [] } }) as never;

describe("scopeLimitsLost", () => {
  it("names the limit a brief leaves out, and keeps quiet when the brief holds it", () => {
    expect(scopeLimitsLost(b2, "Disable the B2 backup timers on every host.")).toEqual(["μονο για το azure server"]);
    expect(scopeLimitsLost(b2, "B2 backups off only on the Azure server (pve-az); leave the other hosts as they are.")).toEqual([]);
    expect(scopeLimitsLost("θελω να μου φτιαξεις μια μονο οθονη για αρχη τιποτα αλλο!!", "Build the app: all screens.")).toHaveLength(1);
    expect(scopeLimitsLost("Κάνεις αλλαγές μόνο στα 100....", "Add photos and filters to the 100 products only.")).toEqual([]);
  });

  it("reads «απλά …» and «… τίποτα άλλο» as limits too (corrections 17/11 da464a6e, 18/11 6a9337d8)", () => {
    const disk = "σου ζητησα απλα να διαγραφει το περιεχομενο του δισκου του γερμανικου για το εξωτερικο δίσκο!!";
    expect(scopeLimitsLost(disk, "Unmount the Storage Box on hz-pve and pve-az and disable its storages.")).toEqual(["απλα να διαγραφει το περιεχομενο του δισκου"]);
    expect(scopeLimitsLost(disk, "Delete only the content (διαγραφή περιεχομένου) of the German Storage Box disk; keep it mounted.")).toEqual([]);
    const civo = "δεν θελω να ζχηταει τιποτα--- απλα ενημερωνει το σχεδιο μας -- και κανει μια αναλυση κοστους -- τιποτα αλλο !!";
    expect(scopeLimitsLost(civo, "Draft the Civo mail asking explicitly for the Elevate tier.")).toEqual(["απλα ενημερωνει το σχεδιο μας", "και κανει μια αναλυση κοστους τιποτα αλλο"]);
    expect(scopeLimitsLost(civo, "Civo mail asks for nothing: it ενημερώνει for our 6-month σχέδιο and κάνει μια ανάλυση κόστους, nothing else.")).toEqual([]);
    expect(scopeLimitsLost("δεν ειναι απλα θεμα χρονου, κανε ολο το πλανο", "Run every step of the plan.")).toEqual([]);
  });

  it("finds no limit in «από μόνο σου», «όχι μόνο», «μόνο αν …» or a load percentage", () => {
    for (const said of ["γιατι δεν το ειχες κανει απο μονο σου ?", "οχι μονο τα types cli!!", "πατάει Confirm, μόνο αν δεν το πάτησες", "εισαι μονο 66% load", "εισαι μονο στο 39% πουσαρε",
      "απλά δεν δουλεύει το login, φτιάξ' το", "Thanks, nothing else"]) {
      expect(scopeLimitsLost(said, "Next step.")).toEqual([]);
    }
  });
});

describe("space_send_to_pane: the operator's limit", () => {
  const roomTool = vi.fn(async (name: string) => ({ ok: true, display: `ran ${name}`, result: `ran ${name}` }));
  const tools = createNousTools({ rooms: async () => [room], listPanes: async () => [andy], roomTool,
    inspectPane: async () => ({ text: "", state: "IDLE", sessionId: "session:1", tasks: [] }), quotaWaits: async () => [],
    allowances: async () => ({ promote: false, warm: false }) } as unknown as NousToolDeps);
  const send = (text: string, ctx: never) => tools.execute("space_send_to_pane", { room: "Felix", panes: ["Andy"], text }, ctx);

  it("is held once per turn when the brief leaves it out; the same send then passes", async () => {
    const ctx = turn(b2);
    const held = await send("Disable the B2 backup timers on every host.", ctx) as { ok: boolean; refused?: boolean; result: string };
    expect(held).toMatchObject({ ok: false, refused: true });
    expect(held.result).toContain("«μονο για το azure server»");
    expect(roomTool).not.toHaveBeenCalled();
    expect(await send("Disable the B2 backup timers on every host.", ctx)).toMatchObject({ ok: true });
    expect(roomTool).toHaveBeenCalledTimes(1);
  });

  it("passes a brief that keeps it, a standing turn and a pane's own message", async () => {
    expect(await send("Κλείσε τα B2 backup μόνο για το Azure server (pve-az).", turn(b2))).toMatchObject({ ok: true });
    expect(await send("Disable the B2 backup timers.", turn(b2, "STANDING"))).toMatchObject({ ok: true });
    expect(await send("Disable the B2 backup timers.", turn(b2, "OPERATOR", false))).toMatchObject({ ok: true });
  });
});

describe("the operator's limit on other dispatch paths", () => {
  const fixture = () => {
    const roomTool = vi.fn(async () => ({ ok: true, display: "sent", result: "sent" }));
    const answerPrompt = vi.fn(async () => ({}));
    const tools = createNousTools({ rooms: async () => [room], listPanes: async () => [andy], roomTool, answerPrompt,
      inspectPane: async () => ({ text: "What should I change?", state: "WAITING_FOR_INPUT", sessionId: "session:1", promptFingerprint: "fp1", tasks: [] }),
      quotaWaits: async () => [], allowances: async () => ({ promote: false, warm: false }) } as unknown as NousToolDeps);
    return { tools, roomTool, answerPrompt };
  };

  it("keeps the Civo limit in an answer to a waiting pane (correction 6a9337d8)", async () => {
    const f = fixture();
    const ctx = turn("απλα ενημερωνει το σχεδιο μας -- και κανει μια αναλυση κοστους -- τιποτα αλλο !!");
    const answer = (text: string) => f.tools.execute("space_answer_pane", { room: "Felix", pane: "Andy", answer: text }, ctx);
    expect(await answer("Draft the Civo mail asking for the Elevate tier.")).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("ενημερωνει το σχεδιο μας") });
    expect(f.answerPrompt).not.toHaveBeenCalled();
    expect(f.roomTool).not.toHaveBeenCalled();
    expect(await answer("Civo: απλα ενημερωνει το σχεδιο μας και κανει μια αναλυση κοστους, τιποτα αλλο.")).toMatchObject({ ok: true });
    expect(f.roomTool).toHaveBeenCalledTimes(1);
  });

  it("checks every Space Control prompt before any action in its batch runs", async () => {
    const f = fixture();
    const ctx = turn(b2);
    const action = (text: string) => ({ kind: "pane", operation: "prompt", target: { paneIds: [andy.id] }, text });
    const execute = (text: string) => f.tools.execute("space_execute", { room: "Felix", actions: [
      action("B2 backups off only on the Azure server."), action(text),
    ] }, ctx);
    expect(await execute("Disable B2 backups on every host.")).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("μονο για το azure server") });
    expect(f.roomTool).not.toHaveBeenCalled();
    expect(await execute("Disable B2 backups only on the Azure server.")).toMatchObject({ ok: true });
    expect(f.roomTool).toHaveBeenCalledTimes(1);
  });

  it("does not treat a decline or a menu choice as a new brief", async () => {
    for (const input of [{ decline: true }, { answer: "1" }]) {
      const f = fixture();
      expect(await f.tools.execute("space_answer_pane", { room: "Felix", pane: "Andy", ...input }, turn(b2))).toMatchObject({ ok: true });
      expect(f.roomTool).toHaveBeenCalledTimes(1);
    }
  });
});
