// Daily Nous errors 13/11 (slice 6): when one answer is plain, a near ref resolves instead of failing; ambiguous refs keep the error.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Pane, Room } from "@space/contracts";
import { createNousFiles } from "../src/nous/files.js";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";

const owner = "user:operator";
const ctx = { owner, turnId: "turn:1", callId: "call:1", traceId: "trace:1" };
const room = (id: string, name: string, kind = "WORKSPACE") => ({ id, name, kind, ownerUserId: owner }) as Room;
const pane = (id: string, roomId: string, mode: string) => ({ id, roomId, title: "Bob", paneName: "Bob", mode, isClosed: false }) as unknown as Pane;
const tools = (extra: Partial<NousToolDeps>) => createNousTools(extra as unknown as NousToolDeps);

describe("space_task_update with a title or a near id", () => {
  const list = [{ id: "task:AbCdEf123456", title: "Daily backup check", status: "OPEN" }, { id: "task:Zz9xYy876543", title: "Weekly report", status: "OPEN" }];
  const setup = (open = list) => {
    const update = vi.fn(async (_owner: string, id: string, input: { status?: string }) => {
      const task = open.find((item) => item.id === id);
      if (!task) throw new Error(`Task item ${id} was not found`);
      return { ...task, ...input };
    });
    return { update, nous: tools({ tasks: { list: async () => open, add: vi.fn(), update, rebind: vi.fn() } as never }) };
  };

  it("resolves an exact title and an id two characters off, and says which task changed", async () => {
    const { update, nous } = setup();
    const byTitle = await nous.execute("space_task_update", { task: "daily backup check", status: "DONE" }, ctx);
    expect(byTitle.ok).toBe(true);
    expect(update).toHaveBeenLastCalledWith(owner, "task:AbCdEf123456", { status: "DONE" });
    expect(byTitle.result).toContain("changed [task:AbCdEf123456]");
    expect((await nous.execute("space_task_update", { task: "task:AbCdEf123465", status: "DONE" }, ctx)).ok).toBe(true);
    expect((await nous.execute("space_task_update", { task: "task:zz9xyy", status: "DONE" }, ctx)).result).toContain("Task task:Zz9xYy876543 is DONE");
  });

  it("keeps the error for invented ids and titles several tasks share", async () => {
    const invented = await setup().nous.execute("space_task_update", { task: "task:nth-0123456789abcdef", status: "DONE" }, ctx);
    // Daily Nous errors 13/11 (8 of 15 failed in 48 h): the answer lists the real ids, so it is a refusal, not a failed call.
    expect(invented).toMatchObject({ ok: false, refused: true, display: "No such task" });
    expect(invented.result).toContain("[task:AbCdEf123456]");
    const twice = [...list, { id: "task:Qq1wWe2rRt3y", title: "Daily backup check", status: "OPEN" }];
    expect((await setup(twice).nous.execute("space_task_update", { task: "Daily backup check", status: "DONE" }, ctx)).result).toContain("fits several tasks");
  });
});

describe("space_read_pane with a name open in several other rooms", () => {
  const alpha = room("room:alpha", "Alpha"), bruno = room("room:bruno", "Bruno"), cleo = room("room:cleo", "Cleo"), proof = room("room:proof", "Agent Proof", "AGENT_PROOF");
  const setup = (panes: Record<string, Pane[]>) => {
    const roomTool = vi.fn(async (_name: string, args: { pane: string }) => ({ ok: true, display: "Read", result: `screen of ${args.pane}` }));
    return { roomTool, nous: tools({ rooms: async () => [alpha, bruno, cleo, proof], listPanes: async (id: string) => panes[id] ?? [], roomTool: roomTool as never }) };
  };

  it("reads the only CLI pane of that name outside test rooms", async () => {
    const { nous } = setup({ "room:bruno": [pane("pane:bruno-bob", "room:bruno", "TERMINAL")], "room:cleo": [pane("pane:cleo-bob", "room:cleo", "BROWSER")],
      "room:proof": [pane("pane:proof-bob", "room:proof", "TERMINAL")] });
    const read = await nous.execute("space_read_pane", { room: "Alpha", pane: "Bob" }, ctx);
    expect(read.ok).toBe(true);
    expect(read.result).toContain("screen of pane:bruno-bob");
    expect(read.result).toContain("the only CLI pane of that name");
  });

  it("reads the pane last reached by that name, and keeps the error listing every room and pane when nothing decides", async () => {
    const both = { "room:bruno": [pane("pane:bruno-bob", "room:bruno", "TERMINAL")], "room:cleo": [pane("pane:cleo-bob", "room:cleo", "TERMINAL")] };
    const fresh = await setup(both).nous.execute("space_read_pane", { room: "Alpha", pane: "Bob" }, ctx);
    expect(fresh.ok).toBe(false);
    expect(fresh.result).toContain("Bruno (pane:bruno-bob), Cleo (pane:cleo-bob)");
    const { nous } = setup(both);
    expect((await nous.execute("space_read_pane", { room: "Cleo", pane: "Bob" }, ctx)).ok).toBe(true);
    const again = await nous.execute("space_read_pane", { room: "Alpha", pane: "Bob" }, ctx);
    expect(again.result).toContain("screen of pane:cleo-bob");
    expect(again.result).toContain("reached by that name before");
  });
});

describe("space_files_read and space_files_list on a path that does not exist", () => {
  const base = mkdtempSync(join(tmpdir(), "nous-near-refs-"));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "agent-workspace");
  mkdirSync(join(root, "reports"), { recursive: true });
  writeFileSync(join(root, "reports", "daily.md"), "ok");
  const alpha = room("room:alpha", "Alpha");
  const files = createNousFiles({ root, ownRoot: join(base, "own"), artifactRoot: join(base, "artifacts"), rooms: async () => [alpha], listArtifacts: async () => [],
    getArtifact: async () => { throw new Error("none"); } });

  it("answers with the nearest existing paths as a hold, not a failed call", async () => {
    const nous = tools({ rooms: async () => [alpha], listPanes: async () => [], files });
    for (const tool of ["space_files_read", "space_files_list"]) {
      const answer = await nous.execute(tool, { path: "reports/dialy.md" }, ctx);
      expect(answer).toMatchObject({ ok: false, refused: true, display: expect.stringContaining("no such path") });
      expect(answer.result).toContain("reports");
    }
  });
});
