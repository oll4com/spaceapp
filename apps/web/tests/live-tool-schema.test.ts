// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  GOOGLE_LIVE_SCHEMA_KEYWORDS,
  googleLiveToolParameters,
  SAVE_PERSONAL_MEMORY_TOOL,
  SPACE_OPEN_PANES_TOOL,
  SPACE_PLAN_MISSION_TOOL,
  SPACE_REQUEST_VIDEO_TOOL
} from "../src/features/live-pane/live-session.js";
import * as livePaneModule from "../src/features/live-pane/live-session.js";

const supported = new Set<string>(GOOGLE_LIVE_SCHEMA_KEYWORDS);

/** Every schema keyword reachable through properties/items, as dotted paths. */
function unsupportedSchemaKeys(schema: unknown, path = "parameters"): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (!supported.has(key)) found.push(`${path}.${key}`);
    if (key === "properties" && value && typeof value === "object") {
      for (const [name, nested] of Object.entries(value as Record<string, unknown>)) {
        found.push(...unsupportedSchemaKeys(nested, `${path}.properties.${name}`));
      }
    }
    if (key === "items") found.push(...unsupportedSchemaKeys(value, `${path}.items`));
  }
  return found;
}

describe("Gemini Live tool schema compatibility", () => {
  it("keeps the whole exported tool catalog inside the Gemini Live schema subset", () => {
    // The catalog is shared by every Live provider. Google parses the setup
    // message as protobuf and rejects the entire session (close 1007, no error
    // frame) for one unknown keyword, so the catalog itself must stay clean.
    const tools = Object.entries(livePaneModule)
      .filter(([name, value]) => name.endsWith("_TOOL") && value && typeof value === "object");
    expect(tools.length).toBeGreaterThan(20);
    const offenders = tools.flatMap(([name, tool]) =>
      unsupportedSchemaKeys((tool as { parameters?: unknown }).parameters, `${name}.parameters`)
    );
    expect(offenders).toEqual([]);
  });

  it("names every Live function tool with the space_ prefix", () => {
    // Operator rule 2026-10-13: every tool SpaceApp defines starts with "space".
    const names = Object.entries(livePaneModule)
      .filter(([name, value]) => name.endsWith("_TOOL") && value && typeof value === "object")
      .map(([, tool]) => (tool as { name?: unknown }).name)
      .filter((name): name is string => typeof name === "string");
    expect(names.length).toBeGreaterThan(20);
    expect(names.filter((name) => !name.startsWith("space_"))).toEqual([]);
  });

  it("drops unsupported keywords while preserving nested properties, items and enums", () => {
    expect(googleLiveToolParameters({
      type: "object",
      additionalProperties: false,
      strict: true,
      $schema: "https://json-schema.org/draft/2020-12/schema",
      properties: {
        counts: {
          type: "object",
          additionalProperties: false,
          properties: { codex: { type: "number", description: "" } }
        },
        mode: { type: "string", enum: ["fast", "slow"], default: "fast" },
        placements: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 }
      },
      required: ["mode"]
    })).toEqual({
      type: "object",
      properties: {
        counts: { type: "object", properties: { codex: { type: "number", description: "" } } },
        mode: { type: "string", enum: ["fast", "slow"] },
        placements: { type: "array", items: { type: "string" } }
      },
      required: ["mode"]
    });
  });

  it("returns undefined for a missing or non-object parameter schema", () => {
    expect(googleLiveToolParameters(undefined)).toBeUndefined();
    expect(googleLiveToolParameters("open")).toBeUndefined();
    expect(googleLiveToolParameters(null)).toBeUndefined();
  });

  it("keeps the offending declaration clean for the Live incident tool", () => {
    // Regression: space_open_panes.counts carried `additionalProperties: false`,
    // which killed every Google Live session before setup completed.
    expect(JSON.stringify(SPACE_OPEN_PANES_TOOL)).not.toContain("additionalProperties");
    const sanitized = googleLiveToolParameters(SPACE_OPEN_PANES_TOOL.parameters) as {
      properties: { counts?: { properties?: Record<string, unknown> } };
    };
    expect(unsupportedSchemaKeys(sanitized)).toEqual([]);
    expect(sanitized.properties.counts?.properties).toHaveProperty("codex");
    expect(sanitized.properties.counts?.properties).toHaveProperty("demos");
    expect(sanitized.properties.counts?.properties).toHaveProperty("files");
    expect(sanitized.properties.counts?.properties).toHaveProperty("live");
    expect(unsupportedSchemaKeys(SAVE_PERSONAL_MEMORY_TOOL.parameters)).toEqual([]);
    expect(unsupportedSchemaKeys(SPACE_PLAN_MISSION_TOOL.parameters)).toEqual([]);
  });

  it("declares the Video pane request tool for every Live provider", () => {
    expect(SPACE_REQUEST_VIDEO_TOOL.name).toBe("space_request_video");
    expect(unsupportedSchemaKeys(SPACE_REQUEST_VIDEO_TOOL.parameters)).toEqual([]);
    expect(Object.keys(SPACE_REQUEST_VIDEO_TOOL.parameters.properties).sort()).toEqual(["brief", "formatIds", "narration", "sourceArtifactIds", "technique"]);
    expect(SPACE_REQUEST_VIDEO_TOOL.parameters.required).toEqual(["brief"]);
    expect(SPACE_REQUEST_VIDEO_TOOL.parameters.properties.technique.enum).toEqual(["silence", "scene", "highlights", "manual"]);
  });
});
