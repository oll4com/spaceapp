import type { PgClientLike } from "./space-store.js";

/** The owner's copilot memories (and Live personal memory) Nous searches next to Space Memory: table, label and id column. */
export const COPILOT_MEMORY_SOURCES = [
  { table: "job_apply_memory", label: "Job Copilot memory" },
  { table: "freelance_copilot_memory", label: "Freelance Copilot memory" },
  { table: "marketing_copilot_memory", label: "Marketing Copilot memory" },
  { table: "mail_copilot_memory", label: "Mail Copilot memory" },
  { table: "security_copilot_memory", label: "Security Copilot memory" },
  { table: "monitoring_copilot_memory", label: "Monitoring Copilot memory" }
] as const;

const QUESTION_STOPWORDS = new Set(("a an and any are as at be been by can could did do does for from has have how in is it its many much of on or our please "
  + "should that the their this to was we were what when which who will with would you your yes no experience years year open").split(" "));
/** Spellings a question and a memory write differently (28/10: "on-call duty?" vs "on call rotation", "Golang" vs "Go"). */
const QUESTION_VARIANTS: Record<string, string[]> = { oncall: ["call"], golang: ["go"], go: ["golang"], k8s: ["kubernetes"], kubernetes: ["k8s"],
  postgres: ["postgresql"], postgresql: ["postgres"], js: ["javascript"], javascript: ["js"], ts: ["typescript"], typescript: ["ts"],
  // Plan clipboard:7L5KyWp3kQsP step 3 (1/11: Heritage asked "GPA" while Job memory said "grades"; "grade point average", "degree/final grade" split to grade).
  gpa: ["grade", "grades"], grade: ["gpa", "grades"], grades: ["gpa", "grade"], dob: ["birth", "birthday"], birth: ["dob", "birthday"], birthday: ["birth", "dob"] };

/**
 * Queue item 34: the words of a copilot question worth looking up in its memory, with their usual variants (every one since 31/10): "Are you open to
 * on-call duty?" → oncall, call, duty; "Kafka/Snowflake/Terraform?" → kafka, snowflake, terraform.
 */
export function questionMemoryTerms(question: string): string[] {
  const text = question.toLowerCase().replace(/\bon[\s-]+call\b/g, "oncall");
  const words = text.split(/[^\p{L}\p{N}+#]+/u).filter((word) => word.length >= 2 && !QUESTION_STOPWORDS.has(word));
  return [...new Set(words.flatMap((word) => [word, ...(QUESTION_VARIANTS[word] ?? [])]))];
}

export interface CopilotMemoryHit { source: string; id: string; key: string | null; text: string; updatedAt: string }

/**
 * The query's words as ILIKE patterns: every word of 2+ characters that is not a filler word (until 31/10 the first 8; the split drops
 * %, _ and \, so no wildcard comes from a query).
 */
export function copilotMemoryPatterns(query: string): string[] {
  const words = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}@.+-]+/u).filter((word) => word.length >= 2 && !QUESTION_STOPWORDS.has(word)))];
  return words.map((word) => `%${word}%`);
}

/**
 * Nous's recall beyond Space Memory (Ask Last step 6, 2026-10-27: Nous asked the operator for a postal code Job Copilot memory had
 * held since 13/10). Every one of the owner's rows whose key or text holds the query's words, matching at least 0.3 of the best row's
 * words (a relevance floor, no count: until 31/10 the top 5 a table), the rows matching most words first, then the newest. Only id, key
 * and text are read: no sealed or secret-named column. `perTable` stays for a caller that wants a page.
 */
export async function searchCopilotMemories(client: PgClientLike, owner: string, query: string, perTable?: number): Promise<CopilotMemoryHit[]> {
  const patterns = copilotMemoryPatterns(query);
  if (!patterns.length) return [];
  const score = (expression: string) => `(SELECT count(*) FROM unnest($2::text[]) AS pattern WHERE ${expression} ILIKE pattern)`;
  const tables = COPILOT_MEMORY_SOURCES.map(({ table, label }, ord) => `(SELECT ${ord} AS ord, '${label}' AS source, id, key, text, to_json(updated_at)#>>'{}' AS updated_at,
      ${score("coalesce(key, '') || ' ' || text")} AS score FROM ${table}
    WHERE owner_user_id = $1 AND (coalesce(key, '') || ' ' || text) ILIKE ANY($2::text[]) ORDER BY score DESC, updated_at DESC LIMIT $3)`);
  const live = `(SELECT ${COPILOT_MEMORY_SOURCES.length} AS ord, 'Live personal memory' AS source, item->>'id' AS id, item->>'key' AS key, item->>'value' AS text, item->>'updatedAt' AS updated_at,
      ${score("(item->>'key') || ' ' || (item->>'value')")} AS score
    FROM live_personal_memory, jsonb_array_elements(CASE WHEN jsonb_typeof(value->'items') = 'array' THEN value->'items' ELSE '[]'::jsonb END) AS item
    WHERE owner_user_id = $1 AND ((item->>'key') || ' ' || (item->>'value')) ILIKE ANY($2::text[]) ORDER BY score DESC, updated_at DESC LIMIT $3)`;
  const signin = `(SELECT ${COPILOT_MEMORY_SOURCES.length + 1} AS ord, 'site sign-in ' || site AS source,
      site || ':' || account_label AS id, site AS key, (record - 'history')::text AS text, to_json(updated_at)#>>'{}' AS updated_at,
      ${score("site || ' ' || (record - 'history')::text")} AS score FROM site_sign_ins
      WHERE owner_user_id = $1 AND (site || ' ' || (record - 'history')::text) ILIKE ANY($2::text[]) ORDER BY score DESC, updated_at DESC LIMIT $3)`;
  const result = await client.query<{ source: string; id: string; key: string | null; text: string; updated_at: string | null; score: string | number }>(
    `SELECT * FROM (${[...tables, live, signin].join("\nUNION ALL\n")}) AS hits ORDER BY ord, score DESC, updated_at DESC`, [owner, patterns, perTable ?? null]);
  const best = Math.max(0, ...result.rows.map((row) => Number(row.score)));
  return result.rows.filter((row) => Number(row.score) >= best * 0.3)
    .map((row) => ({ source: row.source, id: row.id, key: row.key, text: row.text, updatedAt: row.updated_at ?? "" }));
}

/** R12-5: the memories worth checking before a copilot raises a review or a question (websearch syntax: any of the words). */
export const COPILOT_NEVER_QUERY = "never or no or not or don't or ποτέ or ποτε or όχι or οχι or μην or δεν or καμία or καμια or κανένα or κανενα or κανείς or κανεις or ουδέποτε or ουδεποτε";
// Nous 1/11 (flmem:Gs0w0eSD8Cuy "no reply yet" refused Cleo/Dana's Upwork review): a status ("yet", "so far", "received") is no rule.
const NEVER_RAISE = /\b(?:never|no|not|don'?t|do not)\s+(?:(?:a|an|any|send|write|raise|ask|make)\s+){0,2}(?:reply|replies|draft|drafts|review|reviews|question|questions|notification|notifications|thank-you|card|cards)\b(?!\s+(?:yet|so\s+far|received)\b)/iu;
/** R13-5: Greek negations and acts, read case- and accent-folded («Καμία απάντηση», «μην ρωτάς», «δεν θέλω ειδοποίηση»). */
const GREEK_RAISE = /(?:^|[^\p{L}])(?:ποτε|οχι|μην|δεν|καμια|κανενα|κανεις|ουδεποτε)\s+(?:\p{L}+\s+){0,2}?(?:απαντ|προχειρ|ελεγχ|ερωτ|ρωτ|ειδοποι)/u;
const BAN_WORDS = new Set(("never not don reply replies draft drafts review reviews request requests question questions notification notifications raise ask card cards send write "
  + "ποτε οχι μην δεν καμια κανενα κανεις ουδεποτε απαντηση απαντας απαντα προχειρο ελεγχος ερωτηση ρωτας ειδοποιηση και για που την τον της του στο στη απο αυτο").split(" "));
/** R16-10 (29/10 19:33 BKK: «ζητά» and «τις» alone matched): Greek and English function words never count as shared words (folded). */
const FUNCTION_WORDS = new Set(("τις των τους στις στους στην στον στα στο μας σας ειναι εχει εχουν θελει θελω ζητα ζηταει ζητησε ζητουν κανει κανω "
  + "οτι οταν αλλα ομως μονο ολα ολες ολοι αυτη αυτα αυτες αυτοι αυτου αυτης αυτων εδω εκει πως πολυ πιο ακομα ηδη μεσα μετα πριν χωρις κατα προς "
  + "also about after all but into just more need needs only other over same some such than then them there these they those very want wants asks asked "
  + "new one get got via per out here now just been being").split(" "));
const fold = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
const contentWords = (text: string) => new Set(fold(text).split(/[^\p{L}\p{N}]+/u)
  .filter((word) => word.length >= 3 && !QUESTION_STOPWORDS.has(word) && !BAN_WORDS.has(word) && !FUNCTION_WORDS.has(word)));
/**
 * R16-10: what a memory is scoped to by its own words: item ids (`mktpost:6833N9ggK1om`, or a bare 12-character id with a digit; a
 * memory's own `*mem:` ids are references, not scope) and mail addresses. Prefixed ids also count by their bare part.
 */
function namedScope(text: string): { ids: Set<string>; addresses: Set<string> } {
  const ids = new Set<string>();
  for (const token of text.split(/[^A-Za-z0-9_:-]+/)) {
    const prefixed = /^([a-z]+):([A-Za-z0-9_-]{8,})$/.exec(token);
    if (prefixed && !prefixed[1]!.endsWith("mem")) ids.add(token).add(prefixed[2]!);
    else if (/^[A-Za-z0-9_-]{12}$/.test(token) && /\d/.test(token) && /[A-Za-z]/.test(token)) ids.add(token);
  }
  return { ids, addresses: new Set((text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []).map((address) => address.toLowerCase())) };
}
/** Step 3 (jobmem:S60Ur8lh8uZK "never ask the operator for … grades or GPA"): "never ask" forbids a question whatever it asks about. */
const NEVER_ASK = /\b(?:never|don'?t|do not)\s+ask\b/iu;
const forbids = (text: string) => NEVER_RAISE.test(text) || NEVER_ASK.test(text) || GREEK_RAISE.test(fold(text));
/** The item's words with their usual variants (QUESTION_VARIANTS), so "GPA" meets a memory about grades. */
const withVariants = (words: Set<string>) => new Set([...words].flatMap((word) => [word, ...(QUESTION_VARIANTS[word] ?? [])]));
/** Step 3: how many of a copilot question's own words a text holds (a variant counts for its word), and their share of the question's words. */
export const questionWordMatch = (question: string, text: string): { matched: number; share: number } => {
  const words = contentWords(text);
  const asked = [...contentWords(question)];
  const matched = asked.filter((word) => [word, ...(QUESTION_VARIANTS[word] ?? [])].some((form) => words.has(form))).length;
  return { matched, share: asked.length ? matched / asked.length : 0 };
};
/**
 * Nous 1/11 (plan EiYT0BvsSw8Y: flmem:XEkern-eQTJa "Upwork proposals sent (6), snapshot 2026-10-17 ... no reply", after flmem:Gs0w0eSD8Cuy's
 * "no reply yet"): "no reply" reads the same in a status line and a rule, so the memory's kind decides. Only these kinds hold rules.
 */
const RULE_MEMORY_KINDS: ReadonlySet<string> = new Set(["LESSON", "PREFERENCE", "CHANNEL_RULE"]);

/**
 * R12-5 (29/10 09:16 BKK: review mailrev:zTKfA_IVEmwC, a Telnyx thank-you, reached Needs you while mailmem:HkyoywEn0sDc said "no draft, no
 * review request, no question, never a notification"): the copilot's own memory that forbids raising this item, or null. A memory forbids
 * when it says never/no + reply, draft, review, question or notification and shares a word with the item (two words when it is not
 * scoped to the item's correspondent, channel or company). `list` is the copilot's memory search; `scoped` tells a scoped memory;
 * `about` holds the item's own ids and addresses (its id, the mail account and correspondent). Only a rule kind (`RULE_MEMORY_KINDS`) may
 * forbid: a FACT, CLIENT or other record says what happened, never what to do.
 */
export async function forbiddingMemory<T extends { id: string; kind?: string; key?: string | null; text: string }>(list: (query: string) => Promise<T[]>, item: string,
  scoped: (memory: T) => boolean = () => false, about: readonly string[] = []): Promise<T | null> {
  const words = withVariants(contentWords(item));
  // R16-10: a memory naming item ids or addresses (Cleo/Kate 18:17: other posts' ids; Cleo/Emma 19:33: another account) speaks only of them.
  const own = namedScope(`${about.join(" ")} ${item}`);
  const elsewhere = (named: Set<string>, mine: Set<string>) => named.size > 0 && ![...named].some((value) => mine.has(value));
  return (await list(COPILOT_NEVER_QUERY)).find((memory) => {
    if (memory.kind !== undefined && !RULE_MEMORY_KINDS.has(memory.kind)) return false;
    const text = `${memory.key ?? ""} ${memory.text}`;
    const scope = namedScope(text);
    return forbids(text) && !elsewhere(scope.ids, own.ids) && !elsewhere(scope.addresses, own.addresses)
      && [...contentWords(text)].filter((word) => words.has(word)).length >= (scoped(memory) ? 1 : 2);
  }) ?? null;
}

/** The refusal an agent reads: the memory id and its text, which is the habit to apply instead. */
export const forbiddenByMemoryText = (copilot: string, memory: { id: string; text: string }) =>
  `Not raised: ${copilot} memory ${memory.id} forbids it ("${memory.text.replace(/\s+/g, " ")}"). Apply that memory instead; nothing was recorded.`;

/**
 * R13-5 (queue item 34 for every copilot): the copilot's own memories that may already answer a question, by its words and their
 * variants (`questionMemoryTerms`), the ones matching most words first, every one whole (until 31/10 the top 5, 300 characters each).
 * `list` is the copilot's memory search for one word.
 */
export async function questionMemoryHits<T extends { id: string; key?: string | null; text: string }>(list: (term: string) => Promise<T[]>, question: string):
  Promise<Array<{ id: string; key: string | null; text: string }>> {
  const found = new Map<string, { memory: T; hits: number }>();
  for (const term of questionMemoryTerms(question)) for (const memory of await list(term)) found.set(memory.id, { memory, hits: (found.get(memory.id)?.hits ?? 0) + 1 });
  return [...found.values()].sort((left, right) => right.hits - left.hits).map(({ memory }) => ({ id: memory.id, key: memory.key ?? null, text: memory.text }));
}
export const MEMORY_HITS_NOTE = "Nothing was asked yet: your memory may already answer this. If one of these fits, answer from it; if none does, ask again with afterMemory: true.";
