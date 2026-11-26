// Speed audit 14/11: the monthly memory files are read again only when one changed, and a memory save stems its new entry only.
import { appendFile, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { memoryEntries, readMemoryMonthlies } from "../src/nous/operator-facts.js";
import { cardMemoryEntries, cardStems } from "../src/nous/pane-notices.js";

const block = (id: string, title: string, tags: string) =>
  `<!-- space-memory:id=space_memory:${id} -->\n## 2026-11-14 - Space canonical memory: ${title}\n\n- created_at=2026-11-14T07:00:0${id}.000Z\n- Tags: ${tags}\n\nThe ${title} body.\n\n`;

describe("memory text kept between reads", () => {
  it("reads the monthly files again only when a file's size or time changed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "space-memory-"));
    try {
      const october = join(directory, "space_memory_2026-10.md"), november = join(directory, "space_memory_2026-11.md");
      const sameStamp = () => utimes(november, 1_700_000_000, 1_700_000_000);
      await writeFile(october, "october");
      await writeFile(join(directory, "gemini_memory_2026-10.md"), "skipped");
      await writeFile(november, "first");
      await sameStamp();
      expect(await readMemoryMonthlies(november)).toBe("october\nfirst");
      // Same size and time: the kept text answers, the file is not read.
      await writeFile(november, "other");
      await sameStamp();
      expect(await readMemoryMonthlies(november)).toBe("october\nfirst");
      await appendFile(november, " and more");
      expect(await readMemoryMonthlies(november)).toBe("october\nother and more");
      await rm(october);
      expect(await readMemoryMonthlies(november)).toBe("other and more");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps each memory entry's card stems across a save", async () => {
    const text = block("1", "Hetzner invoices", "operator-rule") + block("2", "Postgres restart window", "infra");
    const first = await cardMemoryEntries(memoryEntries(text));
    expect(first.map((entry) => [entry.id, entry.rule])).toEqual([["space_memory:2", false], ["space_memory:1", true]]);
    expect(first[1]!.stems).toEqual(cardStems("Hetzner invoices The Hetzner invoices body."));
    const saved = await cardMemoryEntries(memoryEntries(text + block("3", "Quiet hours", "operator-rules")));
    expect(saved.map((entry) => entry.id)).toEqual(["space_memory:3", "space_memory:2", "space_memory:1"]);
    expect(saved[1]).toBe(first[0]);
    expect(saved[2]).toBe(first[1]);
    expect(saved[0]!.rule).toBe(true);
  });
});
