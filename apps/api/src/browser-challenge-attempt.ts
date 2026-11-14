// A leaf (no imports): the browser routes record solver runs here without reaching nous/tools.ts (domain-boundaries cycle check).
export const CHALLENGE_ATTEMPT_ACTION = "browser.challenge.attempt";
/** The page a run was on, without its query or fragment (a reset or sign-in link's token stays out of the audit). */
export const pageAddress = (url: string | null | undefined): string | null => { try { const page = new URL(url ?? ""); return `${page.origin}${page.pathname}`; } catch { return null; } };
export interface ChallengeAttempt { solver: string; status: string; pageId: string | null; url: string | null; at: string }
