import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import Fastify from "fastify";
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, type PDFObject, type PDFRef } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { localArtifactFilePath } from "../src/artifact-storage.js";
import { isCliBridgeRoutePath } from "../src/cli-bridge-paths.js";
import { persistAgentFile } from "../src/cli-agent-files.js";
import { createSignatureService, registerSignatureAgentRoutes, registerSignatures, signatureFieldTexts, stampSignature } from "../src/signatures.js";

/** A tiny transparent-capable RGBA PNG (w×h), made by hand so the test needs no image library. */
function png(width = 4, height = 2): Buffer {
  const crc = (buf: Buffer) => { let c = ~0; for (const byte of buf) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type: string, data: Buffer) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, "ascii"); data.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height, 0x80);
  for (let row = 0; row < height; row++) raw[row * (width * 4 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
async function pdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let index = 0; index < pages; index++) doc.addPage([595, 842]);
  return Buffer.from(await doc.save());
}
/** What each page draws, read from its own content streams: an image (Do) and text (Tj). */
async function resources(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    const contents = page.node.Contents();
    const streams: PDFObject[] = contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref)!) : contents ? [contents] : [];
    const text = streams.map((stream) => stream instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1") : "").join("\n");
    return { images: /\sDo\b/.test(text), fonts: /\sTj\b/.test(text) };
  });
}

describe("signature stamping", () => {
  it("puts the signature on exactly the placements' pages and the fields' text where asked, leaving the original bytes as they were", async () => {
    const original = await pdf(3);
    const before = createHash("sha256").update(original).digest("hex");
    const signed = await stampSignature(original, png(), [{ page: 1, x: 100, y: 80, width: 150 }, { page: 3, x: 300, y: 120, width: 120 }],
      signatureFieldTexts([{ page: 2, x: 50, y: 700, kind: "PHONE", label: "Phone", size: 10 }], undefined, { phone: "+66 82 558 4972", today: "04.11.2026" }));
    expect(createHash("sha256").update(original).digest("hex")).toBe(before);
    expect(await resources(signed)).toEqual([{ images: true, fonts: false }, { images: false, fonts: true }, { images: true, fonts: false }]);
    await expect(stampSignature(original, png(), [{ page: 4, x: 0, y: 0, width: 10 }])).rejects.toThrow("Page 4 does not exist: the PDF has 3 pages.");
  });

  it("fills a field with what the owner confirmed, else the agent's value, else the saved phone or today's date", () => {
    const fields = [{ page: 1, x: 1, y: 1, kind: "PHONE" as const, label: "Phone", size: 10 }, { page: 1, x: 1, y: 1, kind: "DATE" as const, label: "Date", size: 10 },
      { page: 1, x: 1, y: 1, kind: "TEXT" as const, label: "Place", value: "Bangkok", size: 10 }];
    expect(signatureFieldTexts(fields, undefined, { phone: "+66 82 558 4972", today: "04.11.2026" }).map((item) => item.text)).toEqual(["+66 82 558 4972", "04.11.2026", "Bangkok"]);
    expect(signatureFieldTexts(fields, ["+30 690 000 0000", "05.11.2026", "Athens"], { phone: null, today: "x" }).map((item) => item.text)).toEqual(["+30 690 000 0000", "05.11.2026", "Athens"]);
  });
});

describe("signature access", () => {
  const room = { id: "room:a", ownerUserId: "user:a" };
  const artifact = { id: "artifact:pdf", roomId: "room:a", paneId: null, mimeType: "application/pdf", storageUri: "space-artifact://agent-files/room%3Aa/user/browser/2026-11-04/x-claim.pdf",
    metadata: { originalFilename: "claim.pdf" }, deletedAt: null };
  const store = { getArtifact: async (id: string) => { if (id !== artifact.id) throw new Error("missing"); return artifact; }, getRoom: async () => room,
    getPane: async () => ({ id: "pane:x", roomId: "room:a", title: "Max" }), upsertUser: async (user: { id: string }) => user, recordAuditEvent: async () => ({}),
    getActivePaneCliSession: async () => null } as never;

  it("never lets another owner ask for a signature on a PDF of rooms they do not own", async () => {
    const service = createSignatureService({ store, artifactRoot: await mkdtemp(join(tmpdir(), "sig-")) });
    await expect(service.request("user:b", { id: "pane:x", roomId: "room:a", title: "Max" }, { artifactId: artifact.id, title: "Claim", placements: [{ page: 1, x: 1, y: 1, width: 10 }] }))
      .rejects.toThrow("Agent File artifact:pdf was not found.");
    const made = await service.request("user:a", { id: "pane:x", roomId: "room:a", title: "Max" }, { artifactId: artifact.id, title: "Claim", placements: [{ page: 1, x: 1, y: 1, width: 10 }] });
    expect(await service.list("user:b")).toEqual([]);
    expect((await service.list("user:a")).map((item) => item.id)).toEqual([made.request.id]);
  });

  it("keeps an App Studio pane's request out of the operator's list and Needs you (a test), listing it only when tests are asked for", async () => {
    const raised: unknown[] = [];
    const studio = { ...(store as object), getPane: async (id: string) => ({ id, roomId: "room:a", title: "Iris", mode: id === "pane:studio" ? "APP_STUDIO" : "CODE" }) } as never;
    const service = createSignatureService({ store: studio, artifactRoot: await mkdtemp(join(tmpdir(), "sig-")),
      notifications: { raise: async (input) => { raised.push(input); return null; }, resolve: async () => 0 } });
    const body = { artifactId: artifact.id, title: "ΔΟΚΙΜΗ", placements: [{ page: 1, x: 1, y: 1, width: 10 }] };
    const test = await service.request("user:a", { id: "pane:studio", roomId: "room:a", title: "Iris" }, body);
    const real = await service.request("user:a", { id: "pane:x", roomId: "room:a", title: "Max" }, body);
    expect([test.request.test, real.request.test]).toEqual([true, false]);
    expect(raised).toHaveLength(1);
    // goal ee5a573e: the Sign card says what was checked, so the daily REVIEW does not count it as bare.
    expect((raised[0] as { body: string }).body).toContain("\n\nChecked first:\n• Agent Files: ");
    expect((await service.list("user:a", "PENDING")).map((item) => item.id)).toEqual([real.request.id]);
    expect((await service.list("user:a", "PENDING", true)).map((item) => item.id).sort()).toEqual([test.request.id, real.request.id].sort());
  });

  it("serves the stored signature only to its owner's own session: a broker session cannot read, replace or use it", async () => {
    const app = Fastify();
    const session: { principal?: string } = {};
    app.addHook("onRequest", async (request) => { request.user = { id: "user:a" } as never; (request as { sessionPrincipal?: string }).sessionPrincipal = session.principal; });
    const service = registerSignatures(app, { store, artifactRoot: await mkdtemp(join(tmpdir(), "sig-")), routeOptions: {} });
    await service.saveSignature("user:a", { png: png().toString("base64") });
    expect((await app.inject({ method: "GET", url: "/api/signature/image" })).headers["content-type"]).toBe("image/png");
    session.principal = "user:operator-proof";
    expect((await app.inject({ method: "GET", url: "/api/signature" })).json()).toEqual({ signature: null });
    expect((await app.inject({ method: "GET", url: "/api/signature/image" })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await app.inject({ method: "PUT", url: "/api/signature", payload: { png: png().toString("base64") } })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await app.inject({ method: "GET", url: "/api/signatures" })).json()).toEqual({ signatures: [] });
    expect((await app.inject({ method: "POST", url: "/api/signatures", payload: { png: png().toString("base64") } })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await app.inject({ method: "POST", url: `/api/artifacts/${artifact.id}/sign`, payload: { placements: [{ page: 1, x: 1, y: 1, width: 10 }] } })).statusCode).toBeGreaterThanOrEqual(400);
    await app.close();
  });

  it("lets a pane reach space_signature_request and space_signature_apply with its bridge token (no session), and refuses a call without one", async () => {
    expect(isCliBridgeRoutePath("/api/cli/signature-requests")).toBe(true);
    expect(isCliBridgeRoutePath("/api/cli/signature-apply")).toBe(true);
    const app = Fastify();
    registerSignatures(app, { store, artifactRoot: await mkdtemp(join(tmpdir(), "sig-")), routeOptions: {} });
    registerSignatureAgentRoutes(app, { store, requireBridge: async (request, reply) => {
      if (request.headers["x-test-token"] !== "pane") { await reply.code(401).send({ error: "bridge token required" }); return null; }
      return { claims: { roomId: "room:a", paneId: "pane:x" } };
    } });
    const body = { artifactId: artifact.id, title: "Claim", placements: [{ page: 1, x: 1, y: 1, width: 10 }] };
    expect((await app.inject({ method: "POST", url: "/api/cli/signature-requests", payload: body })).statusCode).toBe(401);
    const made = await app.inject({ method: "POST", url: "/api/cli/signature-requests", payload: body, headers: { "x-test-token": "pane" } });
    expect(made.statusCode).toBe(200);
    expect(made.json().request).toMatchObject({ artifactId: artifact.id, paneId: "pane:x", status: "PENDING" });
    expect((await app.inject({ method: "POST", url: "/api/cli/signature-apply", payload: { artifactId: artifact.id, placements: body.placements } })).statusCode).toBe(401);
    await app.close();
  });
});

describe("saved signatures (nous_msg:781819c5ba0440fbbee8682c)", () => {
  async function setup() {
    const store = new InMemorySpaceStore();
    const owner = "user:operator";
    store.upsertUser({ id: owner, email: "op@space.local", role: "ADMIN" } as never);
    const room = store.createRoom({ name: "Work", initialPaneCount: 0 }, undefined, owner);
    const artifactRoot = await mkdtemp(join(tmpdir(), "sig-lib-"));
    const app = Fastify();
    app.addHook("onRequest", async (request) => {
      request.user = { id: owner, email: "op@space.local", role: "ADMIN" } as never;
      (request as { requestIdForSpace?: string }).requestIdForSpace = "trace:signature-test";
    });
    const service = registerSignatures(app, { store, artifactRoot, routeOptions: {} });
    return { store, owner, room, artifactRoot, app, service };
  }

  it("keeps many signatures with one default, each also an Agent File in Signatures, and deletes one with its file", async () => {
    const { store, app } = await setup();
    const first = (await app.inject({ method: "POST", url: "/api/signatures", payload: { png: png(4, 2).toString("base64"), label: "Full" } })).json().signature;
    const second = (await app.inject({ method: "POST", url: "/api/signatures", payload: { png: png(6, 2).toString("base64") } })).json().signature;
    expect([first.isDefault, second.isDefault, second.label]).toEqual([true, false, "Signature 2"]);
    const listed = (await app.inject({ method: "GET", url: "/api/signatures" })).json().signatures as Array<{ id: string; artifactId: string; isDefault: boolean }>;
    expect(listed.map((item) => item.id)).toEqual([first.id, second.id]);
    const files = listed.map((item) => store.getArtifact(item.artifactId));
    expect(files.map((file) => [file.metadata.folder, file.mimeType])).toEqual([["Signatures", "image/png"], ["Signatures", "image/png"]]);
    expect((await app.inject({ method: "PATCH", url: `/api/signatures/${second.id}`, payload: { isDefault: true, label: "Initials" } })).json().signature).toMatchObject({ isDefault: true, label: "Initials" });
    expect((await app.inject({ method: "GET", url: "/api/signature" })).json().signature).toMatchObject({ width: 6, height: 2 });
    expect((await app.inject({ method: "DELETE", url: `/api/signatures/${second.id}` })).json()).toEqual({ deleted: true });
    const left = (await app.inject({ method: "GET", url: "/api/signatures" })).json().signatures;
    expect(left).toMatchObject([{ id: first.id, isDefault: true }]);
    expect(() => store.getArtifact(listed[1]!.artifactId)).toThrow("was not found");
    await app.close();
  });

  it("gives a signature without its Agent File (the one migration 0302 moved over) its copy when listed", async () => {
    const { store, owner, app, service } = await setup();
    const moved = await service.repository.addSignature(owner, png(), { width: 4, height: 2 }, { label: "Signature" });
    expect(moved.artifactId).toBeNull();
    const [listed] = (await app.inject({ method: "GET", url: "/api/signatures" })).json().signatures;
    expect(store.getArtifact(listed.artifactId).metadata.folder).toBe("Signatures");
    await app.close();
  });

  it("stamps the signature picked for each spot (a saved one or the one drawn now) and keeps a drawn one only when asked", async () => {
    const { store, owner, room, artifactRoot, app, service } = await setup();
    const doc = await pdf(2);
    const record = await persistAgentFile({ store, artifactRoot, roomId: room.id, paneId: null, cliSessionId: null, runtimeId: "test", originalFilename: "claim.pdf",
      declaredMimeType: "application/pdf", buffer: doc, traceId: "trace:t" });
    const full = await service.saveSignature(owner, { png: png(4, 2).toString("base64"), label: "Full" });
    const initials = await service.saveSignature(owner, { png: png(2, 2).toString("base64"), label: "Initials" });
    const placements = [{ page: 1, x: 10, y: 10, width: 100 }, { page: 2, x: 10, y: 10, width: 40 }];
    /** The pixel width of the signature image on each page of the signed copy (the test PNGs differ only in width). */
    const signedWith = async (body: Record<string, unknown>): Promise<number[] | number> => {
      const response = await app.inject({ method: "POST", url: `/api/artifacts/${record.artifact.id}/sign`, payload: { placements, ...body } });
      if (response.statusCode !== 200) return response.statusCode;
      const signed = await PDFDocument.load(await readFile(localArtifactFilePath({ artifactRoot, artifact: response.json().artifact })));
      return signed.getPages().map((page) => {
        const images = page.node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
        return (images.values() as PDFRef[]).map((ref) => (signed.context.lookup(ref) as PDFRawStream).dict.lookup(PDFName.of("Width"), PDFNumber).asNumber())[0]!;
      });
    };
    expect(await signedWith({})).toEqual([4, 4]);
    expect(await signedWith({ spotSignatures: [full.id, initials.id] })).toEqual([4, 2]);
    expect(await signedWith({ png: png(8, 2).toString("base64"), remember: false, spotSignatures: [full.id, "drawn"] })).toEqual([4, 8]);
    expect((await service.signatures(owner)).map((item) => item.label)).toEqual(["Full", "Initials"]);
    expect(await signedWith({ png: png(8, 2).toString("base64"), label: "Short" })).toEqual([8, 8]);
    expect((await service.signatures(owner)).map((item) => item.label)).toEqual(["Full", "Initials", "Short"]);
    expect(await signedWith({ spotSignatures: [full.id] })).toBeGreaterThanOrEqual(400);
    await app.close();
  });
});
