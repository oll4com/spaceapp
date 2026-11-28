import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import seed from "./space-memory-seed.json" with { type: "json" };
import { appendCanonicalMemoryBlocks, canonicalMemoryBlocks } from "./shared-state.js";
import { MONTHLY_MEMORY_FILE_PATTERN } from "./space-memory-files.js";

// Starter Space Memory (operator 27/11, plan clipboard:pt2ciFXsMqVa): generic help every new public install (Nous Cloud) starts with.
// The seed reaches other users' installs, so every entry must pass screenStarterMemory; the contracts-style JSON is reviewed by hand.
const line = z.string().trim().min(1).regex(/^[^\n\r]*$/);
const starterEntrySchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]{1,79}$/),
  revision: z.number().int().positive(),
  title: line.max(160),
  body: line.max(2_000),
  tags: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)).max(12)
}).strict();
const starterSeedSchema = z.object({ schemaVersion: z.literal(1), reviewedAt: z.string().datetime(), entries: z.array(starterEntrySchema).min(1) }).strict();
export type StarterMemorySeed = z.infer<typeof starterSeedSchema>;
export type StarterMemoryEntry = z.infer<typeof starterEntrySchema>;

// Names of people, businesses, places and hosts known from the operator's own server, as sha256 prefixes so this public code never spells them.
const PRIVATE_NAME_HASHES = new Set(("02b15ef87562 0357513deb90 0478721f1106 1238f9b0b9b5 23d75e318598 294aa8d75483 2aed12b734be 2c1773a84387 2c249473aa50 " +
  "2c9e0a2585dc 30a7b7798221 31611159e7e6 39a286e0ac74 4135aa9dc1b8 47612b3175fe 502bc02fb32b 5a3daafa0b71 5f761acdc3b7 6177321eac99 6710ac2b3a6f " +
  "67d18135ba3d 6a6e67c19018 6eadae2ba435 6ffec35d270f 74eccf25c222 7814459b3f23 79a0a449e775 7e8badc68a02 817a5d680929 81b637d8fcd2 8535e86c8118 " +
  "8fbefc95205d 91f9c2a6b282 960f98428570 9baf3a40312f 9bd2b91c240f 9d017e2681b7 b89bd502fced ba94f3933307 bcdb41bf84b5 be217770533f c1e84f7c3e4f " +
  "cbdd10d72000 ccc68482d9e0 d06a2778eb76 d20dbd6a870c d3a053245104 d93acc6c69ea df3853a05cfb e0e2087b3efa e353541817b6 efe5e72e147c f4aa0655cdb8 " +
  "f5a1971c2ef0 fca0927a0685").split(" "));
const sha12 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

const SCREENS: Array<[string, RegExp]> = [
  ["hidden characters", /[\p{Cf}\p{Cc}]/u],
  ["an email or @", /@/],
  ["a URL, host, domain or IP", /https?:|www\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b|\b[\da-f]{0,4}:[\da-f]{0,4}:[\da-f:]*\b/i],
  ["a key-like string", /\b(?:sk|ghp|gho|github_pat|xox[abprs]|AIza)[-_][\w-]{6,}|\bAKIA[0-9A-Z]{12,}|-----BEGIN|\bbearer\s+\S|\b[A-Za-z0-9_+/=-]{32,}|\b[\da-f]{16,}\b/i],
  ["a secret value", /\b(?:api[ _-]?key|password|passphrase|secret|token|cookie)\s*[:=]/i],
  ["a phone number", /\+?\d[\d\s().-]{6,}\d/],
  ["money or prices", /[$€£¥₹₽₿฿]|\b(?:usd|eur|gbp|euros?|dollars?|baht|thb|btc|usdt|price[sd]?|salary|invoice|revenue)\b/i],
  ["an internal id", /\b(?:clipboard|space_memory|room|pane|nous_msg|plan|goal|ticket):[A-Za-z0-9_-]{4,}|\bq-\d{8}|\bvm\s?\d{2,}\b/i]
];

/** The reasons a starter entry may not ship to other users' installs (empty when it may). */
export function screenStarterMemory(entry: Pick<StarterMemoryEntry, "title" | "body" | "tags">): string[] {
  const text = [entry.title, entry.body, ...entry.tags].join("\n").normalize("NFKC");
  const found = SCREENS.filter(([, pattern]) => pattern.test(text.replace(/\n/g, " "))).map(([reason]) => reason);
  const names = [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => PRIVATE_NAME_HASHES.has(sha12(word))))];
  return names.length ? [...found, `a private name (${names.join(", ")})`] : found;
}

/** The seed, refused whole when a key repeats or any entry fails the privacy screen. */
export function parseStarterMemorySeed(raw: unknown = seed): StarterMemorySeed {
  const parsed = starterSeedSchema.parse(raw);
  const keys = new Set<string>();
  for (const entry of parsed.entries) {
    if (keys.has(entry.key)) throw new Error(`Starter Space Memory key ${entry.key} repeats.`);
    keys.add(entry.key);
    const problems = screenStarterMemory(entry);
    if (problems.length) throw new Error(`Starter Space Memory entry ${entry.key} contains ${problems.join("; ")}.`);
  }
  return parsed;
}

/** One id per key and revision on every install, so a re-run finds the block it added and a new revision is a new block. */
export function starterMemoryId(key: string, revision: number): string {
  return `space_memory:${createHash("sha256").update(`space-memory-seed:${key}:${revision}`).digest("hex").slice(0, 24)}`;
}

/** The canonical block (same layout as a memory.save); a later revision names the earlier ones with supersedes= so the reader hides them. */
export function starterMemoryBlock(entry: StarterMemoryEntry, createdAt: string): string {
  const older = Array.from({ length: entry.revision - 1 }, (_, n) => `supersedes=${starterMemoryId(entry.key, n + 1)}`);
  return [
    `<!-- space-memory:id=${starterMemoryId(entry.key, entry.revision)} -->`,
    `## ${createdAt.slice(0, 10)} - Space canonical memory: ${entry.title}`,
    "",
    `- Source: SpaceApp starter memory; original_scope=SYSTEM; provenance=starter:${entry.key}; trace=none.`,
    `- created_at=${createdAt}`,
    ...(entry.tags.length ? [`- Tags: ${entry.tags.join(", ")}`] : []),
    ...(older.length ? [`- Replaces: ${older.join(", ")}`] : []),
    `- ${entry.body}`,
    ""
  ].join("\n");
}

/**
 * Appends the starter entries this install lacks (by id, in any month file beside monthlyPath). Never rewrites or removes a block:
 * the user's own memories and their edits of a starter entry stay as they are.
 */
export async function seedStarterSpaceMemory(monthlyPath: string, raw: unknown = seed): Promise<{ added: number }> {
  const parsed = parseStarterMemorySeed(raw);
  const directory = dirname(monthlyPath);
  const have = new Set<string>();
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    if (!MONTHLY_MEMORY_FILE_PATTERN.test(name)) continue;
    for (const id of canonicalMemoryBlocks(await readFile(join(directory, name), "utf8").catch(() => "")).keys()) have.add(id);
  }
  const blocks = parsed.entries.filter((entry) => !have.has(starterMemoryId(entry.key, entry.revision)))
    .map((entry) => starterMemoryBlock(entry, parsed.reviewedAt));
  return blocks.length ? appendCanonicalMemoryBlocks(monthlyPath, blocks) : { added: 0 };
}
