import { HIDEABLE_CLI_SHORTCUT_IDS, PINNED_CLI_SHORTCUT_ID, TRANSCRIPT_CLI_SHORTCUT_ID } from "../osk-keyboard/cli-shortcuts.js";
import { SHORTCUT_ICONS, SHORTCUT_TITLES } from "./CliShortcutsMenu.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import "./cli-shortcut-visibility.css";

const SHORTCUT_IDS = [PINNED_CLI_SHORTCUT_ID, ...HIDEABLE_CLI_SHORTCUT_IDS];

// Mirrors the two-column menu order so the operator picks shortcuts where they will appear.
export function CliShortcutVisibilitySettings({
  hiddenIds,
  onChange
}: {
  hiddenIds: readonly string[];
  onChange: (hiddenIds: string[]) => void;
}) {
  const hidden = new Set(hiddenIds);

  return (
    <div className="cli-shortcut-visibility">
      <div className="settings-flat-subheading">
        <strong>Shortcuts menu</strong>
        <small>Choose which shortcuts appear. The order is fixed and Continue always comes first.</small>
      </div>
      <div className="cli-shortcut-visibility-grid" role="group" aria-label="Visible shortcuts">
        {SHORTCUT_IDS.map((id) => {
          const pinned = id === PINNED_CLI_SHORTCUT_ID;
          const Icon = SHORTCUT_ICONS[id];
          const label = id === TRANSCRIPT_CLI_SHORTCUT_ID ? "Transcript" : SHORTCUT_TITLES[id] ?? id;
          const note = pinned ? "Always first" : id === TRANSCRIPT_CLI_SHORTCUT_ID ? "Codex, Claude" : null;
          const visible = pinned || !hidden.has(id);
          return (
            <div key={id} className={`cli-shortcut-visibility-item${visible ? "" : " is-hidden"}`} data-shortcut={id}>
              <SpaceToggle
                name={`cli-shortcut-${id}`}
                ariaLabel={label}
                label={<span className="cli-shortcut-visibility-name">{Icon ? <Icon aria-hidden="true" /> : null}<span>{label}</span></span>}
                detail={note ?? undefined}
                title={pinned ? "Continue is always shown first" : undefined}
                checked={visible}
                disabled={pinned}
                onChange={(next) => {
                  onChange(HIDEABLE_CLI_SHORTCUT_IDS.filter((entry) => (entry === id ? !next : hidden.has(entry))));
                }}
              />
            </div>
          );
        })}
      </div>
      <button type="button" className="cli-shortcut-visibility-reset" disabled={hidden.size === 0} onClick={() => onChange([])}>
        Show all
      </button>
    </div>
  );
}
