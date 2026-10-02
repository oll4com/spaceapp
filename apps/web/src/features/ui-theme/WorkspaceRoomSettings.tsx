import type { IconToolbarAction } from "../../icon-toolbar.js";
import { desktopActionDescriptions } from "./desktop-navigation.js";
import { workspaceActionLabel, workspaceActionToggle, workspaceRoomActionIds } from "./workspace-actions.js";

export function WorkspaceRoomSettings({ actions, detailActionIds, onNavigate }: {
  actions: IconToolbarAction[];
  detailActionIds: readonly string[];
  onNavigate: (id: string) => void;
}) {
  return <div className="workspace-room-actions" role="group" aria-label="Room settings">
    {workspaceRoomActionIds.flatMap(id => {
      const action = actions.find(item => item.id === id);
      return action ? [action] : [];
    }).map(action => {
      const Icon = action.icon;
      const label = workspaceActionLabel(action);
      const toggle = workspaceActionToggle(action);
      const reason = action.disabled ? action.disabledReason : undefined;
      return <button key={action.id} type="button" className="workspace-room-action" data-action-id={action.id}
        disabled={action.disabled} aria-label={label} aria-pressed={toggle ?? action.ariaPressed}
        title={reason ?? action.title}
        onClick={() => detailActionIds.includes(action.id) ? onNavigate(action.id) : action.onClick()}>
        <Icon aria-hidden="true" />
        <span><strong>{label}</strong><small>{reason ?? desktopActionDescriptions[action.id]}</small></span>
        {toggle !== undefined ? <small className="desktop-action-status" data-on={toggle}>{toggle ? "On" : "Off"}</small> : null}
      </button>;
    })}
  </div>;
}
