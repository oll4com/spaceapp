import { describe, expect, it } from "vitest";
import type { PaneCategoryColor } from "@space/contracts";
import {
  nextCategoryColor,
  roomCategoryColors
} from "../src/features/pane-category-color/room-filter.js";

const pane = (categoryColor: PaneCategoryColor | null) => ({ categoryColor });

describe("roomCategoryColors", () => {
  it("returns unique colors in canonical palette order", () => {
    expect(roomCategoryColors([
      pane("blue"),
      pane(null),
      pane("red"),
      pane("blue"),
      pane("pink"),
      pane("purple")
    ])).toEqual(["red", "blue", "purple", "pink"]);
  });

  it("returns the canonical palette order regardless of pane order", () => {
    expect(roomCategoryColors([pane("yellow"), pane("green"), pane("orange")]))
      .toEqual(["orange", "yellow", "green"]);
  });

  it("returns empty array when no pane has a color", () => {
    expect(roomCategoryColors([pane(null), pane(null)])).toEqual([]);
    expect(roomCategoryColors([])).toEqual([]);
  });
});

describe("nextCategoryColor", () => {
  const colors = ["red", "blue", "pink"] as PaneCategoryColor[];

  it("cycles forward through colors then OFF", () => {
    expect(nextCategoryColor(null, colors, 1)).toBe("red");
    expect(nextCategoryColor("red", colors, 1)).toBe("blue");
    expect(nextCategoryColor("blue", colors, 1)).toBe("pink");
    expect(nextCategoryColor("pink", colors, 1)).toBeNull();
  });

  it("wraps forward from OFF back to the first color", () => {
    expect(nextCategoryColor(null, colors, 1)).toBe("red");
  });

  it("cycles backward through OFF then colors", () => {
    expect(nextCategoryColor(null, colors, -1)).toBe("pink");
    expect(nextCategoryColor("pink", colors, -1)).toBe("blue");
    expect(nextCategoryColor("blue", colors, -1)).toBe("red");
    expect(nextCategoryColor("red", colors, -1)).toBeNull();
  });

  it("keeps current when deltaY is zero", () => {
    expect(nextCategoryColor("blue", colors, 0)).toBe("blue");
    expect(nextCategoryColor(null, colors, 0)).toBeNull();
  });

  it("handles a single color room", () => {
    const single = ["red"] as PaneCategoryColor[];
    expect(nextCategoryColor(null, single, 1)).toBe("red");
    expect(nextCategoryColor("red", single, 1)).toBeNull();
    expect(nextCategoryColor(null, single, -1)).toBe("red");
    expect(nextCategoryColor("red", single, -1)).toBeNull();
  });

  it("returns null when the room has no colors", () => {
    expect(nextCategoryColor(null, [], 1)).toBeNull();
    expect(nextCategoryColor("red", [], 1)).toBeNull();
  });

  it("falls back to the first color when current is not in the room colors", () => {
    expect(nextCategoryColor("purple", colors, 1)).toBe("blue");
    expect(nextCategoryColor("purple", colors, -1)).toBeNull();
  });
});
