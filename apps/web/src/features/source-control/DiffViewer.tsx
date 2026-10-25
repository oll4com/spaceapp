import React, { useMemo } from "react";
import type { GitFileDiff, GitDiffHunk } from "@space/contracts";
import { Plus, Minus } from "../ui-theme/app-icons.js";

export interface DiffViewerProps {
  diff: GitFileDiff;
  viewMode: "split" | "inline";
  onStageHunk?: (hunkId: string, hunkIndex: number) => void;
  staged?: boolean;
  isRemote?: boolean;
  busy?: boolean;
  statusEpochVersion?: string;
  activeHunkIndex?: number;
}

export interface WordToken {
  text: string;
  changed: boolean;
}

export function computeWordDiff(
  oldText: string,
  newText: string
): { oldParts: WordToken[]; newParts: WordToken[] } {
  // Tokenize by word, punctuation, or whitespace
  const tokenize = (s: string) => s.match(/([a-zA-Z0-9_$]+|[ \t]+|[^a-zA-Z0-9_$\s])/g) || [s];
  const tokensA = tokenize(oldText);
  const tokensB = tokenize(newText);
  const m = tokensA.length;
  const n = tokensB.length;

  // Fallback for empty or very large minified lines to avoid large allocation
  if (m === 0 || n === 0 || m > 250 || n > 250) {
    return {
      oldParts: [{ text: oldText, changed: true }],
      newParts: [{ text: newText, changed: true }]
    };
  }

  // LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (tokensA[i - 1] === tokensB[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  let i = m;
  let j = n;
  const tempA: WordToken[] = [];
  const tempB: WordToken[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && tokensA[i - 1] === tokensB[j - 1]) {
      tempA.unshift({ text: tokensA[i - 1]!, changed: false });
      tempB.unshift({ text: tokensB[j - 1]!, changed: false });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      tempB.unshift({ text: tokensB[j - 1]!, changed: true });
      j--;
    } else if (i > 0) {
      tempA.unshift({ text: tokensA[i - 1]!, changed: true });
      i--;
    }
  }

  function mergeAdjacentTokens(tokens: WordToken[]): WordToken[] {
    if (!tokens.length) return [];
    const merged: WordToken[] = [];
    let current = { ...tokens[0]! };
    for (let k = 1; k < tokens.length; k++) {
      const next = tokens[k]!;
      if (next.changed === current.changed) {
        current.text += next.text;
      } else {
        merged.push(current);
        current = { ...next };
      }
    }
    merged.push(current);
    return merged;
  }

  return { oldParts: mergeAdjacentTokens(tempA), newParts: mergeAdjacentTokens(tempB) };
}

interface SplitCell {
  type: "context" | "added" | "removed";
  lineNum: number;
  text: string;
  wordParts?: WordToken[];
}

interface SplitRow {
  left: SplitCell | null;
  right: SplitCell | null;
}

interface InlineRow {
  type: "context" | "added" | "removed";
  oldLine?: number;
  newLine?: number;
  text: string;
  wordParts?: WordToken[];
}

interface ParsedHunk {
  hunk: GitDiffHunk;
  index: number;
  oldStart: number;
  newStart: number;
  contextHeader: string;
  splitRows: SplitRow[];
  inlineRows: InlineRow[];
}

function parseHunkData(hunk: GitDiffHunk, hunkIndex: number): ParsedHunk {
  const m = hunk.header.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/);
  const oldStart = m ? parseInt(m[1]!, 10) : 1;
  const newStart = m ? parseInt(m[2]!, 10) : 1;
  const contextHeader = m ? m[3]!.trim() : "";

  let oldLine = oldStart;
  let newLine = newStart;

  const inlineRows: InlineRow[] = [];
  const splitRows: SplitRow[] = [];

  let pendingRemoved: SplitCell[] = [];
  let pendingAdded: SplitCell[] = [];

  function flushChanges() {
    if (!pendingRemoved.length && !pendingAdded.length) return;
    const max = Math.max(pendingRemoved.length, pendingAdded.length);

    for (let k = 0; k < max; k++) {
      const left = pendingRemoved[k] || null;
      const right = pendingAdded[k] || null;

      if (left && right) {
        // Paired line modification: compute intra-line word diff
        const diffResult = computeWordDiff(left.text, right.text);
        left.wordParts = diffResult.oldParts;
        right.wordParts = diffResult.newParts;
      } else if (left) {
        left.wordParts = [{ text: left.text, changed: true }];
      } else if (right) {
        right.wordParts = [{ text: right.text, changed: true }];
      }

      splitRows.push({ left, right });
    }
    pendingRemoved = [];
    pendingAdded = [];
  }

  for (const rawLine of hunk.lines) {
    if (rawLine.startsWith("-")) {
      const cell: SplitCell = { type: "removed", lineNum: oldLine++, text: rawLine };
      pendingRemoved.push(cell);
      inlineRows.push({
        type: "removed",
        oldLine: cell.lineNum,
        text: rawLine
      });
    } else if (rawLine.startsWith("+")) {
      const cell: SplitCell = { type: "added", lineNum: newLine++, text: rawLine };
      pendingAdded.push(cell);
      inlineRows.push({
        type: "added",
        newLine: cell.lineNum,
        text: rawLine
      });
    } else {
      flushChanges();
      const currentOld = oldLine++;
      const currentNew = newLine++;
      inlineRows.push({
        type: "context",
        oldLine: currentOld,
        newLine: currentNew,
        text: rawLine
      });
      splitRows.push({
        left: { type: "context", lineNum: currentOld, text: rawLine },
        right: { type: "context", lineNum: currentNew, text: rawLine }
      });
    }
  }
  flushChanges();

  return {
    hunk,
    index: hunkIndex,
    oldStart,
    newStart,
    contextHeader,
    splitRows,
    inlineRows
  };
}

export function DiffViewer({
  diff,
  viewMode,
  onStageHunk,
  staged,
  isRemote,
  busy,
  statusEpochVersion,
  activeHunkIndex
}: DiffViewerProps) {
  const parsedHunks = useMemo(() => {
    return diff.hunks.map((hunk, index) => parseHunkData(hunk, index));
  }, [diff.hunks]);

  return (
    <div className={`diff-viewer-shell mode-${viewMode}`} role="region" aria-label="Diff viewer">
      {parsedHunks.map((pHunk) => {
        const isActive = activeHunkIndex === pHunk.index;
        return (
          <section
            className={`diff-hunk-container ${isActive ? "is-active-hunk" : ""}`}
            key={pHunk.hunk.id || `hunk-${pHunk.index}`}
            id={`diff-hunk-${pHunk.index}`}
          >
            <div className="diff-hunk-bar">
              <span className="diff-hunk-header-code" title={pHunk.hunk.header}>
                <span className="diff-hunk-badge">@@</span>
                <span className="diff-hunk-coords">
                  -{pHunk.oldStart} +{pHunk.newStart}
                </span>
                {pHunk.contextHeader ? (
                  <span className="diff-hunk-func-context">{pHunk.contextHeader}</span>
                ) : null}
              </span>

              <div className="diff-hunk-actions">
                {!isRemote && onStageHunk ? (
                  <button
                    type="button"
                    className="diff-hunk-btn"
                    disabled={busy || (Boolean(statusEpochVersion) && diff.version !== statusEpochVersion)}
                    aria-label={`${staged ? "Unstage" : "Stage"} hunk ${pHunk.index + 1}`}
                    title={`${staged ? "Unstage" : "Stage"} hunk ${pHunk.index + 1}`}
                    onClick={() => onStageHunk(pHunk.hunk.id, pHunk.index)}
                  >
                    {staged ? <Minus size={13} /> : <Plus size={13} />}
                    <span>{staged ? "Unstage" : "Stage"} hunk</span>
                  </button>
                ) : null}
              </div>
            </div>

            {viewMode === "split" ? (
              <div className="diff-split-table" role="table">
                {pHunk.splitRows.map((row, rIdx) => {
                  const left = row.left;
                  const right = row.right;

                  return (
                    <div
                      className={`diff-split-row ${
                        left?.type === "removed" && right?.type === "added"
                          ? "is-change-pair"
                          : left?.type === "removed"
                          ? "is-removed-row"
                          : right?.type === "added"
                          ? "is-added-row"
                          : "is-context-row"
                      }`}
                      key={rIdx}
                      role="row"
                    >
                      {/* Left Side (Original / Base) */}
                      <div
                        className={`diff-split-cell diff-cell-left ${
                          left ? `diff-line-${left.type}` : "diff-line-empty"
                        }`}
                        role="cell"
                      >
                        <span className="diff-gutter-num">
                          {left ? left.lineNum : ""}
                        </span>
                        <span className="diff-gutter-sign">
                          {left?.type === "removed" ? "-" : " "}
                        </span>
                        <span className="diff-code-text">
                          {left ? (
                            left.wordParts ? (
                              left.wordParts.map((part, pIdx) => (
                                <span
                                  key={pIdx}
                                  className={part.changed ? "diff-word-removed" : undefined}
                                >
                                  {part.text}
                                </span>
                              ))
                            ) : (
                              left.text
                            )
                          ) : (
                            <span className="diff-placeholder-stripe" />
                          )}
                        </span>
                      </div>

                      {/* Right Side (Modified / Current) */}
                      <div
                        className={`diff-split-cell diff-cell-right ${
                          right ? `diff-line-${right.type}` : "diff-line-empty"
                        }`}
                        role="cell"
                      >
                        <span className="diff-gutter-num">
                          {right ? right.lineNum : ""}
                        </span>
                        <span className="diff-gutter-sign">
                          {right?.type === "added" ? "+" : " "}
                        </span>
                        <span className="diff-code-text">
                          {right ? (
                            right.wordParts ? (
                              right.wordParts.map((part, pIdx) => (
                                <span
                                  key={pIdx}
                                  className={part.changed ? "diff-word-added" : undefined}
                                >
                                  {part.text}
                                </span>
                              ))
                            ) : (
                              right.text
                            )
                          ) : (
                            <span className="diff-placeholder-stripe" />
                          )}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              /* Inline View */
              <div className="diff-inline-table" role="table">
                {pHunk.inlineRows.map((row, rIdx) => {
                  return (
                    <div
                      className={`diff-inline-row diff-line-${row.type}`}
                      key={rIdx}
                      role="row"
                    >
                      <span className="diff-gutter-num gutter-old">
                        {row.oldLine ?? ""}
                      </span>
                      <span className="diff-gutter-num gutter-new">
                        {row.newLine ?? ""}
                      </span>
                      <span className="diff-gutter-sign">
                        {row.type === "added" ? "+" : row.type === "removed" ? "-" : " "}
                      </span>
                      <span className="diff-code-text">
                        {row.wordParts ? (
                          row.wordParts.map((part, pIdx) => (
                            <span
                              key={pIdx}
                              className={
                                part.changed
                                  ? row.type === "added"
                                    ? "diff-word-added"
                                    : "diff-word-removed"
                                  : undefined
                              }
                            >
                              {part.text}
                            </span>
                          ))
                        ) : (
                          row.text
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
