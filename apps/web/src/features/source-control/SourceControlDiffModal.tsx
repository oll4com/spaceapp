import React, { useEffect, useMemo, useState } from "react";
import {
  X,
  Columns,
  AlignJustify,
  ChevronUp,
  ChevronDown,
  Maximize2,
  Minimize2,
  FileCode,
  Plus,
  Minus,
  Undo2,
  CircleAlert
} from "../ui-theme/app-icons.js";
import type { GitFileDiff } from "@space/contracts";
import { DiffViewer } from "./DiffViewer.js";

export interface SourceControlDiffModalProps {
  title: string;
  path: string;
  staged: boolean;
  isRemote?: boolean;
  status?: string;
  diff: GitFileDiff | null;
  diffError: string | null;
  busy: boolean;
  provider: string;
  snapshotVersion?: string;
  onClose: () => void;
  onStageHunk?: (hunkId: string, hunkIndex: number) => void;
  onStageFile?: () => void;
  onUnstageFile?: () => void;
  onDiscardFile?: () => void;
}

export function SourceControlDiffModal({
  title,
  path,
  staged,
  isRemote,
  status,
  diff,
  diffError,
  busy,
  provider,
  snapshotVersion,
  onClose,
  onStageHunk,
  onStageFile,
  onUnstageFile,
  onDiscardFile
}: SourceControlDiffModalProps) {
  const [viewMode, setViewMode] = useState<"split" | "inline">(() => {
    try {
      const saved = localStorage.getItem("space:git-diff-mode");
      return saved === "inline" ? "inline" : "split";
    } catch {
      return "split";
    }
  });

  const [isMaximized, setIsMaximized] = useState(false);
  const [activeHunkIndex, setActiveHunkIndex] = useState(0);

  const toggleViewMode = (mode: "split" | "inline") => {
    setViewMode(mode);
    try {
      localStorage.setItem("space:git-diff-mode", mode);
    } catch {}
  };

  const pathParts = useMemo(() => {
    const segments = path.split("/");
    const basename = segments.pop() || path;
    const dirname = segments.join("/");
    return { basename, dirname };
  }, [path]);

  const hunkCount = diff?.hunks.length || 0;

  const { totalAdded, totalRemoved } = useMemo(() => {
    if (!diff) return { totalAdded: 0, totalRemoved: 0 };
    let added = 0;
    let removed = 0;
    for (const h of diff.hunks) {
      for (const line of h.lines) {
        if (line.startsWith("+")) added++;
        else if (line.startsWith("-")) removed++;
      }
    }
    return { totalAdded: added, totalRemoved: removed };
  }, [diff]);

  const scrollToHunk = (index: number) => {
    if (index < 0 || index >= hunkCount) return;
    setActiveHunkIndex(index);
    const el = document.getElementById(`diff-hunk-${index}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const prevHunk = () => scrollToHunk(activeHunkIndex - 1);
  const nextHunk = () => scrollToHunk(activeHunkIndex + 1);

  // Keyboard shortcut listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.altKey && e.key === "ArrowUp") {
        e.preventDefault();
        prevHunk();
      } else if (e.altKey && e.key === "ArrowDown") {
        e.preventDefault();
        nextHunk();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  const normalizedStatus = (status || "").toUpperCase();
  const statusLabel =
    normalizedStatus === "A"
      ? "Added (New)"
      : normalizedStatus === "U"
      ? "Untracked"
      : normalizedStatus === "D"
      ? "Deleted"
      : normalizedStatus === "R"
      ? "Renamed"
      : "Modified";

  return (
    <div
      className={`source-control-modal-backdrop ${isMaximized ? "is-maximized" : ""}`}
      onClick={onClose}
      role="presentation"
    >
      <div
        className={`source-control-diff-card ${isMaximized ? "is-maximized" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Main Diff Header */}
        <header className="source-control-diff-header">
          <div className="diff-header-left">
            <span className="diff-header-icon" aria-hidden="true">
              <FileCode size={18} />
            </span>
            <span
              className={`diff-status-pill status-${
                normalizedStatus === "A" || normalizedStatus === "U"
                  ? "added"
                  : normalizedStatus === "D"
                  ? "deleted"
                  : normalizedStatus === "R"
                  ? "renamed"
                  : "modified"
              }`}
            >
              {statusLabel}
            </span>
            <div className="diff-header-title">
              <strong className="diff-header-basename">{pathParts.basename}</strong>
              {pathParts.dirname ? (
                <span className="diff-header-dir">{pathParts.dirname}</span>
              ) : null}
            </div>
            {totalAdded > 0 || totalRemoved > 0 ? (
              <div className="diff-header-stats">
                {totalAdded > 0 ? (
                  <span className="diff-stat-add">+{totalAdded}</span>
                ) : null}
                {totalRemoved > 0 ? (
                  <span className="diff-stat-del">-{totalRemoved}</span>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="diff-header-actions">
            {/* View Mode Toggle */}
            <div className="diff-mode-switcher" role="group" aria-label="View mode">
              <button
                type="button"
                className={`diff-mode-btn ${viewMode === "split" ? "is-active" : ""}`}
                onClick={() => toggleViewMode("split")}
                title="Side-by-Side (Split) View"
                aria-pressed={viewMode === "split"}
              >
                <Columns size={14} />
                <span>Split</span>
              </button>
              <button
                type="button"
                className={`diff-mode-btn ${viewMode === "inline" ? "is-active" : ""}`}
                onClick={() => toggleViewMode("inline")}
                title="Unified (Inline) View"
                aria-pressed={viewMode === "inline"}
              >
                <AlignJustify size={14} />
                <span>Inline</span>
              </button>
            </div>

            {/* Hunk Navigation */}
            {hunkCount > 0 ? (
              <div className="diff-nav-controls" role="group" aria-label="Change navigation">
                <button
                  type="button"
                  className="diff-nav-btn"
                  onClick={prevHunk}
                  disabled={activeHunkIndex <= 0}
                  title="Previous change (Alt+Up)"
                  aria-label="Previous change"
                >
                  <ChevronUp size={15} />
                </button>
                <span className="diff-nav-counter">
                  {activeHunkIndex + 1} / {hunkCount}
                </span>
                <button
                  type="button"
                  className="diff-nav-btn"
                  onClick={nextHunk}
                  disabled={activeHunkIndex >= hunkCount - 1}
                  title="Next change (Alt+Down)"
                  aria-label="Next change"
                >
                  <ChevronDown size={15} />
                </button>
              </div>
            ) : null}

            {/* Maximize / Restore Toggle */}
            <button
              type="button"
              className={`icon-action diff-maximize-btn${isMaximized ? " is-active" : ""}`}
              onClick={() => setIsMaximized((prev) => !prev)}
              aria-label={isMaximized ? "Exit diff fullscreen" : "Maximize diff"}
              title={isMaximized ? "Exit diff fullscreen" : "Maximize diff"}
            >
              {isMaximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>

            {/* Close Button */}
            <button
              type="button"
              className="icon-action diff-close-btn"
              aria-label={`Close ${title}`}
              title="Close diff (Esc)"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
        </header>

        {/* Subheader / Status Bar */}
        <div className="source-control-diff-subbar">
          <span className="diff-context-badge">
            {isRemote
              ? `${provider} branch → local commit`
              : staged
              ? "Staged Changes vs HEAD"
              : "Working Tree vs Staged / HEAD"}
          </span>

          {!isRemote ? (
            <div className="diff-file-actions">
              {staged && onUnstageFile ? (
                <button
                  type="button"
                  className="diff-subbar-action-btn"
                  disabled={busy}
                  onClick={onUnstageFile}
                  title={`Unstage ${path}`}
                >
                  <Minus size={13} />
                  <span>Unstage File</span>
                </button>
              ) : null}

              {!staged && onStageFile ? (
                <button
                  type="button"
                  className="diff-subbar-action-btn"
                  disabled={busy}
                  onClick={onStageFile}
                  title={`Stage ${path}`}
                >
                  <Plus size={13} />
                  <span>Stage File</span>
                </button>
              ) : null}

              {!staged && onDiscardFile ? (
                <button
                  type="button"
                  className="diff-subbar-action-btn is-danger"
                  disabled={busy}
                  onClick={onDiscardFile}
                  title={`Discard changes in ${path}`}
                >
                  <Undo2 size={13} />
                  <span>Discard Changes</span>
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Body Content */}
        <div className="source-control-diff-body">
          {diffError ? (
            <div className="diff-alert-box bad" role="alert">
              <CircleAlert size={18} />
              <span>{diffError}</span>
            </div>
          ) : !diff ? (
            <div className="diff-loading-box" role="status">
              <span className="diff-spinner" />
              <span>Loading diff…</span>
            </div>
          ) : diff.binary ? (
            <div className="diff-binary-box" role="status">
              <FileCode size={36} />
              <p>
                {isRemote
                  ? "Binary file differs from the selected remote branch."
                  : "Binary file. Stage or unstage the entire file from the change list."}
              </p>
            </div>
          ) : diff.hunks.length > 0 ? (
            <DiffViewer
              diff={diff}
              viewMode={viewMode}
              onStageHunk={onStageHunk}
              staged={staged}
              isRemote={isRemote}
              busy={busy}
              statusEpochVersion={snapshotVersion}
              activeHunkIndex={activeHunkIndex}
            />
          ) : (
            <div className="diff-empty-box" role="status">
              <pre>
                {diff.text ||
                  (isRemote
                    ? "No textual changes."
                    : "No textual changes. Stage or unstage the entire file.")}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
