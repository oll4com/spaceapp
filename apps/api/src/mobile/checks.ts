import { createPublicKey, verify } from "node:crypto";
import type { FastifyRequest } from "fastify";
import {
  inboxActInputSchema, isAgentFileArtifact, LINK_APP, NOUS_LINK_DECISION_CATEGORIES, nousLinkAnswerRequestSchema, verifyNousLinkAnswer, mobileAdminOpSigningInput, mobileAnswerSigningInput, mobileAskContentHash, mobileDecisionContentHash, mobileGoalContentHash, mobileIntegrityRequestHash, needsYouAsk, needsYouAskRisk,
  type Artifact, type InboxEvent, type MobileRouteRule,
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
  /** The owner's clipboard item, or null (a link's plan-only writes). */
  clipboardItem?: (owner: string, id: string) => Promise<{ source: string } | null>;
  notification: (owner: string, id: string) => Promise<SpaceNotification | null>;
  /** An open Nous decision of the owner, or null. */
  decision: (owner: string, id: string) => Promise<Decision | null>;
  /** A linked Nous's open decision as this SpaceApp last read it, or null (step 9c). */
  linkedDecision?: (owner: string, linkId: string, id: string) => Promise<Decision | null>;
  /** The owner's goal, or null (C9: its delete is signed). */
  goal: (owner: string, id: string) => Promise<{ id: string; text: string } | null>;
  /** A Thread's open asks (inboxThreadState), or null: no such Thread of the owner. */
  inboxAsks?: (owner: string, threadId: string) => Promise<InboxEvent[] | null>;
  /** Play Integrity on every signed answer (MASVS L2); null or absent: not configured, the signature alone decides. */
  integrity?: PlayIntegrity | null;
  /** This SpaceApp's identity public key (a superior's signed answer is made out to it, step 9c). */
  ownIdentity?: () => Promise<string | null>;
  now?: () => number;
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
  /** What a needs-you answer signs, or null when its ask's risk is NONE (or it is gone: its handler answers). */
  function askInput(id: string, notification: SpaceNotification | null, answer: unknown): Uint8Array | null {
    if (!notification || needsYouAskRisk(notification) === "NONE") return null;
    const ask = needsYouAsk(notification);
    return mobileAnswerSigningInput("ask", id, mobileAskContentHash({ id, question: ask.question, options: ask.options, recommended: ask.recommended, body: notification.body }), answer);
  }
  /** What a decision answer signs, or null when its category is not signed (or it is not open: its handler answers). */
  const decisionInput = (id: string, decision: Decision | null, answer: unknown) =>
    decision && SIGNED_CATEGORIES.has(decision.category) ? mobileAnswerSigningInput("decide", id, mobileDecisionContentHash(decision), answer) : null;
  return async (request: FastifyRequest, rule: MobileRouteRule): Promise<MobileCheckRefusal | null> => {
    const owner = request.user!.id;
    const id = (request.params as { id?: string }).id ?? "";
    if (rule.artifactById) {
      const artifact = await deps.artifact(id).catch(() => null);
      // A SpaceApp link (manage) also reads the screenshots its captures made (plan step 5).
      if (artifact && request.appSession === LINK_APP && artifact.kind === "SCREENSHOT") return null;
      return artifact && isAgentFileArtifact(artifact) ? null : refuse(403, "MOBILE_SCOPE_DENIED", request.appSession === LINK_APP
        ? "A SpaceApp link opens Agent Files and screenshots only." : "A phone opens Agent Files only.");
    }
    if (rule.superior) {
      const row = (await deps.devices.list(owner)).find((entry) => entry.id === request.mobileDevice?.id);
      if (!row?.nousSuperior || !row.scopes?.includes("nous")) {
        return refuse(403, "NOUS_NOT_SUPERIOR", "Only this Nous's superior commands it; the link names its Nous superior first (POST /api/nous/link/superior).");
      }
      if (!rule.superiorSignature) return null;
      // Step 9c: signed by the superior's stored key, made out to this SpaceApp, over the decision as it stands now, and recent.
      const input = nousLinkAnswerRequestSchema.safeParse(request.body);
      const decision = await deps.decision(owner, id);
      if (!decision) return refuse(409, "DECISION_NOT_OPEN", "This decision is answered or gone here; the first answer wins.");
      if (!(NOUS_LINK_DECISION_CATEGORIES as readonly string[]).includes(decision.category)) return refuse(403, "NOUS_LINK_DECISION_CATEGORY", "A superior answers only RELEASE, DESTRUCTIVE, EXTERNAL and DIRECTION decisions here.");
      const own = await deps.ownIdentity?.();
      const at = input.success ? Date.parse(input.data.statement.at) : NaN;
      // shortcut: a signed answer is good for 10 minutes either side (clock skew and a slow link); a replay inside it meets an answered decision (first answer wins).
      const fresh = Math.abs((deps.now?.() ?? Date.now()) - at) <= 10 * 60_000;
      return input.success && own && fresh && input.data.statement.to === own && input.data.statement.decisionId === id
        && input.data.statement.contentHash === mobileDecisionContentHash(decision) && verifyNousLinkAnswer(input.data.statement, input.data.signature, row.nousSuperior.identityPublic)
        ? null : refuse(403, "NOUS_LINK_ANSWER_SIGNATURE", "The answer is not signed by this Nous's superior for this decision as it stands now; refresh and answer again.");
    }
    if (rule.planById) {
      const item = await deps.clipboardItem?.(owner, id).catch(() => null);
      return item?.source === "PLAN" ? null : refuse(403, "MOBILE_SCOPE_DENIED", "A SpaceApp link changes plans only.");
    }
    if (rule.askRisk) {
      const input = askInput(id, await deps.notification(owner, id), request.body);
      return input ? signed(request, input) : null;
    }
    if (rule.decisionSignature) {
      const input = decisionInput(id, await deps.decision(owner, id), request.body);
      return input ? signed(request, input) : null;
    }
    if (rule.inboxActSignature) {
      const act = inboxActInputSchema.safeParse(request.body);
      // A body the route refuses never runs (400 from its handler).
      if (!act.success) return null;
      // Fail closed: a Thread the lookup cannot find is never acted on from a phone unsigned.
      const asks = await deps.inboxAsks?.(owner, id);
      if (!asks) return refuse(404, "NOT_FOUND", "That thread does not exist; refresh.");
      // The asks the verb reaches, as the route does: an answer its one ask, DISMISS every open one, DONE none (it refuses while one waits).
      const touched = act.data.verb === "DISMISS" ? asks : act.data.verb === "DONE" ? [] : asks.filter((ask) => ask.ref === act.data.askId);
      const inputs: Uint8Array[] = [];
      for (const ref of touched.map((ask) => ask.ref ?? "")) {
        // A decision signs the act's body; a dismissed card is acknowledged, which POST /api/notifications/:id/ack does unsigned.
        const input = ref.startsWith("nous_decision:") ? decisionInput(ref, await deps.decision(owner, ref), request.body)
          : act.data.verb === "DISMISS" ? null : askInput(ref, await deps.notification(owner, ref), request.body);
        if (input) inputs.push(input);
      }
      // shortcut: one signature header carries one statement; a Thread with two signed decisions open is dismissed on a computer, sign a list if that ever matters.
      if (inputs.length > 1) return refuse(409, "INBOX_SIGN_ONE", "More than one ask here needs your fingerprint; answer them one by one, or dismiss this on a computer.");
      return inputs[0] ? signed(request, inputs[0]) : null;
    }
    if (rule.linkedDecisionSignature) {
      const decisionId = (request.params as { decisionId?: string }).decisionId ?? "";
      const decision = await deps.linkedDecision?.(owner, id, decisionId);
      if (!decision) return refuse(404, "NOT_FOUND", "That decision is not open there any more; refresh.");
      return SIGNED_CATEGORIES.has(decision.category) ? signed(request, mobileAnswerSigningInput("decide", decisionId, mobileDecisionContentHash(decision), request.body)) : null;
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
