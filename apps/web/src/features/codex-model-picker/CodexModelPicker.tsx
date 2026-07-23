import { BrainCircuit, Check } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PaneCliModelSettings } from "@space/contracts";

const MODEL_POPOVER_MAX_HEIGHT_PX = 31 * 16;
const MODEL_POPOVER_GAP_PX = 11;
const MODEL_POPOVER_BOUNDARY_INSET_PX = 8;

function reasoningEffortLabel(value: string): string {
  const labels: Record<string, string> = {
    none: "None",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "XHigh",
    max: "Max",
    ultra: "Ultra"
  };
  return labels[value] ?? value;
}

export interface CodexModelPickerProps {
  settings: PaneCliModelSettings;
  disabled?: boolean;
  allowSelectionWithoutCurrent?: boolean;
  onSwitch: (modelId: string, reasoningEffort: string) => Promise<{
    current: NonNullable<PaneCliModelSettings["current"]>;
    message: string | null;
  }>;
}

export function CodexModelPicker({
  settings,
  disabled = false,
  allowSelectionWithoutCurrent = false,
  onSwitch
}: CodexModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; tone: "good" | "bad" } | null>(null);
  const [draft, setDraft] = useState<{ modelId: string; reasoningEffort: string } | null>(null);
  const [confirmed, setConfirmed] = useState(settings.current);
  const [popoverMaxHeight, setPopoverMaxHeight] = useState<number | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const reasoningSectionRef = useRef<HTMLDivElement | null>(null);
  const collapseTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const switchGenerationRef = useRef(0);
  const currentSettings = settings.current;
  const effectiveCurrent = confirmed ?? currentSettings;
  const effectiveCurrentRef = useRef(effectiveCurrent);
  effectiveCurrentRef.current = effectiveCurrent;
  const selectedModel = effectiveCurrent
    ? settings.models.find((model) => model.id === effectiveCurrent.modelId) ?? null
    : null;

  function clearCollapseTimer() {
    if (collapseTimerRef.current === null) return;
    window.clearTimeout(collapseTimerRef.current);
    collapseTimerRef.current = null;
  }

  function closeAndCollapse(restoreFocus: boolean) {
    switchGenerationRef.current += 1;
    clearCollapseTimer();
    setOpen(false);
    setExpanded(false);
    setDraft(null);
    setFeedback(null);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function completeSelection(selection: { modelId: string; reasoningEffort: string }) {
    clearCollapseTimer();
    setConfirmed(selection);
    setOpen(false);
    setExpanded(true);
    setDraft(null);
    setFeedback(null);
    triggerRef.current?.focus();
    collapseTimerRef.current = window.setTimeout(() => {
      collapseTimerRef.current = null;
      setExpanded(false);
    }, 3_000);
  }

  useEffect(() => {
    setConfirmed(currentSettings);
  }, [currentSettings?.modelId, currentSettings?.reasoningEffort]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      switchGenerationRef.current += 1;
      clearCollapseTimer();
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const activeSettings = effectiveCurrentRef.current;
    setDraft({ modelId: activeSettings?.modelId ?? "", reasoningEffort: activeSettings?.reasoningEffort ?? "" });
    setFeedback(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeAndCollapse(true);
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      closeAndCollapse(false);
    };
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled && open && !switching) closeAndCollapse(false);
  }, [disabled, open, switching]);

  useLayoutEffect(() => {
    if (!open) {
      setPopoverMaxHeight(null);
      return;
    }
    const trigger = triggerRef.current;
    const boundary = trigger?.closest<HTMLElement>(".terminal-stage, .codex-chat-shell");
    if (!trigger || !boundary) return;

    const measure = () => {
      const triggerRect = trigger.getBoundingClientRect();
      const boundaryRect = boundary.getBoundingClientRect();
      const safeTop = Math.max(
        boundaryRect.top + MODEL_POPOVER_BOUNDARY_INSET_PX,
        MODEL_POPOVER_BOUNDARY_INSET_PX
      );
      const popoverBottom = Math.min(
        triggerRect.top - MODEL_POPOVER_GAP_PX,
        window.innerHeight - MODEL_POPOVER_BOUNDARY_INSET_PX
      );
      setPopoverMaxHeight(Math.max(0, Math.min(MODEL_POPOVER_MAX_HEIGHT_PX, Math.floor(popoverBottom - safeTop))));
    };

    measure();
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resizeObserver?.observe(boundary);
    resizeObserver?.observe(trigger);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [open]);

  if (!currentSettings && (!allowSelectionWithoutCurrent || settings.models.length === 0)) {
    return (
      <div className="terminal-model-picker">
        <button
          type="button"
          className="terminal-model-chip is-expanded"
          aria-label="Detecting Codex model"
          disabled
        >
          <span>Detecting model…</span>
        </button>
      </div>
    );
  }

  const current = effectiveCurrent ?? currentSettings;
  const chipLabel = current
    ? `${selectedModel?.displayName ?? current.modelId} · ${reasoningEffortLabel(current.reasoningEffort)}`
    : "Select model";
  const drafted = draft?.modelId ? draft : current;
  const draftedModel = drafted
    ? settings.models.find((model) => model.id === drafted.modelId) ?? selectedModel
    : selectedModel;
  const reasoningOptions: Array<{ reasoningEffort: string; description?: string }> =
    draftedModel?.reasoningOptions ?? draftedModel?.supportedReasoningEfforts.map((reasoningEffort) => ({ reasoningEffort })) ?? [];

  function selectModel(modelId: string, reasoningEffort: string) {
    setDraft({ modelId, reasoningEffort });
    setFeedback(null);
    window.requestAnimationFrame(() => {
      const section = reasoningSectionRef.current;
      popoverRef.current?.scrollTo?.({ top: section?.offsetTop ?? 0, behavior: "smooth" });
      section
        ?.querySelector<HTMLButtonElement>(`button[aria-label="${reasoningEffort}"]`)
        ?.focus({ preventScroll: true });
    });
  }

  async function apply(modelId: string, effort: string) {
    if (disabled || switching) return;
    const selection = { modelId, reasoningEffort: effort };
    if (current && modelId === current.modelId && effort === current.reasoningEffort) {
      completeSelection(selection);
      return;
    }
    const generation = switchGenerationRef.current + 1;
    switchGenerationRef.current = generation;
    setSwitching(true);
    setFeedback(null);
    try {
      const outcome = await onSwitch(modelId, effort);
      if (!mountedRef.current || switchGenerationRef.current !== generation) return;
      completeSelection(outcome.current);
    } catch (error) {
      if (!mountedRef.current || switchGenerationRef.current !== generation) return;
      setFeedback({
        message: error instanceof Error ? error.message : "Model settings could not be changed.",
        tone: "bad"
      });
    } finally {
      if (mountedRef.current) setSwitching(false);
    }
  }

  return (
    <div className="terminal-model-picker">
      <button
        ref={triggerRef}
        type="button"
        className={`terminal-model-chip${expanded ? " is-expanded" : ""}`}
        aria-label={current ? `Change Codex model and reasoning. Current ${chipLabel}` : "Select Codex model and reasoning"}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          if (open) {
            closeAndCollapse(false);
            return;
          }
          clearCollapseTimer();
          setExpanded(true);
          setOpen(true);
        }}
      >
        <BrainCircuit aria-hidden="true" />
        {expanded ? <span>{switching ? "Switching…" : chipLabel}</span> : null}
      </button>
      {open ? (
        <div
          ref={popoverRef}
          className="terminal-model-popover"
          role="dialog"
          aria-label="Codex model and reasoning"
          style={popoverMaxHeight === null ? undefined : { maxHeight: `${popoverMaxHeight}px` }}
        >
          <div className="terminal-model-popover-head">
            <div>
              <strong>Model & reasoning</strong>
              <small>{settings.isTurnActive ? "Continues this turn in the same session" : "Until the next Build/Plan switch"}</small>
            </div>
            <span className="terminal-model-transport">Live</span>
          </div>
          <div className="terminal-model-options" role="radiogroup" aria-label="Codex model">
            {settings.models.map((model) => {
              const selected = model.id === drafted?.modelId;
              return (
                <button
                  key={model.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={selected ? "is-selected" : ""}
                  disabled={disabled || switching}
                  onClick={() => selectModel(model.id, model.defaultReasoningEffort)}
                >
                  <span>{model.displayName}</span>
                  {selected ? <Check className="terminal-model-selection-check" size={16} strokeWidth={2.5} aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
          <div ref={reasoningSectionRef} className="terminal-reasoning-section">
            <span>Reasoning</span>
            <div className="terminal-reasoning-options" role="radiogroup" aria-label="Reasoning effort">
              {reasoningOptions.map((option) => {
                const selected = option.reasoningEffort === drafted?.reasoningEffort;
                return (
                  <button
                    key={option.reasoningEffort}
                    type="button"
                    role="radio"
                    aria-label={option.reasoningEffort}
                    aria-checked={selected}
                    className={selected ? "is-selected" : ""}
                    disabled={disabled || switching}
                    onClick={() => void apply(draftedModel?.id ?? drafted?.modelId ?? "", option.reasoningEffort)}
                  >
                    <span>{reasoningEffortLabel(option.reasoningEffort)}</span>
                    {selected ? <Check className="terminal-model-selection-check" size={14} strokeWidth={2.5} aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </div>
          </div>
          {feedback ? (
            <div className={`terminal-model-feedback ${feedback.tone}`} role={feedback.tone === "bad" ? "alert" : "status"}>
              {feedback.message}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
