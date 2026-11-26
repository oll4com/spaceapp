import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defaultFreelanceCopilotPaneMetadata, defaultMarketingCopilotPaneMetadata, paneSchema } from "@space/contracts";
import { PostgresSpaceStore } from "../src/space-store.js";
import { parsePaneRowTolerantly } from "../src/tolerant-pane.js";

const row = (overrides: Record<string, unknown> = {}) => ({
  id: "pane:browser01", roomId: "room:browser01", title: "Browser", titleSource: "auto", taskMetadata: null, paneName: null, mode: "BROWSER", status: "IDLE",
  providerId: null, modelId: null, terminalRuntimeId: null, reasoningEffort: "medium", cwd: null, order: 0, columnSpan: 1, isMaximized: false,
  isMinimized: false, isClosed: false, split: { parentId: null, direction: null, size: null }, categoryColor: null, vncTarget: null,
  createdAt: "2026-11-17T00:00:00.000Z", updatedAt: "2026-11-17T00:00:00.000Z", ...overrides
});

describe("the Browser Host's tolerant pane row parse (17/11: a promote must not need a Browser Host restart)", () => {
  it("reads a row the host fully understands exactly as the strict contract does", () => {
    const current = row({ marketingCopilotMetadata: defaultMarketingCopilotPaneMetadata() });
    expect(parsePaneRowTolerantly(current)).toEqual(paneSchema.parse(current));
  });

  it("parses a pane row with an extra field and an unknown enum value, which the strict parse refuses", () => {
    const newer = row({
      // A key a newer API wrote into a strict metadata schema, and values a newer API added to the enums this host knows.
      marketingCopilotMetadata: { ...defaultMarketingCopilotPaneMetadata(), bookmarksView: { open: true } },
      reasoningEffort: "gigantic", titleSource: "robot", categoryColor: "ultraviolet", status: "HIBERNATING", futureColumn: 7
    });
    expect(paneSchema.safeParse(newer).success).toBe(false);
    const parsed = parsePaneRowTolerantly(newer);
    expect(parsed).toMatchObject({ id: "pane:browser01", roomId: "room:browser01", mode: "BROWSER", isClosed: false,
      reasoningEffort: "medium", titleSource: "auto", categoryColor: null, status: "IDLE" });
    expect(parsed.marketingCopilotMetadata).toEqual(defaultMarketingCopilotPaneMetadata());
    expect(parsed).not.toHaveProperty("futureColumn");
  });

  it("reads a pane of a mode this host does not know as CHAT, so one new pane never stops the browsers of its room", () => {
    expect(paneSchema.safeParse(row({ mode: "HOLOGRAM" })).success).toBe(false);
    expect(parsePaneRowTolerantly(row({ mode: "HOLOGRAM" })).mode).toBe("CHAT");
  });

  it("empties a metadata field the host does not read when its shape changed, and keeps the rest of the row", () => {
    const parsed = parsePaneRowTolerantly(row({ mailCopilotMetadata: { version: 2, settings: "rewritten" }, paneName: "Docs" }));
    expect(parsed.mailCopilotMetadata ?? null).toBeNull();
    expect(parsed.paneName).toBe("Docs");
  });

  it("still fails on what the host reads or cannot do without", () => {
    expect(() => parsePaneRowTolerantly(row({ id: undefined }))).toThrow();
    expect(() => parsePaneRowTolerantly(row({ roomId: 12 }))).toThrow();
    expect(() => parsePaneRowTolerantly(row({ title: "" }))).toThrow();
    expect(() => parsePaneRowTolerantly(row({ isClosed: "no" }))).toThrow();
    expect(() => parsePaneRowTolerantly(row({ order: "first" }))).toThrow();
    expect(() => parsePaneRowTolerantly(row({ createdAt: "yesterday" }))).toThrow();
  });

  it("drops unknown keys of the freelance metadata but never sends a pane out through a route it does not know", () => {
    const metadata = defaultFreelanceCopilotPaneMetadata();
    const withKey = parsePaneRowTolerantly(row({ mode: "FREELANCE_COPILOT", freelanceCopilotMetadata: { ...metadata, killSwitch: true } }));
    expect(withKey.freelanceCopilotMetadata).toEqual(metadata);
    const newRoute = { ...metadata, settings: { ...metadata.settings, browserEgress: "iceland-vpn" } };
    expect(() => parsePaneRowTolerantly(row({ mode: "FREELANCE_COPILOT", freelanceCopilotMetadata: newRoute }))).toThrow();
    const garbage = { version: 1, settings: { paused: "maybe" } };
    expect(() => parsePaneRowTolerantly(row({ mode: "FREELANCE_COPILOT", freelanceCopilotMetadata: garbage }))).toThrow();
  });

  describe("on a contract of its own: unions, records, arrays, passthrough and lazy schemas", () => {
    const color = z.enum(["red", "blue"]);
    const old = z.object({
      id: z.string(),
      mode: z.enum(["A", "B"]),
      tint: color.default("red"),
      shade: color.nullable().optional(),
      tints: z.array(color),
      scores: z.record(z.string(), color),
      selection: z.discriminatedUnion("type", [z.object({ type: z.literal("one"), id: z.string() }).strict(), z.object({ type: z.literal("many"), ids: z.array(z.string()) }).strict()]).nullable().default(null),
      route: z.union([z.enum(["direct", "mullvad"]), z.literal("pane")]).default("pane"),
      loose: z.object({ keep: z.string() }).passthrough(),
      later: z.lazy(() => z.object({ n: z.number() }).strict()).optional(),
      checked: z.object({ n: z.number() }).strict().refine((value) => value.n > 0)
    });

    it("cleans each of them and keeps validating what it knows", () => {
      const input = {
        id: "x", mode: "C", tint: "green", shade: "green", tints: ["red", "green", "blue"], scores: { a: "blue", b: "green" },
        selection: { type: "one", id: "p1", extra: true }, route: "iceland", loose: { keep: "k", more: 1 }, later: { n: 1, m: 2 }, checked: { n: 2, o: 3 }
      };
      expect(() => old.parse(input)).toThrow();
      expect(parsePaneRowTolerantly(input, old as never)).toEqual({
        id: "x", mode: "A", tint: "red", shade: null, tints: ["red", "blue"], scores: { a: "blue" },
        selection: { type: "one", id: "p1" }, route: "pane", loose: { keep: "k", more: 1 }, later: { n: 1 }, checked: { n: 2 }
      });
    });

    it("still refuses a value a refine or a type rejects", () => {
      expect(() => parsePaneRowTolerantly({ id: "x", mode: "A", tints: [], scores: {}, loose: { keep: "k" }, checked: { n: 0 } }, old as never)).toThrow();
      expect(() => parsePaneRowTolerantly({ id: 5, mode: "A", tints: [], scores: {}, loose: { keep: "k" }, checked: { n: 1 } }, old as never)).toThrow();
    });
  });
});

describe("the Browser Host's store reads panes written by a newer API", () => {
  const newer = row({ marketingCopilotMetadata: { ...defaultMarketingCopilotPaneMetadata(), bookmarksView: { open: true } }, reasoningEffort: "gigantic", futureColumn: 7 });
  const storeOver = (options: { tolerantPaneRows?: boolean }) => {
    const pool = { query: async () => ({ rows: [newer], rowCount: 1 }), connect: async () => { throw new Error("no client in this test"); } };
    const store = new PostgresSpaceStore(pool as never, options);
    vi.spyOn(store, "getRoom").mockResolvedValue({} as never);
    return store;
  };

  it("opens the pane and lists the room with tolerantPaneRows, which the host sets", async () => {
    const store = storeOver({ tolerantPaneRows: true });
    expect(await store.getPane("pane:browser01")).toMatchObject({ id: "pane:browser01", mode: "BROWSER", reasoningEffort: "medium" });
    expect((await store.listPanes("room:browser01")).map((pane) => pane.id)).toEqual(["pane:browser01"]);
  });

  it("keeps the strict parse for every other store", async () => {
    const store = storeOver({});
    await expect(store.getPane("pane:browser01")).rejects.toThrow();
    await expect(store.listPanes("room:browser01")).rejects.toThrow();
  });
});
