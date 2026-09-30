import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ClipboardItem } from "@space/contracts";
import { api } from "../../api.js";
import { ClipboardList, Clock3, RotateCw, Loader2 } from "../ui-theme/app-icons.js";
import { SPACE_CLIPBOARD_UPDATED_EVENT } from "../clipboard-dock/clipboard-events.js";

export interface CliPlansMenuProps {
  disabled?: boolean;
  active: boolean;
  onSelectPlan: (plan: ClipboardItem) => void;
}

function formatPlanDate(isoString?: string | null): string {
  if (!isoString) return "";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (isToday) {
    return `Today ${time}`;
  }
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${date.getDate()} ${months[date.getMonth()]} · ${time}`;
}

function formatPlanSnippet(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .join(" ")
    .slice(0, 150);
}

export function CliPlansMenu({
  disabled = false,
  active,
  onSelectPlan
}: CliPlansMenuProps) {
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [plans, setPlans] = useState<ClipboardItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<{ right: number; bottom: number; maxHeight: number } | null>(null);
  const [themeContext, setThemeContext] = useState<{
    uiTheme?: string;
    interfaceTheme?: string;
    roomTheme?: string;
    colorMode?: string;
  }>({});

  const open = Boolean(position && active && !disabled);

  const loadPlans = useCallback(async () => {
    if (typeof api?.clipboardItems !== "function") {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await api.clipboardItems({
        source: "PLAN",
        includeCompleted: false,
        page: 1,
        pageSize: 100
      });
      const openPlans = (response?.data ?? []).filter(
        (item) => !item.isCompleted && item.executionStatus !== "COMPLETED"
      );
      // Newest to oldest
      openPlans.sort((a, b) => {
        const timeA = new Date(a.createdAt || a.lastUsedAt || 0).getTime();
        const timeB = new Date(b.createdAt || b.lastUsedAt || 0).getTime();
        return timeB - timeA;
      });
      setPlans(openPlans);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load open plans.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void loadPlans();
    const handleClipboardUpdated = () => {
      void loadPlans();
    };
    window.addEventListener(SPACE_CLIPBOARD_UPDATED_EVENT, handleClipboardUpdated);
    return () => {
      window.removeEventListener(SPACE_CLIPBOARD_UPDATED_EVENT, handleClipboardUpdated);
    };
  }, [active, loadPlans]);

  useEffect(() => {
    if (!active || disabled) {
      setPosition(null);
    }
  }, [active, disabled]);

  useEffect(() => {
    if (!open) return;
    void loadPlans();
    panelRef.current?.querySelector("button")?.focus();
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !panelRef.current?.contains(event.target) &&
        !buttonRef.current?.contains(event.target)
      ) {
        setPosition(null);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setPosition(null);
      buttonRef.current?.focus();
    };
    const close = () => setPosition(null);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", close);
    };
  }, [open, loadPlans]);

  useLayoutEffect(() => {
    if (!open || !panelRef.current) return;
    const rect = panelRef.current.getBoundingClientRect();
    if (rect.left < 8) {
      const overflow = 8 - rect.left;
      setPosition((current) => {
        if (!current) return current;
        return {
          ...current,
          right: Math.max(8, current.right - overflow)
        };
      });
    }
  }, [open]);

  const toggleOpen = () => {
    if (open) {
      setPosition(null);
      return;
    }
    const box = buttonRef.current?.getBoundingClientRect();
    if (!box) return;
    const container =
      buttonRef.current?.closest(".terminal-floating-controls, .codex-composer-toolbar") ??
      buttonRef.current;
    const anchorBox = container ? container.getBoundingClientRect() : box;
    const rootFontSize =
      typeof window !== "undefined"
        ? Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16
        : 16;
    const popoverWidth = Math.min(28 * rootFontSize, window.innerWidth - 16);
    const maxRight = Math.max(8, window.innerWidth - popoverWidth - 8);
    const targetHost = buttonRef.current?.closest<HTMLElement>(
      "[data-shell-mode], .space-shell, [data-room-theme], [data-ui-theme]"
    );
    setThemeContext({
      uiTheme:
        targetHost?.dataset.uiTheme ||
        (typeof document !== "undefined" ? document.body.dataset.uiTheme : undefined),
      interfaceTheme:
        targetHost?.dataset.interfaceTheme ||
        (typeof document !== "undefined" ? document.documentElement.dataset.interfaceTheme : undefined),
      roomTheme:
        targetHost?.dataset.roomTheme ||
        (typeof document !== "undefined" ? document.body.dataset.roomTheme : undefined),
      colorMode:
        targetHost?.dataset.colorMode ||
        (typeof document !== "undefined" ? document.body.dataset.colorMode : undefined)
    });
    setPosition({
      right: Math.min(Math.max(8, window.innerWidth - anchorBox.right), maxRight),
      bottom: Math.max(8, window.innerHeight - box.top + 8),
      maxHeight: Math.max(140, box.top - 16)
    });
  };

  const currentUiTheme =
    themeContext.uiTheme ??
    buttonRef.current?.closest<HTMLElement>("[data-shell-mode], .space-shell, [data-room-theme], [data-ui-theme]")
      ?.dataset.uiTheme ??
    (typeof document !== "undefined" ? document.body.dataset.uiTheme : undefined);
  const currentInterfaceTheme =
    themeContext.interfaceTheme ??
    buttonRef.current?.closest<HTMLElement>("[data-shell-mode], .space-shell, [data-room-theme], [data-ui-theme]")
      ?.dataset.interfaceTheme ??
    (typeof document !== "undefined" ? document.documentElement.dataset.interfaceTheme : undefined);
  const currentRoomTheme =
    themeContext.roomTheme ??
    buttonRef.current?.closest<HTMLElement>("[data-shell-mode], .space-shell, [data-room-theme], [data-ui-theme]")
      ?.dataset.roomTheme ??
    (typeof document !== "undefined" ? document.body.dataset.roomTheme : undefined);
  const currentColorMode =
    themeContext.colorMode ??
    buttonRef.current?.closest<HTMLElement>("[data-shell-mode], .space-shell, [data-room-theme], [data-ui-theme]")
      ?.dataset.colorMode ??
    (typeof document !== "undefined" ? document.body.dataset.colorMode : undefined);

  const titleText = plans.length > 0 ? `Open plans (${plans.length})` : "Open plans";

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="terminal-shortcuts-button terminal-plans-button"
        aria-label={titleText}
        title={titleText}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={toggleOpen}
      >
        <ClipboardList aria-hidden="true" />
        {plans.length > 0 ? (
          <span className="terminal-plans-button-badge" aria-hidden="true">
            {plans.length > 9 ? "9+" : plans.length}
          </span>
        ) : null}
      </button>

      {open && position
        ? createPortal(
            <div
              ref={panelRef}
              id={id}
              className="terminal-plans-popover"
              role="dialog"
              aria-label="Open plans"
              data-ui-theme={currentUiTheme}
              data-interface-theme={currentInterfaceTheme}
              data-room-theme={currentRoomTheme}
              data-color-mode={currentColorMode}
              style={position}
              onBlur={(event) => {
                if (
                  event.relatedTarget !== buttonRef.current &&
                  !event.currentTarget.contains(event.relatedTarget as Node | null)
                ) {
                  setPosition(null);
                }
              }}
            >
              <div className="terminal-plans-header">
                <div className="terminal-plans-header-title">
                  <ClipboardList aria-hidden="true" style={{ width: 15, height: 15 }} />
                  <span>Open plans</span>
                  {plans.length > 0 ? (
                    <span className="terminal-plans-count-badge">{plans.length}</span>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="terminal-plans-refresh-btn"
                  aria-label="Refresh plans"
                  title="Refresh plans"
                  onClick={(e) => {
                    e.stopPropagation();
                    void loadPlans();
                  }}
                >
                  <RotateCw
                    className={loading ? "is-spinning" : ""}
                    aria-hidden="true"
                    style={{ width: 13, height: 13 }}
                  />
                </button>
              </div>

              {loading && plans.length === 0 ? (
                <div className="terminal-plans-loading" role="status">
                  <Loader2 className="is-spinning" aria-hidden="true" style={{ width: 16, height: 16 }} />
                  <span>Loading open plans…</span>
                </div>
              ) : null}

              {error && plans.length === 0 ? (
                <div className="terminal-plans-error" role="alert">
                  {error}
                </div>
              ) : null}

              {!loading && plans.length === 0 && !error ? (
                <div className="terminal-plans-empty" role="status">
                  No open plans
                </div>
              ) : null}

              {plans.length > 0 ? (
                <div className="terminal-plans-list" role="list" aria-label="Open plans list">
                  {plans.map((plan) => {
                    const planTitle = plan.title?.trim() || "Untitled Plan";
                    const dateLabel = formatPlanDate(plan.createdAt || plan.lastUsedAt);
                    const snippet = formatPlanSnippet(plan.text);
                    const isProgressActive =
                      plan.executionStatus && plan.executionStatus !== "PLANNED";
                    return (
                      <button
                        key={plan.id}
                        type="button"
                        role="listitem"
                        className="terminal-plan-item"
                        onClick={() => {
                          setPosition(null);
                          onSelectPlan(plan);
                        }}
                        title={`Send to CLI: ${planTitle}`}
                      >
                        <div className="terminal-plan-item-top">
                          <span className="terminal-plan-item-title">{planTitle}</span>
                          {isProgressActive ? (
                            <span
                              className="terminal-plan-status-tag"
                              data-status={plan.executionStatus}
                            >
                              {plan.executionStatus}{" "}
                              {plan.progressPercentage ? `${plan.progressPercentage}%` : ""}
                            </span>
                          ) : null}
                        </div>
                        <div className="terminal-plan-item-meta">
                          <Clock3 aria-hidden="true" style={{ width: 11, height: 11 }} />
                          <span>{dateLabel}</span>
                          {plan.characterCount ? (
                            <span>· {plan.characterCount.toLocaleString()} chars</span>
                          ) : null}
                        </div>
                        {snippet ? (
                          <div className="terminal-plan-item-snippet">{snippet}</div>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>,
            document.body
          )
        : null}
    </>
  );
}
