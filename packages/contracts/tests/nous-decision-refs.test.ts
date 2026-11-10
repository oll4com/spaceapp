import { describe, expect, it } from "vitest";
import { z } from "zod";
import { nousDecisionRefsSchema } from "../src/nous.js";

describe("Nous decision refs", () => {
  it("R70: reads a send kind with capitals, underscores or spaces as its hyphenated form; other characters stay refused", () => {
    expect(nousDecisionRefsSchema.parse({ sendKind: " Marketing-Hacker_News " }).sendKind).toBe("marketing-hacker-news");
    expect(nousDecisionRefsSchema.parse({ sendKind: "pilot offer" }).sendKind).toBe("pilot-offer");
    expect(nousDecisionRefsSchema.safeParse({ sendKind: "mail/reply" }).success).toBe(false);
    expect(nousDecisionRefsSchema.parse({}).sendKind).toBeUndefined();
    // The tool's JSON Schema (space_ask_operator's inputSchema) still shows the hyphenated form.
    expect((z.toJSONSchema(nousDecisionRefsSchema) as { properties: Record<string, unknown> }).properties.sendKind).toMatchObject({ pattern: "^[a-z0-9][a-z0-9-]{1,39}$" });
  });
});
