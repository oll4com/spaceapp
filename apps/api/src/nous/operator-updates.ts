import { createHash } from "node:crypto";
import { z } from "zod";
import { nousProgramGmailUrl, OPERATOR_UPDATE_KIND, operatorUpdateLinkSchema, type NousProgram, type OperatorUpdatePayload, type SpaceNotification, type UiLanguage } from "@space/contracts";
import type { NotificationService } from "../notifications/service.js";

/**
 * Nous › Updates (operator 4/11 15:04 and 15:09 BKK, R73: «όταν υπάρχει έγκριση για οποιοδήποτε πρόγραμμα θέλω να μου έρχεται πλήρης αναφορά»):
 * one roomless NOUS notification per development, its full report in `payload.report`. The programs registry writes a program's approval,
 * rejection or new amount itself (not dependent on Nous remembering); Nous posts the rest with space_operator_update.
 */
const DECIDED = new Set<NousProgram["status"]>(["APPROVED", "REJECTED"]);
/** A decision this recent is still reported when its program is next written (the backfill of 4/11: approvals he was never told about). */
export const OPERATOR_UPDATE_RECENT_MS = 7 * 86_400_000;

export const operatorUpdateArgsSchema = z.object({
  title: z.string().trim().min(1).max(200).describe("One line he reads on the card, in his language: what happened (\"Η αποστολή στην Temu έγινε\")."),
  body: z.string().trim().min(1).max(1_000).describe("Two or three short sentences under the title: the outcome and whether he must do anything."),
  report: z.string().trim().min(1).max(20_000).optional().describe("The full report that opens when he selects the entry: what was done, the result and how it was checked, "
    + "what it gives or costs, what happens next and what (money, a card, his hands) is needed from him. Left out: the body."),
  links: z.array(operatorUpdateLinkSchema).max(50).optional().describe("http(s) links the report rests on: {label, url} (a Gmail thread, a page, a published post)."),
  refs: z.array(z.string().trim().min(1).max(200)).max(20).optional().describe("Space ids it is about (nous_msg:…, clipboard:…, q-…, a program id), listed under the report.")
});
export type OperatorUpdateArgs = z.infer<typeof operatorUpdateArgsSchema>;

const LABELS = {
  en: { APPROVED: "Approved", REJECTED: "Rejected", AMOUNT: "New amount", what: "What it is", gives: "What it gives", use: "How we use it and what it needs",
    valid: "valid until", terms: "Conditions and commitments", account: "Account", project: "Project", applied: "Applied", decided: "Decided", why: "Why", next: "Next step",
    benefits: "Benefits", mails: "Mails", page: "Program page", before: "Before", missing: "not written yet" },
  el: { APPROVED: "Εγκρίθηκε", REJECTED: "Απορρίφθηκε", AMOUNT: "Νέο ποσό", what: "Τι είναι", gives: "Τι δίνει", use: "Πώς το χρησιμοποιούμε και τι χρειάζεται",
    valid: "ισχύει έως", terms: "Όροι και δεσμεύσεις", account: "Λογαριασμός", project: "Έργο", applied: "Αίτηση", decided: "Απόφαση", why: "Γιατί", next: "Επόμενο βήμα",
    benefits: "Παροχές", mails: "Mails", page: "Σελίδα του προγράμματος", before: "Πριν", missing: "δεν έχει γραφτεί ακόμα" }
} as const;
const day = (value: string | null) => value ? value.slice(0, 10) : null;
const amountText = (program: NousProgram) => program.amount ? program.amount.text : null;
const amountKey = (program: NousProgram) => program.amount ? `${program.amount.value ?? ""}|${program.amount.currency ?? ""}|${program.amount.text}` : "";
const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
type Change = "APPROVED" | "REJECTED" | "AMOUNT";

/** The report of one program's decision, in the operator's agent language (the registry's own values stay as written). */
export function programUpdate(program: NousProgram, change: Change, language: UiLanguage, before: NousProgram | null = null) {
  const l = LABELS[language];
  const row = (label: string, value: string | null | undefined) => value ? [`${label}: ${value}`] : [];
  // An approval always says both (R73); a rejection only when written.
  const use = (label: string, value: string | null) => value || program.status === "APPROVED" ? [`${label}: ${value || l.missing}`] : [];
  const name = `${program.parent} › ${program.program}`;
  const gives = [amountText(program), program.validUntil ? `${l.valid} ${day(program.validUntil)}` : null].filter(Boolean).join(" · ");
  const links = [...(program.url ? [{ label: l.page, url: program.url }] : []),
    ...program.mails.flatMap((mail) => { const url = nousProgramGmailUrl(mail); return url ? [{ label: `${day(mail.date)} · ${mail.subject || mail.from}`, url }] : []; })];
  const report = [
    `${l[change]}: ${name}${program.project ? ` (${program.project})` : ""}`,
    ...use(l.what, program.whatItIs),
    ...row(l.gives, gives),
    ...(change === "AMOUNT" && before ? row(l.before, amountText(before)) : []),
    ...use(l.use, program.howWeUse),
    ...row(l.terms, program.commitments), ...row(l.account, program.account), ...row(l.project, program.project),
    ...row(l.applied, day(program.appliedAt)), ...row(l.decided, day(program.decidedAt)), ...row(l.why, program.statusReason), ...row(l.next, program.nextAction),
    ...(program.benefits.length ? [`${l.benefits}:`, ...program.benefits.map((line) => `- ${line.what}${line.total ? ` · ${line.total.text}` : ""}${line.perMonth ? ` · ${line.perMonth.text}/month` : ""}`
      + `${line.validUntil ? ` · ${l.valid} ${day(line.validUntil)}` : ""}${line.account ? ` · ${line.account}` : ""}`)] : []),
    ...(program.mails.length ? [`${l.mails}:`, ...program.mails.map((mail) => `- ${day(mail.date)} ${mail.direction === "SENT" ? "→" : "←"} ${mail.direction === "SENT" ? mail.to.join(", ") : mail.from} · "${mail.subject}"`)] : []),
    `(${program.id})`
  ].join("\n");
  const body = [gives || null, program.whatItIs].filter(Boolean).join(" · ") || name;
  return { title: `${l[change]}: ${name}`, body: body.slice(0, 1_000), payload: { report, links, programId: program.id } satisfies OperatorUpdatePayload };
}

export function createOperatorUpdates(deps: {
  notifications: Pick<NotificationService, "list" | "raise">;
  language(owner: string): Promise<UiLanguage>;
  /** An inbox line that wakes Nous (service.notice). */
  notice?(owner: string, key: string, line: string): Promise<void>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  /** One entry per key, ever (a read entry is not posted again). Null when the key already has one. */
  async function post(owner: string, entry: { title: string; body: string; payload: OperatorUpdatePayload; dedupeKey: string }): Promise<SpaceNotification | null> {
    if ((await deps.notifications.list(owner, { status: "ALL", source: "NOUS", kind: OPERATOR_UPDATE_KIND, dedupeKey: entry.dedupeKey, limit: 1 })).length) return null;
    return deps.notifications.raise({ ownerUserId: owner, roomId: null, paneId: null, source: "NOUS", kind: OPERATOR_UPDATE_KIND, severity: "ATTENTION",
      title: entry.title, body: entry.body, link: { surface: "nous", target: "updates" }, dedupeKey: entry.dedupeKey, payload: entry.payload, telegram: null });
  }
  const programKey = (program: NousProgram) => `nous:update:program:${program.id.slice(0, 120)}:${program.status}:${hash(amountKey(program))}`;
  const missingUse = (program: NousProgram) => program.status === "APPROVED" && (!program.whatItIs || !program.howWeUse);
  const askForUse = (owner: string, programs: NousProgram[]) => programs.length ? deps.notice?.(owner, `program-use:${programs.map((program) => program.id).join(",").slice(0, 160)}`,
    `${programs.map((program) => `${program.id} (${program.parent} › ${program.program})`).join(", ")} ${programs.length === 1 ? "is" : "are"} APPROVED without whatItIs/howWeUse, so the `
    + "operator has no report yet: write both now with space_programs upsert, in his language (what the service is; how SpaceApp/oll4 uses it and what that needs: a card, "
    + "a plan, setup, a deadline). That upsert sends him the full report in Updates and the chat.") : undefined;

  /**
   * A program written: its approval, rejection or new amount goes to Updates once, and so does a recent decision not reported yet. An approval
   * without its two use fields (saved all the same, operator 7/11) waits for them and asks Nous. Returns the report posted, if any.
   */
  async function programChanged(owner: string, before: NousProgram | null, after: NousProgram): Promise<string | null> {
    if (!DECIDED.has(after.status)) return null;
    const recent = Boolean(after.decidedAt) && Date.parse(after.decidedAt!) >= now() - OPERATOR_UPDATE_RECENT_MS;
    // A program first recorded already decided is news only when the decision is recent (or undated): the data panes also record history.
    const statusChanged = before ? before.status !== after.status : !after.decidedAt || recent;
    const change: Change | null = statusChanged ? after.status as Change : before && after.status === "APPROVED" && amountKey(before) !== amountKey(after) ? "AMOUNT"
      : recent ? after.status as Change : null;
    if (!change) return null;
    if (missingUse(after)) {
      if (statusChanged || change === "AMOUNT") await askForUse(owner, [after]);
      return null;
    }
    const entry = programUpdate(after, change, await deps.language(owner), before);
    return await post(owner, { ...entry, dedupeKey: programKey(after) }) ? entry.payload.report : null;
  }

  return {
    post,
    programChanged,
    /** Space's start: recent decisions with no entry yet get theirs (or Nous is asked for the use fields first). */
    async sweep(owner: string, programs: NousProgram[]): Promise<number> {
      const recent = programs.filter((program) => DECIDED.has(program.status) && program.decidedAt && Date.parse(program.decidedAt) >= now() - OPERATOR_UPDATE_RECENT_MS);
      const unreported: NousProgram[] = [];
      for (const program of recent) {
        if ((await deps.notifications.list(owner, { status: "ALL", source: "NOUS", kind: OPERATOR_UPDATE_KIND, dedupeKey: programKey(program), limit: 1 })).length) continue;
        unreported.push(program);
      }
      await askForUse(owner, unreported.filter(missingUse));
      let posted = 0;
      for (const program of unreported.filter((entry) => !missingUse(entry))) if (await programChanged(owner, null, program)) posted += 1;
      return posted;
    },
    /** space_operator_update: the same title and body is posted once. */
    async postNote(owner: string, args: OperatorUpdateArgs) {
      const report = [args.report ?? args.body, ...(args.refs?.length ? [`\n(${args.refs.join(", ")})`] : [])].join("\n");
      return post(owner, { title: args.title, body: args.body, payload: { report, links: args.links ?? [] }, dedupeKey: `nous:update:note:${hash(`${args.title}\n${args.body}`)}` });
    }
  };
}
export type OperatorUpdates = ReturnType<typeof createOperatorUpdates>;
