import { useMemo, useState } from "react";
import { APP_STUDIO_DEVICES, appStudioDevice, type AppStudioDevice, type AppStudioPreview } from "@space/contracts";

type PlatformFilter = "ALL" | "ANDROID" | "IOS";
const FILTERS: Array<[PlatformFilter, string]> = [["ALL", "All"], ["ANDROID", "Android"], ["IOS", "iPhone"]];
/** Frame width on screen for a 400 pt wide phone; every phone keeps its own proportions. */
const FRAME_SCALE = 0.55;

/** One phone: its capture inside a bezel with the device's own cutout (punch-hole, notch or Dynamic Island). */
function DeviceFrame({ device, preview }: { device: AppStudioDevice; preview: AppStudioPreview }) {
  const width = Math.round(device.width * FRAME_SCALE);
  return (
    <figure className="as-device" data-platform={device.platform.toLowerCase()} data-cutout={device.cutout.toLowerCase()} style={{ "--as-screen-width": `${width}px`, "--as-aspect": `${device.width} / ${device.height}` } as React.CSSProperties}>
      <div className="as-bezel">
        <div className="as-screen">
          <img src={`/api/artifacts/${encodeURIComponent(preview.artifactId)}/file`} alt={`${device.label} preview of ${preview.route}`} loading="lazy" draggable={false} />
          <span className="as-cutout" aria-hidden="true" />
        </div>
      </div>
      <figcaption><strong>{device.label}</strong><span>{device.width}×{device.height}</span></figcaption>
    </figure>
  );
}

/** The latest capture of each phone for one screen, Android and iPhone side by side or one platform at a time. */
export function PreviewView({ previews }: { previews: AppStudioPreview[] }) {
  const [filter, setFilter] = useState<PlatformFilter>("ALL");
  const routes = useMemo(() => [...new Set(previews.map((preview) => preview.route))].sort(), [previews]);
  const newestRoute = useMemo(() => [...previews].sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))[0]?.route ?? null, [previews]);
  const [chosenRoute, setChosenRoute] = useState<string | null>(null);
  const route = chosenRoute && routes.includes(chosenRoute) ? chosenRoute : newestRoute;
  const shown = useMemo(() => {
    const order = new Map(APP_STUDIO_DEVICES.map((device, index) => [device.id, index]));
    return previews.filter((preview) => preview.route === route)
      .flatMap((preview) => { const device = appStudioDevice(preview.deviceId); return device && (filter === "ALL" || device.platform === filter) ? [{ device, preview }] : []; })
      .sort((left, right) => (order.get(left.device.id) ?? 0) - (order.get(right.device.id) ?? 0));
  }, [filter, previews, route]);
  const capturedAt = shown.map((entry) => entry.preview.capturedAt).sort().at(-1);

  if (!previews.length) {
    return (
      <div className="jc-empty as-empty" role="status">
        <strong>No previews yet</strong>
        <span>Give App Studio a brief in Activity. Its agent builds the app and shows every screen here on Android and iPhone.</span>
      </div>
    );
  }
  return (
    <div className="as-preview">
      <div className="as-preview-bar">
        <div className="jc-chips" role="radiogroup" aria-label="Platform">
          {FILTERS.map(([id, label]) => (
            <button key={id} type="button" role="radio" aria-checked={filter === id} className={`jc-chip${filter === id ? " selected" : ""}`} onClick={() => setFilter(id)}>{label}</button>
          ))}
        </div>
        <label className="as-route"><span>Screen</span>
          <select value={route ?? ""} aria-label="Screen" onChange={(event) => setChosenRoute(event.target.value)}>
            {routes.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
          </select>
        </label>
        {capturedAt ? <span className="jc-muted as-captured">Captured {new Date(capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span> : null}
      </div>
      {shown.length ? (
        <div className="as-devices" aria-label="Device previews">{shown.map(({ device, preview }) => <DeviceFrame key={device.id} device={device} preview={preview} />)}</div>
      ) : <p className="jc-muted jc-empty">No {filter === "IOS" ? "iPhone" : "Android"} preview of this screen yet.</p>}
    </div>
  );
}
