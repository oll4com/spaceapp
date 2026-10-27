import type { CopilotRailTab } from "./CopilotRail.js";
import { layoutForWidth, STACKED_LAYOUT_MAX_WIDTH, type CopilotLayout } from "../copilot-kit/copilot-layout.js";

/**
 * Split: live browser beside (or, under 900px, above) the rail. Stacked: one surface at a time
 * with the browser as a rail tab and the tab strip at the bottom, for phones and narrow panes.
 */
export type JobCopilotLayout = CopilotLayout;
export { layoutForWidth, STACKED_LAYOUT_MAX_WIDTH };

export const RAIL_TABS: readonly CopilotRailTab[] = ["activity", "queue", "fields", "memory", "bookmarks", "setup", "terminal"];

/** The tabs a layout offers, in strip order: the browser leads only when it is a tab of its own. */
export function tabsForLayout(layout: JobCopilotLayout): CopilotRailTab[] {
  return layout === "stacked" ? ["browser", ...RAIL_TABS] : [...RAIL_TABS];
}

/** A stored tab that the current layout has no surface for falls back to Activity. */
export function resolveActiveTab(tab: string | null | undefined, layout: JobCopilotLayout): CopilotRailTab {
  const available = tabsForLayout(layout);
  return available.includes(tab as CopilotRailTab) ? (tab as CopilotRailTab) : "activity";
}

/** Whether the live browser surface is the visible one for this layout and tab. */
export function browserVisible(layout: JobCopilotLayout, activeTab: CopilotRailTab, railCollapsed: boolean): boolean {
  if (layout === "split") return true;
  return activeTab === "browser" || railCollapsed;
}
