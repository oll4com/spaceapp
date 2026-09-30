import { useState, useEffect, useRef, useMemo } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  X,
  Download,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Edit,
  Copy,
  Check,
  Code2,
  Eye,
  FileText
} from "lucide-react";
import type { FileItem } from "@space/contracts";
import { api } from "../../api.js";

function VirtualCodeViewer({ content }: { content: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);

  const lines = useMemo(() => content.split("\n"), [content]);
  const totalLines = lines.length;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateSize = () => {
      if (el.clientHeight > 0) {
        setContainerHeight(el.clientHeight);
      }
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const LINE_HEIGHT = 20;
  const totalHeight = totalLines * LINE_HEIGHT;
  const OVERSCAN = 25;

  const startIndex = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(totalLines, Math.ceil((scrollTop + containerHeight) / LINE_HEIGHT) + OVERSCAN);
  const visibleLines = lines.slice(startIndex, endIndex);

  const topOffset = startIndex * LINE_HEIGHT;
  const bottomOffset = Math.max(0, (totalLines - endIndex) * LINE_HEIGHT);

  const gutterWidth = Math.max(48, String(totalLines).length * 8 + 18);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  };

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      style={{
        flex: 1,
        width: "100%",
        height: "100%",
        minHeight: 0,
        minWidth: 0,
        overflow: "auto",
        fontFamily: "monospace",
        fontSize: "0.85rem",
        lineHeight: `${LINE_HEIGHT}px`,
        background: "#070c10",
        position: "relative"
      }}
    >
      <div
        style={{
          height: totalHeight,
          minWidth: "100%",
          width: "max-content",
          position: "relative"
        }}
      >
        {/* Top Spacer */}
        {topOffset > 0 && <div style={{ height: topOffset }} />}

        {/* Rendered Window */}
        {visibleLines.map((line, idx) => {
          const lineNum = startIndex + idx + 1;
          return (
            <div
              key={lineNum}
              style={{
                display: "flex",
                height: LINE_HEIGHT,
                minWidth: "100%",
                width: "max-content",
                boxSizing: "border-box"
              }}
            >
              <div
                style={{
                  width: gutterWidth,
                  minWidth: gutterWidth,
                  background: "var(--modern-surface, #111820)",
                  color: "var(--modern-faint, #8796a3)",
                  textAlign: "right",
                  paddingRight: 10,
                  paddingLeft: 4,
                  userSelect: "none",
                  borderRight: "1px solid var(--modern-border, #2a3947)",
                  position: "sticky",
                  left: 0,
                  zIndex: 2,
                  flexShrink: 0
                }}
              >
                {lineNum}
              </div>
              <div
                style={{
                  padding: "0 14px",
                  color: "var(--modern-text, #f2f6f8)",
                  whiteSpace: "pre",
                  flex: 1
                }}
              >
                {line}
              </div>
            </div>
          );
        })}

        {/* Bottom Spacer */}
        {bottomOffset > 0 && <div style={{ height: bottomOffset }} />}
      </div>
    </div>
  );
}

export interface FilePreviewModalProps {
  entry: FileItem;
  mode: "user" | "admin";
  onClose: () => void;
  onDownload: () => void;
  onEdit?: (entry: FileItem) => void;
}

function SimpleMarkdownRenderer({ content }: { content: string }) {
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];
  let inCodeBlock = false;
  let codeBlockLines: string[] = [];
  let codeBlockLang = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("```")) {
      if (inCodeBlock) {
        elements.push(
          <pre
            key={`code-${i}`}
            style={{
              background: "rgba(0, 0, 0, 0.45)",
              padding: "12px 16px",
              borderRadius: "6px",
              border: "1px solid var(--modern-border, #2a3947)",
              fontFamily: "monospace",
              fontSize: "0.85rem",
              overflowX: "auto",
              margin: "12px 0",
              color: "var(--modern-text, #f2f6f8)",
              whiteSpace: "pre"
            }}
          >
            {codeBlockLines.join("\n")}
          </pre>
        );
        codeBlockLines = [];
        codeBlockLang = "";
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
        codeBlockLang = line.slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    if (line.startsWith("# ")) {
      elements.push(
        <h1
          key={i}
          style={{
            fontSize: "1.45rem",
            fontWeight: 700,
            margin: "18px 0 10px",
            borderBottom: "1px solid var(--modern-border, #2a3947)",
            paddingBottom: 6,
            color: "var(--modern-text, #f2f6f8)"
          }}
        >
          {line.slice(2)}
        </h1>
      );
    } else if (line.startsWith("## ")) {
      elements.push(
        <h2
          key={i}
          style={{
            fontSize: "1.2rem",
            fontWeight: 600,
            margin: "14px 0 8px",
            borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
            paddingBottom: 4,
            color: "var(--modern-text, #f2f6f8)"
          }}
        >
          {line.slice(3)}
        </h2>
      );
    } else if (line.startsWith("### ")) {
      elements.push(
        <h3
          key={i}
          style={{
            fontSize: "1.05rem",
            fontWeight: 600,
            margin: "12px 0 6px",
            color: "var(--modern-text, #f2f6f8)"
          }}
        >
          {line.slice(4)}
        </h3>
      );
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      elements.push(
        <li
          key={i}
          style={{
            marginLeft: 24,
            marginBottom: 4,
            lineHeight: 1.6,
            color: "var(--modern-text, #f2f6f8)"
          }}
        >
          {line.slice(2)}
        </li>
      );
    } else if (line.startsWith("> ")) {
      elements.push(
        <blockquote
          key={i}
          style={{
            borderLeft: "3px solid var(--modern-accent, #61d2c3)",
            margin: "8px 0",
            padding: "6px 14px",
            background: "rgba(97, 210, 195, 0.06)",
            color: "var(--modern-muted, #95a4b1)",
            borderRadius: "0 4px 4px 0"
          }}
        >
          {line.slice(2)}
        </blockquote>
      );
    } else if (line.trim() === "---" || line.trim() === "***") {
      elements.push(
        <hr
          key={i}
          style={{
            border: "none",
            borderTop: "1px solid var(--modern-border, #2a3947)",
            margin: "16px 0"
          }}
        />
      );
    } else if (line.trim() === "") {
      elements.push(<div key={i} style={{ height: 8 }} />);
    } else {
      elements.push(
        <p
          key={i}
          style={{
            margin: "4px 0",
            lineHeight: 1.6,
            color: "var(--modern-text, #f2f6f8)"
          }}
        >
          {line}
        </p>
      );
    }
  }

  if (inCodeBlock && codeBlockLines.length > 0) {
    elements.push(
      <pre
        key="code-last"
        style={{
          background: "rgba(0, 0, 0, 0.45)",
          padding: "12px 16px",
          borderRadius: "6px",
          border: "1px solid var(--modern-border, #2a3947)",
          fontFamily: "monospace",
          fontSize: "0.85rem",
          overflowX: "auto",
          margin: "12px 0",
          color: "var(--modern-text, #f2f6f8)",
          whiteSpace: "pre"
        }}
      >
        {codeBlockLines.join("\n")}
      </pre>
    );
  }

  return (
    <div style={{ padding: "20px 28px", maxWidth: "100%", width: "100%", overflowX: "auto" }}>
      {elements}
    </div>
  );
}

export function FilePreviewModal({ entry, mode, onClose, onDownload, onEdit }: FilePreviewModalProps) {
  const [zoom, setZoom] = useState(1);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [isLoadingText, setIsLoadingText] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);
  const [isRawView, setIsRawView] = useState(false);
  const [copied, setCopied] = useState(false);

  const rawUrl = `/api/files/raw?path=${encodeURIComponent(entry.path)}${mode === "admin" ? "&mode=admin" : ""}`;

  const ext = entry.extension?.toLowerCase() || (entry.name.includes(".") ? ("." + entry.name.split(".").pop()!.toLowerCase()) : "");
  const mime = entry.mimeType || "";
  const isImage = mime.startsWith("image/");
  const isVideo = mime.startsWith("video/");
  const isAudio = mime.startsWith("audio/");
  const isPdf = mime === "application/pdf";
  const isMarkdown = ext === ".md" || ext === ".markdown" || mime === "text/markdown";
  const isText =
    isMarkdown ||
    mime.startsWith("text/") ||
    mime.includes("javascript") ||
    mime.includes("typescript") ||
    mime.includes("json") ||
    mime.includes("xml") ||
    mime.includes("yaml") ||
    mime.includes("sql") ||
    mime.includes("sh") ||
    [
      ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".html", ".css", ".scss",
      ".py", ".sh", ".bash", ".zsh", ".yaml", ".yml", ".toml", ".xml", ".sql", ".env",
      ".conf", ".ini", ".log", ".txt", ".rs", ".go", ".c", ".cpp", ".h", ".dockerfile"
    ].includes(ext);

  useEffect(() => {
    if (!isText) return;
    setIsLoadingText(true);
    setTextError(null);
    api.filesRead({ path: entry.path, mode })
      .then((res) => {
        if (res.isBinary) {
          setTextError("Binary file cannot be displayed as text preview.");
        } else {
          setTextContent(res.content ?? "");
        }
      })
      .catch((err) => {
        setTextError(err instanceof Error ? err.message : "Failed to load file preview");
      })
      .finally(() => {
        setIsLoadingText(false);
      });
  }, [entry.path, mode, isText]);

  async function handleCopy() {
    if (textContent === null) return;
    try {
      await navigator.clipboard.writeText(textContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }

  return (
    <AnimatePresence>
      <motion.div
        className="fm-modal-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        onClick={onClose}
      >
        <motion.div
          className="fm-modal-card"
          initial={{ opacity: 0, scale: 0.96, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 12 }}
          transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
          style={{
            width: "100%",
            maxWidth: "1050px",
            height: "100%",
            maxHeight: "100%",
            minHeight: 0,
            minWidth: 0
          }}
          onClick={(e) => e.stopPropagation()}
        >
        {/* Header */}
        <div className="fm-modal-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, minWidth: 0, overflow: "hidden" }}>
          <div className="fm-modal-title" style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1, overflow: "hidden" }}>
            <span style={{ fontWeight: 600, color: "var(--modern-text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={entry.name}>
              {entry.name}
            </span>
            <span style={{ fontSize: "0.75rem", color: "var(--modern-faint)", fontWeight: 400, whiteSpace: "nowrap", flexShrink: 0 }}>
              ({mime || ext})
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            {/* Markdown view switcher */}
            {isMarkdown && !isLoadingText && textContent !== null && (
              <div style={{ display: "flex", background: "var(--modern-bg, #0b1015)", borderRadius: 4, padding: 2, gap: 2 }}>
                <button
                  type="button"
                  className={`fm-crumb-btn ${!isRawView ? "fm-crumb-active" : ""}`}
                  onClick={() => setIsRawView(false)}
                  style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "4px 8px" }}
                  title="Formatted Markdown Preview"
                  aria-label="Formatted Preview"
                >
                  <Eye size={15} />
                </button>
                <button
                  type="button"
                  className={`fm-crumb-btn ${isRawView ? "fm-crumb-active" : ""}`}
                  onClick={() => setIsRawView(true)}
                  style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "4px 8px" }}
                  title="Raw Code Preview"
                  aria-label="Raw Code Preview"
                >
                  <Code2 size={15} />
                </button>
              </div>
            )}

            {/* Text actions: Copy & Edit */}
            {isText && textContent !== null && (
              <>
                <button
                  type="button"
                  className="fm-action-btn"
                  onClick={handleCopy}
                  title="Copy file content"
                  aria-label="Copy"
                  style={{ padding: "4px 6px", display: "flex", alignItems: "center", justifyContent: "center" }}
                >
                  {copied ? <Check size={15} color="#65d8a3" /> : <Copy size={15} />}
                </button>
                {mode === "admin" && onEdit && (
                  <button
                    type="button"
                    className="fm-btn"
                    onClick={() => {
                      onClose();
                      onEdit(entry);
                    }}
                    title="Open in Code Editor"
                    aria-label="Edit"
                    style={{ padding: "0 10px", height: 28, display: "flex", alignItems: "center", justifyContent: "center" }}
                  >
                    <Edit size={15} />
                  </button>
                )}
              </>
            )}

            {/* Image zoom controls */}
            {isImage && (
              <div style={{ display: "flex", gap: 4, marginRight: 4 }}>
                <button
                  type="button"
                  className="fm-action-btn"
                  onClick={() => setZoom((z) => Math.min(z + 0.25, 3))}
                  title="Zoom In"
                  aria-label="Zoom In"
                  style={{ padding: "4px 6px" }}
                >
                  <ZoomIn size={15} />
                </button>
                <button
                  type="button"
                  className="fm-action-btn"
                  onClick={() => setZoom((z) => Math.max(z - 0.25, 0.5))}
                  title="Zoom Out"
                  aria-label="Zoom Out"
                  style={{ padding: "4px 6px" }}
                >
                  <ZoomOut size={15} />
                </button>
                <button
                  type="button"
                  className="fm-action-btn"
                  onClick={() => setZoom(1)}
                  title="Reset Zoom"
                  aria-label="Reset Zoom"
                  style={{ padding: "4px 6px" }}
                >
                  <RotateCcw size={15} />
                </button>
              </div>
            )}

            <button
              type="button"
              className="fm-btn"
              onClick={onDownload}
              title="Download file"
              aria-label="Download"
              style={{ padding: "0 10px", height: 28, display: "flex", alignItems: "center", justifyContent: "center" }}
            >
              <Download size={15} />
            </button>

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

        {/* Preview Content */}
        <div
          style={{
            flex: 1,
            display: "flex",
            minHeight: 0,
            minWidth: 0,
            overflow: "hidden",
            background: "#070c10",
            position: "relative"
          }}
        >
          {isImage ? (
            <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", padding: 16, overflow: "auto" }}>
              <img
                src={rawUrl}
                alt={entry.name}
                style={{
                  maxWidth: "100%",
                  maxHeight: "100%",
                  transform: `scale(${zoom})`,
                  transition: "transform 0.15s ease",
                  objectFit: "contain"
                }}
              />
            </div>
          ) : isVideo ? (
            <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", padding: 16, overflow: "auto" }}>
              <video
                src={rawUrl}
                controls
                autoPlay
                style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 4 }}
              />
            </div>
          ) : isAudio ? (
            <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", padding: 32, overflow: "auto" }}>
              <audio src={rawUrl} controls autoPlay style={{ width: "450px" }} />
            </div>
          ) : isPdf ? (
            <iframe
              src={rawUrl}
              title={entry.name}
              style={{ width: "100%", height: "100%", border: "none" }}
            />
          ) : isText ? (
            <div style={{ display: "flex", flex: 1, width: "100%", height: "100%", minHeight: 0, minWidth: 0, overflow: "hidden" }}>
              {isLoadingText ? (
                <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", color: "var(--modern-muted)" }}>
                  Loading preview...
                </div>
              ) : textError ? (
                <div style={{ display: "flex", flex: 1, flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--modern-danger)", gap: 8 }}>
                  <p>{textError}</p>
                  <button className="fm-btn primary" onClick={onDownload}>
                    <Download size={14} />
                    <span>Download File</span>
                  </button>
                </div>
              ) : isMarkdown && !isRawView && textContent !== null ? (
                <div style={{ flex: 1, overflowY: "auto" }}>
                  <SimpleMarkdownRenderer content={textContent} />
                </div>
              ) : (
                <VirtualCodeViewer content={textContent ?? ""} />
              )}
            </div>
          ) : (
            <div style={{ display: "flex", flex: 1, flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--modern-muted)", textAlign: "center", padding: 24 }}>
              <p>Preview not available for this file type ({mime || ext}).</p>
              <button className="fm-btn primary" onClick={onDownload} style={{ marginTop: 12 }}>
                <Download size={14} />
                <span>Download File</span>
              </button>
            </div>
          )}
        </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
