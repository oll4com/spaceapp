import { describe, expect, it } from "vitest";
import { parseMemorySourceRecords, type MemoryGraphSource } from "../src/index.js";

// Well over the 256 KiB parse chunk, laid out like the live monthly files (marker line straight before each heading).
function monthly(entry: (index: number) => string[] = () => []): string {
  const lines = ["# Space Memory 2026-11", ""];
  for (let index = 0; index < 1500; index += 1) {
    lines.push(`<!-- space-memory:id=memory:chunk-${index} -->`, `## 2026-11-${String(index % 28 + 1).padStart(2, "0")} - Entry ${index}`);
    lines.push(...entry(index), `  - ${"Durable note about the memory graph worker and its snapshot. ".repeat(12)}`);
  }
  return lines.join("\n");
}

const records = (content: string) => parseMemorySourceRecords({ path: "/opt/spaceapp/docs/space_memory_2026-11.md", kind: "MONTHLY", content } satisfies MemoryGraphSource);
// A reference definition keeps the file in one parse, the behaviour before chunking.
const wholeFileRecords = (content: string) => records(`${content}\n\n[ref]: /opt/spaceapp/docs/space.md`);

describe("chunked monthly parse", () => {
  it("returns the same records as parsing the file whole", () => {
    const content = monthly();
    expect(content.length).toBeGreaterThan(4 * 256 * 1024);
    const chunked = records(content);
    expect(chunked).toHaveLength(1500);
    expect(chunked.slice(0, -1)).toEqual(wholeFileRecords(content).slice(0, -1));
  });

  it("falls back to one parse when a fence or html block would run across a cut", () => {
    for (const open of ["```", "<pre>"]) {
      const content = monthly((index) => (index === 1 ? [open] : []));
      const chunked = records(content);
      expect(chunked.length).toBeLessThan(1500);
      expect(chunked.slice(0, -1)).toEqual(wholeFileRecords(content).slice(0, -1));
    }
  });
});
