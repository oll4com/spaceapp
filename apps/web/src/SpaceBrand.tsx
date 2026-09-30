import { useEffect, useRef, useState } from "react";

const STATIC_LOGO_SRC = "/brand/space-logo-2048.png";
const STATIC_LIGHT_LOGO_SRC = "/brand/space-logo-light.svg";
const ANIMATED_LOGO_SRC = "/brand/space-logo.gif";
const FALLBACK_LOGO_SRC = "/brand/space-logo.svg";
const ANIMATION_DURATION_MS = 4_800;

type StaticLogoSource = typeof STATIC_LOGO_SRC | typeof STATIC_LIGHT_LOGO_SRC | typeof FALLBACK_LOGO_SRC;

function getInitialIsLight(): boolean {
  if (typeof document === "undefined") return false;
  return document.body?.getAttribute("data-color-mode") === "light" ||
         document.documentElement?.getAttribute("data-color-mode") === "light" ||
         document.querySelector(".space-shell")?.getAttribute("data-color-mode") === "light";
}

export function SpaceBrand() {
  const [isLight, setIsLight] = useState(getInitialIsLight);
  const [staticSource, setStaticSource] = useState<StaticLogoSource>(() => getInitialIsLight() ? STATIC_LIGHT_LOGO_SRC : STATIC_LOGO_SRC);
  const [isAnimating, setIsAnimating] = useState(false);
  const [animationRun, setAnimationRun] = useState(0);
  const [showTextFallback, setShowTextFallback] = useState(false);
  const animationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const checkLight = () => {
      const light = getInitialIsLight();
      setIsLight(light);
      setStaticSource((prev) => {
        if (prev === STATIC_LOGO_SRC && light) return STATIC_LIGHT_LOGO_SRC;
        if (prev === STATIC_LIGHT_LOGO_SRC && !light) return STATIC_LOGO_SRC;
        return prev;
      });
    };
    const observer = new MutationObserver(checkLight);
    observer.observe(document.body, { attributes: true, attributeFilter: ["data-color-mode"] });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-color-mode"] });
    return () => observer.disconnect();
  }, []);

  function clearAnimationTimer() {
    if (animationTimerRef.current === null) return;
    clearTimeout(animationTimerRef.current);
    animationTimerRef.current = null;
  }

  function stopAnimation() {
    clearAnimationTimer();
    setIsAnimating(false);
  }

  function startAnimationTimer() {
    clearAnimationTimer();
    animationTimerRef.current = setTimeout(() => {
      animationTimerRef.current = null;
      setIsAnimating(false);
    }, ANIMATION_DURATION_MS);
  }

  function playAnimation() {
    clearAnimationTimer();
    setShowTextFallback(false);
    setAnimationRun((current) => current + 1);
    setIsAnimating(true);
  }

  useEffect(() => clearAnimationTimer, []);

  const imageSource = isAnimating ? ANIMATED_LOGO_SRC : staticSource;

  return (
    <button
      type="button"
      className="space-brand-control"
      aria-label="Play Space logo animation"
      title="Play Space logo animation"
      onClick={playAnimation}
    >
      {showTextFallback ? (
        <span className="space-brand-text-fallback" aria-hidden="true">S</span>
      ) : (
        <img
          key={isAnimating ? `animated-${animationRun}` : staticSource}
          src={imageSource}
          alt="Space"
          onLoad={() => {
            if (isAnimating) startAnimationTimer();
          }}
          onError={() => {
            if (isAnimating) {
              stopAnimation();
              return;
            }
            if (staticSource === STATIC_LOGO_SRC) {
              setStaticSource(FALLBACK_LOGO_SRC);
              return;
            }
            setShowTextFallback(true);
          }}
        />
      )}
    </button>
  );
}
