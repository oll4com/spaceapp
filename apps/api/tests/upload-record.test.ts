import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { recordUploadedArtifact, inspectUploadRecord } from "../src/upload-record.js";

let root: string;
let store: InMemorySpaceStore;
const body = "private attachment contents";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "space-upload-record-"));
  store = new InMemorySpaceStore();
  await writeFile(join(root, "file.txt"), body);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

function record() {
  return recordUploadedArtifact(store, { roomId: null, paneId: null, kind: "EXPORT", mimeType: "text/plain",
    storageUri: "space-artifact://user-uploads/fixture/file.txt", sha256: createHash("sha256").update(body).digest("hex"),
    byteSize: Buffer.byteLength(body), metadata: {} }, "trace:upload-record", join(root, "file.txt"));
}
async function loseAcknowledgement() {
  const create = store.createArtifact.bind(store);
  vi.spyOn(store, "createArtifact").mockImplementation((...args) => {
    create(...args);
    throw new Error("Connection dropped after COMMIT");
  });
  await expect(record()).rejects.toMatchObject({ code: "UPLOAD_RECORD_UNCERTAIN", statusCode: 503 });
  return join(root, (await readdir(root)).find(name => name.startsWith(".upload-record-"))!);
}

it("removes the journal only after confirmed persistence", async () => {
  const result = await record();
  expect(store.getArtifact(result.artifact.id).storageUri).toBe("space-artifact://user-uploads/fixture/file.txt");
  expect(await readdir(root)).toEqual(["file.txt"]);
});

it("retains private metadata without attachment text and confirms a lost acknowledgement without repeating it", async () => {
  const marker = await loseAcknowledgement();
  expect((await stat(marker)).mode & 0o777).toBe(0o600);
  expect(await readFile(marker, "utf8")).not.toContain(body);
  expect(await inspectUploadRecord(root, marker, uri => store.listArtifacts().filter(artifact => artifact.storageUri === uri))).toMatchObject({ status: "CONFIRMED", fileValid: true });
  expect(store.createArtifact).toHaveBeenCalledTimes(1);
  expect(await readdir(root)).toHaveLength(2);
});

it("detects content damage without retrying the database write", async () => {
  const marker = await loseAcknowledgement();
  await writeFile(join(root, "file.txt"), "x".repeat(Buffer.byteLength(body)));
  expect(await inspectUploadRecord(root, marker, uri => store.listArtifacts().filter(artifact => artifact.storageUri === uri))).toMatchObject({ status: "FILE_DAMAGED_OR_MISSING", fileValid: false });
  expect(store.createArtifact).toHaveBeenCalledTimes(1);
});

it("reports missing files and conflicting metadata without deleting evidence", async () => {
  const marker = await loseAcknowledgement();
  const original = store.listArtifacts()[0]!;
  vi.spyOn(store, "listArtifacts").mockReturnValue([{ ...original, sha256: "0".repeat(64) }]);
  expect(await inspectUploadRecord(root, marker, uri => store.listArtifacts().filter(artifact => artifact.storageUri === uri))).toMatchObject({ status: "CONFLICT", fileValid: true });
  await rm(join(root, "file.txt"));
  expect(await inspectUploadRecord(root, marker, uri => store.listArtifacts().filter(artifact => artifact.storageUri === uri))).toMatchObject({ status: "FILE_DAMAGED_OR_MISSING" });
  expect(await readFile(marker, "utf8")).toContain(original.storageUri);
});

it("fails closed on a symlinked journal or an escaping filename", async () => {
  const marker = await loseAcknowledgement();
  await symlink(marker, join(root, "link.json"));
  await expect(inspectUploadRecord(root, join(root, "link.json"), uri => store.listArtifacts().filter(artifact => artifact.storageUri === uri))).rejects.toMatchObject({ code: "PATH_UNSAFE" });
  const metadata = JSON.parse(await readFile(marker, "utf8"));
  await writeFile(marker, JSON.stringify({ ...metadata, filename: "../outside.txt" }));
  await expect(inspectUploadRecord(root, marker, uri => store.listArtifacts().filter(artifact => artifact.storageUri === uri))).rejects.toThrow();
  expect(store.createArtifact).toHaveBeenCalledTimes(1);
});
