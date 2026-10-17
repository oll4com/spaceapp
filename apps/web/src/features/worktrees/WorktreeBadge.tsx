import { GitBranch, Loader2, Check, Trash2, X } from "../ui-theme/app-icons.js";
import { useState, useRef, useEffect } from "react";
import type { SpaceWorktree } from "@space/contracts";
import { mergeWorktree, removeWorktree } from "./worktree-client.js";
import "./worktree.css";

const NON_CRITICAL_INITIAL_DELAY_MS = 4_000;

export interface WorktreeBadgeProps {
  branch?: string;
  worktreePath?: string;
  isDirty?: boolean;
  onMerged?: () => void;
  onRemoved?: () => void;
}

export function WorktreeBadge({
  branch,
  worktreePath,
  isDirty: propIsDirty = false,
  onMerged,
  onRemoved
}: WorktreeBadgeProps) {
  const displayBranch = branch || (worktreePath ? worktreePath.split("/").pop() : "worktree");
  const [isExpanded, setIsExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [worktreeData, setWorktreeData] = useState<SpaceWorktree | null>(null);
  const [isMerged, setIsMerged] = useState(false);
  const badgeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!worktreePath) return;
    let cancelled = false;
    let inFlight = false;

    const checkStatus = async () => {
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        const res = await fetch(`/api/worktrees/item?path=${encodeURIComponent(worktreePath)}`, {
          credentials: "same-origin"
        });
        if (res.ok) {
          const json = await res.json();
          if (!cancelled && json.data) {
            const data: SpaceWorktree = json.data;
            setWorktreeData((prev) => {
              if (
                prev &&
                prev.worktreePath === data.worktreePath &&
                prev.branch === data.branch &&
                Boolean(prev.isDirty) === Boolean(data.isDirty) &&
                Number(prev.aheadCount || 0) === Number(data.aheadCount || 0) &&
                Number(prev.behindCount || 0) === Number(data.behindCount || 0) &&
                prev.status === data.status &&
                prev.baseCommit === data.baseCommit
              ) {
                return prev;
              }
              return data;
            });
            const dirty = Boolean(data.isDirty);
            const ahead = Number(data.aheadCount || 0);
            const isMergedStatus = data.status === "MERGED";

            // If the worktree has active uncommitted changes or commits ahead of main:
            // it has changes and is NOT merged.
            const hasNewChanges = dirty || ahead > 0;
            const nextMerged = !hasNewChanges && isMergedStatus;
            setIsMerged((prev) => (prev === nextMerged ? prev : nextMerged));
          }
        }
      } catch {
        // network or server error, retain current state
      } finally {
        inFlight = false;
      }
    };

    let started = false;
    let timer: number | null = null;
    let timeoutHandle: number | null = null;
    const start = () => {
      if (cancelled || started) return;
      started = true;
      void checkStatus();
      // Periodic polling (every 7.5s) when window/tab is visible
      timer = window.setInterval(() => {
        if (document.visibilityState !== "hidden") void checkStatus();
      }, 7500);
    };
    const runImmediately = /\bjsdom\b/i.test(navigator.userAgent);
    if (runImmediately) {
      start();
    } else {
      timeoutHandle = window.setTimeout(start, NON_CRITICAL_INITIAL_DELAY_MS);
    }

    const handleVisibilityOrFocus = () => {
      if (document.visibilityState !== "hidden") {
        start();
        void checkStatus();
      }
    };

    window.addEventListener("focus", handleVisibilityOrFocus);
    document.addEventListener("visibilitychange", handleVisibilityOrFocus);

    return () => {
      cancelled = true;
      if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
      if (timer !== null) window.clearInterval(timer);
      window.removeEventListener("focus", handleVisibilityOrFocus);
      document.removeEventListener("visibilitychange", handleVisibilityOrFocus);
    };
  }, [worktreePath]);

  useEffect(() => {
    if (!isExpanded) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (badgeRef.current && !badgeRef.current.contains(e.target as Node)) {
        setIsExpanded(false);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [isExpanded]);

  const handleMerge = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!worktreePath) return;
    setLoading(true);
    setError(null);
    try {
      await mergeWorktree(worktreePath, { strategy: "merge", deleteBranchAfter: false });
      setIsMerged(true);
      setIsExpanded(false);
      onMerged?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Merge failed";
      if (msg.toLowerCase().includes("already merged")) {
        setIsMerged(true);
        setIsExpanded(false);
        onMerged?.();
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRemove = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!worktreePath) return;
    const isDirty = Boolean(worktreeData?.isDirty || propIsDirty);
    if (isDirty && typeof window !== "undefined" && !window.confirm("Worktree has uncommitted changes. Force discard?")) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await removeWorktree(worktreePath, true);
      onRemoved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Remove failed");
    } finally {
      setLoading(false);
    }
  };

  // When merged, simply do NOT display any icon.
  // If the agent creates new changes later, checkStatus detects them and resets isMerged to false,
  // making the icon reappear for as many cycles as needed.
  if (isMerged) {
    return null;
  }

  const isDirty = Boolean(worktreeData?.isDirty || propIsDirty);

  if (!isExpanded) {
    return (
      <button
        type="button"
        className="worktree-badge collapsed"
        onClick={() => setIsExpanded(true)}
        title={`Isolated Worktree: ${displayBranch} (Click to open)`}
        aria-label={`Isolated Worktree ${displayBranch}`}
      >
        <GitBranch size={13} aria-hidden="true" />
        {isDirty && <span className="worktree-dirty-dot" title="Uncommitted changes" />}
      </button>
    );
  }

  return (
    <div ref={badgeRef} className="worktree-badge expanded" title={`Isolated Worktree: ${displayBranch}`}>
      <button
        type="button"
        className="worktree-badge-tag worktree-toggle-btn"
        onClick={() => setIsExpanded(false)}
        title={`Isolated Worktree: ${displayBranch} (Click to collapse)`}
        aria-label={`Isolated Worktree ${displayBranch}`}
      >
        <GitBranch size={13} aria-hidden="true" />
        <span className="worktree-branch-name">{displayBranch}</span>
        {isDirty && <span className="worktree-dirty-dot" title="Uncommitted changes" />}
      </button>
      {worktreePath && (
        <div className="worktree-badge-actions">
          <button
            type="button"
            className="worktree-action-btn merge"
            onClick={handleMerge}
            disabled={loading}
            title="Merge to main"
            aria-label="Merge to main"
          >
            {loading ? <Loader2 size={11} className="spin" /> : <Check size={11} />}
            <span className="worktree-action-label">Merge</span>
          </button>
          <button
            type="button"
            className="worktree-action-btn discard"
            onClick={handleRemove}
            disabled={loading}
            title="Discard worktree"
            aria-label="Discard worktree"
          >
            <Trash2 size={11} />
          </button>
          <button
            type="button"
            className="worktree-action-btn close"
            onClick={(e) => {
              e.stopPropagation();
              setIsExpanded(false);
            }}
            title="Collapse"
            aria-label="Collapse"
          >
            <X size={11} />
          </button>
        </div>
      )}
      {error && <span className="worktree-error-tooltip">{error}</span>}
    </div>
  );
}
