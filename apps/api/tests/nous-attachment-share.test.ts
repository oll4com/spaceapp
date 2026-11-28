import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { InMemoryNousAttachmentRepository } from "@space/db";
import { createNousAttachments } from "../src/nous/attachments.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

// 28/11 Nous Cloud box: the operator's fx-assistant-main.zip stayed in the chat for ten hours; no pane could reach it.
it("copies an attached ZIP into Nous's own folder where panes read it, names the tool in the attachments block, and keeps one copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "nous-share-"));
  roots.push(root);
  const repository = new InMemoryNousAttachmentRepository();
  const id = repository.newId();
  const storagePath = join(root, "nous-uploads", `${id.replace(/:/g, "_")}-fx-assistant-main.zip`);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(join(root, "nous-uploads"), { recursive: true }));
  await writeFile(storagePath, "PK\u0003\u0004zip-bytes");
  await repository.add({ id, ownerUserId: "user:op", kind: "FILE", filename: "fx-assistant-main.zip", mimeType: "application/zip", byteSize: 13,
    sha256: "x", storagePath, meta: {} } as never);
  const shareDir = join(root, "nous-workspace", "attachments");
  const attachments = createNousAttachments({ repository, root, share: { dir: shareDir, shown: "/workspaces/nous/attachments" } });

  expect(attachments.handles("space_nous_attachment_share")).toBe(true);
  expect((await attachments.prepare("user:op", [id])).block).toContain(`space_nous_attachment_share {"id":"${id}"}`);
  const first = await attachments.callTool("user:op", "space_nous_attachment_share", { id });
  expect(first.ok).toBe(true);
  expect(first.text).toContain("/workspaces/nous/attachments/");
  const copy = join(shareDir, storagePath.split("/").pop()!);
  expect(await readFile(copy, "utf8")).toBe("PK\u0003\u0004zip-bytes");
  expect((await stat(copy)).mode & 0o777).toBe(0o664);
  expect((await attachments.callTool("user:op", "space_nous_attachment_share", { id })).ok).toBe(true);
  // Another person's file is not theirs to share.
  expect((await attachments.callTool("user:other", "space_nous_attachment_share", { id })).ok).toBe(false);
  // Without a share folder the tool is not offered.
  expect(createNousAttachments({ repository, root }).handles("space_nous_attachment_share")).toBe(false);
});
