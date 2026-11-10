import { z } from "zod";

export const sharedMemoryContentSchema = z.object({
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(2_000),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).default([])
}).strict();
export type SharedMemoryContent = z.infer<typeof sharedMemoryContentSchema>;
export const sharedMemoryStatusSchema = z.enum(["PROPOSED", "ACTIVE", "RETIRED"]);
export const sharedMemoryEntrySchema = sharedMemoryContentSchema.extend({
  id: z.string().min(1), teamId: z.string().min(1), source: z.enum(["SEED", "NOUS", "ADMIN"]), status: sharedMemoryStatusSchema,
  introducedVersion: z.string(), seedKey: z.string().nullable(), seedHash: z.string().nullable(), adminModified: z.boolean(),
  createdBy: z.string(), updatedBy: z.string(), createdAt: z.string(), updatedAt: z.string(), revision: z.number().int().positive(), deleted: z.boolean()
});
export type SharedMemoryEntry = z.infer<typeof sharedMemoryEntrySchema>;
export const sharedMemoryPolicySchema = z.object({ autoApprove: z.boolean(), dailyUpgrade: z.boolean(), lastDailyDay: z.string().nullable() }).strict();
export type SharedMemoryPolicy = z.infer<typeof sharedMemoryPolicySchema>;
export const sharedMemorySeedEntrySchema = sharedMemoryContentSchema.extend({ key: z.string().regex(/^[a-z][a-z0-9-]{1,79}$/) }).strict();
export type SharedMemorySeedEntry = z.infer<typeof sharedMemorySeedEntrySchema>;
const releaseNumber = "(?:0|[1-9]\\d*)";
const releaseIdentifier = `(?:${releaseNumber}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
export const sharedMemoryReleaseVersionSchema = z.string().max(128).regex(new RegExp(`^${releaseNumber}\\.${releaseNumber}\\.${releaseNumber}(?:-${releaseIdentifier}(?:\\.${releaseIdentifier})*)?$`));
export const sharedMemorySeedSchema = z.object({ schemaVersion: z.literal(1), releaseVersion: sharedMemoryReleaseVersionSchema, reviewedAt: z.string().datetime(), entries: z.array(sharedMemorySeedEntrySchema).max(100) }).strict();

// Conservative shared-data boundary, deliberately stricter than private Space Memory redaction.
// Contextual privacy still needs admin review. A refusal quotes only the words that read as names and the money and private-fact
// phrases; contacts, hosts, secrets and listed names (an address's "alice") are named by place (field and word number), never echoed.
const QUOTED = new Set(["money", "private facts or mail"]);
const genericCapitals = new Set(`I Nous Νους SpaceApp Greek Identity Working Rules Evidence Verify Read Before After When If Once Every Never Always Only Use Find Answer Report Work Give One Goals Ask A An The This That Keep Save Check Do Each No Shared Memory Task Tasks Admin ACTIVE PROPOSED RETIRED`.split(" "));
const screens: Array<[string, RegExp]> = [
  ["hidden characters", /[\p{Cf}\p{Cc}]/u],
  ["contact details", /@|\b(?:at|dot)\b(?=\s*[\])}])|\(\s*(?:at|dot)\s*\)|\+?\d[\d\s().-]{6,}\d/i],
  ["hosts or addresses", /https?:|www\.|\b(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)+)\b|\b[\da-f]{0,4}:[\da-f:]+:[\da-f:]+\b/i],
  ["secrets", /\b(?:api[ _-]?key|password|passphrase|secret|token|cookie|authorization|bearer|private[ _-]?key)\b\s*[:=]|\b(?:sk|ghp|github_pat|xox[baprs])[-_][\w-]+|-----BEGIN|\b[A-Za-z0-9_+/=-]{32,}\b/i],
  ["secrets", /\b(?:password|passphrase|api[ _-]?key|access[ _-]?token|secret)\b\s+(?:is|was|equals|value|for)\b|\bas\s+(?:the\s+)?(?:password|passphrase|api[ _-]?key|access[ _-]?token)\b/i],
  ["money", /\b(?:owes?|owed|paid|costs?|priced?|earned|charged|sold|bought|salary|revenue)\s+(?:is\s+|was\s+|of\s+)?\d/i],
  ["money", /[$€£¥₹₽₿]|\b(?:usd|eur|gbp|euros?|dollars?|pounds?|baht|thb|btc|usdt)\b|\b(?:price|salary|balance|budget|revenue|profit|discount|invoice|payment|contract value)\b/i],
  ["private facts or mail", /\b(?:our|my|your|their)\s+(?:company|business|customer|client|account|employee|supplier|contract|mail|email|address|phone|name)\b|\b(?:confidential|inc\.?|ltd\.?|llc|gmbh)\b|(?:^|\n)\s*(?:from|to|subject|dear|sent):|\b(?:company|customer|client|employee|person|name)\s+(?:is|called|named)\b/i],
  ["personal names", /\b(?:alice|bob|charlie|john|jane|smith|alex|iris|maria|george|dimitris|γιάννης|δημήτρης|μαρία)\b/iu]
];
export function screenSharedMemory(input: SharedMemoryContent): { ok: true } | { ok: false; reason: string } {
  const parsed = sharedMemoryContentSchema.safeParse({ title: input.title, body: input.body, tags: input.tags });
  if (!parsed.success) return { ok: false, reason: "Invalid shared memory content." };
  const fields: Array<[string, string]> = [["title", parsed.data.title.normalize("NFKC")], ["body", parsed.data.body.normalize("NFKC")],
    ...parsed.data.tags.map((tag, i): [string, string] => [`tag ${i + 1}`, tag.normalize("NFKC")])];
  const text = fields.map(([, value]) => value).join("\n");
  // A match inside a word (the "@" of an address) names that word.
  const place = (field: string, value: string, index: number) => `${field} word ${(value.slice(0, value.slice(0, index).search(/[\p{L}\p{M}]*$/u)).match(/\p{L}[\p{L}\p{M}]*/gu) ?? []).length + 1}`;
  const spot = (index: number): [string, string, number] => {
    let start = 0;
    for (const [field, value] of fields) { if (index <= start + value.length) return [field, value, index - start]; start += value.length + 1; }
    return [...fields.at(-1)!, 0];
  };
  // 4/11 R64 (the 3/11 21:07 UTC proposal was refused "cannot contain contact details" with no place): every screen that trips says where,
  // in one refusal, so one retry passes. Newlines are allowed between sentences, other control characters are not.
  const tripped: string[] = [];
  for (const [reason, pattern] of screens) {
    const found = new Set<string>();
    for (const match of text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))) {
      if (reason === "hidden characters" && match[0] === "\n") continue;
      const [field, value, at] = spot(match.index + match[0].length - match[0].trimStart().length);
      found.add(reason === "hidden characters" ? `${place(field, value, at)} U+${match[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`
        : QUOTED.has(reason) ? `${place(field, value, at)} "${match[0].trim()}"` : place(field, value, at));
    }
    if (found.size) tripped.push(`${reason} (${[...found].join(", ")})`);
  }
  // Lowercase text must not bypass common person/provider introductions. Keep generic role and method nouns admissible.
  const genericObjects = new Set("the a an for again permission approval confirmation questions whether how why what when to before after only once user operator administrator admin team member members colleague person people owner evidence tools tool memory notes files database git sources result results task tasks list plan plans instructions guidance generic reusable shared it this that them me us yourself".split(" "));
  // A function word after the verb means a noun use ("the same call later", "make use of the item"; 2/11 false refusals): never a name,
  // but after a preposition the next word is the object and must be generic ("make use of <name>" stays refused).
  const prepositions = new Set("about across against around at behind below between by during from in inside into of off on onto over per since through under until upon via with within without".split(" "));
  const functionWords = new Set([...prepositions, ..."all also and another any as away back because both but down each either else every first here instead its last later less more most much next no none nor not now or other out own so some soon such than then there these those today together too up yet is are was were be been being has have had does did can cannot could should would must which who where while they he she you we his her our your their my".split(" ")]);
  const generic = (word: string) => genericObjects.has(word.toLowerCase()) || genericCapitals.has(word) || functionWords.has(word.toLowerCase());
  const namedObject = /\b(?:ask|contact|email|call|tell|notify|message|meet|hire|pay|invite|use|choose|select|recommend)\s+(\p{L}[\p{L}\p{M}]*)\b(?=(?:\s+(\p{L}[\p{L}\p{M}]*))?)/giu;
  // The refusal names every word that reads as a name, where it is and the word itself (4/11 REVIEW: 9 of 21 proposals refused, one word per retry;
  // the words are Nous's own, already in its call), so one retry passes.
  const hits: string[] = [];
  const nameAt = (field: string, value: string, index: number) => {
    const hit = `${place(field, value, index)} "${/\p{L}[\p{L}\p{M}]*/u.exec(value.slice(index))?.[0] ?? ""}"`;
    if (!hits.includes(hit)) hits.push(hit);
  };
  for (const [field, value] of fields) {
    for (const match of value.matchAll(namedObject)) {
      const [, first, next] = match;
      const object = !genericObjects.has(first!.toLowerCase()) && prepositions.has(first!.toLowerCase()) && next ? next : first!;
      const at = match.index! + match[0].length - first!.length;
      if (!generic(object)) nameAt(field, value, object === first ? at : value.indexOf(object, at + first!.length));
    }
    for (const word of value.matchAll(/\p{L}[\p{L}\p{M}]*/gu)) if (/\p{Lu}/u.test(word[0]) && !genericCapitals.has(word[0])) nameAt(field, value, word.index!);
  }
  const named = hits.length ? `Use generic wording without personal or company names: ${hits.join(", ")} ${hits.length === 1 ? "reads as a name" : "read as names"}. A person, company, site or product: say its role instead (the operator, a supplier, a site); an ordinary word: write it in lower case (capitals are kept only for I, Nous, SpaceApp and a few sentence words).` : "";
  return tripped.length || named ? { ok: false, reason: [tripped.length ? `Shared memory cannot contain ${tripped.join("; ")}.` : "", named].filter(Boolean).join(" ") } : { ok: true };
}
