import { z } from "zod";

// The operator's hand signature (operator 4/11 18:38 BKK, plan clipboard:2qSLIT_csvPm: «δεν εχω εκτυπωτη»): drawn once on the phone,
// stamped by Space into every place a PDF in Agent Files needs it. The PNG is the owner's alone: never a public link, every use audited.

/** One spot for the signature, in PDF points (1/72 inch) with PDF's own origin: x from the page's left edge, y from its BOTTOM edge up to
 * the signature's bottom. The height follows the drawn signature's proportions. */
export const signaturePlacementSchema = z.object({
  page: z.number().int().min(1).max(10_000),
  x: z.number().min(0).max(20_000),
  y: z.number().min(0).max(20_000),
  width: z.number().gt(0).max(2_000)
}).strict();
export type SignaturePlacement = z.infer<typeof signaturePlacementSchema>;
// Technical: a placement list is part of one HTTP body; a document needing more spots takes another request.
export const signaturePlacementsSchema = z.array(signaturePlacementSchema).min(1).max(200);

/** A text the document needs beside the signature (the claimant's phone on a court form, the date), written at its spot in PDF points like a
 * placement (`y` is the text's baseline from the page's bottom). PHONE starts as the owner's saved phone, DATE as today; the owner can change both. */
export const SIGNATURE_FIELD_KINDS = ["PHONE", "DATE", "TEXT"] as const;
export const signatureFieldSchema = z.object({
  page: z.number().int().min(1).max(10_000),
  x: z.number().min(0).max(20_000),
  y: z.number().min(0).max(20_000),
  kind: z.enum(SIGNATURE_FIELD_KINDS).default("TEXT"),
  label: z.string().trim().min(1).max(120),
  /** What the agent already knows; the owner sees it and may change it. */
  value: z.string().trim().max(300).nullable().optional(),
  /** Font size in points (Helvetica). */
  size: z.number().min(4).max(72).default(10)
}).strict();
export type SignatureField = z.infer<typeof signatureFieldSchema>;
// Technical: part of one HTTP body, like the placements.
export const signatureFieldsSchema = z.array(signatureFieldSchema).max(200);
/** The values the owner confirmed, one per field in the request's order. */
export const signatureFieldValuesSchema = z.array(z.string().trim().max(300)).max(200);

export const SIGNATURE_REQUEST_STATUSES = ["PENDING", "SIGNED", "CANCELLED"] as const;
export const signatureRequestSchema = z.object({
  id: z.string(),
  ownerUserId: z.string(),
  /** The PDF in Agent Files to sign; the signed copy is a new Agent File beside it. */
  artifactId: z.string(),
  title: z.string(),
  note: z.string().nullable(),
  placements: z.array(signaturePlacementSchema),
  fields: z.array(signatureFieldSchema),
  /** The pane that asked: told when it is signed. */
  roomId: z.string().nullable(),
  paneId: z.string().nullable(),
  status: z.enum(SIGNATURE_REQUEST_STATUSES),
  /** Asked by an App Studio pane or in an Agent Proof room: never in the operator's list, badge or Needs you (nous_msg:781819c5ba0440fbbee8682c). */
  test: z.boolean(),
  signedArtifactId: z.string().nullable(),
  signedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type SignatureRequest = z.infer<typeof signatureRequestSchema>;

export const signatureRequestCreateSchema = z.object({
  artifactId: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(300),
  note: z.string().trim().max(2_000).nullable().optional(),
  placements: signaturePlacementsSchema,
  fields: signatureFieldsSchema.optional()
}).strict();
export type SignatureRequestCreate = z.infer<typeof signatureRequestCreateSchema>;

/** A drawn signature: a PNG (transparent background) as base64, with or without its `data:image/png;base64,` prefix. */
// Technical: a phone's canvas at 3x of a 360-pixel pad is well under 1 MB of PNG; the cap keeps a stored signature from carrying a payload.
export const SIGNATURE_PNG_MAX_BYTES = 1024 * 1024;
export const signaturePngSchema = z.string().trim().min(1).max(Math.ceil(SIGNATURE_PNG_MAX_BYTES * 4 / 3) + 64);

/** "drawn" in `spotSignatures`: the signature drawn with this signing (`png`). */
export const SIGNATURE_DRAWN = "drawn" as const;
export const signatureLabelSchema = z.string().trim().min(1).max(80);
/**
 * Sign a request. Which signature goes on each spot (nous_msg:781819c5ba0440fbbee8682c): `spotSignatures` names one per placement (a saved
 * signature's id or "drawn"), else `signatureId` fills every spot, else the one drawn now (`png`), else the default saved one. A drawn `png`
 * joins the saved signatures (under `label`) unless `remember` is false.
 */
export const signatureSignSchema = z.object({
  png: signaturePngSchema.optional(), remember: z.boolean().optional(), label: signatureLabelSchema.optional(), fieldValues: signatureFieldValuesSchema.optional(),
  signatureId: z.string().trim().min(1).max(100).optional(),
  spotSignatures: z.array(z.string().trim().min(1).max(100)).max(200).optional()
}).strict();
/** Sign a PDF of Agent Files directly at the spots tapped on its pages (no request). */
export const signatureApplySchema = signatureSignSchema.extend({ placements: signaturePlacementsSchema, fields: signatureFieldsSchema.optional() }).strict();
/** An agent's space_signature_apply: the stored signature only. */
export const signatureAgentApplySchema = z.object({ artifactId: z.string().trim().min(1).max(200), placements: signaturePlacementsSchema }).strict();

export const storedSignatureSchema = z.object({ width: z.number().int(), height: z.number().int(), updatedAt: z.string() });
/** One of the owner's saved signatures (many per owner; one is the default). Its PNG: GET /api/signatures/:id/image; its Agent File copy in
 * Agent Files › Signatures: `artifactId`. */
export const savedSignatureSchema = z.object({
  id: z.string(), label: z.string(), width: z.number().int(), height: z.number().int(), isDefault: z.boolean(), artifactId: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string()
});
export type SavedSignature = z.infer<typeof savedSignatureSchema>;
export const signatureCreateSchema = z.object({ png: signaturePngSchema, label: signatureLabelSchema.optional(), isDefault: z.boolean().optional() }).strict();
/** Rename it, or make it the default (`isDefault: true`; another becomes the default only by being chosen). */
export const signatureUpdateSchema = z.object({ label: signatureLabelSchema.optional(), isDefault: z.literal(true).optional() }).strict();
/** The owner's signer details: the phone a PHONE field starts with (saved from the last signing, or set here). */
export const signerDetailsSchema = z.object({ phone: z.string().trim().max(40).regex(/^[+0-9 ()./-]*$/, "digits, spaces and + ( ) . / - only").nullable() }).strict();
export type SignerDetails = z.infer<typeof signerDetailsSchema>;
export type StoredSignature = z.infer<typeof storedSignatureSchema>;
