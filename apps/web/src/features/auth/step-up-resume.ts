import { api } from "../../api.js";

/**
 * An action held by STEP_UP_REQUIRED that runs once a Google step-up comes back (?mobileStepUp=ok), like mobile-pair-resume: a link's
 * grants (Settings > Account > Devices) or an answer to a linked SpaceApp's decision (Nous dock). Kept in this tab only, for 10 minutes.
 */
export type StepUpResume =
  | { purpose: "link-scopes"; deviceId: string; scopes: string[] }
  | { purpose: "linked-decision"; linkId: string; decisionId: string; answer: "APPROVE" | "DECLINE" | "ANSWER"; text?: string };

const KEY = "space:step-up-resume";
const TTL_MS = 10 * 60_000;

/** Before leaving for Google's step-up. */
export function markStepUpResume(resume: StepUpResume): void {
  try { window.sessionStorage.setItem(KEY, JSON.stringify({ at: Date.now(), resume })); } catch { /* storage off: the person does it again */ }
}

/** The step-up came back: the held action (once), or null. */
export function takeStepUpResume(): StepUpResume | null {
  try {
    const mark = JSON.parse(window.sessionStorage.getItem(KEY) ?? "null") as { at?: unknown; resume?: StepUpResume } | null;
    window.sessionStorage.removeItem(KEY);
    return mark && typeof mark.at === "number" && Date.now() - mark.at < TTL_MS && mark.resume ? mark.resume : null;
  } catch { return null; }
}

/** Runs the held action within the fresh step-up; answers the notice to show. */
export async function runStepUpResume(resume: StepUpResume): Promise<string> {
  if (resume.purpose === "link-scopes") {
    await api.setLinkScopes(resume.deviceId, resume.scopes);
    return "Confirmed it is you. The link's grants in Settings > Account > Devices are saved.";
  }
  await api.answerLinkedNousDecision(resume.linkId, resume.decisionId, { answer: resume.answer, ...(resume.text ? { text: resume.text } : {}) });
  return "Confirmed it is you. Your answer went to the linked SpaceApp.";
}
