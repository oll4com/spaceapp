import { useEffect, useRef, type ReactNode, type RefObject, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { X } from "../ui-theme/app-icons.js";
import type { IconToolbarAction } from "../../icon-toolbar.js";
import { enabledButtons, restorePopupTriggerFocus, type PaneOverflowCommand, type PopupCloseIntent } from "./action-surface-shared.js";

export function MobileActionSheet({
  actionSections,
  actions,
  commandSectionLabel = "Task commands",
  commands = [],
  hiddenActionIds,
  label,
  onClose,
  onHideAction,
  onRunCommand,
  onShowAction,
  onRunAction,
  plainActions = false,
  popupId,
  summary,
  triggerRef,
}: {
  actionSections?: Array<{ id: string; label: string; actions: IconToolbarAction[] }>;
  actions: IconToolbarAction[];
  commandSectionLabel?: string;
  commands?: PaneOverflowCommand[];
  hiddenActionIds: string[];
  label: string;
  onClose: () => void;
  onHideAction: (actionId: string) => void;
  onRunCommand?: (command: PaneOverflowCommand) => void;
  onShowAction: (actionId: string) => void;
  onRunAction: (action: IconToolbarAction) => void;
  plainActions?: boolean;
  popupId: string;
  summary?: ReactNode;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const hiddenSet = new Set(hiddenActionIds);
  const toolbarSections = actionSections ?? [{ id: "toolbar", label: plainActions ? "Pane actions" : "Toolbar buttons", actions }];
  const dialogRef = useRef<HTMLElement>(null);
  const closeIntentRef = useRef<PopupCloseIntent>("auto");
  const swipeStartYRef = useRef<number | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog) enabledButtons(dialog)[0]?.focus();
    return () => restorePopupTriggerFocus(dialog, triggerRef.current, closeIntentRef.current);
  }, [triggerRef]);

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
    onRunAction(action);
  }

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const buttons = enabledButtons(dialog);
    const first = buttons[0];
    const last = buttons.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="mobile-action-sheet-backdrop" onClick={dismiss}>
      <section
        id={popupId}
        ref={dialogRef}
        className="mobile-action-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <header
          onPointerDown={(event) => { swipeStartYRef.current = event.clientY; }}
          onPointerUp={(event) => {
            // Pulling the sheet's header down closes it, like a native bottom sheet.
            if (swipeStartYRef.current !== null && event.clientY - swipeStartYRef.current > 60) dismiss();
            swipeStartYRef.current = null;
          }}
          onPointerCancel={() => { swipeStartYRef.current = null; }}
        >
          <strong>{label}</strong>
          <button type="button" className="mobile-action-sheet-close" aria-label={`Close ${label}`} onClick={dismiss}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="mobile-action-sheet-list">
          {summary}
          {commands.length ? (
            <div className="mobile-action-sheet-section" role="group" aria-label={commandSectionLabel}>
              <span className="mobile-action-sheet-section-label">{commandSectionLabel}</span>
              {commands.map((command) => {
                const CommandIcon = command.icon;
                return (
                  <div className="mobile-action-sheet-row" key={command.id}>
                    <button
                      type="button"
                      className="mobile-action-sheet-main"
                      aria-label={command.ariaLabel}
                      title={command.title}
                      disabled={command.disabled}
                      onClick={() => runCommand(command)}
                    >
                      <CommandIcon aria-hidden="true" />
                      <span>
                        <strong>{command.label}</strong>
                        {/* Touch has no tooltip, so a disabled command shows its reason here. */}
                        <small>{command.disabled && command.title ? command.title : command.description}</small>
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}
          {toolbarSections.map((section) => section.actions.length ? (
            <div className="mobile-action-sheet-section" role="group" aria-label={section.label} key={section.id}>
              <span className="mobile-action-sheet-section-label">{section.label}</span>
              {section.actions.map((action) => {
                const ActionIcon = action.icon;
                const isHidden = hiddenSet.has(action.id);
                if (plainActions) {
                  return (
                    <div className="mobile-action-sheet-row" key={action.id}>
                      <button
                        type="button"
                        className="mobile-action-sheet-main"
                        aria-label={action.ariaLabel}
                        aria-controls={action.ariaControls}
                        aria-expanded={action.ariaExpanded}
                        aria-haspopup={action.ariaHasPopup}
                        disabled={action.disabled}
                        onClick={() => runAction(action)}
                      >
                        <ActionIcon aria-hidden="true" />
                        <span>
                          <strong>{action.label}</strong>
                          <small>{action.title}</small>
                        </span>
                      </button>
                    </div>
                  );
                }
                return (
                  <div className={isHidden ? "mobile-action-sheet-row is-hidden" : "mobile-action-sheet-row"} key={action.id}>
                    <button
                      type="button"
                      className="mobile-action-sheet-main"
                      aria-label={action.ariaLabel}
                      aria-controls={action.ariaControls}
                      aria-expanded={action.ariaExpanded}
                      aria-haspopup={action.ariaHasPopup}
                      disabled={action.disabled || isHidden}
                      onClick={() => runAction(action)}
                    >
                      <ActionIcon aria-hidden="true" />
                      <span>
                        <strong>{action.label}</strong>
                        <small>{isHidden ? "Hidden" : action.title}</small>
                      </span>
                    </button>
                    {action.hideable === false ? null : (
                      <button
                        type="button"
                        className="mobile-action-sheet-toggle"
                        aria-label={`${isHidden ? "Show" : "Hide"} ${action.label}`}
                        onClick={() => {
                          if (isHidden) {
                            onShowAction(action.id);
                          } else {
                            onHideAction(action.id);
                          }
                        }}
                      >
                        {isHidden ? "Show" : "Hide"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null)}
        </div>
      </section>
    </div>
  );
}
