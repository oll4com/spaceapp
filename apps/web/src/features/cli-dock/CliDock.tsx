import { MAX_CLI_IMAGE_PREVIEW_LIMIT, MIN_CLI_IMAGE_PREVIEW_LIMIT, normalizeCliImagePreviewLimit } from "../../cli-upload-settings.js";
import {
  MAX_WARM_ROOM_CONNECTED_PANE_LIMIT,
  MIN_WARM_ROOM_CONNECTED_PANE_LIMIT,
  normalizeWarmRoomConnectedPaneLimit
} from "../../warm-room-settings.js";
import { CliRuntimeSettingsCard } from "../cli-runtime-settings/CliRuntimeSettingsCard.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { Gauge, Images } from "../ui-theme/app-icons.js";
import "./cli-dock.css";

interface CliDockProps {
  canManage: boolean;
  cliImagePreviewLimit: number;
  warmRoomEnabled: boolean;
  warmConnectedPaneLimit: number;
  onCliImagePreviewLimitChange: (limit: number) => void;
  onWarmRoomEnabledChange: (enabled: boolean) => void;
  onWarmConnectedPaneLimitChange: (limit: number) => void;
  onOpenRestartAll: () => void;
  restartAllPending: boolean;
}

export function CliDock({
  canManage,
  cliImagePreviewLimit,
  warmRoomEnabled,
  warmConnectedPaneLimit,
  onCliImagePreviewLimitChange,
  onWarmRoomEnabledChange,
  onWarmConnectedPaneLimitChange,
  onOpenRestartAll,
  restartAllPending
}: CliDockProps) {
  return (
    <div className="cli-dock">
      {!canManage ? <p className="dock-muted-text">The ADMIN role can manage CLI runtimes.</p> : null}

      <CliRuntimeSettingsCard
        canManage={canManage}
        onOpenRestartAll={onOpenRestartAll}
        restartAllPending={restartAllPending}
      />

      <a
        className="spaceapp-download-banner"
        href="https://spaceapp.dev"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Download SpaceApp from SpaceApp.dev"
      >
        <img
          src="/brand/spaceapp-open-source-banner.webp"
          alt="SpaceApp is open source and free to download."
          decoding="async"
        />
      </a>

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

      <section className="agent-settings-card settings-flat-card cli-upload-settings-card" aria-label="CLI photo preview settings">
        <div className="agent-settings-section-title settings-flat-heading">
          <Images aria-hidden="true" />
          <span>
            <strong>CLI photo previews</strong>
            <small>{cliImagePreviewLimit} images retained in the floating preview strip.</small>
          </span>
        </div>
        <label className="settings-flat-row">
          <span className="settings-flat-row-copy">
            <strong>Photo previews</strong>
            <small>Images retained in the floating preview strip.</small>
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

    </div>
  );
}
