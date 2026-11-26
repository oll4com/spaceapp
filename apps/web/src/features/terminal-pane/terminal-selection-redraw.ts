type SelectionPoint = [number, number] | undefined;
type HandleSelectionChanged = (start: SelectionPoint, end: SelectionPoint, columnSelectMode: boolean) => void;

interface XtermRenderService {
  _selectionState?: { start: SelectionPoint; end: SelectionPoint; columnSelectMode: boolean };
  handleSelectionChanged?: HandleSelectionChanged;
}

const isEmpty = (start: SelectionPoint, end: SelectionPoint) =>
  !start || !end || (start[0] === end[0] && start[1] === end[1]);

// xterm's SelectionService.clearSelection() redraws every DOM row even when nothing was
// selected; TUIs trigger it on each mouse-mode or alt-screen switch (freeze report 22/11).
// Empty -> empty draws nothing, so keep the state and skip the full-terminal render.
export function skipEmptySelectionRedraw(terminal: unknown): boolean {
  const renderService = (terminal as { _core?: { _renderService?: XtermRenderService } })?._core?._renderService;
  const state = renderService?._selectionState;
  const original = renderService?.handleSelectionChanged;
  if (!renderService || !state || typeof original !== "function") return false;
  renderService.handleSelectionChanged = (start, end, columnSelectMode) => {
    if (isEmpty(start, end) && isEmpty(state.start, state.end)) {
      state.start = start;
      state.end = end;
      state.columnSelectMode = columnSelectMode;
      return;
    }
    original.call(renderService, start, end, columnSelectMode);
  };
  return true;
}
