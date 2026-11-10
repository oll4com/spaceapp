import { createHash } from "node:crypto";
import type { NousNote } from "@space/db";
import { fitWhole, foldWords, NOUS_RETRIEVED_SECTION_CHARS } from "./retrieval.js";
import { nousProtectedNote } from "./memory-authority.js";

/**
 * Nous's lessons as a memory (operator 31/10 16:25 BKK «Από εκατοντάδες σημειώσεις βλέπω μόνο τις 5 πιο πρόσφατες… φτιάξε μια νέα λογική
 * τύπου space μνήμη… Σταμάτα να βάζεις αυθαίρετα όρια!!!»; RCA ~/agent-workspace/active/20261031-nous-repeat-rca/rca.md): every repeat of
 * 31/10 had its lesson written hours earlier and pushed out of a newest-3,000-character digest. Every `lessons*` note (the record stays in
 * nous_notes) is found by relevance instead: rare shared words (accent-folded: the operator often types without accents) and Space
 * Memory's bge-m3 vectors. No count or age cap; the only bound is the turn's context, filled in rank order.
 */
/** bge-m3 cosine for "about this": unrelated texts top out at 0.44-0.52 against medians 0.31-0.50, related lessons 0.58-0.71 (31/10). */
const VECTOR_FLOOR = 0.55;
const VECTOR_ABOVE_MEDIAN = 0.10;
/** A keyword match counts only at half the best one's score or more (the keyword half is the fallback before vectors). */
const KEYWORD_RELATIVE_FLOOR = 0.5;
/** A lesson sharing the ask's words also counts when its meaning is this far above the median, short of the floor (stable 31/10: a short
 * approval ask scored lessons-1031-allowances-ask 0.50-0.56 against floors of 0.55-0.58, so the lesson about exactly that ask was not held). */
const KEYWORD_NEAR_MEDIAN = 0.05;
/** Two lessons of one cause: 0.746-0.775 measured (slow/three-minutes, done-unreported/pending-never-done, the two Requests lessons). */
export const NOUS_LESSON_SAME_CAUSE = 0.74;
const QUERY_WAIT_MS = 3_000;
const BATCH = 16;
/** After a failed embedding run the index waits this long before it tries again (keywords meanwhile), so a down gateway is not asked every turn. */
const RETRY_MS = 10 * 60_000;
/** The answer within `ms`, else null (the work goes on in the background). */
async function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); timer.unref?.(); });
  try { return await Promise.race([work, late]); } finally { clearTimeout(timer); }
}
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
export const isLessonNote = (key: string) => /^lessons(?:-|$)/.test(key);
const lessonText = (note: NousNote) => `${note.key}\n${note.text}`.slice(0, 10_000);
const hashOf = (note: NousNote) => createHash("sha256").update(lessonText(note)).digest("hex");
/** An answer that says the work is done, ready or fixed (Greek and English, accents folded). */
export const NOUS_DONE_CLAIM = /\b(?:done|ready|fixed|shipped|deployed|works now|is live)\b|εγινε|ετοιμ|διορθω|φτιαχτηκε|φτιαξαμε|ολοκληρωθηκε|δουλευει πια|λειτουργει πια/;
export const claimsDone = (text: string) => NOUS_DONE_CLAIM.test(fold(text));

export interface LessonMatch { key: string; text: string; updatedAt: string; similarity: number | null; shared: string[] }

/** Lessons sharing at least 3 rare words worth 1.5 × ln(N+1) with `text`, best first (the keyword half of the recall). */
export function keywordLessons(lessons: NousNote[], text: string): Array<{ note: NousNote; score: number; shared: string[] }> {
  const docs = lessons.map((note) => {
    const list = foldWords(`${note.key.replace(/^lessons-?\d*-?/, "").replace(/-/g, " ")} ${note.text}`);
    return { note, set: new Set(list), size: list.length };
  });
  const query = new Set(foldWords(text));
  if (!docs.length || query.size < 2) return [];
  const df = new Map<string, number>();
  for (const doc of docs) for (const word of doc.set) df.set(word, (df.get(word) ?? 0) + 1);
  const floor = 1.5 * Math.log(docs.length + 1);
  const scored = docs.map((doc) => {
    const shared = [...query].filter((word) => doc.set.has(word));
    // A long lesson (a daily review) counts its words less, so it does not match every text.
    const score = shared.reduce((sum, word) => sum + Math.log((docs.length + 1) / ((df.get(word) ?? 0) + 1)), 0) * Math.min(1, Math.sqrt(120 / Math.max(1, doc.size)));
    return { note: doc.note, score, shared };
  }).filter((match) => match.shared.length >= 3 && match.score >= floor);
  // Stable 31/10 (step 5): a long ask shares mid-frequency words with most lessons (17 of 30, holds of 67 lessons), so a keyword
  // match must also score half the best one.
  const best = Math.max(0, ...scored.map((match) => match.score));
  return scored.filter((match) => match.score >= best * KEYWORD_RELATIVE_FLOOR).sort((left, right) => right.score - left.score);
}

export const cosine = (left: Float32Array, right: Float32Array) => {
  let dot = 0, a = 0, b = 0;
  for (let index = 0; index < left.length; index++) { dot += left[index]! * right[index]!; a += left[index]! ** 2; b += right[index]! ** 2; }
  return a && b ? dot / Math.sqrt(a * b) : 0;
};

/** Each matched lesson whole, in rank order, as far as the turn's context share goes (retrieval.ts); the lessons past it are named for space_lessons. */
export function renderLessons(matches: LessonMatch[], matchedTo: string, budget = NOUS_RETRIEVED_SECTION_CHARS): string {
  if (!matches.length) return "";
  return [`## Your lessons about this (your memory of the operator's corrections, matched to ${matchedTo}, most relevant first: he corrected you on exactly this before; follow them)`,
    ...fitWhole(matches.map((match) => ({ whole: `- [${match.key}]${match.similarity !== null ? ` (${match.similarity.toFixed(2)})` : ""} ${match.text.trim()}`, name: match.key })),
      "space_lessons {\"query\": …} reads them", budget)].join("\n");
}

export interface NousLessonsDeps {
  notes(owner: string): Promise<NousNote[]>;
  /** Space Memory's embeddings (bge-m3 on Space Gateway's local CPU model); absent or failing: keywords alone. */
  embed?(texts: string[], purpose: "document" | "query"): Promise<number[][]>;
  setNote?(owner: string, key: string, text: string | null): Promise<void>;
  warn?(error: unknown, message: string): void;
  queryWaitMs?: number;
}

export function createNousLessons(deps: NousLessonsDeps) {
  // shortcut: vectors live in the API's memory and are rebuilt after a restart (about 0.2 s a lesson, a minute for 300; the notes are the
  // record); move them to a table if lessons pass a few thousand.
  const vectors = new Map<string, Map<string, { hash: string; vector: Float32Array }>>();
  const syncing = new Map<string, Promise<void>>();
  const failedAt = new Map<string, number>();
  const lessonsOf = async (owner: string, notes?: NousNote[]) => (notes ?? await deps.notes(owner)).filter((note) => isLessonNote(note.key));

  async function runSync(owner: string, lessons: NousNote[]) {
    const index = vectors.get(owner) ?? new Map<string, { hash: string; vector: Float32Array }>();
    vectors.set(owner, index);
    const current = new Set(lessons.map((note) => note.key));
    for (const key of index.keys()) if (!current.has(key)) index.delete(key);
    const missing = lessons.filter((note) => index.get(note.key)?.hash !== hashOf(note));
    for (let start = 0; start < missing.length; start += BATCH) {
      const batch = missing.slice(start, start + BATCH);
      const embedded = await deps.embed!(batch.map(lessonText), "document");
      if (embedded.length !== batch.length) throw new Error("Lesson embedding batch was incomplete.");
      batch.forEach((note, position) => index.set(note.key, { hash: hashOf(note), vector: Float32Array.from(embedded[position]!) }));
    }
  }
  /** Embeds the lessons that have no current vector (new, changed), in the background; one run per owner at a time. */
  function sync(owner: string, lessons: NousNote[]): Promise<void> {
    if (!deps.embed || Date.now() - (failedAt.get(owner) ?? 0) < RETRY_MS) return Promise.resolve();
    const running = syncing.get(owner);
    if (running) return running;
    const run = runSync(owner, lessons).then(() => { failedAt.delete(owner); }, (error) => {
      failedAt.set(owner, Date.now());
      deps.warn?.(error, "Nous lessons could not be embedded; keywords still find them.");
    }).finally(() => syncing.delete(owner));
    syncing.set(owner, run);
    return run;
  }
  async function queryVector(text: string): Promise<Float32Array | null> {
    if (!deps.embed) return null;
    const embedded = await within(deps.embed([text.slice(0, 4_000)], "query").then((rows) => rows[0] ?? null).catch(() => null), deps.queryWaitMs ?? QUERY_WAIT_MS);
    return embedded ? Float32Array.from(embedded) : null;
  }

  /** Every lesson relevant to `text`, best first: vector hits by similarity, then keyword-only hits. No count cap. */
  async function recall(owner: string, text: string, notes?: NousNote[]): Promise<LessonMatch[]> {
    const lessons = await lessonsOf(owner, notes);
    if (!lessons.length || !text.trim()) return [];
    void sync(owner, lessons);
    const query = await queryVector(text);
    const index = vectors.get(owner);
    const scored = query && index ? lessons.flatMap((note) => {
      const entry = index.get(note.key);
      return entry && entry.hash === hashOf(note) ? [{ note, similarity: cosine(query, entry.vector) }] : [];
    }) : [];
    // Meaning decides wherever a vector exists (stable 31/10: keywords over a long ask matched 57 % of the lessons, holds named 67). Keywords
    // stand in only where meaning is unavailable: no embedder, a failed embedding, or a lesson saved since the index was built; while the
    // first index is being built (about a minute after a start) nothing is recalled rather than noise. Words and near meaning together
    // also count (KEYWORD_NEAR_MEDIAN).
    const similarityOf = new Map(scored.map((entry) => [entry.note.key, entry.similarity]));
    const meaningless = !deps.embed || !query || failedAt.has(owner);
    const building = !meaningless && !index?.size;
    const sorted = scored.map((entry) => entry.similarity).sort((left, right) => left - right);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const floor = Math.max(VECTOR_FLOOR, median + VECTOR_ABOVE_MEDIAN);
    const keyword = building ? [] : keywordLessons(lessons, text).filter((match) => {
      const near = similarityOf.get(match.note.key);
      return meaningless || near === undefined || near >= median + KEYWORD_NEAR_MEDIAN;
    });
    const byVector = scored.filter((entry) => entry.similarity >= floor).sort((left, right) => right.similarity - left.similarity);
    const sharedOf = new Map(keyword.map((match) => [match.note.key, match.shared]));
    const seen = new Set(byVector.map((entry) => entry.note.key));
    return [
      ...byVector.map(({ note, similarity }) => ({ key: note.key, text: note.text, updatedAt: note.updatedAt, similarity, shared: sharedOf.get(note.key) ?? [] })),
      ...keyword.filter((match) => !seen.has(match.note.key)).map(({ note, shared }) => ({ key: note.key, text: note.text, updatedAt: note.updatedAt, similarity: similarityOf.get(note.key) ?? null, shared }))
    ];
  }

  /** The existing lesson a new text repeats (same cause: cosine ≥ 0.74 with its vector), or null; never the key itself. */
  async function sameCause(owner: string, key: string, text: string): Promise<{ key: string; text: string; similarity: number } | null> {
    if (!deps.embed) return null;
    const all = await lessonsOf(owner);
    // Rewriting an existing lesson is never a merge.
    if (all.some((note) => note.key === key)) return null;
    const lessons = all;
    // The first look after a start embeds every lesson (about a minute for 300): the save goes on with what is ready after 15 s.
    await within(sync(owner, lessons), 15_000);
    const index = vectors.get(owner);
    if (!index?.size) return null;
    const embedded = await deps.embed([`${key}\n${text}`.slice(0, 10_000)], "document").catch(() => null);
    if (!embedded?.[0]) return null;
    const vector = Float32Array.from(embedded[0]);
    const best = lessons.map((note) => ({ note, entry: index.get(note.key) })).filter((item) => item.entry?.hash === hashOf(item.note))
      .map((item) => ({ key: item.note.key, text: item.note.text, similarity: cosine(vector, item.entry!.vector) })).sort((left, right) => right.similarity - left.similarity)[0];
    return best && best.similarity >= NOUS_LESSON_SAME_CAUSE ? best : null;
  }

  /** Groups of existing lessons of one cause (cosine ≥ 0.74 to the group's first, newest first), for space_lessons and the daily review. */
  async function duplicates(owner: string): Promise<Array<{ keys: string[]; similarity: number }>> {
    const lessons = await lessonsOf(owner);
    await within(sync(owner, lessons), 40_000);
    const index = vectors.get(owner);
    if (!index) return [];
    const ready = lessons.filter((note) => index.get(note.key)?.hash === hashOf(note)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const taken = new Set<string>();
    const groups: Array<{ keys: string[]; similarity: number }> = [];
    for (const head of ready) {
      if (taken.has(head.key)) continue;
      const members = ready.filter((note) => note.key !== head.key && !taken.has(note.key))
        .map((note) => ({ key: note.key, similarity: cosine(index.get(head.key)!.vector, index.get(note.key)!.vector) })).filter((item) => item.similarity >= NOUS_LESSON_SAME_CAUSE);
      if (!members.length) continue;
      taken.add(head.key);
      for (const member of members) taken.add(member.key);
      groups.push({ keys: [head.key, ...members.map((member) => member.key)], similarity: Math.min(...members.map((member) => member.similarity)) });
    }
    return groups;
  }

  /** Merges lessons of one cause: each source's text joins the target as an incident, then the source goes (its text is in the target first). */
  async function merge(owner: string, into: string, from: string[]): Promise<string> {
    if (!deps.setNote) throw new Error("Lessons cannot be written here.");
    const notes = await deps.notes(owner);
    const target = notes.find((note) => note.key === into && isLessonNote(note.key));
    if (!target) return `No lesson ${into}.`;
    const sources = from.filter((key) => key !== into).map((key) => notes.find((note) => note.key === key && isLessonNote(note.key)));
    const missing = from.filter((key, position) => key !== into && !sources[position]);
    const found = sources.filter((note): note is NousNote => Boolean(note));
    if (!found.length) return `Nothing merged: ${missing.join(", ") || "no source"} ${missing.length === 1 ? "is" : "are"} not a lesson.`;
    // 9/11 REVIEW (9 of 12 groups refused): the one operator instruction of a group is the target, so it keeps its own source and note.
    const kept = [target, ...found].filter((note) => nousProtectedNote(note.key, note.text));
    if (kept.length > 1) return `Nothing merged: operator instructions keep their own source and note (${kept.map((note) => note.key).join(", ")}); merge the others into one of them.`;
    const head = kept[0] ?? target;
    const rest = [target, ...found].filter((note) => note.key !== head.key);
    await deps.setNote(owner, head.key, [head.text.trim(), ...rest.map((note) => `--- Incident (merged from ${note.key}, ${note.createdAt ?? note.updatedAt}):\n${note.text.trim()}`)].join("\n\n"));
    for (const note of rest) await deps.setNote(owner, note.key, null);
    return `Merged ${rest.map((note) => note.key).join(", ")} into ${head.key}${head === target ? "" : ` (the operator's instruction stays the target, not ${into})`}.${missing.length ? ` Not lessons: ${missing.join(", ")}.` : ""}`;
  }

  return { recall,
    // API audit 5/11: callers fire and forget (`void lessons.sync`), so a failed notes read is warned here, never an unhandled rejection.
    sync: (owner: string) => lessonsOf(owner).then((lessons) => sync(owner, lessons), (error: unknown) => deps.warn?.(error, "Nous lessons could not be read; the next turn tries again.")), sameCause, duplicates, merge,
    count: async (owner: string, notes?: NousNote[]) => (await lessonsOf(owner, notes)).length };
}
export type NousLessons = ReturnType<typeof createNousLessons>;
