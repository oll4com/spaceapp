import { z } from "zod";
import { GATEWAY_PROGRAM_PROVIDERS } from "./gateway.js";

// Startup programs (operator 3/11 20:09 BKK, plan clipboard:17yLAnH5ZpyF, brief nous/briefs/20261103-programs-pages.md):
// every program applied to, one row each under its parent (NVIDIA › Inception), with its status, amounts, dates, every mail and whether
// to apply again. The second page, "oll4-funding", is gone (operator 7/11, nous_msg:e9c06cd838de45f4bccda467); its rows were moved to startup.
export const NOUS_PROGRAM_PAGES = ["startup"] as const;
export const NOUS_PROGRAM_STATUSES = ["APPROVED", "REJECTED", "IN_PROGRESS", "APPLIED", "DRAFT", "NOT_APPLIED", "EXPIRED", "CANCELLED"] as const;
export type NousProgramPage = (typeof NOUS_PROGRAM_PAGES)[number];
export type NousProgramStatus = (typeof NOUS_PROGRAM_STATUSES)[number];
/** The grouped tags the programs files carry (operator 6/11 21:42 BKK, nous_msg:f0287998): the pages' tag chips, in this order (cash first, 7/11). */
export const NOUS_PROGRAM_TAGS = ["cash-grants", "ai-tokens", "server-access", "dev-tools", "perks"] as const;
export type NousProgramTag = (typeof NOUS_PROGRAM_TAGS)[number];
const CASH_WORDS = /\b(grants?|cash|equity|invest\w*|funding|non-dilutive|prizes?|awards?|bount(?:y|ies)|seed|loans?|subsid\w*|stipends?)\b/i;
const TAG_WORDS: Array<[NousProgramTag, RegExp]> = [
  ["ai-tokens", /\b(api credits?|tokens?|llms?|inference|openai|anthropic|claude|gemini|mistral|cohere|groq|ai credits?)\b/i],
  ["server-access", /\b(cloud|gpus?|compute|aws|azure|gcp|servers?|hosting|vps|kubernetes|digitalocean|hetzner|ovh)\b/i],
  ["cash-grants", CASH_WORDS],
  ["dev-tools", /\b(saas|github|gitlab|sentry|algolia|datadog|jetbrains|figma|notion|licen[cs]es?|software|dev tools?|ide|monitoring)\b/i]
];
const AI_TOKENS_ONLY = /\b(codex|claude for startups)\b/i;
const CLOUD = /\b(aws|amazon web services|azure|upcloud|google cloud|gcp|digitalocean|hetzner|ovh\w*|oracle|scaleway|vultr|linode|akamai|ibm cloud|alibaba cloud|tencent cloud|outscale|cloudflare|backblaze)\b/i;
const CONTEST = /\b(bug bounty|bount(?:y|ies)|hackathons?|prizes?|competitions?|challenges?|arena)\b/i;
const PERK = /\b(credits?|tokens?|seats?|membership|vouchers?|coupons?|vps|hosting|licen[cs]es?|subscriptions?|plans?|tiers?|free|discounts?|off|value|equivalent|allocation|premium|minutes|mentor\w*|workshops?)\b/i;
/**
 * A program's categories as the pages show them (operator 7/11 14:26 BKK, nous_msg:02ad746e), read from its stored tags (else its words) and
 * never written back: Cash is only money paid into our account (grants, prizes, bounties paid, investment), never credits, tokens, seats, plans
 * or perks; the Gateway pools, Claude for Startups and Codex are AI tokens only; a cloud provider's program is Servers/Cloud only.
 */
export function nousProgramCategories(program: Pick<NousProgram, "id" | "parent" | "program" | "amount" | "tags" | "whatItIs" | "howWeUse" | "notes" | "benefits">): string[] {
  const name = `${program.parent} ${program.program}`;
  if (GATEWAY_PROGRAM_PROVIDERS[program.id] || AI_TOKENS_ONLY.test(`${program.id} ${name}`)) return ["ai-tokens"];
  if (CLOUD.test(name) && !CONTEST.test(name)) return ["server-access"];
  const raw = program.amount?.text ?? "", amount = raw.replace(/\b(?:no|zero)\b[\w ]*?\b(?:cash|equity|funding)\b/gi, "");
  const text = [name, amount, program.whatItIs, program.howWeUse, program.notes, ...program.benefits.map((line) => line.what)].filter(Boolean).join(" ");
  const tags = program.tags.length ? program.tags : TAG_WORDS.filter(([, words]) => words.test(text)).map(([tag]) => tag);
  // A cash tag stays unless the amount's lead names a perk and the amount (outside brackets) no money: "$10,000 in API credits" from a
  // "Grant Program" is not cash, "$20,000 Cash and AWS credits", "$500k on a SAFE" or "accelerator; EUR 12,500 investment" is.
  const lead = raw.split(/;|\(|\s(?:plus|and|\+)\s/i)[0] ?? "";
  const perk = PERK.test(lead) || (!/[$€£]|\b(?:usd|eur|gbp)\b/i.test(lead) && PERK.test(raw));
  const bare = amount.replace(/\([^)]*\)/g, "");
  const cash = CASH_WORDS.test(bare) || /\bSAFE\b/.test(bare) || !perk;
  const kept = tags.filter((tag) => tag !== "cash-grants" || cash);
  return kept.length ? kept : ["perks"];
}

const blankToNull = (value: unknown) => typeof value === "string" && !value.trim() ? null : value;
const upper = (value: unknown) => typeof value === "string" ? value.trim().toUpperCase().replace(/[\s-]+/g, "_") : value;
const list = (value: unknown) => typeof value === "string" ? (value.trim() ? [value] : []) : value ?? [];
/** Any date the data gives (a date alone too), kept as an ISO instant. */
const instant = z.string().trim().refine((value) => !Number.isNaN(Date.parse(value)), "Not a date").transform((value) => new Date(value).toISOString());
const date = z.preprocess(blankToNull, instant.nullable());
const text = z.preprocess(blankToNull, z.string().trim().nullable());
// Only web addresses: the page opens it as a link.
const webUrl = z.preprocess(blankToNull, z.string().trim().url().refine((value) => /^https?:\/\//i.test(value), "Only http(s) links").nullable());
const texts = z.preprocess(list, z.array(z.string().trim().min(1)));

// A provider's yes in another word is APPROVED (operator 7/11: every approved record under Approved; tailscale-for-startups came as REDEEMED).
const APPROVED_WORDS = new Set(["REDEEMED", "ACCEPTED", "GRANTED", "AWARDED", "ACTIVATED", "ACTIVE"]);
export const nousProgramStatusSchema = z.preprocess((value) => { const word = upper(value); return APPROVED_WORDS.has(word as string) ? "APPROVED" : word; },
  z.enum(NOUS_PROGRAM_STATUSES));
// A writer still naming the old "oll4-funding" page lands on startup (an oll4 project's program keeps its project there).
export const nousProgramPageSchema = z.preprocess((value) => typeof value === "string" ? value.trim().toLowerCase().replace(/^oll4-funding$/, "startup") : value, z.enum(NOUS_PROGRAM_PAGES));

export const nousProgramMailSchema = z.object({
  date: instant,
  direction: z.preprocess(upper, z.enum(["SENT", "RECEIVED"])),
  from: z.string().trim().min(1),
  to: texts,
  subject: z.preprocess((value) => value ?? "", z.string()),
  gmailAccount: text.optional().default(null),
  // Gmail's own id: it goes into the "Open in Gmail" link.
  threadId: z.preprocess(blankToNull, z.string().trim().regex(/^[A-Za-z0-9_-]+$/, "Gmail thread ids are letters and digits").nullable()).optional().default(null)
}).passthrough();
export type NousProgramMail = z.infer<typeof nousProgramMailSchema>;

export const nousProgramAmountSchema = z.preprocess((value) => typeof value === "string" ? { text: value } : value, z.object({
  text: z.string().trim().min(1),
  value: z.number().nullable().optional().default(null),
  currency: text.optional().default(null)
}));
const amountOrNull = z.preprocess(blankToNull, nousProgramAmountSchema.nullable()).optional().default(null);

// One thing a program gives (operator 3/11 21:41 BKK: what each program gave, per account, per month): a credit grant, a seat, a listing.
// The shared shape for usage too (plan clipboard:MUFqsrKfQtAt): `used`/`remaining` as of `usageAt`, written by whoever measures them.
export const NOUS_PROGRAM_BENEFIT_STATUSES = ["ACTIVE", "PENDING", "USED_UP", "EXPIRED", "NOT_VERIFIED"] as const;
export const nousProgramBenefitSchema = z.object({
  what: z.string().trim().min(1),
  account: text.optional().default(null),
  perMonth: amountOrNull,
  total: amountOrNull,
  used: amountOrNull,
  remaining: amountOrNull,
  usageAt: date.optional().default(null),
  validUntil: date.optional().default(null),
  // A recurring line's first day (a seat or subscription worth perMonth, operator 7/11): its total and used follow from perMonth on every read. Never on a credit grant.
  since: date.optional(),
  status: z.preprocess(upper, z.enum(NOUS_PROGRAM_BENEFIT_STATUSES)).optional().default("NOT_VERIFIED"),
  source: text.optional().default(null),
  notes: text.optional().default(null),
  // Which project uses it, and for what (the usage report's split; percent of this line).
  allocations: z.preprocess((value) => value ?? [], z.array(z.object({
    project: z.string().trim().min(1),
    percent: z.number().min(0).max(100).nullable().optional().default(null),
    purpose: text.optional().default(null)
  }))).optional().default([])
});
export type NousProgramBenefit = z.output<typeof nousProgramBenefitSchema>;

// A program's levels (OpenAI Partner Network: Registered, then the tiers above): REACHED, PENDING (applied, under review), NEXT (what comes
// if approved), LATER.
export const NOUS_PROGRAM_TIER_STATUSES = ["REACHED", "PENDING", "NEXT", "LATER"] as const;
export const nousProgramTierSchema = z.object({
  name: z.string().trim().min(1),
  status: z.preprocess(upper, z.enum(NOUS_PROGRAM_TIER_STATUSES)),
  requires: text.optional().default(null),
  gives: text.optional().default(null),
  amount: amountOrNull,
  source: text.optional().default(null)
});
export type NousProgramTier = z.output<typeof nousProgramTierSchema>;

export const nousProgramReapplySchema = z.object({
  needed: z.boolean(),
  why: text.optional().default(null),
  when: date.optional().default(null)
});

/**
 * One program as the data files, the API and space_programs give it. Every field but the id may be left out: an upsert keeps what it does
 * not name (null clears), and a new program needs parent, program and status (page defaults to startup). Mails are added, never replaced (mailKey).
 */
export const nousProgramInputSchema = z.object({
  id: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "A stable slug such as nvidia-inception"),
  page: nousProgramPageSchema.optional(),
  parent: z.string().trim().min(1).optional(),
  program: z.string().trim().min(1).optional(),
  project: text.optional(),
  url: webUrl.optional(),
  status: nousProgramStatusSchema.optional(),
  statusReason: text.optional(),
  appliedAt: date.optional(),
  decidedAt: date.optional(),
  expectedReplyBy: date.optional(),
  validUntil: date.optional(),
  amount: z.preprocess(blankToNull, nousProgramAmountSchema.nullable()).optional(),
  commitments: text.optional(),
  account: text.optional(),
  contacts: texts.optional(),
  mails: z.preprocess((value) => value ?? [], z.array(nousProgramMailSchema)).optional(),
  nextAction: text.optional(),
  reapply: nousProgramReapplySchema.nullable().optional(),
  sources: texts.optional(),
  notes: text.optional(),
  // Gives money: cash, investment or spendable credits with a value (API usage, cloud, GPU, storage); not courses, memberships, free
  // tiers, free services or seats only (operator 3/11, nous_msg:c85c7a41). A program with mixed benefits that include money counts.
  givesMoney: z.boolean().nullable().optional(),
  // Grouped tags (NOUS_PROGRAM_TAGS; another slug is kept and shown as written). Replaced whole when given.
  tags: z.preprocess(list, z.array(z.string().trim().min(1).transform((tag) => tag.toLowerCase()))).optional(),
  // Operator 4/11 15:09 BKK (R73): what the service or program is, in one line, and how SpaceApp/oll4 uses it with what that needs (a card, a
  // paid plan, a DSN, a deadline). The operator's report leads with them and waits for them; an approval without them is still saved (7/11).
  whatItIs: text.optional(),
  howWeUse: text.optional(),
  // Replaced whole when given (unlike mails).
  benefits: z.preprocess((value) => value ?? [], z.array(nousProgramBenefitSchema)).optional(),
  tiers: z.preprocess((value) => value ?? [], z.array(nousProgramTierSchema)).optional(),
  // Fields the operator locked (9/11 20:59 BKK: UpCloud's €5,000 went back to €1,000 with a file rewrite): a data file never changes them,
  // space_programs only with a new source in sources. Replaced whole when given; set by space_programs only.
  locked: texts.optional()
});
export type NousProgramInput = z.input<typeof nousProgramInputSchema>;
export type NousProgramFields = z.output<typeof nousProgramInputSchema>;

export interface NousProgram {
  id: string; page: NousProgramPage; parent: string; program: string; project: string | null; url: string | null;
  status: NousProgramStatus; statusReason: string | null;
  appliedAt: string | null; decidedAt: string | null; expectedReplyBy: string | null; validUntil: string | null;
  amount: { text: string; value: number | null; currency: string | null } | null;
  commitments: string | null; account: string | null; contacts: string[]; mails: NousProgramMail[]; nextAction: string | null;
  reapply: { needed: boolean; why: string | null; when: string | null } | null;
  sources: string[]; notes: string | null; givesMoney: boolean | null; tags: string[]; whatItIs: string | null; howWeUse: string | null; benefits: NousProgramBenefit[]; tiers: NousProgramTier[]; locked?: string[]; createdAt: string; updatedAt: string;
}

/** The usage report's file (plan clipboard:MUFqsrKfQtAt): `{ generatedAt, entries: [{ id, benefits }] }`, merged into the stored lines. */
export const nousProgramUsageEntrySchema = z.object({ id: z.string().trim().min(1), benefits: z.array(nousProgramBenefitSchema) });
/** One benefit line once: the same thing for the same account (or none). */
export const nousProgramBenefitKey = (line: Pick<NousProgramBenefit, "what" | "account">) => `${line.what.trim().toLowerCase()}|${(line.account ?? "").trim().toLowerCase()}`;

/** The data panes' file: `{ generatedAt, entries }` (~/agent-workspace/active/20261103-programs/*.json). Entries are checked one by one. */
export const nousProgramsFileSchema = z.object({ generatedAt: date.optional(), entries: z.array(z.unknown()) });

/** One mail once: the same direction, time, thread and subject is the same mail. */
export const nousProgramMailKey = (mail: Pick<NousProgramMail, "direction" | "date" | "threadId" | "subject">) =>
  `${mail.direction}|${mail.date}|${mail.threadId ?? ""}|${mail.subject.trim().toLowerCase()}`;

/** The Gmail link of a mail's thread, when the mail names both its account and its thread. */
export const nousProgramGmailUrl = (mail: Pick<NousProgramMail, "gmailAccount" | "threadId">): string | null =>
  mail.gmailAccount && mail.threadId ? `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(mail.gmailAccount)}#all/${mail.threadId}` : null;
