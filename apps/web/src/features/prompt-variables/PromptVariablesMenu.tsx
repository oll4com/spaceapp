import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PromptVariable } from "@space/contracts";
import { Download, Hash, Pencil, Plus, Search, Trash2, Upload, X } from "../ui-theme/app-icons.js";
import { shouldPreserveForSnipTool } from "../snip-tool/snip-guard.js";
import {
  cleanPromptVariableName,
  parsePromptVariablesImport,
  promptVariableNameError,
  usePromptVariables,
  type PromptVariablesImport
} from "./prompt-variables-store.js";
import "./prompt-variables-menu.css";

export interface PromptVariablesMenuProps {
  disabled?: boolean;
  active?: boolean;
  paneTitle?: string;
  onInsertVariable?: (variable: PromptVariable) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  initialName?: string;
}

export function PromptVariablesMenu({
  disabled = false,
  active = true,
  paneTitle,
  onInsertVariable,
  open: controlledOpen,
  onOpenChange,
  initialName = ""
}: PromptVariablesMenuProps) {
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const { variables, addVariable, updateVariable, deleteVariable, restoreVariable, importVariables } = usePromptVariables();

  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  const [position, setPosition] = useState<{
    right: number;
    bottom: number;
    maxHeight: number;
    maxWidth: number;
    width: number;
  } | null>(null);

  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(Boolean(initialName));

  // Form states
  const [formName, setFormName] = useState(initialName.replace(/^#+/, ""));
  const [formLabel, setFormLabel] = useState("");
  const [formValue, setFormValue] = useState("");
  const [formCategory, setFormCategory] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [deletedVariable, setDeletedVariable] = useState<PromptVariable | null>(null);
  const undoTimerRef = useRef<number | null>(null);
  const [pendingImport, setPendingImport] = useState<(PromptVariablesImport & { fileName: string }) | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => () => {
    if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
  }, []);

  const [themeContext, setThemeContext] = useState<{
    uiTheme?: string;
    interfaceTheme?: string;
    roomTheme?: string;
    colorMode?: string;
  }>({});

  const setOpen = useCallback(
    (next: boolean) => {
      if (onOpenChange) {
        onOpenChange(next);
      }
      if (!isControlled) {
        setUncontrolledOpen(next);
      }
    },
    [isControlled, onOpenChange]
  );

  const resetForm = useCallback(() => {
    setEditingId(null);
    setIsCreating(false);
    setFormName("");
    setFormLabel("");
    setFormValue("");
    setFormCategory("");
    setFormDescription("");
    setFormError(null);
  }, []);

  const calculatePosition = useCallback(() => {
    const box = buttonRef.current?.getBoundingClientRect();
    if (!box) return null;

    const container =
      buttonRef.current?.closest(".terminal-floating-controls, .codex-composer-toolbar") ??
      buttonRef.current;
    const anchorBox = container ? container.getBoundingClientRect() : box;
    const rootFontSize =
      typeof window !== "undefined"
        ? Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16
        : 16;

    const paneCard =
      buttonRef.current?.closest<HTMLElement>(".pane-card, [data-space-pane-id]") ||
      buttonRef.current?.closest<HTMLElement>(".terminal-pane, .codex-pane");
    const paneRect = paneCard
      ? paneCard.getBoundingClientRect()
      : {
          left: 0,
          right: window.innerWidth,
          top: 0,
          bottom: window.innerHeight,
          width: window.innerWidth,
          height: window.innerHeight
        };

    // Keep popover completely bounded within the pane horizontally
    const maxWidth = Math.max(
      220,
      Math.min(32 * rootFontSize, paneRect.width - 16, window.innerWidth - 16)
    );
    const idealRight = window.innerWidth - anchorBox.right;
    const minRight = Math.max(8, window.innerWidth - paneRect.right + 8);
    const maxRight = Math.max(minRight, window.innerWidth - paneRect.left - 8 - maxWidth);
    const chosenRight = Math.max(minRight, Math.min(idealRight, maxRight));

    // Vertical positioning: above the button, never covering the pane header or exceeding pane top
    const paneTopLimit = paneCard ? paneRect.top + 38 : 16;
    const availableHeightInsidePane = box.top - 8 - paneTopLimit;
    const availableHeightViewport = box.top - 8 - 16;
    const maxHeight = Math.max(
      160,
      Math.min(availableHeightInsidePane, availableHeightViewport, window.innerHeight - 32)
    );

    const targetHost = buttonRef.current?.closest<HTMLElement>(
      "[data-shell-mode], .space-shell, [data-room-theme], [data-ui-theme]"
    );
    setThemeContext({
      uiTheme:
        targetHost?.dataset.uiTheme ||
        (typeof document !== "undefined" ? document.body.dataset.uiTheme : undefined),
      interfaceTheme:
        targetHost?.dataset.interfaceTheme ||
        (typeof document !== "undefined"
          ? document.documentElement.dataset.interfaceTheme
          : undefined),
      roomTheme:
        targetHost?.dataset.roomTheme ||
        (typeof document !== "undefined" ? document.body.dataset.roomTheme : undefined),
      colorMode:
        targetHost?.dataset.colorMode ||
        (typeof document !== "undefined" ? document.body.dataset.colorMode : undefined)
    });

    return {
      right: chosenRight,
      bottom: Math.max(8, window.innerHeight - box.top + 8),
      maxHeight,
      maxWidth,
      width: maxWidth
    };
  }, []);

  // Update position when opened
  useEffect(() => {
    if (isOpen && active && !disabled) {
      const pos = calculatePosition();
      setPosition(pos);
      if (initialName) {
        setIsCreating(true);
        setFormName(initialName.replace(/^#+/, ""));
      }
    } else {
      setPosition(null);
      resetForm();
    }
  }, [isOpen, active, disabled, calculatePosition, initialName, resetForm]);

  // Auto-dismiss if pane unmaximizes or state becomes inactive/disabled
  useEffect(() => {
    if (!active || disabled) {
      setOpen(false);
      setPosition(null);
      resetForm();
    }
  }, [active, disabled, setOpen, resetForm]);

  // Click outside and Escape key handling
  useEffect(() => {
    if (!isOpen || !position) return;

    const outside = (event: PointerEvent) => {
      if (shouldPreserveForSnipTool(event)) return;
      if (
        event.target instanceof Node &&
        !panelRef.current?.contains(event.target) &&
        !buttonRef.current?.contains(event.target)
      ) {
        setOpen(false);
        setPosition(null);
        resetForm();
      }
    };

    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setPosition(null);
      resetForm();
      buttonRef.current?.focus();
    };

    const close = () => {
      setOpen(false);
      setPosition(null);
      resetForm();
    };

    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", close);

    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", close);
    };
  }, [isOpen, position, isCreating, editingId, setOpen, resetForm]);

  // Observe pane resize to close or reposition
  useEffect(() => {
    if (!isOpen || !position) return;
    const paneCard =
      buttonRef.current?.closest<HTMLElement>(".pane-card, [data-space-pane-id]") ||
      buttonRef.current?.closest<HTMLElement>(".terminal-pane, .codex-pane");
    if (!paneCard || typeof ResizeObserver === "undefined") return;

    let initialCall = true;
    const observer = new ResizeObserver(() => {
      if (initialCall) {
        initialCall = false;
        return;
      }
      setOpen(false);
      setPosition(null);
      resetForm();
    });

    observer.observe(paneCard);
    return () => {
      observer.disconnect();
    };
  }, [isOpen, position, setOpen, resetForm]);

  // Horizontal position correction if overflowing pane left boundary
  useLayoutEffect(() => {
    if (!isOpen || !panelRef.current) return;
    const paneCard =
      buttonRef.current?.closest<HTMLElement>(".pane-card, [data-space-pane-id]") ||
      buttonRef.current?.closest<HTMLElement>(".terminal-pane, .codex-pane");
    const minLeft = paneCard ? paneCard.getBoundingClientRect().left + 8 : 8;
    const rect = panelRef.current.getBoundingClientRect();
    if (rect.left < minLeft) {
      const overflow = minLeft - rect.left;
      setPosition((current) => {
        if (!current) return current;
        return {
          ...current,
          right: Math.max(8, current.right - overflow)
        };
      });
    }
  }, [isOpen]);

  const toggleOpen = () => {
    if (isOpen) {
      setOpen(false);
      setPosition(null);
      resetForm();
    } else {
      const pos = calculatePosition();
      setPosition(pos);
      setOpen(true);
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return variables;
    return variables.filter(
      (v) =>
        v.name.toLowerCase().includes(q) ||
        (v.label ?? "").toLowerCase().includes(q) ||
        (v.category ?? "").toLowerCase().includes(q) ||
        v.value.toLowerCase().includes(q)
    );
  }, [variables, search]);

  function handleStartCreate() {
    resetForm();
    setIsCreating(true);
  }

  function handleStartEdit(variable: PromptVariable) {
    setEditingId(variable.id);
    setIsCreating(false);
    setFormName(variable.name);
    setFormLabel(variable.label ?? "");
    setFormValue(variable.value);
    setFormCategory(variable.category ?? "");
    setFormDescription(variable.description ?? "");
    setFormError(null);
  }

  function handleSaveForm(e: React.FormEvent) {
    e.preventDefault();
    const cleanName = cleanPromptVariableName(formName);
    // A new name must not silently replace another variable, and a rename must not duplicate one.
    const nameError = promptVariableNameError(cleanName, variables, editingId);
    if (nameError) {
      setFormError(nameError);
      return;
    }
    if (!formValue.trim()) {
      setFormError("Definition / value is required.");
      return;
    }

    // The definition is stored exactly as typed; leading or trailing spaces can be part of it.
    if (editingId) {
      updateVariable(editingId, {
        name: cleanName,
        label: formLabel.trim() || undefined,
        value: formValue,
        category: formCategory.trim() || undefined,
        description: formDescription.trim() || undefined
      });
    } else {
      addVariable({
        name: cleanName,
        label: formLabel.trim() || undefined,
        value: formValue,
        category: formCategory.trim() || undefined,
        description: formDescription.trim() || undefined
      });
    }

    resetForm();
  }

  function handleExportJson() {
    const dataStr =
      "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(variables, null, 2));
    const downloadAnchor = document.createElement("a");
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute(
      "download",
      `space-prompt-variables-${new Date().toISOString().slice(0, 10)}.json`
    );
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  }

  // Importing first shows what the file contains; nothing changes until Merge or Replace all.
  function handleImportJson(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError(null);
    setPendingImport(null);
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = parsePromptVariablesImport(String(event.target?.result ?? ""));
        setPendingImport({ ...parsed, fileName: file.name });
      } catch (err) {
        setImportError(err instanceof Error ? err.message : "The file could not be imported.");
      }
    };
    reader.onerror = () => setImportError("The file could not be read.");
    reader.readAsText(file);
    e.target.value = "";
  }

  function applyImport(mode: "merge" | "replace") {
    if (!pendingImport) return;
    importVariables(pendingImport.variables, mode);
    setPendingImport(null);
  }

  function handleDelete(variable: PromptVariable) {
    deleteVariable(variable.id);
    if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
    setDeletedVariable(variable);
    undoTimerRef.current = window.setTimeout(() => {
      undoTimerRef.current = null;
      setDeletedVariable(null);
    }, 8_000);
  }

  function handleUndoDelete() {
    if (!deletedVariable) return;
    if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
    undoTimerRef.current = null;
    restoreVariable(deletedVariable);
    setDeletedVariable(null);
  }

  const titleText = paneTitle
    ? `Prompt Variables (#) · ${paneTitle}`
    : "Prompt Variables (#) · Custom context shortcuts";

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`terminal-shortcuts-button terminal-plans-button terminal-variables-button ${isOpen ? "is-active" : ""}`}
        aria-label={titleText}
        title={titleText}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? id : undefined}
        disabled={disabled}
        onClick={toggleOpen}
      >
        <Hash aria-hidden="true" style={{ width: 14, height: 14 }} />
      </button>

      {isOpen && position && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              id={id}
              className="terminal-plans-popover terminal-variables-popover"
              role="dialog"
              aria-label="Prompt Variables"
              data-ui-theme={themeContext.uiTheme}
              data-interface-theme={themeContext.interfaceTheme}
              data-room-theme={themeContext.roomTheme}
              data-color-mode={themeContext.colorMode}
              style={position}
            >
              {/* Header */}
              <div className="terminal-plans-header">
                <div className="terminal-plans-header-title">
                  <Hash aria-hidden="true" style={{ width: 16, height: 16 }} />
                  <span className="terminal-plans-title-text">Prompt Variables</span>
                  {variables.length > 0 ? (
                    <span className="terminal-plans-count-badge">{variables.length}</span>
                  ) : null}
                </div>
                <div className="terminal-plans-header-actions">
                  <button
                    type="button"
                    className="terminal-plans-action-btn"
                    aria-label="New prompt variable"
                    title="New prompt variable"
                    onClick={() => {
                      if (isCreating || editingId) {
                        resetForm();
                      } else {
                        handleStartCreate();
                      }
                    }}
                  >
                    <Plus aria-hidden="true" style={{ width: 14, height: 14 }} />
                  </button>
                  <button
                    type="button"
                    className="terminal-plans-action-btn"
                    aria-label="Import variables from JSON"
                    title="Import JSON"
                    onClick={() => importInputRef.current?.click()}
                  >
                    <Upload aria-hidden="true" style={{ width: 13, height: 13 }} />
                  </button>
                  <input ref={importInputRef} type="file" accept=".json" hidden aria-hidden="true" tabIndex={-1} onChange={handleImportJson} />
                  <button
                    type="button"
                    className="terminal-plans-action-btn"
                    aria-label="Export variables as JSON"
                    title="Export JSON"
                    disabled={variables.length === 0}
                    onClick={handleExportJson}
                  >
                    <Download aria-hidden="true" style={{ width: 13, height: 13 }} />
                  </button>
                  <button
                    type="button"
                    className="terminal-plans-action-btn terminal-plans-close-btn"
                    aria-label="Close"
                    title="Close"
                    onClick={() => {
                      setOpen(false);
                      setPosition(null);
                      resetForm();
                    }}
                  >
                    <X aria-hidden="true" style={{ width: 14, height: 14 }} />
                  </button>
                </div>
              </div>

              {/* Search Bar */}
              <div className="terminal-plans-search-container">
                <Search
                  aria-hidden="true"
                  className="terminal-plans-search-icon"
                  style={{ width: 14, height: 14 }}
                />
                <input
                  type="text"
                  className="terminal-plans-search-input"
                  placeholder="Search variables (#name, value, label)..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label="Search prompt variables"
                />
                {search ? (
                  <button
                    type="button"
                    className="terminal-plans-search-clear-btn"
                    onClick={() => setSearch("")}
                    aria-label="Clear search"
                  >
                    <X aria-hidden="true" style={{ width: 12, height: 12 }} />
                  </button>
                ) : null}
              </div>

              {/* Form when creating or editing */}
              {isCreating || editingId ? (
                <form className="terminal-variables-form" onSubmit={handleSaveForm}>
                  <div className="terminal-variables-form-header">
                    <h4>{editingId ? "Edit Variable" : "New Prompt Variable"}</h4>
                    <button
                      type="button"
                      className="terminal-variables-form-cancel"
                      onClick={resetForm}
                    >
                      Cancel
                    </button>
                  </div>

                  {formError ? (
                    <div className="terminal-variables-form-error">{formError}</div>
                  ) : null}

                  <div className="terminal-variables-form-field">
                    <label htmlFor="pvm-form-name">Trigger Name</label>
                    <div className="terminal-variables-input-prefix">
                      <span>#</span>
                      <input
                        id="pvm-form-name"
                        type="text"
                        placeholder="pc_thai"
                        value={formName}
                        onChange={(e) => setFormName(e.target.value)}
                        required
                        autoFocus
                      />
                    </div>
                  </div>

                  <div className="terminal-variables-form-field">
                    <label htmlFor="pvm-form-value">Definition / Injected Prompt</label>
                    <textarea
                      id="pvm-form-value"
                      placeholder="e.g. Computer with IP 192.168.10.50 accessed via RT-BKK-01"
                      value={formValue}
                      onChange={(e) => setFormValue(e.target.value)}
                      rows={3}
                      required
                    />
                  </div>

                  <div className="terminal-variables-form-row">
                    <div className="terminal-variables-form-field">
                      <label htmlFor="pvm-form-cat">Category (optional)</label>
                      <input
                        id="pvm-form-cat"
                        type="text"
                        placeholder="Network"
                        value={formCategory}
                        onChange={(e) => setFormCategory(e.target.value)}
                      />
                    </div>
                    <div className="terminal-variables-form-field">
                      <label htmlFor="pvm-form-desc">Description (optional)</label>
                      <input
                        id="pvm-form-desc"
                        type="text"
                        placeholder="Bangkok terminal bridge"
                        value={formDescription}
                        onChange={(e) => setFormDescription(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="terminal-variables-form-actions">
                    <button type="submit" className="terminal-plans-nav-btn is-save-btn">
                      {editingId ? "Update Variable" : "Save Variable"}
                    </button>
                  </div>
                </form>
              ) : null}

              {importError ? (
                <div className="terminal-variables-notice is-error" role="alert">
                  <span>{importError}</span>
                  <button type="button" className="terminal-plans-nav-btn" onClick={() => setImportError(null)}>Dismiss</button>
                </div>
              ) : null}
              {pendingImport ? (
                <div className="terminal-variables-notice" role="status">
                  <span>
                    {(() => {
                      const existing = new Set(variables.map((v) => v.name.toLowerCase()));
                      const updates = pendingImport.variables.filter((v) => existing.has(v.name.toLowerCase())).length;
                      const additions = pendingImport.variables.length - updates;
                      return `${pendingImport.fileName}: ${pendingImport.variables.length} variables (${additions} new, ${updates} update existing${pendingImport.skipped ? `, ${pendingImport.skipped} skipped` : ""}).`;
                    })()}
                  </span>
                  <span className="terminal-variables-notice-actions">
                    <button type="button" className="terminal-plans-nav-btn" onClick={() => applyImport("merge")}>Merge</button>
                    <button type="button" className="terminal-plans-nav-btn" onClick={() => applyImport("replace")}>Replace all</button>
                    <button type="button" className="terminal-plans-nav-btn" onClick={() => setPendingImport(null)}>Cancel</button>
                  </span>
                </div>
              ) : null}
              {deletedVariable ? (
                <div className="terminal-variables-notice" role="status">
                  <span>Deleted #{deletedVariable.name}.</span>
                  <button type="button" className="terminal-plans-nav-btn" onClick={handleUndoDelete}>Undo</button>
                </div>
              ) : null}

              {/* Variables List */}
              <div
                className="terminal-plans-list terminal-variables-list"
                role="list"
                aria-label="Prompt variables list"
              >
                {filtered.length > 0 ? (
                  filtered.map((variable) => (
                    <div
                      key={variable.id}
                      role="listitem"
                      className="terminal-variable-card"
                      onClick={() => {
                        if (onInsertVariable) {
                          onInsertVariable(variable);
                          setOpen(false);
                          setPosition(null);
                          resetForm();
                        }
                      }}
                      title={
                        onInsertVariable
                          ? `Click to insert #${variable.name} into prompt`
                          : undefined
                      }
                    >
                      <div className="terminal-variable-card-header">
                        <div className="terminal-variable-card-identity">
                          <span className="terminal-variable-tag">#{variable.name}</span>
                          {variable.category ? (
                            <span className="terminal-variable-category">
                              {variable.category}
                            </span>
                          ) : null}
                          {variable.label ? (
                            <span className="terminal-variable-label" title={variable.label}>
                              {variable.label}
                            </span>
                          ) : null}
                        </div>

                        <div className="terminal-variable-card-actions">
                          {onInsertVariable ? (
                            <button
                              type="button"
                              className="terminal-variable-insert-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                onInsertVariable(variable);
                                setOpen(false);
                                setPosition(null);
                                resetForm();
                              }}
                              title={`Insert #${variable.name}`}
                            >
                              Insert
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="terminal-variable-icon-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleStartEdit(variable);
                            }}
                            aria-label={`Edit #${variable.name}`}
                            title="Edit variable"
                          >
                            <Pencil aria-hidden="true" style={{ width: 12, height: 12 }} />
                          </button>
                          <button
                            type="button"
                            className="terminal-variable-icon-btn is-delete"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDelete(variable);
                            }}
                            aria-label={`Delete #${variable.name}`}
                            title="Delete variable"
                          >
                            <Trash2 aria-hidden="true" style={{ width: 12, height: 12 }} />
                          </button>
                        </div>
                      </div>

                      <div className="terminal-variable-snippet">
                        <code data-sensitive-masked="manual">{variable.value}</code>
                      </div>

                      {variable.description ? (
                        <div className="terminal-variable-footer" title={variable.description}>
                          <span>{variable.description}</span>
                        </div>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <div className="terminal-variables-empty-state">
                    {search ? (
                      <p>No variables matching &ldquo;{search}&rdquo;</p>
                    ) : (
                      <>
                        <p>No prompt variables configured yet.</p>
                        <button
                          type="button"
                          className="terminal-plans-nav-btn"
                          onClick={handleStartCreate}
                        >
                          Create your first variable
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
