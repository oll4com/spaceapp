import { describe, expect, it } from "vitest";
import { memoryExcerpt, normalizeMemoryDates, normalizeMemoryQuery, memoryQueryTerms, memoryTermMatches, searchMemoryDocuments } from "../src/index.js";

const doc = (id: string, body: string, title = "Operational note") => ({
  id, title, body, provenance: "/opt/spaceapp/docs/gemini_history_2026-09.md", createdAt: "2026-09-05T00:00:00Z"
});

describe("shared operational recall", () => {
  it.each(["5 Σεπτεμβρίου 2026", "5 ΣΕΠΤΕΜΒΡΙΟΣ 2026", "September 5, 2026", "5 September 2026"])("normalizes the exact day in %s", date => {
    expect(normalizeMemoryDates(`backup ${date}`)).toBe("backup 2026-09-05");
  });
  it.each(["31 February 2026", "29 Φεβρουαρίου 2025", "5 MissingMonth 2026", "5 September 20260"])("preserves invalid/unknown dates: %s", date => {
    expect(normalizeMemoryDates(date)).toBe(date);
  });
  it("accepts leap days and retains Greek evidence unchanged", () => {
    expect(normalizeMemoryDates("29 Φεβρουαρίου 2024")).toBe("2024-02-29");
    const body = "Το αντίγραφο ασφαλείας της μνήμης βρίσκεται σε εξωτερικό storage.";
    const record = doc("memory:greek", body);
    expect(searchMemoryDocuments([record], "memory external backup")).toEqual([record]);
    expect(record.body).toBe(body);
    expect(memoryQueryTerms("Ποιο είναι το προεπιλεγμένο μοντέλο στην καθαρή εγκατάσταση;")).toEqual(["default", "model", "clean", "setup"]);
  });
  it.each([
    ["258000", "25800"], ["125800", "25800"], ["host2070", "host207"], ["xhost207", "host207"],
    ["203.0.113.104", "203.0.113.10"], ["1203.0.113.104", "203.0.113.104"],
    ["2026-09-05", "2026-09"], ["2026-09-050", "2026-09-05"]
  ])("does not confuse %s with identifier %s", (body, term) => {
    expect(memoryTermMatches(body, term)).toBe(false);
    expect(searchMemoryDocuments([doc("memory:numeric", `backup ${body}`)], `backup ${term}`)).toEqual([]);
  });
  it.each([["(HOST207)", "host207"], ["2026-09-05: verified", "2026-09-05"], ["IP 203.0.113.104.", "203.0.113.104"], ["203.0.113.104:4911", "203.0.113.104"], ["2026-09-05", "2026"]])("accepts identifier punctuation in %s", (text, term) => {
    expect(memoryTermMatches(normalizeMemoryQuery(text), term)).toBe(true);
  });
  it("requires identifiers even when a natural question permits partial lexical matches", () => {
    const rows = [doc("memory:backup", "HOST207 backups belong on external storage.")];
    expect(searchMemoryDocuments(rows, "Πώς αποθηκεύονται τα αντίγραφα ασφαλείας της HOST207;")).toHaveLength(1);
    expect(searchMemoryDocuments(rows, "Πώς αποθηκεύονται τα αντίγραφα ασφαλείας της HOST2070;")).toEqual([]);
  });
  it("does not treat short operational terms as parts of unrelated words", () => {
    expect(searchMemoryDocuments([doc("memory:other", "Clipboard Stripe")], "IP")).toEqual([]);
    expect(searchMemoryDocuments([doc("memory:other", "Clipboard Stripe renewed plans")], "IP new")).toEqual([]);
    expect(searchMemoryDocuments([doc("memory:ip", "New public IP: 192.0.2.1")], "IP new")).toHaveLength(1);
  });
  it("ranks complete coverage ahead of a title-heavy partial answer", () => {
    const partial = doc("memory:partial", "Deployment details", "Clipboard plan save");
    const complete = doc("memory:complete", "Clipboard plan save is never automatic; explicit opt-in is required.");
    expect(searchMemoryDocuments([partial, complete], "Πρέπει να αποθηκεύουμε αυτόματα τα πλάνα στο clipboard;")[0]?.id).toBe(complete.id);
  });
  it("prefers related terms in one passage over scattered mentions", () => {
    const scattered = doc("memory:scattered", `setup\n${"unrelated ".repeat(100)}\ndefault\n${"unrelated ".repeat(100)}\nmodel`, "OpenCode clean room");
    const focused = doc("memory:focused", "Clean setup default model for OpenCode is recorded here.", "OpenCode release");
    expect(searchMemoryDocuments([scattered, focused], "OpenCode clean setup default model")[0]?.id).toBe(focused.id);
  });
  it("invalidates cached normalized content when any searchable field changes", () => {
    const record = doc("memory:mutable", "oldbody", "oldtitle");
    expect(searchMemoryDocuments([record], "oldbody")).toHaveLength(1);
    record.body = "newbody"; record.title = "newtitle"; record.provenance = "newsource";
    expect(searchMemoryDocuments([record], "oldbody")).toEqual([]);
    expect(searchMemoryDocuments([record], "newbody newtitle")).toEqual([record]);
  });
  it("does not match the source path or canonical-save boilerplate", () => {
    const saved = doc("memory:saved", [
      "<!-- space-memory:id=gemini_memory:abc -->",
      "## 2026-10-11 - Space canonical memory: Queue fix",
      "- Source: Space API memory.save; original_scope=SYSTEM; provenance=operator; trace=none.",
      "- created_at=2026-10-11T10:00:00.000Z",
      "- Merge queue retries host conditions."
    ].join("\n"), "Queue fix");
    expect(searchMemoryDocuments([saved], "gemini_history")).toEqual([]);
    expect(searchMemoryDocuments([saved], "canonical operator")).toEqual([]);
    expect(searchMemoryDocuments([saved], "merge queue")).toEqual([saved]);
    expect(searchMemoryDocuments([saved], "2026-10-11 queue")).toEqual([saved]);
  });
  it("weighs rare terms above common ones", () => {
    const common = Array.from({ length: 8 }, (_, n) => doc(`memory:common-${n}`, "space deploy notes", `Space note ${n}`));
    const rare = doc("memory:rare", "space deploy through the merge queue", "Deploy");
    const commonInTitle = doc("memory:title", "merge queue mentioned once", "Space deploy space deploy");
    expect(searchMemoryDocuments([...common, commonInTitle, rare], "space deploy merge")[0]?.id).toBe(rare.id);
  });
  it("prefers the newer of two equally relevant records without overriding a better match", () => {
    const older = { ...doc("memory:older", "Default OpenCode model is big-pickle."), createdAt: "2026-07-01T00:00:00Z" };
    const newer = { ...doc("memory:newer", "Default OpenCode model is big-pickle."), createdAt: "2026-10-11T00:00:00Z" };
    expect(searchMemoryDocuments([older, newer], "opencode default model")[0]?.id).toBe(newer.id);
    const focusedOld = { ...doc("memory:focused", "OpenCode default model big-pickle", "OpenCode default model"), createdAt: "2026-07-01T00:00:00Z" };
    const vagueNew = { ...doc("memory:vague", `OpenCode ${"filler ".repeat(200)} default ${"filler ".repeat(200)} model`), createdAt: "2026-10-11T00:00:00Z" };
    expect(searchMemoryDocuments([vagueNew, focusedOld], "opencode default model")[0]?.id).toBe(focusedOld.id);
  });
  it("keeps late evidence within budget despite length-changing Greek aliases and dates", () => {
    const fact = "Μνήμη εξωτερικό backup 5 Σεπτεμβρίου 2026: /external/verified-copy.";
    const body = `Μνήμη ${"αδιάφορο ".repeat(2000)}${fact} ${"τέλος ".repeat(200)}`;
    const result = memoryExcerpt(body, "memory external backup 2026-09-05", 300);
    expect(result).toContain(fact);
    expect(result.length).toBeLessThanOrEqual(300);
    expect(body).toContain(result.replace(/^…|…$/g, ""));
  });
});
