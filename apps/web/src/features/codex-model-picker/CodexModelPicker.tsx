import { BrainCircuit, Check, ChevronLeft } from "../ui-theme/app-icons.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentPaneModelProvider, PaneCliModelSettings } from "@space/contracts";

const MODEL_POPOVER_MAX_HEIGHT_PX = 31 * 16;
const MODEL_POPOVER_GAP_PX = 11;
const MODEL_POPOVER_BOUNDARY_INSET_PX = 8;

function reasoningEffortLabel(value: string): string {
  const labels: Record<string, string> = {
    auto: "Auto",
    disabled: "Disabled",
    unknown: "Unknown",
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
  compact?: boolean;
  groupNativeProviders?: boolean;
  providers?: AgentPaneModelProvider[];
  disabled?: boolean;
  allowSelectionWithoutCurrent?: boolean;
  onRefreshCatalog?: () => Promise<void>;
  onSwitch: (
    modelId: string,
    reasoningEffort: string,
    providerId: string | null
  ) => Promise<{
    current: NonNullable<PaneCliModelSettings["current"]>;
    message: string | null;
  }>;
}

export function CodexModelPicker({
  settings,
  providers = [],
  compact = false,
  groupNativeProviders = false,
  disabled = false,
  allowSelectionWithoutCurrent = false,
  onRefreshCatalog,
  onSwitch
}: CodexModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [step, setStep] = useState<"providers" | "models" | "reasoning">("models");
  const [feedback, setFeedback] = useState<{ message: string; tone: "good" | "bad" } | null>(null);
  const [draft, setDraft] = useState<{
    modelId: string;
    reasoningEffort: string;
    providerId: string | null;
  } | null>(null);
  const [quickProviderKey, setQuickProviderKey] = useState<string | null>(null);
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(settings.current);
  const [popoverMaxHeight, setPopoverMaxHeight] = useState<number | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const reasoningSectionRef = useRef<HTMLDivElement | null>(null);
  const collapseTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const switchGenerationRef = useRef(0);
  const hasProviders = providers.length > 1;
  const currentSettings = settings.current;
  const currentProviderId = providers.find((provider) => provider.isCurrent)?.providerId ?? null;
  const [confirmedProviderId, setConfirmedProviderId] = useState(currentProviderId);
  const confirmedModels = compact && hasProviders
    ? providers.find((provider) => provider.providerId === confirmedProviderId)?.models ?? settings.models
    : settings.models;
  const activeProvider = hasProviders
    ? providers.find((provider) => provider.providerId === activeProviderId) ?? null
    : null;
  const pickerModels = activeProvider?.models ?? settings.models;
  const effectiveCurrent = confirmed ?? currentSettings;
  const effectiveCurrentRef = useRef(effectiveCurrent);
  effectiveCurrentRef.current = effectiveCurrent;
  const selectedModel = effectiveCurrent
    ? confirmedModels.find((model) => model.id === effectiveCurrent.modelId) ?? null
    : null;

  // Group the upstream catalog independently from the runtime used to execute it.
  // Keep the original runtime/model pair in every option for selection routing.
  const catalogProviders = providers.length ? providers : [{
    providerId: "", providerName: "Models", models: settings.models, statusReason: null
  }];
  const providerGroups = catalogProviders.flatMap(provider => {
    if (!(provider.providerId === "opencode" || (!providers.length && groupNativeProviders)) || !provider.models.length) {
      return [{ key: provider.providerId, label: provider.providerName, provider, models: provider.models }];
    }
    const groups = new Map<string, { key: string; label: string; provider: typeof provider; models: typeof provider.models }>();
    for (const model of provider.models) {
      const nativeProviderId = model.id.split("/")[0]!;
      const key = `${provider.providerId}:${nativeProviderId}`;
      const group = groups.get(key) ?? {
        key, label: model.description || nativeProviderId, provider, models: []
      };
      group.models.push(model);
      groups.set(key, group);
    }
    return [...groups.values()];
  });
  const confirmedGroup = providerGroups.find(group =>
    (!hasProviders || group.provider.providerId === confirmedProviderId) &&
    group.models.some(model => model.id === effectiveCurrent?.modelId));
  const quickGroup = providerGroups.find(group => group.key === quickProviderKey) ?? confirmedGroup ?? providerGroups[0];
  const quickModels = quickGroup?.models ?? [];
  const quickShowsCurrent = Boolean(quickGroup && quickGroup.key === confirmedGroup?.key);

  async function refreshCatalog() {
    if (!onRefreshCatalog || refreshing) return;
    setRefreshing(true);
    try {
      await onRefreshCatalog();
    } catch {
      if (mountedRef.current) setFeedback({ tone: "bad", message: "Could not refresh the model catalog. Close and reopen the picker to retry." });
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  }

  function clearCollapseTimer() {
    if (collapseTimerRef.current === null) return;
    window.clearTimeout(collapseTimerRef.current);
    collapseTimerRef.current = null;
  }

  function resetSteps() {
    setStep(hasProviders && activeProviderId === null ? "providers" : "models");
  }

  function closeAndCollapse(restoreFocus: boolean) {
    switchGenerationRef.current += 1;
    clearCollapseTimer();
    setOpen(false);
    setExpanded(false);
    setDraft(null);
    setFeedback(null);
    resetSteps();
    if (restoreFocus) triggerRef.current?.focus();
  }

  function completeSelection(selection: { modelId: string; reasoningEffort: string }) {
    clearCollapseTimer();
    setConfirmed(selection);
    setOpen(false);
    setExpanded(true);
    setDraft(null);
    setFeedback(null);
    resetSteps();
    triggerRef.current?.focus();
    collapseTimerRef.current = window.setTimeout(() => {
      collapseTimerRef.current = null;
      setExpanded(false);
    }, 3_000);
  }

  useEffect(() => {
    setConfirmed(currentSettings);
    if (compact && currentSettings && !switching) {
      setDraft({ ...currentSettings, providerId: null });
    }
  }, [currentSettings?.modelId, currentSettings?.reasoningEffort]);

  useEffect(() => { setConfirmedProviderId(currentProviderId); }, [currentProviderId]);

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
    setDraft({
      modelId: activeSettings?.modelId ?? "",
      reasoningEffort: activeSettings?.reasoningEffort ?? "",
      providerId: null
    });
    setFeedback(null);
    resetSteps();
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
          aria-label="Detecting model"
          disabled
        >
          <span>Detecting model…</span>
        </button>
      </div>
    );
  }

  const current = effectiveCurrent ?? currentSettings;
  const drafted = draft?.modelId ? draft : null;
  const draftedModel = drafted
    ? pickerModels.find((model) => model.id === drafted.modelId) ?? selectedModel
    : selectedModel;
  const reasoningOptions: Array<{ reasoningEffort: string; description?: string }> =
    draftedModel?.reasoningOptions ?? draftedModel?.supportedReasoningEfforts.map((reasoningEffort) => ({ reasoningEffort })) ?? [];
  const currentModelOption = current
    ? confirmedModels.find((model) => model.id === current.modelId) ?? null
    : null;
  const activeReasoningOptions: Array<{ reasoningEffort: string; description?: string }> =
    currentModelOption?.reasoningOptions ?? currentModelOption?.supportedReasoningEfforts.map((reasoningEffort) => ({ reasoningEffort })) ?? [];
  const hasReasoningOptions = currentModelOption === null || activeReasoningOptions.length > 0;
  const chipLabel = current
    ? hasReasoningOptions
      ? `${selectedModel?.displayName ?? current.modelId} · ${reasoningEffortLabel(current.reasoningEffort)}`
      : (selectedModel?.displayName ?? current.modelId)
    : "Select model";

  function modelReasoningOptions(
    model: NonNullable<PaneCliModelSettings["models"][number]>
  ): Array<{ reasoningEffort: string; description?: string }> {
    return model.reasoningOptions ?? model.supportedReasoningEfforts.map((reasoningEffort) => ({ reasoningEffort })) ?? [];
  }

  function selectProvider(providerId: string) {
    setActiveProviderId(providerId);
    setDraft(null);
    setFeedback(null);
    setStep("models");
  }

  function selectModel(modelId: string, reasoningEffort: string) {
    const providerId = hasProviders
      ? (activeProvider?.providerId ?? currentProviderId)
      : null;
    const target = pickerModels.find((model) => model.id === modelId);
    if (target && modelReasoningOptions(target).length > 0) {
      setDraft({ modelId, reasoningEffort, providerId });
      setStep("reasoning");
      return;
    }
    void apply(modelId, reasoningEffort, providerId);
  }

  function backToModels() {
    setDraft(null);
    setStep("models");
    setFeedback(null);
  }

  function backToProviders() {
    setDraft(null);
    setStep("providers");
    setFeedback(null);
  }

  async function apply(modelId: string, effort: string, providerId: string | null) {
    if (disabled || switching) return;
    const selection = { modelId, reasoningEffort: effort, providerId };
    const sameProvider = providerId === null || providerId === (compact ? confirmedProviderId : currentProviderId);
    if (sameProvider && current && modelId === current.modelId && effort === current.reasoningEffort) {
      if (!compact) completeSelection(selection);
      return;
    }
    const generation = switchGenerationRef.current + 1;
    switchGenerationRef.current = generation;
    setSwitching(true);
    setFeedback(null);
    try {
      const outcome = await onSwitch(modelId, effort, providerId);
      if (!mountedRef.current || switchGenerationRef.current !== generation) return;
      if (compact) {
        if (providerId !== null) setConfirmedProviderId(providerId);
        setConfirmed(outcome.current);
        setDraft({ ...outcome.current, providerId });
        setFeedback(outcome.message ? { message: outcome.message, tone: "good" } : null);
      } else {
        completeSelection(outcome.current);
      }
    } catch (error) {
      if (!mountedRef.current || switchGenerationRef.current !== generation) return;
      if (compact && effectiveCurrentRef.current) setDraft({ ...effectiveCurrentRef.current, providerId: null });
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
        className={`terminal-model-chip${expanded && !compact ? " is-expanded" : ""}`}
        aria-label={current ? `Change model and reasoning. Current ${chipLabel}` : "Select model and reasoning"}
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
          setQuickProviderKey(null);
          setOpen(true);
          void refreshCatalog();
        }}
      >
        <BrainCircuit aria-hidden="true" />
        {expanded && !compact ? <span>{chipLabel}</span> : null}
      </button>
      {open ? (
        <div
          ref={popoverRef}
          className={`terminal-model-popover${compact ? " terminal-model-popover-quick" : ""}`}
          role="dialog"
          aria-label="Model and reasoning"
          style={popoverMaxHeight === null ? undefined : { maxHeight: `${popoverMaxHeight}px` }}
        >
          {compact ? (
            <>
              {providerGroups.length > 1 ? (
                <label className="terminal-quick-provider-field">
                  <span>Provider</span>
                  <select className="terminal-quick-model-select" aria-label="Provider"
                    value={quickGroup?.key ?? ""} disabled={disabled || switching || refreshing}
                    onChange={event => setQuickProviderKey(event.target.value)}>
                    {providerGroups.map(group => <option key={group.key} value={group.key}
                      disabled={!group.models.length}>{group.label}{!group.models.length ? ` — ${group.provider.statusReason ?? "No models available"}` : ""}</option>)}
                  </select>
                </label>
              ) : null}
              <select
                className="terminal-quick-model-select"
                aria-label="Model"
                value={quickShowsCurrent ? current?.modelId ?? "" : ""}
                disabled={disabled || switching || refreshing || !quickModels.length}
                onChange={(event) => {
                  const model = quickModels.find(entry => entry.id === event.target.value);
                  const providerId = hasProviders ? quickGroup?.provider.providerId ?? null : null;
                  if (model) void apply(model.id, model.defaultReasoningEffort, providerId);
                }}
              >
                {!quickShowsCurrent ? <option value="" disabled>Select model</option> : null}
                {quickModels.map(model => <option key={model.id} value={model.id}>{model.displayName}</option>)}
              </select>
              {refreshing ? <div role="status">Refreshing models…</div> : null}
              {activeReasoningOptions.length > 0 && current && quickShowsCurrent ? (
                <div className="terminal-quick-effort">
                  <strong>
                    Reasoning{" "}
                    <span>{reasoningEffortLabel(draft?.reasoningEffort ?? current.reasoningEffort)}</span>
                  </strong>
                  <input
                    type="range"
                    aria-label="Reasoning effort"
                    aria-valuetext={reasoningEffortLabel(draft?.reasoningEffort ?? current.reasoningEffort)}
                    style={{ background: `linear-gradient(to right, #3385ff ${100 * Math.max(0, activeReasoningOptions.findIndex((option) => option.reasoningEffort === (draft?.reasoningEffort ?? current.reasoningEffort))) / Math.max(1, activeReasoningOptions.length - 1)}%, #505050 0)` }}
                    min={0}
                    max={Math.max(0, activeReasoningOptions.length - 1)}
                    step={1}
                    value={Math.max(0, activeReasoningOptions.findIndex((option) => option.reasoningEffort === (draft?.reasoningEffort ?? current.reasoningEffort)))}
                    disabled={disabled || switching || refreshing || activeReasoningOptions.length < 2}
                    onChange={(event) => {
                      const effort = activeReasoningOptions[Number(event.target.value)]?.reasoningEffort;
                      if (effort) setDraft({ ...current, reasoningEffort: effort, providerId: null });
                    }}
                    onPointerUp={(event) => {
                      const effort = activeReasoningOptions[Number(event.currentTarget.value)]?.reasoningEffort;
                      if (effort) void apply(current.modelId, effort, hasProviders ? confirmedProviderId : null);
                    }}
                    onKeyUp={(event) => {
                      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) return;
                      const effort = activeReasoningOptions[Number(event.currentTarget.value)]?.reasoningEffort;
                      if (effort) void apply(current.modelId, effort, hasProviders ? confirmedProviderId : null);
                    }}
                  />
                  <div className="terminal-quick-effort-labels" aria-hidden="true">
                    <span>{reasoningEffortLabel(activeReasoningOptions[0]!.reasoningEffort)}</span>
                    <span>{reasoningEffortLabel(activeReasoningOptions[activeReasoningOptions.length - 1]!.reasoningEffort)}</span>
                  </div>
                </div>
              ) : null}
            </>
          ) : step === "providers" ? (
            <>
              <div className="terminal-model-popover-head">
                <div>
                  <strong>Provider</strong>
                  <small>Pick the model provider for this session</small>
                </div>
                <span className="terminal-model-transport">Live</span>
              </div>
              <div className="terminal-model-options" role="radiogroup" aria-label="Model provider">
                {providers.map((provider) => {
                  const selected = provider.providerId === (activeProvider?.providerId ?? currentProviderId);
                  return (
                    <button
                      key={provider.providerId}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={selected ? "is-selected" : ""}
                      disabled={disabled || switching || provider.models.length === 0}
                      title={provider.statusReason ?? undefined}
                      onClick={() => selectProvider(provider.providerId)}
                    >
                      <span className="terminal-model-provider-label">
                        <span>{provider.providerName}</span>
                        {provider.models.length === 0 && provider.statusReason ? (
                          <small className="terminal-model-provider-reason">{provider.statusReason}</small>
                        ) : null}
                      </span>
                      {selected ? <Check className="terminal-model-selection-check" size={16} strokeWidth={2.5} aria-hidden="true" /> : null}
                    </button>
                  );
                })}
              </div>
            </>
          ) : step === "models" ? (
            <>
              <div className="terminal-model-popover-head">
                {hasProviders ? (
                  <button
                    type="button"
                    className="terminal-model-back"
                    aria-label="Back to providers"
                    onClick={backToProviders}
                  >
                    <ChevronLeft size={16} strokeWidth={2.5} aria-hidden="true" />
                  </button>
                ) : null}
                <div>
                  <strong>{activeProvider?.providerName ?? "Model"}</strong>
                  <small>
                    {settings.controlMode === "OPENCODE"
                      ? "Applies to subsequent turns in this session"
                      : settings.isTurnActive
                        ? "Continues this turn in the same session"
                        : "Until the next Build/Plan switch"}
                  </small>
                </div>
                <span className="terminal-model-transport">Live</span>
              </div>
              <div className="terminal-model-options" role="radiogroup" aria-label="Model">
                {pickerModels.map((model) => {
                  const selected = model.id === drafted?.modelId;
                  const modelEffort =
                    model.id === current?.modelId && current
                      ? current.reasoningEffort
                      : model.defaultReasoningEffort;
                  return (
                    <button
                      key={model.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={selected ? "is-selected" : ""}
                      disabled={disabled || switching}
                      onClick={() => selectModel(model.id, modelEffort)}
                    >
                      <span>{model.displayName}</span>
                      {selected ? <Check className="terminal-model-selection-check" size={16} strokeWidth={2.5} aria-hidden="true" /> : null}
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <div className="terminal-model-popover-head">
                <button
                  type="button"
                  className="terminal-model-back"
                  aria-label="Back to models"
                  onClick={backToModels}
                >
                  <ChevronLeft size={16} strokeWidth={2.5} aria-hidden="true" />
                </button>
                <div>
                  <strong>{draftedModel?.displayName ?? "Reasoning"}</strong>
                  <small>Choose reasoning effort for this model</small>
                </div>
                <span className="terminal-model-transport">Live</span>
              </div>
              {reasoningOptions.length > 0 ? (
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
                          onClick={() => void apply(
                            draftedModel?.id ?? drafted?.modelId ?? "",
                            option.reasoningEffort,
                            drafted?.providerId ?? null
                          )}
                        >
                          <span>{reasoningEffortLabel(option.reasoningEffort)}</span>
                          {option.description ? <small>{option.description}</small> : null}
                          {selected ? <Check className="terminal-model-selection-check" size={14} strokeWidth={2.5} aria-hidden="true" /> : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </>
          )}
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
