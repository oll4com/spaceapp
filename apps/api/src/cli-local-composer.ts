import { createHash } from "node:crypto";
import { z } from "zod";
import { idSchema } from "@space/contracts";
import type { ControlRecord, ControlRepository } from "@space/db";
import { SpaceConflictError } from "@space/runtime";

// Only text, tabs and newlines can enter a bracketed paste. In particular an
// embedded ESC must never terminate the paste and turn the remainder into keys.
const unsafeTextControl = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
export const cliLocalComposerSubmissionSchema = z.object({
  submissionId: z.string().uuid(),
  expectedSessionId: idSchema,
  text: z.string().max(200_000).refine(value => !unsafeTextControl.test(value), "The text contains terminal control characters."),
  imagePaths: z.array(z.string().min(2).max(1_000).startsWith("/")
    .refine(value => !/[\u0000-\u001f\u007f-\u009f]/.test(value), "An image path contains control characters.")).max(8).optional()
}).strict().refine(value => value.text.trim().length > 0 || (value.imagePaths?.length ?? 0) > 0,
  "Write a message or attach an image before sending.");

export type CliLocalComposerSubmission = z.infer<typeof cliLocalComposerSubmissionSchema>;
export interface CliLocalComposerReceipt {
  submissionId: string;
  sessionId: string | null;
  status: "SENT" | "UNCERTAIN" | "REJECTED" | "NOT_FOUND";
  reason?: string;
}

export const cliLocalComposerRecordKind = "cli_composer_submission";
const storedReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  submissionId: z.string().uuid(),
  paneId: idSchema,
  sessionId: idSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["DISPATCHING", "SENT", "UNCERTAIN", "REJECTED"]),
  reason: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});
type StoredReceipt = z.infer<typeof storedReceiptSchema>;
type Identity = { ownerUserId: string; paneId: string; roomId: string };
const uncertainReason = "Delivery could not be confirmed. Check the CLI before sending this draft again.";
const recordKey = (paneId: string, submissionId: string) => JSON.stringify([paneId, submissionId]);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function readStored(record: ControlRecord): StoredReceipt {
  const result = storedReceiptSchema.safeParse(record.value);
  if (!result.success) throw new SpaceConflictError("The saved composer receipt could not be verified. Keep your draft and check the CLI.");
  return result.data;
}

function receipt(stored: StoredReceipt): CliLocalComposerReceipt {
  const status = stored.status === "DISPATCHING" ? "UNCERTAIN" : stored.status;
  return { submissionId: stored.submissionId, sessionId: stored.sessionId, status,
    ...(status === "UNCERTAIN" ? { reason: uncertainReason } : stored.reason ? { reason: stored.reason } : {}) };
}

/**
 * A durable at-most-once dispatch receipt, independent of the HTTP connection.
 * The host's bounded in-memory input deduplication is additional protection,
 * never permission to replay an incomplete receipt after an API/host restart.
 * Only hashes are stored here; the browser retains the complete recovery draft.
 */
export function createCliLocalComposerService(deps: {
  repository: ControlRepository;
  serialize: <T>(sessionId: string, work: () => Promise<T>) => Promise<T>;
  sendInput: (sessionId: string, data: string, traceId: string, key: string) => Promise<unknown>;
  wait?: (ms: number) => Promise<void>;
}) {
  const { repository } = deps;
  const wait = deps.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  return {
    async get(identity: Pick<Identity, "ownerUserId" | "paneId">, submissionId: string): Promise<CliLocalComposerReceipt> {
      const record = await repository.get(cliLocalComposerRecordKind, identity.ownerUserId, recordKey(identity.paneId, submissionId));
      if (!record) return { submissionId, sessionId: null, status: "NOT_FOUND" };
      const stored = readStored(record);
      if (stored.paneId !== identity.paneId || stored.submissionId !== submissionId)
        throw new SpaceConflictError("The saved composer receipt does not match this draft.");
      return receipt(stored);
    },

    async submit(identity: Identity, input: CliLocalComposerSubmission, attempt: {
      traceId: string;
      /** Must recheck pane ownership, active NORMAL session/generation and HTTP control lease. */
      assertCurrent: () => Promise<void>;
    }): Promise<CliLocalComposerReceipt> {
      const parsed = cliLocalComposerSubmissionSchema.parse(input);
      const key = recordKey(identity.paneId, parsed.submissionId);
      const contentHash = hash([parsed.expectedSessionId, parsed.text, parsed.imagePaths ?? []]);
      // Same-pane submissions cannot interleave, including across API processes.
      // A timed-out lock can expose DISPATCHING, which is still never retried.
      return repository.withLock(`cli-local-composer:${identity.ownerUserId}:${identity.paneId}`, async () => {
        const existing = await repository.get(cliLocalComposerRecordKind, identity.ownerUserId, key);
        if (existing) {
          const stored = readStored(existing);
          if (stored.paneId !== identity.paneId || stored.submissionId !== parsed.submissionId ||
              stored.sessionId !== parsed.expectedSessionId || stored.contentHash !== contentHash)
            throw new SpaceConflictError("This submission ID already belongs to a different composer draft or CLI session.");
          return receipt(stored);
        }

        const now = new Date().toISOString();
        const stored: StoredReceipt = { schemaVersion: 1, submissionId: parsed.submissionId, paneId: identity.paneId,
          sessionId: parsed.expectedSessionId, contentHash, status: "DISPATCHING", createdAt: now, updatedAt: now };
        const record: ControlRecord = { kind: cliLocalComposerRecordKind, actorId: identity.ownerUserId,
          key, roomId: identity.roomId, version: 0, value: stored };
        // This must finish before queuing or performing any terminal side effect.
        if (!await repository.write(record, 0)) throw new SpaceConflictError("The composer receipt changed. Check its status before sending again.");

        let mayHaveWritten = false;
        let result: StoredReceipt;
        try {
          await deps.serialize(parsed.expectedSessionId, async () => {
            const hostKey = `local-composer:${hash([identity.ownerUserId, identity.paneId, parsed.submissionId])}`;
            const paste = async (text: string, step: string) => {
              await attempt.assertCurrent();
              // An input error can follow host acceptance: from here on only
              // UNCERTAIN is safe, even if no acknowledgement reaches the API.
              mayHaveWritten = true;
              await deps.sendInput(parsed.expectedSessionId, `\u001b[200~${text}\u001b[201~`, attempt.traceId, `${hostKey}:${step}`);
              await wait(200);
            };
            for (const [index, path] of (parsed.imagePaths ?? []).entries()) await paste(path, `image:${index}`);
            if (parsed.text.length) await paste(parsed.text, "text");
            await attempt.assertCurrent();
            mayHaveWritten = true;
            await deps.sendInput(parsed.expectedSessionId, "\r", attempt.traceId, `${hostKey}:enter`);
          });
          result = { ...stored, status: "SENT", updatedAt: new Date().toISOString() };
        } catch {
          result = { ...stored, status: mayHaveWritten ? "UNCERTAIN" : "REJECTED", updatedAt: new Date().toISOString(),
            reason: mayHaveWritten ? uncertainReason : "The CLI session or its control changed before delivery. Your draft was not sent." };
        }

        // Never tell the browser to discard its draft unless SENT is durable.
        // A failed completion write leaves the original DISPATCHING tombstone.
        try {
          if (await repository.write({ ...record, version: 1, value: result }, 1)) return receipt(result);
        } catch { /* The durable pre-dispatch receipt remains authoritative. */ }
        return receipt({ ...stored, status: "UNCERTAIN" });
      }, 60_000);
    }
  };
}
