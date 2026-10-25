import { describe, expect, it } from "vitest";
import {
  groupModernRoomActions,
  modernPanePrimaryActionCapacity,
  modernPanePrimaryActionCount,
  modernRoomActionGroup,
  type ModernRoomActionGroup
} from "../src/features/ui-theme/modern-toolbar.js";

describe("Modern room toolbar grouping", () => {
  it("maps room actions into the four stable visual groups", () => {
    expect(modernRoomActionGroup("add-chat")).toBe("create");
    expect(modernRoomActionGroup("add-cli")).toBe("create");
    expect(modernRoomActionGroup("add-harness")).toBe("create");
    expect(modernRoomActionGroup("pane-layout")).toBe("view");
    expect(modernRoomActionGroup("pane-span-all")).toBe("view");
    expect(modernRoomActionGroup("theme")).toBe("view");
    expect(modernRoomActionGroup("memory-workspace")).toBe("tools");
    expect(modernRoomActionGroup("clip-tool")).toBe("tools");
    expect(modernRoomActionGroup("server-restart")).toBe("more");
    expect(modernRoomActionGroup("room-settings")).toBe("more");
  });

  it("keeps action order inside Create, View, Tools, and More", () => {
    const actions = [
      { id: "pane-layout" },
      { id: "pane-span-all" },
      { id: "theme" },
      { id: "add-chat" },
      { id: "clip-tool" },
      { id: "reload-room" },
      { id: "add-cli" }
    ];
    const groups = groupModernRoomActions(actions);
    const idsByGroup = Object.fromEntries(
      groups.map((group) => [group.id, group.actions.map((action) => action.id)])
    ) as Record<ModernRoomActionGroup, string[]>;

    expect(idsByGroup).toEqual({
      create: ["add-chat", "add-cli"],
      view: ["pane-layout", "pane-span-all", "theme"],
      tools: ["clip-tool"],
      more: ["reload-room"]
    });
  });

  it("renders only the stable primary pane actions and leaves the rest for overflow", () => {
    expect(modernPanePrimaryActionCount("desktop")).toBe(4);
    expect(modernPanePrimaryActionCount("tablet")).toBe(3);
    expect(modernPanePrimaryActionCount("mobile")).toBe(0);
  });

  it("reduces pane header actions to the slots that fit inside the pane itself", () => {
    const shared = {
      paddingLeft: 8,
      paddingRight: 8,
      badgeWidth: 34,
      titleWidth: 96,
      fixedWidth: 139,
      columnGap: 7,
      actionWidth: 33,
      actionGap: 4
    };

    expect(modernPanePrimaryActionCapacity({ ...shared, availableWidth: 370, maxActions: 3 })).toBe(1);
    expect(modernPanePrimaryActionCapacity({ ...shared, availableWidth: 520, maxActions: 3 })).toBe(3);
    expect(modernPanePrimaryActionCapacity({ ...shared, availableWidth: 520, maxActions: 4 })).toBe(4);
  });
});
