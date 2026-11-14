import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact } from "@space/contracts";
import { asciiFileName, createFileMentions, type FileMentionsDeps } from "../src/nous/file-mentions.js";
import { createAppointmentsService } from "../src/appointments.js";
import { createNotificationService } from "../src/notifications/service.js";
import { InMemorySpaceNotificationsRepository } from "@space/db";
import { SpaceEventBus } from "@space/runtime";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "file-mentions-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const artifact = (id: string, content: string): Artifact => ({ id, roomId: "room:a", paneId: null, turnId: null, workflowId: null, kind: "EXPORT", mimeType: "text/markdown",
  storageUri: `space-artifact://agent-files/${id}`, sha256: sha(content), byteSize: content.length, metadata: { originalFilename: `${id}.md` },
  expiresAt: null, pinnedAt: null, deletedAt: null, createdAt: "2026-11-04T07:00:00.000Z" });

function setup(existing: Artifact[] = [], role = true) {
  const added: Array<Parameters<FileMentionsDeps["add"]>[1]> = [];
  const deps: FileMentionsDeps = {
    publishable: async (path) => {
      if (path.includes("missing")) throw new Error(`No file or folder ${path}`);
      const sourcePath = join(dir, path.split("/").pop()!);
      return { sourceRoot: dir, sourcePath, shown: path, copiedFrom: null };
    },
    add: vi.fn(async (_owner, input) => { added.push(input); return artifact(`artifact:new${added.length}xx`, "x"); }),
    rooms: async () => [{ id: "room:a" }, { id: "room:b" }],
    agentFiles: async (roomId) => roomId === "room:b" ? existing : [],
    allowed: async () => role
  };
  return { mentions: createFileMentions(deps), added, deps };
}

describe("workspace files named in Space's texts go to Agent Files (nous_msg:8e7e6c25)", () => {
  it("files a path under Documents/Interviews, writes its id beside it, and reuses an Agent File with the same content", async () => {
    await writeFile(join(dir, "20261104-wim-mcarthur.md"), "# WIM prep");
    await writeFile(join(dir, "20261104-axis.md"), "# Axis prep");
    const { mentions, added } = setup([artifact("artifact:eunVA-x5EHIv", "# Axis prep")]);
    const text = "Προετοιμασία: nous/job/interview-prep/20261104-wim-mcarthur.md and nous/job/interview-prep/20261104-axis.md, nous/missing.md";
    expect(await mentions.annotate("user:operator", text, "INTERVIEW")).toBe("Προετοιμασία: nous/job/interview-prep/20261104-wim-mcarthur.md (artifact:new1xx) and "
      + "nous/job/interview-prep/20261104-axis.md (artifact:eunVA-x5EHIv), nous/missing.md");
    expect(added).toEqual([expect.objectContaining({ roomId: "room:a", folder: "Documents/Interviews", filename: "20261104-wim-mcarthur.md" })]);
    // Already annotated: left as it is, nothing filed again.
    const again = await mentions.annotate("user:operator", "nous/job/interview-prep/20261104-wim-mcarthur.md (artifact:new1xx)");
    expect(again).toBe("nous/job/interview-prep/20261104-wim-mcarthur.md (artifact:new1xx)");
    expect(added).toHaveLength(1);
  });

  it("files a report under Documents/Reports with an ASCII name, once for two clicks at the same time", async () => {
    await writeFile(join(dir, "αναφορά-test.md"), "report");
    const { mentions, added } = setup();
    const [first, second] = await Promise.all([mentions.publish("user:operator", "nous/reports/αναφορά-test.md"), mentions.publish("user:operator", "nous/reports/αναφορά-test.md")]);
    expect(first.id).toBe(second.id);
    expect(added).toEqual([expect.objectContaining({ folder: "Documents/Reports", filename: "test.md" })]);
    expect(asciiFileName("ραντεβού.md", "abcdef0123")).toBe("file-abcdef01.md");
  });

  it("reaches the workspace only for an ADMIN or OPERATOR owner", async () => {
    await writeFile(join(dir, "a.md"), "a");
    const { mentions, added } = setup([], false);
    expect(await mentions.annotate("user:other", "nous/a.md")).toBe("nous/a.md");
    await expect(mentions.publish("user:other", "nous/a.md")).rejects.toThrow("Only the operator's workspace");
    expect(added).toHaveLength(0);
  });

  it("an appointment's notes keep the id of the file they name, on add and on update; no notes stay no notes", async () => {
    const annotate = vi.fn(async (_owner: string, text: string, hint: string) => `${text} (artifact:prep${hint})`);
    const service = createAppointmentsService({ store: { getUserSettings: async () => null } as never, annotate });
    // The sections every upcoming appointment needs (nous_msg:a6016259), the file in its last one.
    const sections = "ΤΙ ΕΙΝΑΙ: γνωριμία\nΕΙΣΟΔΟΣ: Teams, χωρίς λογαριασμό\nΓΙΑΤΙ ΑΞΙΖΕΙ: στάδιο 1\nΠΗΓΗ: mail\nΤΙ ΧΡΕΙΑΖΕΣΑΙ: ";
    const item = await service.add("user:operator", { title: "WIM", startsAt: "2026-11-05T05:00:00.000Z", kind: "INTERVIEW", format: "LIVE_HUMAN_VIDEO", timing: "FIXED", location: "https://teams.microsoft.com/l/w",
      notes: `${sections}nous/job/interview-prep/w.md` });
    expect(item.notes).toBe(`${sections}nous/job/interview-prep/w.md (artifact:prepINTERVIEW)`);
    expect((await service.update("user:operator", item.id, { notes: `${sections}nous/a.md` })).notes).toBe(`${sections}nous/a.md (artifact:prep)`);
    expect((await service.update("user:operator", item.id, { title: "WIM 2" })).notes).toBe(`${sections}nous/a.md (artifact:prep)`);
    expect(annotate).toHaveBeenCalledTimes(2);
  });

  it("a card's body and a Done record's summary keep the id of the file they name", async () => {
    const annotate = vi.fn(async (_owner: string, text: string) => text.replace("nous/r.md", "nous/r.md (artifact:reportxx)"));
    const service = createNotificationService({ repository: new InMemorySpaceNotificationsRepository(), eventBus: new SpaceEventBus(),
      userSettings: async () => ({ notifications: null }) as never, nous: { held: async () => false, raised: () => undefined, annotate } });
    const done = await service.raise({ ownerUserId: "user:operator", source: "NOUS", kind: "REQUEST_DONE", severity: "INFO", title: "Done", body: "See nous/r.md",
      link: {}, payload: { request: "Write the report", summary: "Written to nous/r.md", where: "no code" } });
    expect(done.body).toBe("See nous/r.md (artifact:reportxx)");
    expect(done.payload.summary).toBe("Written to nous/r.md (artifact:reportxx)");
  });
});
