import { useEffect, useState, useRef, useLayoutEffect, useCallback } from "react";
import { DEMO_MODE_STEPS, type DemoModeStep } from "./demo-mode-steps.js";
import {
  ChevronLeft,
  ChevronRight,
  Play,
  Pause,
  X,
  Sparkles,
  CheckCircle2,
  RotateCcw,
  ExternalLink
} from "../ui-theme/app-icons.js";
import "./demo-mode.css";

interface DemoModeOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  onActionPreview?: (actionId: string) => void;
}

const STEP_DURATION_MS = 7500;
const TICK_INTERVAL_MS = 100;
const CARD_WIDTH = 420;
const CARD_HEIGHT_ESTIMATE = 340;
const MARGIN = 16;

export function DemoModeOverlay({ isOpen, onClose, onActionPreview }: DemoModeOverlayProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [isAutoPlay, setIsAutoPlay] = useState(false);
  const [autoPlayProgress, setAutoPlayProgress] = useState(0);
  const [isHovered, setIsHovered] = useState(false);
  const [spotlightRect, setSpotlightRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const [cardPos, setCardPos] = useState<{ top: number; left: number }>({ top: 120, left: 40 });

  const currentStep: DemoModeStep = (DEMO_MODE_STEPS[stepIndex] ?? DEMO_MODE_STEPS[0])!;
  const cardRef = useRef<HTMLDivElement | null>(null);

  const nextStep = useCallback(() => {
    setAutoPlayProgress(0);
    setStepIndex((curr) => {
      if (curr < DEMO_MODE_STEPS.length - 1) return curr + 1;
      setIsAutoPlay(false);
      return curr;
    });
  }, []);

  const prevStep = useCallback(() => {
    setAutoPlayProgress(0);
    setStepIndex((curr) => (curr > 0 ? curr - 1 : curr));
  }, []);

  const jumpToStep = useCallback((idx: number) => {
    setAutoPlayProgress(0);
    setStepIndex(idx);
  }, []);

  const restartTour = useCallback(() => {
    setAutoPlayProgress(0);
    setStepIndex(0);
  }, []);

  // Update spotlight target positioning
  const updatePosition = useCallback(() => {
    if (!isOpen || typeof window === "undefined") return;

    let targetEl: HTMLElement | null = null;
    const selectors = currentStep.targetSelector.split(",").map((s) => s.trim());
    for (const sel of selectors) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el && el.offsetParent !== null) {
        targetEl = el;
        break;
      }
    }

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    if (targetEl) {
      const rect = targetEl.getBoundingClientRect();
      setSpotlightRect({
        top: Math.max(0, rect.top - 4),
        left: Math.max(0, rect.left - 4),
        width: rect.width + 8,
        height: rect.height + 8
      });

      // Position the floating card intelligently relative to target
      let cardLeft = (vw - CARD_WIDTH) / 2;
      let cardTop = (vh - CARD_HEIGHT_ESTIMATE) / 2;

      const placement = currentStep.placement || (rect.left < vw / 2 ? "right" : "left");

      if (placement === "right" && rect.right + CARD_WIDTH + MARGIN < vw) {
        cardLeft = rect.right + MARGIN;
        cardTop = Math.max(MARGIN + 60, Math.min(rect.top, vh - CARD_HEIGHT_ESTIMATE - MARGIN));
      } else if (placement === "left" && rect.left - CARD_WIDTH - MARGIN > 0) {
        cardLeft = rect.left - CARD_WIDTH - MARGIN;
        cardTop = Math.max(MARGIN + 60, Math.min(rect.top, vh - CARD_HEIGHT_ESTIMATE - MARGIN));
      } else if (placement === "bottom" && rect.bottom + CARD_HEIGHT_ESTIMATE + MARGIN < vh) {
        cardLeft = Math.max(MARGIN, Math.min(rect.left, vw - CARD_WIDTH - MARGIN));
        cardTop = rect.bottom + MARGIN;
      } else if (placement === "top" && rect.top - CARD_HEIGHT_ESTIMATE - MARGIN > 60) {
        cardLeft = Math.max(MARGIN, Math.min(rect.left, vw - CARD_WIDTH - MARGIN));
        cardTop = rect.top - CARD_HEIGHT_ESTIMATE - MARGIN;
      } else {
        // Safe fallback placement inside viewport
        cardLeft = Math.max(MARGIN, Math.min(rect.left < vw / 2 ? rect.right + MARGIN : rect.left - CARD_WIDTH - MARGIN, vw - CARD_WIDTH - MARGIN));
        cardTop = Math.max(70, Math.min(rect.top + 10, vh - CARD_HEIGHT_ESTIMATE - MARGIN));
      }

      setCardPos({ top: cardTop, left: cardLeft });
    } else {
      setSpotlightRect(null);
      // Center card if no element matched
      setCardPos({
        top: Math.max(80, (vh - CARD_HEIGHT_ESTIMATE) / 2),
        left: Math.max(MARGIN, (vw - CARD_WIDTH) / 2)
      });
    }
  }, [isOpen, currentStep]);

  useLayoutEffect(() => {
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [updatePosition]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        nextStep();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        prevStep();
      } else if (e.key === " " && document.activeElement?.tagName !== "BUTTON") {
        e.preventDefault();
        setIsAutoPlay((prev) => !prev);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, nextStep, prevStep, onClose]);

  // Auto-play timer
  useEffect(() => {
    if (!isOpen || !isAutoPlay || isHovered) return;

    const interval = setInterval(() => {
      setAutoPlayProgress((curr) => {
        const next = curr + (TICK_INTERVAL_MS / STEP_DURATION_MS) * 100;
        if (next >= 100) {
          nextStep();
          return 0;
        }
        return next;
      });
    }, TICK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [isOpen, isAutoPlay, isHovered, nextStep]);

  if (!isOpen) return null;

  return (
    <aside className="demo-mode-root" aria-label="Space App Demo Mode Tour" role="dialog" aria-modal="true">
      <div className="demo-mode-backdrop" onClick={onClose} aria-hidden="true" />

      {spotlightRect && (
        <div
          className="demo-mode-spotlight"
          style={{
            top: `${spotlightRect.top}px`,
            left: `${spotlightRect.left}px`,
            width: `${spotlightRect.width}px`,
            height: `${spotlightRect.height}px`
          }}
          aria-hidden="true"
        />
      )}

      {/* Top persistent control bar */}
      <header className="demo-mode-topbar">
        <div className="demo-mode-brand-badge">
          <Sparkles aria-hidden="true" />
          <span>Demo Mode</span>
        </div>

        <nav className="demo-mode-step-indicator" aria-label="Tour steps">
          {DEMO_MODE_STEPS.map((step, idx) => (
            <button
              key={step.id}
              type="button"
              className={`demo-mode-step-dot${idx === stepIndex ? " is-active" : ""}`}
              onClick={() => jumpToStep(idx)}
              title={`Step ${idx + 1}: ${step.title}`}
              aria-label={`Jump to Step ${idx + 1}: ${step.title}`}
              aria-current={idx === stepIndex ? "step" : undefined}
            />
          ))}
        </nav>

        <div className="demo-mode-topbar-actions">
          <button
            type="button"
            className="demo-mode-btn demo-mode-btn-pill"
            onClick={() => setIsAutoPlay((v) => !v)}
            title={isAutoPlay ? "Pause Auto-play (Space)" : "Start Auto-play (Space)"}
            aria-label={isAutoPlay ? "Pause Auto-play" : "Start Auto-play"}
          >
            {isAutoPlay ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
            <span>{isAutoPlay ? "Pause" : "Auto-play"}</span>
          </button>

          <button
            type="button"
            className="demo-mode-btn"
            onClick={prevStep}
            disabled={stepIndex === 0}
            title="Previous Step (Left Arrow)"
            aria-label="Previous Step"
          >
            <ChevronLeft aria-hidden="true" />
          </button>

          <button
            type="button"
            className="demo-mode-btn"
            onClick={nextStep}
            disabled={stepIndex === DEMO_MODE_STEPS.length - 1}
            title="Next Step (Right Arrow)"
            aria-label="Next Step"
          >
            <ChevronRight aria-hidden="true" />
          </button>

          <button
            type="button"
            className="demo-mode-btn demo-mode-btn-exit"
            onClick={onClose}
            title="Exit Demo Mode (Escape)"
            aria-label="Exit Demo Mode"
          >
            <X aria-hidden="true" />
            <span>Exit</span>
          </button>
        </div>
      </header>

      {/* Floating Info Card */}
      <section
        ref={cardRef}
        className="demo-mode-card"
        style={{
          top: `${cardPos.top}px`,
          left: `${cardPos.left}px`
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <header className="demo-mode-card-header">
          <span className="demo-mode-badge">{currentStep.badge}</span>
          <span className="demo-mode-step-fraction">
            {currentStep.stepNumber} of {currentStep.totalSteps}
          </span>
        </header>

        <div>
          <h2 className="demo-mode-title">{currentStep.title}</h2>
          <p className="demo-mode-subtitle">{currentStep.subtitle}</p>
        </div>

        <p className="demo-mode-description">{currentStep.description}</p>

        <ul className="demo-mode-features-list">
          {currentStep.features.map((feat, i) => (
            <li key={i} className="demo-mode-feature-item">
              <CheckCircle2 className="demo-mode-feature-bullet" aria-hidden="true" />
              <span>{feat}</span>
            </li>
          ))}
        </ul>

        <footer className="demo-mode-card-footer">
          <div className="demo-mode-nav-group">
            {currentStep.actionId && onActionPreview && (
              <button
                type="button"
                className="demo-mode-btn"
                onClick={() => onActionPreview(currentStep.actionId!)}
                title={`Preview ${currentStep.title}`}
              >
                <ExternalLink aria-hidden="true" />
                <span>{currentStep.actionLabel ?? "Preview"}</span>
              </button>
            )}
            {stepIndex === DEMO_MODE_STEPS.length - 1 && (
              <button
                type="button"
                className="demo-mode-btn"
                onClick={restartTour}
                title="Restart Tour from Beginning"
              >
                <RotateCcw aria-hidden="true" />
                <span>Restart</span>
              </button>
            )}
          </div>

          <div className="demo-mode-nav-group">
            {stepIndex < DEMO_MODE_STEPS.length - 1 ? (
              <button
                type="button"
                className="demo-mode-btn demo-mode-btn-primary"
                onClick={nextStep}
                aria-label="Next Step"
              >
                <span>Next</span>
                <ChevronRight aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                className="demo-mode-btn demo-mode-btn-primary"
                onClick={onClose}
                aria-label="Finish Tour"
              >
                <span>Finish</span>
              </button>
            )}
          </div>
        </footer>

        {isAutoPlay && (
          <div className="demo-mode-progress-bar" aria-hidden="true">
            <div
              className="demo-mode-progress-fill"
              style={{ width: `${autoPlayProgress}%` }}
            />
          </div>
        )}
      </section>
    </aside>
  );
}
