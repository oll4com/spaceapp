import type { NousDecisionCategory } from "@space/contracts";
import { classifyPaneApproval } from "../room-agent-guardrails.js";

/**
 * What Nous may not do by itself (operator decision 2026-10-17): releases, irreversible actions and anything that goes
 * to third parties or costs money are the operator's. These checks run on the text Nous sends to a pane and on the pane
 * prompt it would answer; a match is refused and Nous asks the operator with space_ask_operator instead.
 * Mentions are fine ("do not touch .env"); only commands and requests to act are critical.
 */
const PROMOTE = /space-queue\s+promote\b/i;
const QUEUE_CONTROL = /space-queue\s+(?:default-target|resume|approve|pause)\b|--target\s+stable\b|--hotfix\b/i;
// Naming a release command only to forbid it is a mention: stable 2026-10-17 held three work instructions for "never --target
// stable" and "never --hotfix". The negation must stand right before it, so "no matter what, run --hotfix" still counts.
const NEGATED_RELEASE = /\b(?:never|not|no|don['’]t|do not|without)\s+(?:(?:use|pass|run|add)\s+)?(?:--target\s+stable|--hotfix|space-queue\s+(?:promote|default-target|resume|approve|pause))\b/gi;
// Workbench review 2026-10-21 (plan clipboard:GZNzxm7FNwjM): 7 days of held pane texts. Naming the deploy script as a file to edit
// ("scripts/space-deploy-commit.sh around line 1735", "installed by space-deploy-commit.sh") is work, not a deploy: only a request to
// run it counts (a run verb before it, or the command at a line start or in a code span).
const RUN_IT = String.raw`(?:\b(?:run|runs|running|execute|exec|call|invoke|use|start|trigger|bash|sh|sudo)\b[^\n.;]{0,40}|^[ \t>*-]*|\x60)`;
const DIRECT_DEPLOY = new RegExp(`${RUN_IT}(?:\\S*/)?(?:space-deploy-commit(?:\\.sh)?|space_deploy_commit|space-queue-deploy\\.sh)\\b`, "im");
// Reports about money ("card charge failed", "no refund recorded: €19,659", "Payment Warning (invoice …)") are not payments: a payment
// verb counts where it asks for an act (a clause start or after to/please/then/…), or an act names one ("issue a refund of €23").
const PAYMENT = /(?:(?:^|[.;:!?,(\n])\s*|\b(?:to|please|then|and|now|you|must|should|will|can|go|just|so|also)\s+)(?:pay|purchase|buy|checkout|subscribe|refund|charge)\b[^\n.]{0,40}(?:€|\$|eur|usd|card|invoice|plan|subscription)|\b(?:issue|make|send|process|complete|do|give|place)\s+(?:(?:a|an|the)\s+)?(?:\S+\s+)?(?:refund|payment|purchase|charge|order)\b[^\n.]{0,40}(?:€|\$|eur|usd|card|invoice|plan|subscription)/i;
// Gmail's "Send mail as" setting and a test mail to oneself reach no third party.
const SELF_ONLY = /["'“‘]?\bsend[- ]mail[- ]as\b["'”’]?|\bsend-as\b/gi;
const outgoingRules: Array<[NousDecisionCategory, string, RegExp]> = [
  ["RELEASE", "promoting dev to stable", PROMOTE],
  ["RELEASE", "stable queue control or a hotfix", QUEUE_CONTROL],
  ["RELEASE", "a version bump", /space-version\s+bump\b|npm\s+version\s+(?:patch|minor|major)\b|\bprepare-release\b/i],
  ["RELEASE", "an npm or GitHub release", /\bnpm\s+(?:publish|dist-tag)\b|spaceapp-setup-sync\.sh[^\n]*--publish|\bpublish-prepared\b|\bgh\s+release\s+create\b|release-train\s+(?:publishing|published)\b/i],
  ["RELEASE", "a push or tag", /\bgit\s+(?:push|tag)\b/i],
  ["RELEASE", "a direct deploy", DIRECT_DEPLOY],
  ["DESTRUCTIVE", "a recursive delete", /\brm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive)\b|find\s[^\n]*-delete\b/i],
  ["DESTRUCTIVE", "a git history rewrite", /git\s+(?:reset\s+--hard|clean\s+-[a-z]*[fdx]|branch\s+-D|stash\s+(?:drop|clear)|filter-(?:branch|repo)|push\s+(?:-f|--force))/i],
  // A request to show a secret, not a prohibition ("never print the token"): stable 2026-10-17, Nous asked a pane to show a password.
  ["DESTRUCTIVE", "showing a secret on screen", /(?<!(?:\bnot|\bnever|n't|\bno)\s+(?:\S+\s+){0,2})\b(?:show|print|display|reveal|cat|echo|output)\b(?:[^\n.]|\.(?!\s)){0,60}\b(?:passwords?|passwd|passphrases?|tokens?|secrets?|api[ -]?keys?|private keys?|credentials?)\b/i],
  ["DESTRUCTIVE", "destroying data", /\bdrop\s+(?:table|database|schema)\b|\btruncate\s+(?:table\s+)?\w|\bdelete\s+from\b|\bdropdb\b/i],
  // shortcut: words, not intent; a send or payment phrased differently passes. Copilots keep their own server-side send gates.
  ["EXTERNAL", "sending or publishing to third parties", /\b(?:send|post|publish|submit|reply|forward|tweet)\b[^\n.]{0,60}\b(?:e-?mails?|mails?|posts?|tweets?|proposals?|applications?|comments?|replies|messages?)\b[^\n.]{0,40}\b(?:to(?!\s+(?:it|your|my|our|them)sel(?:f|ves)\b)|on)\b/i],
  ["EXTERNAL", "a payment", PAYMENT]
];

/** The text without release commands it names only to forbid them ("never --hotfix"). */
export const withoutNegatedRelease = (text: string): string => text.replace(NEGATED_RELEASE, "");

export interface NousCriticalVerdict { category: NousDecisionCategory; reasons: string[] }
/** What the operator lets Nous do on its own in its settings (mayPromote, mayApproveWarm). */
export interface NousAllowances { promote: boolean; warm: boolean }
const NONE: NousAllowances = { promote: false, warm: false };

/** Text Nous wants to send to a pane as a prompt. */
export function classifyNousOutgoing(text: string, allow: NousAllowances = NONE): NousCriticalVerdict | null {
  const asked = withoutNegatedRelease(text).replace(SELF_ONLY, " ");
  const hits = outgoingRules.filter(([, reason, pattern]) => pattern.test(asked) && !(allow.promote && reason === "promoting dev to stable"));
  if (!hits.length) return null;
  return { category: hits[0]![0], reasons: [...new Set(hits.map(([, reason]) => reason))] };
}

/**
 * A pane prompt Nous would answer: the Room Agent's screen check (protected approvals and destructive commands) plus
 * the outgoing rules, so "Publish to npm? (y/n)" is the operator's too.
 */
export function classifyNousPrompt(screen: string, allow: NousAllowances = NONE): NousCriticalVerdict | null {
  const recent = screen.split("\n").slice(-40).join("\n");
  const checked = classifyPaneApproval(recent);
  // The operator's allowances lift only their own reason: a promote without any other queue control, Warm code.
  const reasons = checked.reasons.filter((reason) => !(allow.warm && reason === "Warm and room-switch code")
    && !(allow.promote && reason === "stable promotion and queue control" && PROMOTE.test(recent) && !QUEUE_CONTROL.test(recent)));
  const verdict = { level: reasons.length ? checked.level : "SAFE" as const, reasons };
  const outgoing = classifyNousOutgoing(recent, allow);
  if (verdict.level === "SAFE") return outgoing;
  const release = verdict.reasons.some((reason) => /promotion|deploy|version|push/.test(reason));
  return { category: release ? "RELEASE" : outgoing?.category ?? "DESTRUCTIVE", reasons: [...new Set([...verdict.reasons, ...(outgoing?.reasons ?? [])])] };
}
