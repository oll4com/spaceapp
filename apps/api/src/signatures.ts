import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { z } from "zod";
import {
  isAgentFileArtifact, NEEDS_YOU_GO_NOW, SIGNATURE_DRAWN, SIGNATURE_PNG_MAX_BYTES, signatureAgentApplySchema, signatureApplySchema, signatureCreateSchema, signatureRequestCreateSchema,
  signatureSignSchema, signatureUpdateSchema, signerDetailsSchema, type Artifact, type NotificationRaiseInput, type SavedSignature, type SignatureField, type SignaturePlacement,
  type SignatureRequest, type StoredSignature
} from "@space/contracts";
import { InMemorySignaturesRepository, PostgresSignaturesRepository, type SignaturesRepository } from "@space/db";
import { SpaceConflictError, SpaceNotFoundError, makeSpaceId, type SpaceStore } from "@space/runtime";
import { artifactFilename, localArtifactFilePath, permanentlyDeleteLocalArtifact } from "./artifact-storage.js";
import { persistAgentFile } from "./cli-agent-files.js";
import { imageDimensions } from "./design/images.js";
import { withCheckedBlock } from "./nous/pane-notices.js";
import { recordAudit } from "./request-audit.js";
import { parseBody, parseQuery } from "./route-parsing.js";
import { openWorkspacePath } from "./workspace-filesystem.js";

// Signature from the phone (operator 4/11 18:38 BKK «δεν εχω εκτυπωτη», plan clipboard:2qSLIT_csvPm): the owner draws a signature once (stored as a
// transparent PNG, the owner's alone), agents ask for it on a PDF in Agent Files with the spots it goes (space_signature_request), and one signature
// fills every spot. The signed copy is a new Agent File beside the original ("-signed"); the original is never changed. Every use is audited.

type Store = Pick<SpaceStore, "getArtifact" | "getRoom" | "getPane" | "upsertUser" | "recordAuditEvent" | "getActivePaneCliSession"> &
  Partial<Pick<SpaceStore, "getPaneOwner" | "listRooms" | "deleteArtifact">>;
type Who = { by: "OWNER" | "AGENT"; paneId: string | null; requestId?: string };

export type StampText = { page: number; x: number; y: number; size: number; text: string };

/** Stamps a signature at every placement (one PNG for all, or one per placement) and each text at its spot; answers the new PDF's bytes
 * (the input bytes are not changed). */
export async function stampSignature(pdf: Uint8Array, png: Uint8Array | readonly Uint8Array[], placements: readonly SignaturePlacement[], texts: readonly StampText[] = []): Promise<Buffer> {
  let doc: PDFDocument;
  try { doc = await PDFDocument.load(pdf); }
  catch (error) { throw new SpaceConflictError(`The PDF could not be opened for signing (${error instanceof Error ? error.message : "unreadable"}).`); }
  const perSpot = Array.isArray(png) ? png as readonly Uint8Array[] : placements.map(() => png as Uint8Array);
  if (perSpot.length !== placements.length) throw new SpaceConflictError(`${perSpot.length} signatures were given for ${placements.length} spots.`);
  const images = new Map<Uint8Array, Awaited<ReturnType<PDFDocument["embedPng"]>>>();
  const pages = doc.getPages();
  for (const [index, spot] of placements.entries()) {
    const page = pages[spot.page - 1];
    if (!page) throw new SpaceConflictError(`Page ${spot.page} does not exist: the PDF has ${pages.length} page${pages.length === 1 ? "" : "s"}.`);
    const bytes = perSpot[index]!;
    const image = images.get(bytes) ?? await doc.embedPng(bytes);
    images.set(bytes, image);
    page.drawImage(image, { x: spot.x, y: spot.y, width: spot.width, height: spot.width * image.height / image.width });
  }
  const written = texts.filter((item) => item.text.trim());
  // shortcut: Helvetica (WinAnsi) writes Latin text only (phones, dates, names in Latin letters); embed a Unicode font (fontkit) when a form needs Greek.
  const font = written.length ? await doc.embedFont(StandardFonts.Helvetica) : null;
  for (const item of written) {
    const page = pages[item.page - 1];
    if (!page) throw new SpaceConflictError(`Page ${item.page} does not exist: the PDF has ${pages.length} page${pages.length === 1 ? "" : "s"}.`);
    try { page.drawText(item.text, { x: item.x, y: item.y, size: item.size, font: font! }); }
    catch { throw new SpaceConflictError(`"${item.text}" has characters the PDF's standard font cannot write; use Latin letters, digits and + ( ) . / -.`); }
  }
  return Buffer.from(await doc.save());
}

/** A drawn signature from base64 (a data: URL or bare): a PNG of sane size, else refused. */
export function decodeSignaturePng(value: string): { png: Buffer; width: number; height: number } {
  const png = Buffer.from(value.replace(/^data:image\/png;base64,/, ""), "base64");
  const size = png.length <= SIGNATURE_PNG_MAX_BYTES && png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? imageDimensions(png) : null;
  // Technical: pdf-lib decodes the whole bitmap; past 4000 pixels a side it is no hand signature.
  if (!size || size.width < 1 || size.height < 1 || size.width > 4000 || size.height > 4000) throw new SpaceConflictError("The signature must be a PNG image up to 1 MB and 4000 pixels a side.");
  return { png, ...size };
}

/** Each field's text: the owner's confirmed value, else the agent's, else the saved phone (PHONE) or today's date (DATE). */
export function signatureFieldTexts(fields: readonly SignatureField[], values: readonly string[] | undefined, defaults: { phone: string | null; today: string }): StampText[] {
  return fields.map((field, index) => ({ page: field.page, x: field.x, y: field.y, size: field.size,
    text: values?.[index] ?? field.value ?? (field.kind === "PHONE" ? defaults.phone ?? "" : field.kind === "DATE" ? defaults.today : "") }));
}
const today = () => new Date().toISOString().slice(0, 10).split("-").reverse().join(".");

export const signatureNeedsYouKey = (requestId: string) => `signature:${requestId}`;
/** Agent Files' folder holding a PNG copy of every saved signature (operator 6/11 «να βλέπω τις υπογραφές και στο agent files»). */
export const SIGNATURES_FOLDER = "Signatures";
const signedName = (artifact: Artifact) => `${artifactFilename(artifact).replace(/\.pdf$/i, "")}-signed.pdf`;
const isPdf = (artifact: Artifact) => artifact.mimeType.toLowerCase() === "application/pdf" || /\.pdf$/i.test(artifactFilename(artifact));

export interface SignatureDeps {
  store: Store;
  artifactRoot: string;
  repository?: SignaturesRepository;
  databaseUrl?: string | null;
  publish?: (event: unknown) => void;
  notifications?: { raise(input: NotificationRaiseInput, options?: { realert?: boolean }): Promise<unknown>; resolve(owner: string, dedupeKey: string, reason?: string): Promise<unknown> };
  /** Nous's inbox: one line per signed document, so Nous knows even when the pane could not be told. */
  notice?: (owner: string, key: string, line: string) => Promise<unknown> | unknown;
  /** Types a line into the asking pane when its prompt is free; refused (thrown) otherwise. */
  tellPane?: (pane: { id: string; roomId: string }, text: string) => Promise<void>;
  log?: { warn(details: unknown, message: string): void };
}

/** A store read that may throw synchronously (in-memory) or reject: null either way. */
const orNull = async <T>(read: () => T | Promise<T>): Promise<T | null> => { try { return await read(); } catch { return null; } };

export function createSignatureService(deps: SignatureDeps) {
  const { store } = deps;
  const repository = deps.repository ?? (deps.databaseUrl ? PostgresSignaturesRepository.fromConnectionString(deps.databaseUrl) : new InMemorySignaturesRepository());

  /** A PDF in Agent Files of one of the owner's rooms; anything else reads as not found. */
  async function ownedPdf(owner: string, artifactId: string): Promise<Artifact> {
    const artifact = await orNull(() => store.getArtifact(artifactId));
    const room = artifact?.roomId ? await orNull(() => store.getRoom(artifact.roomId!)) : null;
    if (!artifact || artifact.deletedAt || !isAgentFileArtifact(artifact) || room?.ownerUserId !== owner) throw new SpaceNotFoundError(`Agent File ${artifactId} was not found.`);
    if (!isPdf(artifact)) throw new SpaceConflictError(`${artifactFilename(artifact)} is not a PDF; only PDFs can be signed.`);
    return artifact;
  }

  async function sign(owner: string, artifact: Artifact, png: Buffer | readonly Buffer[], placements: readonly SignaturePlacement[], who: Who, traceId: string, texts: readonly StampText[] = []) {
    const handle = await openWorkspacePath(deps.artifactRoot, localArtifactFilePath({ artifactRoot: deps.artifactRoot, artifact }));
    const original = await (async () => { try { return await handle.readFile(); } finally { await handle.close(); } })();
    const bytes = await stampSignature(original, png, placements, texts);
    const folder = typeof artifact.metadata?.folder === "string" ? artifact.metadata.folder : undefined;
    const record = await persistAgentFile({ store: store as unknown as SpaceStore, artifactRoot: deps.artifactRoot, roomId: artifact.roomId!, paneId: artifact.paneId ?? null, cliSessionId: null,
      runtimeId: "space-signature", originalFilename: signedName(artifact), declaredMimeType: "application/pdf", buffer: bytes, traceId,
      source: who.by === "OWNER" ? "USER_UPLOAD" : "AGENT_OUTPUT", ...(folder ? { folder } : {}) });
    deps.publish?.(record.event);
    return record.artifact;
  }

  /** The phone the owner confirmed on a PHONE field becomes the one the next signing starts with. */
  async function rememberPhone(owner: string, fields: readonly SignatureField[], texts: readonly StampText[]) {
    const phone = texts.find((_text, index) => fields[index]?.kind === "PHONE")?.text.trim();
    if (phone && signerDetailsSchema.safeParse({ phone }).success && phone !== await repository.getPhone(owner)) await repository.setPhone(owner, phone);
  }

  async function tell(owner: string, request: SignatureRequest, signed: Artifact) {
    const line = `Signature request ${request.id} ("${request.title}") is signed: ${signed.id} (${artifactFilename(signed)}), stamped at ${request.placements.length} spot${request.placements.length === 1 ? "" : "s"}.`;
    await Promise.resolve(deps.notice?.(owner, `signature-signed:${request.id}`, `${line}${request.paneId ? ` Asked by pane ${request.paneId}.` : ""}`))
      .catch((error: unknown) => deps.log?.warn({ err: error }, "The signature notice for Nous failed."));
    if (request.paneId && request.roomId && deps.tellPane) {
      await deps.tellPane({ id: request.paneId, roomId: request.roomId }, line)
        .catch((error: unknown) => deps.log?.warn({ err: error, paneId: request.paneId }, "The asking pane was not told about its signed document (Nous was)."));
    }
  }

  /** A saved signature's PNG copy in Agent Files › Signatures, in the owner's first workspace room (the dock lists every room). */
  async function fileCopy(owner: string, saved: SavedSignature, png: Buffer): Promise<SavedSignature> {
    const rooms = (await orNull(() => store.listRooms?.(owner))) ?? [];
    const room = rooms.filter((item) => item.kind === "WORKSPACE" && !item.archivedAt).sort((a, b) => a.order - b.order)[0];
    if (!room) return saved;
    // shortcut: the copy keeps the name it was saved with; a rename shows in the library and the picker only. Rename the file too if the operator asks.
    const record = await persistAgentFile({ store: store as unknown as SpaceStore, artifactRoot: deps.artifactRoot, roomId: room.id, paneId: null, cliSessionId: null,
      runtimeId: "space-signature", originalFilename: `${saved.label}.png`, declaredMimeType: "image/png", buffer: png, traceId: makeSpaceId("trace"), source: "USER_UPLOAD",
      folder: SIGNATURES_FOLDER });
    deps.publish?.(record.event);
    return await repository.updateSignature(owner, saved.id, { artifactId: record.artifact.id }) ?? saved;
  }
  const hasFile = async (saved: SavedSignature) => {
    const artifact = saved.artifactId ? await orNull(() => store.getArtifact(saved.artifactId!)) : null;
    return Boolean(artifact && !artifact.deletedAt);
  };
  const listing = new Map<string, Promise<SavedSignature[]>>();
  async function saveDrawn(owner: string, drawn: { png: Buffer; width: number; height: number }, input: { label?: string | undefined; isDefault?: boolean | undefined }) {
    const count = (await repository.listSignatures(owner)).length;
    const saved = await repository.addSignature(owner, drawn.png, drawn, { label: input.label ?? `Signature ${count + 1}`, isDefault: input.isDefault });
    return fileCopy(owner, saved, drawn.png).catch((error: unknown) => { deps.log?.warn({ err: error }, "The signature's Agent File copy failed."); return saved; });
  }

  return {
    repository,
    /** Every saved signature; one without its Agent File copy (the one 0302 moved over, a deleted file) gets it again. */
    signatures(owner: string): Promise<SavedSignature[]> {
      // Settings and the Sign view may list at once: one listing per owner at a time, so a copy is made once.
      const running = listing.get(owner);
      if (running) return running;
      const run = (async () => Promise.all((await repository.listSignatures(owner)).map(async (saved) => {
        if (await hasFile(saved)) return saved;
        const row = await repository.getSignature(owner, saved.id);
        return row ? fileCopy(owner, saved, row.png).catch((error: unknown) => { deps.log?.warn({ err: error }, "The signature's Agent File copy failed."); return saved; }) : saved;
      })))().finally(() => listing.delete(owner));
      listing.set(owner, run);
      return run;
    },
    /** The default one's size (the routes before the library). */
    async signature(owner: string): Promise<StoredSignature | null> {
      const row = await repository.getSignature(owner);
      return row ? { width: row.width, height: row.height, updatedAt: row.updatedAt } : null;
    },
    signatureImage: async (owner: string, id?: string) => (await repository.getSignature(owner, id))?.png ?? null,
    saveDrawn,
    async saveSignature(owner: string, raw: unknown) {
      const input = signatureCreateSchema.parse(raw);
      return saveDrawn(owner, decodeSignaturePng(input.png), input);
    },
    async updateSignature(owner: string, id: string, raw: unknown) {
      const saved = await repository.updateSignature(owner, id, signatureUpdateSchema.parse(raw));
      if (!saved) throw new SpaceNotFoundError(`Signature ${id} was not found.`);
      return saved;
    },
    /** The owner's explicit delete: the signature and its Agent File copy. */
    async deleteSignature(owner: string, id: string) {
      const deleted = await repository.deleteSignature(owner, id);
      const artifact = deleted?.artifactId ? await orNull(() => store.getArtifact(deleted.artifactId!)) : null;
      if (artifact && !artifact.deletedAt && store.deleteArtifact) {
        await permanentlyDeleteLocalArtifact({ store: store as Pick<SpaceStore, "deleteArtifact">, artifactRoot: deps.artifactRoot, artifact })
          .catch((error: unknown) => deps.log?.warn({ err: error, artifactId: artifact.id }, "A deleted signature's Agent File copy could not be removed."));
      }
      return deleted;
    },
    details: async (owner: string) => ({ phone: await repository.getPhone(owner) }),
    setDetails: async (owner: string, raw: unknown) => { const details = signerDetailsSchema.parse(raw); await repository.setPhone(owner, details.phone || null); return details; },
    async list(owner: string, status?: SignatureRequest["status"], tests = false) {
      const requests = await repository.listRequests(owner, status, tests);
      return Promise.all(requests.map(async (request) => {
        const artifact = await orNull(() => store.getArtifact(request.artifactId));
        return { ...request, document: artifact && !artifact.deletedAt ? { filename: artifactFilename(artifact), folder: typeof artifact.metadata?.folder === "string" ? artifact.metadata.folder : null } : null };
      }));
    },
    /** An agent's request: the PDF must be the owner's; one Needs you card opens the signing view. */
    async request(owner: string, pane: { id: string; roomId: string; title: string }, raw: unknown) {
      const input = signatureRequestCreateSchema.parse(raw);
      const artifact = await ownedPdf(owner, input.artifactId);
      // nous_msg:781819c5ba0440fbbee8682c: App Studio's Android test held the operator's Sign badge at 1; a test never waits for them.
      const test = (await orNull(() => store.getPane(pane.id)))?.mode === "APP_STUDIO" || (await orNull(() => store.getRoom(pane.roomId)))?.kind === "AGENT_PROOF";
      const request = await repository.createRequest(owner, { ...input, roomId: pane.roomId, paneId: pane.id, test });
      if (!test) await deps.notifications?.raise({ ownerUserId: owner, roomId: pane.roomId, paneId: pane.id, source: "AGENT", kind: "NEEDS_YOU", severity: "ATTENTION",
        title: `Sign: ${input.title}`.slice(0, 200),
        body: withCheckedBlock([`${pane.title} asks for your signature on ${artifactFilename(artifact)} (${input.placements.length} spot${input.placements.length === 1 ? "" : "s"}, pages ${[...new Set(input.placements.map((spot) => spot.page))].join(", ")}).`,
          input.fields?.length ? `It also needs: ${input.fields.map((field) => field.label).join(", ")} (you can check and change them before you sign).` : null,
          input.note ?? null, "Open signs it in Agent Files: one signature fills every spot, and the signed copy is saved beside the original."].filter(Boolean).join("\n\n"),
          [`Agent Files: ${artifactFilename(artifact)} prepared by ${pane.title}, ready to sign`, "Signature: only the operator can sign it"], 2_000),
        link: { roomId: pane.roomId, paneId: pane.id, surface: "agent-files", target: `sign:${request.id}` }, dedupeKey: signatureNeedsYouKey(request.id), telegram: null,
        payload: { signatureRequestId: request.id, artifactId: artifact.id,
          ask: { question: `Sign ${input.title}`.slice(0, 300), options: [NEEDS_YOU_GO_NOW, "Failed", "Need links/steps"], recommended: NEEDS_YOU_GO_NOW, answer: { kind: "PANE" } } } },
      { realert: true }).catch((error: unknown) => deps.log?.warn({ err: error }, "The signature request card could not be raised."));
      return { request, document: { artifactId: artifact.id, filename: artifactFilename(artifact) } };
    },
    async signRequest(owner: string, id: string, png: Buffer | readonly Buffer[], traceId: string, fieldValues?: readonly string[], remember = true) {
      const request = await repository.getRequest(owner, id);
      if (!request) throw new SpaceNotFoundError(`Signature request ${id} was not found.`);
      if (request.status !== "PENDING") throw new SpaceConflictError(`Signature request ${id} is already ${request.status.toLowerCase()}.`);
      const texts = signatureFieldTexts(request.fields, fieldValues, { phone: await repository.getPhone(owner), today: today() });
      const signed = await sign(owner, await ownedPdf(owner, request.artifactId), png, request.placements, { by: "OWNER", paneId: request.paneId, requestId: id }, traceId, texts);
      if (remember) await rememberPhone(owner, request.fields, texts);
      const done = await repository.finishRequest(owner, id, { status: "SIGNED", signedArtifactId: signed.id });
      if (!done) throw new SpaceConflictError(`Signature request ${id} changed while it was signed; the signed copy ${signed.id} is in Agent Files.`);
      await deps.notifications?.resolve(owner, signatureNeedsYouKey(id), "signed").catch(() => undefined);
      await tell(owner, done, signed);
      return { request: done, artifact: signed };
    },
    async cancel(owner: string, id: string) {
      const done = await repository.finishRequest(owner, id, { status: "CANCELLED" });
      if (!done) throw new SpaceConflictError(`Signature request ${id} is not pending.`);
      await deps.notifications?.resolve(owner, signatureNeedsYouKey(id), "cancelled").catch(() => undefined);
      return done;
    },
    async apply(owner: string, artifactId: string, png: Buffer | readonly Buffer[], placements: readonly SignaturePlacement[], who: Who, traceId: string,
      fields: readonly SignatureField[] = [], fieldValues?: readonly string[], remember = who.by === "OWNER") {
      const texts = signatureFieldTexts(fields, fieldValues, { phone: await repository.getPhone(owner), today: today() });
      const signed = await sign(owner, await ownedPdf(owner, artifactId), png, placements, who, traceId, texts);
      if (remember) await rememberPhone(owner, fields, texts);
      return signed;
    }
  };
}
export type SignatureService = ReturnType<typeof createSignatureService>;

const services = new WeakMap<object, SignatureService>();
export const signaturesFor = (store: object) => services.get(store);

const idParams = z.object({ id: z.string().min(1).max(200) }).strict();
const listQuery = z.object({ status: z.enum(["PENDING", "SIGNED", "CANCELLED"]).optional(), tests: z.literal("include").optional() }).strict();
const saveBody = z.object({ png: signatureSignSchema.shape.png.unwrap() }).strict();

/** The owner's routes (browser session). A broker session (an agent's proof or admin action) never reads, replaces or uses the stored signature. */
export function registerSignatures(app: FastifyInstance, deps: SignatureDeps & { routeOptions: Pick<RouteShorthandOptions, "config"> }) {
  const service = createSignatureService(deps);
  services.set(deps.store, service);
  const { store } = deps;
  const owner = async (request: FastifyRequest) => (await store.upsertUser(request.user!)).id;
  const ownerOnly = (request: FastifyRequest) => {
    if (request.sessionPrincipal) throw new SpaceConflictError("Only the owner, signed in, can use the stored signature.");
  };
  /**
   * The signature on each spot: `spotSignatures` (a saved one's id or "drawn"), else `signatureId` on every spot, else the one drawn now, else
   * the default saved one. A drawn one joins the saved signatures unless remember is false; a broker session only draws, never reads or keeps one.
   */
  async function chosen(request: FastifyRequest, who: string, body: z.infer<typeof signatureSignSchema>, spots: number): Promise<Buffer[]> {
    const drawn = body.png ? decodeSignaturePng(body.png) : null;
    const ids = body.spotSignatures ?? Array.from({ length: spots }, () => body.signatureId ?? (drawn ? SIGNATURE_DRAWN : ""));
    if (ids.length !== spots) throw new SpaceConflictError(`spotSignatures names ${ids.length} signature${ids.length === 1 ? "" : "s"} for ${spots} spot${spots === 1 ? "" : "s"}.`);
    if (ids.some((id) => id !== SIGNATURE_DRAWN)) ownerOnly(request);
    if (drawn && body.remember !== false && !request.sessionPrincipal) await service.saveDrawn(who, drawn, { label: body.label });
    const pngs = new Map<string, Buffer>();
    for (const id of new Set(ids)) {
      if (id === SIGNATURE_DRAWN) {
        if (!drawn) throw new SpaceConflictError("A spot asks for the signature drawn now, but none was drawn.");
        pngs.set(id, drawn.png);
        continue;
      }
      const png = await service.signatureImage(who, id || undefined);
      if (!png) throw new SpaceConflictError(id ? `Signature ${id} was not found.` : "No signature is saved yet: draw it first.");
      pngs.set(id, png);
    }
    return ids.map((id) => pngs.get(id)!);
  }
  const audit = (request: FastifyRequest, targetId: string, metadata: Record<string, unknown>) =>
    recordAudit(store, request, { action: "signature.apply", targetType: "artifact", targetId, metadata });

  const image = (reply: FastifyReply, png: Buffer | null) => {
    if (!png) throw new SpaceNotFoundError("No such signature is saved.");
    return reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff").type("image/png").send(png);
  };
  const remove = async (request: FastifyRequest, who: string, id: string) => {
    const deleted = await service.deleteSignature(who, id);
    await recordAudit(store, request, { action: "signature.delete", targetType: "signature", targetId: id, metadata: { deleted: Boolean(deleted), artifactId: deleted?.artifactId ?? null } });
    return { deleted: Boolean(deleted) };
  };

  // The library (nous_msg:781819c5ba0440fbbee8682c). A broker session sees none: it may not read or use a saved signature, so its Sign view draws one.
  app.get("/api/signatures", deps.routeOptions, async (request) => ({ signatures: request.sessionPrincipal ? [] : await service.signatures(await owner(request)) }));
  app.get("/api/signatures/:id/image", deps.routeOptions, async (request, reply) => {
    ownerOnly(request);
    return image(reply, await service.signatureImage(await owner(request), parseQuery(idParams, request.params).id));
  });
  app.post("/api/signatures", deps.routeOptions, async (request) => {
    ownerOnly(request);
    const who = await owner(request);
    const saved = await service.saveSignature(who, request.body ?? {});
    await recordAudit(store, request, { action: "signature.save", targetType: "signature", targetId: saved.id, metadata: { width: saved.width, height: saved.height, isDefault: saved.isDefault } });
    return { signature: saved };
  });
  app.patch("/api/signatures/:id", deps.routeOptions, async (request) => {
    ownerOnly(request);
    const who = await owner(request);
    const saved = await service.updateSignature(who, parseQuery(idParams, request.params).id, request.body ?? {});
    await recordAudit(store, request, { action: "signature.update", targetType: "signature", targetId: saved.id, metadata: { isDefault: saved.isDefault } });
    return { signature: saved };
  });
  app.delete("/api/signatures/:id", deps.routeOptions, async (request) => {
    ownerOnly(request);
    return remove(request, await owner(request), parseQuery(idParams, request.params).id);
  });
  // The routes before the library, on the default signature: PUT saves a new default (nothing is replaced any more), DELETE deletes the default.
  app.get("/api/signature", deps.routeOptions, async (request) => ({ signature: request.sessionPrincipal ? null : await service.signature(await owner(request)) }));
  app.get("/api/signature/image", deps.routeOptions, async (request, reply) => {
    ownerOnly(request);
    return image(reply, await service.signatureImage(await owner(request)));
  });
  app.put("/api/signature", deps.routeOptions, async (request) => {
    ownerOnly(request);
    const who = await owner(request);
    const saved = await service.saveSignature(who, { png: parseBody(saveBody, request.body ?? {}).png, isDefault: true });
    await recordAudit(store, request, { action: "signature.save", targetType: "signature", targetId: saved.id, metadata: { width: saved.width, height: saved.height, isDefault: true } });
    return { signature: { width: saved.width, height: saved.height, updatedAt: saved.updatedAt } };
  });
  app.delete("/api/signature", deps.routeOptions, async (request) => {
    ownerOnly(request);
    const who = await owner(request);
    const current = await service.repository.getSignature(who);
    return current ? remove(request, who, current.id) : { deleted: false };
  });
  app.get("/api/signature/details", deps.routeOptions, async (request) => ({ details: await service.details(await owner(request)) }));
  app.put("/api/signature/details", deps.routeOptions, async (request) => {
    ownerOnly(request);
    const who = await owner(request);
    const details = await service.setDetails(who, request.body ?? {});
    await recordAudit(store, request, { action: "signature.details", targetType: "signature", targetId: who, metadata: { phone: Boolean(details.phone) } });
    return { details };
  });
  app.get("/api/signature-requests", deps.routeOptions, async (request) => {
    const query = parseQuery(listQuery, request.query ?? {});
    return { requests: await service.list(await owner(request), query.status, query.tests === "include") };
  });
  app.post("/api/signature-requests/:id/sign", deps.routeOptions, async (request) => {
    const who = await owner(request);
    const { id } = parseQuery(idParams, request.params);
    const body = parseBody(signatureSignSchema, request.body ?? {});
    const pending = await service.repository.getRequest(who, id);
    if (!pending) throw new SpaceNotFoundError(`Signature request ${id} was not found.`);
    const result = await service.signRequest(who, id, await chosen(request, who, body, pending.placements.length), request.requestIdForSpace, body.fieldValues, !request.sessionPrincipal);
    await audit(request, result.request.artifactId, { requestId: id, signedArtifactId: result.artifact.id, placements: result.request.placements.length,
      pages: [...new Set(result.request.placements.map((spot) => spot.page))], by: "OWNER", drawnNow: Boolean(body.png), askedBy: result.request.paneId,
      signatures: [...new Set(body.spotSignatures ?? [body.signatureId ?? (body.png ? SIGNATURE_DRAWN : "default")])] });
    return result;
  });
  app.post("/api/signature-requests/:id/cancel", deps.routeOptions, async (request) => {
    const who = await owner(request);
    const done = await service.cancel(who, parseQuery(idParams, request.params).id);
    await recordAudit(store, request, { action: "signature.request.cancel", targetType: "signature_request", targetId: done.id, metadata: { artifactId: done.artifactId } });
    return { request: done };
  });
  // Agent Files' Sign: the spots tapped on the PDF's pages, no request.
  app.post("/api/artifacts/:id/sign", deps.routeOptions, async (request) => {
    const who = await owner(request);
    const { id } = parseQuery(idParams, request.params);
    const body = parseBody(signatureApplySchema, request.body ?? {});
    const artifact = await service.apply(who, id, await chosen(request, who, body, body.placements.length), body.placements, { by: "OWNER", paneId: null }, request.requestIdForSpace,
      body.fields ?? [], body.fieldValues, !request.sessionPrincipal);
    await audit(request, id, { signedArtifactId: artifact.id, placements: body.placements.length, pages: [...new Set(body.placements.map((spot) => spot.page))], by: "OWNER", drawnNow: Boolean(body.png),
      signatures: [...new Set(body.spotSignatures ?? [body.signatureId ?? (body.png ? SIGNATURE_DRAWN : "default")])] });
    return { artifact };
  });
  app.addHook("onClose", () => service.repository.dispose());
  return service;
}

/** space_signature_request and space_signature_apply (MCP space_progress), with the pane's bridge token, as the room's owner. */
export function registerSignatureAgentRoutes(app: FastifyInstance, deps: {
  store: Pick<SpaceStore, "getRoom" | "getPane" | "getPaneOwner" | "upsertUser" | "recordAuditEvent">;
  requireBridge(request: FastifyRequest, reply: FastifyReply): Promise<{ claims: { roomId: string; paneId: string } } | null>;
}) {
  const context = async (request: FastifyRequest, reply: FastifyReply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return null;
    const service = signaturesFor(deps.store);
    if (!service) throw new SpaceConflictError("Signatures are unavailable.");
    const pane = await deps.store.getPane(bridge.claims.paneId);
    const owner = await deps.store.getPaneOwner?.(pane.id) ?? (await deps.store.getRoom(bridge.claims.roomId)).ownerUserId;
    if (!owner) throw new SpaceConflictError("This room has no owner; a signature belongs to a signed-in operator account.");
    return { service, owner, pane };
  };
  const audit = (owner: string, action: string, targetId: string, metadata: Record<string, unknown>) =>
    Promise.resolve(deps.store.recordAuditEvent({ actorUserId: owner, traceId: makeSpaceId("trace"), action, targetType: "artifact", targetId, metadata }));
  app.post("/api/cli/signature-requests", async (request, reply) => {
    const ctx = await context(request, reply);
    if (!ctx) return reply;
    const created = await ctx.service.request(ctx.owner, { id: ctx.pane.id, roomId: ctx.pane.roomId, title: ctx.pane.paneName ?? ctx.pane.title }, request.body ?? {});
    await audit(ctx.owner, "signature.request.create", created.document.artifactId, { requestId: created.request.id, placements: created.request.placements.length, askedBy: ctx.pane.id });
    return { request: created.request, document: created.document, next: "The operator got a Needs you card; you are told here and in Nous's inbox when it is signed." };
  });
  app.post("/api/cli/signature-apply", async (request, reply) => {
    const ctx = await context(request, reply);
    if (!ctx) return reply;
    const input = signatureAgentApplySchema.parse(request.body ?? {});
    const png = await ctx.service.signatureImage(ctx.owner);
    if (!png) throw new SpaceConflictError("The operator has no stored signature yet: ask with space_signature_request instead.");
    const artifact = await ctx.service.apply(ctx.owner, input.artifactId, png, input.placements, { by: "AGENT", paneId: ctx.pane.id }, `trace:${randomUUID()}`);
    await audit(ctx.owner, "signature.apply", input.artifactId, { signedArtifactId: artifact.id, placements: input.placements.length,
      pages: [...new Set(input.placements.map((spot) => spot.page))], by: "AGENT", paneId: ctx.pane.id });
    return { artifact: { id: artifact.id, filename: artifactFilename(artifact) } };
  });
}
