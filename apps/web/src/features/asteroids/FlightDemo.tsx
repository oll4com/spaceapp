import { useEffect, useState } from "react";
import { SpaceappMark } from "./SpaceappMark.js";

/** Tiny silent CSS/SVG illustration. No game simulation, RAF or JS timers. */
export function FlightDemo() {
  const [active, setActive] = useState(() => !document.hidden);
  useEffect(() => {
    const hide = () => setActive(false);
    const show = () => setActive(!document.hidden);
    const visibility = () => setActive(!document.hidden);
    window.addEventListener("blur", hide); window.addEventListener("focus", show);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("blur", hide); window.removeEventListener("focus", show);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  return <figure className="asteroids-flight-demo" data-active={active} aria-label="Flight demo: thrust moves the ship forward, then turn and fire. Pauses and repeats.">
    <div className="asteroids-demo-circle" aria-hidden="true">
      <div className="asteroids-demo-logo"><SpaceappMark /></div>
      <svg viewBox="0 0 200 200" className="asteroids-demo-scene">
        <path d="M52 154V74Q52 64 62 64H145" fill="none" stroke="var(--asteroids-border)" strokeDasharray="3 7" />
        <path d="m47 104 5-7 5 7m43-45 7 5-7 5" fill="none" stroke="var(--asteroids-accent)" />
        <path className="asteroids-demo-rock" d="m163 53 12-3 9 11-4 12-14 2-7-10z" fill="var(--asteroids-surface)" stroke="var(--asteroids-muted)" strokeWidth="1.5" />
        <g className="asteroids-demo-ship">
          <path className="asteroids-demo-flame" d="M-8-4-24 0-8 4" fill="var(--asteroids-warning)" />
          <path d="M13 0-9-8-5 0-9 8Z" fill="var(--asteroids-surface)" stroke="var(--asteroids-accent)" strokeWidth="2" />
        </g>
        <path className="asteroids-demo-shot" d="M0 0H8" stroke="var(--asteroids-accent)" strokeWidth="2.5" />
        <circle className="asteroids-demo-hit" cx="171" cy="64" r="18" fill="none" stroke="var(--asteroids-text)" strokeWidth="2" />
      </svg>
    </div>
    <figcaption><strong>Hold W / ↑ to fly forward</strong><span>Turn with A / D · fire with Space</span></figcaption>
  </figure>;
}
