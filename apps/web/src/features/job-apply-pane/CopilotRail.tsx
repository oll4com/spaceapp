import { Activity, Brain, ClipboardList, Globe, Settings, Table, Terminal } from "../ui-theme/app-icons.js";
import type { CopilotRailTabDefinition as KitRailTabDefinition } from "../copilot-kit/CopilotRail.js";

// The rail component lives in the copilot kit; Job Copilot keeps its tab ids and icons here.
export { CopilotRail } from "../copilot-kit/CopilotRail.js";

export type CopilotRailTab = "browser" | "activity" | "queue" | "fields" | "memory" | "setup" | "terminal";

export type CopilotRailTabDefinition = KitRailTabDefinition<CopilotRailTab>;

export const RAIL_TAB_ICONS: Record<CopilotRailTab, typeof Activity> = {
  browser: Globe, activity: Activity, queue: ClipboardList, fields: Table, memory: Brain, setup: Settings, terminal: Terminal
};
