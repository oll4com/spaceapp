// Job applications and Crypto, two Nous pages beside Startup programs (operator 3/11 22:33 BKK, nous_msg:e734994004dd4c5eb8356124):
// the whole picture of every job applied to (read live from the Job Copilot's records) and of every crypto method tested (read from the
// crypto team's final table). Only what the records say: a stage the records do not name is derived from real mails and marked so.

/** A mail or a test/interview record about a company we applied to. */
export interface NousJobMail {
  /** The event (jobevt:…), task (task:…) or appointment id it comes from. */
  id: string;
  kind: "REJECTION" | "TEST" | "INTERVIEW" | "OFFER" | "ACTION_NEEDED";
  /** When the mail arrived (else when it was recorded). */
  at: string;
  subject: string;
  from: string | null;
  threadId: string | null;
  account: string | null;
  /** Tests and interviews: the deadline or start the record holds; null when the mail states none. */
  deadline?: string | null;
  /** Tests and interviews: still open (the task is OPEN or the appointment UPCOMING). */
  open?: boolean;
  /** The application the triage stored it under, when it names this company (else the triage's match was another company's). */
  applicationId?: string | null;
}

/** One company we sent at least one application to, and what its mails say. */
export interface NousJobCompany {
  name: string;
  applicationIds: string[];
  /** Tests and interviews in order: stage n is the n-th distinct one (derived: the records do not number stages). */
  stages: NousJobMail[];
  rejections: NousJobMail[];
  offers: NousJobMail[];
  /** Mails filed as "Action needed" that made no test or interview record (older rules filed receipts there too). */
  otherMails: NousJobMail[];
  outcome: "OFFER" | "IN_PROCESS" | "INVITED" | "REJECTED" | "NO_REPLY";
}

export interface NousJobApplicationRow {
  id: string;
  company: string;
  role: string;
  platform: string;
  url: string;
  status: string;
  appliedAt: string | null;
  createdAt: string;
  /** Monday (YYYY-MM-DD, in the report's zone) of the week it was sent. */
  week: string | null;
}

export interface NousJobReport {
  generatedAt: string;
  timeZone: string;
  funnel: {
    rows: number;
    /** Sent: SUBMITTED or VERIFIED. */
    applied: number;
    /** VERIFIED: a confirmation page or mail was seen. */
    confirmed: number;
    /** Distinct companies among the sent applications. */
    companies: number;
    rejected: number;
    invited: number;
    /** passed[k-1]: companies that invited us to a stage after stage k (derived), k = 1..4. */
    passed: number[];
    offers: number;
    noReply: number;
    /** Open tests and interviews (records). */
    pending: number;
  };
  /** Rows not sent, by status (QUEUED, FILLING, NEEDS_USER, FAILED). */
  notSent: Record<string, number>;
  platforms: Array<{ platform: string; applied: number; confirmed: number; companies: number; rejected: number; invited: number }>;
  weeks: Array<{ week: string; applied: number; confirmed: number; rejections: number; invitations: number }>;
  pending: Array<NousJobMail & { company: string | null }>;
  /** Rejection, test and interview mails naming no company we sent an application to. */
  unmatched: NousJobMail[];
  companies: NousJobCompany[];
  applications: NousJobApplicationRow[];
}

export const NOUS_CRYPTO_VERDICTS = ["PASS", "FAIL", "INSUFFICIENT", "RESEARCH", "SKIP", "PENDING", "OTHER"] as const;
export type NousCryptoVerdict = (typeof NOUS_CRYPTO_VERDICTS)[number];

export interface NousCryptoRow {
  id: string;
  method: string;
  category: string;
  success: string;
  monthly: string;
  capital: string;
  risk: string;
  verdict: NousCryptoVerdict;
  /** The table's own verdict cell. */
  verdictText: string;
  /** The source cell's links (registry rows, audits, evidence) and its other text. */
  sources: Array<{ label: string; path: string; line: number | null }>;
  sourceText: string;
  /** The registry row the first link names, by its column names (where, test mode, started, h logged, status, owner, evidence…). */
  registry: Record<string, string> | null;
  /** Hours the registry logged, when it states a number of hours; days = hours / 24. */
  hours: number | null;
  /** "-n2" rows: the method this second check repeats. */
  retestOf: string | null;
  retests: string[];
  /** FAIL and SKIP rows: the reason groups their stated reason names (a row can name several). */
  reasons: string[];
}

export interface NousCryptoReport {
  /** The table read: final-table.md once it exists, else the draft. Null when neither exists. */
  source: { path: string; final: boolean; modifiedAt: string; title: string } | null;
  /** The table's own notes (coverage and how to read it), as written. */
  notes: string[];
  rows: NousCryptoRow[];
  verdicts: Record<NousCryptoVerdict, number>;
  categories: Array<{ category: string; total: number; verdicts: Partial<Record<NousCryptoVerdict, number>> }>;
  reasons: Array<{ reason: string; ids: string[] }>;
}

// Marketing (operator 5/11 10:42 BKK, nous_msg:25daa8b6ebbf489499694f64, plan clipboard:netzt-nNvtBL): every Marketing Copilot post numbered,
// per platform, with what it brought, the other stats sources (GA4, GitHub, npm, installs, mail campaigns) and a score per post, platform and overall.

/** A post's numbers in one shape, whatever keys the copilot's readout or a public API used (null: never read). */
export interface NousMarketingNumbers { views: number | null; replies: number; messages: number; likes: number; clicks: number; followers: number }
export interface NousMarketingPostRow extends NousMarketingNumbers {
  /** #1 is the oldest post, so a number never changes; the list shows the newest first. */
  number: number;
  id: string;
  channel: string;
  status: string;
  title: string | null;
  target: string | null;
  url: string | null;
  at: string;
  /** When its numbers were last read (copilot readout or the stats collector); null: never. */
  measuredAt: string | null;
  /** 0-100; null while it is not measured yet (a failed publish scores 0). */
  score: number | null;
  failure: string | null;
  raw: Record<string, number>;
}
export interface NousMarketingPlatform extends NousMarketingNumbers {
  channel: string;
  posts: number;
  published: number;
  failed: number;
  measured: number;
  /** Visits the platform sent to our sites and repository (GA4 sessions of 30 days + GitHub referrers of 14 days); null: no source read it. */
  visits: number | null;
  /** 0-100 over its measured and failed posts of the last 30 days; null: nothing measured yet. */
  score: number | null;
}
export interface NousMarketingSource {
  id: string;
  label: string;
  connected: boolean;
  /** What the numbers are (connected) or exactly what is needed to connect it. */
  detail: string;
  /** The newest recorded values ("stars": 41, ...), and their day. */
  values: Record<string, number>;
  day: string | null;
}
export interface NousMarketingReport {
  generatedAt: string;
  /** 0-100: posts (their scores) and outcomes (stars, downloads, visitors gained) of the last 30 days. */
  score: number | null;
  postsScore: number | null;
  outcomesScore: number | null;
  /** Today's score minus the one 7 and 30 days ago (null: no score then). */
  trend7: number | null;
  trend30: number | null;
  /** Days of the last 7 without one published post that brought anything. */
  daysWithoutResult: number;
  /** The score Nous must reach (MARKETING_SCORE_TARGET) and the days in a row, up to today, it has been below it (the Nous Score charges them). */
  target: number;
  daysBelowTarget: number;
  totals: NousMarketingNumbers & { posts: number; published: number; failed: number; measured: number; zeroReach: number };
  platforms: NousMarketingPlatform[];
  /** Every post, newest first. */
  posts: NousMarketingPostRow[];
  sources: NousMarketingSource[];
  /** spaceapp.dev's anonymous page views of the owner's history period (visit.php day files); null: never synced to this server. */
  site?: NousSiteFunnel | null;
}
/** A count and the median seconds of what it counts. */
export interface NousSiteRow { key: string; views: number; medianSeconds: number | null }
export interface NousSiteFunnel {
  /** The newest synced day file's change, and the first day of the period the numbers cover. */
  updatedAt: string | null;
  since: string;
  /** Page views of the period (one per visit id), and how many came from our own addresses (left out of everything below). */
  views: number;
  internal: number;
  /** Homepage sections in page order: views that reached it, median seconds on it, views that left the page there, clicks in it. */
  sections: Array<{ id: string; reached: number; medianSeconds: number | null; exits: number; clicks: number }>;
  /** Every page: views, median visible seconds, median scroll depth (%) and views that left the site from it. */
  pages: Array<NousSiteRow & { medianDepth: number | null; leftSite: number }>;
  referrers: NousSiteRow[];
  sources: NousSiteRow[];
  countries: NousSiteRow[];
  screens: NousSiteRow[];
  /** "from → to" within the site, and the named actions (install_copy, demo, github, docs, advisor). */
  next: NousSiteRow[];
  actions: NousSiteRow[];
}
