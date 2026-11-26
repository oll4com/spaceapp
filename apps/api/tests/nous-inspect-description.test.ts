import { controlInspectSections } from "@space/contracts";
import { describe, expect, it } from "vitest";
import { nousToolDefinitions } from "../src/nous/tools.js";

describe("Nous space_inspect description", () => {
  it("names only real Space Control inspect sections (cleanup plan clipboard:mJxMBg0sQ8hi step 7)", () => {
    const description = nousToolDefinitions({ copilots: false }).find((tool) => tool.name === "space_inspect")!.description;
    const named = /\(section ([A-Z_, ]+)/.exec(description)![1]!.split(",").map((name) => name.trim()).filter(Boolean);
    expect(named.length).toBeGreaterThan(3);
    expect(named.filter((name) => !(controlInspectSections as readonly string[]).includes(name))).toEqual([]);
  });
  it("space_execute shows panes.move's form with its required id (2026-11-23 REVIEW)", () => {
    const description = nousToolDefinitions({ copilots: false }).find((tool) => tool.name === "space_execute")!.description;
    expect(description).toContain('{kind:"resource",operation:"panes.move",id:"<paneId>",input:{targetRoomId:"<roomId>"}}');
  });
});
