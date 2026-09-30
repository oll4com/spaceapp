import { useState, useEffect, useRef, type KeyboardEvent, type UIEvent } from "react";
import { Save, X, FileCode, Check, Eye, Code2 } from "lucide-react";
import { api } from "../../api.js";

export interface FileEditorModalProps {
  filePath: string;
  mode: "user" | "admin";
  onClose: () => void;
  onSaved?: () => void;
}

export function FileEditorModal({ filePath, mode, onClose, onSaved }: FileEditorModalProps) {
  const [content, setContent] = useState<string>("");
  const [initialContent, setInitialContent] = useState<string>("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"edit" | "preview">("edit");
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineNumbersRef = useRef<HTMLDivElement>(null);

  const isDirty = content !== initialContent;
  const isMarkdown = filePath.endsWith(".md") || filePath.endsWith(".markdown");

  useEffect(() => {
    async function load() {
      setIsLoading(true);
      setError(null);
      try {
        const res = await api.filesRead({ path: filePath, mode });
        if (res.isBinary) {
          setError("Binary file cannot be edited as text.");
          setIsLoading(false);
          return;
        }
        setContent(res.content ?? "");
        setInitialContent(res.content ?? "");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load file");
      } finally {
        setIsLoading(false);
      }
    }
    void load();
  }, [filePath, mode]);

  // Sync scrolling between line numbers and textarea
  function handleScroll(e: UIEvent<HTMLTextAreaElement>) {
    if (lineNumbersRef.current) {
      lineNumbersRef.current.scrollTop = e.currentTarget.scrollTop;
    }
  }

  function updateCursorPos() {
    if (!textareaRef.current) return;
    const pos = textareaRef.current.selectionStart;
    const textBefore = content.substring(0, pos);
    const lines = textBefore.split("\n");
    setCursorPos({
      line: lines.length,
      col: (lines[lines.length - 1]?.length ?? 0) + 1
    });
  }

  async function handleSave() {
    if (mode !== "admin") return;
    if (!isDirty || isSaving) return;
    setIsSaving(true);
    setError(null);
    try {
      await api.filesWrite({ path: filePath, content, mode });
      setInitialContent(content);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save file");
    } finally {
      setIsSaving(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (mode !== "admin") return;

    // Save on Ctrl+S or Cmd+S
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      void handleSave();
      return;
    }

    // Tab key inserts 2 spaces
    if (e.key === "Tab") {
      e.preventDefault();
      const textarea = e.currentTarget;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;

      const newContent = content.substring(0, start) + "  " + content.substring(end);
      setContent(newContent);

      setTimeout(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 2;
      }, 0);
    }
  }

  const lines = content.split("\n");
  const lineCount = lines.length;
  const fileName = filePath.split("/").pop() || "";

  return (
    <div className="fm-modal-backdrop" onClick={onClose}>
      <div
        className="fm-modal-card"
        style={{
          width: "100%",
          maxWidth: "1200px",
          height: "100%",
          maxHeight: "100%",
          minHeight: 0,
          minWidth: 0
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Editor Header */}
        <div className="fm-editor-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1, overflow: "hidden" }}>
            <FileCode size={18} color="var(--modern-accent)" style={{ flexShrink: 0 }} />
            <span style={{ fontWeight: 600, fontSize: "0.92rem", color: "var(--modern-text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {fileName}
              {isDirty && <span style={{ color: "var(--modern-warning)", marginLeft: 4 }}>*</span>}
            </span>
            {mode !== "admin" && (
              <span
                style={{
                  fontSize: "0.72rem",
                  padding: "1px 6px",
                  borderRadius: 4,
                  background: "rgba(255, 255, 255, 0.07)",
                  color: "var(--modern-muted)",
                  border: "1px solid var(--modern-border)",
                  flexShrink: 0
                }}
              >
                Read-only
              </span>
            )}
            <span style={{ fontSize: "0.75rem", color: "var(--modern-faint)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={filePath}>
              ({filePath})
            </span>
          </div>

          <div className="fm-editor-actions" style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            {isMarkdown && (
              <div style={{ display: "flex", background: "var(--modern-bg)", borderRadius: 4, padding: 2, gap: 2 }}>
                <button
                  type="button"
                  className={`fm-crumb-btn ${activeTab === "edit" ? "fm-crumb-active" : ""}`}
                  onClick={() => setActiveTab("edit")}
                  style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "4px 8px" }}
                  title="Editor"
                  aria-label="Editor"
                >
                  <Code2 size={16} />
                </button>
                <button
                  type="button"
                  className={`fm-crumb-btn ${activeTab === "preview" ? "fm-crumb-active" : ""}`}
                  onClick={() => setActiveTab("preview")}
                  style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "4px 8px" }}
                  title="Preview"
                  aria-label="Preview"
                >
                  <Eye size={16} />
                </button>
              </div>
            )}

            {mode === "admin" && (
              <button
                type="button"
                className={`fm-btn ${isDirty ? "primary" : ""}`}
                onClick={handleSave}
                disabled={!isDirty || isSaving}
                title={isSaving ? "Saving..." : saveSuccess ? "Saved!" : "Save (Ctrl+S)"}
                aria-label="Save"
                style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "0 10px", height: 28 }}
              >
                {saveSuccess ? <Check size={16} color="#65d8a3" /> : <Save size={16} />}
              </button>
            )}

            <button
              type="button"
              className="fm-action-btn"
              onClick={onClose}
              title="Close (Esc)"
              aria-label="Close"
              style={{ padding: "4px 6px", display: "flex", alignItems: "center", justifyContent: "center" }}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {error && (
          <div style={{ padding: "8px 16px", background: "var(--modern-danger-soft)", color: "var(--modern-danger)", fontSize: "0.82rem" }}>
            {error}
          </div>
        )}

        {/* Editor Body */}
        <div style={{ display: "flex", flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden", position: "relative" }}>
          {isLoading ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", color: "var(--modern-muted)" }}>
              Loading file...
            </div>
          ) : activeTab === "preview" && isMarkdown ? (
            <div
              style={{
                flex: 1,
                padding: "20px 28px",
                overflowY: "auto",
                background: "var(--modern-bg)",
                lineHeight: 1.6
              }}
            >
              <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", margin: 0 }}>
                {content}
              </pre>
            </div>
          ) : (
            <div style={{ display: "flex", flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden" }}>
              {/* Line Numbers Gutter */}
              <div
                ref={lineNumbersRef}
                style={{
                  width: "50px",
                  background: "var(--modern-surface)",
                  color: "var(--modern-faint)",
                  fontFamily: "monospace",
                  fontSize: "0.85rem",
                  lineHeight: "1.5",
                  padding: "12px 6px 12px 0",
                  textAlign: "right",
                  userSelect: "none",
                  overflowY: "hidden",
                  borderRight: "1px solid var(--modern-border)"
                }}
              >
                {Array.from({ length: lineCount }, (_, i) => (
                  <div key={i + 1}>{i + 1}</div>
                ))}
              </div>

              {/* Code Textarea */}
              <textarea
                ref={textareaRef}
                className="fm-editor-textarea"
                value={content}
                readOnly={mode !== "admin"}
                onChange={(e) => {
                  if (mode === "admin") setContent(e.target.value);
                }}
                onKeyDown={handleKeyDown}
                onScroll={handleScroll}
                onKeyUp={updateCursorPos}
                onClick={updateCursorPos}
                spellCheck={false}
                placeholder={mode === "admin" ? "Empty file..." : "Empty file (read-only)"}
              />
            </div>
          )}
        </div>

        {/* Editor Status Bar */}
        <div className="fm-editor-status">
          <div style={{ display: "flex", gap: 14 }}>
            <span>Ln {cursorPos.line}, Col {cursorPos.col}</span>
            <span>{lineCount} lines</span>
            <span>{content.length} characters</span>
          </div>
          <div style={{ display: "flex", gap: 14 }}>
            <span>UTF-8</span>
            <span>Spaces: 2</span>
            <span style={{ textTransform: "uppercase" }}>{fileName.split(".").pop() || "TEXT"}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
