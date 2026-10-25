import { useEffect, useRef } from "react";
import type { PromptVariable } from "@space/contracts";
import { Hash, Plus, Settings, X } from "../ui-theme/app-icons.js";
import { filterPromptVariables, usePromptVariables } from "./prompt-variables-store.js";
import "./prompt-variables.css";

export interface PromptVariableAutocompleteProps {
  query: string;
  selectedIndex: number;
  onSelect: (variable: PromptVariable) => void;
  onClose: () => void;
  onOpenManager?: (initialName?: string) => void;
  onHighlightIndex?: (index: number) => void;
}

export function PromptVariableAutocomplete({
  query,
  selectedIndex,
  onSelect,
  onClose,
  onOpenManager,
  onHighlightIndex
}: PromptVariableAutocompleteProps) {
  const { variables, settings } = usePromptVariables();
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = filterPromptVariables(variables, query);

  // Auto-scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selectedElement = listRef.current.querySelector<HTMLElement>(".prompt-variable-item.is-selected");
    if (selectedElement) {
      selectedElement.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    }
  }, [selectedIndex]);

  // Global capture for Escape key to guarantee closing autocomplete
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [onClose]);

  if (!settings.enabled) return null;

  return (
    <div
      className="prompt-variable-autocomplete-popup"
      role="listbox"
      aria-label="Prompt variables suggestions"
      tabIndex={-1}
      onMouseDown={(e) => {
        // Prevent terminal or composer from losing focus
        e.preventDefault();
      }}
    >
      <div className="prompt-variable-autocomplete-header">
        <div className="prompt-variable-autocomplete-title">
          <Hash aria-hidden="true" className="prompt-variable-header-icon" />
          <span>Variables</span>
          {query ? <span className="prompt-variable-filter-chip">#{query}</span> : null}
        </div>
        <div className="prompt-variable-header-actions">
          {onOpenManager ? (
            <button
              type="button"
              className="prompt-variable-header-manage-btn"
              onClick={() => onOpenManager(query)}
              title="Manage Prompt Variables"
              aria-label="Manage Prompt Variables"
            >
              <Settings aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            className="prompt-variable-header-close-btn"
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            <X aria-hidden="true" style={{ width: 13, height: 13 }} />
          </button>
        </div>
      </div>

      <div className="prompt-variable-autocomplete-list" ref={listRef}>
        {filtered.length > 0 ? (
          filtered.map((item, index) => {
            const isSelected = index === selectedIndex;
            return (
              <button
                type="button"
                key={item.id}
                className={`prompt-variable-item ${isSelected ? "is-selected" : ""}`}
                role="option"
                aria-selected={isSelected}
                onClick={() => onSelect(item)}
                onMouseEnter={() => onHighlightIndex?.(index)}
              >
                <div className="prompt-variable-item-head">
                  <span className="prompt-variable-name">#{item.name}</span>
                  {item.label ? <span className="prompt-variable-label">{item.label}</span> : null}
                  {item.category ? <span className="prompt-variable-category">{item.category}</span> : null}
                </div>
                <div className="prompt-variable-item-value" data-sensitive-masked="manual">
                  {item.value}
                </div>
              </button>
            );
          })
        ) : (
          <div className="prompt-variable-empty">
            <span>No variable matches &ldquo;#{query}&rdquo;</span>
            {onOpenManager ? (
              <button
                type="button"
                className="prompt-variable-quick-add-btn"
                onClick={() => onOpenManager(query)}
              >
                <Plus aria-hidden="true" />
                <span>Create #{query || "variable"}</span>
              </button>
            ) : null}
          </div>
        )}
      </div>

      <div className="prompt-variable-autocomplete-footer">
        <span className="prompt-variable-key-hint">
          <kbd>&uarr;</kbd> <kbd>&darr;</kbd> Navigate
        </span>
        <span className="prompt-variable-key-hint">
          <kbd>&crarr;</kbd> / <kbd>Tab</kbd> Insert
        </span>
        <span className="prompt-variable-key-hint">
          <kbd>Esc</kbd> Close
        </span>
      </div>
    </div>
  );
}
