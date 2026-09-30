import { useEffect, useState } from "react";
import type { DemoVariantFile, DemoVariantFileContent } from "@space/contracts";
import { api } from "../../api.js";

interface CodeTabProps {
  projectId: string;
  variantId: string;
  initialFile?: string | null;
  onNotice: (notice: { tone: "ok" | "error" | "warn"; message: string } | null) => void;
}

const groups: Array<{ key: DemoVariantFile["group"]; label: string }> = [
  { key: "server", label: "Server" },
  { key: "web", label: "Web" },
  { key: "config", label: "Configuration" },
  { key: "docs", label: "Documentation" }
];

export function CodeTab({ projectId, variantId, initialFile, onNotice }: CodeTabProps) {
  const [files, setFiles] = useState<DemoVariantFile[]>([]);
  const [workspacePath, setWorkspacePath] = useState("");
  const [selected, setSelected] = useState<string | null>(initialFile ?? null);
  const [content, setContent] = useState<DemoVariantFileContent | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setSelected(initialFile ?? null);
    setContent(null);
  }, [initialFile, projectId, variantId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setContent(null);
    void api
      .demoVariantFiles(variantId, projectId)
      .then((payload) => {
        if (cancelled) return;
        setFiles(payload.files);
        setWorkspacePath(payload.workspacePath);
        const filePaths = new Set(payload.files.map((f) => f.path));
        setSelected((current) => {
          if (initialFile && filePaths.has(initialFile)) return initialFile;
          if (current && filePaths.has(current)) return current;
          const serverEntry = payload.files.find((f) => f.group === "server")?.path;
          return serverEntry ?? payload.files[0]?.path ?? null;
        });
      })
      .catch((error) => onNotice({ tone: "error", message: error instanceof Error ? error.message : "Could not list the sources." }))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initialFile, onNotice, projectId, variantId]);

  useEffect(() => {
    if (!selected || files.length === 0 || !files.some((f) => f.path === selected)) {
      setContent(null);
      return undefined;
    }
    let cancelled = false;
    void api
      .demoVariantFile(variantId, selected, projectId)
      .then((payload) => {
        if (!cancelled) {
          setContent(payload);
          onNotice(null);
        }
      })
      .catch((error) => onNotice({ tone: "error", message: error instanceof Error ? error.message : "Could not read the file." }));
    return () => {
      cancelled = true;
    };
  }, [files, onNotice, projectId, selected, variantId]);

  const totalLines = files.reduce((acc, f) => acc + (f.lines ?? 0), 0);

  return (
    <div className="demos-card" style={{ minHeight: 0 }}>
      <div className="demos-row spread">
        <h3>Variant source</h3>
        <div className="demos-row" style={{ gap: 8 }}>
          {files.length > 0 ? (
            <span className="demos-pill" style={{ background: "rgba(99, 102, 241, 0.15)", color: "#a5b4fc", borderColor: "rgba(99, 102, 241, 0.3)" }}>
              {totalLines.toLocaleString()} lines · {files.length} files
            </span>
          ) : null}
          <span className="demos-muted">{workspacePath ? `template: ${workspacePath}` : ""}</span>
        </div>
      </div>
      <p className="demos-muted">
        Each variant is a separate implementation. Opening the folder in the Space file manager or your editor keeps the same
        files you see here.
      </p>
      <div className="demos-code">
        <div className="demos-files">
          {loading ? <p className="demos-muted">Loading sources…</p> : null}
          {groups.map((group) => {
            const groupFiles = files.filter((file) => file.group === group.key);
            if (groupFiles.length === 0) return null;
            return (
              <div key={group.key}>
                <div className="demos-file-group">{group.label}</div>
                {groupFiles.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    className="demos-file"
                    aria-current={selected === file.path}
                    onClick={() => setSelected(file.path)}
                  >
                    <span className="demos-file-path">{file.path}</span>
                    <span className="demos-file-meta">
                      {file.lines !== undefined ? (
                        <span className="demos-loc-badge">{file.lines} L</span>
                      ) : null}
                      <span className="demos-muted">{Math.max(1, Math.round(file.bytes / 1024))} kB</span>
                    </span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
        <div className="demos-source">
          {content ? `${content.path}\n\n${content.content}${content.truncated ? "\n… truncated" : ""}` : "Select a file to preview it."}
        </div>
      </div>
    </div>
  );
}
