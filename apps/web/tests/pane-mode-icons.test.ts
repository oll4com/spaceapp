import { describe, expect, it } from "vitest";
import { ClipboardList, Cpu, Eye, Rocket, Terminal } from "../src/features/ui-theme/app-icons.js";
import { modeIcons } from "../src/features/pane-card/pane-mode-icons.js";
import { sideSurfaceMeta } from "../src/features/docks/side-surface-meta.js";
import { NON_CLI_PANE_DEFINITIONS } from "../src/features/pane-visibility/use-panes-visibility.js";

describe("pane type icons", () => {
  it("gives every pane type in the Create menu its own icon", () => {
    const icons = NON_CLI_PANE_DEFINITIONS.map((pane) => pane.icon);
    expect(icons.every((icon) => Object.values(modeIcons).includes(icon))).toBe(true);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("gives every pane type and every dock its own icon", () => {
    const panes = Object.values(modeIcons);
    const docks = Object.values(sideSurfaceMeta).map((dock) => dock.icon);
    expect(new Set(panes).size).toBe(panes.length);
    expect(new Set(docks).size).toBe(docks.length);
    // Only the CLI dock shares its icon with a pane type: both are the CLI.
    expect(docks.filter((icon) => panes.includes(icon))).toEqual([Terminal]);
  });

  it("does not reuse icons that mean something else in Space", () => {
    // Eye shows or hides, ClipboardList is Plan mode, Rocket deploys, Cpu is the CPU indicator.
    const taken = [Eye, ClipboardList, Rocket, Cpu];
    expect(Object.values(modeIcons).filter((icon) => taken.includes(icon))).toEqual([]);
  });
});
