import { MAX_CLI_IMAGE_PREVIEW_LIMIT, MIN_CLI_IMAGE_PREVIEW_LIMIT, normalizeCliImagePreviewLimit } from "../../cli-upload-settings.js";
import type { WarmRoomCapacitySnapshot } from "../../warm-room-capacity-controller.js";
import { CliRuntimeSettingsCard } from "../cli-runtime-settings/CliRuntimeSettingsCard.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { Gauge, Images } from "../ui-theme/app-icons.js";
import "./cli-dock.css";

interface CliDockProps {
  canManage: boolean;
  cliImagePreviewLimit: number;
  warmRoomEnabled: boolean;
  warmRoomCapacity: WarmRoomCapacitySnapshot;
  onCliImagePreviewLimitChange: (limit: number) => void;
  onWarmRoomEnabledChange: (enabled: boolean) => void;
  onOpenRestartAll: () => void;
  restartAllPending: boolean;
}

export function CliDock({
  canManage,
  cliImagePreviewLimit,
  warmRoomEnabled,
  warmRoomCapacity,
  onCliImagePreviewLimitChange,
  onWarmRoomEnabledChange,
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
            <small>{warmRoomEnabled ? "Capacity adapts to this browser." : "Disabled in this browser."}</small>
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
        <dl
          className="warm-room-capacity-status settings-flat-metrics"
          role="status"
          aria-label="Warm room capacity status"
        >
          <div><dt>Safe capacity</dt><dd>{warmRoomCapacity.effectiveSafeRoomCapacity} rooms</dd></div>
          <div><dt>Warm rooms</dt><dd>{warmRoomCapacity.warmRoomCount}</dd></div>
          <div><dt>Connected panes</dt><dd>{warmRoomCapacity.connectedPaneCount}</dd></div>
          <div><dt>Memory source</dt><dd>{warmRoomCapacity.memorySource}</dd></div>
          <div>
            <dt>Pressure</dt>
            <dd>{warmRoomCapacity.pressureReasons.length
              ? warmRoomCapacity.pressureReasons.join(", ")
              : "Healthy"}</dd>
          </div>
          <div>
            <dt>Admission</dt>
            <dd>{warmRoomEnabled ? "Auto Open safely" : "Disabled"}</dd>
          </div>
        </dl>
        <p className="settings-flat-note">
          {warmRoomEnabled
            ? "One full-room reserve is kept; memory pressure reduces hidden warm rooms before navigation is affected."
            : "Only the active room is mounted; CLI processes continue on the pane host."}
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
