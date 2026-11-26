import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  shortTaskTitle,
  type Pane,
  type TaskTitleCandidateStatus,
} from "@space/contracts";
import { api } from "../../api.js";

const genericPlaceholderTitle =
  /^(?:(?:cli|terminal|bash|zsh|task|untitled|new session|child session|Job Copilot|Mail Copilot|Marketing Copilot|Freelance Copilot|Monitoring Copilot|Security Copilot|App Studio|Video|Design|Browser|Code|Review|Swarm|YouTube|VNC|Harness|Live|Files|Databases|Demo Projects|T3 Code|Appointments|Chat)(?:\s+\d+)?)$/i;

export function isGenericTaskTitle(title: string | null | undefined): boolean {
  if (!title) return true;
  const trimmed = title.trim();
  return !trimmed || genericPlaceholderTitle.test(trimmed);
}

export function hasTaskTitlePopoverContent(
  pane: Pane,
  displayTitle = pane.title,
): boolean {
  const metadata = pane.taskMetadata;
  if (
    metadata &&
    (metadata.generationStatus === "pending" ||
      (metadata.topics && metadata.topics.length > 0) ||
      Boolean(metadata.description && metadata.description.trim()) ||
      Boolean(metadata.nativeTitle && metadata.nativeTitle.trim()) ||
      (metadata.steps && metadata.steps.length > 0))
  ) {
    return true;
  }
  const taskPane =
    ["CHAT", "TERMINAL", "HARNESS"].includes(pane.mode) &&
    pane.terminalRuntimeId !== "cli:root";
  const candidate =
    taskPane && pane.titleSource !== "manual"
      ? shortTaskTitle(pane.title, "")
      : pane.title || displayTitle;
  const trimmed = candidate.trim();
  if (!trimmed) return false;
  if (
    pane.paneName &&
    trimmed.toLowerCase() === pane.paneName.trim().toLowerCase()
  ) {
    return false;
  }
  if (
    isGenericTaskTitle(trimmed) &&
    pane.titleSource !== "ai" &&
    pane.titleSource !== "manual"
  ) {
    return false;
  }
  return true;
}

export function TaskTitleDetails({
  pane,
  displayTitle = pane.title,
  titleRef,
  onRename,
  onUpdated,
  disabled = false,
}: {
  pane: Pane;
  displayTitle?: string;
  titleRef: RefObject<HTMLElement | null>;
  onRename: () => void;
  onUpdated: (pane: Pane) => void;
  disabled?: boolean;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<
    TaskTitleCandidateStatus[] | null
  >(null);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const taskPane = ["CHAT", "TERMINAL", "HARNESS"].includes(pane.mode) &&
    pane.terminalRuntimeId !== "cli:root";
  const rawTaskTitle =
    taskPane && pane.titleSource !== "manual"
      ? shortTaskTitle(pane.title, "")
      : pane.title || displayTitle;
  const title =
    taskPane && pane.titleSource !== "manual"
      ? shortTaskTitle(pane.title, "Task")
      : displayTitle;
  const headerText = pane.paneName || title;
  const metadata = pane.taskMetadata;
  const topics = metadata?.topics ?? [];
  const summarizing = metadata?.generationStatus === "pending";
  const hasTitle = hasTaskTitlePopoverContent(pane, displayTitle);
  const popoverTitle =
    rawTaskTitle &&
    (!pane.paneName ||
      rawTaskTitle.trim().toLowerCase() !== pane.paneName.trim().toLowerCase()) &&
    (!isGenericTaskTitle(rawTaskTitle) ||
      pane.titleSource === "ai" ||
      pane.titleSource === "manual")
      ? rawTaskTitle
      : topics.at(-1)?.title || metadata?.nativeTitle || title;
  useEffect(() => {
    if (!hasTitle && open) {
      close();
    }
  }, [hasTitle, open]);
  useEffect(() => {
    const handleGlobalDragStart = () => {
      close();
    };
    window.addEventListener("dragstart", handleGlobalDragStart);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      window.removeEventListener("dragstart", handleGlobalDragStart);
    };
  }, []);
  useLayoutEffect(() => {
    if (!open || !hasTitle) return;
    const popover = popoverRef.current;
    if (!popover) return;
    // The native top layer escapes pane overflow without moving or remounting
    // the pane. Keeping the DOM ancestry also preserves the room theme.
    popover.showPopover?.();
    const position = () => {
      const anchor = detailsRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const viewport = window.visualViewport;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const maxWidth = Math.min(520, width - 32);
      const maxHeight = Math.min(560, height - 32);
      popover.style.width = "max-content";
      popover.style.maxWidth = `${maxWidth}px`;
      popover.style.maxHeight = `${maxHeight}px`;
      const measuredWidth = Math.ceil(popover.getBoundingClientRect().width || 0);
      const popoverWidth =
        measuredWidth > 0 ? Math.min(measuredWidth, maxWidth) : maxWidth;
      Object.assign(popover.style, {
        width: "max-content",
        maxWidth: `${maxWidth}px`,
        maxHeight: `${maxHeight}px`,
        left: `${Math.max(left + 16, Math.min(anchor.left, left + width - popoverWidth - 16))}px`,
        top: `${Math.max(top + 16, Math.min(anchor.bottom + 8, top + height - Math.min(popover.scrollHeight, maxHeight) - 16))}px`,
      });
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position);
      popover.hidePopover?.();
    };
  }, [open, hasTitle, preferencesOpen, pane.taskMetadata]);
  function cancelTimer() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }
  function close() {
    cancelTimer();
    if (detailsRef.current) detailsRef.current.open = false;
    setOpen(false);
  }
  async function change(action: () => Promise<Pane>) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      onUpdated(await action());
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Task title update failed.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <details
      ref={detailsRef}
      className="pane-title-details"
      data-has-title={hasTitle ? "true" : "false"}
      onToggle={(event) => {
        if (event.target !== event.currentTarget) return;
        if (!hasTitle) {
          event.currentTarget.open = false;
          setOpen(false);
          return;
        }
        setOpen(event.currentTarget.open);
      }}
      onPointerEnter={(event) => {
        if (!hasTitle) return;
        if (event.pointerType === "touch") return;
        if (event.buttons !== 0) return;
        if (detailsRef.current?.closest(".pane-card")?.classList.contains("is-dragging")) return;
        cancelTimer();
        timer.current = setTimeout(() => {
          if (detailsRef.current) detailsRef.current.open = true;
        }, 300);
      }}
      onPointerDown={() => {
        cancelTimer();
      }}
      onPointerLeave={() => {
        if (!hasTitle) return;
        cancelTimer();
        timer.current = setTimeout(() => {
          if (!detailsRef.current?.contains(document.activeElement)) close();
        }, 200);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          detailsRef.current?.querySelector("summary")?.focus();
          close();
        }
      }}
      onBlur={(event) => {
        if (
          event.relatedTarget &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          close();
      }}
    >
      <summary
        tabIndex={hasTitle ? undefined : -1}
        aria-label={
          hasTitle
            ? `Show task details ${pane.paneName ? `${pane.paneName} - ${popoverTitle}` : popoverTitle}`
            : undefined
        }
        onClick={(event) => {
          event.preventDefault();
          if (!hasTitle) return;
          if (detailsRef.current?.closest(".pane-card")?.classList.contains("is-dragging")) return;
          if (detailsRef.current) detailsRef.current.open = true;
          setOpen(true);
        }}
        onFocus={() => {
          if (!hasTitle) return;
          if (detailsRef.current) detailsRef.current.open = true;
        }}
      >
        <strong ref={titleRef} className="pane-title-text">
          {headerText}
        </strong>
      </summary>
      {hasTitle && open ? (
        <div
          ref={popoverRef}
          popover={typeof HTMLElement !== "undefined" && "showPopover" in HTMLElement.prototype ? "manual" : undefined}
          className="pane-title-detail-content task-title-popover"
          role="region"
          aria-label="Task details"
          onPointerEnter={cancelTimer}
        >
          <div className="task-title-body">
            {/* The title lines already name it; a heading would repeat it. */}
            {topics.some((topic) => topic.title.trim().toLowerCase() === popoverTitle.trim().toLowerCase()) ? null : (
              <p className="task-title-heading">{popoverTitle}</p>
            )}
            {metadata?.nativeTitle ? (
              <p className="task-title-native">
                <span className="task-title-native-label">
                  Saved in {metadata.nativeTitleLabel || "CLI"}
                </span>
                <span className="task-title-native-text">{metadata.nativeTitle}</span>
              </p>
            ) : null}
            {topics.length ? (
              <ol className="task-title-lines" aria-label="Task title lines">
                {topics.map((topic, index) => (
                  <li
                    key={`${index}:${topic.at}`}
                    className="task-title-line"
                    aria-current={index === topics.length - 1 ? "step" : undefined}
                  >
                    <span className="task-title-line-title">
                      {topic.title}
                      {topic.hasImages ? (
                        <span className="task-title-line-badge">Image</span>
                      ) : null}
                    </span>
                    {topic.summary ? (
                      <span className="task-title-line-summary">{topic.summary}</span>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : summarizing && !metadata?.description ? null : (
              <>
                {metadata?.description || taskPane ? (
                  <p className="task-title-description">
                    {metadata?.description ||
                      "Task details will appear after a request is submitted."}
                  </p>
                ) : null}
                {metadata?.steps.length ? (
                  <ol>
                    {metadata.steps.map((step, index) => (
                      <li key={`${index}:${step}`}>{step}</li>
                    ))}
                  </ol>
                ) : null}
              </>
            )}
            {metadata?.earlierWork ? (
              <p className="task-title-earlier">Earlier: {metadata.earlierWork}</p>
            ) : null}
            {taskPane ? (
              <div className="task-title-actions">
                <button
                  type="button"
                  disabled={disabled || pending}
                  onClick={() => {
                    close();
                    onRename();
                  }}
                >
                  Rename
                </button>
                {pane.titleSource === "manual" ||
                pane.taskMetadata?.nativeTitleManual ? (
                  <button
                    type="button"
                    disabled={pending || disabled}
                    onClick={() =>
                      void change(() =>
                        api.updatePane(pane.id, { titleSource: "auto" }),
                      )
                    }
                  >
                    Use automatic title
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={pending || disabled}
                  onClick={() =>
                    void change(() => api.generatePaneTitle(pane.id))
                  }
                >
                  Regenerate summary
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPreferencesOpen(!preferencesOpen);
                    if (!candidates)
                      void api
                        .taskTitleAvailability()
                        .then((result) => setCandidates(result.candidates))
                        .catch(() => setError("Title models are unavailable."));
                  }}
                >
                  Title model
                </button>
              </div>
            ) : null}
            {summarizing ? (
              <p role="status" className="task-title-status">
                {topics.length ? "Checking the latest request…" : "Summarizing the request…"}
              </p>
            ) : topics.at(-1)?.source === "local" &&
              (metadata?.generationStatus === "unavailable" || metadata?.generationStatus === "deferred") ? (
              <p role="status" className="task-title-status">
                AI summary unavailable. Showing a local title.
              </p>
            ) : null}
            {preferencesOpen ? (
              <div className="task-title-preferences">
                <label>
                  Preferred title model
                  <select
                    aria-label="Preferred title model"
                    value={pane.taskMetadata?.preferredCandidateId ?? ""}
                    disabled={pending || disabled}
                    onChange={(event) =>
                      void change(() =>
                        api.setPaneTitlePreference(
                          pane.id,
                          event.target.value || null,
                        ),
                      )
                    }
                  >
                    <option value="">Automatic with fallback</option>
                    {candidates?.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.displayName} · {candidate.providerId} ·{" "}
                        {candidate.billing}
                        {candidate.vision ? " · images" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <small>
                  Summary: {metadata?.generationStatus ?? "pending"}
                  {metadata?.modelId ? ` (${metadata.modelId})` : ""} · Native title:{" "}
                  {metadata?.nativeSyncStatus ?? "pending"}
                </small>
              </div>
            ) : null}
            {error ? <p role="alert">{error}</p> : null}
          </div>
          <button type="button" aria-label="Close task details" onClick={close}>
            ×
          </button>
        </div>
      ) : null}
    </details>
  );
}
