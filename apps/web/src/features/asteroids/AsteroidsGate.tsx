import { lazy, Suspense, useRef, useState } from "react";
import { Rocket, X } from "../ui-theme/app-icons.js";
import { RecoverableSurface } from "../SurfaceErrorBoundary.js";

const Game = lazy(() => import("./SpaceappAsteroids.js"));

/** Mounted only in the active, loaded, genuinely empty pane background. */
export function AsteroidsGate() {
  const [open, setOpen] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => launcher.current?.focus({ preventScroll: true }));
  };
  return open ? (
    <div className="asteroids-host">
      <button className="asteroids-close" type="button" aria-label="Close Spaceapp Asteroids" title="Close game (Esc)" onClick={close}><X aria-hidden="true" /></button>
      <RecoverableSurface fallback={<p className="asteroids-loading" role="status">Loading Spaceapp Asteroids…</p>}>
        <Suspense fallback={<p className="asteroids-loading" role="status">Loading Spaceapp Asteroids…</p>}>
          <Game onClose={close} />
        </Suspense>
      </RecoverableSurface>
    </div>
  ) : (
    <button ref={launcher} type="button" className="asteroids-easter-egg" aria-label="Play Spaceapp Asteroids" title="A little space to play" onClick={() => setOpen(true)}>
      <Rocket aria-hidden="true" />
    </button>
  );
}
