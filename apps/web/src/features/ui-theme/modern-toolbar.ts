export type ModernRoomActionGroup = "create" | "view" | "tools" | "more";

export const modernRoomActionGroups: ReadonlyArray<{
  id: ModernRoomActionGroup;
  label: string;
}> = [
  { id: "create", label: "Create" },
  { id: "view", label: "View" },
  { id: "tools", label: "Tools" },
  { id: "more", label: "More" }
];

const createActionIds = new Set([
  "add-chat",
  "add-cli",
  "add-root-admin-cli",
  "add-browser",
  "add-youtube",
  "add-review"
]);

const viewActionIds = new Set([
  "pane-layout",
  "pane-span-all",
  "theme",
  "cli-floats",
  "font-down"
]);

const toolActionIds = new Set([
  "memory-workspace",
  "quick-links",
  "clip-tool"
]);

export function modernRoomActionGroup(actionId: string): ModernRoomActionGroup {
  if (createActionIds.has(actionId)) return "create";
  if (viewActionIds.has(actionId) || actionId.startsWith("surface-")) return "view";
  if (toolActionIds.has(actionId)) return "tools";
  return "more";
}

export function groupModernRoomActions<T extends { id: string }>(actions: T[]) {
  return modernRoomActionGroups.map((group) => ({
    ...group,
    actions: actions.filter((action) => modernRoomActionGroup(action.id) === group.id)
  }));
}

export function modernPanePrimaryActionCount(shellMode: "desktop" | "tablet" | "mobile"): number {
  if (shellMode === "mobile") return 0;
  return shellMode === "tablet" ? 3 : 4;
}

export function modernPanePrimaryActionCapacity(input: {
  availableWidth: number;
  paddingLeft: number;
  paddingRight: number;
  badgeWidth: number;
  titleWidth: number;
  fixedWidth: number;
  columnGap: number;
  actionWidth: number;
  actionGap: number;
  maxActions: number;
}): number {
  if (input.availableWidth <= 0 || input.maxActions <= 0) return Math.max(0, input.maxActions);
  const availableActionWidth =
    input.availableWidth -
    input.paddingLeft -
    input.paddingRight -
    input.badgeWidth -
    input.titleWidth -
    input.fixedWidth -
    input.columnGap * 3;
  const actionSlotWidth = input.actionWidth + input.actionGap;
  if (availableActionWidth <= 0 || actionSlotWidth <= 0) return 0;
  const fittingActions = Math.floor((availableActionWidth + input.actionGap) / actionSlotWidth);
  return Math.max(0, Math.min(input.maxActions, fittingActions));
}
