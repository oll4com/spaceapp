import { MAX_CLI_IMAGE_PREVIEW_LIMIT, MIN_CLI_IMAGE_PREVIEW_LIMIT, normalizeCliImagePreviewLimit } from "../../cli-upload-settings.js";
import {
  MAX_WARM_ROOM_CONNECTED_PANE_LIMIT,
  MIN_WARM_ROOM_CONNECTED_PANE_LIMIT,
  normalizeWarmRoomConnectedPaneLimit
} from "../../warm-room-settings.js";
import { CliRuntimeSettingsCard } from "../cli-runtime-settings/CliRuntimeSettingsCard.js";
import { CliProvidersSettingsCard } from "../cli-providers-settings/CliProvidersSettingsCard.js";
import { T3CodeServiceSettingsCard } from "../t3code-settings/T3CodeServiceSettingsCard.js";
import { CliPaneControlsSettingsCard } from "../voice-input/CliPaneControlsSettingsCard.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { CodeXml, Gauge, GitBranch, Images, MousePointer2 } from "../ui-theme/app-icons.js";
import { SettingsDisclosure, SettingsSections } from "../settings/SettingsDisclosure.js";
import { DockNotice } from "../dock-kit/DockKit.js";

interface CliDockProps {
  canManage: boolean;
  cliImagePreviewLimit: number;
  warmRoomEnabled: boolean;
  warmConnectedPaneLimit: number;
  defaultWorktreeEnabled?: boolean;
  onCliImagePreviewLimitChange: (limit: number) => void;
  onWarmRoomEnabledChange: (enabled: boolean) => void;
  onWarmConnectedPaneLimitChange: (limit: number) => void;
  onDefaultWorktreeEnabledChange?: (enabled: boolean) => void;
  onOpenRestartAll: () => void;
  restartAllPending: boolean;
}

export function CliDock({
  canManage,
  cliImagePreviewLimit,
  warmRoomEnabled,
  warmConnectedPaneLimit,
  defaultWorktreeEnabled = true,
  onCliImagePreviewLimitChange,
  onWarmRoomEnabledChange,
  onWarmConnectedPaneLimitChange,
  onDefaultWorktreeEnabledChange,
  onOpenRestartAll,
  restartAllPending
}: CliDockProps) {
  return (
    <div className="dock-panel cli-dock">
      <SettingsSections>
      {/* The shell header already names this dock; only the role explanation stays here. */}
      {!canManage ? <DockNotice tone="info">The ADMIN role can manage CLI runtimes.</DockNotice> : null}

      <CliRuntimeSettingsCard
        canManage={canManage}
        onOpenRestartAll={onOpenRestartAll}
        restartAllPending={restartAllPending}
        disclosures
      />

      <CliProvidersSettingsCard canManage={canManage} />

      {canManage ? (
        <SettingsDisclosure title="T3 Code" description="Status, version, on/off and restart of the managed T3 Code service." scope="Installation" icon={CodeXml}>
          <T3CodeServiceSettingsCard />
        </SettingsDisclosure>
      ) : null}

      <SettingsDisclosure title="CLI pane controls" description="Buttons and menus inside AI coding panes." scope="Your account" icon={MousePointer2}
        help="Choose which buttons float over AI coding panes (CLI panes) and which commands the Shortcuts menu lists. Hiding a button doesn't switch its feature off."
        keywords="terminal cli shortcuts right-click context menu buttons mic model stop turn plans variables">
        <CliPaneControlsSettingsCard />
      </SettingsDisclosure>

      <SettingsDisclosure title="Git worktrees" description="Whether new CLI panes work on their own branch copy." scope="Your account" icon={GitBranch}>
        <section className="agent-settings-card settings-flat-card cli-worktree-settings-card" aria-label="Git Worktrees default settings">
          <div className="agent-settings-section-title settings-flat-heading">
            <GitBranch aria-hidden="true" />
            <span>
              <strong>Git Worktrees</strong>
              <small>{defaultWorktreeEnabled ? "New CLI panes start on their own branch copy." : "New CLI panes work directly in the project folder."}</small>
            </span>
          </div>
          <SpaceToggle
            className="settings-flat-row settings-flat-toggle-row default-worktree-toggle"
            name="default-worktree-enabled"
            ariaLabel="Enable isolated worktrees by default"
            label="Isolated worktrees by default"
            detail="In rooms with a project folder, each new CLI pane works in its own Git worktree (a separate branch copy), so it cannot change your main checkout until you merge it."
            checked={Boolean(defaultWorktreeEnabled)}
            onChange={(checked) => onDefaultWorktreeEnabledChange?.(checked)}
          />
        </section>
      </SettingsDisclosure>

      <SettingsDisclosure title="Room cache" description="Keep recently used rooms ready for your account." scope="Your account" icon={Gauge}>
      <section className="agent-settings-card settings-flat-card warm-room-cache-settings-card" aria-label="Warm room cache settings">
        <div className="agent-settings-section-title settings-flat-heading">
          <Gauge aria-hidden="true" />
          <span>
            <strong>Warm room cache</strong>
            <small>{warmRoomEnabled ? `${warmConnectedPaneLimit} connected panes can remain warm in this browser.` : "Disabled in this browser."}</small>
          </span>
        </div>
        <SpaceToggle
          className="settings-flat-row settings-flat-toggle-row warm-room-enable-toggle"
          name="warm-room-cache-enabled"
          ariaLabel="Enable warm room cache"
          label="Warm room cache"
          detail="Keep recently used rooms ready in this browser."
          checked={warmRoomEnabled}
          onChange={onWarmRoomEnabledChange}
        />
        <label className="settings-flat-row">
          <span className="settings-flat-row-copy">
            <strong>Warm connected pane limit</strong>
            <small>Terminal and browser panes that can stay connected in hidden rooms.</small>
          </span>
          <input
            className="settings-flat-control"
            type="number"
            min={MIN_WARM_ROOM_CONNECTED_PANE_LIMIT}
            max={MAX_WARM_ROOM_CONNECTED_PANE_LIMIT}
            step={1}
            aria-label="Warm connected pane limit"
            name="warm-connected-pane-limit"
            value={warmConnectedPaneLimit}
            disabled={!warmRoomEnabled}
            onChange={(event) => onWarmConnectedPaneLimitChange(normalizeWarmRoomConnectedPaneLimit(event.target.value))}
          />
        </label>
        <p className="settings-flat-note">
          {warmRoomEnabled
            ? "Two rooms of 16 connected panes fit exactly at 32."
            : "Only the active room is mounted while the cache is off."}
        </p>
        <p className="settings-flat-note">
          {warmRoomEnabled
            ? "Higher values use more RAM and CPU in this browser."
            : "CLI processes continue running on the pane host when you leave a room."}
        </p>
      </section>

      </SettingsDisclosure>
      <SettingsDisclosure title="Image previews" description="How many uploaded images a CLI pane's preview strip shows at once." scope="Your account" icon={Images}>
      <section className="agent-settings-card settings-flat-card cli-upload-settings-card" aria-label="CLI photo preview settings">
        <div className="agent-settings-section-title settings-flat-heading">
          <Images aria-hidden="true" />
          <span>
            <strong>CLI photo previews</strong>
            <small>{cliImagePreviewLimit} images shown at a time in the preview strip.</small>
          </span>
        </div>
        <label className="settings-flat-row">
          <span className="settings-flat-row-copy">
            <strong>Photo previews</strong>
            <small>Images shown at once in a CLI pane&apos;s preview strip. Older images move to earlier pages.</small>
          </span>
          <input
            className="settings-flat-control"
            type="number"
            min={MIN_CLI_IMAGE_PREVIEW_LIMIT}
            max={MAX_CLI_IMAGE_PREVIEW_LIMIT}
            step={1}
            aria-label="CLI photo preview limit"
            name="cli-image-preview-limit"
            value={cliImagePreviewLimit}
            onChange={(event) => onCliImagePreviewLimitChange(normalizeCliImagePreviewLimit(event.target.value))}
          />
        </label>
      </section>

      </SettingsDisclosure>
      </SettingsSections>
    </div>
  );
}
