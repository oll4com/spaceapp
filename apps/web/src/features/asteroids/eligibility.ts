export function canPlayAsteroids(input: {
  selectedRoomId: string | null;
  displayedRoomId: string | null;
  preparingRoomId: string | null;
  loaded: boolean;
  category: string | null;
  panes: ReadonlyArray<{ roomId: string; isMinimized: boolean; categoryColor?: string | null }>;
}) {
  const { selectedRoomId, displayedRoomId, preparingRoomId, loaded, category, panes } = input;
  return Boolean(selectedRoomId && selectedRoomId === displayedRoomId && !preparingRoomId && loaded &&
    panes.length > 0 && panes.every(pane => pane.roomId === selectedRoomId && pane.isMinimized) &&
    (!category || panes.some(pane => pane.categoryColor === category)));
}
