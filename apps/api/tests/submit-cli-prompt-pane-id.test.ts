import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * DEV3D-021: submitCliPrompt notes Space's prompt (noteSpacePrompt) only with a paneId. A kickoff or plan prompt typed without one left the
 * pane looking unprompted by Space, so the operator's next line marked it "the operator gave it its first prompt" and Nous could never close it.
 * Shared chat relays the operator's own message, so it is theirs and passes none.
 */
const OPERATOR_RELAYS = new Set(["shared-chat-routes.ts"]);

describe("submitCliPrompt callers", () => {
  it("every Space caller passes the pane id", () => {
    const root = join(import.meta.dirname, "../src");
    const missing: string[] = [];
    for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
      if (!file.endsWith(".ts") || file === "cli-prompt-submit.ts" || OPERATOR_RELAYS.has(file)) continue;
      const text = readFileSync(join(root, file), "utf8");
      for (const match of text.matchAll(/\bsubmitCliPrompt\(/g)) {
        // The call's arguments up to its closing parenthesis.
        let depth = 0, end = match.index + match[0].length - 1;
        for (; end < text.length; end += 1) { if (text[end] === "(") depth += 1; else if (text[end] === ")" && --depth === 0) break; }
        if (!/\bpaneId\b/.test(text.slice(match.index, end))) missing.push(`${file}:${text.slice(0, match.index).split("\n").length}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
