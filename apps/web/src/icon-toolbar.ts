import type { LucideIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type AriaAttributes,
  type DragEvent as ReactDragEvent,
  type RefObject
} from "react";
import { getSpaceRuntime } from "./runtime/SpaceRuntime.js";

export type IconActionMenuState = {
  actionId: string;
  actionLabel: string;
  x: number;
  y: number;
};

export type IconToolbarAction = {
  id: string;
  label: string;
  title: string;
  ariaLabel: string;
  icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
  ariaControls?: string;
  ariaExpanded?: boolean;
  ariaHasPopup?: AriaAttributes["aria-haspopup"];
  ariaPressed?: boolean;
  hideable?: boolean;
  draggable?: boolean;
  className?: string;
};

const FINE_POINTER_QUERY = "(any-pointer: fine)";

function readFinePointer(): boolean {
  if (typeof window === "undefined") return true;
  if ((navigator.maxTouchPoints ?? 0) === 0) return true;
  return typeof window.matchMedia === "function" && window.matchMedia(FINE_POINTER_QUERY).matches;
}

function useFinePointer(): boolean {
  const [hasFinePointer, setHasFinePointer] = useState(readFinePointer);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mediaQuery = window.matchMedia(FINE_POINTER_QUERY);
    const update = () => setHasFinePointer(readFinePointer());
    update();
    mediaQuery.addEventListener?.("change", update);
    return () => mediaQuery.removeEventListener?.("change", update);
  }, []);

  return hasFinePointer;
}

const stringListListeners = new Map<string, Set<() => void>>();

function uniqueStringList(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function stringListsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function readStoredStringList(key: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = getSpaceRuntime().platform.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return uniqueStringList(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return [];
  }
}

function persistStoredStringList(key: string, values: string[]) {
  if (typeof window === "undefined") return;
  try {
    const normalized = uniqueStringList(values);
    if (normalized.length) {
      getSpaceRuntime().platform.localStorage.setItem(key, JSON.stringify(normalized));
    } else {
      getSpaceRuntime().platform.localStorage.removeItem(key);
    }
  } catch {
    // Best effort only.
  }
}

function emitStringListUpdate(key: string) {
  stringListListeners.get(key)?.forEach((listener) => listener());
}

function subscribeStoredStringList(key: string, listener: () => void) {
  let listeners = stringListListeners.get(key);
  if (!listeners) {
    listeners = new Set();
    stringListListeners.set(key, listeners);
  }
  listeners.add(listener);
  function handleStorage(event: StorageEvent) {
    if (event.key === null || event.key === key) {
      listener();
    }
  }
  if (typeof window !== "undefined") {
    window.addEventListener("storage", handleStorage);
  }
  return () => {
    listeners?.delete(listener);
    if (listeners && listeners.size === 0) {
      stringListListeners.delete(key);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", handleStorage);
    }
  };
}

function writeStoredStringList(key: string, values: string[]) {
  persistStoredStringList(key, values);
  emitStringListUpdate(key);
}

function useStoredStringList(key: string) {
  const [value, setValue] = useState<string[]>(() => readStoredStringList(key));

  useEffect(() => {
    setValue(readStoredStringList(key));
    return subscribeStoredStringList(key, () => setValue(readStoredStringList(key)));
  }, [key]);

  const persistValue = useCallback(
    (next: string[]) => {
      writeStoredStringList(key, next);
      setValue(readStoredStringList(key));
    },
    [key]
  );

  return [value, persistValue] as const;
}

function normalizeActionOrder(actionIds: string[], storedOrder: string[], preserveUnknownActionIds = false): string[] {
  const ordered = uniqueStringList(preserveUnknownActionIds ? storedOrder : storedOrder.filter((id) => actionIds.includes(id)));
  for (const actionId of actionIds) {
    if (!ordered.includes(actionId)) {
      ordered.push(actionId);
    }
  }
  return ordered;
}

function normalizeHiddenActions(actions: IconToolbarAction[], hiddenActionIds: string[], preserveUnknownActionIds = false): string[] {
  const actionIds = new Set(actions.map((action) => action.id));
  const nonHideableIds = new Set(actions.filter((action) => action.hideable === false).map((action) => action.id));
  return hiddenActionIds.filter((actionId) => (preserveUnknownActionIds || actionIds.has(actionId)) && !nonHideableIds.has(actionId));
}

function reorderActionIds(actionIds: string[], draggedActionId: string, targetActionId: string): string[] {
  if (draggedActionId === targetActionId) return actionIds;
  const draggedIndex = actionIds.indexOf(draggedActionId);
  const targetIndex = actionIds.indexOf(targetActionId);
  if (draggedIndex === -1 || targetIndex === -1) return actionIds;
  const next = [...actionIds];
  next.splice(draggedIndex, 1);
  next.splice(targetIndex, 0, draggedActionId);
  return next;
}

function moveActionIdToEnd(actionIds: string[], draggedActionId: string): string[] {
  const draggedIndex = actionIds.indexOf(draggedActionId);
  if (draggedIndex === -1 || draggedIndex === actionIds.length - 1) return actionIds;
  const next = [...actionIds];
  next.splice(draggedIndex, 1);
  next.push(draggedActionId);
  return next;
}

export function useDismissibleToolbarLayer({
  containerRef,
  active,
  onDismiss
}: {
  containerRef: RefObject<HTMLElement | null>;
  active: boolean;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!active) return;
    function handlePointerDown(event: PointerEvent) {
      if (containerRef.current?.contains(event.target as Node)) return;
      onDismiss();
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onDismiss();
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [active, containerRef, onDismiss]);
}

export function usePersistentIconToolbar({
  actions,
  hiddenStorageKey,
  orderStorageKey,
  nonPersistentActionIds = [],
  preserveUnknownActionIds = false,
  closeOverflowOnDragStart = true
}: {
  actions: IconToolbarAction[];
  hiddenStorageKey: string;
  orderStorageKey: string;
  nonPersistentActionIds?: string[];
  preserveUnknownActionIds?: boolean;
  closeOverflowOnDragStart?: boolean;
}) {
  const [hiddenActionIds, setHiddenActionIds] = useStoredStringList(hiddenStorageKey);
  const [orderedActionIds, setOrderedActionIds] = useStoredStringList(orderStorageKey);
  const [isOverflowOpen, setIsOverflowOpen] = useState(false);
  const [actionMenu, setActionMenu] = useState<IconActionMenuState | null>(null);
  const [draggedActionId, setDraggedActionId] = useState<string | null>(null);
  const hasFinePointer = useFinePointer();
  const nonPersistentSet = useMemo(() => new Set(nonPersistentActionIds), [nonPersistentActionIds]);
  const actionIds = useMemo(() => actions.map((action) => action.id).filter((id) => !nonPersistentSet.has(id)), [actions, nonPersistentSet]);
  const actionsById = useMemo(() => new Map(actions.map((action) => [action.id, action])), [actions]);

  useEffect(() => {
    const normalized = normalizeHiddenActions(actions.filter((action) => !nonPersistentSet.has(action.id)), hiddenActionIds, preserveUnknownActionIds);
    if (!stringListsEqual(normalized, hiddenActionIds)) {
      setHiddenActionIds(normalized);
    }
  }, [actions, hiddenActionIds, nonPersistentSet, preserveUnknownActionIds, setHiddenActionIds]);

  useEffect(() => {
    const normalized = normalizeActionOrder(actionIds, orderedActionIds, preserveUnknownActionIds);
    if (!stringListsEqual(normalized, orderedActionIds)) {
      setOrderedActionIds(normalized);
    }
  }, [actionIds, orderedActionIds, preserveUnknownActionIds, setOrderedActionIds]);

  const orderedActions = useMemo(() => {
    const normalizedOrder = normalizeActionOrder(actionIds, orderedActionIds, preserveUnknownActionIds);
    const persistent = normalizedOrder.map((actionId) => actionsById.get(actionId)).filter((action): action is IconToolbarAction => Boolean(action));
    return [...persistent, ...actions.filter((action) => nonPersistentSet.has(action.id))];
  }, [actionIds, actions, actionsById, nonPersistentSet, orderedActionIds, preserveUnknownActionIds]);

  const hiddenSet = useMemo(() => new Set(hiddenActionIds), [hiddenActionIds]);
  const visibleActions = useMemo(() => orderedActions.filter((action) => !hiddenSet.has(action.id)), [hiddenSet, orderedActions]);
  const hiddenActions = useMemo(() => orderedActions.filter((action) => hiddenSet.has(action.id)), [hiddenSet, orderedActions]);

  const closeMenus = useCallback(() => {
    setIsOverflowOpen(false);
    setActionMenu(null);
  }, []);

  const hideAction = useCallback(
    (actionId: string) => {
      const action = actionsById.get(actionId);
      if (!action || action.hideable === false) return;
      setHiddenActionIds([...hiddenActionIds, actionId]);
      setActionMenu(null);
      setIsOverflowOpen(false);
    },
    [actionsById, hiddenActionIds, setHiddenActionIds]
  );

  const showAction = useCallback(
    (actionId: string) => {
      const action = actionsById.get(actionId);
      if (!action || action.hideable === false) return;
      setHiddenActionIds(hiddenActionIds.filter((hiddenActionId) => hiddenActionId !== actionId));
      setActionMenu(null);
      setIsOverflowOpen(false);
    },
    [actionsById, hiddenActionIds, setHiddenActionIds]
  );

  const restoreHiddenActions = useCallback(() => {
    setHiddenActionIds([]);
    setIsOverflowOpen(false);
  }, [setHiddenActionIds]);

  const moveAction = useCallback(
    (draggedId: string, targetId: string) => {
      const nextOrder = reorderActionIds(normalizeActionOrder(actionIds, orderedActionIds, preserveUnknownActionIds), draggedId, targetId);
      setOrderedActionIds(nextOrder);
    },
    [actionIds, orderedActionIds, preserveUnknownActionIds, setOrderedActionIds]
  );

  const moveActionToEnd = useCallback(() => {
    if (!draggedActionId) return;
    const nextOrder = moveActionIdToEnd(normalizeActionOrder(actionIds, orderedActionIds, preserveUnknownActionIds), draggedActionId);
    setOrderedActionIds(nextOrder);
    setDraggedActionId(null);
  }, [actionIds, draggedActionId, orderedActionIds, preserveUnknownActionIds, setOrderedActionIds]);

  const getDragHandleProps = useCallback(
    (action: IconToolbarAction) => ({
      draggable: hasFinePointer && action.draggable !== false,
      onDragStart: () => {
        if (!hasFinePointer || action.draggable === false) return;
        setDraggedActionId(action.id);
        if (closeOverflowOnDragStart) {
          setIsOverflowOpen(false);
        }
        setActionMenu(null);
      },
      onDragOver: (event: ReactDragEvent<HTMLElement>) => {
        if (action.draggable === false || !draggedActionId || draggedActionId === action.id) return;
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = "move";
        }
      },
      onDrop: (event: ReactDragEvent<HTMLElement>) => {
        if (action.draggable === false || !draggedActionId || draggedActionId === action.id) return;
        event.preventDefault();
        moveAction(draggedActionId, action.id);
        setDraggedActionId(null);
      },
      onDragEnd: () => setDraggedActionId(null)
    }),
    [closeOverflowOnDragStart, draggedActionId, hasFinePointer, moveAction]
  );

  const overflowDropProps = useMemo(
    () => ({
      onDragOver: (event: ReactDragEvent<HTMLElement>) => {
        if (!draggedActionId) return;
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = "move";
        }
      },
      onDrop: (event: ReactDragEvent<HTMLElement>) => {
        if (!draggedActionId) return;
        event.preventDefault();
        moveActionToEnd();
      }
    }),
    [draggedActionId, moveActionToEnd]
  );

  return {
    actionMenu,
    closeMenus,
    draggedActionId,
    getDragHandleProps,
    hiddenActionIds,
    hiddenActions,
    hideAction,
    isOverflowOpen,
    moveActionToEnd,
    orderedActions,
    overflowDropProps,
    restoreHiddenActions,
    setActionMenu,
    setIsOverflowOpen,
    showAction,
    visibleActions
  };
}
