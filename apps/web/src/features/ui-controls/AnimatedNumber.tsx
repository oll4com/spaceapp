import { useEffect, useRef, useState } from "react";
import { animate } from "motion";

interface AnimatedNumberProps {
  value: number;
  /** Duration in seconds (default 0.5) */
  duration?: number;
  className?: string;
}

/**
 * Smoothly animates a number from its previous value to the new one.
 * Uses motion's animate() for a spring-like counter roll effect.
 */
export function AnimatedNumber({ value, duration = 0.5, className }: AnimatedNumberProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(value);
  const [displayed, setDisplayed] = useState(value);

  useEffect(() => {
    const from = prev.current;
    const to = value;
    prev.current = value;
    if (from === to || !ref.current) return;

    const prefersReducedMotion = typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const isTest = typeof process !== "undefined" && process.env?.NODE_ENV === "test";
    if (prefersReducedMotion || duration <= 0 || isTest) {
      setDisplayed(to);
      if (ref.current) {
        ref.current.textContent = Math.round(to).toLocaleString();
      }
      return;
    }

    const controls = animate(from, to, {
      duration,
      ease: [0.4, 0, 0.2, 1],
      onUpdate: (v) => {
        if (ref.current) {
          ref.current.textContent = Math.round(v).toLocaleString();
        }
      },
      onComplete: () => {
        setDisplayed(to);
      }
    });

    return () => controls.stop();
  }, [value, duration]);

  return <span ref={ref} className={className}>{displayed.toLocaleString()}</span>;
}
