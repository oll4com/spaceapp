import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasTaskImageReference,
  readableTaskImages,
  taskImageReferences,
  taskTitleImageMaxBytes,
} from "../src/task-title-images.js";

const scope = { artifactRoot: "/opt/spaceapp/var/artifacts", roomId: "room:R1", paneId: "pane:P1", cwd: "/work" };
const upload = (pane: string, file: string) =>
  `/opt/spaceapp/var/artifacts/cli-uploads/room_R1/${pane}/cli_session_S1/2026-10-12/${file}`;

describe("task title image references", () => {
  it("accepts only this pane's image uploads, latest last and at most two", () => {
    const raw = [
      `'${upload("pane_P1", "upload_a-one.png")}'`,
      upload("pane_OTHER", "upload_b-foreign.png"),
      upload("pane_P1", "upload_c-notes.md"),
      `"${upload("pane_P1", "upload_d-two.jpeg")}" ${upload("pane_P1", "upload_e-three.webp")} fix this`,
    ].join(" ");
    expect(hasTaskImageReference(raw)).toBe(true);
    expect(taskImageReferences(raw, scope)).toEqual([
      upload("pane_P1", "upload_d-two.jpeg"),
      upload("pane_P1", "upload_e-three.webp"),
    ]);
  });
  it("rebases any prefix onto the configured upload root and rejects traversal", () => {
    expect(taskImageReferences("/elsewhere/cli-uploads/room_R1/pane_P1/s/2026-10-12/upload_x.png", scope))
      .toEqual([upload("pane_P1", "upload_x.png").replace("cli_session_S1", "s")]);
    expect(taskImageReferences("/cli-uploads/room_R1/pane_P1/../2026-10-12/upload_x.png", scope)).toEqual([]);
    expect(taskImageReferences("/cli-uploads/room_R1/pane_P1/s/2026-10-12/../../x.png", scope)).toEqual([]);
    expect(hasTaskImageReference("Plain request without uploads")).toBe(false);
  });
  it("resolves Reasonix clipboard attachments inside the session workspace only", () => {
    expect(taskImageReferences("@.reasonix/attachments/clipboard-20261012-101500.123.png fix", scope))
      .toEqual(["/work/.reasonix/attachments/clipboard-20261012-101500.123.png"]);
    expect(taskImageReferences("@.reasonix/attachments/../../etc/passwd.png", scope)).toEqual([]);
    expect(taskImageReferences("@.reasonix/attachments/clipboard-20261012-101500.123.png", { ...scope, cwd: null })).toEqual([]);
  });
  it("reads only regular, bounded files that stay inside the pane's upload directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "title-image-files-"));
    try {
      const local = { ...scope, artifactRoot: root, cwd: null };
      const dir = join(root, "cli-uploads", "room_R1", "pane_P1", "s", "2026-10-12");
      const foreignDir = join(root, "cli-uploads", "room_R1", "pane_OTHER", "s", "2026-10-12");
      await mkdir(dir, { recursive: true });
      await mkdir(foreignDir, { recursive: true });
      const good = join(dir, "upload_a.png"), big = join(dir, "upload_b.png"), empty = join(dir, "upload_c.png");
      const foreign = join(foreignDir, "upload_d.png"), link = join(dir, "upload_e.png");
      await writeFile(good, "png");
      await writeFile(big, "");
      await truncate(big, taskTitleImageMaxBytes + 1);
      await writeFile(empty, "");
      await writeFile(foreign, "png");
      await symlink(foreign, link);
      expect(await readableTaskImages([good, big], local)).toEqual([await realpath(good)]);
      expect(await readableTaskImages([empty, foreign], local)).toEqual([]);
      expect(await readableTaskImages([link, join(dir, "missing.png")], local)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
