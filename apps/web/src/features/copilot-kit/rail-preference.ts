/** The rail's width, collapsed state and active tab, remembered per pane in this browser. */
export interface RailPreference<TTab extends string = string> { width: number; collapsed: boolean; tab: TTab }

export const RAIL_MIN_WIDTH = 300;
export const RAIL_MAX_WIDTH = 720;
export const RAIL_DEFAULT_WIDTH = 520;

export function readRailPreference<TTab extends string>(storageKey: string, tabs: readonly TTab[], defaultTab: TTab): RailPreference<TTab> {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<RailPreference<TTab>>;
      return {
        width: typeof parsed.width === "number" ? Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, parsed.width)) : RAIL_DEFAULT_WIDTH,
        collapsed: parsed.collapsed === true,
        tab: parsed.tab && tabs.includes(parsed.tab) ? parsed.tab : defaultTab
      };
    }
  } catch {
    // Preference storage is optional.
  }
  return { width: RAIL_DEFAULT_WIDTH, collapsed: false, tab: defaultTab };
}

export function writeRailPreference(storageKey: string, preference: RailPreference): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(preference));
  } catch {
    // Preference storage is optional.
  }
}
