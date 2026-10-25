import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type KeyboardEvent as ReactKeyboardEvent, type DragEvent as ReactDragEvent } from "react";
import { createPortal } from "react-dom";
import type { IconToolbarAction } from "../../icon-toolbar.js";
import { RotateCcw } from "../ui-theme/app-icons.js";
import { enabledButtons, restorePopupTriggerFocus, type PaneOverflowCommand, type PopupCloseIntent } from "./action-surface-shared.js";

export function DesktopActionManager({
  actions,
  commandSectionLabel = "Task commands",
  commands = [],
  hiddenActionIds,
  label,
  onClose,
  onHideAction,
  onReorderAction,
  onRunAction,
  onRunCommand,
  onShowAction,
  onResetOrder,
  isOrderCustomized = false,
  plainActions = false,
  preferPaneInside = false,
  primaryActionIds,
  popupId,
  triggerRef
}: {
  actions: IconToolbarAction[];
  commandSectionLabel?: string;
  commands?: PaneOverflowCommand[];
  hiddenActionIds: string[];
  label: string;
  onClose: () => void;
  onHideAction: (actionId: string) => void;
  onReorderAction?: (draggedId: string, targetId: string, position?: "before" | "after") => void;
  onRunAction?: (action: IconToolbarAction) => void;
  onRunCommand?: (command: PaneOverflowCommand) => void;
  onShowAction: (actionId: string) => void;
  onResetOrder?: () => void;
  isOrderCustomized?: boolean;
  plainActions?: boolean;
  preferPaneInside?: boolean;
  primaryActionIds?: string[];
  popupId: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const hiddenSet = new Set(hiddenActionIds);
  const primarySet = primaryActionIds ? new Set(primaryActionIds) : null;
  const menuActions = plainActions ? actions.filter((action) => !(action.hideWhenDisabled && action.disabled)) : actions;
  const quickCommands = commands.filter((command) => command.placement === "quick");
  const listCommands = commands.filter((command) => command.placement !== "quick");
  const menuRef = useRef<HTMLDivElement>(null);
  const closeIntentRef = useRef<PopupCloseIntent>("auto");
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<"before" | "after">("after");
  const draggedIdRef = useRef<string | null>(null);
  const dropPositionRef = useRef<"before" | "after">("after");
  const isDraggingRef = useRef(false);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    ready: boolean;
    width: number | null;
    maxHeight: number | null;
    placement: "pane-inside-above" | "pane-inside-below" | "trigger-above" | "trigger-below";
  }>({
    left: 8,
    top: 8,
    ready: false,
    width: null,
    maxHeight: null,
    placement: "trigger-below"
  });

  useLayoutEffect(() => {
    function updatePosition() {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const margin = 8;
      const gap = 8;
      const triggerRect = trigger.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const width = menuRect.width || Math.min(320, window.innerWidth - margin * 2);
      const scrollEl = menu.querySelector<HTMLElement>(".icon-action-manager-scroll");
      const scrollContentHeight = scrollEl && scrollEl.scrollHeight > scrollEl.offsetHeight
        ? menu.offsetHeight - scrollEl.offsetHeight + scrollEl.scrollHeight
        : 0;
      const height = Math.max(menuRect.height, scrollContentHeight) || Math.min(448, window.innerHeight * 0.7);
      const maxLeft = Math.max(margin, window.innerWidth - width - margin);
      const maxTop = Math.max(margin, window.innerHeight - height - margin);
      const pane = preferPaneInside ? trigger.closest<HTMLElement>(".pane-card") : null;
      if (pane) {
        const paneRect = pane.getBoundingClientRect();
        const paneLeft = Math.max(margin, paneRect.left);
        const paneRight = Math.min(window.innerWidth - margin, paneRect.right);
        const paneTop = Math.max(margin, paneRect.top);
        const paneBottom = Math.min(window.innerHeight - margin, paneRect.bottom);
        const insideWidth = Math.max(1, Math.min(width, paneRight - paneLeft - margin * 2));
        const belowTop = triggerRect.bottom + gap;
        const belowHeight = Math.max(0, paneBottom - margin - belowTop);
        const aboveHeight = Math.max(0, triggerRect.top - gap - (paneTop + margin));
        const placeBelow = belowHeight >= height || belowHeight >= aboveHeight;
        const availableHeight = placeBelow ? belowHeight : aboveHeight;
        const insideHeight = Math.max(1, Math.min(height, availableHeight));
        const insideTop = placeBelow
          ? belowTop
          : Math.max(paneTop + margin, triggerRect.top - gap - insideHeight);
        setPosition({
          left: Math.max(
            paneLeft + margin,
            Math.min(triggerRect.right - insideWidth, paneRight - margin - insideWidth)
          ),
          top: insideTop,
          ready: true,
          width: insideWidth,
          maxHeight: insideHeight,
          placement: placeBelow ? "pane-inside-below" : "pane-inside-above"
        });
        return;
      }
      const availableHeightBelow = Math.max(0, window.innerHeight - margin - (triggerRect.bottom + gap));
      const availableHeightAbove = Math.max(0, triggerRect.top - gap - margin);
      const fitsBelow = height <= availableHeightBelow;
      const fitsAbove = height <= availableHeightAbove;
      const placeBelow = fitsBelow || (!fitsAbove && availableHeightBelow >= availableHeightAbove);
      const availableHeight = placeBelow ? availableHeightBelow : availableHeightAbove;
      const desiredTop = placeBelow
        ? triggerRect.bottom + gap
        : triggerRect.top - gap - Math.min(height, availableHeight);
      const actualMaxHeight = height > availableHeight ? availableHeight : null;
      setPosition({
        left: Math.max(margin, Math.min(triggerRect.right - width, maxLeft)),
        top: Math.max(margin, Math.min(desiredTop, maxTop)),
        ready: true,
        width: null,
        maxHeight: actualMaxHeight,
        placement: placeBelow ? "trigger-below" : "trigger-above"
      });
    }

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [preferPaneInside, triggerRef]);

  useEffect(() => {
    const menu = menuRef.current;
    return () => restorePopupTriggerFocus(menu, triggerRef.current, closeIntentRef.current);
  }, [triggerRef]);

  useEffect(() => {
    if (!position.ready) return;
    const frame = window.requestAnimationFrame(() => {
      const menu = menuRef.current;
      if (!menu) return;
      // Window tiles sit above the list; start keyboard focus on the first task action.
      const items = enabledButtons(menu);
      (items.find((item) => !item.classList.contains("icon-action-manager-quick-button")) ?? items[0])?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [position.ready]);

  function dismiss() {
    closeIntentRef.current = "dismissal";
    onClose();
  }

  function runCommand(command: PaneOverflowCommand) {
    closeIntentRef.current = "activation";
    onRunCommand?.(command);
  }

  function runAction(action: IconToolbarAction) {
    closeIntentRef.current = "activation";
    onRunAction?.(action);
  }

  function handleDragStart(event: ReactDragEvent<HTMLElement>, actionId: string) {
    if (!onReorderAction) return;
    isDraggingRef.current = true;
    draggedIdRef.current = actionId;
    setDraggedId(actionId);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", actionId);
    }
  }

  function handleDragOver(event: ReactDragEvent<HTMLElement>, actionId: string) {
    const currentDragged = draggedIdRef.current || draggedId;
    if (!onReorderAction || !currentDragged || currentDragged === actionId) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const rowHeight = rect.height || 36;
    const midY = rect.top + rowHeight / 2;
    const clientY = typeof event.clientY === "number" ? event.clientY : midY - 1;
    const position = clientY < midY ? "before" : "after";
    dropPositionRef.current = position;
    setDragOverId(actionId);
    setDropPosition(position);
  }

  function handleDragLeave(event: ReactDragEvent<HTMLElement>, actionId: string) {
    if (event.currentTarget.contains(event.relatedTarget as Node)) return;
    if (dragOverId === actionId) {
      setDragOverId(null);
    }
  }

  function handleDrop(event: ReactDragEvent<HTMLElement>, targetActionId: string) {
    const sourceId = draggedIdRef.current || draggedId || event.dataTransfer?.getData("text/plain");
    if (!onReorderAction || !sourceId || sourceId === targetActionId) return;
    event.preventDefault();
    event.stopPropagation();
    const effectivePos = dropPositionRef.current || dropPosition;
    onReorderAction(sourceId, targetActionId, effectivePos);
    draggedIdRef.current = null;
    setDraggedId(null);
    setDragOverId(null);
    setTimeout(() => {
      isDraggingRef.current = false;
    }, 100);
  }

  function handleDragEnd() {
    draggedIdRef.current = null;
    setDraggedId(null);
    setDragOverId(null);
    setTimeout(() => {
      isDraggingRef.current = false;
    }, 100);
  }

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return;
    }
    const menu = menuRef.current;
    if (!menu) return;
    const items = enabledButtons(menu);
    if (!items.length) return;
    if (event.key === "Tab") {
      dismiss();
      return;
    }
    if (onReorderAction && (event.altKey || event.ctrlKey) && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      const activeElement = document.activeElement;
      const activeButton = items.find((btn) => btn === activeElement);
      const actionId = activeButton?.dataset.actionId;
      if (actionId) {
        // The first and last items have no neighbour; keep them in place instead of wrapping focus.
        event.preventDefault();
        const currentIndex = menuActions.findIndex((a) => a.id === actionId);
        const targetAction = currentIndex === -1 ? undefined : menuActions[event.key === "ArrowUp" ? currentIndex - 1 : currentIndex + 1];
        if (targetAction) {
          onReorderAction(actionId, targetAction.id, event.key === "ArrowUp" ? "before" : "after");
          requestAnimationFrame(() => {
            const nextBtn = menu.querySelector<HTMLButtonElement>(`button[data-action-id="${actionId}"]`);
            nextBtn?.focus();
          });
        }
        return;
      }
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const activeIndex = items.findIndex((item) => item === document.activeElement);
    // Home returns to the first task action, where the menu opens; the window tiles sit above it.
    const homeIndex = Math.max(0, items.findIndex((item) => !item.classList.contains("icon-action-manager-quick-button")));
    const nextIndex = event.key === "Home"
      ? homeIndex
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowUp"
          ? activeIndex <= 0 ? items.length - 1 : activeIndex - 1
          : activeIndex < 0 || activeIndex === items.length - 1 ? 0 : activeIndex + 1;
    items[nextIndex]?.focus();
  }

  return createPortal(
    <div
      id={popupId}
      ref={menuRef}
      className="icon-overflow-menu icon-action-manager"
      role="menu"
      aria-label={label}
      data-placement={position.placement}
      style={{
        left: `${position.left}px`,
        top: `${position.top}px`,
        width: position.width === null ? undefined : `${position.width}px`,
        maxHeight: position.maxHeight === null ? undefined : `${position.maxHeight}px`,
        visibility: position.ready ? "visible" : "hidden"
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={handleMenuKeyDown}
    >
      {commands.length ? (
        <div className="icon-action-manager-section" role="group" aria-label={commandSectionLabel}>
          {listCommands.length && !plainActions ? (
            <span className="icon-action-manager-section-label">{commandSectionLabel}</span>
          ) : null}
          {quickCommands.length ? (
            <div className="icon-action-manager-quick">
              {quickCommands.map((command) => {
                const CommandIcon = command.icon;
                return (
                  <button
                    key={command.id}
                    type="button"
                    role="menuitem"
                    className="icon-action-manager-quick-button"
                    aria-label={command.ariaLabel}
                    title={command.title ?? command.description}
                    disabled={command.disabled}
                    onClick={() => runCommand(command)}
                  >
                    <CommandIcon aria-hidden="true" />
                    <span>{command.label}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
          {listCommands.map((command) => {
            const CommandIcon = command.icon;
            return (
              <button
                key={command.id}
                type="button"
                role="menuitem"
                aria-label={command.ariaLabel}
                title={command.title ?? command.description}
                disabled={command.disabled}
                onClick={() => runCommand(command)}
              >
                <CommandIcon aria-hidden="true" />
                <span>{command.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {menuActions.length ? <div className="icon-action-manager-scroll">
        <div className="icon-action-manager-section" role="group" aria-label={plainActions ? "Pane actions" : "Toolbar buttons"}>
          {plainActions ? null : <span className="icon-action-manager-section-label">Toolbar buttons</span>}
          {menuActions.map((action) => {
            const ActionIcon = action.icon;
            const isHidden = hiddenSet.has(action.id);
            const isShown = !isHidden && (primarySet?.has(action.id) ?? true);
            const canHide = action.hideable !== false;
            const stateLabel = isShown ? (canHide ? "Hide" : "Shown") : "Show";
            const isDraggable = Boolean(onReorderAction) && action.draggable !== false;
            const isDragging = draggedId === action.id;
            const isDragOver = dragOverId === action.id;
            const rowDragClass = isDragging
              ? " is-dragging"
              : isDragOver
                ? dropPosition === "before"
                  ? " is-drag-over-before"
                  : " is-drag-over-after"
                : "";

            return (
              <div
                key={action.id}
                className={`icon-action-manager-row${rowDragClass}`}
                draggable={isDraggable}
                onDragStart={(event) => handleDragStart(event, action.id)}
                onDragOver={(event) => handleDragOver(event, action.id)}
                onDragLeave={(event) => handleDragLeave(event, action.id)}
                onDrop={(event) => handleDrop(event, action.id)}
                onDragEnd={handleDragEnd}
              >
                {plainActions ? (
                  <button
                    type="button"
                    role="menuitem"
                    className={action.tone === "danger" ? "is-danger" : undefined}
                    data-action-id={action.id}
                    aria-label={action.ariaLabel}
                    title={action.shortcut ? `${action.title} (${action.shortcut})` : action.title}
                    disabled={action.disabled}
                    onClick={(event) => {
                      if (isDraggingRef.current) {
                        event.preventDefault();
                        return;
                      }
                      runAction(action);
                    }}
                  >
                    <ActionIcon aria-hidden="true" />
                    <span>{action.label}</span>
                    {action.shortcut ? <kbd className="icon-action-manager-shortcut" aria-hidden="true">{action.shortcut}</kbd> : null}
                  </button>
                ) : (
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    data-action-id={action.id}
                    aria-checked={isShown}
                    aria-label={`${stateLabel} ${action.ariaLabel}`}
                    disabled={isShown && !canHide}
                    onClick={(event) => {
                      if (isDraggingRef.current) {
                        event.preventDefault();
                        return;
                      }
                      if (isShown) {
                        onHideAction(action.id);
                      } else {
                        onShowAction(action.id);
                      }
                    }}
                  >
                    <ActionIcon aria-hidden="true" />
                    <span>{action.label}</span>
                    <span className="icon-action-manager-state">{stateLabel}</span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div> : null}
      {onResetOrder && isOrderCustomized && menuActions.length > 1 ? (
        <div className="icon-action-manager-footer">
          <button
            type="button"
            role="menuitem"
            className="icon-action-manager-reset"
            title="Restore the default order of these actions"
            onClick={() => {
              onResetOrder();
              // The reset button unmounts once the order is default again; keep keyboard focus in the menu.
              requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>("button[data-action-id]:not(:disabled)")?.focus());
            }}
          >
            <RotateCcw aria-hidden="true" />
            <span>Reset order</span>
          </button>
        </div>
      ) : null}
    </div>,
    document.body
  );
}
