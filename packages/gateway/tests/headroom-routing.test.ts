import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isMixedContent, mixedContentIndicators, splitIntoSections } from "../src/compression/mixed-content.js";
import { isReadCommand, toolCallCommand } from "../src/compression/read-protection.js";

const fixture = <T>(name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "headroom-parity", name, "cases.json"), "utf8")) as T;

describe("file-read protection (Headroom _is_read_command parity)", () => {
  const { commands, toolArgs } = fixture<{ commands: Array<{ command: string; read: boolean }>; toolArgs: Array<{ args: unknown; command: string }> }>("read_protection");

  it.each(commands.map((entry) => [entry.command || "(empty)", entry] as const))("%s", (_, entry) => {
    expect(isReadCommand(entry.command)).toBe(entry.read);
  });

  it("reads the command from Anthropic inputs, OpenAI JSON arguments and Codex command lists", () => {
    for (const entry of toolArgs) expect(toolCallCommand(entry.args)).toBe(entry.command);
  });
});

describe("mixed content (Headroom mixed_content parity)", () => {
  const { fixtures } = fixture<{ fixtures: Array<{ name: string; input: string; mixed: boolean; indicators: Record<string, boolean>; sections: unknown[] }> }>("mixed_content");

  it.each(fixtures.map((entry) => [entry.name, entry] as const))("%s", (_, entry) => {
    const indicators = mixedContentIndicators(entry.input);
    expect({
      has_code_fences: indicators.hasCodeFences, has_json_blocks: indicators.hasJsonBlocks, has_embedded_json_with_text: indicators.hasEmbeddedJsonWithText,
      has_prose: indicators.hasProse, has_search_results: indicators.hasSearchResults
    }).toEqual(entry.indicators);
    expect(isMixedContent(entry.input)).toBe(entry.mixed);
    expect(splitIntoSections(entry.input)).toEqual(entry.sections);
  });
});
