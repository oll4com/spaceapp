import { createPublicKey, verify } from "node:crypto";
import type { FastifyRequest } from "fastify";
import {
  isAgentFileArtifact, mobileAdminOpSigningInput, mobileAnswerSigningInput, mobileAskContentHash, mobileDecisionContentHash, mobileGoalContentHash, mobileIntegrityRequestHash, needsYouAsk, needsYouAskRisk,
  type Artifact, type MobileRouteRule,
  type SpaceNotification
} from "@space/contracts";
import type { AppDeviceSessionRepository } from "@space/db";
import { MOBILE_INTEGRITY_HEADER, type PlayIntegrity } from "./integrity.js";

// The per-request checks a phone's request passes before its handler (plan clipboard:kTV3y2lwO-99 phase 1b-5c, ADR-013 §6-7, design §6.2,
// §7): an artifact by id only from Agent Files (security review P1-4); a needs-you answer whose ask's risk is not NONE (`needsYouAskRisk`:
// the producer's, else by where the answer goes, P1-2) and a RELEASE, DESTRUCTIVE or EXTERNAL decision need `decide` and the device's
// signature over what it showed; so does a goal's delete (C9) and an ADMIN operation (Nous settings' ops, nous_msg:7f3a38f5).

export const MOBILE_SIG_HEADER = "x-space-mobile-sig";
const SIGNED_CATEGORIES = new Set(["RELEASE", "DESTRUCTIVE", "EXTERNAL"]);
export type MobileCheckRefusal = { status: number; code: string; message: string };
type Decision = Parameters<typeof mobileDecisionContentHash>[0];

export function createMobileChecks(deps: {
  devices: Pick<AppDeviceSessionRepository, "list">;
  artifact: (id: string) => Promise<Artifact>;
  notification: (owner: string, id: string) => Promise<SpaceNotification | null>;
  /** An open Nous decision of the owner, or null. */
  decision: (owner: string, id: string) => Promise<Decision | null>;
  /** The owner's goal, or null (C9: its delete is signed). */
  goal: (owner: string, id: string) => Promise<{ id: string; text: string } | null>;
  /** Play Integrity on every signed answer (MASVS L2); null or absent: not configured, the signature alone decides. */
  integrity?: PlayIntegrity | null;
}) {
  const refuse = (status: number, code: string, message: string): MobileCheckRefusal => ({ status, code, message });
  /** The device's decide signature over these bytes, or why not. */
  async function signed(request: FastifyRequest, input: Uint8Array): Promise<MobileCheckRefusal | null> {
    const phone = request.mobileDevice!;
    if (!phone.scopes.includes("decide")) return refuse(403, "MOBILE_DECIDE_REQUIRED", "Answer this on a computer, or allow this phone to decide.");
    const device = (await deps.devices.list(request.user!.id)).find((row) => row.id === phone.id);
    const sig = request.headers[MOBILE_SIG_HEADER];
    if (!device?.decidePublicSpki || typeof sig !== "string") return refuse(403, "DECIDE_SIGNATURE", "This answer needs your fingerprint on the phone.");
    const key = createPublicKey({ key: Buffer.from(device.decidePublicSpki, "base64url"), format: "der", type: "spki" });
    // shortcut: one code for a changed item and a bad signature (the request does not carry the hash it signed); the app refreshes either way.
    if (!verify("sha256", input, { key, dsaEncoding: "der" }, Buffer.from(sig, "base64url"))) {
      return refuse(403, "DECIDE_SIGNATURE", "It changed since you saw it, or the signature is not this phone's; refresh and answer again.");
    }
    const token = request.headers[MOBILE_INTEGRITY_HEADER];
    const integrity = deps.integrity
      ? await deps.integrity.verify({ token: typeof token === "string" ? token : undefined, app: device.app, requestHash: mobileIntegrityRequestHash("decide", input) }) : null;
    return integrity && !integrity.ok ? refuse(403, "PLAY_INTEGRITY", `Google Play could not vouch for this app or phone (${integrity.reason}); answer on a computer.`) : null;
  }
  return async (request: FastifyRequest, rule: MobileRouteRule): Promise<MobileCheckRefusal | null> => {
    const owner = request.user!.id;
    const id = (request.params as { id?: string }).id ?? "";
    if (rule.artifactById) {
      const artifact = await deps.artifact(id).catch(() => null);
      return artifact && isAgentFileArtifact(artifact) ? null : refuse(403, "MOBILE_SCOPE_DENIED", "A phone opens Agent Files only.");
    }
    if (rule.askRisk) {
      const notification = await deps.notification(owner, id);
      if (!notification || needsYouAskRisk(notification) === "NONE") return null;
      const ask = needsYouAsk(notification);
      return signed(request, mobileAnswerSigningInput("ask", id, mobileAskContentHash({ id, question: ask.question, options: ask.options, recommended: ask.recommended, body: notification.body }), request.body));
    }
    if (rule.decisionSignature) {
      const decision = await deps.decision(owner, id);
      return decision && SIGNED_CATEGORIES.has(decision.category) ? signed(request, mobileAnswerSigningInput("decide", id, mobileDecisionContentHash(decision), request.body)) : null;
    }
    if (rule.goalSignature) {
      const goal = await deps.goal(owner, id);
      // Fail closed (Nous 16855): a goal the lookup cannot find is never deleted from a phone unsigned.
      return goal ? signed(request, mobileAnswerSigningInput("goal-delete", id, mobileGoalContentHash(goal), "delete")) : refuse(404, "NOT_FOUND", "This goal is gone; refresh.");
    }
    if (rule.adminSignature) {
      if (request.user!.role !== "ADMIN") return refuse(403, "ADMIN_REQUIRED", "Only an administrator runs this.");
      return signed(request, mobileAdminOpSigningInput(request.method, request.url.split("?", 1)[0]!, request.body));
    }
    return null;
  };
}
export type MobileChecks = ReturnType<typeof createMobileChecks>;
