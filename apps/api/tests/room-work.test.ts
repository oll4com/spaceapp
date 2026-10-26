import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DeployQueueTicket, Pane } from "@space/contracts";
import type { ReleaseTrain } from "../src/release-trains.js";
import { createRoomWork, paneWorktree, roomWorkOverlaps, WORKTREE_MAX_AGE_MS, type RoomWorkPane } from "../src/room-work.js";
import type { WorktreeRecord } from "../src/worktrees/worktree-service.js";

const at = "2026-10-15T07:00:00.000Z";
const work = (paneId: string, name: string, top: string | null, files: string[], extra: Partial<RoomWorkPane> = {}): RoomWorkPane =>
  ({ paneId, name, top, branch: top ? `space/${top.split("/").at(-1)}` : null, files, tickets: [], task: null, ...extra });
const ticket = (id: string, status: DeployQueueTicket["status"], extra: Partial<DeployQueueTicket> = {}): DeployQueueTicket => ({
  id, status, branch: "space/wt", summary: "Fix the backups", sha: "3707cca9af", submittedAt: at, updatedAt: at, note: null, deployedCommit: null,
  conflictFiles: [], autoResolvedFiles: [], remotes: null, ...extra
});
const train: ReleaseTrain = { product: "run-spaceapp", version: "1.1.5", status: "OPEN", captain: { paneId: "pane:jack", name: "Jack" }, roomId: "room:r",
  sourceSha: null, contributors: [{ paneId: "pane:max", name: "Max", commit: "abcdef1234", note: null, addedAt: at }], openedAt: at, updatedAt: at };

describe("room work overlaps", () => {
  it("reports worktrees that change the same files, but not panes sharing one worktree or files everyone touches", () => {
    const overlaps = roomWorkOverlaps([
      work("pane:finn", "Finn", "/wt/a", ["apps/api/src/backup.ts", "AGENTS.md"]),
      work("pane:jack", "Jack", "/wt/b", ["apps/api/src/backup.ts", "AGENTS.md", "README.md"]),
      work("pane:hugo", "Hugo", "/wt/b", ["apps/api/src/backup.ts", "AGENTS.md", "README.md"]),
      work("pane:oscar", "Oscar", "/wt/c", ["AGENTS.md", "package-lock.json"])
    ], []);
    expect(overlaps).toEqual([{ title: "Finn and Hugo and Jack change the same files", paneIds: ["pane:finn", "pane:jack", "pane:hugo"],
      detail: "Shared files: apps/api/src/backup.ts. Worktrees: a (space/a), b (space/b)." }]);
  });

  it("reports a pane whose latest queue ticket conflicts, with the other panes changing those files", () => {
    const overlaps = roomWorkOverlaps([
      work("pane:finn", "Finn", "/wt/a", ["apps/api/src/backup.ts"], { tickets: [ticket("q-1", "CONFLICT", { conflictFiles: ["apps/web/src/x.ts"] })] }),
      work("pane:jack", "Jack", "/wt/b", ["apps/web/src/x.ts"]),
      work("pane:max", "Max", "/wt/c", [], { tickets: [ticket("q-2", "CONFLICT"), ticket("q-3", "DEPLOYED", { updatedAt: "2026-10-15T08:00:00.000Z" })] })
    ], []);
    expect(overlaps).toEqual([{ title: "Finn's queue ticket q-1 hit a merge conflict", paneIds: ["pane:finn", "pane:jack"],
      detail: "Conflicting files: apps/web/src/x.ts. Also changed by Jack." }]);
  });

  it("reports panes heading to a release outside the live train, never its captain or contributors", () => {
    const overlaps = roomWorkOverlaps([
      work("pane:jack", "Jack", null, [], { task: "Release 1.1.5" }),
      work("pane:max", "Max", null, [], { tickets: [ticket("q-4", "QUEUED", { summary: "Fix for 1.1.6" })] }),
      work("pane:finn", "Finn", null, [], { tickets: [ticket("q-5", "QUEUED", { summary: "Backups fix for 1.1.6" })] }),
      work("pane:hugo", "Hugo", null, [], { task: "Space-style chart", tickets: [ticket("q-6", "QUEUED", { summary: "Chart colors" })] }),
      // Release words, the train's own version or another product line's version are no sign of a second release.
      work("pane:oscar", "Oscar", null, [], { task: "Release trains: Finn joins 1.1.5", tickets: [ticket("q-7", "QUEUED", { summary: "Autohand 0.9.8 release" })] })
    ], [train, { ...train, product: "space-desktop", status: "PUBLISHED" }]);
    expect(overlaps.map((overlap) => overlap.title)).toEqual(["Finn works outside the open run-spaceapp 1.1.5 release"]);
    expect(overlaps[0]!.detail).toContain("Finn's queued work: q-5.");
  });

  it("finds where a pane works: its newest Space worktree or its latest ticket's worktree, not the launch directory", () => {
    const record = (id: string, extra: Partial<WorktreeRecord> = {}): WorktreeRecord => ({ id, worktreePath: `/opt/spaceapp/var/worktrees/space/${id}`, repoPath: "/opt/spaceapp",
      branch: `space/${id}`, baseBranch: "dev", status: "ACTIVE", createdAt: "2026-10-14T08:00:00.000Z", updatedAt: at, ...extra });
    const registry = [record("wt-finn", { paneId: "pane:finn" }), record("wt-jack"), record("wt-old", { paneId: "pane:finn", createdAt: "2026-10-01T08:00:00.000Z" }),
      record("wt-gone", { paneId: "pane:max", status: "DISCARDED" })];
    const finn = { id: "pane:finn", cwd: "/opt/spaceapp" };
    expect(paneWorktree(finn, [], registry)).toBe("/opt/spaceapp/var/worktrees/space/wt-finn");
    // A later ticket from another worktree wins over an older created one.
    expect(paneWorktree(finn, [ticket("q-1", "QUEUED", { branch: "space/wt-jack" })], registry)).toBe("/opt/spaceapp/var/worktrees/space/wt-jack");
    expect(paneWorktree({ id: "pane:jack", cwd: "/opt/spaceapp" }, [ticket("q-2", "DEPLOYED", { branch: "space/wt-jack" })], registry)).toBe("/opt/spaceapp/var/worktrees/space/wt-jack");
    expect(paneWorktree({ id: "pane:max", cwd: "/opt/spaceapp" }, [ticket("q-3", "DEPLOYED", { branch: "dev" })], registry)).toBe("/opt/spaceapp");
    expect(paneWorktree({ id: "pane:new", cwd: null }, [], registry)).toBeNull();
  });
});

describe("room work git reads", () => {
  it("reads a worktree once for every pane in it, again when its index or HEAD moves, else after five minutes", async () => {
    const repo = mkdtempSync(join(tmpdir(), "room-work-git-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
    try {
      git("init", "-q", "-b", "main");
      writeFileSync(join(repo, "a.txt"), "a\n");
      git("add", "a.txt");
      git("commit", "-q", "-m", "a");
      let time = 1_000_000;
      const pane = (id: string) => ({ id, isClosed: false, mode: "TERMINAL", cwd: repo, title: id, paneName: id }) as unknown as Pane;
      const work = createRoomWork({ listPanes: async () => [pane("pane:one"), pane("pane:two")], queueRoots: [], trains: async () => [],
        registry: async () => [], now: () => time });
      const files = async () => {
        time += 61_000;
        const { panes } = await work.read("room:r");
        expect(panes[0]!.files).toEqual(panes[1]!.files);
        return panes[0]!.files;
      };
      writeFileSync(join(repo, "u1.txt"), "1\n");
      expect(await files()).toEqual(["u1.txt"]);
      // Unstaged edits touch neither HEAD nor the index: the reading is reused, and our own status left the index alone.
      writeFileSync(join(repo, "u2.txt"), "2\n");
      expect(await files()).toEqual(["u1.txt"]);
      git("add", "u2.txt");
      expect(await files()).toEqual(["u1.txt", "u2.txt"]);
      writeFileSync(join(repo, "u3.txt"), "3\n");
      time += WORKTREE_MAX_AGE_MS;
      expect(await files()).toEqual(["u1.txt", "u2.txt", "u3.txt"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
