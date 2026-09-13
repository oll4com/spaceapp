import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  shortTaskTitle,
  type Pane,
  type TaskTitleCandidateStatus,
} from "@space/contracts";
import { api } from "../../api.js";

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
  const title =
    taskPane && pane.titleSource !== "manual"
      ? shortTaskTitle(pane.title, "Task")
      : displayTitle;
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  useLayoutEffect(() => {
    if (!open) return;
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
      const popoverWidth = Math.min(520, width - 32);
      const maxHeight = Math.min(560, height - 32);
      Object.assign(popover.style, {
        width: `${popoverWidth}px`,
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
  }, [open, preferencesOpen, pane.taskMetadata]);
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
      onToggle={(event) => {
        if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
      }}
      onPointerEnter={(event) => {
        if (event.pointerType === "touch") return;
        cancelTimer();
        timer.current = setTimeout(() => {
          if (detailsRef.current) detailsRef.current.open = true;
        }, 300);
      }}
      onPointerLeave={() => {
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
        aria-label={`Show task details ${title}`}
        onClick={(event) => {
          event.preventDefault();
          if (detailsRef.current) detailsRef.current.open = true;
          setOpen(true);
        }}
        onFocus={() => {
          if (detailsRef.current) detailsRef.current.open = true;
        }}
      >
        <strong ref={titleRef} className="pane-title-text">
          {title}
        </strong>
      </summary>
      {open ? (
        <div
          ref={popoverRef}
          popover={typeof HTMLElement !== "undefined" && "showPopover" in HTMLElement.prototype ? "manual" : undefined}
          className="pane-title-detail-content task-title-popover"
          role="region"
          aria-label="Task details"
          onPointerEnter={cancelTimer}
        >
          <div className="task-title-body">
            <p className="task-title-heading">{title}</p>
            <p className="task-title-description">
              {pane.taskMetadata?.description ||
                (taskPane
                  ? "Task details will appear after a request is submitted."
                  : displayTitle)}
            </p>
            {pane.taskMetadata?.steps.length ? (
              <ol>
                {pane.taskMetadata.steps.map((step, index) => (
                  <li key={`${index}:${step}`}>{step}</li>
                ))}
              </ol>
            ) : null}
            {pane.taskMetadata?.earlierWork ? (
              <p>{pane.taskMetadata.earlierWork}</p>
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
            {pane.taskMetadata?.generationStatus === "pending" ? (
              <p role="status">Summary update queued.</p>
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
                      </option>
                    ))}
                  </select>
                </label>
                <small>
                  Summary: {pane.taskMetadata?.generationStatus ?? "pending"} ·
                  Native title:{" "}
                  {pane.taskMetadata?.nativeSyncStatus ?? "pending"}
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
