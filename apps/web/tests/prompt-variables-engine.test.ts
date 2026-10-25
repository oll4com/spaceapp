import { describe, expect, it } from "vitest";
import type { PromptVariable } from "@space/contracts";
import {
  expandPromptVariables,
  parsePromptVariablesImport,
  promptVariableNameError,
  filterPromptVariables,
  findActiveVariableToken
} from "../src/features/prompt-variables/prompt-variables-store.js";

const sampleVariables: PromptVariable[] = [
  {
    id: "pv-1",
    name: "pc_thai",
    label: "Thai Remote Workstation",
    value: "Computer at 192.168.10.50 accessible via wireguard tunnel on router RT-BKK-01",
    description: "Office workstation in Bangkok",
    category: "Infrastructure"
  },
  {
    id: "pv-2",
    name: "db_prod",
    label: "Production Postgres",
    value: "postgresql://postgres:secret@db.internal.net:5432/main",
    description: "Primary transactional database",
    category: "Database"
  },
  {
    id: "pv-3",
    name: "router_gw",
    label: "Core Gateway Router",
    value: "10.0.0.1 (Cisco Catalyst)",
    description: "Default gateway",
    category: "Network"
  },
  {
    id: "pv-4",
    name: "pc_athens",
    label: "Athens Lab PC",
    value: "192.168.1.100 accessible via LAN",
    description: "Local test box",
    category: "Infrastructure"
  }
];

describe("Prompt Variables Engine", () => {
  describe("findActiveVariableToken", () => {
    it("returns null for empty or non-hash input", () => {
      expect(findActiveVariableToken("")).toBeNull();
      expect(findActiveVariableToken("hello world")).toBeNull();
      expect(findActiveVariableToken("git status")).toBeNull();
    });

    it("detects bare '#' as active token", () => {
      const result = findActiveVariableToken("#");
      expect(result).toEqual({
        query: "",
        token: "#",
        startIndex: 0,
        endIndex: 1
      });
    });

    it("detects '#' after words and spaces", () => {
      const result = findActiveVariableToken("please ping #");
      expect(result).toEqual({
        query: "",
        token: "#",
        startIndex: 12,
        endIndex: 13
      });
    });

    it("detects variable query prefix as user types", () => {
      const result = findActiveVariableToken("please connect to #pc_th");
      expect(result).toEqual({
        query: "pc_th",
        token: "#pc_th",
        startIndex: 18,
        endIndex: 24
      });
    });

    it("supports Greek characters in variable name", () => {
      const result = findActiveVariableToken("έλεγχος #υπολογιστής_1");
      expect(result).toEqual({
        query: "υπολογιστής_1",
        token: "#υπολογιστής_1",
        startIndex: 8,
        endIndex: 22
      });
    });

    it("returns null if token is followed by a space (completed token)", () => {
      expect(findActiveVariableToken("#pc_thai ")).toBeNull();
      expect(findActiveVariableToken("ping #pc_thai and check")).toBeNull();
    });

    it("returns null for escaped \\# tokens", () => {
      expect(findActiveVariableToken("\\#pc_thai")).toBeNull();
      expect(findActiveVariableToken("open page#")).toBeNull();
      expect(findActiveVariableToken("see https://host/a#pc")).toBeNull();
      expect(findActiveVariableToken("(#pc")?.query).toBe("pc");
      expect(findActiveVariableToken("line one\n#pc")?.query).toBe("pc");
      expect(findActiveVariableToken("Issue \\#123")).toBeNull();
    });
  });

  describe("filterPromptVariables", () => {
    it("returns all variables alphabetically when query is empty", () => {
      const filtered = filterPromptVariables(sampleVariables, "");
      expect(filtered.map((v) => v.name)).toEqual(["db_prod", "pc_athens", "pc_thai", "router_gw"]);
    });

    it("ranks exact name match highest", () => {
      const filtered = filterPromptVariables(sampleVariables, "pc_thai");
      expect(filtered[0]?.name).toBe("pc_thai");
    });

    it("filters by prefix match", () => {
      const filtered = filterPromptVariables(sampleVariables, "pc_");
      expect(filtered.map((v) => v.name)).toEqual(["pc_athens", "pc_thai"]);
    });

    it("matches against label, description, and category", () => {
      const filteredByLabel = filterPromptVariables(sampleVariables, "Bangkok");
      expect(filteredByLabel).toHaveLength(1);
      expect(filteredByLabel[0]?.name).toBe("pc_thai");

      const filteredByCategory = filterPromptVariables(sampleVariables, "Database");
      expect(filteredByCategory).toHaveLength(1);
      expect(filteredByCategory[0]?.name).toBe("db_prod");
    });
  });

  describe("expandPromptVariables", () => {
    it("expands single variable in prompt", () => {
      const input = "ping #pc_thai to verify latency";
      const expanded = expandPromptVariables(input, sampleVariables);
      expect(expanded).toBe(
        "ping Computer at 192.168.10.50 accessible via wireguard tunnel on router RT-BKK-01 to verify latency"
      );
    });

    it("expands multiple variables in prompt", () => {
      const input = "connect from #router_gw to #pc_thai";
      const expanded = expandPromptVariables(input, sampleVariables);
      expect(expanded).toBe(
        "connect from 10.0.0.1 (Cisco Catalyst) to Computer at 192.168.10.50 accessible via wireguard tunnel on router RT-BKK-01"
      );
    });

    it("handles case-insensitive variable tokens", () => {
      const input = "check #PC_THAI";
      const expanded = expandPromptVariables(input, sampleVariables);
      expect(expanded).toBe(
        "check Computer at 192.168.10.50 accessible via wireguard tunnel on router RT-BKK-01"
      );
    });

    it("preserves escaped \\# without expanding", () => {
      const input = "This is literal \\#pc_thai not expanded";
      const expanded = expandPromptVariables(input, sampleVariables, { autoUnescape: true });
      expect(expanded).toBe("This is literal #pc_thai not expanded");
    });

    it("expands only tokens that start a word, never inside URLs or words", () => {
      expect(expandPromptVariables("open https://host/page#pc_thai and foo#pc_thai", sampleVariables))
        .toBe("open https://host/page#pc_thai and foo#pc_thai");
      expect(expandPromptVariables("(#router_gw)", sampleVariables)).toBe("(10.0.0.1 (Cisco Catalyst))");
    });

    it("leaves unknown variables untouched", () => {
      const input = "unknown #server_xyz stays as is";
      const expanded = expandPromptVariables(input, sampleVariables);
      expect(expanded).toBe("unknown #server_xyz stays as is");
    });
  });
});

describe("prompt variable names and imports", () => {
  const existing = [{ id: "pv_1", name: "pc_thai", value: "x" }];

  it("rejects empty, malformed and case-insensitive duplicate names but allows renaming in place", () => {
    expect(promptVariableNameError("  ", existing)).toBe("Variable name is required.");
    expect(promptVariableNameError("bad name", existing)).toMatch(/only contain letters/);
    expect(promptVariableNameError("#PC_Thai", existing)).toBe("A variable named #PC_Thai already exists.");
    expect(promptVariableNameError("pc_thai", existing, "pv_1")).toBeNull();
    expect(promptVariableNameError("υπολογιστής_1", existing)).toBeNull();
  });

  it("parses an export, skips invalid entries and lets the last duplicate win", () => {
    const parsed = parsePromptVariablesImport(JSON.stringify([
      { name: "#a", value: " keep spaces ", label: " L " },
      { name: "a", value: "second" },
      { name: "b c", value: "invalid name" },
      { name: "empty", value: "   " },
      "not an object"
    ]));
    expect(parsed).toEqual({ variables: [{ name: "a", value: "second", label: undefined, category: undefined, description: undefined }], skipped: 3 });
    expect(() => parsePromptVariablesImport("{")).toThrow("The file is not valid JSON.");
    expect(() => parsePromptVariablesImport("{}")).toThrow("The file must contain a list of variables.");
    expect(() => parsePromptVariablesImport("[]")).toThrow(/no valid variables/);
  });
});
